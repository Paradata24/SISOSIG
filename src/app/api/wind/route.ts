import { NextResponse } from "next/server";
import type { WindStation } from "@/lib/wind";

// Open-Data-Webservice der Provinz Bozen für Wetter-/Pegelstationen.
// Datensatz: https://data.civis.bz.it/de/dataset/misure-meteo-e-idrografiche
const API_BASE =
  process.env.WIND_API_BASE_URL ??
  "http://daten.buergernetz.bz.it/services/meteo/v1";

// Stationen, die zusätzlich zur automatisch gewählten Station immer
// angezeigt werden. Abgleich über den normalisierten Stationsnamen
// (Groß-/Kleinschreibung und Leerzeichen egal), da die Stationscodes
// des Dienstes nicht dokumentiert sind.
const FEATURED_STATION_NAMES = ["rittnerhorn"];

interface SensorReading {
  SCODE: string;
  TYPE: string;
  DESC_D: string;
  UNIT: string;
  DATE: string;
  VALUE: number | null;
}

interface StationMeta {
  SCODE: string;
  NAME_D?: string;
  NAME_I?: string;
  LAT?: number;
  LONG?: number;
  ALT?: number;
}

// Manche OGC/CKAN-Endpunkte liefern Stationen als flache Liste, andere als
// GeoJSON-FeatureCollection (Koordinaten unter geometry.coordinates). Beide
// Formen werden hier auf eine einheitliche Form gebracht.
function normalizeStations(raw: unknown): StationMeta[] {
  if (Array.isArray(raw)) return raw as StationMeta[];

  if (raw && typeof raw === "object" && Array.isArray((raw as { features?: unknown }).features)) {
    const features = (raw as { features: Array<Record<string, unknown>> }).features;
    return features.map((f) => {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const coords = (f.geometry as { coordinates?: [number, number] } | undefined)
        ?.coordinates;
      return {
        SCODE: String(props.SCODE ?? ""),
        NAME_D: props.NAME_D as string | undefined,
        NAME_I: props.NAME_I as string | undefined,
        ALT: props.ALT as number | undefined,
        LAT: (props.LAT as number | undefined) ?? coords?.[1],
        LONG: (props.LONG as number | undefined) ?? coords?.[0],
      };
    });
  }

  return [];
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-zäöüß]/g, "");
}

function toKmh(value: number, unit: string | undefined): number {
  if (unit && unit.toLowerCase().includes("m/s")) return value * 3.6;
  return value;
}

const isDirection = (desc: string) => /windrichtung/i.test(desc);
const isSpeed = (desc: string) =>
  /windgeschwindigkeit/i.test(desc) && !/böe/i.test(desc);
const isGust = (desc: string) => /böe/i.test(desc);
const hasCoords = (meta: StationMeta | undefined): meta is StationMeta =>
  typeof meta?.LAT === "number" && typeof meta?.LONG === "number";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedStations = searchParams.get("station");

  let sensors: SensorReading[];
  try {
    const res = await fetch(`${API_BASE}/sensors`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Wetterdienst antwortete mit Status ${res.status}` },
        { status: 502 },
      );
    }
    sensors = await res.json();
  } catch {
    return NextResponse.json(
      { error: "Wetterdienst der Provinz Bozen ist nicht erreichbar" },
      { status: 502 },
    );
  }

  let stationsByCode = new Map<string, StationMeta>();
  try {
    const res = await fetch(`${API_BASE}/stations`, { cache: "no-store" });
    if (res.ok) {
      const stations = normalizeStations(await res.json());
      stationsByCode = new Map(stations.map((s) => [s.SCODE, s]));
    } else {
      console.error(`Stationsmetadaten: Status ${res.status}`);
    }
  } catch (err) {
    // Stationsmetadaten (Name, Koordinaten) sind optional; ohne sie
    // liefern wir trotzdem die Sensordaten zurück.
    console.error("Stationsmetadaten nicht abrufbar:", err);
  }

  const byStation = new Map<string, SensorReading[]>();
  for (const s of sensors) {
    if (!byStation.has(s.SCODE)) byStation.set(s.SCODE, []);
    byStation.get(s.SCODE)!.push(s);
  }

  const hasDirection = (r: SensorReading) => isDirection(r.DESC_D);
  const hasSpeed = (r: SensorReading) => isSpeed(r.DESC_D);
  const hasWind = (readings: SensorReading[]) =>
    readings.some(hasDirection) || readings.some(hasSpeed);

  function buildWindStation(code: string): WindStation | null {
    const readings = byStation.get(code);
    if (!readings) return null;

    const dirReading = readings.find(hasDirection);
    const speedReading = readings.find(hasSpeed);
    const gustReading = readings.find((r) => isGust(r.DESC_D));
    const meta = stationsByCode.get(code);

    return {
      stationCode: code,
      stationName: meta?.NAME_D ?? meta?.NAME_I ?? code,
      lat: meta?.LAT ?? null,
      lng: meta?.LONG ?? null,
      altitude: meta?.ALT ?? null,
      direction: dirReading?.VALUE ?? null,
      speedKmh:
        speedReading?.VALUE != null
          ? Math.round(toKmh(speedReading.VALUE, speedReading.UNIT) * 10) / 10
          : null,
      gustKmh:
        gustReading?.VALUE != null
          ? Math.round(toKmh(gustReading.VALUE, gustReading.UNIT) * 10) / 10
          : null,
      timestamp: speedReading?.DATE ?? dirReading?.DATE ?? null,
    };
  }

  // Zu zeigende Stationen bestimmen (Reihenfolge, ohne Duplikate):
  // 1. Explizit per ?station=CODE1,CODE2 angefragte Stationen — oder sonst:
  // 2. Die erste Station mit Windrichtung + -geschwindigkeit UND Koordinaten.
  // 3. Die konfigurierten Stationen (FEATURED_STATION_NAMES), per Name gesucht.
  const codes: string[] = [];

  if (requestedStations) {
    for (const code of requestedStations.split(",").map((c) => c.trim())) {
      if (code && byStation.has(code) && !codes.includes(code)) codes.push(code);
    }
  } else {
    for (const [code, readings] of byStation) {
      if (
        readings.some(hasDirection) &&
        readings.some(hasSpeed) &&
        hasCoords(stationsByCode.get(code))
      ) {
        codes.push(code);
        break;
      }
    }

    for (const featured of FEATURED_STATION_NAMES) {
      for (const [code, meta] of stationsByCode) {
        const names = [meta.NAME_D, meta.NAME_I].filter(
          (n): n is string => typeof n === "string",
        );
        const matches = names.some((n) => normalizeName(n).includes(featured));
        if (!matches || codes.includes(code)) continue;
        const readings = byStation.get(code);
        if (readings && hasWind(readings) && hasCoords(meta)) codes.push(code);
      }
    }
  }

  const stations = codes
    .map(buildWindStation)
    .filter((s): s is WindStation => s !== null);

  if (stations.length === 0) {
    return NextResponse.json(
      { error: "Keine Station mit Winddaten und Koordinaten gefunden" },
      { status: 404 },
    );
  }

  return NextResponse.json(stations);
}
