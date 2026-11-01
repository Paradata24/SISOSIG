import { GRID_MS, type TimelinePayload, type TimelineSeries } from "./wind";
import { LONGEST_RULE_MINUTES } from "./plausibility";

// Zeitbalken-Daten auffrischen, ohne alles neu zu laden (Punkt 27 der
// Code-Durchsicht, Nov. 2026).
//
// Die vollen 48 h (/api/timeline) sind rund 450 KB. Bis Nov. 2026 holte die
// Seite sie alle 10 Minuten komplett neu, obwohl sich nur das jüngste Stück
// ändert — knapp 3 MB pro Stunde, auch im Flugmodus. Jetzt holt WindApp nach
// dem ersten Laden nur noch die letzten TIMELINE_RECENT_HOURS (8 h, rund
// 80 KB, /api/timeline?hours=8) und ersetzt damit hier die letzten 8 h des
// vorhandenen Stands.
//
// DAS ERGEBNIS IST DASSELBE WIE BEIM VOLLEN LADEN (geprüft mit einer
// Simulation über 90 Auffrischungen mit eingefrorenen Abschnitten, klemmenden
// Windfahnen, SLF-Werten und verspäteten Werten). Das geht, weil
// /api/timeline jeden ausgelieferten Punkt mit 3 h Vorlauf berechnet (dort
// LEAD_SLOTS) — Messfehler-Kennzeichen und gehaltene SLF-Werte sind also auch
// am Anfang des kurzen Fensters richtig. Bleibt eine Bedingung: Ein Abschnitt,
// der zwischen zwei Ständen gerade lang genug für eine Messfehler-Markierung
// geworden ist, wird als GANZES markiert, auch rückwirkend. Er muss deshalb
// ganz im neuen 8-h-Fenster liegen. Das ist sicher, solange zwischen den
// beiden Ständen höchstens 8 h − 3 h (längste Regel) = 5 h liegen. Sonst lehnt
// mergeRecentTimeline ab (null), und WindApp lädt die vollen 48 h.
// Nicht erfasst werden nur Werte, die mehr als 8 h verspätet in der Datenbank
// ankommen (der Sammler holt höchstens 3 h nach) — die zeigt erst das nächste
// volle Laden.

const LEAD_MS = LONGEST_RULE_MINUTES * 60_000;

/**
 * Höchstens so lange darf das letzte erfolgreiche Laden zurückliegen, damit
 * WindApp nur das kurze Fenster holt (sonst gleich die vollen 48 h). Deutlich
 * unter den 5 h aus der Rechnung oben: Das CDN liefert eine Antwort bis zu
 * 6 Minuten alt aus (/api/timeline: 60 s plus Nachfrist 300 s), und die Uhr
 * des Handys darf etwas falsch gehen.
 */
export const TIMELINE_MERGE_MAX_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * Das kurze Fenster `recent` in den bisherigen Stand `base` einfügen. Das
 * Ergebnis ist so lang wie `base` (48 h bzw. im Flugmodus 8 h) und endet mit
 * dem jüngsten Zeitpunkt von `recent`. Ist `recent` älter als `base` (z. B.
 * eine gespeicherte Antwort des Offline-Helfers), bleibt `base` unverändert.
 * null = passt nicht zusammen (zu großer Abstand zwischen den beiden
 * Ständen) — dann alles neu laden.
 */
export function mergeRecentTimeline(
  base: TimelinePayload,
  recent: TimelinePayload,
): TimelinePayload | null {
  if (base.times.length === 0 || recent.times.length === 0) return null;
  const baseStart = base.times[0];
  const baseEnd = base.times[base.times.length - 1];
  const recentStart = recent.times[0];
  const recentEnd = recent.times[recent.times.length - 1];
  if (recentEnd < baseEnd) return base;
  // Höchstens (Fenster − längste Regel) Abstand, siehe Rechnung oben.
  if (recentEnd - baseEnd > recentEnd - recentStart - LEAD_MS) return null;

  const count = base.times.length;
  const times = Array.from({ length: count }, (_, i) => recentEnd - (count - 1 - i) * GRID_MS);

  const codes = new Set([...Object.keys(base.stations), ...Object.keys(recent.stations)]);
  const stations: Record<string, TimelineSeries> = {};
  for (const code of codes) {
    const d = new Array<number | null>(count).fill(null);
    const s = new Array<number | null>(count).fill(null);
    const g = new Array<number | null>(count).fill(null);
    const q: string[] = new Array<string>(count).fill(".");
    let hasValue = false;
    let flagged = false;
    for (let i = 0; i < count; i++) {
      const t = times[i];
      // Die letzten 8 h aus recent, alles davor aus dem bisherigen Stand.
      const fromRecent = t >= recentStart;
      const from = fromRecent ? recent : base;
      const series = from.stations[code];
      if (!series) continue;
      const j = Math.round((t - (fromRecent ? recentStart : baseStart)) / GRID_MS);
      if (j < 0 || j >= from.times.length) continue;
      d[i] = series.d[j] ?? null;
      s[i] = series.s[j] ?? null;
      g[i] = series.g[j] ?? null;
      if (d[i] !== null || s[i] !== null || g[i] !== null) hasValue = true;
      const flag = series.q?.[j];
      if (flag && flag !== ".") {
        q[i] = flag;
        flagged = true;
      }
    }
    // Stationen ganz ohne Werte im neuen Zeitraum weglassen (wie /api/timeline,
    // das nur Stationen mit Messungen liefert).
    if (!hasValue) continue;
    stations[code] = flagged ? { d, s, g, q: q.join("") } : { d, s, g };
  }

  return {
    hours: base.hours,
    stepMinutes: base.stepMinutes,
    generatedAt: recent.generatedAt,
    times,
    rows: base.rows, // nur zur Fehlersuche, siehe TimelinePayload
    stations,
  };
}
