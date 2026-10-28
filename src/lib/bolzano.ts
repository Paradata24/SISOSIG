import { isOutdated, METADATA_TIMEOUT_MS, SOURCE_TIMEOUT_MS, type WindStation } from "./wind";

// Gemeinsame Logik zum Abrufen der Stationen des Bozner Wetterdienstes
// (Open-Data-Webservice der Provinz Bozen für Wetter-/Pegelstationen).
// Genutzt von /api/wind (Live-Anzeige) und /api/collect (Sammel-Route für die
// Historie). Bis Okt. 2026 stand diese Logik in beiden Routen doppelt; seitdem
// ist Bozen eine Quelle wie alle anderen: Fällt der Dienst aus, zeigen Karte
// und Sammler die übrigen Quellen trotzdem (vorher war dann alles leer).
//
// Datensatz: https://data.civis.bz.it/de/dataset/misure-meteo-e-idrografiche
// Zwei Anfragen genügen für alle Stationen: /sensors liefert die aktuellen
// Messwerte ALLER Stationen auf einmal, /stations alle Metadaten.
//
// ADRESSE: Seit Sept. 2026 läuft der Dienst unter geoservices.buergernetz.bz.it.
// Die frühere Adresse (daten.buergernetz.bz.it) antwortet nur noch mit 404
// ("Questo endpoint è stato spostato") — die Karte zeigte dann keine Stationen
// mehr. Die aktuelle Adresse steht auf der Datensatz-Seite oben. Sie steht
// zweifach im Projekt: hier und in der Edge Function
// supabase/functions/fetch-wind-forecasts/index.ts — beide mitziehen.
//
// Der Dienst liefert unter /sensors immer nur den NEUESTEN Wert je Sensor,
// rund 10 min nach der Messung (Folgen für den Sammel-Takt: siehe
// /api/collect).
const API_BASE =
  process.env.WIND_API_BASE_URL ??
  "https://geoservices.buergernetz.bz.it/services/meteo/v1";

// Stationsmetadaten (Name, Koordinaten, Höhe) ändern sich praktisch nie und
// werden 6 h im Next.js-Daten-Cache gehalten. Die Messwerte (/sensors) werden
// dagegen IMMER frisch geholt (Begründung bei "Zwischenspeicherung" in
// /api/wind).
const STATIONS_REVALIDATE_S = 6 * 60 * 60;

interface SensorReading {
  SCODE: string;
  TYPE?: string;
  DESC_D: string;
  UNIT?: string;
  DATE?: string;
  VALUE: number | null;
}

interface StationMeta {
  SCODE: string;
  NAME_D?: string;
  NAME_I?: string;
  LAT?: number;
  LONG?: number;
  ALT?: number;
}

/** Ein Messwert einer Bozner Station, schon in unseren Einheiten (km/h). */
export interface BolzanoReading {
  stationCode: string;
  measuredAt: string;
  direction: number | null;
  speedKmh: number | null;
  gustKmh: number | null;
}

// Manche OGC/CKAN-Endpunkte liefern Stationen als flache Liste, andere als
// GeoJSON-FeatureCollection (Koordinaten unter geometry.coordinates). Beide
// Formen werden hier auf eine einheitliche Form gebracht.
function normalizeStations(raw: unknown): StationMeta[] {
  if (Array.isArray(raw)) return raw as StationMeta[];

  if (raw && typeof raw === "object" && Array.isArray((raw as { features?: unknown }).features)) {
    const features = (raw as { features: Array<Record<string, unknown>> }).features;
    return features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const coords = (f.geometry as { coordinates?: [number, number] } | undefined)
        ?.coordinates;
      return {
        SCODE: String(props.SCODE ?? ""),
        NAME_D: props.NAME_D as string | undefined,
        NAME_I: props.NAME_I as string | undefined,
        ALT: props.ALT as number | undefined,
        LAT: (props.LAT as number | undefined) ?? coords?.[1],
        LONG: (props.LONG as number | undefined) ?? coords?.[0],
      };
    });
  }

  return [];
}

// Der Dienst liefert Zeitstempel wie "2026-07-13T14:10:00CEST" — das ist
// kein gültiges ISO 8601 und von JavaScript nicht parsebar. Die Zeitzonen-
// Kürzel werden deshalb durch numerische Offsets ersetzt.
function toIsoTimestamp(date: string | undefined): string | null {
  if (!date) return null;
  return date.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
}

