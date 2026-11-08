import { WIND_COLOR_SCALE } from "./wind";

// Föhn-Anzeige: Druckdifferenz zwischen Bozen und Innsbruck (Nov. 2026,
// Wunsch des Projektbesitzers; Vorbild die "Live-Druckdifferenzen" der burnair
// Map). Gemeinsame Angaben für Sammler, /api/pressure, Karte und
// Druck-Verlaufsbalken. Die Abrufe selbst stehen in src/lib/stationPressure.ts
// und src/lib/crestTemperature.ts (nur Server).
//
// QFF STATT QNH (seit 8. Nov. 2026, Wunsch des Projektbesitzers nach einer
// Recherche; vorher "immer QNH"): Angezeigt wird der Luftdruck auf
// Meereshöhe, umgerechnet mit der ECHTEN Temperatur und Feuchte der Station
// (QFF, siehe qffFromStation) — nicht mehr nach der Normatmosphäre der ICAO
// (QNH, wie die Flughäfen ihn melden). Grund: Bozen liegt 333 m tiefer als
// Innsbruck; für dieses Stück nimmt der QNH immer "Normluft" (~12 °C) an. Ist
// es wärmer oder kälter, verfälscht das die Differenz um ~0,14 hPa je Grad —
// bis gut 2 hPa an heißen Sommernachmittagen oder bei Winterkälte, mehr als
// eine Farbstufe. MeteoSchweiz empfiehlt für Druckdifferenzen ausdrücklich das
// QFF, und auch die Föhndiagramme der Wetterdienste und Modelle rechnen mit
// der Temperatur — ihre Faustregeln (3/4/6 hPa) beziehen sich darauf. An den
// Daten vom 5.–8. Nov. 2026 lag die QFF-Differenz im Mittel 0,9 hPa unter der
// QNH-Differenz.
// GESPEICHERT wird weiter der QNH (Spalte qnh_hpa) samt Temperatur und
// Feuchte: Der QNH lässt sich exakt in den Stationsdruck zurückrechnen
// (stationFromQnh), daraus rechnet /api/pressure beim Auslesen das QFF
// (toQffSeries) — so gilt die neue Rechnung sofort auch für alle
// gespeicherten Werte, ohne Änderung an der Datenbank. Die reduzierten Werte
// der Landeswetterdienste werden NICHT direkt verglichen (jeder rechnet
// anders).
//
// MESSREIHE: alle 10 min auf 0,1 hPa, selbst gerechnet aus den
// Wetterstationen Innsbruck-Flughafen (GeoSphere) und Bozen
// (Landeswetterdienst) — src/lib/stationPressure.ts. Für Hauptkurve, Linie
// und Schild auf der Karte. Bis 8. Nov. 2026 gab es dazu die METAR der
// Flughäfen LOWI und LIPB (die erste Fassung zeigte nur diese: ganze hPa,
// Bozen nachts ohne Meldung, die Kurve war treppig und jede Nacht
// unterbrochen; danach Vergleichslinie, zuletzt nur Ersatz) — auf Wunsch des
// Projektbesitzers ganz entfernt, nicht wieder einführen.
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

