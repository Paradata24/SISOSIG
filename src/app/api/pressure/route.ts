import { NextResponse } from "next/server";
import { DATABASE_TIMEOUT_MS, HISTORY_HOURS } from "@/lib/wind";
import { fetchMetarPressure } from "@/lib/metar";
import {
  PRESSURE_STALE_AFTER_MS,
  PRESSURE_STATION_IDS,
  type PressurePayload,
  type PressureStationId,
} from "@/lib/pressure";

// Luftdruck (QNH) der Flughäfen Innsbruck und Bozen für die Föhn-Anzeige
// (src/lib/pressure.ts): gemessen (METAR) der letzten HISTORY_HOURS und die
// ICON-CH1-Prognose, beides aus der Tabelle pressure_values. Gefüllt wird sie
// vom Sammler (/api/collect, Messwerte) und der Edge Function
// fetch-wind-forecasts (Prognose) — "Ein Sammler, eine Wahrheit".
//
// NOTBETRIEB wie bei /api/wind: Antwortet die Datenbank nicht oder fehlt dort
// ein frischer Messwert (z. B. Sammler ausgefallen, oder kurz nach dem
// Einbau, bevor er gelaufen ist), holt die Route die Messwerte direkt beim
// Flugwetterdienst. Die Prognose gibt es nur aus der Datenbank.
//
// Aufruf: /api/pressure

// Wie /api/history: 60 s im CDN, kurze Nachfrist. Die Flughäfen melden nur
// alle 30–60 min, öfter neu zu fragen brächte nichts.
const RESPONSE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=30";

// Höchstens so viele Zeilen (Supabase gibt je Anfrage bis zu 1000 heraus).
// Erwartet: ~150 Messwerte + ~170 Prognosestunden in 48 h + 33 h Vorschau.
const MAX_ROWS = 1000;

export const dynamic = "force-dynamic";

interface PressureRow {
  station: string;
  kind: string;
  valid_at: string;
  qnh_hpa: number;
  model_run: string | null;
}

function emptySeries(): Record<PressureStationId, Array<[number, number]>> {
  return Object.fromEntries(PRESSURE_STATION_IDS.map((id) => [id, []])) as unknown as Record<
    PressureStationId,
    Array<[number, number]>
  >;
}

async function readDatabase(sinceIso: string): Promise<PressureRow[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase ist nicht konfiguriert");
  const res = await fetch(
    `${supabaseUrl}/rest/v1/pressure_values` +
      `?valid_at=gte.${encodeURIComponent(sinceIso)}` +
      `&order=valid_at.asc&limit=${MAX_ROWS}` +
      `&select=station,kind,valid_at,qnh_hpa,model_run`,
    {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Supabase antwortete mit Status ${res.status}`);
  return (await res.json()) as PressureRow[];
}

export async function GET() {
  const now = Date.now();
  const since = now - HISTORY_HOURS * 60 * 60 * 1000;
  const measured = emptySeries();
  const forecast = emptySeries();
  let modelRun: string | null = null;

  let databaseOk = true;
  try {
    for (const row of await readDatabase(new Date(since).toISOString())) {
      const station = PRESSURE_STATION_IDS.find((id) => id === row.station);
      const time = Date.parse(row.valid_at);
      if (!station || Number.isNaN(time) || typeof row.qnh_hpa !== "number") continue;
      if (row.kind === "metar") {
        measured[station].push([time, row.qnh_hpa]);
      } else if (row.kind === "icon_ch1") {
        forecast[station].push([time, row.qnh_hpa]);
        // Jüngster Lauf (ältere Stunden stammen teils aus früheren Läufen).
        if (row.model_run && (!modelRun || row.model_run > modelRun)) modelRun = row.model_run;
      }
    }
  } catch (err) {
    console.error("Luftdruck aus der Datenbank nicht lesbar:", err);
    databaseOk = false;
  }

  // Notbetrieb: für irgendeinen Flughafen kein frischer Messwert gespeichert.
  const fresh = PRESSURE_STATION_IDS.every((id) => {
    const last = measured[id][measured[id].length - 1];
    return last !== undefined && now - last[0] <= PRESSURE_STALE_AFTER_MS;
  });
  let fallback = false;
  if (!databaseOk || !fresh) {
    try {
      const direct = await fetchMetarPressure(HISTORY_HOURS);
      if (direct.length > 0) {
        const replaced = emptySeries();
        for (const p of direct) {
          const time = Date.parse(p.observedAt);
          if (time >= since) replaced[p.station].push([time, p.qnhHpa]);
        }
        for (const id of PRESSURE_STATION_IDS) {
          replaced[id].sort((a, b) => a[0] - b[0]);
          measured[id] = replaced[id];
        }
        fallback = true;
      }
    } catch (err) {
      console.error("Luftdruck (METAR) im Notbetrieb nicht abrufbar:", err);
    }
  }

  const hasAny = PRESSURE_STATION_IDS.some((id) => measured[id].length > 0 || forecast[id].length > 0);
  if (!hasAny) {
    return NextResponse.json({ error: "Keine Druckwerte verfügbar" }, { status: 502 });
  }

  const payload: PressurePayload = { measured, forecast, modelRun, fallback };
  return NextResponse.json(payload, { headers: { "Cache-Control": RESPONSE_CACHE_CONTROL } });
}
