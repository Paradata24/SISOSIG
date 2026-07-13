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
}

export type WindCategory = "schwach" | "mittel" | "stark";

/** Farb- und Kategorie-Grenzwerte für Gleitschirmflieger. */
export function getWindCategory(speedKmh: number | null): WindCategory {
  if (speedKmh === null || speedKmh < 10) return "schwach";
  if (speedKmh < 25) return "mittel";
  return "stark";
}

export function getWindColor(speedKmh: number | null): string {
  switch (getWindCategory(speedKmh)) {
    case "schwach":
      return "#22c55e"; // grün
    case "mittel":
      return "#eab308"; // gelb
    case "stark":
      return "#ef4444"; // rot
  }
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
