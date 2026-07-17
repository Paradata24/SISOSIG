import type { WindStation } from "./wind";

// Gemeinsame Logik zum Abrufen der Südtiroler OpenWindMap-Stationen
// (Pioupiou-Netzwerk). Genutzt von /api/wind (Live-Anzeige) und
// /api/collect (Sammel-Route für die Historie) — nicht aber von der
// Supabase Edge Function fetch-wind-forecasts, die läuft unter Deno und
// dupliziert diese Logik dort (siehe Kommentar in dieser Datei am Ende).
//
// Endpunkt: https://api.pioupiou.fr/v1/live/all liefert ALLE Stationen
// weltweit ohne Regionsfilter — Südtirol wird über eine grobe Bounding Box
// herausgefiltert (siehe SOUTH_TYROL_BBOX unten).
//
// Lizenz: Die Daten stehen unter der kostenlosen OpenWindMap-Community-
// Lizenz, die einen sichtbaren Credit verlangt (siehe Fußzeile auf der
// Seite, src/app/page.tsx).

const API_BASE =
  process.env.PIOUPIOU_API_BASE_URL ?? "https://api.pioupiou.fr/v1";

// Grobe Bounding Box Südtirol (Näherungswerte laut Projektbesitzer, bei
// Bedarf hier nachjustieren).
export const SOUTH_TYROL_BBOX = {
  latMin: 46.2,
  latMax: 47.1,
  lngMin: 10.3,
  lngMax: 12.5,
};

// Messwerte, die älter sind als diese Schwelle, gelten als ausgefallen —
// dieselbe Regel wie bei den Bozner Stationen (siehe /api/wind). Pioupiou-
// Stationen sind batteriebetrieben und melden nachts/windstill teils gar
// nicht, fallen dann also nach 2h ebenfalls auf den grauen "stale"-Punkt
// zurück statt mit einem veralteten Pfeil angezeigt zu werden.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Vorangestellt an die Pioupiou-Stations-ID, damit die Stationscodes nicht
// mit den Bozner SCODEs kollidieren (z. B. "pioupiou-413").
const CODE_PREFIX = "pioupiou-";

// Der Abruf wird 60 s im Next.js-Daten-Cache gehalten (gleiche Dauer wie
// die Bozner Messwerte in /api/wind, siehe dort). Die Pioupiou-Stationen
// melden ohnehin nur alle paar Minuten. Auch für /api/collect (läuft nur
// alle 10 Minuten) sind bis zu 60 s alte Werte unschädlich: gespeichert
// wird der Mess-Zeitstempel der Station, Duplikate fängt der Upsert ab.
const REVALIDATE_S = 60;

interface PioupiouStation {
  id: number;
  meta?: { name?: string };
  location?: {
    latitude?: number;
    longitude?: number;
    success?: boolean;
  };
  measurements?: {
    date?: string;
    wind_heading?: number;
    wind_speed_avg?: number;
    wind_speed_max?: number;
  };
}

function inSouthTyrolBbox(lat: number, lng: number): boolean {
  return (
    lat >= SOUTH_TYROL_BBOX.latMin &&
    lat <= SOUTH_TYROL_BBOX.latMax &&
    lng >= SOUTH_TYROL_BBOX.lngMin &&
    lng <= SOUTH_TYROL_BBOX.lngMax
  );
}

// INTERNE EINHEIT: km/h (wie bei den Bozner Stationen). Laut Pioupiou-
// API-Doku (developers.pioupiou.fr) liefert wind_speed_avg/-max bereits
// km/h — hier ist also keine Umrechnung nötig. Die Werte laufen trotzdem
// durch diese eine Funktion, damit eine Korrektur (falls sich das als
// falsch herausstellt) nur an einer Stelle nötig wäre.
function toKmh(valueKmh: number): number {
  return valueKmh;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Ruft alle Pioupiou/OpenWindMap-Stationen ab und gibt nur jene innerhalb
 * der Südtirol-Bounding-Box mit gültigen Koordinaten zurück, im selben
 * WindStation-Format wie die Bozner Stationen (gleiche Farbskala, gleiches
 * stale-Verhalten, gleiche Karten-/Verlaufsbalken-Darstellung).
 */
export async function fetchOpenWindMapStations(): Promise<WindStation[]> {
  const res = await fetch(`${API_BASE}/live/all`, {
    next: { revalidate: REVALIDATE_S },
  });
  if (!res.ok) {
    throw new Error(`OpenWindMap antwortete mit Status ${res.status}`);
  }
  const body: unknown = await res.json();
  const stations: PioupiouStation[] = Array.isArray(body)
    ? (body as PioupiouStation[])
    : ((body as { data?: PioupiouStation[] })?.data ?? []);

  const now = Date.now();
  const result: WindStation[] = [];

  for (const s of stations) {
    const loc = s.location;
    if (
      !loc?.success ||
      typeof loc.latitude !== "number" ||
      typeof loc.longitude !== "number" ||
      !inSouthTyrolBbox(loc.latitude, loc.longitude)
    ) {
      continue;
    }

    const m = s.measurements;
    const timestamp = m?.date ?? null;
    const direction = m?.wind_heading ?? null;
    const speedKmh =
      m?.wind_speed_avg != null ? round1(toKmh(m.wind_speed_avg)) : null;
    const gustKmh =
      m?.wind_speed_max != null ? round1(toKmh(m.wind_speed_max)) : null;

    const measuredAt = timestamp ? Date.parse(timestamp) : NaN;
    const stale =
      direction === null ||
      speedKmh === null ||
      Number.isNaN(measuredAt) ||
      now - measuredAt > STALE_AFTER_MS;

    result.push({
      stationCode: `${CODE_PREFIX}${s.id}`,
      stationName: s.meta?.name ?? `Pioupiou ${s.id}`,
      lat: loc.latitude,
      lng: loc.longitude,
      altitude: null,
      direction,
      speedKmh,
      gustKmh,
      timestamp,
      stale,
      source: "openwindmap",
    });
  }

  return result;
}
