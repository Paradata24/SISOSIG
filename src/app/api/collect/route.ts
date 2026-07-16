import { NextResponse } from "next/server";
import { fetchOpenWindMapStations } from "@/lib/pioupiou";

// Sammel-Route: ruft den Open-Data-Wetterdienst der Provinz Bozen ab und
// schreibt die aktuellen Windwerte aller Stationen in die Supabase-Tabelle
// wind_measurements. Ersetzt den früheren GitHub-Actions-Workflow und wird
// stattdessen von Supabase Cron per POST angestoßen.
//
// Aufruf nur mit gültigem Token:
//   POST /api/collect
//   Header: Authorization: Bearer <CRON_SECRET>
//
// Benötigte serverseitige Umgebungsvariablen (in Vercel hinterlegen):
//   SUPABASE_URL               z.B. https://xyz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service_role Key des Supabase-Projekts
//   CRON_SECRET                selbst gewähltes Geheimnis für den Cron-Aufruf

const API_BASE =
  process.env.WIND_API_BASE_URL ??
  "http://daten.buergernetz.bz.it/services/meteo/v1";

const RETENTION_DAYS = 7;

// Nicht cachen und immer serverseitig zur Laufzeit ausführen — sonst würde
// Next.js die Route eventuell zur Build-Zeit vorberechnen.
export const dynamic = "force-dynamic";

interface SensorReading {
  SCODE: string;
  DESC_D: string;
  UNIT?: string;
  DATE?: string;
  VALUE: number | null;
}

const isDirection = (desc: string) => /windrichtung/i.test(desc);
const isSpeed = (desc: string) =>
  /windgeschwindigkeit/i.test(desc) && !/böe/i.test(desc);
const isGust = (desc: string) => /böe/i.test(desc);

// "2026-07-13T14:10:00CEST" → gültiges ISO 8601 mit numerischem Offset.
function toIsoTimestamp(date: string | undefined): string | null {
  if (!date) return null;
  return date.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
}

function toKmh(value: number, unit: string | undefined): number {
  if (unit && unit.toLowerCase().includes("m/s")) return value * 3.6;
  return value;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function POST(request: Request) {
  // 1) Zugriffsschutz: nur mit korrektem Bearer-Token ausführen.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET ist serverseitig nicht gesetzt" },
      { status: 500 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt" },
      { status: 500 },
    );
  }

  const supabaseHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  // 2) Aktuelle Messwerte aller Stationen abrufen.
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

  // 3) Messwerte je Station bündeln und zu Datenbankzeilen aufbereiten.
  const byStation = new Map<string, SensorReading[]>();
  for (const s of sensors) {
    if (!byStation.has(s.SCODE)) byStation.set(s.SCODE, []);
    byStation.get(s.SCODE)!.push(s);
  }

  const rows: Array<{
    station_code: string;
    measured_at: string;
    direction: number | null;
    speed_kmh: number | null;
    gust_kmh: number | null;
    source: "bolzano" | "openwindmap";
  }> = [];

  for (const [code, readings] of byStation) {
    const dir = readings.find((r) => isDirection(r.DESC_D));
    const speed = readings.find((r) => isSpeed(r.DESC_D));
    if (!dir && !speed) continue; // Station ohne Windsensoren

    const gust = readings.find((r) => isGust(r.DESC_D));
    const measuredAt = toIsoTimestamp(speed?.DATE ?? dir?.DATE);
    if (!measuredAt || Number.isNaN(Date.parse(measuredAt))) continue;

    const direction = dir?.VALUE ?? null;
    const speedKmh =
      speed?.VALUE != null ? round1(toKmh(speed.VALUE, speed.UNIT)) : null;
    if (direction === null && speedKmh === null) continue; // kein Messwert

    rows.push({
      station_code: code,
      measured_at: measuredAt,
      direction,
      speed_kmh: speedKmh,
      gust_kmh: gust?.VALUE != null ? round1(toKmh(gust.VALUE, gust.UNIT)) : null,
      source: "bolzano",
    });
  }

  // 3b) OpenWindMap/Pioupiou-Stationen dazuholen — additiv: schlägt der
  //     Abruf fehl, werden trotzdem die Bozner Messwerte gespeichert statt
  //     den ganzen Lauf abzubrechen.
  try {
    const openWindMapStations = await fetchOpenWindMapStations();
    for (const s of openWindMapStations) {
      if (!s.timestamp || Number.isNaN(Date.parse(s.timestamp))) continue;
      if (s.direction === null && s.speedKmh === null) continue; // kein Messwert
      rows.push({
        station_code: s.stationCode,
        measured_at: s.timestamp,
        direction: s.direction,
        speed_kmh: s.speedKmh,
        gust_kmh: s.gustKmh,
        source: "openwindmap",
      });
    }
  } catch (err) {
    console.error("OpenWindMap-Stationen nicht abrufbar:", err);
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "Keine Windmesswerte im Datenbestand gefunden" },
      { status: 502 },
    );
  }

  // 4) Upsert: vorhandene (station_code, measured_at)-Paare werden
  //    aktualisiert statt doppelt angelegt.
  const insertRes = await fetch(
    `${supabaseUrl}/rest/v1/wind_measurements?on_conflict=station_code,measured_at`,
    {
      method: "POST",
      headers: {
        ...supabaseHeaders,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!insertRes.ok) {
    return NextResponse.json(
      {
        error: `Supabase-Insert schlug fehl (Status ${insertRes.status})`,
        details: await insertRes.text(),
      },
      { status: 502 },
    );
  }

  // 5) Aufräumen: Einträge älter als RETENTION_DAYS Tage löschen.
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  let deleted = true;
  const deleteRes = await fetch(
    `${supabaseUrl}/rest/v1/wind_measurements?measured_at=lt.${encodeURIComponent(cutoff)}`,
    { method: "DELETE", headers: supabaseHeaders },
  );
  if (!deleteRes.ok) {
    // Aufräumen ist unkritisch — Fehler nur protokollieren, nicht abbrechen.
    console.error(
      `WARNUNG: Aufräumen alter Einträge schlug fehl (Status ${deleteRes.status})`,
    );
    deleted = false;
  }

  return NextResponse.json({
    ok: true,
    saved: rows.length,
    cleanupBefore: cutoff,
    cleanupOk: deleted,
  });
}