/**
 * Temperatur auf Kammhöhe (8. Nov. 2026, Wunsch des Projektbesitzers; ersetzt
 * im Druck-Verlaufsbalken die Temperaturen der Talstationen Bozen und
 * Innsbruck): zwei fast gleich hohe Bergstationen südlich und nördlich des
 * Brenners. Hintergrund (Recherche Nov. 2026: DHV, Schweizer Verband SHV,
 * XCTherm, Uni Innsbruck): Föhn wird nicht nur vom Druck am Boden angetrieben,
 * sondern auch vom Temperaturunterschied der Luftmassen auf Höhe der Pässe —
 * kalte, schwere Luft drängt über die Pässe zur wärmeren Seite. Die
 * Temperaturen am Talboden zeigen das kaum (Tagesgang, Kaltluftseen,
 * Inversionen); deshalb hier zwei Gipfel auf rund 2260 m. Höhenunterschied
 * nur 10 m (~0,07 °C) — bewusst nicht bereinigt.
 * NORDEN = HAFELEKAR (Nordkette) seit 8. Nov. 2026, Wunsch des
 * Projektbesitzers; vorher Patscherkofel (GeoSphere 11126, 2251 m). Der
 * Patscherkofel liegt am Ausgang des Wipptals und steht bei Südföhn selbst in
 * der Föhnströmung (zeigt dann Luft aus dem Süden); der Hafelekar liegt
 * weiter vom Alpenhauptkamm weg. Sein Dienst liefert nur den neuesten Wert
 * (src/lib/crestTemperature.ts).
 * `code` = Kennung beim Dienst (Land Südtirol bzw. LWD Tirol), `id` = Schlüssel
 * in der Tabelle pressure_values (Spalte station). Kopie mit Koordinaten in
 * der Edge Function (CREST_STATIONS) — bei einer Änderung beide anfassen.
 */
export const CREST_STATIONS = {
  RITTNERHORN: {
    id: "RITTNERHORN",
    name: "Rittnerhorn",
    code: "82500WS",
    lat: 46.6156,
    lng: 11.4604,
    elevationM: 2260,
  },
  HAFELEKAR: {
    id: "HAFELEKAR",
    name: "Hafelekar",
    code: "ISEE1",
    lat: 47.3121,
    lng: 11.3836,
    elevationM: 2270,
  },
} as const;

export type CrestStationId = keyof typeof CREST_STATIONS;
export const CREST_STATION_IDS = Object.keys(CREST_STATIONS) as CrestStationId[];

/** Das Paar für den Temperaturvergleich, gezählt wie der Druck: Süd − Nord. */
export const CREST_PAIR = { north: "HAFELEKAR", south: "RITTNERHORN" } as const satisfies {
  north: CrestStationId;
  south: CrestStationId;
};

/**
 * Spalte kind der gemessenen Kammtemperaturen in pressure_values (alle 10 min,
 * vom Sammler; qnh_hpa leer). Die ICON-CH1-Prognose dieser Stationen steht
 * unter kind 'icon_ch1' (Edge Function), ebenfalls ohne qnh_hpa.
 */
export const CREST_KIND = "kamm";

/** Name der Zeile in wind_status, in die der Sammler den Zustand der Druck-Abfrage schreibt. */
export const PRESSURE_STATUS_NAME = "druck";

/**
 * Ab diesem Alter gilt die Differenz als ausgefallen (Linie grau, ohne Zahl).
 * Die 10-Minuten-Werte der Stationen sind normal 10–20 min alt. Die 2 h
 * stammen aus der Zeit, als bei fehlenden Stationswerten die stündlichen
 * METAR einsprangen (bis 8. Nov. 2026); seitdem gelten sie nur noch für die
 * Stationswerte und ließen sich verkürzen. Auch /api/pressure nutzt die
 * Grenze für den Notbetrieb.
 */
export const PRESSURE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Zwei Messungen gehören zusammen, wenn sie höchstens so weit auseinander
 * liegen. Die Stationen messen beide zu jeder vollen 10 Minuten; fehlt auf
 * einer Seite ein Wert, wird der nächstgelegene genommen.
 */
const PAIR_TOLERANCE_MS = 20 * 60 * 1000;

