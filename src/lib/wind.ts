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
 * Zeitfenster des Verlaufsbalkens: Die Zeitachse läuft fest von
 * (jetzt − HISTORY_HOURS) bis (jetzt + FUTURE_MARGIN_HOURS). Beide Werte
 * stehen bewusst hier zentral, damit das Panel (WindHistoryPanel) und die
 * beiden APIs (/api/history, /api/forecast) nicht auseinanderlaufen können.
 *
 * Achtung: Die Supabase-Edge-Function
 * (supabase/functions/fetch-wind-forecasts) ist Deno-Code und kann hier NICHT
 * importieren – dort stehen eigene, abgeleitete Konstanten (PAST_HOURS /
 * FORECAST_HOURS), die bei einer Änderung mitgezogen werden müssen.
 */
export const HISTORY_HOURS = 12;
export const FUTURE_MARGIN_HOURS = 4;

/**
 * "Windanzeiger" – kuratierte Liste der vom Projektbesitzer bewusst
 * ausgewählten Stationen. Der gleichnamige Filter auf der Karte zeigt nur
 * diese Stationen an. Jeder Eintrag wird (klein geschrieben, ohne
 * Leerzeichen/Binde-/Schrägstriche und ohne Akzente/Umlaut-Punkte) als
 * Teilstring gegen den Stationsnamen geprüft, damit kleine Schreibweise-
 * Unterschiede der Datenquelle (z. B. "Ritten Rittner Horn" vs. "Rittnerhorn",
 * oder "Pisciadù" mit Akzent) kein Problem sind.
 * Zum Hinzufügen einer Station hier einfach einen weiteren Namensbestandteil
 * ergänzen.
 */
export const WINDANZEIGER_STATION_NAMES: string[] = [
  "rittner horn", // Ritten Rittner Horn
  "schöntaufspitze", // Sulden Schöntaufspitze
  "wilder freiger", // Signalgipfel Wilder Freiger
  "lengspitze", // Prettau Lengspitze
  "pisciadu", // Abtei Piz Pisciadù (Akzent wird beim Vergleich ignoriert)
  "plose", // Plose
  "raujoch", // Pfelders Raujoch (Schreibweise ohne "h")
  "rauhjoch", // Pfelders Rauhjoch (Schreibweise mit "h" – je nach Datenquelle)
  "elferspitze", // Graun Elferspitze
  "regelspitze", // Gsies Regelspitze
];

/**
 * Klein schreiben und für den Namensvergleich vereinheitlichen: Akzente und
 * Umlaut-Punkte entfernen (NFD-Zerlegung + diakritische Zeichen streichen,
 * z. B. "à"→"a", "ö"→"o") sowie Leerzeichen/Binde-/Schrägstriche entfernen.
 */
function normalizeStationName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "") // diakritische Zeichen (Akzente, Umlaut-Punkte) entfernen
    .replace(/[\s/-]+/g, "");
}

/** true, wenn die Station Teil des kuratierten "Windanzeiger"-Filters ist. */
export function isWindanzeigerStation(station: WindStation): boolean {
  const name = normalizeStationName(station.stationName);
  return WINDANZEIGER_STATION_NAMES.some((needle) =>
    name.includes(normalizeStationName(needle)),
  );
}

// Gemeinsame Typen/Konstanten für das Menü im Titel-Balken (WindApp.tsx) und
// die Karte (WindMap.tsx). Sie liegen hier zentral, damit Menü-Beschriftung
// und Filterlogik nie auseinanderlaufen können.

/** Welcher Kartenhintergrund angezeigt wird (Menüpunkt "Karte"). */
export type BaseLayer = "standard" | "relief";

// "all"/"high"/"veryHigh": Höhenfilter (alle Stationen bzw. nur oberhalb einer
// Höhenschwelle). "windanzeiger": der benannte, kuratierte Filter, der nur die
// vom Projektbesitzer ausgewählten Stationen zeigt (siehe isWindanzeigerStation
// unten). Alle Filter schließen sich gegenseitig aus.
export type StationFilter = "all" | "high" | "veryHigh" | "windanzeiger";

export const HIGH_ALTITUDE_THRESHOLD_M = 2000;
export const VERY_HIGH_ALTITUDE_THRESHOLD_M = 3000;

