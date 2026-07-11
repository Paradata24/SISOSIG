// Gemeinsame Typen für die Winddaten einer Station.
export interface WindStation {
  stationCode: string;
  stationName: string;
  lat: number | null;
  lng: number | null;
  altitude: number | null;
  /** Windrichtung in Grad (0-360), Richtung AUS der der Wind weht */
  direction: number | null;
  /** Windgeschwindigkeit (Durchschnitt) in km/h */
  speedKmh: number | null;
  /** Windböe in km/h */
  gustKmh: number | null;
  timestamp: string | null;
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
