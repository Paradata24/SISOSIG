import type { WindStation } from "./wind";

// Ausgewählte Holfuy-Stationen rund um den Gardasee (Startplätze, Landeplätze).
// Genutzt von /api/wind (Live-Anzeige) und /api/collect (Sammel-Route für die
// Historie) — nicht aber von der Supabase Edge Function fetch-wind-forecasts
// (für diese Stationen gibt es keine Prognose-Kurve, siehe README).
//
// Datenquelle: Holfuy Live-API V4 (https://api.holfuy.com/live/).
// WICHTIG: Die API liefert Werte nur mit einem Zugangsschlüssel ("pw").
// Holfuy vergibt ihn laut Nutzungsbedingungen kostenlos auf Anfrage
// (info@holfuy.com). Der Schlüssel steht NIE im Code, sondern als
// Umgebungsvariable HOLFUY_API_KEY in Vercel. Ohne Schlüssel fragt dieses
// Modul gar nicht erst an und liefert eine leere Liste — die Karte sieht dann
// genauso aus wie vorher. Stationen, für die der Schlüssel nicht gilt,
// meldet die API einzeln mit "no_access"; sie werden still übersprungen.
//
// Abschreiben der Holfuy-Webseite (Scraping) ist laut Holfuy-Bedingungen
// ohne Vereinbarung verboten — deshalb ausschließlich über die API.
//
// Quellenangabe (Pflicht laut Holfuy-Bedingungen): "Holfuy" als Quelle nennen
// UND neben den Daten auf die Seite der jeweiligen Station verlinken. Das
// erledigt getSourceLink() in src/lib/wind.ts (Verlaufsbalken). Nicht entfernen.
// Das Präfix der Stationscodes ("holfuy-") steht dort ein zweites Mal, weil
// wind.ts auch im Browser läuft und dieses Server-Modul nicht laden soll.

const API_URL = process.env.HOLFUY_API_URL ?? "https://api.holfuy.com/live/";

// Vorangestellt an die Holfuy-Stationsnummer, damit die Codes nicht
// kollidieren (z. B. "holfuy-1000").
export const HOLFUY_CODE_PREFIX = "holfuy-";

/**
 * Die abgerufenen Stationen, Schlüssel = Holfuy-Stationsnummer (steht in der
 * Adresse der Stationsseite, z. B. holfuy.com/de/weather/1000). Namen und
 * Koordinaten liefert die API selbst mit (Parameter "loc"); der Text hier ist
 * nur die Rückfall-Bezeichnung und die Beschreibung für Menschen.
 * Weitere Station: Nummer ergänzen (die öffentliche Liste aller Stationen
 * steht unter https://api.holfuy.com/stations/stations.json).
 */
export const HOLFUY_STATIONS: Record<string, string> = {
  "1000": "Decollo Malcesine (Monte Baldo, 1760 m)",
  "289": "Brento Exit (Monte Brento, 1500 m)",
  "459": "Brento LZ (Landeplatz Brento, 150 m)",
  "931": "VLS Decollo Colonei (1366 m)",
  "828": "VLS M. Belpo Devid (880 m)",
  "718": "VLS Deltaland (250 m)",
  "1036": "Garda Paragliding (80 m)",
};

// Messwerte älter als 2 h gelten als ausgefallen (wie bei den anderen Quellen).
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Holfuy begrenzt zu viele Aufrufe in kurzer Zeit (API-Version 3.2). Alle
// Stationen kommen deshalb in EINER Anfrage, und die Antwort wird 120 s
// gecacht — bei Abruf-Takt 3 min (Karte) bzw. 5 min (Sammeln) genügt das.
const REVALIDATE_S = 120;

interface HolfuyMeasurement {
  stationId?: number;
  stationName?: string;
  error?: string;
  location?: {
    latitude?: string | number;
    longitude?: string | number;
    altitude?: number;
  };
  /** Mit Parameter "utc": "2026-10-03 00:39:05" in UTC (ohne Zeitzonen-Angabe). */
  dateTime?: string;
  wind?: {
    speed?: number | null;
    gust?: number | null;
    direction?: number | null;
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function fetchHolfuyStations(): Promise<WindStation[]> {
  const apiKey = process.env.HOLFUY_API_KEY;
  if (!apiKey) return []; // noch kein Schlüssel von Holfuy → Quelle bleibt aus

  const params = new URLSearchParams({
    s: Object.keys(HOLFUY_STATIONS).join(","),
    pw: apiKey,
    m: "JSON",
    su: "km/h",
    tu: "C",
  });
  // "loc" (Koordinaten + Höhe mitliefern) und "utc" (Zeitstempel in UTC statt
  // Mitteleuropäischer Zeit) sind Schalter ohne Wert.
  const url = `${API_URL}?${params.toString()}&loc&utc`;

  const res = await fetch(url, { next: { revalidate: REVALIDATE_S } });
  if (!res.ok) throw new Error(`Holfuy antwortete mit Status ${res.status}`);
  const body = (await res.json()) as HolfuyMeasurement & {
    measurements?: HolfuyMeasurement[];
  };
  // Mehrere Stationen → {"measurements": [...]}, eine einzige → direkt das Objekt.
  const measurements = body.measurements ?? [body];

  // Gilt der Schlüssel für keine einzige Station (falsch abgetippt oder von
  // Holfuy noch nicht freigeschaltet), steht das in den Vercel-Logs.
  if (measurements.length > 0 && measurements.every((m) => m.error)) {
    console.warn(`Holfuy: kein Zugriff auf die Stationen (${measurements[0].error})`);
  }

  const now = Date.now();
  const result: WindStation[] = [];

  for (const m of measurements) {
    if (m.error || m.stationId == null) continue; // z. B. "no_access"
    const id = String(m.stationId);
    if (!(id in HOLFUY_STATIONS)) continue;

    const lat = numberOrNull(m.location?.latitude);
    const lng = numberOrNull(m.location?.longitude);
    if (lat === null || lng === null) continue;

    const direction = numberOrNull(m.wind?.direction);
    const speed = numberOrNull(m.wind?.speed);
    const gust = numberOrNull(m.wind?.gust);
    if (direction === null && speed === null && gust === null) continue;

    const measuredAt = m.dateTime ? Date.parse(`${m.dateTime.replace(" ", "T")}Z`) : NaN;
    const stale =
      direction === null ||
      speed === null ||
      Number.isNaN(measuredAt) ||
      now - measuredAt > STALE_AFTER_MS;

    const altitude = numberOrNull(m.location?.altitude);
    result.push({
      stationCode: `${HOLFUY_CODE_PREFIX}${id}`,
      stationName: m.stationName?.trim() || HOLFUY_STATIONS[id],
      lat: round5(lat),
      lng: round5(lng),
      altitude: altitude !== null ? Math.round(altitude) : null,
      direction: direction !== null ? round1(direction) : null,
      speedKmh: speed !== null ? round1(speed) : null,
      gustKmh: gust !== null ? round1(gust) : null,
      timestamp: Number.isNaN(measuredAt) ? null : new Date(measuredAt).toISOString(),
      stale,
      source: "holfuy",
    });
  }
  return result;
}
