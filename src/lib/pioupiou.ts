import { isInAlps } from "./alps";
import { isOutdated, SOURCE_TIMEOUT_MS, type WindStation } from "./wind";
import { cachedFresh } from "./freshCache";

// Gemeinsame Logik zum Abrufen der OpenWindMap-Stationen (Pioupiou-Netzwerk)
// im Alpenraum. Genutzt von /api/wind (Live-Anzeige) und /api/collect
// (Sammel-Route für die Historie) — nicht aber von der Supabase Edge Function
// fetch-wind-forecasts, die läuft unter Deno und hat eine eigene Kopie.
//
// Endpunkt: https://api.pioupiou.fr/v1/live/all liefert ALLE Stationen
// weltweit ohne Regionsfilter. Behalten werden die im Alpenraum (isInAlps,
// dieselbe Regel wie bei allen Quellen) — meist Vereinsstationen direkt an
// Startplätzen. Bis Okt. 2026 war es nur eine grobe Südtirol-Box (6 Stationen
// statt rund 90); auf Wunsch des Projektbesitzers erweitert (Punkt 26 der
// Code-Durchsicht).
//
// Prognosen: Die Edge Function fragt OpenWindMap weiterhin nur für Südtirol
// ab (ihre eigene Südtirol-Box). Die übrigen OpenWindMap-Stationen haben
// deshalb — wie MeteoSchweiz — keine Prognose-Kurve.
//
// Lizenz: Die Daten stehen unter der kostenlosen OpenWindMap-Community-
// Lizenz, die einen sichtbaren Credit mit Link verlangt. Die frühere Fußzeile
// dafür ist auf Wunsch des Projektbesitzers entfernt; der Credit steht derzeit
// nur als "Quelle:"-Link im Verlaufsbalken (offener Punkt, siehe CLAUDE.md).

const API_BASE =
  process.env.PIOUPIOU_API_BASE_URL ?? "https://api.pioupiou.fr/v1";

// Stationen, die so lange nichts gemeldet haben, gelten als abgebaut oder für
// die Saison abgeschaltet und erscheinen nicht auf der Karte (Okt. 2026 waren
// das im Alpenraum 4 von 94, zwei davon ausdrücklich "off"). Gleiche Dauer wie
// die Aufbewahrung in der Datenbank (/api/collect): Danach gäbe es auch im
// Verlaufsbalken nichts mehr zu sehen. Kürzere Pausen (nachts, windstill)
// bleiben als grauer Ring stehen.
const MAX_SILENCE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Feste Höhenangaben für Stationen, deren Name keine Höhe enthält
 * (Schlüssel = Pioupiou-Stations-ID). Sept. 2026, Wunsch des Projektbesitzers:
 * die Vereinsstation des Paradeltaclubs Uri am Bälmeten (Schweiz) im
 * Windanzeiger — die Höhe liefert weder die API noch der Stationsname
 * ("Bälmeten Backup"); sie stammt vom Projektbesitzer. (Bis Okt. 2026 stand
 * die Station hier, weil sie außerhalb der Südtirol-Box lag.)
 */
const ALTITUDE_OVERRIDES: Record<number, number> = {
  1535: 2414, // Bälmeten Backup (Paradeltaclub Uri)
};

// Vorangestellt an die Pioupiou-Stations-ID, damit die Stationscodes nicht
// mit den Bozner SCODEs kollidieren (z. B. "pioupiou-413").
const CODE_PREFIX = "pioupiou-";

// Der Abruf wird 60 s zwischengespeichert (cachedFresh, holt nach Ablauf
// sofort neu — siehe src/lib/freshCache.ts). Die Pioupiou-Stationen
// melden ohnehin nur alle paar Minuten. Auch für /api/collect (läuft alle
// 5 Minuten) sind bis zu 60 s alte Werte unschädlich: gespeichert wird der
// Mess-Zeitstempel der Station, Duplikate fängt der Upsert ab.
const CACHE_TTL_MS = 60 * 1000;

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

// --- Stationshöhe aus dem Namen ---
//
// Die Pioupiou-API liefert KEINE Höhenangabe (anders als der Bozner Dienst mit
// seinem Feld ALT). Die Betreiber schreiben die Höhe aber üblicherweise in den
// Stationsnamen, z. B. "Kronplatz 2275m", "Vöran (1.200 m)" oder
// "Meran 2000 - 1900 m ü. M.". Ohne diese Auswertung hätten alle Pioupiou-
// Stationen die Höhe "unbekannt" und würden aus JEDEM Höhenfilter der Karte
// herausfallen (siehe matchesStationFilter in wind.ts).
//
// Bewusst nur mit Einheit ("m", "mt", "meter", "metri", "m ü. M."): Eine blanke
// Zahl im Namen wird NICHT als Höhe gelesen. Sonst würde z. B. der Ortsname
// "Meran 2000" oder der Ersatzname "Pioupiou 1234" (bei Stationen ohne
// hinterlegten Namen) als Höhenangabe missverstanden.
const ALTITUDE_IN_NAME =
  /(\d{1,4}(?:[.,]\d{3})?)\s*(?:m(?:t|eter|etri)?|m\s*ü\.?\s*m\.?)(?![\p{L}\d])/giu;

