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
  "dannelspitz", // Pfunders Dannelspitz (ohne End-"e", damit auch
  // "Dannelspitze" gefunden wird)
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

// Die Suchbegriffe werden EINMAL beim Laden vereinheitlicht statt bei jedem
// Vergleich neu. Vorher lief die (nicht ganz billige) Unicode-Normalisierung
// bei jedem Neuzeichnen der Karte für jede Station mal jeden Suchbegriff —
// also gut tausend Mal pro Bildaufbau, immer mit demselben Ergebnis.
const WINDANZEIGER_NEEDLES = WINDANZEIGER_STATION_NAMES.map(normalizeStationName);

/** true, wenn die Station Teil des kuratierten "Windanzeiger"-Filters ist. */
export function isWindanzeigerStation(station: WindStation): boolean {
  const name = normalizeStationName(station.stationName);
  return WINDANZEIGER_NEEDLES.some((needle) => name.includes(needle));
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

export interface WindColorBand {
  /**
   * Obergrenze dieses Farbbereichs in km/h, EINSCHLIESSLICH: der Bereich
   * gilt von der Obergrenze des vorherigen Bands (ausschließlich) bis
   * hierher. null = nach oben offen, gilt also für alles darüber.
   */
  upTo: number | null;
  /** Hex-Farbcode dieses Bereichs. */
  color: string;
  /** Wortbezeichnung zur Einordnung, z. B. "mässig". */
  name: string;
}

/**
 * Farbskala der Windstärke (Windwerte für Gleitschirmflieger) als klare
 * Farbflächen: jeder Bereich hat GENAU EINE Farbe, dazwischen wird nichts
 * gemischt. Die Bereiche sind vom Projektbesitzer vorgegeben:
 *   0–10 km/h hellblau, 11–20 grün, 21–25 gelb, 26–30 orange, ab 31 rot.
 * (Früher war das ein durchgehender Verlauf mit einer eigenen Farbe pro
 * km/h; auf Wunsch des Projektbesitzers wieder zurück auf harte Stufen.
 * Die Farbtöne selbst wurden zuletzt an eine Vorlage des Projektbesitzers
 * angeglichen: die oberste Stufe ist rot statt violett, darunter orange
 * statt rot — die Bereichsgrenzen blieben dabei unverändert.)
 * Die unterste Stufe ist bewusst ein ganz helles Blau statt Weiß, damit
 * schwache Pfeile auf hellem Kartenhintergrund ohne zusätzliche Kontur
 * sichtbar sind. Bei Änderungswunsch bitte hier zentral anpassen — die
 * Kartenpfeile, die Wert-Quadrate und die Farbflächen samt Achsen-
 * beschriftung im Verlaufsbalken leiten sich alle hiervon ab.
 */
export const WIND_COLOR_SCALE: WindColorBand[] = [
  { upTo: 10, color: "#CFE8F7", name: "schwach" }, // ganz helles Blau
  { upTo: 20, color: "#7ED96F", name: "spürbar" }, // Grün
  { upTo: 25, color: "#FAE45C", name: "mässig" }, // Gelb
  { upTo: 30, color: "#F0812F", name: "stark" }, // Orange
  { upTo: null, color: "#E24B45", name: "zu stark" }, // Rot
];

/**
 * Liefert für einen Windwert (km/h) die Farbe seines Bereichs aus der
 * Windskala. Gerundet wird auf ganze km/h, damit die angezeigte Zahl und
 * ihre Farbe immer zusammenpassen (z. B. 10,4 km/h wird als "10" angezeigt
 * und ist deshalb auch hellblau).
 */
export function getWindColor(speedKmh: number | null): string {
  const speed = Math.round(speedKmh ?? 0);
  for (const band of WIND_COLOR_SCALE) {
    if (band.upTo === null || speed <= band.upTo) return band.color;
  }
  return WIND_COLOR_SCALE[WIND_COLOR_SCALE.length - 1].color;
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
