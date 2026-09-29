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
  /**
   * Datenquelle: Bozner Wetterdienst, OpenWindMap/Pioupiou-Netzwerk, die
   * IMIS-Stationen des SLF (Schweiz, siehe src/lib/slf.ts) oder GeoSphere
   * Austria (früher ZAMG, siehe src/lib/geosphere.ts)
   */
  source: "bolzano" | "openwindmap" | "slf" | "geosphere";
}

/** Anzeigename + Link zur Datenquelle, z. B. für den "Quelle:"-Hinweis im Verlaufsbalken. */
export const SOURCE_INFO: Record<
  WindStation["source"],
  { label: string; url: string }
> = {
  bolzano: { label: "Land Südtirol – Wetterdienst", url: "https://wetter.provinz.bz.it" },
  openwindmap: { label: "OpenWindMap / Pioupiou", url: "https://openwindmap.org" },
  // Lizenz CC BY 4.0 — die Nennung des SLF ist Pflicht, nicht entfernen.
  slf: {
    label: "WSL-Institut für Schnee- und Lawinenforschung SLF (IMIS)",
    url: "https://www.slf.ch/de/services-und-produkte/slf-datenservice/",
  },
  // Lizenz CC BY 4.0: Dieser Link ist die Pflicht-Quellenangabe, nicht entfernen.
  geosphere: { label: "GeoSphere Austria (CC BY 4.0)", url: "https://data.hub.geosphere.at" },
};

/**
 * Wie oft eine Quelle einen neuen Messwert liefert (Minuten). Bozen misst
 * alle 10 min, Pioupiou sendet unregelmäßig alle paar Minuten (landet im
 * 10-Minuten-Raster), GeoSphere Austria ebenfalls alle 10 min. Die SLF-IMIS-Stationen liefern dagegen nur einen
 * 30-Minuten-Mittelwert zu :00 und :30 — nachgeprüft im Sept. 2026, auch
 * whiterisk.ch selbst zeigt nichts Feineres.
 *
 * Daraus leiten sich ab:
 *  - measurementGapMs: ab welcher Lücke die Kurve im Verlaufsbalken abreißt,
 *  - der "Halte"-Zeitraum im Zeitbalken (/api/timeline): ein 30-Minuten-Wert
 *    bleibt dort bis zum nächsten Wert stehen, statt dass die Station an den
 *    Zwischenschritten :10/:20 grau wird.
 */
