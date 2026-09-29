import { inflateRawSync } from "node:zlib";
import type { WindStation } from "./wind";

// Ausgewählte Messstationen des Deutschen Wetterdienstes (DWD) — derzeit nur
// die Zugspitze (Föhnindikator für Tirol, Wunsch des Projektbesitzers).
// Genutzt von /api/wind (Live-Anzeige) und /api/collect (Sammel-Route für die
// Historie) — nicht aber von der Supabase Edge Function fetch-wind-forecasts
// (für diese Station gibt es keine Prognose-Kurve, siehe README).
//
// Datenquelle: DWD Open Data (https://opendata.dwd.de), ohne Anmeldung.
// Je Station zwei kleine ZIP-Dateien mit den 10-Minuten-Werten der letzten
// ~24 h (Verzeichnis ".../climate/10_minutes/<Datensatz>/now/"):
//   wind/now/10minutenwerte_wind_<ID>_now.zip
//       FF_10 Mittelwind (m/s), DD_10 Windrichtung (Grad)
//   extreme_wind/now/10minutenwerte_extrema_wind_<ID>_now.zip
//       FX_10 Böe = Maximum der letzten 10 min (m/s)
// Fehlende Werte sind als -999 eingetragen; Zeitstempel (MESS_DATUM, z. B.
// 202609250700) sind UTC. Die ZIP-Dateien enthalten je genau eine Textdatei.
//
// ACHTUNG Ausfall: Nachgeprüft im Sept. 2026 — die Zugspitze lieferte zuletzt
// am 25.09.2026 Werte (in der DWD-Stationsliste steht als Enddatum 25.09.2026;
// alle anderen Stationen werden weiter aktualisiert). Solange DWD keine neuen
// Werte veröffentlicht, ist die Station grau ("ausgefallen", letzter Wert älter
// als 2 h) — das ist KEIN Fehler dieser Datei.
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

// Messwerte älter als 2 h gelten als ausgefallen (wie bei den anderen Quellen).
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Neue Werte alle 10 Minuten; 120 s Cache genügen.
const REVALIDATE_S = 120;

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

async function fetchZipText(url: string): Promise<string> {
  const res = await fetch(url, { next: { revalidate: REVALIDATE_S } });
  if (!res.ok) throw new Error(`DWD antwortete mit Status ${res.status} (${url})`);
  return readFirstZipEntry(Buffer.from(await res.arrayBuffer()));
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

async function fetchStation(id: string, info: DwdStationInfo): Promise<WindStation | null> {
  const [windText, extremaText] = await Promise.all([
    fetchZipText(`${CDC_BASE}/wind/now/10minutenwerte_wind_${id}_now.zip`),
    // Die Böen sind ein Zusatz: fehlt die Datei, bleibt die Station trotzdem
    // mit Mittelwind und Richtung sichtbar.
    fetchZipText(`${CDC_BASE}/extreme_wind/now/10minutenwerte_extrema_wind_${id}_now.zip`).catch(
      () => "",
    ),
  ]);

  const wind = parseRows(windText, ["FF_10", "DD_10"]);
  const gustAt = new Map<number, number>();
  for (const r of parseRows(extremaText, ["FX_10"])) gustAt.set(r.measuredAt, r.values[0]);

  // Jüngste Zeile, die überhaupt einen Windwert hat.
  let latest: DwdRow | null = null;
  for (const r of wind) {
    if (Number.isNaN(r.values[0]) && Number.isNaN(r.values[1])) continue;
    if (!latest || r.measuredAt > latest.measuredAt) latest = r;
  }
  if (!latest) return null;

  const [speed, direction] = latest.values;
  const gust = gustAt.get(latest.measuredAt);
  const speedKmh = Number.isNaN(speed) ? null : msToKmh(speed);
  const dir = Number.isNaN(direction) ? null : direction;
  const stale =
    dir === null || speedKmh === null || Date.now() - latest.measuredAt > STALE_AFTER_MS;

  return {
    stationCode: `${DWD_CODE_PREFIX}${id}`,
    stationName: info.name,
    lat: info.lat,
    lng: info.lng,
    altitude: info.altitude,
    direction: dir,
    speedKmh,
    gustKmh: gust === undefined || Number.isNaN(gust) ? null : msToKmh(gust),
    timestamp: new Date(latest.measuredAt).toISOString(),
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
