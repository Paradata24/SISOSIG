// Supabase Edge Function "fetch-wind-forecasts": holt ICON-CH1-Windprognosen
// von Open-Meteo für alle Südtiroler Wetterstationen mit Windsensoren
// (Bozner Wetterdienst UND Südtiroler OpenWindMap/Pioupiou-Stationen) und
// schreibt sie per Upsert in die Supabase-Tabelle wind_forecasts
// (Schema: supabase/forecast-schema.sql).
//
// Warum eine Edge Function und kein reiner SQL-Cron-Job: pg_net arbeitet
// asynchron (die Antwort läge erst nach dem Cron-Lauf vor) und das Parsen
// der verschachtelten Open-Meteo-JSON wäre in SQL fehleranfällig. Hier in
// TypeScript ist beides einfach und gut zu loggen. Angestoßen wird die
// Funktion stündlich von pg_cron + pg_net (siehe supabase/forecast-cron.sql).
//
// Ablauf pro Aufruf:
//   1. Zugriffsschutz: nur POST mit "Authorization: Bearer <service_role Key>"
//      (gleiches Muster wie CRON_SECRET bei /api/collect).
//   2. Stationsliste ableiten: Bozner Wetterdienst — exakt dieselbe Logik
//      wie /api/wind: nur Stationen mit Windsensoren UND Koordinaten,
//      deterministisch nach Stationscode sortiert — plus Südtiroler
//      OpenWindMap/Pioupiou-Stationen (Bounding-Box-Filter, additiv).
//   3. Bodenwind in Batches (je 50 Stationen, Koordinaten komma-getrennt)
//      abfragen — für ZWEI Modelle: meteoswiss_icon_ch1 (model 'icon_ch1')
//      und dwd_icon_d2 (model 'icon_d2'), damit sich beide Prognosen
//      vergleichen lassen. Letzte 12 h + kommende ~7 h, Einheit km/h (wie in
//      wind_measurements), Zeiten als Unix-Sekunden (eindeutig UTC). Die
//      Antwort-Liste hat dieselbe Reihenfolge wie die Koordinaten und wird
//      per Index den Stationen zugeordnet.
//   4. Stunden ohne Werte (Station am/außerhalb des Modellrands liefert
//      null) werden übersprungen; der Rest wird per Upsert gespeichert
//      (on_conflict station_code,model,forecast_time).
//   5. Prognosen älter als 2 Tage löschen (wie bei wind_measurements).
//
// Umgebungsvariablen: SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY werden von
// Supabase automatisch in jede Edge Function injiziert — es müssen keine
// eigenen Secrets gesetzt werden. WIND_API_BASE_URL / OPEN_METEO_BASE_URL
// sind optionale Overrides für Tests mit einem lokalen Mock-Server.

const WIND_API_BASE =
  Deno.env.get("WIND_API_BASE_URL") ??
  "http://daten.buergernetz.bz.it/services/meteo/v1";

const OPEN_METEO_BASE =
  Deno.env.get("OPEN_METEO_BASE_URL") ?? "https://api.open-meteo.com";

const PIOUPIOU_API_BASE =
  Deno.env.get("PIOUPIOU_API_BASE_URL") ?? "https://api.pioupiou.fr/v1";

// Grobe Bounding Box Südtirol — identisch zu src/lib/pioupiou.ts (dort für
// /api/wind und /api/collect, hier separat dupliziert, weil diese Edge
// Function unter Deno läuft und nichts aus src/lib importieren kann).
const SOUTH_TYROL_BBOX = { latMin: 46.2, latMax: 47.1, lngMin: 10.3, lngMax: 12.5 };
const PIOUPIOU_CODE_PREFIX = "pioupiou-";

// Modellnamen in der Datenbank (Spalte "model") — kurz und stabil. Es werden
// zwei Zeilen-Sorten gespeichert:
//   'icon_ch1' — Bodenwind aus MeteoSwiss ICON-CH1 (rote Kurve im Panel)
//   'icon_d2'  — Bodenwind aus DWD ICON-D2 (blaue Kurve im Panel)
const MODEL_DB = "icon_ch1";
const MODEL_D2_DB = "icon_d2";
// Modellname, den die Open-Meteo-API für ICON-CH1 erwartet.
const MODEL_API = "meteoswiss_icon_ch1";
// Modellname, den die Open-Meteo-API für ICON-D2 erwartet. ICON-D2 ist
// hochauflösend (~2 km) und deckt den Alpenraum inkl. Südtirol ab.
const MODEL_D2_API = "dwd_icon_d2";

