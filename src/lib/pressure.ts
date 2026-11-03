// Föhn-Anzeige: Druckdifferenz zwischen den Flughäfen Bozen und Innsbruck
// (Nov. 2026, Wunsch des Projektbesitzers; Vorbild die "Live-Druckdifferenzen"
// der burnair Map). Gemeinsame Angaben für Sammler, /api/pressure, Karte und
// Druck-Verlaufsbalken — die Abfrage der Flugwetter-Meldungen selbst steht in
// src/lib/metar.ts (nur Server).
//
// WARUM DIE FLUGHÄFEN (Wunsch des Projektbesitzers): Beide melden in ihrer
// Flugwetter-Meldung (METAR) den QNH — den Luftdruck, nach der
// Normatmosphäre auf Meereshöhe umgerechnet. Beide Seiten rechnen also nach
// DERSELBEN Regel. Die Landeswetterdienste rechnen jeder auf eigene Art um
// (am 03.11.2026 lag GeoSphere Innsbruck-Flughafen 1,6 hPa über dem METAR),
// eine Differenz aus zwei verschiedenen Diensten hätte deshalb einen festen
// Versatz. Nachteil: Der METAR nennt nur ganze hPa (abgerundet), die
// Differenz ist also auf ±1 hPa genau. Für die Föhn-Faustregeln (ab etwa
// 4 hPa) reicht das.
//
// Messtakt: Innsbruck alle 30 min (:20 und :50), Bozen jede Stunde (:50).
//
// VORZEICHEN: Differenz = Bozen − Innsbruck (wie im Föhndiagramm üblich).
//   positiv = Druck im Süden höher → Luft strömt nach Norden → Südföhn
//             (Wipptal, Innsbruck)
//   negativ = Druck im Norden höher → Nordföhn (Südtirol)
// Auf der Karte zeigt ein Pfeil in die Richtung, in die sich der Druck
// ausgleicht (vom hohen zum tiefen Druck).

/** Ein Flughafen mit Druckmessung. */
export interface PressureStation {
  /** ICAO-Kennung, zugleich Schlüssel in der Tabelle pressure_values. */
  icao: string;
  name: string;
  /** Kurzname für Karte und Verlaufsbalken. */
  short: string;
  lat: number;
  lng: number;
  /**
   * Höhe des Flughafens (m). Daraus rechnet die Edge Function den QNH der
   * Prognose (aus dem Druck am Boden) — Kopie dort in PRESSURE_STATIONS.
   */
  elevationM: number;
}

export const PRESSURE_STATIONS = {
  LOWI: { icao: "LOWI", name: "Innsbruck Flughafen", short: "IBK", lat: 47.2602, lng: 11.3439, elevationM: 581 },
  LIPB: { icao: "LIPB", name: "Bozen Flughafen", short: "BZ", lat: 46.4603, lng: 11.3264, elevationM: 240 },
} as const satisfies Record<string, PressureStation>;

export type PressureStationId = keyof typeof PRESSURE_STATIONS;
export const PRESSURE_STATION_IDS = Object.keys(PRESSURE_STATIONS) as PressureStationId[];

/** Das Stationspaar der Föhn-Anzeige (später ggf. weitere, z. B. Lugano–Zürich). */
export const FOEHN_PAIR = { north: "LOWI", south: "LIPB" } as const satisfies {
  north: PressureStationId;
  south: PressureStationId;
};

/** Name der Zeile in wind_status, in die der Sammler den Zustand der METAR-Abfrage schreibt. */
export const PRESSURE_STATUS_NAME = "druck";

/**
 * Ab diesem Alter gilt die Differenz als ausgefallen (Linie grau, ohne Zahl).
 * Bozen meldet nur stündlich, der METAR ist dann ~15 min unterwegs und der
 * Sammler läuft alle 5 min — normal ist also bis ~80 min. 2 h = ein
 * verpasster Bozner METAR wird noch überbrückt.
 */
export const PRESSURE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Zwei Messungen gehören zusammen, wenn sie höchstens so weit auseinander
 * liegen. Beide Flughäfen melden zu :50; Sondermeldungen (SPECI) liegen
 * dazwischen und werden so mit der nächstgelegenen Meldung der anderen Seite
 * gepaart.
 */
const PAIR_TOLERANCE_MS = 20 * 60 * 1000;

