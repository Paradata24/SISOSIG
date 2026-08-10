import { NextResponse } from "next/server";
import {
  buildTimelineSlots,
  GRID_MS,
  HISTORY_HOURS,
  snapToGrid,
  TIMELINE_STEP_MINUTES,
  type TimelinePayload,
  type TimelineSeries,
} from "@/lib/wind";

// Liefert die Messwerte ALLER Stationen der letzten HISTORY_HOURS Stunden
// (aktuell 12) aus der Supabase-Tabelle wind_measurements — die Datengrundlage
// für den Zeitbalken unter der Karte (TimeSlider.tsx).
//
// Aufruf: /api/timeline  (keine Parameter)
//
// Gegenstück zu /api/history, das dasselbe für EINE Station tut. Hier wäre ein
// Zeilen-JSON (~130 Stationen × 73 Zeitpunkte) mehrere hundert KB groß,
// deshalb ein kompaktes SPALTEN-Format: eine gemeinsame Zeitliste und pro
// Station drei gleich lange Zahlenreihen (siehe TimelinePayload in
// src/lib/wind.ts). Das sind rund 15–25 KB komprimiert.
//
// Benötigt SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY (bei Vercel unter
// Settings → Environment Variables). Der Key bleibt auf dem Server.
//
// Hinweis zur Geschwindigkeit: Die Abfrage filtert nur nach Zeit, nicht nach
// Station. Der vorhandene Index (station_code, measured_at desc) hilft dabei
// nicht — dafür gibt es supabase/add-measured-at-index.sql, das einmalig im
// Supabase-SQL-Editor ausgeführt werden muss.

// Diese Route liest nichts aus der Anfrage, ihr Ergebnis hängt aber an der
// aktuellen Uhrzeit. Ohne diese Zeile könnte Next sie beim Bauen einmalig
// vorberechnen und dauerhaft dieselbe (dann veraltete) Antwort ausliefern.
export const dynamic = "force-dynamic";

// Supabase/PostgREST liefert pro Anfrage höchstens so viele Zeilen, wie in den
// Projekteinstellungen unter "Max rows" steht (Standard 1000). Deshalb wird
// seitenweise gelesen.
const PAGE_SIZE = 1000;
// Harte Obergrenze, damit die Route bei einer unerwartet großen Tabelle nicht
// endlos weiterliest. 30 Seiten = 30.000 Zeilen ≈ das Dreifache der Erwartung
// (~130 Stationen × 73 Zeitpunkte ≈ 9.500).
const MAX_PAGES = 30;

// Zwischenspeicherung wie bei /api/history: Neue Messwerte kommen nur alle
// 10 Minuten dazu. Fehlerantworten bekommen bewusst KEINEN solchen Header,
// damit sich eine kurze Störung nicht 60 s lang festsetzt.
const RESPONSE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

interface MeasurementRow {
  station_code: string;
  measured_at: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
}

/** Auf ganze Zahlen runden — kürzeres JSON, und die Karte rundet ohnehin. */
function round0(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export async function GET() {
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

  const times = buildTimelineSlots(Date.now());
  const start = times[0];
  // Einen halben Rasterschritt Vorlauf, damit eine Messung, die knapp VOR dem
  // ersten Rasterpunkt liegt und auf diesen gehört (z. B. 02:27 → 02:30), nicht
  // wegfällt.
  const sinceIso = new Date(start - GRID_MS / 2).toISOString();

  // Seitenweise lesen. Zwei Details, die leicht schiefgehen:
  //  - Weitergerückt wird um die TATSÄCHLICHE Zeilenzahl der Seite, und
  //    abgebrochen wird nur bei einer LEEREN Seite. Würde man auf
  //    "Seite kürzer als PAGE_SIZE" prüfen, bräche die Schleife still nach der
  //    ersten Seite ab, sobald "Max rows" kleiner als PAGE_SIZE eingestellt ist
  //    — mit stillschweigend fehlender Historie.
  //  - Sortiert wird aufsteigend nach Zeit. Das macht das seitenweise Lesen
  //    unempfindlich gegen gleichzeitige Schreibvorgänge: neue Zeilen von
  //    /api/collect haben immer die GRÖSSTE Zeit, hängen sich also hinten an
  //    und verschieben nichts; und das Aufräumen alter Zeilen betrifft nur
  //    Daten außerhalb des 12h-Fensters. (station_code als zweites
  //    Sortierkriterium sorgt für eine eindeutige Reihenfolge.)
  const rows: MeasurementRow[] = [];
  let offset = 0;
  let pages = 0;
  let truncated = false;
  while (pages < MAX_PAGES) {
    const query =
      `${supabaseUrl}/rest/v1/wind_measurements` +
      `?measured_at=gte.${encodeURIComponent(sinceIso)}` +
      `&order=measured_at.asc,station_code.asc` +
      `&select=station_code,measured_at,direction,speed_kmh,gust_kmh` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;

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

    const page: MeasurementRow[] = await res.json();
    if (page.length === 0) break;
    rows.push(...page);
    offset += page.length;
    pages += 1;
    if (pages === MAX_PAGES) truncated = true;
  }
  if (truncated) {
    console.warn(
      `/api/timeline: Seiten-Obergrenze erreicht (${rows.length} Zeilen) — ` +
        "die jüngsten Messwerte fehlen möglicherweise.",
    );
  }

  // Zeilen in die Spalten einsortieren. Pro Station und Rasterpunkt bleibt
  // genau ein Wert übrig — dieselbe Vorrangregel wie im Verlaufsbalken
  // (snapPointsToGrid): Messungen mit Werten schlagen leere, danach entscheidet
  // der kleinere Abstand zum Rasterpunkt.
  const stations: Record<string, TimelineSeries> = {};
  const distances = new Map<string, number[]>();
  for (const row of rows) {
    const t = Date.parse(row.measured_at);
    if (Number.isNaN(t)) continue;
    const idx = Math.round((snapToGrid(t) - start) / GRID_MS);
    if (idx < 0 || idx >= times.length) continue;

    let series = stations[row.station_code];
    if (!series) {
      series = {
        d: new Array<number | null>(times.length).fill(null),
        s: new Array<number | null>(times.length).fill(null),
        g: new Array<number | null>(times.length).fill(null),
      };
      stations[row.station_code] = series;
      distances.set(row.station_code, new Array<number>(times.length).fill(Infinity));
    }

    const dist = Math.abs(t - times[idx]);
    const taken = distances.get(row.station_code)!;
    const hasData = row.speed_kmh !== null || row.gust_kmh !== null;
    const curHasData = series.s[idx] !== null || series.g[idx] !== null;
    const occupied = taken[idx] !== Infinity;
    const better =
      !occupied ||
      (hasData && !curHasData) ||
      (hasData === curHasData && dist < taken[idx]);
    if (!better) continue;

    series.d[idx] = round0(row.direction);
    series.s[idx] = round0(row.speed_kmh);
    series.g[idx] = round0(row.gust_kmh);
    taken[idx] = dist;
  }

  const payload: TimelinePayload = {
    hours: HISTORY_HOURS,
    stepMinutes: TIMELINE_STEP_MINUTES,
    generatedAt: times[times.length - 1],
    times,
    rows: rows.length,
    truncated,
    stations,
  };
  return NextResponse.json(payload, {
    headers: { "Cache-Control": RESPONSE_CACHE_CONTROL },
  });
}