// Rollendes Zeitfenster je Lauf. Die Werte spiegeln HISTORY_HOURS (12) und
// FUTURE_MARGIN_HOURS (4) aus src/lib/wind.ts — Deno kann von dort nicht
// importieren, deshalb bei einer Änderung beide Stellen anfassen.
const PAST_HOURS = 12;
// Bewusst MEHR als FUTURE_MARGIN_HOURS (4): Open-Meteo zählt ab der aktuellen
// vollen Stunde, und diese Funktion läuft nur stündlich (pg_cron, Minute 10).
// Kurz vor dem nächsten Lauf ist der jüngste Datensatz also fast eine Stunde
// alt; mit 7 Stunden ist der angezeigte Bereich bis "jetzt + 4h" auch im
// ungünstigsten Fall lückenlos gefüllt. /api/forecast schneidet den Überhang
// beim Ausliefern wieder ab.
const FORECAST_HOURS = 7;
// Aufbewahrung wie bei den Messwerten (/api/collect): 2 Tage reichen für die
// 12h-Anzeige mit großem Puffer.
const RETENTION_DAYS = 2;

// Stationen pro Open-Meteo-Request. Überschreibbar für Tests, damit sich
// das Batching auch mit wenigen Mock-Stationen prüfen lässt.
const BATCH_SIZE = Number(Deno.env.get("FORECAST_BATCH_SIZE") ?? "50");

interface SensorReading {
  SCODE: string;
  DESC_D: string;
}

interface StationMeta {
  SCODE: string;
  LAT?: number;
  LONG?: number;
}

interface Station {
  code: string;
  lat: number;
  lng: number;
}

interface ForecastRow {
  station_code: string;
  model: string;
  forecast_time: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
  fetched_at: string;
}

// Antwortform eines Standorts bei Open-Meteo (timeformat=unixtime).
interface OpenMeteoLocation {
  hourly?: {
    time?: number[];
    wind_speed_10m?: Array<number | null>;
    wind_direction_10m?: Array<number | null>;
    wind_gusts_10m?: Array<number | null>;
  };
}

// Windsensor-Erkennung per deutscher Beschreibung — identisch zu
// /api/wind und /api/collect (die TYPE-Codes sind nirgends dokumentiert).
const isWindSensor = (desc: string) =>
  /windrichtung|windgeschwindigkeit|böe/i.test(desc);

// Manche OGC/CKAN-Endpunkte liefern Stationen als flache Liste, andere als
// GeoJSON-FeatureCollection — gleiche Normalisierung wie in /api/wind.
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
        LAT: (props.LAT as number | undefined) ?? coords?.[1],
        LONG: (props.LONG as number | undefined) ?? coords?.[0],
      };
    });
  }

  return [];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Stationen mit Windsensoren und Koordinaten aus dem Bozner Wetterdienst
// ableiten — dieselben zwei Anfragen (/sensors + /stations) wie /api/wind.
async function loadStations(): Promise<Station[]> {
  const sensorsRes = await fetch(`${WIND_API_BASE}/sensors`);
  if (!sensorsRes.ok) {
    throw new Error(`Wetterdienst /sensors antwortete mit Status ${sensorsRes.status}`);
  }
  const sensors: SensorReading[] = await sensorsRes.json();

  const stationsRes = await fetch(`${WIND_API_BASE}/stations`);
  if (!stationsRes.ok) {
    throw new Error(`Wetterdienst /stations antwortete mit Status ${stationsRes.status}`);
  }
  const metaByCode = new Map(
    normalizeStations(await stationsRes.json()).map((s) => [s.SCODE, s]),
  );

  const windCodes = new Set<string>();
  for (const s of sensors) {
    if (isWindSensor(s.DESC_D)) windCodes.add(s.SCODE);
  }

  const stations: Station[] = [];
  for (const code of windCodes) {
    const meta = metaByCode.get(code);
    // Ohne Koordinaten keine Prognose-Abfrage möglich — Station überspringen
    // (gleiche Regel wie auf der Karte).
    if (typeof meta?.LAT !== "number" || typeof meta?.LONG !== "number") continue;
    stations.push({ code, lat: meta.LAT, lng: meta.LONG });
  }

  // Deterministische Reihenfolge, damit Batches über Läufe hinweg stabil sind.
  stations.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return stations;
}

