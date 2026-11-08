import { SOURCE_TIMEOUT_MS } from "./wind";
import { type PressureStationId } from "./pressure";

// Luftdruck in 10-Minuten-Auflösung für die Föhn-Anzeige (Nov. 2026, Wunsch
// des Projektbesitzers): Die Flugwetter-Meldungen (METAR, src/lib/metar.ts)
// haben nur ganze hPa, und Bozen meldet nachts gar nicht (etwa 22:50–6:30
// Uhr) — die Kurve im Druck-Verlaufsbalken war deshalb treppig und nachts
// unterbrochen. Hier rechnen wir den QNH selbst, auf 0,1 hPa und alle 10
// Minuten, aus zwei Wetterstationen an den Flughäfen:
//
//   Innsbruck: GeoSphere Austria, Station 11121 "Innsbruck-Flughafen"
//              (578 m, steht auf dem Flughafen). Parameter P = Luftdruck in
//              Stationshöhe → QNH nach der Normatmosphäre (qnhFromStation).
//   Bozen:     Landeswetterdienst Südtirol, Station 83200MS "Bozen" (245 m,
//              rund 3,5 km vom Flughafen). Der Dienst liefert nur den auf
//              Meereshöhe umgerechneten Druck (Sensor LD.RED). Den rechnen wir
//              mit der Lufttemperatur der Station (Sensor LT) auf den Druck in
//              Stationshöhe zurück (stationFromReduced) und daraus wie in
//              Innsbruck den QNH.
//
// Beide Seiten rechnen also nach DERSELBEN Regel wie die Flughäfen. Am
// 03.11.2026 über 48 h geprüft: Die Differenz Bozen − Innsbruck wich im
// Mittel 0,02 hPa von der Differenz der METAR ab, höchstens ±1 hPa (= die
// Rundung der METAR auf ganze hPa); von einem 10-Minuten-Wert zum nächsten
// änderte sie sich im Median um 0,08 hPa. WIE das Land Bozen auf Meereshöhe
// umrechnet, ist nicht dokumentiert — die Rückrechnung (Höhe 245 m,
// Stationstemperatur plus halber Normgradient) traf es an diesen 48 h am
// besten. Die METAR werden weiter gespeichert (seit 8. Nov. 2026 ohne Linie
// im Diagramm); weicht die Kurve dauerhaft von ihnen ab, hier prüfen.
//
// Nur auf dem Server: Abgefragt vom Sammler (/api/collect, letzte 3 h) und im
// Notbetrieb von /api/pressure (48 h). Beide Dienste liefern ihre Werte mit
// Verlauf — ein verpasster Sammel-Lauf füllt sich beim nächsten von selbst auf.

const GEOSPHERE_HISTORICAL_URL =
  process.env.GEOSPHERE_HISTORICAL_BASE_URL ??
  "https://dataset.api.hub.geosphere.at/v1/station/historical/tawes-v1-10min";
const BOLZANO_TIMESERIES_URL =
  (process.env.WIND_API_BASE_URL ?? "https://geoservices.buergernetz.bz.it/services/meteo/v1") +
  "/timeseries";

/** Station je Flughafen-Seite: Kennung beim Dienst und Barometerhöhe (m). */
const INNSBRUCK = { geosphereId: "11121", elevationM: 578 };
const BOZEN = { scode: "83200MS", elevationM: 245 };

// Gültige Werte (QNH in hPa); alles außerhalb wäre ein Messfehler.
const QNH_MIN_HPA = 940;
const QNH_MAX_HPA = 1070;
// Ebenso für Temperatur (°C) und Luftfeuchtigkeit (%).
const TEMP_MIN_C = -40;
const TEMP_MAX_C = 45;

// Auch für die Kammtemperaturen (src/lib/crestTemperature.ts) genutzt.
export function tempOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= TEMP_MIN_C && value <= TEMP_MAX_C
    ? round1(value)
    : null;
}

export function humidityOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : null;
}

