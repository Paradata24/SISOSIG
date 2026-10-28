import { inflateRawSync } from "node:zlib";
import { isOutdated, SOURCE_TIMEOUT_MS, type WindStation } from "./wind";
import { cachedFresh } from "./freshCache";

// Ausgewählte Messstationen des Deutschen Wetterdienstes (DWD) — derzeit nur
// die Zugspitze (Föhnindikator für Tirol, Wunsch des Projektbesitzers).
// Genutzt von /api/wind (Live-Anzeige) und /api/collect (Sammel-Route für die
// Historie) — nicht aber von der Supabase Edge Function fetch-wind-forecasts
// (für diese Station gibt es keine Prognose-Kurve, siehe README).
//
// Datenquelle: DWD Open Data (https://opendata.dwd.de), ohne Anmeldung.
// Je Station zwei kleine ZIP-Dateien mit ALLEN 10-Minuten-Werten des
// laufenden Tages (Verzeichnis ".../climate/10_minutes/<Datensatz>/now/"):
//   wind/now/10minutenwerte_wind_<ID>_now.zip
//       FF_10 Mittelwind (m/s), DD_10 Windrichtung (Grad)
//   extreme_wind/now/10minutenwerte_extrema_wind_<ID>_now.zip
//       FX_10 Böe = Maximum der letzten 10 min (m/s)
// Fehlende Werte sind als -999 eingetragen; Zeitstempel (MESS_DATUM, z. B.
// 202609250700) sind UTC. Die ZIP-Dateien enthalten je genau eine Textdatei.
//
// TAKT: Der DWD erneuert die Dateien nur alle 30 Minuten (im Okt. 2026
// nachgeprüft); jede neue Fassung bringt drei neue 10-Minuten-Werte, der
// jüngste ist dann schon 25–30 min alt. Deshalb nimmt /api/collect nicht nur
// den neuesten Wert, sondern alle der letzten Stunden
// (fetchDwdReadingsSince) — vorher landete nur jeder dritte Wert in der
// Datenbank, und im Verlaufsbalken fehlte die Kurve. Grau wird die Station
// entsprechend später als andere (STALE_AFTER_MINUTES in wind.ts).
//
// Zur Zugspitze: Ab dem 25.09.2026 lieferte sie eine Zeit lang keine Werte
// (Ausfall beim DWD, kein Fehler dieser Datei); spätestens seit dem
// 25.10.2026 wieder.
//
// Lizenz/Quellenangabe: "Datenbasis: Deutscher Wetterdienst" — steht über
// SOURCE_INFO in src/lib/wind.ts im Verlaufsbalken. Nicht entfernen.
//
// Welche Stationen: nur die in DWD_STATIONS. Weitere hinzufügen: Stations-ID,
// Koordinaten und Höhe stehen in der Datei zehn_now_ff_Beschreibung_Stationen.txt
// im wind/now-Verzeichnis.

const CDC_BASE =
  process.env.DWD_CDC_BASE_URL ??
  "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/10_minutes";

// Vorangestellt an die DWD-Stations-ID, damit die Codes nicht kollidieren
// (z. B. "dwd-05792" = Zugspitze).
export const DWD_CODE_PREFIX = "dwd-";

interface DwdStationInfo {
  name: string;
  lat: number;
  lng: number;
  altitude: number;
}

/**
 * Die abgerufenen Stationen, Schlüssel = DWD-Stations-ID (fünfstellig).
 * Koordinaten und Höhe laut DWD-Stationsliste (Sept. 2026).
 */
export const DWD_STATIONS: Record<string, DwdStationInfo> = {
  "05792": { name: "Zugspitze", lat: 47.421, lng: 10.9848, altitude: 2956 },
};

// Neue Werte alle 10 Minuten; 120 s Cache genügen. Über cachedFresh
// (src/lib/freshCache.ts), damit nach Ablauf sofort frisch geholt wird.
const CACHE_TTL_MS = 120 * 1000;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// m/s → km/h
function msToKmh(value: number): number {
  return round1(value * 3.6);
}

/**
 * Liest die (einzige) Datei aus einem ZIP-Archiv und gibt ihren Text zurück.
 * Ein eigener kleiner Leser statt einer Bibliothek: Die DWD-Archive sind
 * einfach aufgebaut (eine Datei, Standard-"deflate"-Kompression), und so
 * kommt keine zusätzliche Abhängigkeit ins Projekt. Es wird das Inhaltsver-
 * zeichnis am Dateiende gelesen, weil die Größenangaben im Kopf der Datei
 * bei manchen ZIPs fehlen (Bit 3 "Data Descriptor").
 */
function readFirstZipEntry(zip: Buffer): string {
  // Ende-Kennung "PK\x05\x06" von hinten suchen (danach folgt höchstens ein
  // Kommentar).
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Kein gültiges ZIP-Archiv");

  const centralDirOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(centralDirOffset) !== 0x02014b50) {
    throw new Error("ZIP-Inhaltsverzeichnis nicht lesbar");
  }
  const method = zip.readUInt16LE(centralDirOffset + 10);
  const compressedSize = zip.readUInt32LE(centralDirOffset + 20);
  const localHeaderOffset = zip.readUInt32LE(centralDirOffset + 42);

  if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error("ZIP-Dateikopf nicht lesbar");
  }
  const nameLen = zip.readUInt16LE(localHeaderOffset + 26);
  const extraLen = zip.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLen + extraLen;
  const data = zip.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return data.toString("latin1");
  if (method === 8) return inflateRawSync(data).toString("latin1");
  throw new Error(`ZIP-Kompression ${method} wird nicht unterstützt`);
}

