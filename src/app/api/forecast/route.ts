import { NextResponse } from "next/server";
import {
  FORECAST_MODELS,
  FUTURE_MARGIN_HOURS,
  HISTORY_HOURS,
  UPPER_FORECAST_MODEL,
} from "@/lib/wind";

// Liefert die Windprognosen einer Station aus der Supabase-Tabelle
// wind_forecasts (befüllt von der Edge Function fetch-wind-forecasts, die
// stündlich per pg_cron angestoßen wird).
//
// Aufruf: /api/forecast?station=<SCODE>
//
// Exakte Parallele zu /api/history: gleiche Struktur, gleiche
// Umgebungsvariablen SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY, gleiches
// Fehlerverhalten. Zurück kommen ALLE Bodenwind-Modelle aus FORECAST_MODELS
// (src/lib/wind.ts) — nach Modell gruppiert — plus der Höhenwind. Modelle,
// die diese Station nicht abdecken (z. B. AROME Austria außerhalb seines
// Gebiets, oder Stationen außerhalb des ICON-CH1-Modellgebiets), liefern
// einfach eine leere Liste, kein Fehler.
//
// Zeitfenster: genau der Bereich, den der Verlaufsbalken zeichnet, also
// (jetzt − HISTORY_HOURS) bis (jetzt + FUTURE_MARGIN_HOURS) — beide Werte aus
// src/lib/wind.ts. Die Edge Function speichert bewusst etwas mehr Zukunft, als
// angezeigt wird (Puffer für ihren stündlichen Takt); die Obergrenze hier
// schneidet diesen Überhang ab, damit keine Punkte rechts außerhalb der Achse
// landen.

export interface ForecastEntry {
  forecast_time: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
}

// Höhenwind-Prognose (nur für Windanzeiger-Stationen vorhanden). pressure_level
// = verwendete Druckfläche in hPa, height_m = deren (mittlere) Höhe in Metern.
export interface UpperForecast {
  pressure_level: number | null;
  height_m: number | null;
  entries: ForecastEntry[];
}

/** Prognosen je Modellname (Schlüssel = "key" aus FORECAST_MODELS). */
export type ForecastsByModel = Record<string, ForecastEntry[]>;

export interface ForecastResponse {
  stationCode: string;
  hours: number;
  count: number;
  models: ForecastsByModel;
  upper: UpperForecast | null;
}

// Eine Zeile, wie sie aus Supabase kommt (die beiden letzten Spalten sind nur
// beim Höhenwind gefüllt).
interface ForecastRow extends ForecastEntry {
  model: string;
  pressure_level: number | null;
  height_m: number | null;
}

function toEntry(row: ForecastRow): ForecastEntry {
  return {
    forecast_time: row.forecast_time,
    direction: row.direction,
    speed_kmh: row.speed_kmh,
    gust_kmh: row.gust_kmh,
  };
}

// Fasst die Höhenwind-Zeilen zu einer Prognose zusammen: eine feste Druckfläche
// pro Station, dazu die repräsentative (gemittelte) Höhe für die Beschriftung.
function summarizeUpper(rows: ForecastRow[]): UpperForecast | null {
  if (rows.length === 0) return null;
  const level = rows.find((r) => r.pressure_level != null)?.pressure_level ?? null;
  const heights = rows.map((r) => r.height_m).filter((h): h is number => h != null);
  const heightM = heights.length
    ? Math.round(heights.reduce((a, b) => a + b, 0) / heights.length)
    : null;
  return {
    pressure_level: level,
    height_m: heightM,
    entries: rows.map(toEntry),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const station = searchParams.get("station");
  if (!station) {
    return NextResponse.json(
      { error: "Parameter ?station=<SCODE> fehlt" },
      { status: 400 },
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      {
        error:
          "Supabase ist nicht konfiguriert (SUPABASE_URL / " +
          "SUPABASE_SERVICE_ROLE_KEY fehlen in den Umgebungsvariablen)",
      },
      { status: 500 },
    );
  }

  const since = new Date(
    Date.now() - HISTORY_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const until = new Date(
    Date.now() + FUTURE_MARGIN_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Alle Modelle in EINER Abfrage holen und danach nach Modell gruppieren —
  // früher war das eine Abfrage pro Modell; bei inzwischen vier Bodenwind-
  // Modellen plus Höhenwind wären das fünf Rundreisen zu Supabase für
  // insgesamt nur rund 100 Zeilen.
  const wantedModels = [
    ...FORECAST_MODELS.map((m) => m.key),
    UPPER_FORECAST_MODEL.key,
  ];
  const query =
    `${supabaseUrl}/rest/v1/wind_forecasts` +
    `?station_code=eq.${encodeURIComponent(station)}` +
    `&forecast_time=gte.${encodeURIComponent(since)}` +
    `&forecast_time=lte.${encodeURIComponent(until)}` +
    `&model=in.(${wantedModels.map(encodeURIComponent).join(",")})` +
    `&select=model,forecast_time,direction,speed_kmh,gust_kmh,pressure_level,height_m` +
    `&order=forecast_time.asc`;

  let res: Response;
  try {
    res = await fetch(query, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "Supabase ist nicht erreichbar" },
      { status: 502 },
    );
  }

  if (!res.ok) {
    return NextResponse.json(
      { error: `Supabase antwortete mit Status ${res.status}` },
      { status: 502 },
    );
  }

  const rows = (await res.json()) as ForecastRow[];

  // Jedes bekannte Modell taucht im Ergebnis auf — notfalls mit leerer Liste,
  // damit das Frontend nicht zwischen "kein Eintrag" und "keine Daten"
  // unterscheiden muss.
  const models: ForecastsByModel = Object.fromEntries(
    FORECAST_MODELS.map((m) => [m.key, [] as ForecastEntry[]]),
  );
  const upperRows: ForecastRow[] = [];
  for (const row of rows) {
    if (row.model === UPPER_FORECAST_MODEL.key) {
      upperRows.push(row);
    } else if (models[row.model]) {
      models[row.model].push(toEntry(row));
    }
  }

  const response: ForecastResponse = {
    stationCode: station,
    hours: HISTORY_HOURS,
    count: rows.length - upperRows.length,
    models,
    upper: summarizeUpper(upperRows),
  };
  return NextResponse.json(response);
}
