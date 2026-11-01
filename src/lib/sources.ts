import { fetchBolzanoForCollect, fetchBolzanoStations } from "./bolzano";
import { fetchOpenWindMapStations } from "./pioupiou";
import { fetchSlfReadingsSince, fetchSlfStations } from "./slf";
import { fetchGeoSphereStations } from "./geosphere";
import { fetchMeteoSwissStations } from "./meteoswiss";
import { fetchLwdTirolStations } from "./lwdtirol";
import { fetchDwdReadingsSince, fetchDwdStations } from "./dwd";
import type { WindStation } from "./wind";

// ALLE Datenquellen an einer Stelle (Punkt 17 der Code-Durchsicht, Nov. 2026).
// Vorher hatten /api/wind und /api/collect je eine eigene Liste, und eine neue
// Quelle musste an beiden Stellen eingetragen werden. Die Logik je Quelle
// (Abruf, Umrechnung) steht weiter in ihrer eigenen Datei in src/lib/.
//
// Seit Punkt 14 ("Ein Sammler, eine Wahrheit") spricht im Normalbetrieb nur
// noch der Sammler (/api/collect) mit den Wetterdiensten; die Karte liest die
// Werte aus der Datenbank. `live` braucht /api/wind nur noch im Notbetrieb,
// wenn die Datenbank nicht antwortet.
//
// Als Record über alle Quellen-Kennungen: Kommt in WindStation["source"]
// (src/lib/wind.ts) eine Quelle dazu, meldet TypeScript hier sofort, dass ihr
// Eintrag fehlt.

export type SourceId = WindStation["source"];

/** Eine Zeile der Tabelle wind_measurements. */
export interface MeasurementRow {
  station_code: string;
  measured_at: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
  source: SourceId;
}

/** Was eine Quelle dem Sammler liefert: Messwerte und ihre Stationen (für die Stationsliste). */
export interface CollectResult {
  rows: MeasurementRow[];
  stations: WindStation[];
}

export interface WindSource {
  /** Aktuelle Werte im Format der Karte (Notbetrieb von /api/wind). */
  live: () => Promise<WindStation[]>;
  /**
   * Für den Sammler: Messwerte (SLF und DWD mit ihrem Verlauf ab `sinceMs`,
   * siehe HISTORY_WINDOW_MS in /api/collect) und die Stationen.
   */
  collect: (sinceMs: number) => Promise<CollectResult>;
}

// Ein Messwert in unseren Einheiten (gemeinsame Form von BolzanoReading,
// SlfReading und DwdReading).
interface Reading {
  stationCode: string;
  measuredAt: string;
  direction: number | null;
  speedKmh: number | null;
  gustKmh: number | null;
}

function fromReadings(readings: Reading[], source: SourceId): MeasurementRow[] {
  return readings.map((r) => ({
    station_code: r.stationCode,
    measured_at: r.measuredAt,
    direction: r.direction,
    speed_kmh: r.speedKmh,
    gust_kmh: r.gustKmh,
    source,
  }));
}

// Quellen, die nur ihren neuesten Wert liefern (Format der Karte): Ihre
// Stationen sind zugleich die Einträge der Stationsliste.
function fromStations(stations: WindStation[]): CollectResult {
  const rows: MeasurementRow[] = [];
  for (const s of stations) {
    if (!s.timestamp || Number.isNaN(Date.parse(s.timestamp))) continue;
    if (s.direction === null && s.speedKmh === null) continue; // kein Messwert
    rows.push({
      station_code: s.stationCode,
      measured_at: s.timestamp,
      direction: s.direction,
      speed_kmh: s.speedKmh,
      gust_kmh: s.gustKmh,
      source: s.source,
    });
  }
  return { rows, stations };
}

// SLF und DWD: Messwerte und Stationen kommen aus zwei Funktionen, die sich
// den Abruf teilen (Zwischenspeicher in slf.ts bzw. cachedFresh in dwd.ts).
// Die Stationsliste ist nur ein Zusatz — scheitert sie, werden die Messwerte
// trotzdem gespeichert.
async function withStations(
  readings: Promise<MeasurementRow[]>,
  stations: Promise<WindStation[]>,
): Promise<CollectResult> {
  const [rows, list] = await Promise.all([
    readings,
    stations.catch((err) => {
      console.error("Stationen für die Stationsliste nicht abrufbar:", err);
      return [];
    }),
  ]);
  return { rows, stations: list };
}

export const WIND_SOURCES: Record<SourceId, WindSource> = {
  bolzano: {
    live: fetchBolzanoStations,
    // Messwerte und Stationen aus EINEM Abruf von /sensors (siehe bolzano.ts).
    collect: async () => {
      const { readings, stations } = await fetchBolzanoForCollect();
      return { rows: fromReadings(readings, "bolzano"), stations };
    },
  },
  openwindmap: {
    live: fetchOpenWindMapStations,
    collect: async () => fromStations(await fetchOpenWindMapStations()),
  },
  slf: {
    live: fetchSlfStations,
    collect: (sinceMs) =>
      withStations(
        fetchSlfReadingsSince(sinceMs).then((r) => fromReadings(r, "slf")),
        fetchSlfStations(),
      ),
  },
  geosphere: {
    live: fetchGeoSphereStations,
    collect: async () => fromStations(await fetchGeoSphereStations()),
  },
  meteoswiss: {
    live: fetchMeteoSwissStations,
    collect: async () => fromStations(await fetchMeteoSwissStations()),
  },
  lwdtirol: {
    live: fetchLwdTirolStations,
    collect: async () => fromStations(await fetchLwdTirolStations()),
  },
  dwd: {
    live: fetchDwdStations,
    collect: (sinceMs) =>
      withStations(
        fetchDwdReadingsSince(sinceMs).then((r) => fromReadings(r, "dwd")),
        fetchDwdStations(),
      ),
  },
};

/** Alle Quellen-Kennungen ("bolzano", "openwindmap", …). */
export const SOURCE_IDS = Object.keys(WIND_SOURCES) as SourceId[];
