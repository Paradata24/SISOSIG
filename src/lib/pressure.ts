import { WIND_COLOR_SCALE } from "./wind";

// Föhn-Anzeige: Druckdifferenz zwischen Bozen und Innsbruck (Nov. 2026,
// Wunsch des Projektbesitzers; Vorbild die "Live-Druckdifferenzen" der burnair
// Map). Gemeinsame Angaben für Sammler, /api/pressure, Karte und
// Druck-Verlaufsbalken. Die Abrufe selbst stehen in src/lib/stationPressure.ts
// und src/lib/metar.ts (nur Server).
//
// IMMER QNH (Wunsch des Projektbesitzers): der Luftdruck, nach der
// Normatmosphäre der ICAO auf Meereshöhe umgerechnet — so, wie ihn die
// Flughäfen melden. Beide Seiten rechnen nach DERSELBEN Regel; die
// Landeswetterdienste rechnen ihre eigenen Werte auf Meereshöhe jeder anders
// um (am 03.11.2026 lag GeoSphere Innsbruck-Flughafen 1,6 hPa über dem METAR)
// — deren umgerechnete Werte werden deshalb NICHT direkt verglichen.
//
// ZWEI MESSREIHEN (seit Nov. 2026):
//   1. Hauptkurve, Linie und Schild auf der Karte: QNH alle 10 min auf 0,1 hPa,
//      selbst gerechnet aus den Wetterstationen Innsbruck-Flughafen (GeoSphere)
//      und Bozen (Landeswetterdienst) — src/lib/stationPressure.ts.
//   2. Zum Vergleich (dünne graue punktierte Linie im Diagramm, Wunsch des
//      Projektbesitzers): die METAR der Flughäfen LOWI und LIPB. Nur ganze hPa
//      (abgerundet), Innsbruck alle 30 min, Bozen stündlich und NACHTS GAR
//      NICHT (etwa 22:50–6:30 Uhr). Die erste Fassung zeigte nur diese — die
//      Kurve war treppig und jede Nacht unterbrochen. Fehlen die
//      Stationswerte, zeigt die Karte die METAR.
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

/** Name der Zeile in wind_status, in die der Sammler den Zustand der Druck-Abfrage schreibt. */
export const PRESSURE_STATUS_NAME = "druck";

/**
 * Ab diesem Alter gilt die Differenz als ausgefallen (Linie grau, ohne Zahl).
 * Die 10-Minuten-Werte der Stationen sind normal 10–20 min alt; fehlen sie,
 * springt die Anzeige auf die METAR (Bozen stündlich, ~15 min unterwegs,
 * normal bis ~80 min). 2 h überbrücken einen verpassten Bozner METAR.
 */
export const PRESSURE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Zwei Messungen gehören zusammen, wenn sie höchstens so weit auseinander
 * liegen. Die Stationen messen beide zu jeder vollen 10 Minuten; die
 * Flughäfen melden beide zu :50, Sondermeldungen (SPECI) dazwischen werden so
 * mit der nächstgelegenen Meldung der anderen Seite gepaart.
 */
const PAIR_TOLERANCE_MS = 20 * 60 * 1000;

