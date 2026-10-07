import { NextResponse } from "next/server";
import {
  buildTimelineSlots,
  GRID_MS,
  HISTORY_HOURS,
  snapToGrid,
  SOURCE_INTERVAL_MINUTES,
  TIMELINE_STEP_MINUTES,
  type WindStation,
  type TimelinePayload,
  type TimelineSeries,
} from "@/lib/wind";
import { assessSeries, encodeSuspectFlags } from "@/lib/plausibility";

// Liefert die Messwerte ALLER Stationen der letzten HISTORY_HOURS Stunden
// (aktuell 12) aus der Supabase-Tabelle wind_measurements — die Datengrundlage
// für den Zeitbalken unter der Karte (TimeSlider.tsx).
//
// Aufruf: /api/timeline  (keine Parameter)
//
// Gegenstück zu /api/history, das dasselbe für EINE Station tut. Hier wäre ein
// Zeilen-JSON (~700 Stationen × 73 Zeitpunkte) mehrere hundert KB groß,
// deshalb ein kompaktes SPALTEN-Format: eine gemeinsame Zeitliste und pro
// Station drei gleich lange Zahlenreihen (siehe TimelinePayload in
// src/lib/wind.ts). Das sind einige Dutzend KB komprimiert.
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
// endlos weiterliest. 100 Seiten = 100.000 Zeilen ≈ das Zweieinhalbfache der
// Erwartung: Im Okt. 2026 lagen in 12 h rund 41.000 Zeilen (gut 700 Stationen
// aus allen Quellen). Die frühere Grenze von 80 Seiten war damit nur noch
// knapp doppelt so groß — bei neuen Quellen oder einem längeren HISTORY_HOURS
// hier nachrechnen, sonst fehlen still die jüngsten Werte.
const MAX_PAGES = 100;
// So viele Seiten werden gleichzeitig angefragt. Nacheinander wären es gut 40
// Anfragen, jede mit eigener Wartezeit — zusammen mehrere Sekunden. Zu je 8
// sind es rund 6 Runden.
const PARALLEL_PAGES = 8;

// Zwischenspeicherung wie bei /api/history: Neue Messwerte kommen nur alle
// 10 Minuten dazu (Messtakt der Stationen). Fehlerantworten bekommen bewusst
// KEINEN solchen Header, damit sich eine kurze Störung nicht 60 s lang
// festsetzt.
const RESPONSE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

interface MeasurementRow {
  station_code: string;
  measured_at: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
  source: string | null;
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

