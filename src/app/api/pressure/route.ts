import { NextResponse } from "next/server";
import { DATABASE_TIMEOUT_MS, HISTORY_HOURS } from "@/lib/wind";
import { fetchStationPressure } from "@/lib/stationPressure";
import { fetchCrestTemperature } from "@/lib/crestTemperature";
import {
  CREST_KIND,
  CREST_STATION_IDS,
  MEASURED_ELEVATION_M,
  PRESSURE_STALE_AFTER_MS,
  PRESSURE_STATION_IDS,
  PRESSURE_STATIONS,
  QFF_TEMP_LAG_MS,
  toQffSeries,
  type CrestStationId,
  type PressurePayload,
  type PressureStationId,
  type QnhReading,
} from "@/lib/pressure";

// Luftdruck (QFF) bei den Flughäfen Innsbruck und Bozen für die Föhn-Anzeige
// (src/lib/pressure.ts), alles aus der Tabelle pressure_values:
//   stations  QFF alle 10 min aus den Wetterstationen (Hauptkurve)
//   crestTemperature  Temperatur auf Kammhöhe (Rittnerhorn, Hafelekar;
//             seit 8. Nov. 2026, vorher die Talstationen Bozen/Innsbruck)
//   crestTemperatureForecast  ICON-CH1-Temperatur (2 m) dieser Bergstationen
//   forecast  ICON-CH1-Prognose (QFF)
//   ecmwf     ECMWF-Prognose (IFS, seit Nov. 2026; QFF)
// QFF STATT QNH (seit 8. Nov. 2026, Begründung in src/lib/pressure.ts):
// Gespeichert ist der QNH samt Temperatur und Feuchte; diese Route rechnet
// beim Auslesen daraus das QFF (toQffSeries) — für Messung UND Prognose nach
// derselben Regel. Dafür liest sie 12 h mehr als angezeigt (QFF_TEMP_LAG_MS:
// Mittel aus aktueller Temperatur und der von vor 12 h).
// Gefüllt wird die Tabelle vom Sammler (/api/collect, Messwerte) und der Edge
// Function fetch-wind-forecasts (Prognose) — "Ein Sammler, eine Wahrheit".
// Die Flugwetter-Meldungen der Flughäfen (METAR, Art 'metar') sind seit
// 8. Nov. 2026 auf Wunsch des Projektbesitzers ganz weg.
//
// NOTBETRIEB wie bei /api/wind: Antwortet die Datenbank nicht oder fehlt dort
// für eine Messreihe ein frischer Wert (z. B. Sammler ausgefallen, oder kurz
// nach dem Einbau, bevor er gelaufen ist), holt die Route diese Reihe direkt
// bei den Diensten. Die Prognose gibt es nur aus der Datenbank.
//
// Aufruf: /api/pressure

// Wie /api/history: 60 s im CDN, kurze Nachfrist.
const RESPONSE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=30";

// Höchstens so viele Zeilen (Supabase gibt je Anfrage bis zu 1000 heraus).
// Erwartet in 48 h + 12 h (QFF) + 33 h Vorschau: ~720 Stationswerte, ~720
// Kammtemperaturen, ~370 ICON-CH1-Stunden (Flughäfen und Bergstationen),
// ~260 ECMWF-Stunden — zusammen über 1000, deshalb je Art eine Anfrage.
const MAX_ROWS = 1000;

export const dynamic = "force-dynamic";

type Series = Record<PressureStationId, Array<[number, number]>>;
type CrestSeries = Record<CrestStationId, Array<[number, number]>>;

interface PressureRow {
  station: string;
  valid_at: string;
  // Leer bei den Kammtemperaturen (Bergstationen ohne Luftdruck).
  qnh_hpa: number | null;
  model_run: string | null;
  temp_c: number | null;
  humidity_pct: number | null;
}

function emptySeries(): Series {
  return Object.fromEntries(PRESSURE_STATION_IDS.map((id) => [id, []])) as unknown as Series;
}

function emptyCrestSeries(): CrestSeries {
  return Object.fromEntries(CREST_STATION_IDS.map((id) => [id, []])) as unknown as CrestSeries;
}

