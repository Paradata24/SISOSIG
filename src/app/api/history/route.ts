import { NextResponse } from "next/server";

// Liefert die Wind-Historie der letzten 48 Stunden einer Station aus der
// Supabase-Tabelle wind_measurements (befüllt durch den GitHub-Actions-
// Workflow "Winddaten sammeln").
//
// Aufruf: /api/history?station=<SCODE>
//
// Benötigt die Umgebungsvariablen SUPABASE_URL und
// SUPABASE_SERVICE_ROLE_KEY (bei Vercel unter Settings → Environment
// Variables hinterlegen). Der Key bleibt auf dem Server — die Route gibt
// nur die Messwerte weiter.

const HISTORY_HOURS = 48;

export interface HistoryEntry {
  measured_at: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
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

  const query =
    `${supabaseUrl}/rest/v1/wind_measurements` +
    `?station_code=eq.${encodeURIComponent(station)}` +
    `&measured_at=gte.${encodeURIComponent(since)}` +
    `&order=measured_at.asc` +
    `&select=measured_at,direction,speed_kmh,gust_kmh`;

  let res: Response;
  try {
    res = await fetch(query, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
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

  const entries: HistoryEntry[] = await res.json();
  return NextResponse.json({
    stationCode: station,
    hours: HISTORY_HOURS,
    count: entries.length,
    entries,
  });
}