/** Antwort von /api/pressure. Zeiten in ms (UTC), Druck in hPa (QFF, siehe oben). */
export interface PressurePayload {
  /**
   * Hauptkurve: QFF alle 10 min, aus den Wetterstationen an den Flughäfen
   * (src/lib/stationPressure.ts), letzte HISTORY_HOURS, aufsteigend.
   */
  stations: Record<PressureStationId, Array<[number, number]>>;
  /**
   * Lufttemperatur (°C) auf Kammhöhe (Rittnerhorn, Hafelekar), alle
   * 10 min, aufsteigend — für das Temperatur-Diagramm (seit 8. Nov. 2026;
   * vorher die Talstationen Bozen und Innsbruck im Feld "temperature").
   */
  crestTemperature: Record<CrestStationId, Array<[number, number]>>;
  /** ICON-CH1-Prognose je Flughafen (QFF, stündlich), aufsteigend. */
  forecast: Record<PressureStationId, Array<[number, number]>>;
  /** ICON-CH1-Prognose der Lufttemperatur (2 m, °C) auf Kammhöhe, stündlich. */
  crestTemperatureForecast: Record<CrestStationId, Array<[number, number]>>;
  /** ECMWF-Prognose (IFS, 9 km) je Flughafen (QFF, stündlich), aufsteigend. */
  ecmwf: Record<PressureStationId, Array<[number, number]>>;
  /** Startzeit des ECMWF-Laufs (ISO), sonst null. */
  ecmwfRun: string | null;
  /** Startzeit des Modelllaufs (ISO), sonst null. */
  modelRun: string | null;
  /** true = Messwerte im Notbetrieb direkt bei den Diensten geholt (nicht aus der Datenbank). */
  fallback: boolean;
}

// --- Umrechnung QNH → QFF (seit 8. Nov. 2026, siehe oben) ---

/**
 * Höhe (m), auf die sich der gespeicherte QNH der MESSUNG bezieht: die
 * Barometer der Wetterstationen (GeoSphere 11121 Innsbruck-Flughafen, Land
 * Südtirol 83200MS Bozen). Die PROGNOSE bezieht sich auf die Flughafenhöhe
 * (PRESSURE_STATIONS.elevationM, 581/240 m) — so hat die Edge Function ihren
 * QNH gerechnet. Zurückgerechnet werden muss mit derselben Höhe.
 */
export const MEASURED_ELEVATION_M: Record<PressureStationId, number> = { LOWI: 578, LIPB: 245 };

/** QNH aus dem Druck in Stationshöhe nach der Normatmosphäre der ICAO (wie die Flughäfen). */
export function qnhFromStation(stationHpa: number, elevationM: number): number {
  return Math.pow(Math.pow(stationHpa, 0.190263) + 8.417286e-5 * elevationM, 1 / 0.190263);
}

/** Umkehrung von qnhFromStation: Druck in Stationshöhe aus dem QNH (exakt). */
export function stationFromQnh(qnh: number, elevationM: number): number {
  return Math.pow(Math.pow(qnh, 0.190263) - 8.417286e-5 * elevationM, 1 / 0.190263);
}

/** Dampfdruck (hPa) aus Temperatur (°C) und relativer Feuchte (%), Magnus-Formel. */
function vaporPressureHpa(tempC: number, humidityPct: number): number {
  return (humidityPct / 100) * 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
}

/**
 * QFF: Druck in Stationshöhe auf Meereshöhe umgerechnet mit der mittleren
 * Temperatur der gedachten Luftsäule unter der Station — Mitteltemperatur
 * (`tempMeanC`, siehe toQffSeries) plus halber Normgradient (0,65 K je
 * 100 m bis zur Mitte der Säule), als VIRTUELLE Temperatur: Feuchte Luft ist
 * leichter, das macht bis ~0,3 hPa aus (Nachfrage des Projektbesitzers,
 * Nov. 2026). Ohne Feuchte (null) wird trocken gerechnet. Dampfdruck aus der
 * aktuellen Temperatur und Feuchte.
 */
export function qffFromStation(
  stationHpa: number,
  elevationM: number,
  tempMeanC: number,
  tempNowC: number,
  humidityPct: number | null,
): number {
  const meanK = tempMeanC + 273.15 + (0.0065 * elevationM) / 2;
  const e = humidityPct === null ? 0 : vaporPressureHpa(tempNowC, humidityPct);
  const virtualK = meanK / (1 - (0.378 * e) / stationHpa);
  return stationHpa * Math.exp((9.80665 * elevationM) / (287.05 * virtualK));
}

