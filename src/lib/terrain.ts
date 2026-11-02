// Gelände-Ebenen der Hauptseite (Nov. 2026, Wunsch des Projektbesitzers):
// Hangausrichtung und Lee-Hänge zur Windrose. Vorbild ist die Hangausrichtung
// der Karte im Wolkenatlas (Repo Wolkenatlas, index.html, "Gelände:
// Hangneigung und Hangausrichtung") — dieselben acht Richtungen und Farben.
//
// Eigene Datei ohne Leaflet (wie src/lib/kk7.ts): Das Ebenen-Menü im
// Titel-Balken wird auch auf dem Server vorbereitet, dort gibt es kein
// Leaflet. Gerechnet und gezeichnet wird in src/components/terrain.ts.

/** Die acht Himmelsrichtungen, im Uhrzeigersinn ab Norden (je 45°). */
export const COMPASS_DIRECTIONS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"] as const;
export type CompassDirection = (typeof COMPASS_DIRECTIONS)[number];

/** Ausgeschriebener Name für Beschriftungen ("Wind aus Ost"). */
export const COMPASS_NAMES: Record<CompassDirection, string> = {
  N: "Nord",
  NO: "Nordost",
  O: "Ost",
  SO: "Südost",
  S: "Süd",
  SW: "Südwest",
  W: "West",
  NW: "Nordwest",
};

export function isCompassDirection(value: unknown): value is CompassDirection {
  return COMPASS_DIRECTIONS.some((d) => d === value);
}

/** Mitte der Richtung in Grad (N = 0, O = 90 …). */
export function compassDegrees(direction: CompassDirection): number {
  return COMPASS_DIRECTIONS.indexOf(direction) * 45;
}

/**
 * Farben der Hangausrichtung (Richtung, in die der Hang abfällt), genau wie
 * im Wolkenatlas und bei gängigen Touren-Apps: Norden blau, Osten weiß,
 * Süden orange, Westen schwarz — dazwischen die Übergänge.
 */
export const ASPECT_COLORS: Record<CompassDirection, [number, number, number]> = {
  N: [30, 120, 255],
  NO: [160, 198, 245],
  O: [255, 255, 255],
  SO: [248, 176, 130],
  S: [255, 110, 20],
  SW: [110, 45, 15],
  W: [15, 15, 15],
  NW: [15, 40, 90],
};

/**
 * Lee-Hänge zur Windrose: Kommt der Wind aus Osten, liegen die Hänge im Lee,
 * die nach Westen abfallen (vom Wind abgewandt). Gefärbt werden alle Hänge,
 * deren Ausrichtung höchstens so viele Grad von der Lee-Richtung abweicht —
 * 45° = die Lee-Richtung selbst plus je die halbe Nachbarrichtung (bei Ostwind
 * also W, dazu die westlichen Hälften von NW und SW). Größer = mehr rote
 * Fläche, kleiner = nur die genau abgewandten Hänge.
 */
export const LEE_HALF_ANGLE_DEG = 45;

/** Rot der Lee-Hänge; halb durchsichtig über LEE_OPACITY in terrain.ts. */
export const LEE_COLOR: [number, number, number] = [225, 25, 25];

/**
 * Ab dieser Zoomstufe erscheinen beide Gelände-Ebenen — das ist die
 * Startansicht Südtirol (SOUTH_TYROL_ZOOM). Weiter draußen wären die Hänge in
 * den Höhendaten zu stark geglättet und es müssten sehr viele Kacheln
 * gerechnet werden.
 */
export const TERRAIN_MIN_ZOOM = 9;

/**
 * Quelle der Höhendaten (Lizenzpflicht, steht unter "Quellen" im
 * Ebenen-Menü): "Terrain Tiles" auf Amazon (AWS Open Data), frei ohne
 * Schlüssel; in Südtirol aus dem EU-DEM von Copernicus (~30 m), in
 * Österreich ~10 m. Dieselbe Quelle wie im Wolkenatlas.
 */
export const TERRAIN_SOURCE = {
  label: "Gelände: Terrain Tiles (AWS Open Data), EU-DEM © Copernicus",
  url: "https://registry.opendata.aws/terrain-tiles/",
};