/** Antwort von /api/pressure. Zeiten in ms (UTC), Druck in hPa (QNH). */
export interface PressurePayload {
  /** Gemessene Werte (METAR) der letzten HISTORY_HOURS je Flughafen, aufsteigend. */
  measured: Record<PressureStationId, Array<[number, number]>>;
  /** ICON-CH1-Prognose je Flughafen (stündlich), aufsteigend. */
  forecast: Record<PressureStationId, Array<[number, number]>>;
  /** Startzeit des Modelllaufs (ISO), sonst null. */
  modelRun: string | null;
  /** true = Messwerte im Notbetrieb direkt beim Flugwetterdienst geholt. */
  fallback: boolean;
}

/** Ein Punkt der Differenz-Reihe (Bozen − Innsbruck). */
export interface PressureDiffPoint {
  time: number;
  diff: number;
  north: number;
  south: number;
}

/**
 * Differenz-Reihe Süd − Nord aus zwei Reihen: zu jedem Wert der Südseite
 * der zeitlich nächste der Nordseite (höchstens PAIR_TOLERANCE_MS entfernt).
 * Bei der Prognose liegen beide auf denselben vollen Stunden.
 */
export function pairPressureSeries(
  north: Array<[number, number]>,
  south: Array<[number, number]>,
): PressureDiffPoint[] {
  const result: PressureDiffPoint[] = [];
  let j = 0;
  for (const [time, southValue] of south) {
    // Beide Reihen sind aufsteigend sortiert: j läuft nur vorwärts.
    while (j + 1 < north.length && Math.abs(north[j + 1][0] - time) <= Math.abs(north[j][0] - time)) {
      j++;
    }
    const match = north[j];
    if (!match || Math.abs(match[0] - time) > PAIR_TOLERANCE_MS) continue;
    result.push({ time, diff: round1(southValue - match[1]), north: match[1], south: southValue });
  }
  return result;
}

/**
 * Der zum Zeitpunkt `time` gültige Punkt: der jüngste, der nicht später
 * liegt und höchstens PRESSURE_STALE_AFTER_MS alt ist; sonst null.
 */
export function pressureDiffAt(series: PressureDiffPoint[], time: number): PressureDiffPoint | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const point = series[i];
    if (point.time > time) continue;
    return time - point.time <= PRESSURE_STALE_AFTER_MS ? point : null;
  }
  return null;
}

/**
 * Farbe je Betrag der Differenz, in harten Stufen wie bei burnair (und wie die
 * Windfarben): bis 1 hPa weiß, bis 2 gelb, bis 4 orange, bis 8 rot, darüber
 * schwarz. Faustregel: ab etwa 4 hPa ist mit Föhn zu rechnen.
 */
export const FOEHN_COLOR_SCALE: Array<{ below: number; color: string; text: string; label: string }> = [
  { below: 1, color: "#ffffff", text: "#18181b", label: "unter 1 hPa" },
  { below: 2, color: "#facc15", text: "#18181b", label: "1–2 hPa" },
  { below: 4, color: "#fb923c", text: "#18181b", label: "2–4 hPa" },
  { below: 8, color: "#dc2626", text: "#ffffff", label: "4–8 hPa" },
  { below: Infinity, color: "#18181b", text: "#ffffff", label: "ab 8 hPa" },
];

/** Farbstufe zum Betrag einer Differenz. */
export function foehnColor(diff: number): { color: string; text: string } {
  const magnitude = Math.abs(diff);
  return FOEHN_COLOR_SCALE.find((step) => magnitude < step.below) ?? FOEHN_COLOR_SCALE[0];
}

/** Grau für ausgefallene Werte (wie ausgefallene Windstationen). */
export const FOEHN_STALE_COLOR = "#a1a1aa";

/**
 * Kurzer Text zur Lage: Unter 1 hPa kein Gefälle, sonst die Seite mit dem
 * höheren Druck und wohin die Luft drängt.
 */
export function describeFoehn(diff: number): string {
  if (Math.abs(diff) < 1) return "kein nennenswertes Gefälle";
  return diff > 0 ? "Süd höher → Südföhn-Lage" : "Nord höher → Nordföhn-Lage";
}

/** Differenz als Text, z. B. "+4 hPa" / "−3 hPa" (METAR-Werte sind ganzzahlig). */
export function formatPressureDiff(diff: number): string {
  const rounded = Math.round(diff * 10) / 10;
  const text = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1).replace(".", ",");
  if (rounded === 0) return "0 hPa";
  return `${rounded > 0 ? "+" : "−"}${text} hPa`;
}

/** Quelle der Messwerte (Lizenz: gemeinfrei, US-Behörde) — Nennung im Druck-Verlaufsbalken. */
export const METAR_SOURCE = {
  label: "METAR LOWI/LIPB über NOAA Aviation Weather Center",
  url: "https://aviationweather.gov/data/api/",
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
