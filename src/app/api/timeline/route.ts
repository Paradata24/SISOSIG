import { NextResponse } from "next/server";
import {
  buildTimelineSlots,
  DATABASE_TIMEOUT_MS,
  GRID_MS,
  HISTORY_HOURS,
  snapToGrid,
  SOURCE_INTERVAL_MINUTES,
  STALE_AFTER_MINUTES,
  TIMELINE_STEP_MINUTES,
  type WindStation,
  type TimelinePayload,
  type TimelineSeries,
  type SuspectInfo,
} from "@/lib/wind";
import { assessSeries, encodeSuspectFlags, LONGEST_RULE_MINUTES } from "@/lib/plausibility";

// Liefert die Messwerte ALLER Stationen der letzten HISTORY_HOURS Stunden
// (seit Nov. 2026 48, vorher 12) aus der Supabase-Tabelle wind_measurements — die Datengrundlage
// für den Zeitbalken unter der Karte (TimeSlider.tsx).
//
// Aufruf: /api/timeline           die vollen HISTORY_HOURS (48 h)
//         /api/timeline?hours=8   nur die letzten 8 h (TIMELINE_RECENT_HOURS)
// Die kurze Form (Punkt 27, Nov. 2026) holt die Seite nach dem ersten Laden
// alle 10 Minuten und fügt sie in den vorhandenen Stand ein
// (src/lib/timelineMerge.ts); der Flugmodus braucht nur sie. Erlaubt ist jede
// ganze Zahl von 1 bis HISTORY_HOURS — die Seite benutzt aber immer dieselbe,
// damit sich alle Besucher die Antwort im CDN teilen.
//
// Gegenstück zu /api/history, das dasselbe für EINE Station tut. Hier wäre ein
// Zeilen-JSON (~650 Stationen × 289 Zeitpunkte) mehrere MB groß,
// deshalb ein kompaktes SPALTEN-Format: eine gemeinsame Zeitliste und pro
// Station drei gleich lange Zahlenreihen (siehe TimelinePayload in
// src/lib/wind.ts). Bei 48 h kommen aus der Datenbank rund 8 MB (~136.000
// Zeilen, ~0,6 s, Nov. 2026 gemessen); an den Browser geht davon nur das
// Spaltenformat, komprimiert einige hundert KB.
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

// Vorlauf der Berechnung in Rasterpunkten: so weit, wie die längste
// Messfehler-Regel zurückschaut (3 h = 18 Punkte). Deckt auch das Halten der
// SLF-Werte (20 min) ab. Kostet rund 6 % mehr gelesene Zeilen.
const LEAD_SLOTS = Math.ceil(LONGEST_RULE_MINUTES / TIMELINE_STEP_MINUTES);

