import {
  GRID_MS,
  snapToGrid,
  SUSPECT_CODES,
  type SuspectInfo,
  type SuspectReason,
  type TimelineSeries,
  type WindStation,
} from "@/lib/wind";

// Erkennt Messwerte, die wahrscheinlich ein MESSFEHLER sind (Wunsch des
// Projektbesitzers, Okt. 2026): Solche Stationen stehen auf der Karte als
// grauer Punkt statt als Pfeil, und beim Anklicken steht im Verlaufsbalken ein
// Hinweis. Typische Ursachen in den Alpen: vereistes Windrad oder vereiste
// Windfahne, hängender Datenlogger, Übertragungsfehler.
//
// Genutzt an zwei Stellen:
//  - /api/timeline rechnet für alle Stationen und alle Rasterpunkte der letzten
//    12 h aus, wann sie auffällig waren (Feld q, siehe TimelineSeries) — für
//    den Zeitbalken und dessen Farbstrich.
//  - WindMap prüft die aktuellen Live-Werte (assessLive): die 12 h aus
//    /api/timeline plus der neueste Wert von /api/wind.
//
// Grundlage sind die auf ganze km/h bzw. Grad gerundeten Werte von
// /api/timeline. Die Grenzwerte sind an echten Daten geprüft (alle Quellen,
// 2 Tage, Okt. 2026, rund 120.000 Messungen): Mit diesen Werten wurde keine
// einzige Station fälschlich markiert. Bitte nicht ohne eine solche Prüfung
// verschärfen — ein grauer Punkt an einer funktionierenden Station wäre
// schlimmer als ein übersehener Fehler.

// --- Regel 1: "eingefroren" ---
// Mittelwind, Böe UND Richtung bleiben exakt gleich. In der Natur schwanken
// Böe und Richtung von Messung zu Messung; mindestens 90 min lang alle drei
// unverändert kommt bei echtem Wind praktisch nicht vor (in den Testdaten
// höchstens 70 min, Hafelekar). 90 min = 10 Messungen im 10-Minuten-Takt bzw.
// 4 Messungen beim SLF (30-Minuten-Takt).
const FROZEN_MIN_MINUTES = 90;
// Mindestens so viele Rasterpunkte mit Wert. Verhindert, dass zwei zufällig
// gleiche Messungen mit einer langen Lücke dazwischen als "eingefroren" gelten.
const FROZEN_MIN_VALUES = 4;
// Bei Windstille (0 km/h) ist "stundenlang dieselben Werte" normal — nachts in
// Tälern sogar die Regel. Deshalb gilt die Regel erst ab diesem Mittelwind.
const FROZEN_MIN_SPEED_KMH = 3;

// --- Regel 2: "Windfahne klemmt" ---
// Nur die Richtung bleibt exakt gleich, obwohl die ganze Zeit spürbar Wind
// weht (typisch: vereiste Windfahne). Richtung schwankt selbst bei
// gleichmäßigem Föhn um einige Grad — 3 h auf das Grad genau ist auffällig.
const VANE_MIN_MINUTES = 180;
const VANE_MIN_VALUES = 6;
const VANE_MIN_SPEED_KMH = 5;
// Nur für Quellen, die die Richtung fein (auf 1°) liefern. Pioupiou meldet nur
// 16 Richtungen (22,5°-Schritte), der DWD 10°-Schritte — dort bleibt die Richtung
// bei gleichmäßigem Wind auch ohne Fehler stundenlang im selben Schritt (in den
// Testdaten z. B. Bälmeten fast 12 h auf 135°).
const VANE_CHECK_SOURCES = new Set<WindStation["source"]>([
  "bolzano",
  "slf",
  "geosphere",
  "meteoswiss",
  "lwdtirol",
]);

