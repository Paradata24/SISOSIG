import { DATABASE_TIMEOUT_MS, isOutdated, type WindStation } from "./wind";

// Stationsliste in der Datenbank (Okt. 2026, Punkt 10 der Code-Durchsicht):
// Name, Lage und Höhe jeder Station in der Supabase-Tabelle wind_stations
// (supabase/stationsliste.sql), eingetragen vom Sammler (/api/collect).
//
// Wozu: Liefert eine Quelle gar nichts (Ausfall, Zeitlimit, leere Datei),
// zeigt /api/wind ihre Stationen trotzdem — mit dem letzten gespeicherten
// Messwert, der nach der Grau-Grenze (STALE_AFTER_MINUTES in wind.ts) grau
// wird, genau wie bei einem Sensorausfall. Vorher verschwanden sie von der
// Karte und damit auch aus Zeitbalken und Verlaufsbalken (beide hängen an den
// Stationen der Karte); der Hinweis "… liefert gerade keine Daten" bleibt.
//
// Den neuesten Wert je Station liefert die Sicht wind_stations_latest: eine
// Zeile der Stationsliste plus die jüngste Zeile aus wind_measurements.
// Stationen ohne gespeicherten Wert fehlen dort. Weil wind_measurements nur
// 2 Tage aufbewahrt wird (/api/collect), verschwinden die Stationen einer
// tagelang ausgefallenen Quelle nach 2 Tagen also doch von der Karte. Ebenso
// taucht eine Station, die eine Quelle nicht mehr führt, spätestens nach
// 2 Tagen auch hier nicht mehr auf (ihre Zeile in wind_stations bleibt, stört
// aber nicht).

/** Eine Zeile der Tabelle wind_stations. */
interface StationListRow {
  station_code: string;
  source: WindStation["source"];
  name: string;
  lat: number;
  lng: number;
  altitude: number | null;
  updated_at: string;
}

/** Eine Zeile der Sicht wind_stations_latest. */
interface LatestRow {
  station_code: string;
  source: WindStation["source"];
  name: string;
  lat: number;
  lng: number;
  altitude: number | null;
  measured_at: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
}

/**
 * Stationen in die Stationsliste schreiben (für /api/collect). Neue Stationen
 * kommen immer dazu. Bekannte werden nur mit refreshKnown = true
 * überschrieben: Name, Lage und Höhe ändern sich praktisch nie, und sonst
 * schriebe jeder Lauf rund 700 unveränderte Zeilen neu. Gibt null zurück,
 * wenn alles geklappt hat, sonst die Fehlermeldung.
 */
export async function saveStationList(
  supabaseUrl: string,
  headers: Record<string, string>,
  stations: WindStation[],
  refreshKnown: boolean,
): Promise<string | null> {
  const updatedAt = new Date().toISOString();
  const rows: StationListRow[] = [];
  for (const s of stations) {
    if (s.lat === null || s.lng === null) continue; // ohne Lage kein Marker
    rows.push({
      station_code: s.stationCode,
      source: s.source,
      name: s.stationName,
      lat: s.lat,
      lng: s.lng,
      altitude: s.altitude,
      updated_at: updatedAt,
    });
  }
  if (rows.length === 0) return null;

  const resolution = refreshKnown ? "merge-duplicates" : "ignore-duplicates";
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/wind_stations?on_conflict=station_code`, {
      method: "POST",
      headers: { ...headers, Prefer: `resolution=${resolution},return=minimal` },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    return res.ok ? null : `Status ${res.status}: ${await res.text()}`;
  } catch (err) {
    return String(err);
  }
}

/**
 * Die Stationen der angegebenen (gerade ausgefallenen) Quellen mit ihrem
 * letzten gespeicherten Messwert, im Live-Format der Karte (für /api/wind).
 * Grau werden sie nach derselben Regel wie live. Bei jedem Fehler (Datenbank
 * nicht erreichbar, Tabelle noch nicht angelegt) eine leere Liste — die Karte
 * zeigt dann wie früher nur die übrigen Quellen.
 *
 * Supabase liefert höchstens 1000 Zeilen je Anfrage ("Max rows"). Das reicht
 * auch, wenn alle Quellen zugleich ausfallen (Okt. 2026: gut 700 Stationen).
 */
export async function fetchLastKnownStations(
  sources: WindStation["source"][],
): Promise<WindStation[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sources.length === 0 || !supabaseUrl || !serviceKey) return [];

  const query =
    `${supabaseUrl}/rest/v1/wind_stations_latest` +
    `?source=in.(${sources.join(",")})` +
    `&select=station_code,source,name,lat,lng,altitude,measured_at,direction,speed_kmh,gust_kmh`;
  // Das Zeitlimit gilt auch für das Lesen der Antwort — deshalb steht
  // res.json() mit im try.
  let rows: LatestRow[];
  try {
    const res = await fetch(query, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Stationsliste: Supabase antwortete mit Status ${res.status}`);
      return [];
    }
    rows = (await res.json()) as LatestRow[];
  } catch (err) {
    console.error("Stationsliste nicht abrufbar:", err);
    return [];
  }

  const now = Date.now();
  return rows.map((r) => ({
    stationCode: r.station_code,
    stationName: r.name,
    lat: r.lat,
    lng: r.lng,
    altitude: r.altitude,
    direction: r.direction,
    speedKmh: r.speed_kmh,
    gustKmh: r.gust_kmh,
    timestamp: r.measured_at,
    // Gleiche Regel wie bei den Live-Werten der Quellen (z. B. bolzano.ts).
    stale:
      r.direction === null ||
      r.speed_kmh === null ||
      isOutdated(r.source, Date.parse(r.measured_at), now),
    source: r.source,
  }));
}
