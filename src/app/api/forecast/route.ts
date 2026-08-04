import { NextResponse } from "next/server";
import { FUTURE_MARGIN_HOURS, HISTORY_HOURS } from "@/lib/wind";

// Liefert die Windprognosen einer Station aus der Supabase-Tabelle
// wind_forecasts (befüllt von der Edge Function fetch-wind-forecasts, die
// stündlich per pg_cron angestoßen wird): ICON-CH1 und AROME.
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

// Modellnamen in der Tabelle wind_forecasts (siehe Edge Function): zwei
// Bodenwind-Prognosen zum Vergleich (ICON-CH1 = rot, AROME = gelb).
// ICON-D2 ('icon_d2') wird weiterhin gesammelt, aber nicht mehr ausgeliefert,
// weil das Diagramm es nicht mehr zeichnet.
const MODEL_SURFACE = "icon_ch1";
const MODEL_SURFACE_AROME = "arome";

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

  // Bodenwind ICON-CH1 (Pflicht) und AROME-Bodenwind (additiv) parallel
  // abfragen.
  const surfaceQuery =
    `${baseUrl}&model=eq.${MODEL_SURFACE}` +
    `&select=forecast_time,direction,speed_kmh,gust_kmh`;
  const surfaceAromeQuery =
    `${baseUrl}&model=eq.${MODEL_SURFACE_AROME}` +
    `&select=forecast_time,direction,speed_kmh,gust_kmh`;

  let res: Response;
  let aromeRes: Response | null = null;
  try {
    [res, aromeRes] = await Promise.all([
      fetch(surfaceQuery, { headers, cache: "no-store" }),
      // Der AROME-Bodenwind ist optional: ein Fehler hier darf den
      // ICON-CH1-Bodenwind nicht blockieren, deshalb separat aufgefangen.
      // Stationen außerhalb des AROME-Gebiets liefern einfach eine leere
      // Liste (die Edge Function speichert dafür keine Zeilen).
      fetch(surfaceAromeQuery, { headers, cache: "no-store" }).catch(() => null),
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

  let entriesArome: ForecastEntry[] = [];
  if (aromeRes?.ok) {
    try {
      entriesArome = (await aromeRes.json()) as ForecastEntry[];
    } catch {
      entriesArome = [];
    }
  }

  return NextResponse.json({
    stationCode: station,
    hours: HISTORY_HOURS,
    count: entries.length,
    entries,
    entriesArome,
  });
}
