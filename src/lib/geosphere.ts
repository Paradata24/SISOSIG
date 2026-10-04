import type { WindStation } from "./wind";

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
// Welche Stationen: nur die im ALPENRAUM (Wunsch des Projektbesitzers,
// Okt. 2026: "nur dort, wo Berge sind") — rund 190 von ~290. Anfangs waren es
// nur die grenznahen Stationen innerhalb der Südtirol-Bounding-Box, im Sept.
// 2026 dann alle Österreichs; das brachte viele Stationen im Flachland
// (Wien, Burgenland, Weinviertel, Donauraum, Mühl-/Waldviertel) ohne Nutzen
// für Gleitschirmflieger. Die Regel steht in isInAlps() weiter unten.
// Stationen ganz ohne Windwerte (reine Temperatur-/Niederschlagsstationen,
// rund ein Dutzend) werden ausgelassen, wie beim Bozner Dienst.
//
// Zwei Anfragen je Abruf:
//   1. /metadata: alle ~290 österreichischen Stationen mit Name, Koordinaten
//      und Höhe (danach auf den Alpenraum gefiltert). Ändert sich praktisch
//      nie → 6 h gecacht.
//   2. Aktuelle Messwerte aller aktiven Stationen (station_ids=… ist
//      Pflicht, die Schnittstelle kennt kein "alle"), Parameter DD
//      (Richtung), FF (Mittelwind), FFX (Böe).
//
// ACHTUNG Antwortformat: Die Antwort enthält MEHRERE Zeitpunkte, sobald
// einzelne Stationen hinterherhinken (z. B. eine seit Wochen ausgefallene
// Station). "timestamps" ist dann die Vereinigung aller Zeitpunkte, und jede
// Station hat je Zeitpunkt einen Wert (meist null). Je Station gilt deshalb
// der LETZTE Zeitpunkt, zu dem sie einen Windwert hat.
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

// Wert eines Parameters zum Zeitpunkt Nummer `idx` lesen, oder null.
function valueAt(param: GeoSphereParameter | undefined, idx: number): number | null {
  const v = param?.data?.[idx];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Grober Umriss des österreichischen Alpenraums als Vieleck aus
// [Länge, Breite]-Punkten. Drin sind die Alpen samt Talböden (Innsbruck,
// Salzburg, Klagenfurt, Villach, Graz, Bregenz …) und dem Alpenrand
// (Gmunden/Traunsee, Waidhofen/Ybbs, Hohe Wand, Semmering); draußen sind
// Alpenvorland, Donauraum, Wien, Burgenland, Weinviertel, Böhmische Masse
// (Mühl-/Waldviertel) und das Südost-Hügelland der Steiermark. Der Süden und
// Westen liegen außerhalb Österreichs und schneiden deshalb nichts ab.
// Am 04.10.2026 gegen alle 286 aktiven Stationen geprüft: 191 drin, 95 draußen;
// alle Windanzeiger-Stationen (WINDANZEIGER_STATION_CODES) bleiben drin.
//
// ACHTUNG: Die Edge Function fetch-wind-forecasts hat eine Kopie dieses
// Vielecks (Deno kann nicht aus src/ importieren) — bei Änderungen beide
// anfassen, sonst gibt es Prognosen für Stationen, die gar nicht mehr
// angezeigt werden (oder umgekehrt Stationen ohne Prognose).
const ALPS_POLYGON: Array<[number, number]> = [
  [9.4, 46.3],
  [9.4, 47.75],
  [12.0, 47.75],
  [13.2, 48.0],
  [13.8, 48.0],
  [14.2, 47.95],
  [14.9, 48.0],
  [15.6, 48.05],
  [15.9, 48.0],
  [16.06, 47.9],
  [16.06, 47.45],
  [15.75, 47.3],
  [15.55, 47.0],
  [15.35, 46.6],
  [15.3, 46.3],
];

// Punkt-im-Vieleck-Test (Strahlverfahren): zählt, wie oft ein Strahl nach
// Osten die Vieleck-Kanten kreuzt — ungerade Anzahl heißt "drin".
export function isInAlps(lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = ALPS_POLYGON.length - 1; i < ALPS_POLYGON.length; j = i++) {
    const [xi, yi] = ALPS_POLYGON[i];
    const [xj, yj] = ALPS_POLYGON[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

async function fetchActiveStations(): Promise<GeoSphereStationMeta[]> {
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
      isInAlps(s.lat, s.lon),
  );
}

/**
 * Ruft die GeoSphere-Austria-Stationen im Alpenraum mit Windmessung ab, im selben WindStation-Format wie die Bozner Stationen (gleiche
 * Farbskala, gleiches stale-Verhalten, gleiche Darstellung).
 */
export async function fetchGeoSphereStations(): Promise<WindStation[]> {
  const metas = await fetchActiveStations();
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

  // Zeitpunkte einmal umwandeln, z. B. "2026-09-29T03:10+00:00" → Epoch-ms.
  const times = (body.timestamps ?? []).map((t) => Date.parse(t));

  const byId = new Map<string, GeoSphereFeature>();
  for (const f of body.features ?? []) {
    if (f.properties?.station) byId.set(f.properties.station, f);
  }

  const now = Date.now();
  const result: WindStation[] = [];

  for (const meta of metas) {
    const p = byId.get(meta.id)?.properties?.parameters;

    // Letzter Zeitpunkt mit Richtung ODER Mittelwind (siehe "ACHTUNG
    // Antwortformat" oben). Keiner gefunden → Station misst keinen Wind
    // und wird ausgelassen.
    let idx = times.length - 1;
    while (idx >= 0 && valueAt(p?.DD, idx) === null && valueAt(p?.FF, idx) === null) {
      idx--;
    }
    if (idx < 0 || Number.isNaN(times[idx])) continue;

    const direction = valueAt(p?.DD, idx);
    const speed = valueAt(p?.FF, idx);
    const gust = valueAt(p?.FFX, idx);
    const speedKmh = speed !== null ? round1(msToKmh(speed)) : null;
    const measuredAt = times[idx];

    // Eine ausgefallene Station (letzter Wert älter als 2 h) erscheint als
    // grauer Punkt, genau wie bei den anderen Quellen.
    const stale =
      direction === null || speedKmh === null || now - measuredAt > STALE_AFTER_MS;

    result.push({
      stationCode: `${CODE_PREFIX}${meta.id}`,
      stationName: formatGeoSphereName(meta.name ?? meta.id),
      lat: round5(meta.lat!),
      lng: round5(meta.lon!),
      altitude: typeof meta.altitude === "number" ? meta.altitude : null,
      direction,
      speedKmh,
      gustKmh: gust !== null ? round1(msToKmh(gust)) : null,
      timestamp: new Date(measuredAt).toISOString(),
      stale,
      source: "geosphere",
    });
  }

  return result;
}
