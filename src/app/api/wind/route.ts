import { NextResponse } from "next/server";
import type { WindStation } from "@/lib/wind";

// Open-Data-Webservice der Provinz Bozen für Wetter-/Pegelstationen.
// Datensatz: https://data.civis.bz.it/de/dataset/misure-meteo-e-idrografiche
const API_BASE =
  process.env.WIND_API_BASE_URL ??
  "http://daten.buergernetz.bz.it/services/meteo/v1";

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
  const requestedStation = searchParams.get("station");

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

  // Ohne explizite Stationsangabe: die erste Station mit vollständigen
  // Winddaten (Richtung + Geschwindigkeit) UND bekannten Koordinaten nehmen,
  // damit garantiert ein Marker auf der Karte platziert werden kann.
  let stationCode = requestedStation ?? undefined;
  if (!stationCode) {
    for (const [code, readings] of byStation) {
      if (
        readings.some(hasDirection) &&
        readings.some(hasSpeed) &&
        hasCoords(stationsByCode.get(code))
      ) {
        stationCode = code;
        break;
      }
    }
  }

  if (!stationCode || !byStation.has(stationCode)) {
    return NextResponse.json(
      { error: "Keine Station mit Winddaten und Koordinaten gefunden" },
      { status: 404 },
    );
  }

  const readings = byStation.get(stationCode)!;
  const dirReading = readings.find(hasDirection);
  const speedReading = readings.find(hasSpeed);
  const gustReading = readings.find((r) => isGust(r.DESC_D));
  const meta = stationsByCode.get(stationCode);

  const result: WindStation = {
    stationCode,
    stationName: meta?.NAME_D ?? meta?.NAME_I ?? stationCode,
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

  return NextResponse.json(result);
}
