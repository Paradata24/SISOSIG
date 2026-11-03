import { SOURCE_TIMEOUT_MS } from "./wind";
import { PRESSURE_STATION_IDS, type PressureStationId } from "./pressure";

// Flugwetter-Meldungen (METAR) der Flughäfen Innsbruck (LOWI) und Bozen (LIPB)
// für die Föhn-Anzeige (src/lib/pressure.ts). Nur auf dem Server: Abgefragt
// vom Sammler (/api/collect) und im Notbetrieb von /api/pressure.
//
// Quelle: Aviation Weather Center der US-Wetterbehörde NOAA — frei und ohne
// Schlüssel, sammelt die METAR aller Flughäfen weltweit (auch die von Austro
// Control und ENAV). Grenze: 100 Anfragen pro Minute; der Sammler fragt alle
// 5 min einmal für beide Flughäfen. Die Daten sind gemeinfrei (US-Behörde).
// Bozen hat im Netz des Landes keine Wetterstation am Flughafen (dort steht
// nur ein Grundwasser-Messpunkt), deshalb der METAR.
//
// Umgebungsvariable METAR_API_BASE_URL biegt die Adresse für Tests auf einen
// lokalen Nachbau um (wie bei den anderen Quellen).
const METAR_API_BASE =
  process.env.METAR_API_BASE_URL ?? "https://aviationweather.gov/api/data/metar";

// Gültige QNH-Werte; alles außerhalb wäre ein Lese- oder Tippfehler im METAR.
const QNH_MIN_HPA = 900;
const QNH_MAX_HPA = 1100;

/** Ein gemessener QNH. */
export interface MetarPressure {
  station: PressureStationId;
  /** Beobachtungszeit, ISO (UTC). */
  observedAt: string;
  qnhHpa: number;
}

/** Ein Eintrag der Antwort (format=json), nur die genutzten Felder. */
interface MetarJson {
  icaoId?: string;
  obsTime?: number;
  rawOb?: string;
  altim?: number;
}

/**
 * QNH aus der Meldung: bevorzugt die Q-Gruppe im Originaltext ("Q1019" = 1019
 * hPa, genau so, wie der Flughafen sie meldet), sonst das ausgewertete Feld
 * altim des Dienstes.
 */
function readQnh(entry: MetarJson): number | null {
  const fromText = entry.rawOb?.match(/\sQ(\d{4})(?=\s|$)/);
  const value = fromText ? Number(fromText[1]) : entry.altim;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= QNH_MIN_HPA && value <= QNH_MAX_HPA ? value : null;
}

/**
 * Alle METAR der beiden Flughäfen aus den letzten `hours` Stunden (der Dienst
 * liefert bis zu einige Tage zurück). Wirft bei einem Fehler des Dienstes.
 */
export async function fetchMetarPressure(hours: number): Promise<MetarPressure[]> {
  const params = new URLSearchParams({
    ids: PRESSURE_STATION_IDS.join(","),
    format: "json",
    hours: String(hours),
  });
  const res = await fetch(`${METAR_API_BASE}?${params}`, {
    // Der Dienst bittet um eine erkennbare Absenderkennung.
    headers: { "User-Agent": "SISOSIG-Windkarte" },
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Aviation Weather antwortete mit Status ${res.status}`);
  // Ohne passende Meldung antwortet der Dienst mit leerem Text statt "[]".
  const text = await res.text();
  const data: unknown = text.trim() === "" ? [] : JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("Aviation Weather: unerwartetes Antwortformat");

  const result: MetarPressure[] = [];
  const seen = new Set<string>();
  for (const entry of data as MetarJson[]) {
    const station = PRESSURE_STATION_IDS.find((id) => id === entry.icaoId);
    if (!station || typeof entry.obsTime !== "number") continue;
    const qnhHpa = readQnh(entry);
    if (qnhHpa === null) continue;
    const observedAt = new Date(entry.obsTime * 1000).toISOString();
    // Zwei Meldungen zur selben Zeit (z. B. eine berichtigte): die erste
    // gewinnt — Doppelte in einem Schreibvorgang lehnt die Datenbank ab.
    const key = `${station}|${observedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ station, observedAt, qnhHpa });
  }
  return result;
}
