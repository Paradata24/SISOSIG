import { NextResponse } from "next/server";
import { FUTURE_MARGIN_HOURS, HISTORY_HOURS } from "@/lib/wind";

// Liefert die Windprognosen einer Station aus der Supabase-Tabelle
// wind_forecasts (befüllt von der Edge Function fetch-wind-forecasts, die
// stündlich per pg_cron angestoßen wird): ICON-CH1.
//
// Aufruf: /api/forecast?station=<SCODE>
//
// Exakte Parallele zu /api/history: gleiche Struktur, gleiche
// Umgebungsvariablen SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY, gleiches
// Fehlerverhalten. Nur ~84 der ~120 Stationen liegen im ICON-CH1-Modellgebiet;
// Stationen ohne Prognose liefern einfach eine leere Liste (kein Fehler).
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

// Modellname in der Tabelle wind_forecasts (siehe Edge Function): die
// Bodenwind-Prognose ICON-CH1 (rote Kurve im Verlaufsbalken).
// ICON-D2 ('icon_d2') wird weiterhin gesammelt, aber nicht ausgeliefert,
// weil das Diagramm es nicht zeichnet. AROME wurde auf Wunsch des
// Projektbesitzers komplett entfernt (weder gesammelt noch angezeigt).
const MODEL_SURFACE = "icon_ch1";

// Zwischenspeicherung wie bei /api/history. Die Prognose wird sogar nur
// STÜNDLICH neu geholt (Edge Function fetch-wind-forecasts), 120 s im CDN
// sind hier also besonders unkritisch. Fehlerantworten bekommen bewusst
// keinen Cache-Header.
const RESPONSE_CACHE_CONTROL =
  "public, s-maxage=120, stale-while-revalidate=600";

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

  const baseUrl =
    `${supabaseUrl}/rest/v1/wind_forecasts` +
    `?station_code=eq.${encodeURIComponent(station)}` +
    `&forecast_time=gte.${encodeURIComponent(since)}` +
    `&forecast_time=lte.${encodeURIComponent(until)}` +
    `&order=forecast_time.asc`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };

  // Bodenwind ICON-CH1 abfragen.
  const surfaceQuery =
    `${baseUrl}&model=eq.${MODEL_SURFACE}` +
    `&select=forecast_time,direction,speed_kmh,gust_kmh`;

  let res: Response;
  try {
    res = await fetch(surfaceQuery, { headers, cache: "no-store" });
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

  return NextResponse.json(
    {
      stationCode: station,
      hours: HISTORY_HOURS,
      count: entries.length,
      entries,
    },
    { headers: { "Cache-Control": RESPONSE_CACHE_CONTROL } },
  );
}