function fetchZipText(url: string): Promise<string> {
  return cachedFresh(url, CACHE_TTL_MS, async () => {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DWD antwortete mit Status ${res.status} (${url})`);
    return readFirstZipEntry(Buffer.from(await res.arrayBuffer()));
  });
}

interface DwdRow {
  measuredAt: number;
  values: number[];
}

// Semikolon-getrennt, Kopfzeile "STATIONS_ID;MESS_DATUM;QN;FF_10;DD_10;eor".
// Liefert je Zeile den Zeitpunkt (UTC, Epoch-ms) und die Werte der gewünschten
// Spalten; -999 (= kein Wert) wird zu NaN.
function parseRows(text: string, columns: string[]): DwdRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = lines[0].split(";").map((h) => h.trim());
  const timeIdx = header.indexOf("MESS_DATUM");
  const idx = columns.map((c) => header.indexOf(c));
  if (timeIdx < 0 || idx.some((i) => i < 0)) return [];

  const rows: DwdRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(";").map((c) => c.trim());
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(cells[timeIdx] ?? "");
    if (!m) continue;
    rows.push({
      measuredAt: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]),
      values: idx.map((i) => {
        const n = Number(cells[i]);
        return Number.isFinite(n) && n !== -999 ? n : NaN;
      }),
    });
  }
  return rows;
}

/** Ein Messwert einer DWD-Station, schon in unseren Einheiten (km/h). */
export interface DwdReading {
  stationCode: string;
  measuredAt: string;
  direction: number | null;
  speedKmh: number | null;
  gustKmh: number | null;
}

// Alle Werte des laufenden Tages einer Station, die überhaupt einen Windwert
// haben, aufsteigend nach Zeit — samt Böe aus der zweiten Datei.
async function loadStationReadings(id: string): Promise<DwdReading[]> {
  const [windText, extremaText] = await Promise.all([
    fetchZipText(`${CDC_BASE}/wind/now/10minutenwerte_wind_${id}_now.zip`),
    // Die Böen sind ein Zusatz: fehlt die Datei, bleibt die Station trotzdem
    // mit Mittelwind und Richtung sichtbar.
    fetchZipText(`${CDC_BASE}/extreme_wind/now/10minutenwerte_extrema_wind_${id}_now.zip`).catch(
      () => "",
    ),
  ]);

  const gustAt = new Map<number, number>();
  for (const r of parseRows(extremaText, ["FX_10"])) gustAt.set(r.measuredAt, r.values[0]);

  const readings: DwdReading[] = [];
  const rows = parseRows(windText, ["FF_10", "DD_10"]).sort((a, b) => a.measuredAt - b.measuredAt);
  for (const r of rows) {
    const [speed, direction] = r.values;
    if (Number.isNaN(speed) && Number.isNaN(direction)) continue;
    const gust = gustAt.get(r.measuredAt);
    readings.push({
      stationCode: `${DWD_CODE_PREFIX}${id}`,
      measuredAt: new Date(r.measuredAt).toISOString(),
      direction: Number.isNaN(direction) ? null : direction,
      speedKmh: Number.isNaN(speed) ? null : msToKmh(speed),
      gustKmh: gust === undefined || Number.isNaN(gust) ? null : msToKmh(gust),
    });
  }
  return readings;
}

async function fetchStation(id: string, info: DwdStationInfo): Promise<WindStation | null> {
  // Jüngste Zeile, die überhaupt einen Windwert hat.
  const latest = (await loadStationReadings(id)).at(-1);
  if (!latest) return null;

  const stale =
    latest.direction === null ||
    latest.speedKmh === null ||
    isOutdated("dwd", Date.parse(latest.measuredAt), Date.now());

  return {
    stationCode: latest.stationCode,
    stationName: info.name,
    lat: info.lat,
    lng: info.lng,
    altitude: info.altitude,
    direction: latest.direction,
    speedKmh: latest.speedKmh,
    gustKmh: latest.gustKmh,
    timestamp: latest.measuredAt,
    stale,
    source: "dwd",
  };
}

/**
 * Live-Werte der ausgewählten DWD-Stationen (siehe DWD_STATIONS). Eine Station,
 * deren Abruf scheitert, fehlt im Ergebnis — sie reißt die anderen nicht mit.
 */
export async function fetchDwdStations(): Promise<WindStation[]> {
  const results = await Promise.all(
    Object.entries(DWD_STATIONS).map(([id, info]) =>
      fetchStation(id, info).catch((err) => {
        console.error(`DWD-Station ${id} nicht abrufbar:`, err);
        return null;
      }),
    ),
  );
  return results.filter((s): s is WindStation => s !== null);
}

/**
 * Alle Messwerte der ausgewählten DWD-Stationen ab `sinceMs` (für
 * /api/collect), nicht nur der neueste — siehe "TAKT" oben. Doppelte fängt
 * die Datenbank ab. Eine Station, deren Abruf scheitert, fehlt im Ergebnis.
 */
export async function fetchDwdReadingsSince(sinceMs: number): Promise<DwdReading[]> {
  const results = await Promise.all(
    Object.keys(DWD_STATIONS).map((id) =>
      loadStationReadings(id).catch((err) => {
        console.error(`DWD-Station ${id} nicht abrufbar:`, err);
        return [];
      }),
    ),
  );
  return results.flat().filter((r) => Date.parse(r.measuredAt) >= sinceMs);
}
