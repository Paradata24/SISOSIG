import { NextResponse } from "next/server";
import {
  buildTimelineSlots,
  DATABASE_TIMEOUT_MS,
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
// Geladen wird über die Datenbank-Funktion wind_timeline
// (supabase/zeitbalken-funktion.sql) in EINER Anfrage (Okt. 2026, Punkt 7 der
// Code-Durchsicht). Vorher las die Route die Tabelle seitenweise, weil
// Supabase pro Anfrage höchstens 1000 Zeilen herausgibt ("Max rows"): gut 30
// Seiten je 8 gleichzeitig, zusammen gut 2 s. Die Funktion gibt alle Zeilen
// als einen einzigen JSON-Wert zurück, für den diese Grenze nicht gilt. Sie
// filtert nur nach Zeit; schnell macht das der Index auf measured_at
// (supabase/add-measured-at-index.sql bzw. schema.sql).

// Diese Route liest nichts aus der Anfrage, ihr Ergebnis hängt aber an der
// aktuellen Uhrzeit. Ohne diese Zeile könnte Next sie beim Bauen einmalig
// vorberechnen und dauerhaft dieselbe (dann veraltete) Antwort ausliefern.
export const dynamic = "force-dynamic";

// Zwischenspeicherung wie bei /api/history: Neue Messwerte kommen nur alle
// 10 Minuten dazu (Messtakt der Stationen). Fehlerantworten bekommen bewusst
// KEINEN solchen Header, damit sich eine kurze Störung nicht 60 s lang
// festsetzt.
const RESPONSE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

// Eine Zeile aus wind_timeline — als kurze Liste statt als Objekt (spart gut
// die Hälfte der Datenmenge): [Stationscode, Messzeit in ms (UTC), Richtung,
// Mittelwind, Böe, Quelle].
type TimelineRow = [string, number, number | null, number | null, number | null, string | null];

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

  // Alle Zeilen in einer Anfrage (siehe oben). Das Zeitlimit gilt auch für
  // das Lesen der Antwort — deshalb steht res.json() mit im try.
  let rows: TimelineRow[];
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/wind_timeline`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ since: sinceIso }),
      cache: "no-store",
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 = die Funktion fehlt in dieser Datenbank.
      const hint =
        res.status === 404 ? " (Funktion fehlt: supabase/zeitbalken-funktion.sql ausführen)" : "";
      console.error(`/api/timeline: Supabase antwortete mit Status ${res.status}${hint}`);
      return NextResponse.json(
        { error: `Supabase antwortete mit Status ${res.status}${hint}` },
        { status: 502 },
      );
    }
    rows = (await res.json()) as TimelineRow[];
  } catch {
    return NextResponse.json({ error: "Supabase ist nicht erreichbar" }, { status: 502 });
  }

  // Zeilen in die Spalten einsortieren. Pro Station und Rasterpunkt bleibt
  // genau ein Wert übrig — dieselbe Vorrangregel wie im Verlaufsbalken
  // (snapPointsToGrid): Messungen mit Werten schlagen leere, danach entscheidet
  // der kleinere Abstand zum Rasterpunkt.
  const stations: Record<string, TimelineSeries> = {};
  const distances = new Map<string, number[]>();
  const sourceByStation = new Map<string, string>();
  for (const [code, t, direction, speedKmh, gustKmh, source] of rows) {
    if (source) sourceByStation.set(code, source);
    if (!Number.isFinite(t)) continue;
    const idx = Math.round((snapToGrid(t) - start) / GRID_MS);
    if (idx < 0 || idx >= times.length) continue;

    let series = stations[code];
    if (!series) {
      series = {
        d: new Array<number | null>(times.length).fill(null),
        s: new Array<number | null>(times.length).fill(null),
        g: new Array<number | null>(times.length).fill(null),
      };
      stations[code] = series;
      distances.set(code, new Array<number>(times.length).fill(Infinity));
    }

    const dist = Math.abs(t - times[idx]);
    const taken = distances.get(code)!;
    const hasData = speedKmh !== null || gustKmh !== null;
    const curHasData = series.s[idx] !== null || series.g[idx] !== null;
    const occupied = taken[idx] !== Infinity;
    const better =
      !occupied ||
      (hasData && !curHasData) ||
      (hasData === curHasData && dist < taken[idx]);
    if (!better) continue;

    series.d[idx] = round0(direction);
    series.s[idx] = round0(speedKmh);
    series.g[idx] = round0(gustKmh);
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
    stations,
  };
  return NextResponse.json(payload, {
    headers: { "Cache-Control": RESPONSE_CACHE_CONTROL },
  });
}