// Antwortform einer Pioupiou-Station (nur die für die Prognose nötigen
// Felder — dieselbe Quelle wie /api/wind und /api/collect).
interface PioupiouStation {
  id: number;
  location?: { latitude?: number; longitude?: number; success?: boolean };
}

// Südtiroler Pioupiou-Stationen laden (Bounding-Box-Filter, siehe oben).
// Läuft unabhängig von loadStations() — ein Fehler hier lässt die Bozner
// Prognosen trotzdem weiterlaufen (siehe try/catch beim Aufruf).
async function loadOpenWindMapStations(): Promise<Station[]> {
  const res = await fetch(`${PIOUPIOU_API_BASE}/live/all`);
  if (!res.ok) {
    throw new Error(`OpenWindMap antwortete mit Status ${res.status}`);
  }
  const body: unknown = await res.json();
  const raw: PioupiouStation[] = Array.isArray(body)
    ? (body as PioupiouStation[])
    : ((body as { data?: PioupiouStation[] })?.data ?? []);

  const stations: Station[] = [];
  for (const s of raw) {
    const loc = s.location;
    if (
      !loc?.success ||
      typeof loc.latitude !== "number" ||
      typeof loc.longitude !== "number"
    ) {
      continue;
    }
    if (
      loc.latitude < SOUTH_TYROL_BBOX.latMin ||
      loc.latitude > SOUTH_TYROL_BBOX.latMax ||
      loc.longitude < SOUTH_TYROL_BBOX.lngMin ||
      loc.longitude > SOUTH_TYROL_BBOX.lngMax
    ) {
      continue;
    }
    stations.push({ code: `${PIOUPIOU_CODE_PREFIX}${s.id}`, lat: loc.latitude, lng: loc.longitude });
  }
  return stations;
}

// Einen Batch Stationen bei Open-Meteo abfragen und zu Tabellenzeilen
// aufbereiten. Die Antwort ist eine Liste in derselben Reihenfolge wie die
// übergebenen Koordinaten (bei nur einer Station ein einzelnes Objekt).
async function fetchForecastBatch(
  batch: Station[],
  fetchedAt: string,
  modelApi: string,
  modelDb: string,
): Promise<{ rows: ForecastRow[]; skippedNullHours: number }> {
  const params = new URLSearchParams({
    latitude: batch.map((s) => s.lat).join(","),
    longitude: batch.map((s) => s.lng).join(","),
    models: modelApi,
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    wind_speed_unit: "kmh",
    past_hours: String(PAST_HOURS),
    forecast_hours: String(FORECAST_HOURS),
    // Unix-Sekunden statt lokaler Zeitangaben — eindeutig UTC, passend zu
    // den timestamptz-Spalten (wie bei wind_measurements).
    timeformat: "unixtime",
  });

  const res = await fetch(`${OPEN_METEO_BASE}/v1/forecast?${params}`);
  if (!res.ok) {
    throw new Error(`Open-Meteo antwortete mit Status ${res.status}: ${await res.text()}`);
  }

  const data: unknown = await res.json();
  if (data && typeof data === "object" && (data as { error?: boolean }).error) {
    throw new Error(`Open-Meteo meldet Fehler: ${(data as { reason?: string }).reason}`);
  }
  const locations = (Array.isArray(data) ? data : [data]) as OpenMeteoLocation[];
  if (locations.length !== batch.length) {
    throw new Error(
      `Open-Meteo lieferte ${locations.length} Standorte, erwartet waren ${batch.length}`,
    );
  }

  const rows: ForecastRow[] = [];
  let skippedNullHours = 0;

  locations.forEach((loc, i) => {
    const station = batch[i];
    const hourly = loc.hourly;
    if (!hourly?.time) return;

    hourly.time.forEach((t, k) => {
      const speed = hourly.wind_speed_10m?.[k] ?? null;
      const direction = hourly.wind_direction_10m?.[k] ?? null;
      const gust = hourly.wind_gusts_10m?.[k] ?? null;
      // Station am/außerhalb des Modellrands: Open-Meteo liefert null —
      // solche Stunden sauber überspringen statt leere Zeilen zu speichern.
      if (speed === null && direction === null && gust === null) {
        skippedNullHours++;
        return;
      }
      rows.push({
        station_code: station.code,
        model: modelDb,
        forecast_time: new Date(t * 1000).toISOString(),
        direction,
        speed_kmh: speed !== null ? round1(speed) : null,
        gust_kmh: gust !== null ? round1(gust) : null,
        fetched_at: fetchedAt,
      });
    });
  });

  return { rows, skippedNullHours };
}