// --- Regel 3: "unplausibler Wert" ---
// Einzelne Werte, die physikalisch nicht sein können. Kam in den Testdaten nie
// vor, ist aber eine billige Absicherung gegen kaputte Daten einer Quelle.
const MAX_SPEED_KMH = 150;
const MAX_GUST_KMH = 250;
// Die Böe ist die Spitze, der Mittelwind der Durchschnitt — die Böe kann also
// nicht kleiner sein. Etwas Spielraum wegen Rundung und leicht versetzter
// Messzeitpunkte.
const GUST_BELOW_SPEED_TOLERANCE_KMH = 3;

/** true, wenn schon ein einzelner Wert physikalisch unmöglich ist (Regel 3). */
function isImplausible(
  speed: number | null,
  gust: number | null,
  direction: number | null,
): boolean {
  if (speed !== null && (speed < 0 || speed > MAX_SPEED_KMH)) return true;
  if (gust !== null && (gust < 0 || gust > MAX_GUST_KMH)) return true;
  if (speed !== null && gust !== null && gust < speed - GUST_BELOW_SPEED_TOLERANCE_KMH) {
    return true;
  }
  if (direction !== null && (direction < 0 || direction > 360)) return true;
  return false;
}

/**
 * Prüft die Messreihe EINER Station und liefert je Rasterpunkt die
 * Auffälligkeit (oder null). `times` muss aufsteigend sein, darf aber
 * ungleichmäßig sein (assessLive hängt den Live-Wert hinten an).
 *
 * Ein eingefrorener Abschnitt wird VOLLSTÄNDIG markiert, sobald er als Ganzes
 * lang genug ist — auch seine ersten Rasterpunkte. So zeigt der Zeitbalken
 * beim Zurückblättern den ganzen fehlerhaften Abschnitt grau.
 * Rasterpunkte ohne Messung bleiben null (die sind ohnehin grau, "stale").
 */
export function assessSeries(
  series: TimelineSeries,
  times: number[],
  source: WindStation["source"] | undefined,
): (SuspectInfo | null)[] {
  const { s, g, d } = series;
  const result: (SuspectInfo | null)[] = new Array(times.length).fill(null);

  // Nur Rasterpunkte mit Messung. Lücken unterbrechen einen Abschnitt nicht —
  // nach einer Lücke wieder exakt dieselben Werte sind genauso verdächtig.
  const measured: number[] = [];
  for (let i = 0; i < times.length; i++) {
    if (s[i] !== null || g[i] !== null || d[i] !== null) measured.push(i);
  }

  // Regel 3 zuerst: Sie betrifft einzelne Werte und hat Vorrang.
  for (const i of measured) {
    if (isImplausible(s[i], g[i], d[i])) {
      result[i] = { reason: "implausible", since: times[i] };
    }
  }

  // Abschnitte gleicher Werte suchen und lange genug markieren. Bereits
  // markierte Rasterpunkte bleiben, wie sie sind (Vorrang: unplausibel vor
  // eingefroren vor Windfahne).
  const markRuns = (
    reason: SuspectReason,
    eligible: (i: number) => boolean,
    same: (a: number, b: number) => boolean,
    minMinutes: number,
    minValues: number,
  ) => {
    let start = 0;
    while (start < measured.length) {
      if (!eligible(measured[start])) {
        start++;
        continue;
      }
      let end = start;
      while (
        end + 1 < measured.length &&
        eligible(measured[end + 1]) &&
        same(measured[start], measured[end + 1])
      ) {
        end++;
      }
      const first = measured[start];
      const last = measured[end];
      const count = end - start + 1;
      if (count >= minValues && times[last] - times[first] >= minMinutes * 60_000) {
        for (let k = start; k <= end; k++) {
          const i = measured[k];
          if (!result[i]) result[i] = { reason, since: times[first] };
        }
      }
      start = end + 1;
    }
  };

  markRuns(
    "frozen",
    (i) => s[i] !== null && s[i]! >= FROZEN_MIN_SPEED_KMH,
    (a, b) => s[a] === s[b] && g[a] === g[b] && d[a] === d[b],
    FROZEN_MIN_MINUTES,
    FROZEN_MIN_VALUES,
  );

  if (source && VANE_CHECK_SOURCES.has(source)) {
    markRuns(
      "vane",
      (i) => d[i] !== null && s[i] !== null && s[i]! >= VANE_MIN_SPEED_KMH,
      (a, b) => d[a] === d[b],
      VANE_MIN_MINUTES,
      VANE_MIN_VALUES,
    );
  }

  return result;
}

