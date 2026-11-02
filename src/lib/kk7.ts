// Auswahl der KK7-Thermikkarte nach Jahreszeit und Tageszeit (Nov. 2026,
// Wunsch des Projektbesitzers): Im Ebenen-Menü der Hauptseite (LayerMenu)
// lässt sich die Karte von Hand wählen; "Automatisch" ist die bisherige Regel
// (Jahreszeit aus dem Datum, Tageszeit aus den Stunden seit Sonnenaufgang,
// siehe src/components/flight/kk7.ts). Im Flugmodus bleibt es immer
// automatisch.
//
// Eigene Datei ohne Leaflet, weil das Menü im Titel-Balken auch auf dem
// Server vorbereitet wird und Leaflet dort nicht geladen werden kann.
//
// Die Werte sind die Namensteile der Kachel-Adressen von KK7
// ("thermals_jul_07"); "all" = über alle Jahres- bzw. Tageszeiten. Alle
// Kombinationen gibt es bei KK7 (Nov. 2026 nachgeprüft).

export type Kk7Season = "auto" | "all" | "jan" | "apr" | "jul" | "oct";
export type Kk7TimeOfDay = "auto" | "all" | "04" | "07" | "10";

export const KK7_SEASON_OPTIONS: { value: Kk7Season; label: string }[] = [
  { value: "auto", label: "Automatisch" },
  { value: "all", label: "Ganzjährig" },
  // jan/apr/jul/oct stehen bei KK7 für je drei Monate drumherum.
  { value: "jan", label: "Winter" },
  { value: "apr", label: "Frühling" },
  { value: "jul", label: "Sommer" },
  { value: "oct", label: "Herbst" },
];

export const KK7_TIME_OPTIONS: { value: Kk7TimeOfDay; label: string }[] = [
  { value: "auto", label: "Automatisch" },
  { value: "all", label: "Ganztags" },
  // Gemessen ab Sonnenaufgang: Morgen 0–6 h, Mittag 6–10 h, Abend danach.
  { value: "04", label: "Morgen" },
  { value: "07", label: "Mittag" },
  { value: "10", label: "Abend" },
];

export function isKk7Season(value: unknown): value is Kk7Season {
  return KK7_SEASON_OPTIONS.some((o) => o.value === value);
}

export function isKk7TimeOfDay(value: unknown): value is Kk7TimeOfDay {
  return KK7_TIME_OPTIONS.some((o) => o.value === value);
}