/** Auf ganze Zahlen runden — kürzeres JSON, und die Karte rundet ohnehin. */
function round0(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/**
 * Noch nicht eingetroffene Werte am ENDE des Zeitraums überbrücken (Nov. 2026,
 * Rückmeldung des Projektbesitzers: "Um 20:50 verschwinden alle Südtiroler
 * Stationen").
 *
 * Grund: Die jüngsten Rasterpunkte sind beim Laden oft noch leer, weil die
 * Werte erst später in der Datenbank ankommen. Beim Bozner Dienst sind das
 * typisch 15 min (er hinkt 5–10 min nach, dazu bis zu 5 min bis zum nächsten
 * Sammel-Lauf; am 10.11.2026 gemessen: Wert von 20:50 gespeichert um 21:05).
 * Ohne diese Regel waren deshalb um 21:03 an 20:50 und 21:00 ALLE Bozner
 * Stationen grau bzw. in der Übersicht unsichtbar — obwohl keine ausgefallen
 * war. MeteoSchweiz und Meteotrentino trifft es genauso.
 *
 * Die Regel: Fehlen einer Station nur die allerletzten Punkte, und ist ihr
 * letzter echter Wert jünger als die Grau-Grenze ihrer Quelle
 * (STALE_AFTER_MINUTES), bleibt dieser bis zum Ende stehen — genau das, was
 * die Live-Karte in diesem Moment zeigt. Ist er älter, wird nichts gehalten
 * (die Station ist dann auch live grau). Lücken MITTEN im Verlauf
 * bleiben unverändert grau (fehlt nur bei einer Station ein Wert, während
 * danach schon neuere da sind, ist das eine echte Lücke). Sobald der echte
 * Wert eintrifft, ersetzt ihn das nächste Laden (alle 10 min, die letzten 8 h
 * werden komplett neu eingefügt, src/lib/timelineMerge.ts).
 *
 * Gibt die Zahl der gehaltenen Punkte am Ende zurück (Feld h in
 * TimelineSeries). assessLive (src/lib/plausibility.ts) lässt sie weg — sonst
 * verlängerten die Kopien einen scheinbar eingefrorenen Abschnitt.
 */
function holdTrailingValues(
  series: TimelineSeries,
  flags: (SuspectInfo | null)[],
  times: number[],
  source: WindStation["source"] | undefined,
): number {
  if (!source) return 0;
  const end = times.length - 1;
  let lastReal = end;
  while (
    lastReal >= 0 &&
    series.d[lastReal] === null &&
    series.s[lastReal] === null &&
    series.g[lastReal] === null
  ) {
    lastReal--;
  }
  // Kein Wert, oder der letzte ist schon zu alt (Station wäre auch live grau):
  // nichts halten — dann ist es eine echte Lücke, keine verspätete Lieferung.
  if (lastReal < 0 || lastReal === end) return 0;
  if (times[end] - times[lastReal] > STALE_AFTER_MINUTES[source] * 60_000) return 0;
  for (let i = lastReal + 1; i <= end; i++) {
    series.d[i] = series.d[lastReal];
    series.s[i] = series.s[lastReal];
    series.g[i] = series.g[lastReal];
    flags[i] = flags[lastReal];
  }
  return end - lastReal;
}

export async function GET(request: Request) {
  const hoursParam = new URL(request.url).searchParams.get("hours");
  const hours = hoursParam === null ? HISTORY_HOURS : Number(hoursParam);
  if (!Number.isInteger(hours) || hours < 1 || hours > HISTORY_HOURS) {
    return NextResponse.json(
      { error: `hours muss eine ganze Zahl von 1 bis ${HISTORY_HOURS} sein` },
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

  // Ausgeliefert werden die Rasterpunkte `times`. Gerechnet wird aber über
  // `calcTimes` = LEAD_SLOTS Rasterpunkte (3 h) davor plus `times` (Nov. 2026,
  // Punkt 27): Das Halten der SLF-Werte und die Messfehler-Regeln schauen bis
  // zu 3 h zurück. Ohne diesen Vorlauf fehlte am Anfang des Fensters z. B. ein
  // SLF-Wert von kurz davor, und ein langer eingefrorener Abschnitt war am
  // Anfang nicht markiert. So ist jeder ausgelieferte Punkt richtig, egal wo das
  // Fenster beginnt — die Voraussetzung dafür, dass die Seite das kurze
  // Fenster in ihren Stand einfügen kann (src/lib/timelineMerge.ts).
  const times = buildTimelineSlots(Date.now(), hours);
  const calcTimes = [
    ...Array.from({ length: LEAD_SLOTS }, (_, i) => times[0] - (LEAD_SLOTS - i) * GRID_MS),
    ...times,
  ];
  const start = calcTimes[0];
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

  // Zeilen in die Spalten einsortieren (über calcTimes, samt Vorlauf). Pro
  // Station und Rasterpunkt bleibt genau ein Wert übrig — dieselbe Vorrangregel
  // wie im Verlaufsbalken (snapPointsToGrid): Messungen mit Werten schlagen
  // leere, danach entscheidet der kleinere Abstand zum Rasterpunkt.
  const calc: Record<string, TimelineSeries> = {};
  const distances = new Map<string, number[]>();
  const sourceByStation = new Map<string, string>();
  for (const [code, t, direction, speedKmh, gustKmh, source] of rows) {
    if (source) sourceByStation.set(code, source);
    if (!Number.isFinite(t)) continue;
    const idx = Math.round((snapToGrid(t) - start) / GRID_MS);
    if (idx < 0 || idx >= calcTimes.length) continue;

    let series = calc[code];
    if (!series) {
      series = {
        d: new Array<number | null>(calcTimes.length).fill(null),
        s: new Array<number | null>(calcTimes.length).fill(null),
        g: new Array<number | null>(calcTimes.length).fill(null),
      };
      calc[code] = series;
      distances.set(code, new Array<number>(calcTimes.length).fill(Infinity));
    }

    const dist = Math.abs(t - calcTimes[idx]);
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
  for (const [code, series] of Object.entries(calc)) {
    const source = sourceByStation.get(code) as WindStation["source"] | undefined;
    const intervalMin = source ? SOURCE_INTERVAL_MINUTES[source] : undefined;
    if (!intervalMin || intervalMin <= TIMELINE_STEP_MINUTES) continue;
    const holdSlots = Math.ceil(intervalMin / TIMELINE_STEP_MINUTES) - 1;
    let lastReal = -Infinity;
    for (let i = 0; i < calcTimes.length; i++) {
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
  // die Karte zeigt. Danach den Vorlauf wieder abschneiden: Ausgeliefert
  // werden nur `times`, und nur Stationen mit mindestens einem Wert darin. Das
  // Feld q bekommen nur auffällige Stationen.
  const stations: Record<string, TimelineSeries> = {};
  for (const [code, full] of Object.entries(calc)) {
    const source = sourceByStation.get(code) as WindStation["source"] | undefined;
    const allFlags = assessSeries(full, calcTimes, source);
    // Erst NACH der Messfehler-Prüfung: Die gehaltenen Werte sind Kopien und
    // dürfen keinen "eingefrorenen" Abschnitt verlängern.
    const held = holdTrailingValues(full, allFlags, calcTimes, source);
    const flags = allFlags.slice(LEAD_SLOTS);
    const series: TimelineSeries = {
      d: full.d.slice(LEAD_SLOTS),
      s: full.s.slice(LEAD_SLOTS),
      g: full.g.slice(LEAD_SLOTS),
    };
    const empty = (values: (number | null)[]) => values.every((v) => v === null);
    if (empty(series.d) && empty(series.s) && empty(series.g)) continue;
    const q = encodeSuspectFlags(flags);
    if (q) series.q = q;
    if (held > 0) series.h = held;
    stations[code] = series;
  }

  const payload: TimelinePayload = {
    hours,
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
