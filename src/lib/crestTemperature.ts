import { CREST_STATIONS, type CrestStationId } from "./pressure";
import { fetchBolzanoSeries, humidityOrNull, tempOrNull } from "./stationPressure";
import { fetchLwdTirolTemperature } from "./lwdtirol";

// Temperatur auf Kammhöhe für das Temperatur-Diagramm im Druck-Verlaufsbalken
// (8. Nov. 2026, Wunsch des Projektbesitzers; warum diese zwei Stationen:
// CREST_STATIONS in src/lib/pressure.ts):
//
//   Rittnerhorn   (2260 m, südlich des Brenners): Landeswetterdienst
//                 Südtirol, Station 82500WS, Sensoren LT (Temperatur) und LF
//                 (relative Feuchte), alle 10 min.
//   Hafelekar     (2270 m, Nordkette, nördlich von Innsbruck): Lawinenwarndienst
//                 Tirol, Station ISEE1, Felder LT und RH (src/lib/lwdtirol.ts).
//                 Die Datei hat KEINEN Verlauf, nur den neuesten Wert (meist
//                 alle 10 min, manchmal Lücken von 20–80 min): Den Verlauf baut
//                 der Sammler selbst auf (alle 5 min); im Notbetrieb gibt es
//                 nur den aktuellen Wert.
//   Bis 8. Nov. 2026 stand im Norden der Patscherkofel (GeoSphere 11126,
//   2251 m) — auf Wunsch des Projektbesitzers ersetzt: Er liegt am Ausgang
//   des Wipptals und steht bei Südföhn selbst in der Föhnströmung, zeigt dann
//   also Luft aus dem Süden. Der Hafelekar liegt weiter vom Alpenhauptkamm
//   weg und zeigt die Luftmasse im Norden besser (wie im Schweizer Beispiel
//   Matro–Pilatus, SHV).
//
// Die Feuchte wird nur gespeichert (für später, z. B. trockene Föhnluft);
// angezeigt wird die Temperatur.
//
// Nur auf dem Server: Abgefragt vom Sammler (/api/collect, letzte 3 h, Art
// 'kamm' in pressure_values) und im Notbetrieb von /api/pressure (48 h; vom
// Hafelekar nur der aktuelle Wert).

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

/** Hafelekar: neueste Temperatur und Feuchte vom Lawinenwarndienst Tirol. */
async function fetchHafelekar(sinceMs: number): Promise<CrestTemperature[]> {
  const latest = await fetchLwdTirolTemperature(CREST_STATIONS.HAFELEKAR.code);
  const tempC = tempOrNull(latest?.tempC);
  if (!latest || tempC === null || Date.parse(latest.measuredAt) < sinceMs) return [];
  return [
    { station: "HAFELEKAR", measuredAt: latest.measuredAt, tempC, humidityPct: humidityOrNull(latest.humidityPct) },
  ];
}

/**
 * Kammtemperaturen beider Stationen seit `sinceMs`. Scheitert eine Seite,
 * kommen die Werte der anderen trotzdem; `errors` nennt, was fehlte.
 */
export async function fetchCrestTemperature(
  sinceMs: number,
): Promise<{ values: CrestTemperature[]; errors: string[] }> {
  const now = Date.now();
  const results = await Promise.allSettled([fetchRittnerhorn(sinceMs, now), fetchHafelekar(sinceMs)]);
  const values: CrestTemperature[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    const label = i === 0 ? "Rittnerhorn (Landeswetterdienst)" : "Hafelekar (LWD Tirol)";
    if (r.status === "fulfilled") {
      if (r.value.length === 0) errors.push(`${label}: keine Werte`);
      values.push(...r.value);
    } else {
      errors.push(`${label}: ${String(r.reason)}`);
    }
  });
  return { values, errors };
}
