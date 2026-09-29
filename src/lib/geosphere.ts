import type { WindStation } from "./wind";
import { SOUTH_TYROL_BBOX } from "./pioupiou";

// Gemeinsame Logik zum Abrufen der österreichischen Wetterstationen von
// GeoSphere Austria (früher ZAMG), Messnetz TAWES (teilautomatische
// Wetterstationen, 10-Minuten-Werte). Genutzt von /api/wind (Live-Anzeige)
// und /api/collect (Sammel-Route für die Historie) — nicht aber von der
// Supabase Edge Function fetch-wind-forecasts, die läuft unter Deno und
// dupliziert diese Logik dort.
//
// Datenquelle: GeoSphere Austria Data Hub, https://data.hub.geosphere.at
// (Datensatz "tawes-v1-10min"). Offene Schnittstelle ohne API-Schlüssel.
//
// Lizenz: CC BY 4.0 — die Quelle muss genannt werden. Das passiert wie bei
// den anderen Quellen über den "Quelle:"-Link im Verlaufsbalken
// (SOURCE_INFO in src/lib/wind.ts). Nicht entfernen.
//
// Welche Stationen: dieselbe Südtirol-Bounding-Box wie bei Pioupiou
// (SOUTH_TYROL_BBOX in src/lib/pioupiou.ts). Damit kommen die grenznahen
// Nord- und Osttiroler Stationen dazu (u. a. Brenner, Obergurgl, Nauders,
// Pitztaler Gletscher, Sillian) — Stand Sept. 2026 rund 15 Stück.
//
// Zwei Anfragen je Abruf:
//   1. /metadata: alle ~290 österreichischen Stationen mit Name, Koordinaten
//      und Höhe. Ändert sich praktisch nie → 6 h gecacht.
//   2. Aktuelle Messwerte nur der Stationen in der Bounding Box
//      (station_ids=…), Parameter DD (Richtung), FF (Mittelwind), FFX (Böe).
//
// Der Dienst liefert wie der Bozner Dienst immer nur den NEUESTEN
// 10-Minuten-Wert, rund 10 min nach der Messung. Der 5-Minuten-Takt von
// /api/collect passt also auch hier (siehe Begründung dort).

const API_BASE =
  process.env.GEOSPHERE_API_BASE_URL ??
  "https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min";

// Messwerte, die älter sind als diese Schwelle, gelten als ausgefallen —
// dieselbe Regel wie bei den Bozner und den Pioupiou-Stationen.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Vorangestellt an die GeoSphere-Stationsnummer, damit die Codes nicht mit
// den Bozner SCODEs kollidieren (z. B. "geosphere-11129" = Brenner).
const CODE_PREFIX = "geosphere-";

// --- Caching / Anfrage-Grenze ---
// GeoSphere erlaubt pro Absender höchstens 5 Anfragen je Sekunde und 240 je
// Stunde. Deshalb werden die Messwerte 120 s (statt 60 s wie bei Bozen und
// Pioupiou) im Next.js-Daten-Cache gehalten: /api/wind fragt so höchstens
// 30-mal pro Stunde, /api/collect 12-mal, die Edge Function 1-mal — mit viel
// Luft nach oben. Neue Werte gibt es ohnehin nur alle 10 Minuten.
const MEASUREMENTS_REVALIDATE_S = 120;
const METADATA_REVALIDATE_S = 6 * 60 * 60;

interface GeoSphereStationMeta {
  id: string;
  name?: string;
  lat?: number;
  lon?: number;
  altitude?: number;
  is_active?: boolean;
}

interface GeoSphereParameter {
  data?: Array<number | null>;
}

interface GeoSphereFeature {
  properties?: {
    station?: string;
    parameters?: Record<string, GeoSphereParameter | undefined>;
  };
}

interface GeoSphereResponse {
  timestamps?: string[];
  features?: GeoSphereFeature[];
}