/**
 * Ein selbst gerechneter QNH, dazu Temperatur und Luftfeuchtigkeit derselben
 * Station und Messzeit (seit Nov. 2026; bis 8. Nov. 2026 für die
 * Temperatur-Differenz Innsbruck − Bozen im Druck-Verlaufsbalken, seitdem
 * zeigt er die Kammtemperatur, src/lib/crestTemperature.ts — Temperatur und
 * Feuchte der Talstationen werden nur noch gespeichert, z. B. für eine
 * spätere Druckrechnung mit echter Temperatur). null, wenn der Dienst den
 * Wert nicht lieferte.
 */
export interface StationPressure {
  /** Flughafen-Seite (LOWI = Innsbruck, LIPB = Bozen). */
  station: PressureStationId;
  /** Messzeit, ISO (UTC). */
  measuredAt: string;
  qnhHpa: number;
  tempC: number | null;
  humidityPct: number | null;
}

/** QNH aus dem Druck in Stationshöhe nach der Normatmosphäre der ICAO (wie die Flughäfen). */
export function qnhFromStation(stationHpa: number, elevationM: number): number {
  return Math.pow(Math.pow(stationHpa, 0.190263) + 8.417286e-5 * elevationM, 1 / 0.190263);
}

/**
 * Druck in Stationshöhe aus dem auf Meereshöhe umgerechneten Druck (Bozner
 * Dienst) — die Umkehrung der üblichen Reduktion mit der mittleren
 * Temperatur der gedachten Luftsäule (Stationstemperatur + halber
 * Normgradient 0,65 K je 100 m).
 */
function stationFromReduced(reducedHpa: number, tempC: number, elevationM: number): number {
  const meanTempK = tempC + 273.15 + (0.0065 * elevationM) / 2;
  return reducedHpa / Math.exp((9.80665 * elevationM) / (287.05 * meanTempK));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function plausible(qnh: number): boolean {
  return Number.isFinite(qnh) && qnh >= QNH_MIN_HPA && qnh <= QNH_MAX_HPA;
}

// "2026-11-03T13:00:00CET" → ISO (wie toIsoTimestamp in bolzano.ts).
function bolzanoIso(date: string | undefined): string | null {
  if (!date) return null;
  const iso = date.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Datum für den Bozner Dienst (JJJJMMTT, Ortszeit genügt: ein Tag Puffer).
function bolzanoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 10-Minuten-Werte einer GeoSphere-Station seit `sinceMs`: Zeitstempel und je
 * Parameter (z. B. P, TL, RF) die Werte in derselben Reihenfolge. Auch für
 * die Kammtemperatur am Patscherkofel (src/lib/crestTemperature.ts).
 */
export async function fetchGeosphere10min(
  stationId: string,
  parameterNames: string[],
  sinceMs: number,
  now: number,
): Promise<{ times: string[]; parameters: Record<string, Array<number | null>> }> {
  const params = new URLSearchParams({
    parameters: parameterNames.join(","),
    station_ids: stationId,
    start: new Date(sinceMs).toISOString().slice(0, 16),
    end: new Date(now).toISOString().slice(0, 16),
  });
  const res = await fetch(`${GEOSPHERE_HISTORICAL_URL}?${params}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GeoSphere antwortete mit Status ${res.status}`);
  const body = (await res.json()) as {
    timestamps?: string[];
    features?: Array<{
      properties?: { parameters?: Record<string, { data?: Array<number | null> } | undefined> };
    }>;
  };
  const found = body.features?.[0]?.properties?.parameters ?? {};
  const parameters: Record<string, Array<number | null>> = {};
  for (const name of parameterNames) parameters[name] = found[name]?.data ?? [];
  return { times: body.timestamps ?? [], parameters };
}

/** Innsbruck: QNH aus dem Stationsdruck von GeoSphere seit `sinceMs`. */
async function fetchInnsbruck(sinceMs: number, now: number): Promise<StationPressure[]> {
  // P = Luftdruck, TL = Lufttemperatur, RF = relative Feuchte (je 10 min).
  const { times, parameters } = await fetchGeosphere10min(INNSBRUCK.geosphereId, ["P", "TL", "RF"], sinceMs, now);
  const values = parameters.P;
  const temps = parameters.TL;
  const humidity = parameters.RF;
  const result: StationPressure[] = [];
  times.forEach((time, i) => {
    const p = values[i];
    const t = Date.parse(time);
    if (typeof p !== "number" || Number.isNaN(t)) return;
    const qnh = qnhFromStation(p, INNSBRUCK.elevationM);
    if (!plausible(qnh)) return;
    result.push({
      station: "LOWI",
      measuredAt: new Date(t).toISOString(),
      qnhHpa: round1(qnh),
      tempC: tempOrNull(temps[i]),
      humidityPct: humidityOrNull(humidity[i]),
    });
  });
  return result;
}

/**
 * Eine Messreihe einer Station des Bozner Dienstes als Map ISO-Zeit → Wert.
 * Auch für die Kammtemperatur am Rittnerhorn (src/lib/crestTemperature.ts).
 */
export async function fetchBolzanoSeries(
  stationCode: string,
  sensor: string,
  sinceMs: number,
  now: number,
): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    station_code: stationCode,
    sensor_code: sensor,
    date_from: bolzanoDate(sinceMs - 24 * 60 * 60 * 1000),
    date_to: bolzanoDate(now + 24 * 60 * 60 * 1000),
  });
  const res = await fetch(`${BOLZANO_TIMESERIES_URL}?${params}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Bozner Dienst (${sensor}) antwortete mit Status ${res.status}`);
  const rows = (await res.json()) as Array<{ DATE?: string; VALUE?: number }>;
  const map = new Map<string, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const iso = bolzanoIso(row.DATE);
    if (!iso || typeof row.VALUE !== "number") continue;
    if (Date.parse(iso) < sinceMs) continue;
    map.set(iso, row.VALUE);
  }
  return map;
}