// Plausibilitätsgrenzen: Unter 100 m und über 4.000 m liegt im Alpenraum
// sicher keine dieser Stationen. Was außerhalb liegt, ist eher eine andere
// Zahl im Namen (z. B. eine Hausnummer) als eine Höhe.
const MIN_PLAUSIBLE_ALTITUDE_M = 100;
const MAX_PLAUSIBLE_ALTITUDE_M = 4000;

/**
 * Liest die Stationshöhe in Metern aus dem Stationsnamen, oder null, wenn dort
 * keine (plausible) Höhenangabe steht.
 *
 * Erkannt werden u. a. "2275m", "2.275 m", "1200 mt", "1900 m ü. M.".
 * Stehen mehrere Angaben im Namen, gilt die LETZTE — die Höhe steht
 * erfahrungsgemäß am Ende, während vorne eher etwas wie "Sender 5m" o. ä.
 * stehen kann.
 */
export function parseAltitudeFromName(name: string): number | null {
  // lastIndex zurücksetzen: Der reguläre Ausdruck ist global (/g) und merkt
  // sich sonst zwischen zwei Aufrufen, wo er stehen geblieben ist.
  ALTITUDE_IN_NAME.lastIndex = 0;
  let altitude: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = ALTITUDE_IN_NAME.exec(name)) !== null) {
    // Tausendertrennzeichen entfernen: "2.275"/"2,275" -> "2275". Es steht per
    // regulärem Ausdruck immer vor genau drei Ziffern, kann also kein
    // Dezimalkomma sein.
    const value = Number(match[1].replace(/[.,]/g, ""));
    if (
      Number.isFinite(value) &&
      value >= MIN_PLAUSIBLE_ALTITUDE_M &&
      value <= MAX_PLAUSIBLE_ALTITUDE_M
    ) {
      altitude = value;
    }
  }
  return altitude;
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

// Koordinaten auf 5 Nachkommastellen kürzen (≈ 1 m genau — für einen
// Kartenmarker mehr als ausreichend), genau wie bei den Bozner Stationen in
// /api/wind. Nebenbei verschwinden dabei die typischen Fließkomma-Reste wie
// "11.350000000000001", die die JSON-Antwort nur unnötig aufblähen.
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * Ruft alle Pioupiou/OpenWindMap-Stationen ab und gibt nur jene im
 * Alpenraum mit gültigen Koordinaten und einer Meldung in den letzten 2 Tagen
 * zurück (MAX_SILENCE_MS), im selben WindStation-Format wie die Bozner
 * Stationen (gleiche Farbskala, gleiches stale-Verhalten, gleiche
 * Karten-/Verlaufsbalken-Darstellung).
 */
export async function fetchOpenWindMapStations(): Promise<WindStation[]> {
  const url = `${API_BASE}/live/all`;
  const body: unknown = await cachedFresh(url, CACHE_TTL_MS, async () => {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`OpenWindMap antwortete mit Status ${res.status}`);
    }
    return res.json() as Promise<unknown>;
  });
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
      !isInAlps(loc.latitude, loc.longitude)
    ) {
      continue;
    }

    const m = s.measurements;
    const timestamp = m?.date ?? null;
    const measuredAt = timestamp ? Date.parse(timestamp) : NaN;
    // Seit Tagen stumm: abgebaut oder abgeschaltet (siehe MAX_SILENCE_MS).
    if (Number.isNaN(measuredAt) || now - measuredAt > MAX_SILENCE_MS) continue;

    const direction = m?.wind_heading ?? null;
    const speedKmh =
      m?.wind_speed_avg != null ? round1(toKmh(m.wind_speed_avg)) : null;
    const gustKmh =
      m?.wind_speed_max != null ? round1(toKmh(m.wind_speed_max)) : null;

    // Ausgefallen (grauer Ring) wie bei allen Quellen: ohne Richtung/Wind oder
    // zu alt (STALE_AFTER_MINUTES in wind.ts). Pioupiou-Stationen sind
    // batteriebetrieben und melden nachts/windstill teils gar nicht — dann
    // lieber grau als ein veralteter Pfeil.
    const stale =
      direction === null || speedKmh === null || isOutdated("openwindmap", measuredAt, now);

    // Der Name bleibt unverändert stehen (die Höhe wird also nicht
    // "herausgeschnitten") — so ist die Station auf der Karte und im
    // Verlaufsbalken genauso beschriftet wie bei OpenWindMap selbst.
    const stationName = s.meta?.name ?? `Pioupiou ${s.id}`;

    result.push({
      stationCode: `${CODE_PREFIX}${s.id}`,
      stationName,
      lat: round5(loc.latitude),
      lng: round5(loc.longitude),
      altitude: ALTITUDE_OVERRIDES[s.id] ?? parseAltitudeFromName(stationName),
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
