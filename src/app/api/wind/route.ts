import { NextResponse } from "next/server";
import type { WindStation } from "@/lib/wind";
import { fetchOpenWindMapStations } from "@/lib/pioupiou";

// Open-Data-Webservice der Provinz Bozen für Wetter-/Pegelstationen.
// Datensatz: https://data.civis.bz.it/de/dataset/misure-meteo-e-idrografiche
// Zwei Anfragen genügen für alle Stationen: /sensors liefert die aktuellen
// Messwerte ALLER Stationen auf einmal, /stations alle Metadaten.
const API_BASE =
  process.env.WIND_API_BASE_URL ??
  "http://daten.buergernetz.bz.it/services/meteo/v1";

// Messwerte, die älter sind als diese Schwelle, gelten als ausgefallen
// (die Stationen messen normalerweise alle 5-10 Minuten).
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

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

// Der Dienst liefert Zeitstempel wie "2026-07-13T14:10:00CEST" — das ist
// kein gültiges ISO 8601 und von JavaScript nicht parsebar. Die Zeitzonen-
// Kürzel werden deshalb durch numerische Offsets ersetzt.
function toIsoTimestamp(date: string | undefined): string | null {
  if (!date) return null;
  return date.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
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
    console.error("Stationsmetadaten nicht abrufbar:", err);
  }

  const byStation = new Map<string, SensorReading[]>();
  for (const s of sensors) {
    if (!byStation.has(s.SCODE)) byStation.set(s.SCODE, []);
    byStation.get(s.SCODE)!.push(s);
  }

  const hasDirection = (r: SensorReading) => isDirection(r.DESC_D);
  const hasSpeed = (r: SensorReading) => isSpeed(r.DESC_D);
  const now = Date.now();

  function buildWindStation(code: string): WindStation | null {
    const readings = byStation.get(code);
    if (!readings) return null;

    // Nur Stationen mit Windsensoren; alle anderen (reine Pegel-/
    // Temperaturstationen) werden gar nicht erst zurückgegeben.
    const dirReading = readings.find(hasDirection);
    const speedReading = readings.find(hasSpeed);
    if (!dirReading && !speedReading) return null;

    // Ohne Koordinaten kann kein Marker platziert werden.
    const meta = stationsByCode.get(code);
    if (!hasCoords(meta)) return null;

    const gustReading = readings.find((r) => isGust(r.DESC_D));
    const timestamp = toIsoTimestamp(speedReading?.DATE ?? dirReading?.DATE);

    const direction = dirReading?.VALUE ?? null;
    const speedKmh =
      speedReading?.VALUE != null
        ? Math.round(toKmh(speedReading.VALUE, speedReading.UNIT) * 10) / 10
        : null;

    // Station gilt als ausgefallen, wenn Richtung oder Geschwindigkeit
    // fehlen (ohne Richtung kann kein Pfeil gezeichnet werden) oder der
    // letzte Messwert zu alt ist.
    const measuredAt = timestamp ? Date.parse(timestamp) : NaN;
    const stale =
      direction === null ||
      speedKmh === null ||
      Number.isNaN(measuredAt) ||
      now - measuredAt > STALE_AFTER_MS;

    return {
      stationCode: code,
      stationName: meta.NAME_D ?? meta.NAME_I ?? code,
      lat: meta.LAT ?? null,
      lng: meta.LONG ?? null,
      altitude: meta.ALT ?? null,
      direction,
      speedKmh,
      gustKmh:
        gustReading?.VALUE != null
          ? Math.round(toKmh(gustReading.VALUE, gustReading.UNIT) * 10) / 10
          : null,
      timestamp,
      stale,
      source: "bolzano",
    };
  }

  const bolzanoStations = [...byStation.keys()]
    .map(buildWindStation)
    .filter((s): s is WindStation => s !== null);

  // OpenWindMap/Pioupiou-Stationen sind additiv: schlägt der Abruf fehl
  // (Netzfehler, Dienst nicht erreichbar), zeigt die Karte trotzdem die
  // Bozner Stationen statt komplett zu scheitern.
  let openWindMapStations: WindStation[] = [];
  try {
    openWindMapStations = await fetchOpenWindMapStations();
  } catch (err) {
    console.error("OpenWindMap-Stationen nicht abrufbar:", err);
  }

  let stations = [...bolzanoStations, ...openWindMapStations].sort((a, b) =>
    a.stationName.localeCompare(b.stationName, "de"),
  );

  // Optional gefiltert über ?station=CODE1,CODE2 (für Tests/Debugging;
  // funktioniert auch mit Pioupiou-Codes wie "pioupiou-413").
  if (requestedStations) {
    const wanted = new Set(
      requestedStations.split(",").map((c) => c.trim()).filter(Boolean),
    );
    stations = stations.filter((s) => wanted.has(s.stationCode));
  }

  if (stations.length === 0) {
    return NextResponse.json(
      { error: "Keine Station mit Winddaten und Koordinaten gefunden" },
      { status: 404 },
    );
  }

  return NextResponse.json(stations);
}