/** Bozen: QNH aus reduziertem Druck und Temperatur der Station 83200MS seit `sinceMs`. */
async function fetchBozen(sinceMs: number, now: number): Promise<StationPressure[]> {
  // Feuchte (LF) ist nur ein Zusatz: Fehlt sie, bleibt der Rest.
  const [reduced, temperature, humidity] = await Promise.all([
    fetchBolzanoSeries(BOZEN.scode, "LD.RED", sinceMs, now),
    fetchBolzanoSeries(BOZEN.scode, "LT", sinceMs, now),
    fetchBolzanoSeries(BOZEN.scode, "LF", sinceMs, now).catch(() => new Map<string, number>()),
  ]);
  const result: StationPressure[] = [];
  for (const [iso, red] of reduced) {
    const temp = temperature.get(iso);
    if (temp === undefined) continue; // ohne Temperatur keine saubere Rückrechnung
    const qnh = qnhFromStation(stationFromReduced(red, temp, BOZEN.elevationM), BOZEN.elevationM);
    if (!plausible(qnh)) continue;
    result.push({
      station: "LIPB",
      measuredAt: iso,
      qnhHpa: round1(qnh),
      tempC: tempOrNull(temp),
      humidityPct: humidityOrNull(humidity.get(iso)),
    });
  }
  return result.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
}

/**
 * QNH beider Seiten seit `sinceMs`. Scheitert eine Seite, kommen die Werte
 * der anderen trotzdem; `errors` nennt, was fehlte.
 */
export async function fetchStationPressure(
  sinceMs: number,
): Promise<{ values: StationPressure[]; errors: string[] }> {
  const now = Date.now();
  const results = await Promise.allSettled([fetchInnsbruck(sinceMs, now), fetchBozen(sinceMs, now)]);
  const values: StationPressure[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    const label = i === 0 ? "Innsbruck (GeoSphere)" : "Bozen (Landeswetterdienst)";
    if (r.status === "fulfilled") {
      if (r.value.length === 0) errors.push(`${label}: keine Werte`);
      values.push(...r.value);
    } else {
      errors.push(`${label}: ${String(r.reason)}`);
    }
  });
  return { values, errors };
}