/** Kurzform für /api/timeline: ein Zeichen je Rasterpunkt, null wenn alles in Ordnung. */
export function encodeSuspectFlags(flags: (SuspectInfo | null)[]): string | null {
  if (!flags.some((f) => f !== null)) return null;
  return flags.map((f) => (f ? SUSPECT_CODES[f.reason] : ".")).join("");
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/**
 * Prüft die AKTUELLEN Werte einer Station (von /api/wind): Die 12 h aus
 * /api/timeline bekommen den Live-Wert angehängt (bzw. an seinem Rasterpunkt
 * eingesetzt), dann gelten dieselben Regeln wie für den Verlauf. Wird der
 * Live-Wert wieder "normal" (z. B. weil das Windrad abgetaut ist), ist die
 * Station sofort wieder ein Pfeil.
 *
 * Ausgefallene Stationen (stale) sind nie "verdächtig" — sie haben ja keinen
 * Wert und bleiben der blasse Ring.
 */
export function assessLive(
  station: WindStation,
  series: TimelineSeries | undefined,
  times: number[] | undefined,
): SuspectInfo | null {
  if (station.stale) return null;
  const speed = roundOrNull(station.speedKmh);
  const gust = roundOrNull(station.gustKmh);
  const direction = roundOrNull(station.direction);
  const measuredAt = station.timestamp ? Date.parse(station.timestamp) : NaN;

  if (isImplausible(speed, gust, direction)) {
    return { reason: "implausible", since: Number.isNaN(measuredAt) ? null : measuredAt };
  }
  if (!series || !times || times.length === 0 || Number.isNaN(measuredAt)) return null;

  const snapped = snapToGrid(measuredAt);
  const lastTime = times[times.length - 1];
  const s = [...series.s];
  const g = [...series.g];
  const d = [...series.d];
  const t = [...times];
  let idx: number;
  if (snapped > lastTime) {
    // Live-Wert ist neuer als der Verlauf: hinten anhängen.
    s.push(speed);
    g.push(gust);
    d.push(direction);
    t.push(snapped);
    idx = t.length - 1;
  } else {
    // Live-Wert liegt im Verlauf: an seinem Rasterpunkt einsetzen.
    idx = Math.round((snapped - times[0]) / GRID_MS);
    if (idx < 0 || idx >= times.length) return null;
    s[idx] = speed;
    g[idx] = gust;
    d[idx] = direction;
  }
  return assessSeries({ s, g, d }, t, station.source)[idx];
}

/** Uhrzeit "14:20" (Ortszeit des Browsers). */
function formatClock(t: number): string {
  return new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/** Hinweistext für den Verlaufsbalken (beginnt immer mit "Wahrscheinlich Messfehler"). */
export function describeSuspect(info: SuspectInfo): string {
  const since = info.since !== null ? ` seit ${formatClock(info.since)} Uhr` : "";
  switch (info.reason) {
    case "frozen":
      return `Wahrscheinlich Messfehler: Die Station liefert${since} immer exakt dieselben Werte (z. B. vereistes Windrad oder hängende Datenübertragung).`;
    case "vane":
      return `Wahrscheinlich Messfehler: Die Windrichtung hat sich${since} um kein Grad verändert, obwohl Wind weht — die Windfahne klemmt vermutlich (z. B. vereist).`;
    case "implausible":
      return "Wahrscheinlich Messfehler: Die aktuellen Werte sind physikalisch nicht möglich (z. B. Böe deutlich kleiner als der Mittelwind).";
  }
}
