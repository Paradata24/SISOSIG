import { CREST_STATIONS, type CrestStationId } from "./pressure";
import { fetchBolzanoSeries, fetchGeosphere10min, humidityOrNull, tempOrNull } from "./stationPressure";

// Temperatur auf Kammhöhe für das Temperatur-Diagramm im Druck-Verlaufsbalken
// (8. Nov. 2026, Wunsch des Projektbesitzers; warum diese zwei Stationen:
// CREST_STATIONS in src/lib/pressure.ts):
//
//   Rittnerhorn   (2260 m, südlich des Brenners): Landeswetterdienst
//                 Südtirol, Station 82500WS, Sensoren LT (Temperatur) und LF
//                 (relative Feuchte), alle 10 min.
//   Patscherkofel (2251 m, nördlich des Brenners): GeoSphere Austria,
//                 Station 11126, Parameter TL und RF, alle 10 min.
//
// Die Feuchte wird nur gespeichert (für später, z. B. trockene Föhnluft);
// angezeigt wird die Temperatur.
//
// Nur auf dem Server: Abgefragt vom Sammler (/api/collect, letzte 3 h, Art
// 'kamm' in pressure_values) und im Notbetrieb von /api/pressure (48 h).
// GeoSphere erlaubt 240 Anfragen pro Stunde — der Sammler braucht hierfür 12.

/** Eine gemessene Kammtemperatur. */
export interface CrestTemperature {
  station: CrestStationId;
  /** Messzeit, ISO (UTC). */
  measuredAt: string;
  tempC: number;
  humidityPct: number | null;
}

/** Rittnerhorn: Temperatur und Feuchte vom Landeswetterdienst Südtirol. */
async function fetchRittnerhorn(sinceMs: number, now: number): Promise<CrestTemperature[]> {
  const code = CREST_STATIONS.RITTNERHORN.code;
  // Feuchte ist nur ein Zusatz: Fehlt sie, bleibt die Temperatur.
  const [temperature, humidity] = await Promise.all([
    fetchBolzanoSeries(code, "LT", sinceMs, now),
    fetchBolzanoSeries(code, "LF", sinceMs, now).catch(() => new Map<string, number>()),
  ]);
  const result: CrestTemperature[] = [];
  for (const [iso, value] of temperature) {
    const tempC = tempOrNull(value);
    if (tempC === null) continue;
    result.push({ station: "RITTNERHORN", measuredAt: iso, tempC, humidityPct: humidityOrNull(humidity.get(iso)) });
  }
  return result.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
}

/** Patscherkofel: Temperatur und Feuchte von GeoSphere Austria. */
async function fetchPatscherkofel(sinceMs: number, now: number): Promise<CrestTemperature[]> {
  const { times, parameters } = await fetchGeosphere10min(
    CREST_STATIONS.PATSCHERKOFEL.code,
    ["TL", "RF"],
    sinceMs,
    now,
  );
  const result: CrestTemperature[] = [];
  times.forEach((time, i) => {
    const t = Date.parse(time);
    const tempC = tempOrNull(parameters.TL[i]);
    if (Number.isNaN(t) || tempC === null) return;
    result.push({
      station: "PATSCHERKOFEL",
      measuredAt: new Date(t).toISOString(),
      tempC,
      humidityPct: humidityOrNull(parameters.RF[i]),
    });
  });
  return result;
}

/**
 * Kammtemperaturen beider Stationen seit `sinceMs`. Scheitert eine Seite,
 * kommen die Werte der anderen trotzdem; `errors` nennt, was fehlte.
 */
export async function fetchCrestTemperature(
  sinceMs: number,
): Promise<{ values: CrestTemperature[]; errors: string[] }> {
  const now = Date.now();
  const results = await Promise.allSettled([fetchRittnerhorn(sinceMs, now), fetchPatscherkofel(sinceMs, now)]);
  const values: CrestTemperature[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    const label = i === 0 ? "Rittnerhorn (Landeswetterdienst)" : "Patscherkofel (GeoSphere)";
    if (r.status === "fulfilled") {
      if (r.value.length === 0) errors.push(`${label}: keine Werte`);
      values.push(...r.value);
    } else {
      errors.push(`${label}: ${String(r.reason)}`);
    }
  });
  return { values, errors };
}