function inSouthTyrolBbox(lat: number, lng: number): boolean {
  return (
    lat >= SOUTH_TYROL_BBOX.latMin &&
    lat <= SOUTH_TYROL_BBOX.latMax &&
    lng >= SOUTH_TYROL_BBOX.lngMin &&
    lng <= SOUTH_TYROL_BBOX.lngMax
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Koordinaten auf 5 Nachkommastellen kürzen (≈ 1 m) — wie bei den anderen
// Quellen, die Metadaten liefern sonst 15 Stellen.
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

// GeoSphere liefert Windgeschwindigkeiten in m/s, intern gilt km/h.
function msToKmh(value: number): number {
  return value * 3.6;
}

/**
 * GeoSphere schreibt Stationsnamen in GROSSBUCHSTABEN ("BRENNER NEU",
 * "ST.JAKOB/DEFEREGGEN"). Für die Karte werden sie in normale Schreibweise
 * gebracht: jedes Wort groß am Anfang, auch nach "/", "-", "." und "(".
 * Kleine Verbindungswörter mitten im Namen bleiben klein ("Steinach am
 * Brenner"). Ergebnis z. B. "Brenner Neu", "St.Jakob/Defereggen".
 */
const LOWERCASE_WORDS = /(?<=\s)(Am|An|Im|In|Bei|Ob)(?=\s)/g;

export function formatGeoSphereName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s/.(-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(LOWERCASE_WORDS, (w) => w.toLowerCase());
}

// Den ersten (einzigen) Wert eines Parameters lesen, oder null.
function firstValue(param: GeoSphereParameter | undefined): number | null {
  const v = param?.data?.[0];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function fetchStationsInBbox(): Promise<GeoSphereStationMeta[]> {
  const res = await fetch(`${API_BASE}/metadata`, {
    next: { revalidate: METADATA_REVALIDATE_S },
  });
  if (!res.ok) {
    throw new Error(`GeoSphere-Metadaten: Status ${res.status}`);
  }
  const body = (await res.json()) as { stations?: GeoSphereStationMeta[] };
  return (body.stations ?? []).filter(
    (s) =>
      s.is_active !== false &&
      typeof s.lat === "number" &&
      typeof s.lon === "number" &&
      inSouthTyrolBbox(s.lat, s.lon),
  );
}

/**
 * Ruft die grenznahen GeoSphere-Austria-Stationen (Bounding Box Südtirol)
 * ab, im selben WindStation-Format wie die Bozner Stationen (gleiche
 * Farbskala, gleiches stale-Verhalten, gleiche Darstellung).
 */
export async function fetchGeoSphereStations(): Promise<WindStation[]> {
  const metas = await fetchStationsInBbox();
  if (metas.length === 0) return [];

  // Nach Nummer sortiert, damit die Abfrage-Adresse (und damit der
  // Cache-Eintrag) von Lauf zu Lauf gleich bleibt.
  const ids = metas.map((m) => m.id).sort();
  const params = new URLSearchParams({
    parameters: "DD,FF,FFX",
    station_ids: ids.join(","),
  });
  const res = await fetch(`${API_BASE}?${params}`, {
    next: { revalidate: MEASUREMENTS_REVALIDATE_S },
  });
  if (!res.ok) {
    throw new Error(`GeoSphere antwortete mit Status ${res.status}`);
  }
  const body = (await res.json()) as GeoSphereResponse;

  // Alle Stationen einer Antwort teilen sich denselben Zeitstempel, z. B.
  // "2026-09-29T03:10+00:00" — hier in das übliche ISO-Format umgewandelt.
  const rawTime = body.timestamps?.[0];
  const parsed = rawTime ? Date.parse(rawTime) : NaN;
  const timestamp = Number.isNaN(parsed) ? null : new Date(parsed).toISOString();

  const byId = new Map<string, GeoSphereFeature>();
  for (const f of body.features ?? []) {
    if (f.properties?.station) byId.set(f.properties.station, f);
  }

  const now = Date.now();
  const result: WindStation[] = [];

  // Über die Metadaten laufen (nicht über die Messwerte): so erscheint auch
  // eine Station ohne aktuelle Werte — dann als grauer Punkt.
  for (const meta of metas) {
    const p = byId.get(meta.id)?.properties?.parameters;
    const direction = firstValue(p?.DD);
    const speed = firstValue(p?.FF);
    const gust = firstValue(p?.FFX);
    const speedKmh = speed !== null ? round1(msToKmh(speed)) : null;

    const stale =
      direction === null ||
      speedKmh === null ||
      Number.isNaN(parsed) ||
      now - parsed > STALE_AFTER_MS;

    result.push({
      stationCode: `${CODE_PREFIX}${meta.id}`,
      stationName: formatGeoSphereName(meta.name ?? meta.id),
      lat: round5(meta.lat!),
      lng: round5(meta.lon!),
      altitude: typeof meta.altitude === "number" ? meta.altitude : null,
      direction,
      speedKmh,
      gustKmh: gust !== null ? round1(msToKmh(gust)) : null,
      timestamp,
      stale,
      source: "geosphere",
    });
  }

  return result;
}