export interface WindColorStop {
  /**
   * Windgeschwindigkeit (km/h) dieses Stützpunkts der Farbskala. Zwischen
   * zwei Stützpunkten wird die Farbe linear gemischt (siehe getWindColor)
   * — es gibt also keine harten Stufen mehr, sondern einen durchgehenden
   * Verlauf mit einer eigenen Farbe pro km/h.
   */
  at: number;
  /** Hex-Farbcode an diesem Stützpunkt. */
  color: string;
  /** Beschriftung an diesem Stützpunkt für die km/h-Achse im Verlaufsbalken. */
  label: string;
  /** Wortbezeichnung zur Einordnung laut ursprünglicher Legende, z. B. "mässig". */
  name: string;
  /**
   * Abweichende Deckkraft für das Farbband im Verlaufsbalken an diesem
   * Stützpunkt (Standard 0.55). Nur am obersten Stützpunkt (Schwarz) auf
   * einen kleineren Wert gesetzt, sonst verschwindet die schwarze
   * Messkurve im fast schwarzen Bandbereich.
   */
  bandOpacity?: number;
}

/**
 * Farbskala der Windstärke (Windwerte für Gleitschirmflieger) als
 * durchgehender Verlauf: pro km/h eine eigene, zwischen den Stützpunkten
 * linear gemischte Farbe (siehe getWindColor). Die Stützpunkte selbst sind
 * weiterhin exakt die mit dem Projektbesitzer abgestimmten Werte/Farben
 * (hellblau → grün → gelb → orange → dunkelrot → schwarz); bei
 * Änderungswunsch bitte hier zentral anpassen. Die unterste Stufe ist
 * bewusst ein ganz helles Blau statt des Weiß der Vorlage, damit schwache
 * Pfeile auf hellem Kartenhintergrund ohne zusätzliche Kontur sichtbar sind,
 * und bleibt bis 5 km/h absichtlich flach (zwei Stützpunkte mit derselben
 * Farbe), damit der ruhige Bereich nicht schon vorzeitig einfärbt. Dieser
 * flache Anfang endete früher erst bei 7 km/h und wurde auf Wunsch des
 * Projektbesitzers auf 5 km/h verkürzt.
 * Stützpunkte: 0 / 5 (beide hellblau) / 15 (grün) / 20 (zusätzlicher
 * Zwischenpunkt in kräftigem Gelbgrün, auf Wunsch des Projektbesitzers,
 * damit es schon ab 20 km/h deutlich mehr ins Gelb geht) / 25 (gelb) /
 * 30 (orange) / 35 (dunkelrot) / 45 (schwarz, entspricht Y_MAX_KMH in
 * WindHistoryPanel.tsx). Die beiden obersten Farben wurden auf Wunsch des
 * Projektbesitzers nachträglich von 31/37 auf 30/35 herabgesetzt.
 */
export const WIND_COLOR_SCALE: WindColorStop[] = [
  { at: 0, color: "#CFE8F7", label: "0", name: "schwach" }, // ganz helles Blau
  { at: 5, color: "#CFE8F7", label: "5", name: "schwach" }, // Blau endet, Verlauf beginnt
  { at: 15, color: "#6EE45C", label: "15", name: "spürbar" }, // Hellgrün
  { at: 20, color: "#DEEF62", label: "20", name: "mässig" }, // Gelbgrün-Zwischenpunkt
  { at: 25, color: "#FAF264", label: "25", name: "mässig" }, // Gelb
  { at: 30, color: "#F0913C", label: "30", name: "stark" }, // Orange
  { at: 35, color: "#C0281B", label: "35", name: "sehr stark" }, // Dunkelrot
  { at: 45, color: "#000000", label: "45", name: "zu stark", bandOpacity: 0.3 }, // Schwarz
];

/** Mischt zwei Hex-Farben linear (t=0 → colorA, t=1 → colorB). */
function mixHexColors(colorA: string, colorB: string, t: number): string {
  const toRgb = (hexColor: string) => {
    const clean = hexColor.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
  };
  const [ar, ag, ab] = toRgb(colorA);
  const [br, bg, bb] = toRgb(colorB);
  const mix = (a: number, b: number) =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`.toUpperCase();
}

/**
 * Liefert für einen Windwert (km/h) die passende Farbe der Windskala: liegt
 * er zwischen zwei Stützpunkten, wird linear gemischt; davor/danach gilt die
 * Farbe des jeweils äußersten Stützpunkts.
 */
export function getWindColor(speedKmh: number | null): string {
  const speed = speedKmh ?? 0;
  const stops = WIND_COLOR_SCALE;
  if (speed <= stops[0].at) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    if (speed <= stops[i].at) {
      const prev = stops[i - 1];
      const next = stops[i];
      const t = (speed - prev.at) / (next.at - prev.at);
      return mixHexColors(prev.color, next.color, t);
    }
  }
  return stops[stops.length - 1].color;
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