/** Eine gespeicherte Druckzeile: Zeit (ms), QNH, Temperatur (°C) und Feuchte (%). */
export interface QnhReading {
  time: number;
  qnh: number;
  tempC: number | null;
  humidityPct: number | null;
}

/**
 * Wie weit die Temperatur für die Umrechnung zurückblickt: Gerechnet wird mit
 * dem Mittel aus der aktuellen Temperatur und der von vor 12 h — übliche
 * Praxis der Wetterdienste (AMS-Glossar, US-Wetterdienst), damit der
 * Tagesgang der Temperatur am Boden (mittags heiß, nachts kalt) nicht als
 * Druckschwankung erscheint; die gedachte Luftsäule darunter macht ihn nicht
 * mit. /api/pressure liest dafür 12 h mehr Werte als angezeigt.
 */
export const QFF_TEMP_LAG_MS = 12 * 60 * 60 * 1000;
// Nächster Wert um "vor 12 h" höchstens so weit entfernt; sonst nur die
// aktuelle Temperatur.
const QFF_TEMP_MATCH_MS = 30 * 60 * 1000;

/**
 * QNH-Zeilen EINER Station (aufsteigend) als QFF-Reihe [Zeit, hPa], ab
 * `since`. Zeilen ohne Temperatur fallen weg (ohne Temperatur kein QFF).
 */
export function toQffSeries(
  readings: QnhReading[],
  elevationM: number,
  since: number,
): Array<[number, number]> {
  const temps = readings.filter((r) => r.tempC !== null) as Array<QnhReading & { tempC: number }>;
  const result: Array<[number, number]> = [];
  let j = 0;
  for (const r of temps) {
    if (r.time < since) continue;
    // Temperatur von vor 12 h: beide Reihen aufsteigend, j läuft nur vorwärts.
    const target = r.time - QFF_TEMP_LAG_MS;
    while (j + 1 < temps.length && Math.abs(temps[j + 1].time - target) <= Math.abs(temps[j].time - target)) j++;
    const earlier = temps[j] && Math.abs(temps[j].time - target) <= QFF_TEMP_MATCH_MS ? temps[j].tempC : null;
    const tempMean = earlier === null ? r.tempC : (r.tempC + earlier) / 2;
    const station = stationFromQnh(r.qnh, elevationM);
    const qff = qffFromStation(station, elevationM, tempMean, r.tempC, r.humidityPct);
    if (Number.isFinite(qff)) result.push([r.time, round1(qff)]);
  }
  return result;
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
 * (dritte Fassung des Projektbesitzers, Nov. 2026). Die Stufengrenzen auf
 * halben hPa stammen aus der Zeit der ganzzahligen METAR-Werte (0 blau,
 * 1 grün, 2 gelb, 3 orange, ab 4 rot); seit den 10-Minuten-Werten auf 0,1 hPa
 * entscheidet die Zehntel-Rundung (foehnColor).
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

/** Differenz als Text, z. B. "+1,6 hPa" / "−3 hPa" (ganze Werte ohne Komma). */
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
 * Open-Meteo.
 */
export const PRESSURE_SOURCES: Array<{ label: string; url: string; note?: string }> = [
  {
    label: "Luftdruck Innsbruck-Flughafen © GeoSphere Austria",
    url: "https://data.hub.geosphere.at",
    note: "CC BY 4.0",
  },
  {
    label: "Temperatur Hafelekar © Lawinenwarndienst Tirol – Land Tirol",
    url: "https://lawine.tirol.gv.at",
    note: "CC BY 4.0",
  },
  {
    label: "Luftdruck Bozen, Temperatur Rittnerhorn © Land Südtirol – Wetterdienst",
    url: "https://wetter.provinz.bz.it",
  },
  {
    label: "Druck- und Temperaturprognose ICON-CH1 © MeteoSchweiz über Open-Meteo",
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
