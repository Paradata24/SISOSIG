import { isInAlps } from "./alps";
import type { WindStation } from "./wind";

// Gemeinsame Logik zum Abrufen der IMIS-Stationen des SLF (WSL-Institut für
// Schnee- und Lawinenforschung, Davos) — dieselben Stationen, die whiterisk.ch
// anzeigt (z. B. https://whiterisk.ch/de/snow/station/IMIS/ZNZ1). Genutzt von
// /api/wind (Live-Anzeige) und /api/collect (Sammel-Route für die Historie).
// Die Edge Function fetch-wind-forecasts läuft unter Deno und hat eine eigene
// Kopie des Stationsabrufs (siehe dort).
//
// Quelle: die offizielle, öffentliche "SLF Measurement API"
// (https://measurement-api.slf.ch/docs), ohne Anmeldung/Schlüssel.
//   /public/api/imis/stations      alle aktiven Stationen (Name, Lage, Höhe)
//   /public/api/imis/measurements  Messwerte ALLER Stationen der letzten 24 h
// whiterisk.ch selbst holt seine Werte über einen internen Dienst
// (public-meas-data-v2.slf.ch) — der ist nicht dokumentiert und liefert pro
// Anfrage nur EINE Station, deshalb bewusst nicht dieser.
//
// MESSTAKT: 30 Minuten (Werte zu :00 und :30, Mittel über die letzten 30 min).
// Im Sept. 2026 nachgeprüft — auch whiterisk.ch zeigt nichts Feineres. Wie der
// Rest der Seite damit umgeht, steht bei SOURCE_INTERVAL_MINUTES in wind.ts.
//
// Lizenz: CC BY 4.0 (https://www.slf.ch/de/services-und-produkte/slf-datenservice/).
// Die Nennung des SLF steht als "Quelle:" im Verlaufsbalken (SOURCE_INFO).
//
// Größe: /imis/measurements ist unkomprimiert gut 3 MB (komprimiert ~400 KB).
// Das ist mehr, als der Next.js-Daten-Cache pro Eintrag speichert (2 MB) —
// deshalb gibt es unten einen eigenen kleinen Zwischenspeicher im Speicher.

const API_BASE =
  process.env.SLF_API_BASE_URL ?? "https://measurement-api.slf.ch/public/api";

// Vorangestellt an den SLF-Stationscode, damit er nicht mit den Bozner SCODEs
// oder den Pioupiou-Codes kollidiert (z. B. "slf-ZNZ1").
export const SLF_CODE_PREFIX = "slf-";

// Wie bei Bozen und Pioupiou: Messwerte älter als 2 h gelten als ausgefallen.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Stationsliste ändert sich praktisch nie (wie /stations beim Bozner Dienst).
const STATIONS_REVALIDATE_S = 6 * 60 * 60;

// Die Messwerte werden 2 Minuten im Speicher gehalten. Neue Werte kommen
// ohnehin nur alle 30 Minuten, und der SLF-Dienst selbst cacht seine Antwort
// knapp 4 Minuten (Header max-age=225). Laufen mehrere Anfragen gleichzeitig
// an, teilen sie sich denselben Abruf (es wird das Promise gespeichert).
const MEASUREMENTS_TTL_MS = 2 * 60 * 1000;

interface SlfStationMeta {
  code: string;
  label?: string;
  lat?: number;
  lon?: number;
  elevation?: number;
  type?: string;
}

// Nur die Felder, die wir brauchen. Wind in m/s, Richtung in Grad.
//   VW_30MIN_MEAN  Mittelwind (vektorielles Mittel der letzten 30 min)
//   VW_30MIN_MAX   Böe (höchster 5-Sekunden-Wert der letzten 30 min)
//   DW_30MIN_MEAN  Windrichtung (vektorielles Mittel der letzten 30 min)
interface SlfMeasurement {
  station_code: string;
  measure_date: string;
  VW_30MIN_MEAN: number | null;
  VW_30MIN_MAX: number | null;
  DW_30MIN_MEAN: number | null;
}

