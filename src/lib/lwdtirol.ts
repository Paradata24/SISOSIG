import type { WindStation } from "./wind";

// Ausgewählte Messstationen des Lawinenwarndienstes Tirol (LWD Tirol).
// Genutzt von /api/wind (Live-Anzeige) und /api/collect (Sammel-Route für die
// Historie) — nicht aber von der Supabase Edge Function fetch-wind-forecasts
// (für diese Station gibt es keine Prognose-Kurve, siehe README).
//
// Datenquelle: Open Government Data "Wetterstationsdaten Tirol" des Landes
// Tirol, EINE GeoJSON-Datei mit allen ~220 Stationen (rund 180 KB), ohne
// Anmeldung: https://lawine.tirol.gv.at/data/produkte/ogd.geojson
// Laut Datensatzbeschreibung (data.gv.at): Windgeschwindigkeit WG und Böe
// WG_BOE in km/h, Windrichtung WR in Grad — keine Umrechnung nötig.
// Lizenz: CC BY 4.0 — die Nennung steht über SOURCE_INFO in src/lib/wind.ts
// im Verlaufsbalken. Nicht entfernen.
//
// Welche Stationen: bewusst nur die in LWD_TIROL_STATIONS aufgelisteten
// (Wunsch des Projektbesitzers: Hafelekar). Andere Stationen der Datei
// erscheinen NICHT auf der Karte. Weitere hinzufügen: Nummer aus der Spalte
// "LWD-Nummer" der Datei eintragen.
//
// Wie bei den anderen Quellen liefert die Datei nur den neuesten Wert
// (10-Minuten-Takt), der 5-Minuten-Takt von /api/collect passt.

const API_URL =
  process.env.LWD_TIROL_URL ?? "https://lawine.tirol.gv.at/data/produkte/ogd.geojson";

// Vorangestellt an die LWD-Nummer, damit die Codes nicht kollidieren
// (z. B. "lwdtirol-ISEE1").
export const LWD_TIROL_CODE_PREFIX = "lwdtirol-";

/**
 * Die abgerufenen Stationen, Schlüssel = "LWD-Nummer" in der Datei. Der Name
 * in der Datei wird bewusst nicht zur Erkennung benutzt (Namen kommen mehrfach
 * vor: "Hafelekar", "Seegrube" und "Innsbruck Seegrube" liegen nah
 * beieinander und haben je eine eigene Nummer, von denen nur eine Wind misst).
 */
export const LWD_TIROL_STATIONS: Record<string, string> = {
  ISEE1: "Hafelekar (Nordkette, 2270 m)",
};

// Messwerte älter als 2 h gelten als ausgefallen (wie bei den anderen Quellen).
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Neue Werte alle 10 Minuten; 120 s Cache genügen.
const REVALIDATE_S = 120;

interface LwdFeature {
  geometry?: { coordinates?: number[] };
  properties?: {
    "LWD-Nummer"?: string;
    name?: string;
    date?: string;
    WG?: number | null;
    WG_BOE?: number | null;
    WR?: number | null;
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function fetchLwdTirolStations(): Promise<WindStation[]> {
  const res = await fetch(API_URL, { next: { revalidate: REVALIDATE_S } });
  if (!res.ok) throw new Error(`LWD Tirol antwortete mit Status ${res.status}`);
  const body = (await res.json()) as { features?: LwdFeature[] };

  const now = Date.now();
  const result: WindStation[] = [];

  for (const f of body.features ?? []) {
    const p = f.properties;
    const number = p?.["LWD-Nummer"];
    if (!p || !number || !(number in LWD_TIROL_STATIONS)) continue;

    // GeoJSON: [Länge, Breite, Höhe]
    const [lng, lat, alt] = f.geometry?.coordinates ?? [];
    if (typeof lng !== "number" || typeof lat !== "number") continue;

    const direction = numberOrNull(p.WR);
    const speed = numberOrNull(p.WG);
    const gust = numberOrNull(p.WG_BOE);
    if (direction === null && speed === null && gust === null) continue;

    // "2026-09-29T10:50:00+02:00" enthält den Zeitzonen-Versatz → direkt lesbar.
    const measuredAt = p.date ? Date.parse(p.date) : NaN;
    const stale =
      direction === null ||
      speed === null ||
      Number.isNaN(measuredAt) ||
      now - measuredAt > STALE_AFTER_MS;

    result.push({
      stationCode: `${LWD_TIROL_CODE_PREFIX}${number}`,
      stationName: p.name ?? LWD_TIROL_STATIONS[number],
      lat: round5(lat),
      lng: round5(lng),
      altitude: typeof alt === "number" ? Math.round(alt) : null,
      direction: direction !== null ? round1(direction) : null,
      speedKmh: speed !== null ? round1(speed) : null,
      gustKmh: gust !== null ? round1(gust) : null,
      timestamp: Number.isNaN(measuredAt) ? null : new Date(measuredAt).toISOString(),
      stale,
      source: "lwdtirol",
    });
  }
  return result;
}
