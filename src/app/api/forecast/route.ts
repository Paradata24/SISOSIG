import { NextResponse } from "next/server";

// Liefert die ICON-CH1-Windprognose einer Station aus der Supabase-Tabelle
// wind_forecasts (befüllt von der Edge Function fetch-wind-forecasts, die
// stündlich per pg_cron angestoßen wird).
//
// Aufruf: /api/forecast?station=<SCODE>
//
// Exakte Parallele zu /api/history: gleiche Struktur, gleiche
// Umgebungsvariablen SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY, gleiches
// Fehlerverhalten. Nur ~84 der ~120 Stationen liegen im ICON-CH1-Modellgebiet;
// Stationen ohne Prognose liefern einfach eine leere Liste (kein Fehler).

const HISTORY_HOURS = 48;

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

// Modellnamen in der Tabelle wind_forecasts (siehe Edge Function). Der
// Höhenwind kommt aus ICON-D2, weil ICON-CH1 keine Druckflächen-Daten liefert.
const MODEL_SURFACE = "icon_ch1";
const MODEL_UPPER = "icon_d2_upper";

// Eine Zeile der Höhenwind-Abfrage inkl. der beiden Zusatzspalten.
interface UpperRow extends ForecastEntry {
  pressure_level: number | null;
  height_m: number | null;
}

// Fasst die Höhenwind-Zeilen zu einer Prognose zusammen: eine feste Druckfläche
// pro Station, dazu die repräsentative (gemittelte) Höhe für die Beschriftung.
function summarizeUpper(rows: UpperRow[]): UpperForecast | null {
  if (rows.length === 0) return null;
  const level = rows.find((r) => r.pressure_level != null)?.pressure_level ?? null;
  const heights = rows.map((r) => r.height_m).filter((h): h is number => h != null);
  const heightM = heights.length
    ? Math.round(heights.reduce((a, b) => a + b, 0) / heights.length)
    : null;
  return {
    pressure_level: level,
    height_m: heightM,
    entries: rows.map((r) => ({
      forecast_time: r.forecast_time,
      direction: r.direction,
      speed_kmh: r.speed_kmh,
      gust_kmh: r.gust_kmh,
    })),
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

  const baseUrl =
    `${supabaseUrl}/rest/v1/wind_forecasts` +
    `?station_code=eq.${encodeURIComponent(station)}` +
    `&forecast_time=gte.${encodeURIComponent(since)}` +
    `&order=forecast_time.asc`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };

  // Bodenwind (Pflicht) und Höhenwind (additiv) parallel abfragen.
  const surfaceQuery =
    `${baseUrl}&model=eq.${MODEL_SURFACE}` +
    `&select=forecast_time,direction,speed_kmh,gust_kmh`;
  const upperQuery =
    `${baseUrl}&model=eq.${MODEL_UPPER}` +
    `&select=forecast_time,direction,speed_kmh,gust_kmh,pressure_level,height_m`;

  let res: Response;
  let upperRes: Response | null = null;
  try {
    [res, upperRes] = await Promise.all([
      fetch(surfaceQuery, { headers, cache: "no-store" }),
      // Der Höhenwind ist optional: ein Fehler hier darf den Bodenwind nicht
      // blockieren, deshalb separat aufgefangen (upperRes bleibt dann null).
      fetch(upperQuery, { headers, cache: "no-store" }).catch(() => null),
    ]);
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

  const entries: ForecastEntry[] = await res.json();

  let upper: UpperForecast | null = null;
  if (upperRes?.ok) {
    try {
      upper = summarizeUpper((await upperRes.json()) as UpperRow[]);
    } catch {
      upper = null;
    }
  }

  return NextResponse.json({
    stationCode: station,
    hours: HISTORY_HOURS,
    count: entries.length,
    entries,
    upper,
  });
}
