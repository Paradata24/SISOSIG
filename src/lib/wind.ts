// Gemeinsame Typen für die Winddaten einer Station.
export interface WindStation {
  stationCode: string;
  stationName: string;
  lat: number | null;
  lng: number | null;
  altitude: number | null;
  /** Windrichtung in Grad (0-360), Richtung AUS der der Wind weht */
  direction: number | null;
  /** Windgeschwindigkeit (Mittelwind) in km/h */
  speedKmh: number | null;
  /** Windböe in km/h */
  gustKmh: number | null;
  /** Zeitpunkt der Messung (ISO 8601) */
  timestamp: string | null;
  /** true, wenn die Station Windsensoren hat, aber keine aktuellen Werte liefert */
  stale: boolean;
  /** Datenquelle: Bozner Wetterdienst oder OpenWindMap/Pioupiou-Netzwerk */
  source: "bolzano" | "openwindmap";
}

/** Anzeigename + Link zur Datenquelle, z. B. für den "Quelle:"-Hinweis im Verlaufsbalken. */
export const SOURCE_INFO: Record<
  WindStation["source"],
  { label: string; url: string }
> = {
  bolzano: { label: "Land Südtirol – Wetterdienst", url: "https://wetter.provinz.bz.it" },
  openwindmap: { label: "OpenWindMap / Pioupiou", url: "https://openwindmap.org" },
};

/**
 * "Windanzeiger" – kuratierte Liste der vom Projektbesitzer bewusst
 * ausgewählten Stationen. Der gleichnamige Filter auf der Karte zeigt nur
 * diese Stationen an. Jeder Eintrag wird (klein geschrieben und ohne
 * Leerzeichen/Binde-/Schrägstriche) als Teilstring gegen den Stationsnamen
 * geprüft, damit kleine Schreibweise-Unterschiede der Datenquelle
 * (z. B. "Ritten Rittner Horn" vs. "Rittnerhorn") kein Problem sind.
 * Zum Hinzufügen einer Station hier einfach einen weiteren Namensbestandteil
 * ergänzen.
 */
export const WINDANZEIGER_STATION_NAMES: string[] = ["rittner horn"];

/** Klein schreiben und Leerzeichen/Binde-/Schrägstriche entfernen (für den Namensvergleich). */
function normalizeStationName(name: string): string {
  return name.toLowerCase().replace(/[\s/-]+/g, "");
}

/** true, wenn die Station Teil des kuratierten "Windanzeiger"-Filters ist. */
export function isWindanzeigerStation(station: WindStation): boolean {
  const name = normalizeStationName(station.stationName);
  return WINDANZEIGER_STATION_NAMES.some((needle) =>
    name.includes(normalizeStationName(needle)),
  );
}

export interface WindColorStop {
  /** Obere Grenze dieser Stufe in km/h (exklusiv), Infinity für die letzte Stufe. */
  max: number;
  /** Hex-Farbcode dieser Stufe. */
  color: string;
  /** Untere Grenze dieser Stufe als Beschriftung, z. B. "18" für die Stufe 18–23. */
  label: string;
}

/**
 * Farbskala angelehnt an die XC-Therm-Skala (Windwerte für Gleitschirmflieger).
 * Grenzwerte und Farben sind mit dem Projektbesitzer per Screenshot-Vorlage
 * abgestimmt; bei Änderungswunsch bitte hier zentral anpassen.
 */
export const WIND_COLOR_SCALE: WindColorStop[] = [
  { max: 4, color: "#F4F4EC", label: "0" }, // sehr helles Weiß/Off-White
  { max: 7, color: "#B8DCEA", label: "4" }, // helles Blau
  { max: 11, color: "#8DC873", label: "7" }, // helles Grün
  { max: 14, color: "#C6D94A", label: "11" }, // Gelbgrün
  { max: 18, color: "#F6D746", label: "14" }, // Gelb
  { max: 23, color: "#F2A63C", label: "18" }, // Orange
  { max: 27, color: "#DB5A34", label: "23" }, // Rot-Orange
  { max: 36, color: "#9C3350", label: "27" }, // dunkles Rot/Bordeaux
  { max: 45, color: "#7B3796", label: "36" }, // Violett/Lila
  { max: Infinity, color: "#2C2A6E", label: "45" }, // dunkles Blau/Indigo
];

/** Liefert für einen Windwert (km/h) die passende Farbe der XC-Therm-Skala. */
export function getWindColor(speedKmh: number | null): string {
  const speed = speedKmh ?? 0;
  const stop = WIND_COLOR_SCALE.find((s) => speed < s.max);
  return (stop ?? WIND_COLOR_SCALE[WIND_COLOR_SCALE.length - 1]).color;
}

const COMPASS_POINTS = [
  "N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Wandelt Grad (0-360) in eine 16-teilige Himmelsrichtung um, z. B. 315 → NW. */
export function toCompassPoint(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16];
}

/**
 * Rastet eine Windrichtung (Grad) auf die 8 Haupt-Himmelsrichtungen ein
 * (0/45/90/135/180/225/270/315°). Wird für die Pfeil-Drehung auf der Karte
 * genutzt, damit die Anzeige nicht "krumme" Zwischenwinkel zeigt.
 */
export function snapDirectionTo8(degrees: number): number {
  return (Math.round(degrees / 45) * 45) % 360;
}