export async function handleRequest(request: Request): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (request.method !== "POST") {
    return json({ error: "Nur POST erlaubt" }, 405);
  }

  // 1) Zugriffsschutz: nur mit dem service_role Key als Bearer-Token
  //    ausführen (denselben Wert schickt der pg_cron-Job mit).
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt" }, 500);
  }
  if (request.headers.get("authorization") !== `Bearer ${serviceKey}`) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  // 2) Stationsliste ableiten: Bozner Stationen (Pflicht) + Südtiroler
  //    OpenWindMap-Stationen (additiv — ein Fehler hier bricht den Lauf
  //    nicht ab, es gibt dann eben keine Prognosen für diese Stationen).
  let stations: Station[];
  try {
    stations = await loadStations();
  } catch (err) {
    console.error("Stationsliste nicht abrufbar:", err);
    return json({ error: `Stationsliste nicht abrufbar: ${(err as Error).message}` }, 502);
  }
  try {
    stations = [...stations, ...(await loadOpenWindMapStations())];
  } catch (err) {
    console.error("OpenWindMap-Stationsliste nicht abrufbar:", err);
  }
  if (stations.length === 0) {
    return json({ error: "Keine Station mit Windsensoren und Koordinaten gefunden" }, 502);
  }

  // 3) Bodenwind batchweise abfragen — für BEIDE Modelle (ICON-CH1 und
  //    ICON-D2), damit sich die zwei Prognosen im Panel vergleichen lassen.
  //    Ein fehlgeschlagener Batch bricht nicht den ganzen Lauf ab — die
  //    übrigen Stationen werden trotzdem gespeichert, der Fehler wird
  //    geloggt und in der Antwort gemeldet.
  const fetchedAt = new Date().toISOString();
  const rows: ForecastRow[] = [];
  let skippedNullHours = 0;
  const batchErrors: string[] = [];

  const surfaceModels = [
    { api: MODEL_API, db: MODEL_DB },
    { api: MODEL_D2_API, db: MODEL_D2_DB },
  ];
  for (const model of surfaceModels) {
    for (let i = 0; i < stations.length; i += BATCH_SIZE) {
      const batch = stations.slice(i, i + BATCH_SIZE);
      try {
        const result = await fetchForecastBatch(batch, fetchedAt, model.api, model.db);
        rows.push(...result.rows);
        skippedNullHours += result.skippedNullHours;
      } catch (err) {
        const message = `Batch ${model.db} ab Station ${batch[0].code}: ${(err as Error).message}`;
        console.error(message);
        batchErrors.push(message);
      }
    }
  }

  if (rows.length === 0) {
    return json(
      { error: "Keine Prognosewerte erhalten", batchErrors },
      502,
    );
  }

  // 4) Upsert: vorhandene (station_code, model, forecast_time)-Kombinationen
  //    werden aktualisiert statt doppelt angelegt.
  const supabaseHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const insertRes = await fetch(
    `${supabaseUrl}/rest/v1/wind_forecasts?on_conflict=station_code,model,forecast_time`,
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
    return json(
      {
        error: `Supabase-Upsert schlug fehl (Status ${insertRes.status})`,
        details: await insertRes.text(),
      },
      502,
    );
  }

  // 5) Aufräumen: Prognosen älter als RETENTION_DAYS Tage löschen.
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  let cleanupOk = true;
  const deleteRes = await fetch(
    `${supabaseUrl}/rest/v1/wind_forecasts?forecast_time=lt.${encodeURIComponent(cutoff)}`,
    { method: "DELETE", headers: supabaseHeaders },
  );
  if (!deleteRes.ok) {
    // Aufräumen ist unkritisch — Fehler nur protokollieren, nicht abbrechen.
    console.error(`WARNUNG: Aufräumen alter Prognosen schlug fehl (Status ${deleteRes.status})`);
    cleanupOk = false;
  }

  return json({
    ok: true,
    models: [MODEL_DB, MODEL_D2_DB],
    stations: stations.length,
    saved: rows.length,
    ch1Saved: rows.filter((r) => r.model === MODEL_DB).length,
    d2Saved: rows.filter((r) => r.model === MODEL_D2_DB).length,
    skippedNullHours,
    batchErrors,
    cleanupBefore: cutoff,
    cleanupOk,
  });
}

Deno.serve(handleRequest);