  // Seitenweise lesen, je PARALLEL_PAGES Seiten gleichzeitig. Details, die
  // leicht schiefgehen:
  //  - Weitergerückt wird um die TATSÄCHLICHE Zeilenzahl der Seite, und
  //    abgebrochen wird nur bei einer LEEREN Seite. Würde man auf
  //    "Seite kürzer als PAGE_SIZE" prüfen, bräche die Schleife still nach der
  //    ersten Seite ab, sobald "Max rows" kleiner als PAGE_SIZE eingestellt ist
  //    — mit stillschweigend fehlender Historie.
  //  - Die gleichzeitigen Seiten setzen voraus, dass jede volle Seite genau
  //    pageSize Zeilen hat. Kommt eine Seite KÜRZER zurück, ist das entweder
  //    das Ende der Daten oder eine kleinere "Max rows"-Einstellung. Dann
  //    werden die übrigen Seiten dieser Runde verworfen (ihre Startpunkte
  //    stimmen womöglich nicht), pageSize auf die tatsächliche Länge gesetzt
  //    und ab genau dort weitergelesen. War es das Ende, ist die erste Seite
  //    der nächsten Runde leer.
  //  - Sortiert wird aufsteigend nach Zeit. Das macht das seitenweise Lesen
  //    unempfindlich gegen gleichzeitige Schreibvorgänge: neue Zeilen von
  //    /api/collect haben immer die GRÖSSTE Zeit, hängen sich also hinten an
  //    und verschieben nichts; und das Aufräumen alter Zeilen betrifft nur
  //    Daten außerhalb des 12h-Fensters. (station_code als zweites
  //    Sortierkriterium sorgt für eine eindeutige Reihenfolge.)
  const fetchPage = async (
    from: number,
    size: number,
  ): Promise<MeasurementRow[] | { error: string }> => {
    const query =
      `${supabaseUrl}/rest/v1/wind_measurements` +
      `?measured_at=gte.${encodeURIComponent(sinceIso)}` +
      `&order=measured_at.asc,station_code.asc` +
      `&select=station_code,measured_at,direction,speed_kmh,gust_kmh,source` +
      `&limit=${size}&offset=${from}`;
    let res: Response;
    try {
      res = await fetch(query, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        cache: "no-store",
      });
    } catch {
      return { error: "Supabase ist nicht erreichbar" };
    }
    if (!res.ok) return { error: `Supabase antwortete mit Status ${res.status}` };
    return (await res.json()) as MeasurementRow[];
  };

  const rows: MeasurementRow[] = [];
  let offset = 0;
  let pageSize = PAGE_SIZE;
  let pages = 0;
  let finished = false;
  while (!finished && pages < MAX_PAGES) {
    const count = Math.min(PARALLEL_PAGES, MAX_PAGES - pages);
    const batch = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        fetchPage(offset + i * pageSize, pageSize),
      ),
    );
    pages += count;

    for (const page of batch) {
      if (!Array.isArray(page)) {
        return NextResponse.json({ error: page.error }, { status: 502 });
      }
      if (page.length === 0) {
        finished = true;
        break;
      }
      rows.push(...page);
      offset += page.length;
      if (page.length < pageSize) {
        // Ende der Daten oder kleinere "Max rows"-Einstellung (siehe oben):
        // Rest der Runde verwerfen und ab hier mit der echten Seitenlänge
        // weiterlesen.
        pageSize = page.length;
        break;
      }
    }
  }
  const truncated = !finished;
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
  const sourceByStation = new Map<string, string>();
  for (const row of rows) {
    if (row.source) sourceByStation.set(row.station_code, row.source);
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

  // Quellen mit langsamerem Messtakt (SLF: 30 min) haben nur an jedem dritten
  // Rasterpunkt einen Wert. Damit diese Stationen beim Blättern nicht an
  // :10/:20/:40/:50 grau werden, bleibt ihr letzter Messwert bis kurz vor dem
  // nächsten stehen — genau so, wie es die Live-Karte zu diesem Zeitpunkt
  // gezeigt hätte (der jüngste verfügbare Wert). Erfunden wird nichts: Fehlt
  // eine Messung, endet das Halten nach einem Takt, und die Station wird grau.
  for (const [code, series] of Object.entries(stations)) {
    const source = sourceByStation.get(code) as WindStation["source"] | undefined;
    const intervalMin = source ? SOURCE_INTERVAL_MINUTES[source] : undefined;
    if (!intervalMin || intervalMin <= TIMELINE_STEP_MINUTES) continue;
    const holdSlots = Math.ceil(intervalMin / TIMELINE_STEP_MINUTES) - 1;
    let lastReal = -Infinity;
    for (let i = 0; i < times.length; i++) {
      const empty = series.d[i] === null && series.s[i] === null && series.g[i] === null;
      if (!empty) {
        lastReal = i;
      } else if (i - lastReal <= holdSlots) {
        series.d[i] = series.d[lastReal];
        series.s[i] = series.s[lastReal];
        series.g[i] = series.g[lastReal];
      }
    }
  }

  // Wahrscheinliche Messfehler markieren (stundenlang exakt dieselben Werte,
  // klemmende Windfahne, unmögliche Werte — Regeln in src/lib/plausibility.ts).
  // Erst NACH dem Halten der SLF-Werte, damit die Prüfung genau das sieht, was
  // die Karte zeigt. Das Feld q bekommen nur auffällige Stationen.
  for (const [code, series] of Object.entries(stations)) {
    const source = sourceByStation.get(code) as WindStation["source"] | undefined;
    const q = encodeSuspectFlags(assessSeries(series, times, source));
    if (q) series.q = q;
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