async function readKind(kind: string, sinceIso: string): Promise<PressureRow[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase ist nicht konfiguriert");
  const res = await fetch(
    `${supabaseUrl}/rest/v1/pressure_values` +
      `?kind=eq.${kind}&valid_at=gte.${encodeURIComponent(sinceIso)}` +
      `&order=valid_at.asc&limit=${MAX_ROWS}` +
      `&select=station,valid_at,qnh_hpa,model_run,temp_c,humidity_pct`,
    {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Supabase antwortete mit Status ${res.status}`);
  return (await res.json()) as PressureRow[];
}

/**
 * Höhe, auf die sich der gespeicherte QNH bezieht: Messung = Barometer der
 * Wetterstationen, Prognose = Flughafenhöhe (siehe MEASURED_ELEVATION_M).
 */
function qnhElevation(kind: string, id: PressureStationId): number {
  return kind === "station" ? MEASURED_ELEVATION_M[id] : PRESSURE_STATIONS[id].elevationM;
}

/** Gespeicherte QNH-Zeilen je Flughafen als QFF-Reihen ab `since`, aufsteigend. */
function toQff(readings: Record<PressureStationId, QnhReading[]>, kind: string, since: number): Series {
  const series = emptySeries();
  for (const id of PRESSURE_STATION_IDS) {
    const sorted = [...readings[id]].sort((a, b) => a.time - b.time);
    series[id] = toQffSeries(sorted, qnhElevation(kind, id), since);
  }
  return series;
}

function emptyReadings(): Record<PressureStationId, QnhReading[]> {
  return Object.fromEntries(PRESSURE_STATION_IDS.map((id) => [id, []])) as unknown as Record<
    PressureStationId,
    QnhReading[]
  >;
}

/**
 * Zeilen einer Art ab `since`: QFF je Flughafen (`series`) und Temperatur je
 * Bergstation (`crestTemperature`); null, wenn die Datenbank nicht antwortet.
 * Gelesen wird ab `since` − 12 h, weil das QFF die Temperatur von vor 12 h
 * braucht (QFF_TEMP_LAG_MS).
 */
async function readSeries(
  kind: string,
  since: number,
): Promise<{ series: Series; crestTemperature: CrestSeries; modelRun: string | null } | null> {
  try {
    const readings = emptyReadings();
    const crestTemperature = emptyCrestSeries();
    let modelRun: string | null = null;
    for (const row of await readKind(kind, new Date(since - QFF_TEMP_LAG_MS).toISOString())) {
      const time = Date.parse(row.valid_at);
      if (Number.isNaN(time)) continue;
      const station = PRESSURE_STATION_IDS.find((id) => id === row.station);
      const crest = CREST_STATION_IDS.find((id) => id === row.station);
      if (station && typeof row.qnh_hpa === "number") {
        readings[station].push({ time, qnh: row.qnh_hpa, tempC: row.temp_c, humidityPct: row.humidity_pct });
      } else if (crest && typeof row.temp_c === "number") {
        if (time >= since) crestTemperature[crest].push([time, row.temp_c]);
      } else continue;
      // Jüngster Lauf (ältere Stunden stammen teils aus früheren Läufen).
      if (row.model_run && (!modelRun || row.model_run > modelRun)) modelRun = row.model_run;
    }
    return { series: toQff(readings, kind, since), crestTemperature, modelRun };
  } catch (err) {
    console.error(`Luftdruck (${kind}) aus der Datenbank nicht lesbar:`, err);
    return null;
  }
}

/** true, wenn jede Seite einen Wert hat, der höchstens PRESSURE_STALE_AFTER_MS alt ist. */
function isFresh(series: Record<string, Array<[number, number]>> | undefined, now: number): boolean {
  if (!series) return false;
  return Object.values(series).every((points) => {
    const last = points[points.length - 1];
    return last !== undefined && now - last[0] <= PRESSURE_STALE_AFTER_MS;
  });
}


export async function GET() {
  const now = Date.now();
  const since = now - HISTORY_HOURS * 60 * 60 * 1000;

  const [stationsDb, crestDb, forecastDb, ecmwfDb, iconD2Db] = await Promise.all([
    readSeries("station", since),
    readSeries(CREST_KIND, since),
    readSeries("icon_ch1", since),
    readSeries("ecmwf_ifs", since),
    readSeries("icon_d2", since),
  ]);

  let stations = stationsDb?.series ?? emptySeries();
  let crestTemperature = crestDb?.crestTemperature ?? emptyCrestSeries();
  let fallback = false;

  // Notbetrieb je Messreihe, alle gleichzeitig.
  await Promise.all([
    (async () => {
      if (isFresh(stationsDb?.series, now)) return;
      try {
        // 12 h mehr für die Temperatur des QFF (wie readSeries).
        const { values } = await fetchStationPressure(since - QFF_TEMP_LAG_MS);
        if (values.length === 0) return;
        const readings = emptyReadings();
        for (const v of values) {
          readings[v.station].push({
            time: Date.parse(v.measuredAt),
            qnh: v.qnhHpa,
            tempC: v.tempC,
            humidityPct: v.humidityPct,
          });
        }
        stations = toQff(readings, "station", since);
        fallback = true;
      } catch (err) {
        console.error("Luftdruck (Stationen) im Notbetrieb nicht abrufbar:", err);
      }
    })(),
    (async () => {
      if (isFresh(crestDb?.crestTemperature, now)) return;
      try {
        const { values } = await fetchCrestTemperature(since);
        if (values.length === 0) return;
        const series = emptyCrestSeries();
        for (const v of values) {
          const time = Date.parse(v.measuredAt);
          if (time >= since) series[v.station].push([time, v.tempC]);
        }
        for (const id of CREST_STATION_IDS) series[id].sort((a, b) => a[0] - b[0]);
        crestTemperature = series;
        fallback = true;
      } catch (err) {
        console.error("Kammtemperatur im Notbetrieb nicht abrufbar:", err);
      }
    })(),
  ]);

  const forecast = forecastDb?.series ?? emptySeries();
  const ecmwf = ecmwfDb?.series ?? emptySeries();
  const iconD2 = iconD2Db?.series ?? emptySeries();
  const hasAny = [stations, forecast, ecmwf, iconD2].some((series) =>
    PRESSURE_STATION_IDS.some((id) => series[id].length > 0),
  );
  if (!hasAny) {
    return NextResponse.json({ error: "Keine Druckwerte verfügbar" }, { status: 502 });
  }

  const payload: PressurePayload = {
    stations,
    crestTemperature,
    forecast,
    crestTemperatureForecast: forecastDb?.crestTemperature ?? emptyCrestSeries(),
    modelRun: forecastDb?.modelRun ?? null,
    ecmwf,
    ecmwfRun: ecmwfDb?.modelRun ?? null,
    iconD2,
    iconD2Run: iconD2Db?.modelRun ?? null,
    fallback,
  };
  return NextResponse.json(payload, { headers: { "Cache-Control": RESPONSE_CACHE_CONTROL } });
}
