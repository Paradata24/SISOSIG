import { cachedFresh } from "./freshCache";
import {
  isOutdated,
  METADATA_TIMEOUT_MS,
  SOURCE_TIMEOUT_MS,
  type WindStation,
} from "./wind";

// Windstationen von Meteotrentino (Provinz Trient, Servizio prevenzione rischi
// e Centro funzionale di protezione civile). Genutzt vom Sammler /api/collect
// und im Notbetrieb von /api/wind (Liste aller Quellen: src/lib/sources.ts).
//
// Datenquelle: der offene Webdienst https://dati.meteotrentino.it/service.asmx,
// ohne Anmeldung/Schlüssel (Nov. 2026 nachgesehen, 46 Stationen mit Wind):
//   listaStazioniJson          alle Stationen (Name, Lage, Höhe, "fine" = Datum
//                              der Stilllegung, bei laufenden Stationen leer)
//   sensoriStazioniGeoJson     je Station, welche Sensoren sie hat ("vento")
//   datiRealtimeUnaStazione    die Messwerte EINER Station der letzten h Stunden
//                              (GeoJSON, 5-Minuten-Zeilen; Wind kommt alle
//                              10 min in einer Zeile)
// Es gibt auch einen Dienst mit allen Stationen auf einmal (datiRealtime),
// der verlangt aber einen Zugangsschlüssel. Ohne Schlüssel ist es deshalb EINE
// Anfrage je Station (~46 pro Lauf, je ~15 KB); sie laufen mit begrenzter
// Gleichzeitigkeit (CONCURRENCY), damit der Dienst nicht überrannt wird.
//
// Einheiten: vvmed = Mittelwind und vvmax = Böe in m/s (→ km/h), dvmed =
// Windrichtung in Grad Nord (aus der der Wind weht). Zeitstempel wie
// "2026-11-06T15:20:00+01" (Ortszeit mit Versatz, im Sommer "+02").
// Fehlende Werte sind leere Strings.
//
// Messtakt 10 min, der Wert ist beim Abruf typisch nur wenige Minuten alt.
// Der Dienst liefert den Verlauf mit: Der Sammler nimmt wie bei SLF und DWD
// die Werte der letzten 3 h (fetchMeteoTrentinoReadingsSince), Lücken füllen
// sich so beim nächsten Lauf von selbst.
//
// Lizenz: "Creative Commons con attribuzione" (CC BY; Meteotrentino, Seite
// "OpenData", Nov. 2026). Die Nennung steht über SOURCE_INFO in src/lib/wind.ts
// im Verlaufsbalken. Nicht entfernen.
//
// Welche Stationen: alle noch laufenden mit Windsensor (derzeit 46), ohne
// Alpen-Umriss-Prüfung (Begründung bei fetchStationMeta). Eine neue Station
// beim Land erscheint also von selbst.

const API_BASE =
  process.env.METEOTRENTINO_API_BASE_URL ?? "https://dati.meteotrentino.it/service.asmx";

// Vorangestellt an den Stationscode des Landes (z. B. "T0010"), damit die
// Codes nicht kollidieren (z. B. "meteotrentino-T0010").
export const METEOTRENTINO_CODE_PREFIX = "meteotrentino-";

// Stationsliste und Sensorliste ändern sich praktisch nie.
const STATIONS_REVALIDATE_S = 6 * 60 * 60;

// Wie weit der Abruf je Station zurückreicht (Stunden). 3 h wie
// HISTORY_WINDOW_MS im Sammler; dieselbe Antwort dient auch der Karte
// (Notbetrieb), deshalb nur EIN Abruf je Station und Lauf.
const FETCH_HOURS = 3;

// Neue Werte alle 10 min; 120 s Zwischenspeicher genügen. Über cachedFresh
// (src/lib/freshCache.ts), damit nach Ablauf sofort frisch geholt wird.
const CACHE_TTL_MS = 120 * 1000;

// So viele Stationen gleichzeitig abfragen (46 Stationen → 3 Runden à ~1 s).
const CONCURRENCY = 16;

interface SiteInfo {
  codice?: string;
  nome?: string;
  quota?: number;
  latitudine?: number;
  longitudine?: number;
  fine?: string;
}

