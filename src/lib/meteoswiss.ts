import type { WindStation } from "./wind";

// Gemeinsame Logik zum Abrufen der automatischen Messstationen von MeteoSchweiz
// (Bundesamt für Meteorologie und Klimatologie, Netz "SwissMetNet"/SMN, rund
// 150 Stationen mit Windmessung, darunter alle Gipfel- und Passstationen wie
// Säntis, Pilatus oder Jungfraujoch). Genutzt von /api/wind (Live-Anzeige) und
// /api/collect (Sammel-Route für die Historie) — nicht aber von der Supabase
// Edge Function fetch-wind-forecasts: Für diese Stationen gibt es (noch) keine
// Prognose-Kurve, siehe README.
//
// Datenquelle: Open Government Data von MeteoSchweiz, ohne Anmeldung/Schlüssel.
// Zwei Dateien je Abruf, beide über data.geo.admin.ch:
//   1. messwerte-aktuell/VQHA80.csv: die JÜNGSTEN 10-Minuten-Werte ALLER
//      Stationen in EINER Datei (klein, ~16 KB). Wind steht in
//        dkl010z0  Windrichtung (Grad)
//        fu3010z0  Mittelwind, Zehnminutenmittel (km/h)
//        fu3010z1  Böe, Zehnminutenmaximum (km/h)
//      Der Zeitstempel (Spalte "Date", z. B. 202609290850) ist UTC.
//   2. ogd-smn/ogd-smn_meta_stations.csv: Name, Koordinaten und Höhe je
//      Station. Ändert sich praktisch nie → 6 h gecacht.
//
// Wie beim Bozner und beim GeoSphere-Dienst liefert die Datei immer nur den
// NEUESTEN Wert (rund 10 min nach der Messung) — der 5-Minuten-Takt von
// /api/collect passt also auch hier (siehe Begründung dort). Einzelne Lücken
// werden im Verlaufsbalken überbrückt (measurementGapMs in wind.ts).
//
// Die Stationen werden bewusst über ihr KÜRZEL angesprochen ("SAE" = Säntis),
// nicht über den Namen: Der Windanzeiger-Filter in wind.ts benutzt für diese
// Quelle Stationscodes (z. B. "meteoswiss-SAE"), weil Namen kollidieren können
// (SLF "Titlisboden" enthält "Titlis").
//
// Quellenangabe (Pflicht): "Quelle: MeteoSchweiz" — steht über SOURCE_INFO in
// src/lib/wind.ts im Verlaufsbalken. Nicht entfernen.

const CURRENT_URL =
  process.env.METEOSWISS_CURRENT_URL ??
  "https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv";
const META_URL =
  process.env.METEOSWISS_META_URL ??
  "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv";

// Vorangestellt an das MeteoSchweiz-Kürzel, damit die Codes nicht mit den
// Bozner SCODEs, SLF-Codes ("slf-...") usw. kollidieren.
export const METEOSWISS_CODE_PREFIX = "meteoswiss-";

// Wie bei den anderen Quellen: Messwerte älter als 2 h gelten als ausgefallen.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Neue Werte kommen alle 10 Minuten; 120 s Cache halten die Zahl der Abrufe
// niedrig (/api/wind ≤ 30 pro Stunde), ohne die Anzeige spürbar zu verzögern.
const MEASUREMENTS_REVALIDATE_S = 120;
const METADATA_REVALIDATE_S = 6 * 60 * 60;

interface MeteoSwissMeta {
  code: string;
  name: string;
  lat: number;
  lng: number;
  altitude: number | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

// Die Stationsliste kommt (Stand Sept. 2026) in ISO-8859-1 ("Säntis" als ein
// Byte), die Messwerte in reinem ASCII. Falls MeteoSchweiz irgendwann auf
// UTF-8 umstellt, soll das nicht zu kaputten Umlauten führen: erst UTF-8
// versuchen (schlägt bei ISO-8859-1-Umlauten fehl), dann ISO-8859-1.
function decodeText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("latin1").decode(buffer);
  }
}

// Semikolon-getrennte Tabelle → Zeilen mit den Spaltennamen als Schlüssel.
// Die MeteoSchweiz-Dateien enthalten keine Anführungszeichen, ein einfaches
// Zerlegen genügt also. Ein "-" steht für "kein Wert".
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = lines[0].split(";");
  return lines.slice(1).map((line) => {
    const cells = line.split(";");
    const row: Record<string, string> = {};
    header.forEach((name, i) => {
      row[name] = cells[i] ?? "";
    });
    return row;
  });
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "-") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// "202609290850" (UTC) → Epoch-ms, oder NaN.
function parseTimestamp(value: string | undefined): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value ?? "");
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

async function fetchMeta(): Promise<Map<string, MeteoSwissMeta>> {
  const res = await fetch(META_URL, { next: { revalidate: METADATA_REVALIDATE_S } });
  if (!res.ok) throw new Error(`MeteoSchweiz-Stationsliste: Status ${res.status}`);
  const rows = parseCsv(decodeText(await res.arrayBuffer()));
  const byCode = new Map<string, MeteoSwissMeta>();
  for (const r of rows) {
    const code = r["station_abbr"];
    const lat = numberOrNull(r["station_coordinates_wgs84_lat"]);
    const lng = numberOrNull(r["station_coordinates_wgs84_lon"]);
    if (!code || lat === null || lng === null) continue;
    byCode.set(code, {
      code,
      name: r["station_name"] || code,
      lat,
      lng,
      altitude: numberOrNull(r["station_height_masl"]),
    });
  }
  return byCode;
}

/**
 * Live-Werte aller MeteoSchweiz-Stationen mit Windmessung, im selben
 * WindStation-Format wie die anderen Quellen. Stationen ohne jeden Windwert
 * (reine Temperatur-/Niederschlagsstationen) und Stationen ohne Eintrag in der
 * Stationsliste (kein Standort) erscheinen nicht.
 */
export async function fetchMeteoSwissStations(): Promise<WindStation[]> {
  const [meta, res] = await Promise.all([
    fetchMeta(),
    fetch(CURRENT_URL, { next: { revalidate: MEASUREMENTS_REVALIDATE_S } }),
  ]);
  if (!res.ok) throw new Error(`MeteoSchweiz-Messwerte: Status ${res.status}`);
  const rows = parseCsv(decodeText(await res.arrayBuffer()));

  const now = Date.now();
  const result: WindStation[] = [];

  for (const r of rows) {
    const abbr = r["Station/Location"];
    const station = abbr ? meta.get(abbr) : undefined;
    if (!station) continue;

    const direction = numberOrNull(r["dkl010z0"]);
    const speedKmh = numberOrNull(r["fu3010z0"]);
    const gustKmh = numberOrNull(r["fu3010z1"]);
    if (direction === null && speedKmh === null && gustKmh === null) continue;

    const measuredAt = parseTimestamp(r["Date"]);
    const stale =
      direction === null ||
      speedKmh === null ||
      Number.isNaN(measuredAt) ||
      now - measuredAt > STALE_AFTER_MS;

    result.push({
      stationCode: `${METEOSWISS_CODE_PREFIX}${abbr}`,
      stationName: station.name,
      lat: round5(station.lat),
      lng: round5(station.lng),
      altitude: station.altitude !== null ? Math.round(station.altitude) : null,
      direction,
      speedKmh: speedKmh !== null ? round1(speedKmh) : null,
      gustKmh: gustKmh !== null ? round1(gustKmh) : null,
      timestamp: Number.isNaN(measuredAt) ? null : new Date(measuredAt).toISOString(),
      stale,
      source: "meteoswiss",
    });
  }
  return result;
}