/** Ein Messwert einer SLF-Station, schon in unseren Einheiten (km/h). */
export interface SlfReading {
  stationCode: string;
  measuredAt: string;
  direction: number | null;
  speedKmh: number | null;
  gustKmh: number | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

// Das SLF liefert m/s, intern rechnet die ganze Seite in km/h.
function msToKmh(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : round1(value * 3.6);
}

async function fetchStationMeta(): Promise<SlfStationMeta[]> {
  const res = await fetch(`${API_BASE}/imis/stations`, {
    next: { revalidate: STATIONS_REVALIDATE_S },
  });
  if (!res.ok) throw new Error(`SLF-Stationsliste: Status ${res.status}`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as SlfStationMeta[]) : [];
}

let measurementsCache: { at: number; promise: Promise<SlfMeasurement[]> } | null = null;

async function loadMeasurements(): Promise<SlfMeasurement[]> {
  // no-store: zu groß für den Next.js-Daten-Cache (siehe oben), der eigene
  // Zwischenspeicher darüber übernimmt.
  const res = await fetch(`${API_BASE}/imis/measurements`, { cache: "no-store" });
  if (!res.ok) throw new Error(`SLF-Messwerte: Status ${res.status}`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as SlfMeasurement[]) : [];
}

function fetchMeasurements(): Promise<SlfMeasurement[]> {
  const now = Date.now();
  if (measurementsCache && now - measurementsCache.at < MEASUREMENTS_TTL_MS) {
    return measurementsCache.promise;
  }
  const promise = loadMeasurements();
  measurementsCache = { at: now, promise };
  // Ein Fehlschlag darf nicht 2 Minuten lang "festsitzen": dann beim nächsten
  // Aufruf sofort neu versuchen.
  promise.catch(() => {
    if (measurementsCache?.promise === promise) measurementsCache = null;
  });
  return promise;
}

/**
 * Alle SLF-Messwerte der letzten 24 h, die mindestens einen Windwert haben,
 * je Station aufsteigend nach Zeit sortiert. Schlüssel ist bereits unser
 * Stationscode ("slf-ZNZ1").
 */
async function fetchReadingsByStation(): Promise<Map<string, SlfReading[]>> {
  const measurements = await fetchMeasurements();
  const byStation = new Map<string, SlfReading[]>();
  for (const m of measurements) {
    if (!m.station_code || Number.isNaN(Date.parse(m.measure_date))) continue;
    const reading: SlfReading = {
      stationCode: `${SLF_CODE_PREFIX}${m.station_code}`,
      measuredAt: m.measure_date,
      direction: m.DW_30MIN_MEAN ?? null,
      speedKmh: msToKmh(m.VW_30MIN_MEAN ?? null),
      gustKmh: msToKmh(m.VW_30MIN_MAX ?? null),
    };
    // Zeilen ganz ohne Wind (z. B. reine Schnee-/Temperaturwerte) weglassen.
    if (reading.direction === null && reading.speedKmh === null && reading.gustKmh === null) {
      continue;
    }
    const list = byStation.get(reading.stationCode);
    if (list) list.push(reading);
    else byStation.set(reading.stationCode, [reading]);
  }
  for (const list of byStation.values()) {
    list.sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
  }
  return byStation;
}

/**
 * Live-Werte aller SLF-Stationen mit Windmessung, im selben WindStation-Format
 * wie Bozen und Pioupiou. Stationen ohne jeden Windwert in den letzten 24 h
 * (oder ohne Koordinaten) erscheinen nicht auf der Karte.
 *
 * Achtung: Einzelne Stationen melden keine Richtung (z. B. ZNZ1, dort fehlt
 * sie auch auf whiterisk.ch). Sie gelten wie bei Bozen als "stale" (grauer
 * Punkt), weil ohne Richtung kein Pfeil gezeichnet werden kann; der Verlauf
 * mit Mittelwind und Böen ist trotzdem abrufbar.
 */
export async function fetchSlfStations(): Promise<WindStation[]> {
  const [meta, byStation] = await Promise.all([fetchStationMeta(), fetchReadingsByStation()]);
  const now = Date.now();
  const result: WindStation[] = [];

  for (const s of meta) {
    if (typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    if (!isInAlps(s.lat, s.lon)) continue;
    const readings = byStation.get(`${SLF_CODE_PREFIX}${s.code}`);
    if (!readings || readings.length === 0) continue;
    const latest = readings[readings.length - 1];

    const measuredAt = Date.parse(latest.measuredAt);
    const stale =
      latest.direction === null ||
      latest.speedKmh === null ||
      Number.isNaN(measuredAt) ||
      now - measuredAt > STALE_AFTER_MS;

    result.push({
      stationCode: latest.stationCode,
      stationName: s.label ?? s.code,
      lat: round5(s.lat),
      lng: round5(s.lon),
      altitude: typeof s.elevation === "number" ? Math.round(s.elevation) : null,
      direction: latest.direction,
      speedKmh: latest.speedKmh,
      gustKmh: latest.gustKmh,
      timestamp: latest.measuredAt,
      stale,
      source: "slf",
    });
  }
  return result;
}

/**
 * Alle SLF-Messwerte ab `sinceMs` (für /api/collect). Die Sammel-Route
 * schreibt also nicht nur den neuesten Wert, sondern ein ganzes Zeitfenster —
 * anders als beim Bozner Dienst geht das hier, weil das SLF die letzten 24 h
 * mitliefert. So füllen sich Lücken (ausgefallener Sammel-Lauf, verspätet
 * gelieferter Wert) beim nächsten Lauf von selbst.
 */
export async function fetchSlfReadingsSince(sinceMs: number): Promise<SlfReading[]> {
  const [meta, byStation] = await Promise.all([fetchStationMeta(), fetchReadingsByStation()]);
  // Nur Stationen im Alpenraum (siehe src/lib/alps.ts) — dieselbe Auswahl wie
  // in fetchSlfStations, damit nichts gesammelt wird, was nie angezeigt wird.
  const inAlps = new Set(
    meta
      .filter((s) => typeof s.lat === "number" && typeof s.lon === "number" && isInAlps(s.lat, s.lon))
      .map((s) => `${SLF_CODE_PREFIX}${s.code}`),
  );
  const rows: SlfReading[] = [];
  for (const [code, list] of byStation) {
    if (!inAlps.has(code)) continue;
    for (const r of list) {
      if (Date.parse(r.measuredAt) >= sinceMs) rows.push(r);
    }
  }
  return rows;
}
