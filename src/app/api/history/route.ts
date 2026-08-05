import { NextResponse } from "next/server";
import { HISTORY_HOURS } from "@/lib/wind";

// Liefert die Wind-Historie der letzten HISTORY_HOURS Stunden (siehe
// src/lib/wind.ts, aktuell 12) einer Station aus der Supabase-Tabelle
// wind_measurements (befüllt von der Sammel-Route /api/collect, die von
// Supabase Cron angestoßen wird).
//
// Aufruf: /api/history?station=<SCODE>
//
// Benötigt die Umgebungsvariablen SUPABASE_URL und
// SUPABASE_SERVICE_ROLE_KEY (bei Vercel unter Settings → Environment
// Variables hinterlegen). Der Key bleibt auf dem Server — die Route gibt
// nur die Messwerte weiter.

export interface HistoryEntry {
  measured_at: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
}

// Zwischenspeicherung wie bei /api/wind: Neue Messwerte kommen nur alle
// 10 Minuten dazu (Sammel-Lauf /api/collect), es lohnt sich also nicht, für
// jeden Klick auf eine Station erneut die Datenbank zu befragen. 60 s im
// CDN von Vercel bedeuten: klickt man zwischen zwei Stationen hin und her
// oder schauen mehrere Leute dieselbe Station an, kommt die Antwort direkt
// aus dem Zwischenspeicher — ohne Datenbankabfrage und spürbar schneller.
// Fehlerantworten bekommen bewusst KEINEN solchen Header, damit sich eine
// kurze Störung nicht 60 s lang festsetzt.
const RESPONSE_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=300";

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
