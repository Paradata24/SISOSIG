import { NextResponse } from "next/server";
import { DATABASE_TIMEOUT_MS, HISTORY_HOURS } from "@/lib/wind";
import { fetchMetarPressure } from "@/lib/metar";
import { fetchStationPressure } from "@/lib/stationPressure";
import {
  PRESSURE_STALE_AFTER_MS,
  PRESSURE_STATION_IDS,
  type PressurePayload,
  type PressureStationId,
} from "@/lib/pressure";

// Luftdruck (QNH) bei den Flughäfen Innsbruck und Bozen für die Föhn-Anzeige
// (src/lib/pressure.ts), alles aus der Tabelle pressure_values:
//   stations  QNH alle 10 min aus den Wetterstationen (Hauptkurve)
//   metar     QNH aus den Flugwetter-Meldungen (Vergleichslinie)
//   forecast  ICON-CH1-Prognose
//   ecmwf     ECMWF-Prognose (IFS, seit Nov. 2026)
// Gefüllt wird die Tabelle vom Sammler (/api/collect, Messwerte) und der Edge
// Function fetch-wind-forecasts (Prognose) — "Ein Sammler, eine Wahrheit".
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
// Erwartet in 48 h + 33 h Vorschau: ~580 Stationswerte, ~150 METAR,
// ~170 Prognosestunden — knapp unter 1000, deshalb je Art eine Anfrage.
const MAX_ROWS = 1000;

export const dynamic = "force-dynamic";

type Series = Record<PressureStationId, Array<[number, number]>>;

interface PressureRow {
  station: string;
  valid_at: string;
  qnh_hpa: number;
  model_run: string | null;
}

function emptySeries(): Series {
  return Object.fromEntries(PRESSURE_STATION_IDS.map((id) => [id, []])) as unknown as Series;
}

async function readKind(kind: string, sinceIso: string): Promise<PressureRow[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase ist nicht konfiguriert");
  const res = await fetch(
    `${supabaseUrl}/rest/v1/pressure_values` +
      `?kind=eq.${kind}&valid_at=gte.${encodeURIComponent(sinceIso)}` +
      `&order=valid_at.asc&limit=${MAX_ROWS}` +
      `&select=station,valid_at,qnh_hpa,model_run`,
    {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Supabase antwortete mit Status ${res.status}`);
  return (await res.json()) as PressureRow[];
}

/** Zeilen einer Art in Reihen je Flughafen; null, wenn die Datenbank nicht antwortet. */
async function readSeries(kind: string, sinceIso: string): Promise<{ series: Series; modelRun: string | null } | null> {
  try {
    const series = emptySeries();
    let modelRun: string | null = null;
    for (const row of await readKind(kind, sinceIso)) {
      const station = PRESSURE_STATION_IDS.find((id) => id === row.station);
      const time = Date.parse(row.valid_at);
      if (!station || Number.isNaN(time) || typeof row.qnh_hpa !== "number") continue;
      series[station].push([time, row.qnh_hpa]);
      // Jüngster Lauf (ältere Stunden stammen teils aus früheren Läufen).
      if (row.model_run && (!modelRun || row.model_run > modelRun)) modelRun = row.model_run;
    }
    return { series, modelRun };
  } catch (err) {
    console.error(`Luftdruck (${kind}) aus der Datenbank nicht lesbar:`, err);
    return null;
  }
}

/** true, wenn jede Seite einen Wert hat, der höchstens PRESSURE_STALE_AFTER_MS alt ist. */
function isFresh(series: Series | undefined, now: number): boolean {
  if (!series) return false;
  return PRESSURE_STATION_IDS.every((id) => {
    const last = series[id][series[id].length - 1];
    return last !== undefined && now - last[0] <= PRESSURE_STALE_AFTER_MS;
  });
}

/** Werte (Station, ISO-Zeit, QNH) als Reihen ab `since`, aufsteigend. */
function toSeries(values: Array<{ station: PressureStationId; at: string; qnh: number }>, since: number): Series {
  const series = emptySeries();
  for (const v of values) {
    const time = Date.parse(v.at);
    if (time >= since) series[v.station].push([time, v.qnh]);
  }
  for (const id of PRESSURE_STATION_IDS) series[id].sort((a, b) => a[0] - b[0]);
  return series;
}

export async function GET() {
  const now = Date.now();
  const since = now - HISTORY_HOURS * 60 * 60 * 1000;
  const sinceIso = new Date(since).toISOString();

  const [stationsDb, metarDb, forecastDb, ecmwfDb] = await Promise.all([
    readSeries("station", sinceIso),
    readSeries("metar", sinceIso),
    readSeries("icon_ch1", sinceIso),
    readSeries("ecmwf_ifs", sinceIso),
  ]);

  let stations = stationsDb?.series ?? emptySeries();
  let metar = metarDb?.series ?? emptySeries();
  let fallback = false;

  // Notbetrieb je Messreihe, beide gleichzeitig.
  await Promise.all([
    (async () => {
      if (isFresh(stationsDb?.series, now)) return;
      try {
        const { values } = await fetchStationPressure(since);
        if (values.length === 0) return;
        stations = toSeries(values.map((v) => ({ station: v.station, at: v.measuredAt, qnh: v.qnhHpa })), since);
        fallback = true;
      } catch (err) {
        console.error("Luftdruck (Stationen) im Notbetrieb nicht abrufbar:", err);
      }
    })(),
    (async () => {
      if (isFresh(metarDb?.series, now)) return;
      try {
        const values = await fetchMetarPressure(HISTORY_HOURS);
        if (values.length === 0) return;
        metar = toSeries(values.map((v) => ({ station: v.station, at: v.observedAt, qnh: v.qnhHpa })), since);
        fallback = true;
      } catch (err) {
        console.error("Luftdruck (METAR) im Notbetrieb nicht abrufbar:", err);
      }
    })(),
  ]);

  const forecast = forecastDb?.series ?? emptySeries();
  const ecmwf = ecmwfDb?.series ?? emptySeries();
  const hasAny = [stations, metar, forecast, ecmwf].some((series) =>
    PRESSURE_STATION_IDS.some((id) => series[id].length > 0),
  );
  if (!hasAny) {
    return NextResponse.json({ error: "Keine Druckwerte verfügbar" }, { status: 502 });
  }

  const payload: PressurePayload = {
    stations,
    metar,
    forecast,
    modelRun: forecastDb?.modelRun ?? null,
    ecmwf,
    ecmwfRun: ecmwfDb?.modelRun ?? null,
    fallback,
  };
  return NextResponse.json(payload, { headers: { "Cache-Control": RESPONSE_CACHE_CONTROL } });
}