export const SOURCE_INTERVAL_MINUTES: Record<WindStation["source"], number> = {
  bolzano: 10,
  openwindmap: 10,
  slf: 30,
  geosphere: 10,
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
 * Anzeige-Raster: Schrittweite des Zeitbalkens unter der Karte und
 * Spaltendichte im Verlaufsbalken. Steht hier zentral, damit Zeitbalken,
 * /api/timeline und der Verlaufsbalken dasselbe Raster benutzen.
 *
 * 10 Minuten, weil die Bozner Stationen in diesem Takt messen. NICHT zu
 * verwechseln mit dem Abruf-Takt: /api/collect läuft alle 5 Minuten, also
 * doppelt so oft — siehe den Kommentar dort, warum das nötig ist.
 */
export const TIMELINE_STEP_MINUTES = 10;
export const GRID_MS = TIMELINE_STEP_MINUTES * 60 * 1000;
/** 12 h × 6 Schritte + der Schritt "jetzt" = 73 Rasterpunkte. */
export const TIMELINE_SLOT_COUNT =
  HISTORY_HOURS * (60 / TIMELINE_STEP_MINUTES) + 1;

/**
 * Größter Abstand zweier Messungen, über den die Kurven im Verlaufsbalken
 * noch durchgezogen werden: 2,5 Messtakte der Quelle. Bei 10-Minuten-Quellen
 * sind das 25 min (EIN fehlender Wert wird überbrückt, ab ZWEI reißt die
 * Kurve auf — siehe die ausführliche Begründung bei BAND_GAP_MS in
 * WindHistoryPanel.tsx). Für die 30-Minuten-Werte des SLF gilt dieselbe Regel
 * im eigenen Takt: 75 min. Mit dem 10-Minuten-Wert wäre jede SLF-Kurve nur
 * noch eine Reihe einzelner Punkte.
 */
export function measurementGapMs(source: WindStation["source"]): number {
  const intervalMs = Math.max(SOURCE_INTERVAL_MINUTES[source] * 60 * 1000, GRID_MS);
  return 2.5 * intervalMs;
}

/**
 * Rastet einen Zeitpunkt auf das 10-Minuten-Raster ein.
 * Bezugspunkt ist die volle LOKALE Stunde (nicht die Epoche), damit das
 * Raster auch in Zeitzonen mit halbstündigem Versatz exakt auf :00/:10/:20
 * fällt.
 */
export function snapToGrid(t: number): number {
  const hourStart = new Date(t);
  hourStart.setMinutes(0, 0, 0);
  const base = hourStart.getTime();
  return base + Math.round((t - base) / GRID_MS) * GRID_MS;
}

/**
 * Die Rasterzeitpunkte des Zeitbalkens: aufsteigend, der LETZTE Eintrag ist
 * "jetzt" (auf das Raster eingerastet), der erste liegt HISTORY_HOURS davor.
 * Hängt nur an der Uhr — der Balken kann also gezeichnet werden, bevor
 * irgendwelche Daten geladen sind.
 */
export function buildTimelineSlots(now: number): number[] {
  const end = snapToGrid(now);
  return Array.from(
    { length: TIMELINE_SLOT_COUNT },
    (_, i) => end - (TIMELINE_SLOT_COUNT - 1 - i) * GRID_MS,
  );
}

/** Messwerte EINER Station zu EINEM Rasterzeitpunkt (siehe TimelinePayload). */
export interface TimelineValue {
  direction: number | null;
  speedKmh: number | null;
  gustKmh: number | null;
}

/**
 * Drei gleich lange Spalten, parallel zu TimelinePayload.times:
 * d = Richtung (Grad), s = Mittelwind (km/h), g = Böe (km/h).
 * null bedeutet: zu diesem Zeitpunkt keine Messung.
 * Bewusst so kurz benannt — bei ~130 Stationen × 73 Zeitpunkten macht das
 * im JSON einen spürbaren Unterschied.
 */
export interface TimelineSeries {
  d: (number | null)[];
  s: (number | null)[];
  g: (number | null)[];
}

/** Antwort von /api/timeline: die Messwerte ALLER Stationen der letzten 12 h. */
export interface TimelinePayload {
  hours: number;
  stepMinutes: number;
  /** Jüngster Rasterzeitpunkt (= letzter Eintrag in times), Epoch-ms. */
  generatedAt: number;
  /** Rasterzeitpunkte (Epoch-ms), aufsteigend. */
  times: number[];
  /** Anzahl gelesener Datenbankzeilen — nur zur Fehlersuche. */
  rows: number;
  /** true, wenn die Seiten-Obergrenze griff (siehe /api/timeline). */
  truncated: boolean;
  stations: Record<string, TimelineSeries>;
}

/** Die Messwerte aller Stationen zu EINEM gewählten Zeitpunkt. */
export interface TimelineFrame {
  time: number;
  values: Map<string, TimelineValue>;
}

/**
 * Schneidet aus dem Spalten-Payload die Werte eines Zeitpunkts heraus.
 * `time === null` bedeutet "live" — dann gibt es keinen Verlaufs-Ausschnitt.
 *
 * Maßgeblich ist die Zeitliste des SERVERS, nicht die des Browsers: gesucht
 * wird der Rasterpunkt, der dem gewünschten Zeitpunkt am nächsten liegt
 * (höchstens einen halben Schritt daneben). Weil die Zeiten ein gleichmäßiges
 * Raster bilden, geht das ohne Suche direkt per Rechnung.
 */
export function buildTimelineFrame(
  payload: TimelinePayload | null,
  time: number | null,
): TimelineFrame | null {
  if (time === null) return null;
  const values = new Map<string, TimelineValue>();
  if (!payload || payload.times.length === 0) return { time, values };

  const start = payload.times[0];
  const idx = Math.round((time - start) / GRID_MS);
  // Kein passender Rasterpunkt (z. B. Daten veraltet): bewusst ein LEERER
  // Ausschnitt statt gar keiner — dann werden alle Stationen grau, statt
  // heimlich wieder Live-Werte zu zeigen.
  if (idx < 0 || idx >= payload.times.length) return { time, values };
  if (Math.abs(payload.times[idx] - time) > GRID_MS / 2) return { time, values };

  for (const [code, series] of Object.entries(payload.stations)) {
    const direction = series.d[idx] ?? null;
    const speedKmh = series.s[idx] ?? null;
    const gustKmh = series.g[idx] ?? null;
    if (direction === null && speedKmh === null && gustKmh === null) continue;
    values.set(code, { direction, speedKmh, gustKmh });
  }
  return { time: payload.times[idx], values };
}

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

/**
 * Zugangsschlüssel für die CARTO-Ortsnamen (Ebene "Beschriftung" über dem
 * Relief). Seit Sept. 2026 liefert CARTO ohne Schlüssel nur noch Kacheln mit
 * dem Wasserzeichen "API KEY REQUIRED". Der Schlüssel ist für nicht-
 * kommerzielle Nutzung kostenlos (https://carto.com/basemaps/apikey/).
 *
 * Er steht NICHT im Code, sondern als Umgebungsvariable
 * NEXT_PUBLIC_CARTO_API_KEY in Vercel. Er ist kein Geheimnis im engeren Sinn
 * — er steht zwangsläufig in jeder Kachel-Adresse, die der Browser lädt —,
 * so lässt er sich aber ohne Code-Änderung tauschen. Wichtig: NEXT_PUBLIC_-
 * Variablen werden beim Bauen eingesetzt; nach dem Eintragen in Vercel muss
 * also einmal neu deployt werden.
 *
 * Fehlt der Schlüssel, nimmt die Karte ersatzweise die Esri-Ortsnamen
 * (ohne Schlüssel nutzbar, aber nur italienische Namen) — siehe WindMap.tsx.
 */
export const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY || "";

type SourceLink = { label: string; url: string; note?: string };

/**
 * Quellenangaben der Kartenkacheln je Kartenhintergrund.
 *
 * Sie stehen seit Sept. 2026 NICHT mehr in Leaflets Zeile unten rechts auf
 * der Karte (die hat auf dem Handy zwei Zeilen belegt und die
 * "Zuletzt aktualisiert"-Plakette überdeckt), sondern ganz unten im Menü-Popup
 * unter "Quellen" (WindApp.tsx). Auf der Karte ist Leaflets Zeile dafür per
 * attributionControl={false} abgeschaltet (WindMap.tsx).
 *
 * Wichtig: Die Höhenlinien des Landes stehen unter CC BY 4.0 — die Nennung
 * ist Pflicht und darf hier nicht wegfallen, solange die Ebene angezeigt wird.
 * CARTO verlangt laut seinen Bedingungen "© OpenStreetMap contributors,
 * © CARTO"; Gleiches gilt sinngemäß für OpenStreetMap (ODbL) und Esri.
 * Die Beschriftungs-Zeile folgt automatisch der tatsächlich genutzten Quelle
 * (CARTO mit Schlüssel, sonst Esri).
 */
export const MAP_SOURCES: Record<BaseLayer, SourceLink[]> = {
  standard: [
    {
      label: "© OpenStreetMap-Mitwirkende",
      url: "https://www.openstreetmap.org/copyright",
    },
  ],
  relief: [
    { label: "Relief © Esri", url: "https://www.esri.com" },
    {
      label: "Höhenlinien © Autonome Provinz Bozen – Südtirol",
      url: "https://geoportal.buergernetz.bz.it",
      note: "CC BY 4.0",
    },
    CARTO_API_KEY
      ? {
          label: "Beschriftung © OpenStreetMap-Mitwirkende, © CARTO",
          url: "https://carto.com/attributions",
        }
      : {
          label: "Beschriftung © Esri, HERE, Garmin, OpenStreetMap-Mitwirkende",
          url: "https://www.esri.com",
        },
  ],
};

// "below1000"/"below2000"/"high"/"veryHigh": Höhenfilter (nur Stationen bis
// bzw. ab einer Höhenschwelle), "all": keine Einschränkung. "windanzeiger":
// der benannte, kuratierte Filter, der nur die vom Projektbesitzer
// ausgewählten Stationen zeigt (siehe isWindanzeigerStation oben). Es ist
// immer genau ein Filter aktiv; die Stationslisten zweier Filter dürfen sich
// dabei überschneiden (siehe ALTITUDE_FILTERS).
export type AltitudeStationFilter = "below1000" | "below2000" | "high" | "veryHigh";
export type StationFilter = "all" | AltitudeStationFilter | "windanzeiger";

export const LOW_ALTITUDE_THRESHOLD_M = 1000;
export const HIGH_ALTITUDE_THRESHOLD_M = 2000;
export const VERY_HIGH_ALTITUDE_THRESHOLD_M = 3000;

/**
 * Die Höhenfilter an EINER Stelle: Schwelle + Richtung ("above" = ab der
 * Schwelle aufwärts, "below" = bis zur Schwelle abwärts). Menü-Beschriftung (WindApp.tsx) und
 * Filterlogik (WindMap.tsx) werden beide hieraus abgeleitet und können deshalb
 * nicht mehr auseinanderlaufen. Eine weitere Höhenstufe braucht nur einen
 * Eintrag hier, in AltitudeStationFilter und in STATION_FILTER_ORDER.
 *
 * Die Schwelle gehört bewusst zu BEIDEN Seiten: "≥2.000m" schließt 2.000 m
 * ein, "≤2.000m" ebenso. Eine Station auf exakt 2.000 m erscheint also in
 * beiden Filtern — so wird keine Station übersehen, nur weil sie genau auf der
 * Schwelle liegt (ausdrücklicher Wunsch des Projektbesitzers).
 */
export const ALTITUDE_FILTERS: Record<
  AltitudeStationFilter,
  { thresholdM: number; direction: "above" | "below" }
> = {
  below1000: { thresholdM: LOW_ALTITUDE_THRESHOLD_M, direction: "below" },
  below2000: { thresholdM: HIGH_ALTITUDE_THRESHOLD_M, direction: "below" },
  high: { thresholdM: HIGH_ALTITUDE_THRESHOLD_M, direction: "above" },
  veryHigh: { thresholdM: VERY_HIGH_ALTITUDE_THRESHOLD_M, direction: "above" },
};

/** Reihenfolge der Filter-Schaltflächen im Menü: von unten nach oben. */
export const STATION_FILTER_ORDER: StationFilter[] = [
  "all",
  "below1000",
  "below2000",
  "high",
  "veryHigh",
  "windanzeiger",
];

/**
 * Beschriftung einer Filter-Schaltfläche im Menü, z. B. "Stationen ≤1.000m".
 * "≥"/"≤" statt ">"/"<", weil die Schwelle selbst mit dazugehört.
 */
export function getStationFilterLabel(filter: StationFilter): string {
  if (filter === "all") return "Alle";
  if (filter === "windanzeiger") return "Windanzeiger";
  const { thresholdM, direction } = ALTITUDE_FILTERS[filter];
  const sign = direction === "above" ? "≥" : "≤";
  return `Stationen ${sign}${thresholdM.toLocaleString("de-DE")}m`;
}

/**
 * true, wenn die Station beim gewählten Filter auf der Karte sichtbar ist.
 * Stationen ohne Höhenangabe fallen bei jedem Höhenfilter heraus — bei
 * unbekannter Höhe lässt sich nicht sagen, ob sie dazugehören.
 */
export function matchesStationFilter(station: WindStation, filter: StationFilter): boolean {
  if (filter === "all") return true;
  if (filter === "windanzeiger") return isWindanzeigerStation(station);
  const { thresholdM, direction } = ALTITUDE_FILTERS[filter];
  if (station.altitude === null) return false;
  // >= bzw. <=: Die Schwelle selbst zählt zu beiden Seiten (siehe Kommentar
  // bei ALTITUDE_FILTERS).
  return direction === "above" ? station.altitude >= thresholdM : station.altitude <= thresholdM;
}

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
