import {
  DATABASE_TIMEOUT_MS,
  LIVE_DATABASE_TIMEOUT_MS,
  isOutdated,
  type WindStation,
} from "./wind";
import { SOURCE_IDS, type SourceId } from "./sources";
import type { SourceStatusRow } from "./sourceStatus";

// Stationsliste und aktuelle Werte in der Datenbank.
//
// Stationsliste (Okt. 2026, Punkt 10 der Code-Durchsicht): Name, Lage und
// Höhe jeder Station in der Supabase-Tabelle wind_stations
// (supabase/stationsliste.sql), eingetragen vom Sammler (/api/collect).
//
// Seit Nov. 2026 (Punkt 14, "Ein Sammler, eine Wahrheit") liest die Karte
// (/api/wind) ihre Werte nur noch hier: je Station der neueste gespeicherte
// Messwert (Sicht wind_stations_latest) plus der Zustand der Quellen
// (Tabelle wind_status, src/lib/sourceStatus.ts) — beides in EINER Anfrage
// über die Datenbank-Funktion wind_latest (supabase/ein-sammler.sql). Karte,
// Zeitbalken und Verlaufsbalken zeigen dadurch immer denselben Stand.
// Vorher fragte /api/wind bei jedem Abruf alle Wetterdienste selbst und nahm
// die Datenbank nur, wenn eine Quelle ausgefallen war.
//
// Liefert eine Quelle gerade nichts, bleiben ihre Stationen deshalb von
// selbst mit dem letzten Wert stehen und werden nach der Grau-Grenze
// (STALE_AFTER_MINUTES in wind.ts) grau, wie bei einem Sensorausfall. Weil
// wind_measurements nur 3 Tage aufbewahrt wird (/api/collect), verschwinden
// die Stationen einer tagelang ausgefallenen Quelle nach 3 Tagen doch.
// Stationen, die ihre Quelle nicht mehr führt, fallen nach rund 2 Stunden
// weg (STATION_DROPPED_AFTER_MS).

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

/**
 * Eine Station aus wind_latest() (Feld "stations"): Code, Quelle, Name,
 * Breite, Länge, Höhe, Messzeit (ms), Richtung, Mittelwind, Böe, zuletzt in
 * der Stationsliste aufgefrischt (ms).
 */
type LatestStationRow = [
  string,
  string,
  string,
  number,
  number,
  number | null,
  number,
  number | null,
  number | null,
  number | null,
  number,
];

/**
 * Stationen, die ihre Quelle nicht mehr führt (abgebaut, umbenannt, bei
 * OpenWindMap seit 2 Tagen stumm), stehen weiter in wind_stations. Erkannt
 * werden sie daran, dass der Sammler sie nicht mehr auffrischt: Alle
 * gelieferten Stationen einer Quelle frischt er einmal pro Stunde auf. Liegt
 * eine so weit hinter der jüngsten ihrer Quelle, zeigt die Karte sie nicht
 * mehr. Gemessen an der Quelle selbst statt an der Uhr: Scheitert das
 * Auffrischen einmal ganz, liegen alle gleich weit zurück, und es
 * verschwindet nichts.
 */
const STATION_DROPPED_AFTER_MS = 2 * 60 * 60 * 1000;

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

/** Was die Karte aus der Datenbank bekommt. */
export interface LatestFromDatabase {
  /** Alle Stationen mit ihrem neuesten Wert, im Format der Karte. */
  stations: WindStation[];
  /** Zustand der Quellen laut Sammler (siehe src/lib/sourceStatus.ts). */
  sources: SourceStatusRow[];
}

/**
 * Aktuelle Werte aller Stationen und den Zustand der Quellen aus der
 * Datenbank lesen (für /api/wind). null bei jedem Fehler (Datenbank nicht
 * erreichbar, Zeitlimit, Funktion noch nicht angelegt) — /api/wind fragt
 * dann im Notbetrieb direkt bei den Quellen.
 */
export async function fetchLatestFromDatabase(): Promise<LatestFromDatabase | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  // Das Zeitlimit gilt auch für das Lesen der Antwort — deshalb steht
  // res.json() mit im try.
  let body: { stations?: LatestStationRow[]; sources?: SourceStatusRow[] };
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/wind_latest`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(LIVE_DATABASE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`wind_latest: Supabase antwortete mit Status ${res.status}`);
      return null;
    }
    body = await res.json();
  } catch (err) {
    console.error("wind_latest nicht abrufbar:", err);
    return null;
  }
  const rows = Array.isArray(body?.stations) ? body.stations : [];
  const sources = Array.isArray(body?.sources) ? body.sources : [];

  // Jüngstes Auffrischen je Quelle (siehe STATION_DROPPED_AFTER_MS).
  const newestRefresh = new Map<string, number>();
  for (const row of rows) {
    newestRefresh.set(row[1], Math.max(newestRefresh.get(row[1]) ?? 0, row[10]));
  }

  // Nur Quellen, die es im Code (noch) gibt — eine entfernte Quelle hätte
  // sonst noch bis zu 3 Tage Stationen ohne Quellenangabe auf der Karte.
  const known = new Set<string>(SOURCE_IDS);
  const now = Date.now();
  const stations: WindStation[] = [];
  for (const [code, sourceName, name, lat, lng, altitude, measuredMs, direction, speedKmh, gustKmh, refreshedMs] of rows) {
    if (!known.has(sourceName)) continue;
    if (refreshedMs < (newestRefresh.get(sourceName) ?? 0) - STATION_DROPPED_AFTER_MS) continue;
    const source = sourceName as SourceId;
    stations.push({
      stationCode: code,
      stationName: name,
      lat,
      lng,
      altitude,
      direction,
      speedKmh,
      gustKmh,
      timestamp: new Date(measuredMs).toISOString(),
      // Gleiche Regel wie bei den Live-Werten der Quellen (z. B. bolzano.ts).
      stale: direction === null || speedKmh === null || isOutdated(source, measuredMs, now),
      source,
    });
  }
  return { stations, sources };
}