function toKmh(value: number, unit: string | undefined): number {
  if (unit && unit.toLowerCase().includes("m/s")) return value * 3.6;
  return value;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Koordinaten auf 5 Nachkommastellen kürzen (≈ 1 m genau — für einen
// Kartenmarker mehr als ausreichend). Der Dienst liefert teils 10+ Stellen;
// die machen die JSON-Antwort nur unnötig groß, ohne dass man auf der Karte
// irgendetwas davon sieht.
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

const isDirection = (desc: string) => /windrichtung/i.test(desc);
const isSpeed = (desc: string) =>
  /windgeschwindigkeit/i.test(desc) && !/böe/i.test(desc);
const isGust = (desc: string) => /böe/i.test(desc);
const hasCoords = (meta: StationMeta | undefined): meta is StationMeta =>
  typeof meta?.LAT === "number" && typeof meta?.LONG === "number";

// Aktuelle Messwerte, immer frisch (siehe oben). Wirft bei einem Fehler —
// die Routen fangen das ab und machen ohne Bozen weiter.
async function fetchSensors(): Promise<SensorReading[]> {
  const res = await fetch(`${API_BASE}/sensors`, {
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wetterdienst antwortete mit Status ${res.status}`);
  return (await res.json()) as SensorReading[];
}

// Metadaten sind nicht kritisch: fehlen sie, fehlen auf der Karte nur die
// Bozner Stationen (ohne Koordinaten kein Marker) — deshalb hier nur
// protokollieren und eine leere Map liefern.
async function fetchStationMeta(): Promise<Map<string, StationMeta>> {
  try {
    const res = await fetch(`${API_BASE}/stations`, {
      next: { revalidate: STATIONS_REVALIDATE_S },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Bozner Stationsmetadaten: Status ${res.status}`);
      return new Map();
    }
    const stations = normalizeStations(await res.json());
    return new Map(stations.map((s) => [s.SCODE, s]));
  } catch (err) {
    console.error("Bozner Stationsmetadaten nicht abrufbar:", err);
    return new Map();
  }
}

// Messwerte je Station bündeln. Nur Stationen mit Windsensoren; alle anderen
// (reine Pegel-/Temperaturstationen) fallen hier schon heraus.
function windReadingsByStation(sensors: SensorReading[]): Map<
  string,
  { direction?: SensorReading; speed?: SensorReading; gust?: SensorReading }
> {
  const byStation = new Map<string, SensorReading[]>();
  for (const s of sensors) {
    const list = byStation.get(s.SCODE);
    if (list) list.push(s);
    else byStation.set(s.SCODE, [s]);
  }
  const result = new Map<
    string,
    { direction?: SensorReading; speed?: SensorReading; gust?: SensorReading }
  >();
  for (const [code, readings] of byStation) {
    const direction = readings.find((r) => isDirection(r.DESC_D));
    const speed = readings.find((r) => isSpeed(r.DESC_D));
    if (!direction && !speed) continue;
    result.set(code, { direction, speed, gust: readings.find((r) => isGust(r.DESC_D)) });
  }
  return result;
}

function kmhOrNull(reading: SensorReading | undefined): number | null {
  return reading?.VALUE != null ? round1(toKmh(reading.VALUE, reading.UNIT)) : null;
}

/**
 * Live-Werte aller Bozner Stationen mit Windsensoren UND Koordinaten (für
 * /api/wind), im gemeinsamen WindStation-Format. Wirft, wenn /sensors nicht
 * erreichbar ist.
 */
export async function fetchBolzanoStations(): Promise<WindStation[]> {
  const [sensors, stationsByCode] = await Promise.all([fetchSensors(), fetchStationMeta()]);
  const readings = windReadingsByStation(sensors);
  const now = Date.now();
  const result: WindStation[] = [];

  for (const [code, { direction: dirReading, speed: speedReading, gust: gustReading }] of readings) {
    // Ohne Koordinaten kann kein Marker platziert werden.
    const meta = stationsByCode.get(code);
    if (!hasCoords(meta)) continue;

    const timestamp = toIsoTimestamp(speedReading?.DATE ?? dirReading?.DATE);
    const direction = dirReading?.VALUE ?? null;
    const speedKmh = kmhOrNull(speedReading);

    // Station gilt als ausgefallen, wenn Richtung oder Geschwindigkeit
    // fehlen (ohne Richtung kann kein Pfeil gezeichnet werden) oder der
    // letzte Messwert zu alt ist (STALE_AFTER_MINUTES in wind.ts).
    const measuredAt = timestamp ? Date.parse(timestamp) : NaN;
    const stale =
      direction === null || speedKmh === null || isOutdated("bolzano", measuredAt, now);

    result.push({
      stationCode: code,
      stationName: meta.NAME_D ?? meta.NAME_I ?? code,
      lat: meta.LAT != null ? round5(meta.LAT) : null,
      lng: meta.LONG != null ? round5(meta.LONG) : null,
      altitude: meta.ALT ?? null,
      direction,
      speedKmh,
      gustKmh: kmhOrNull(gustReading),
      timestamp,
      stale,
      source: "bolzano",
    });
  }
  return result;
}

/**
 * Die aktuellen Messwerte aller Bozner Stationen mit Windsensoren (für
 * /api/collect). Anders als fetchBolzanoStations bewusst OHNE die
 * Stationsmetadaten: Gespeichert wird auch dann, wenn /stations gerade nicht
 * erreichbar ist. Wirft, wenn /sensors nicht erreichbar ist.
 */
export async function fetchBolzanoReadings(): Promise<BolzanoReading[]> {
  const sensors = await fetchSensors();
  const rows: BolzanoReading[] = [];
  for (const [code, { direction: dir, speed, gust }] of windReadingsByStation(sensors)) {
    const measuredAt = toIsoTimestamp(speed?.DATE ?? dir?.DATE);
    if (!measuredAt || Number.isNaN(Date.parse(measuredAt))) continue;
    const direction = dir?.VALUE ?? null;
    const speedKmh = kmhOrNull(speed);
    if (direction === null && speedKmh === null) continue; // kein Messwert
    rows.push({ stationCode: code, measuredAt, direction, speedKmh, gustKmh: kmhOrNull(gust) });
  }
  return rows;
}
