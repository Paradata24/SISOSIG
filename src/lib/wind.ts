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
 * Ein Prognosemodell, wie es im Verlaufsbalken gezeichnet und in der Legende
 * aufgeführt wird.
 */
export interface ForecastModelInfo {
  /** Wert der Spalte "model" in der Supabase-Tabelle wind_forecasts. */
  key: string;
  /** Kurzname für Legende und Tooltips. */
  label: string;
  /** Wetterdienst hinter dem Modell — für den Lizenz-/Quellenhinweis. */
  provider: string;
  /**
   * Modellname für den Quellenhinweis im Footer, falls dort ein anderer Name
   * passt als in der Legende: dort steht "ECMWF" (der Dienst ist bekannter als
   * das Modell), im Hinweis aber "ECMWF (IFS)". Ohne Angabe wird "label"
   * verwendet.
   */
  licenseLabel?: string;
  /**
   * Linienfarbe als CSS-Variable (definiert in src/app/globals.css, je ein
   * Wert für hellen und dunklen Hintergrund). Bewusst keine Tailwind-Klasse:
   * die Kurven werden per Schleife über diese Liste gezeichnet, eine feste
   * Klasse pro Modell ginge dabei nicht.
   */
  color: string;
}

/**
 * Alle Bodenwind-Prognosemodelle in Zeichenreihenfolge. Die Reihenfolge
 * bestimmt zugleich die Reihenfolge der Legende und der Spalten im
 * Vergleichsblock unter dem Diagramm.
 *
 * Diese Liste ist die EINZIGE Stelle im Frontend, an der ein Modell steht:
 * /api/forecast liest sie für die Datenbankabfrage, WindHistoryPanel für
 * Kurven, Legende und Vergleichsblock. Ein weiteres Modell braucht also nur
 * einen zusätzlichen Eintrag hier — plus den passenden Eintrag in
 * SURFACE_MODELS der Edge Function (supabase/functions/fetch-wind-forecasts),
 * die die Werte einsammelt (Deno-Code, kann hier nicht importieren).
 *
 * Farben: Rot/Blau sind historisch gewachsen. Gelb und Grün sind bewusst
 * dunkler/satter als die naheliegenden Reintöne — die Farbbänder der
 * Windskala im Diagramm sind selbst gelb (15–24 km/h) bzw. grün (7–14 km/h),
 * ein helles Gelb bzw. Grün wäre darauf praktisch unsichtbar.
 */
export const FORECAST_MODELS: ForecastModelInfo[] = [
  {
    key: "icon_ch1",
    label: "ICON-CH1",
    provider: "MeteoSwiss",
    color: "var(--forecast-icon-ch1)",
  },
  {
    key: "icon_d2",
    label: "ICON-D2",
    provider: "DWD",
    color: "var(--forecast-icon-d2)",
  },
  {
    key: "arome_austria",
    label: "AROME",
    provider: "GeoSphere Austria",
    color: "var(--forecast-arome)",
  },
  {
    key: "ecmwf_ifs",
    label: "ECMWF",
    provider: "ECMWF",
    licenseLabel: "IFS",
    color: "var(--forecast-ecmwf)",
  },
];

/**
 * Höhenwind (Druckflächen-Wind). Kein eigenes Modell im Sinne der Liste oben:
 * er stammt aus ICON-D2, wird gestrichelt gezeichnet, hat keine Böen und
 * existiert nur für die Windanzeiger-Stationen — steht aber in derselben
 * Tabelle und ist in der Legende genauso ein-/ausblendbar.
 */
export const UPPER_FORECAST_MODEL = {
  key: "icon_d2_upper",
  label: "Höhenwind",
  color: "var(--forecast-upper)",
} as const;

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
  "raujoch", // Pfelders Raujoch
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
   * Obere Grenze dieser Stufe in km/h (exklusiv), Infinity für die letzte Stufe.
   * Bewusst auf halben Werten (6.5, 14.5, …), damit die Farbe immer zu der
   * gerundeten Zahl passt, die neben dem Pfeil steht: 6.6 km/h wird als "7"
   * angezeigt und gehört damit schon zur Stufe "spürbar" (7–14).
   */
  max: number;
  /** Hex-Farbcode dieser Stufe. */
  color: string;
  /** Untere Grenze dieser Stufe als Beschriftung, z. B. "15" für die Stufe 15–24. */
  label: string;
  /** Wortbezeichnung der Stufe laut Legende, z. B. "mässig". */
  name: string;
  /**
   * Abweichende Deckkraft für die Farbbänder im Verlaufsbalken. Nur für die
   * schwarze Stufe gesetzt: sonst würde die schwarze Messkurve auf einem
   * schwarzen Band verschwinden.
   */
  bandOpacity?: number;
}

/**
 * Farbskala der Windstärke (Windwerte für Gleitschirmflieger).
 * Grenzwerte und Farben sind mit dem Projektbesitzer per Screenshot-Vorlage
 * abgestimmt (hellblau → grün → gelb → orange → dunkelrot → schwarz);
 * bei Änderungswunsch bitte hier zentral anpassen. Die unterste Stufe ist
 * bewusst ein ganz helles Blau statt des Weiß der Vorlage, damit schwache
 * Pfeile auf hellem Kartenhintergrund ohne zusätzliche Kontur sichtbar sind.
 */
export const WIND_COLOR_SCALE: WindColorStop[] = [
  { max: 6.5, color: "#CFE8F7", label: "0", name: "schwach" }, // ganz helles Blau
  { max: 14.5, color: "#6EE45C", label: "7", name: "spürbar" }, // Hellgrün
  { max: 24.5, color: "#FAF264", label: "15", name: "mässig" }, // Gelb
  { max: 30.5, color: "#F0913C", label: "25", name: "stark" }, // Orange
  { max: 36.5, color: "#C0281B", label: "31", name: "sehr stark" }, // Dunkelrot
  { max: Infinity, color: "#000000", label: "37", name: "zu stark", bandOpacity: 0.3 }, // Schwarz
];

/** Liefert für einen Windwert (km/h) die passende Farbe der Windskala. */
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