/** Antwort von /api/pressure. Zeiten in ms (UTC), Druck in hPa (QNH). */
export interface PressurePayload {
  /**
   * Hauptkurve: QNH alle 10 min, selbst gerechnet aus den Wetterstationen an
   * den Flughäfen (src/lib/stationPressure.ts), letzte HISTORY_HOURS,
   * aufsteigend.
   */
  stations: Record<PressureStationId, Array<[number, number]>>;
  /**
   * Lufttemperatur (°C) derselben Wetterstationen, alle 10 min — für die
   * Temperatur-Differenz Innsbruck − Bozen (seit Nov. 2026).
   */
  temperature: Record<PressureStationId, Array<[number, number]>>;
  /** Zum Vergleich: QNH aus den METAR der Flughäfen (ganze hPa), aufsteigend. */
  metar: Record<PressureStationId, Array<[number, number]>>;
  /** ICON-CH1-Prognose je Flughafen (stündlich), aufsteigend. */
  forecast: Record<PressureStationId, Array<[number, number]>>;
  /** ECMWF-Prognose (IFS, 9 km) je Flughafen (stündlich), aufsteigend. */
  ecmwf: Record<PressureStationId, Array<[number, number]>>;
  /** Startzeit des ECMWF-Laufs (ISO), sonst null. */
  ecmwfRun: string | null;
  /** Startzeit des Modelllaufs (ISO), sonst null. */
  modelRun: string | null;
  /** true = Messwerte im Notbetrieb direkt bei den Diensten geholt (nicht aus der Datenbank). */
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
 * Farbe je Betrag der Differenz (Nov. 2026, vom Projektbesitzer festgelegt;
 * zuerst die Stufen von burnair): dieselben fünf Farben wie die Windskala
 * (WIND_COLOR_SCALE in src/lib/wind.ts), in harten Stufen, für positive und
 * negative Werte gleich:
 *   bis 0,5 hPa blau · bis 1,5 grün · bis 2,5 gelb · bis 3 orange · darüber rot
 * (dritte Fassung des Projektbesitzers, Nov. 2026). Die gemessenen Werte
 * sind ganzzahlig (METAR): 0 blau, 1 grün, 2 gelb, 3 orange, ab 4 rot.
 * `upTo` = höchster Betrag der Stufe, `inclusive` = ob er noch dazugehört.
 */
export const FOEHN_COLOR_SCALE: Array<{ upTo: number; inclusive: boolean; color: string; text: string }> = [
  { upTo: 0.5, inclusive: true, color: WIND_COLOR_SCALE[0].color, text: "#18181b" }, // blau
  { upTo: 1.5, inclusive: true, color: WIND_COLOR_SCALE[1].color, text: "#18181b" }, // grün
  { upTo: 2.5, inclusive: true, color: WIND_COLOR_SCALE[2].color, text: "#18181b" }, // gelb
  { upTo: 3, inclusive: true, color: WIND_COLOR_SCALE[3].color, text: "#18181b" }, // orange
  { upTo: Infinity, inclusive: false, color: WIND_COLOR_SCALE[4].color, text: "#18181b" }, // rot
];

/** Farbstufe zum Betrag einer Differenz. */
export function foehnColor(diff: number): { color: string; text: string } {
  // Auf Zehntel runden wie die angezeigte Zahl, damit Zahl und Farbe passen.
  const magnitude = Math.round(Math.abs(diff) * 10) / 10;
  return (
    FOEHN_COLOR_SCALE.find((step) =>
      step.inclusive ? magnitude <= step.upTo : magnitude < step.upTo,
    ) ?? FOEHN_COLOR_SCALE[FOEHN_COLOR_SCALE.length - 1]
  );
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

/**
 * Quellen der Föhn-Anzeige — stehen unter "Quellen" im Ebenen-Menü bei den
 * übrigen Quellen (Wunsch des Projektbesitzers, Nov. 2026; zuerst unten im
 * Druck-Verlaufsbalken). GeoSphere verlangt die Nennung (CC BY 4.0), ebenso
 * Open-Meteo; METAR sind gemeinfrei (US-Behörde NOAA).
 */
export const PRESSURE_SOURCES: Array<{ label: string; url: string; note?: string }> = [
  {
    label: "Luftdruck Innsbruck-Flughafen © GeoSphere Austria",
    url: "https://data.hub.geosphere.at",
    note: "CC BY 4.0",
  },
  {
    label: "Luftdruck Bozen © Land Südtirol – Wetterdienst",
    url: "https://wetter.provinz.bz.it",
  },
  {
    label: "Flughäfen IBK/BZ (METAR) © NOAA Aviation Weather Center",
    url: "https://aviationweather.gov/data/api/",
  },
  {
    label: "Druckprognose ICON-CH1 © MeteoSchweiz über Open-Meteo",
    url: "https://open-meteo.com/en/docs/meteoswiss-api",
    note: "CC BY 4.0",
  },
  {
    label: "Druckprognose ECMWF IFS © ECMWF über Open-Meteo",
    url: "https://open-meteo.com/en/docs/ecmwf-api",
    note: "CC BY 4.0",
  },
];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