interface SensorInfo {
  staz?: string;
  vento?: string;
}

interface RealtimeFeature {
  properties?: {
    datetime?: string;
    "vvmed(m/s)"?: string;
    "vvmax(m/s)"?: string;
    "dvmed(gN)"?: string;
  };
}

/** Ein Messwert einer Station, schon in unseren Einheiten (km/h). */
export interface MeteoTrentinoReading {
  stationCode: string;
  measuredAt: string;
  direction: number | null;
  speedKmh: number | null;
  gustKmh: number | null;
}

interface StationMeta {
  code: string;
  name: string;
  lat: number;
  lng: number;
  altitude: number | null;
}

interface Loaded {
  stations: StationMeta[];
  /** Je Station die Messwerte mit Wind, aufsteigend nach Zeit. */
  readings: Map<string, MeteoTrentinoReading[]>;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** "0.5" → 0.5, "" → null. */
function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// m/s → km/h; negative Werte (Platzhalter für "kein Messwert") gelten als fehlend.
function msToKmh(value: string | undefined): number | null {
  const n = parseNumber(value);
  return n === null || n < 0 ? null : round1(n * 3.6);
}

/**
 * "2026-11-06T15:20:00+01" → ISO-Zeit in UTC. Der Versatz steht nur mit
 * Stunden ("+01"), das lesen nicht alle Umgebungen — deshalb ":00" anhängen.
 * Gibt null zurück, wenn die Zeit nicht lesbar ist.
 */
function parseMeasuredAt(value: string | undefined): string | null {
  if (!value) return null;
  const iso = value.replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

async function fetchJson<T>(path: string, timeoutMs: number, revalidateS?: number): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, {
    ...(revalidateS !== undefined ? { next: { revalidate: revalidateS } } : { cache: "no-store" }),
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit);
  if (!res.ok) throw new Error(`Meteotrentino ${path.split("?")[0]}: Status ${res.status}`);
  return (await res.json()) as T;
}

/** Alle laufenden Stationen mit Windsensor im Alpenraum. */
async function fetchStationMeta(): Promise<StationMeta[]> {
  const [list, sensors] = await Promise.all([
    fetchJson<{ sites?: SiteInfo[] }>("listaStazioniJson", METADATA_TIMEOUT_MS, STATIONS_REVALIDATE_S),
    fetchJson<{ dotazioneSensori?: SensorInfo[] }>(
      "sensoriStazioniGeoJson",
      METADATA_TIMEOUT_MS,
      STATIONS_REVALIDATE_S,
    ),
  ]);
  const hasWind = new Set(
    (sensors.dotazioneSensori ?? []).filter((s) => s.vento === "true").map((s) => s.staz),
  );

  const result: StationMeta[] = [];
  for (const s of list.sites ?? []) {
    if (!s.codice || !hasWind.has(s.codice)) continue;
    if (s.fine) continue; // stillgelegt
    if (typeof s.latitudine !== "number" || typeof s.longitudine !== "number") continue;
    // KEINE Prüfung gegen den Alpen-Umriss (isInAlps): Der ganze Landesdienst
    // liegt im Alpenraum, und der Projektbesitzer will ausdrücklich alle 46
    // Stationen (Nov. 2026). Der Umriss in alps.ts schneidet das südliche
    // Trentino ab — Torbole (Gardasee), Rovereto, Ala, Tremalzo, Malga Zugna
    // und Passo Pian delle Fugazze lägen sonst draußen.
    result.push({
      code: s.codice,
      name: s.nome ?? s.codice,
      lat: round5(s.latitudine),
      lng: round5(s.longitudine),
      altitude: typeof s.quota === "number" ? Math.round(s.quota) : null,
    });
  }
  return result;
}

/** Die Windwerte einer Station der letzten FETCH_HOURS Stunden, aufsteigend nach Zeit. */
async function fetchStationReadings(code: string): Promise<MeteoTrentinoReading[]> {
  const body = await fetchJson<{ features?: RealtimeFeature[] }>(
    `datiRealtimeUnaStazione?stazione=${encodeURIComponent(code)}&h=${FETCH_HOURS}`,
    SOURCE_TIMEOUT_MS,
  );
  const readings: MeteoTrentinoReading[] = [];
  for (const f of body.features ?? []) {
    const p = f.properties;
    const measuredAt = parseMeasuredAt(p?.datetime);
    if (!p || !measuredAt) continue;
    const direction = parseNumber(p["dvmed(gN)"]);
    const speedKmh = msToKmh(p["vvmed(m/s)"]);
    const gustKmh = msToKmh(p["vvmax(m/s)"]);
    // Die 5-Minuten-Zeilen ohne Wind (nur Temperatur/Feuchte usw.) weglassen.
    if (direction === null && speedKmh === null && gustKmh === null) continue;
    readings.push({
      stationCode: `${METEOTRENTINO_CODE_PREFIX}${code}`,
      measuredAt,
      direction: direction !== null && direction >= 0 && direction <= 360 ? round1(direction) : null,
      speedKmh,
      gustKmh,
    });
  }
  readings.sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
  return readings;
}

/** Führt `task` für alle Einträge aus, höchstens `limit` gleichzeitig. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await task(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function load(): Promise<Loaded> {
  const stations = await fetchStationMeta();
  if (stations.length === 0) throw new Error("Meteotrentino: keine Windstationen in der Liste");

  const results = await mapLimited(stations, CONCURRENCY, (s) => fetchStationReadings(s.code));
  const readings = new Map<string, MeteoTrentinoReading[]>();
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      readings.set(stations[i].code, r.value);
    } else {
      failures.push(`${stations[i].code}: ${String(r.reason)}`);
    }
  });
  // Fällt nur eine einzelne Station aus, fehlt sie in diesem Lauf — ihr letzter
  // Wert bleibt in der Datenbank stehen und wird nach der Grau-Grenze grau.
  // Fällt ALLES aus, ist die Quelle ausgefallen (gelber Hinweis auf der Karte).
  if (readings.size === 0) {
    throw new Error(`Meteotrentino: keine Station abrufbar (${failures[0] ?? "unbekannt"})`);
  }
  if (failures.length > 0) {
    console.error(`Meteotrentino: ${failures.length} Stationen nicht abrufbar:`, failures.join("; "));
  }
  return { stations, readings };
}

function loadShared(): Promise<Loaded> {
  return cachedFresh("meteotrentino:all", CACHE_TTL_MS, load);
}

/**
 * Live-Werte aller Windstationen im selben WindStation-Format wie die anderen
 * Quellen. Stationen ohne Windwert in den letzten Stunden (z. B. gerade
 * ausgefallener Sensor) erscheinen nicht — nach der Grau-Grenze stehen sie
 * über die Stationsliste der Datenbank trotzdem noch als grauer Ring da.
 */
export async function fetchMeteoTrentinoStations(): Promise<WindStation[]> {
  const { stations, readings } = await loadShared();
  const now = Date.now();
  const result: WindStation[] = [];

  for (const s of stations) {
    const list = readings.get(s.code);
    if (!list || list.length === 0) continue;
    const latest = list[list.length - 1];

    // Ausgefallen wie bei allen Quellen (STALE_AFTER_MINUTES in wind.ts); ohne
    // Richtung oder Geschwindigkeit lässt sich kein Pfeil zeichnen.
    const stale =
      latest.direction === null ||
      latest.speedKmh === null ||
      isOutdated("meteotrentino", Date.parse(latest.measuredAt), now);

    result.push({
      stationCode: latest.stationCode,
      stationName: s.name,
      lat: s.lat,
      lng: s.lng,
      altitude: s.altitude,
      direction: latest.direction,
      speedKmh: latest.speedKmh,
      gustKmh: latest.gustKmh,
      timestamp: latest.measuredAt,
      stale,
      source: "meteotrentino",
    });
  }
  return result;
}

/** Alle Messwerte ab `sinceMs` (für /api/collect, siehe Kopf der Datei). */
export async function fetchMeteoTrentinoReadingsSince(
  sinceMs: number,
): Promise<MeteoTrentinoReading[]> {
  const { readings } = await loadShared();
  const rows: MeteoTrentinoReading[] = [];
  for (const list of readings.values()) {
    for (const r of list) {
      if (Date.parse(r.measuredAt) >= sinceMs) rows.push(r);
    }
  }
  return rows;
}
