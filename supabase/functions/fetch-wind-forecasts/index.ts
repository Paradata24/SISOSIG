// Supabase Edge Function "fetch-wind-forecasts": holt die Windprognose des
// Modells ICON-CH1 (MeteoSwiss) von Open-Meteo für alle Wetterstationen mit
// Windsensoren (Bozner Wetterdienst, Südtiroler OpenWindMap/Pioupiou-
// Stationen, die Schweizer IMIS-Stationen des SLF und alle österreichischen
// GeoSphere-Stationen) und
// schreibt sie per Upsert in die Supabase-Tabelle wind_forecasts
// (Schema: supabase/forecast-schema.sql).
//
// Warum eine Edge Function und kein reiner SQL-Cron-Job: pg_net arbeitet
// asynchron (die Antwort läge erst nach dem Cron-Lauf vor) und das Parsen
// der verschachtelten Open-Meteo-JSON wäre in SQL fehleranfällig. Hier in
// TypeScript ist beides einfach und gut zu loggen. Angestoßen wird die
// Funktion regelmäßig von pg_cron + pg_net (siehe supabase/forecast-cron.sql).
//
// --- NUR BEI EINEM NEUEN MODELLLAUF ABFRAGEN (Sept. 2026) ---
// ICON-CH1 rechnet alle 3 Stunden neu (Läufe 00, 03, 06, … UTC). Laut den
// Metadaten von Open-Meteo (MODEL_META_URL) steht ein Lauf dort rund
// 2 h 20 min nach dem Start bereit — der 00-UTC-Lauf also gegen 02:20 UTC
// (04:20 Uhr Sommerzeit), dann alle 3 Stunden der nächste. Früher fragte die
// Funktion trotzdem jede Stunde alle Stationen ab; zwei von drei Abrufen
// lieferten also nur noch einmal dieselben Zahlen und kosteten nur
// Kontingent.
// Jetzt fragt sie zuerst die (kostenlose, nicht mitgezählte) Metadaten-Datei
// ab: Ist der dort gemeldete neueste Lauf schon gespeichert (jüngstes
// fetched_at in wind_forecasts liegt NACH dessen Bereitstellung), endet der
// Lauf sofort ohne einen einzigen Prognose-Abruf. So kostet es gleich viel,
// ob der Cron-Job stündlich oder alle 15 Minuten läuft — ein häufigerer
// Takt bringt einen neuen Lauf nur schneller auf die Seite.
// Erzwingen lässt sich ein Abruf mit dem Body {"force": true} (z. B. nach
// einer Änderung der Stationsliste).
// RÜCKFALL: Ist die Metadaten-Datei nicht lesbar (so geschehen beim ersten
// Lauf am 29.09.2026), wird NICHT einfach abgefragt — sonst würde jeder
// Cron-Anstoß alle Stationen abfragen und das Kontingent sprengen. Dann gilt
// eine reine Zeitregel: abgefragt wird nur, wenn der letzte Abruf mindestens
// MIN_REFETCH_WITHOUT_META_MS zurückliegt (höchstens ~8-mal am Tag).
//
// --- KONTINGENT ---
// Open-Meteo zählt kostenlos 10.000 "Aufrufe" pro Tag. Laut Quellcode von
// Open-Meteo (calculateQueryWeight) kostet jeder Standort einer Anfrage
// mindestens 1 Aufruf, mehr erst ab 10 Werte-Reihen oder 2 Wochen Zeitraum —
// wir fragen 3 Reihen über 1 Tag ab, also genau 1 je Station. Bei ~580
// Stationen und 8 Modellläufen am Tag sind das ~4.700 Aufrufe (47 %).
//
// Ablauf pro Aufruf:
//   1. Zugriffsschutz: nur POST mit "Authorization: Bearer <service_role Key>"
//      (gleiches Muster wie CRON_SECRET bei /api/collect).
//   2. Stationsliste ableiten: Bozner Wetterdienst — exakt dieselbe Logik
//      wie /api/wind: nur Stationen mit Windsensoren UND Koordinaten,
//      deterministisch nach Stationscode sortiert — plus Südtiroler
//      OpenWindMap/Pioupiou-Stationen (Bounding-Box-Filter, additiv) — plus
//      die SLF-IMIS-Stationen (Schweiz, additiv; ICON-CH1 deckt die ganze
//      Schweiz ab).
//   (davor: Prüfung, ob es überhaupt einen neuen Modelllauf gibt, s. o.)
//   3. Bodenwind in Batches (je 50 Stationen, Koordinaten komma-getrennt)
//      abfragen — nur ICON-CH1 (meteoswiss_icon_ch1, in der Datenbank
//      'icon_ch1'). Letzte 12 h + kommende 12 h, Einheit km/h (wie in
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

// Adresse des Bozner Dienstes — identisch zu src/app/api/wind/route.ts (dort
// steht, warum sie im Sept. 2026 geändert wurde). Nach einer Änderung hier die
// Funktion im Supabase-Dashboard neu deployen, sonst läuft die alte Adresse
// weiter.
const WIND_API_BASE =
  Deno.env.get("WIND_API_BASE_URL") ??
  "https://geoservices.buergernetz.bz.it/services/meteo/v1";

const OPEN_METEO_BASE =
  Deno.env.get("OPEN_METEO_BASE_URL") ?? "https://api.open-meteo.com";

const PIOUPIOU_API_BASE =
  Deno.env.get("PIOUPIOU_API_BASE_URL") ?? "https://api.pioupiou.fr/v1";

// Grobe Bounding Box Südtirol — identisch zu src/lib/pioupiou.ts (dort für
// /api/wind und /api/collect, hier separat dupliziert, weil diese Edge
// Function unter Deno läuft und nichts aus src/lib importieren kann).
const SOUTH_TYROL_BBOX = { latMin: 46.2, latMax: 47.1, lngMin: 10.3, lngMax: 12.5 };
const PIOUPIOU_CODE_PREFIX = "pioupiou-";

// SLF-IMIS-Stationen — Adresse und Codepräfix identisch zu src/lib/slf.ts
// (auch hier dupliziert, weil Deno nicht aus src/lib importieren kann).
const SLF_API_BASE =
  Deno.env.get("SLF_API_BASE_URL") ?? "https://measurement-api.slf.ch/public/api";
const SLF_CODE_PREFIX = "slf-";

// GeoSphere Austria (früher ZAMG), Messnetz TAWES — identisch zu
// src/lib/geosphere.ts (dort für /api/wind und /api/collect). Es werden nur
// die Metadaten gebraucht (Koordinaten aller Stationen), keine Messwerte.
const GEOSPHERE_API_BASE =
  Deno.env.get("GEOSPHERE_API_BASE_URL") ??
  "https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min";
const GEOSPHERE_CODE_PREFIX = "geosphere-";

// Modellname in der Datenbank (Spalte "model") — kurz und stabil — und der
// dazu passende Modellname der Open-Meteo-API. Gespeichert wird NUR noch
// ICON-CH1 (dunkelgraue, gestrichelte Kurve im Verlaufsbalken).
// Entfernt auf Wunsch des Projektbesitzers:
//   - AROME (GeoSphere Austria, 'arome')
//   - ICON-D2 (DWD, 'icon_d2') — wurde bis Sept. 2026 mitgesammelt, aber nie
//     angezeigt. Alte icon_d2-Zeilen löscht das Aufräumen (RETENTION_DAYS)
//     nach 2 Tagen von selbst.
const MODEL_DB = "icon_ch1";
const MODEL_API = "meteoswiss_icon_ch1";

// Metadaten des Modells bei Open-Meteo: wann der neueste Lauf gestartet und
// wann er bereitgestellt wurde (Unix-Sekunden). Statische Datei, zählt nicht
// zum Kontingent.
const MODEL_META_URL =
  Deno.env.get("OPEN_METEO_META_URL") ??
  `${OPEN_METEO_BASE}/data/${MODEL_API}/static/meta.json`;

// Ostrand des ICON-CH1-Gebiets in Österreich (Längengrad). Am 29.09.2026 für
// alle GeoSphere-Stationen einzeln bei Open-Meteo nachgeprüft: Poysdorf
// (16,637°) liefert noch Werte, alle 10 Stationen ab Lutzmannsburg (16,646°)
// nicht mehr — "No data is available for this location" (u. a. Neusiedl am
// See, Podersdorf, Andau, Hohenau, Gänserndorf). Wien, Eisenstadt und
// Schwechat liegen noch drin. Diese Stationen werden gar nicht erst
// abgefragt, sonst reißt jede einzelne ihren ganzen 50er-Block mit (siehe
// fetchWithSplit unten).
const ICON_CH1_MAX_LNG = 16.64;

function insideIconCh1(station: Station): boolean {
  return station.lng <= ICON_CH1_MAX_LNG;
}

// Zeitregel, falls die Metadaten nicht lesbar sind (s. o.): knapp unter dem
// 3-Stunden-Takt des Modells, damit ein Anstoß alle 3 h sicher durchkommt.
const MIN_REFETCH_WITHOUT_META_MS = 170 * 60 * 1000;

// Rollendes Zeitfenster je Lauf. Bezug: HISTORY_HOURS (24) und
// FUTURE_MARGIN_HOURS (4) aus src/lib/wind.ts — Deno kann von dort nicht
// importieren, deshalb bei einer Änderung beide Stellen prüfen.
// PAST_HOURS darf KLEINER als HISTORY_HOURS sein: Gespeichert wird per Upsert
// und erst nach RETENTION_DAYS gelöscht, ältere Stunden aus früheren Läufen
// bleiben also stehen. Die 12–24 h zurückliegenden Stunden im Verlaufsbalken
// kommen so aus den Läufen von vor bis zu 12 h. Mehr als RETENTION_DAYS kann
// der Verlaufsbalken aber nicht zeigen.
const PAST_HOURS = 12;
// Deutlich MEHR als FUTURE_MARGIN_HOURS (4): Neu geholt wird nur noch alle
// 3 Stunden (bei jedem neuen Modelllauf, s. o.), und Open-Meteo zählt ab der
// aktuellen vollen Stunde. Kurz vor dem nächsten Lauf muss der gespeicherte
// Stand also noch bis "jetzt + 4 h" reichen: bis zu 1 h (angebrochene
// Stunde) + 3 h (bis zum nächsten Lauf) + 4 h = 8 h. 12 h decken zusätzlich
// einen ausgefallenen Lauf ab. Kostet nichts extra (gezählt wird erst ab
// 2 Wochen Zeitraum). /api/forecast schneidet den Überhang wieder ab.
const FORECAST_HOURS = 12;
// Aufbewahrung wie bei den Messwerten (/api/collect): 2 Tage reichen für die
// 24h-Anzeige im Verlaufsbalken.
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
  // Startzeit des Modelllaufs (siehe loadModelRun), null wenn unbekannt.
  // Spalte per supabase/add-model-run-column.sql — die muss VOR dem Deploy
  // dieser Funktion angelegt sein, sonst schlägt der Upsert fehl.
  model_run: string | null;
}

// Antwortform eines Standorts bei Open-Meteo (timeformat=unixtime). Die
// Schlüssel unter "hourly" sind nicht fix, weil bei mehreren Modellen der
// Modellname angehängt wird (z.B. "wind_speed_10m_meteoswiss_icon_ch1") —
// deshalb ein offener Record statt fester Feldnamen.
interface OpenMeteoLocation {
  hourly?: Record<string, unknown>;
}

// Eine Messreihe aus der Antwort holen. Bei nur einem Modell liefert
// Open-Meteo den Namen ohne Suffix ("wind_speed_10m"), bei mehreren mit
// ("wind_speed_10m_meteoswiss_icon_ch1") — beides wird akzeptiert. Fehlt die Reihe ganz (Station außerhalb des Modellgebiets),
// kommt undefined zurück und alle Stunden gelten als leer.
function hourlySeries(
  hourly: Record<string, unknown>,
  variable: string,
  modelApi: string,
): Array<number | null> | undefined {
  const withModel = hourly[`${variable}_${modelApi}`];
  if (Array.isArray(withModel)) return withModel as Array<number | null>;
  const plain = hourly[variable];
  if (Array.isArray(plain)) return plain as Array<number | null>;
  return undefined;
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

// Antwortform einer SLF-Station (nur die für die Prognose nötigen Felder).
interface SlfStationMeta {
  code: string;
  lat?: number;
  lon?: number;
}

// Alle aktiven SLF-IMIS-Stationen laden. Die Stationsliste sagt nicht, welche
// Station Wind misst; die wenigen ohne Windsensor bekommen einfach eine
// Prognose, die nie angezeigt wird (sie erscheinen nicht auf der Karte).
async function loadSlfStations(): Promise<Station[]> {
  const res = await fetch(`${SLF_API_BASE}/imis/stations`);
  if (!res.ok) {
    throw new Error(`SLF-Stationsliste antwortete mit Status ${res.status}`);
  }
  const body: unknown = await res.json();
  const raw = Array.isArray(body) ? (body as SlfStationMeta[]) : [];
  const stations: Station[] = [];
  for (const s of raw) {
    if (typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    stations.push({ code: `${SLF_CODE_PREFIX}${s.code}`, lat: s.lat, lng: s.lon });
  }
  stations.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return stations;
}

// Alle aktiven GeoSphere-Austria-Stationen laden. Ebenfalls additiv, siehe
// try/catch beim Aufruf.
//
// Bis Sept. 2026 waren es nur die 13 grenznahen Stationen (Südtirol-Box),
// weil stündliche Abrufe aller Stationen das Open-Meteo-Kontingent gesprengt
// hätten. Seit nur noch bei neuen Modellläufen abgefragt wird (8× statt
// 24× am Tag, s. o.), ist dafür Platz. Die Metadaten sagen nicht, welche
// Station Wind misst; das gute Dutzend ohne Windsensor bekommt eine
// Prognose, die nie angezeigt wird (wie beim SLF). Die 10 Stationen ganz im
// Osten (Burgenland/Weinviertel) liegen außerhalb des ICON-CH1-Gebiets und
// werden über ICON_CH1_MAX_LNG vorab aussortiert.
interface GeoSphereStationMeta {
  id: string;
  lat?: number;
  lon?: number;
  is_active?: boolean;
}

async function loadGeoSphereStations(): Promise<Station[]> {
  const res = await fetch(`${GEOSPHERE_API_BASE}/metadata`);
  if (!res.ok) {
    throw new Error(`GeoSphere-Metadaten antworteten mit Status ${res.status}`);
  }
  const body = (await res.json()) as { stations?: GeoSphereStationMeta[] };
  const stations: Station[] = [];
  for (const s of body.stations ?? []) {
    if (s.is_active === false || typeof s.lat !== "number" || typeof s.lon !== "number") {
      continue;
    }
    stations.push({ code: `${GEOSPHERE_CODE_PREFIX}${s.id}`, lat: s.lat, lng: s.lon });
  }
  return stations;
}

// Einen Batch Stationen bei Open-Meteo abfragen und zu Tabellenzeilen
// aufbereiten. Die Antwort ist eine Liste in derselben Reihenfolge wie die
// übergebenen Koordinaten (bei nur einer Station ein einzelnes Objekt).
async function fetchForecastBatch(
  batch: Station[],
  fetchedAt: string,
): Promise<{ rows: ForecastRow[]; skippedNullHours: number }> {
  const params = new URLSearchParams({
    latitude: batch.map((s) => s.lat).join(","),
    longitude: batch.map((s) => s.lng).join(","),
    models: MODEL_API,
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
    const times = Array.isArray(hourly?.time)
      ? (hourly.time as Array<number | null>)
      : undefined;
    if (!hourly || !times) return;

    const speeds = hourlySeries(hourly, "wind_speed_10m", MODEL_API);
    const directions = hourlySeries(hourly, "wind_direction_10m", MODEL_API);
    const gusts = hourlySeries(hourly, "wind_gusts_10m", MODEL_API);

    times.forEach((t, k) => {
      if (typeof t !== "number") return;
      const speed = speeds?.[k] ?? null;
      const direction = directions?.[k] ?? null;
      const gust = gusts?.[k] ?? null;
      // Station am/außerhalb des Modellrands: Open-Meteo liefert für alle
      // Variablen null — solche Stunden sauber überspringen statt leere
      // Zeilen zu speichern.
      if (speed === null && direction === null && gust === null) {
        skippedNullHours++;
        return;
      }
      rows.push({
        station_code: station.code,
        model: MODEL_DB,
        forecast_time: new Date(t * 1000).toISOString(),
        direction,
        speed_kmh: speed !== null ? round1(speed) : null,
        gust_kmh: gust !== null ? round1(gust) : null,
        fetched_at: fetchedAt,
        model_run: null, // wird nach dem Abruf aller Batches gesetzt (s. u.)
      });
    });
  });

  return { rows, skippedNullHours };
}

// Neuester ICON-CH1-Lauf laut Open-Meteo: Startzeit (nur für die Antwort)
// und Zeitpunkt der Bereitstellung. null, wenn die Datei nicht lesbar ist.
async function loadModelRun(): Promise<{ runIso: string; availableMs: number } | null> {
  try {
    const res = await fetch(MODEL_META_URL);
    if (!res.ok) {
      console.error(`ICON-CH1-Metadaten: Status ${res.status} (${MODEL_META_URL})`);
      return null;
    }
    const meta = (await res.json()) as {
      last_run_initialisation_time?: number;
      last_run_availability_time?: number;
    };
    if (
      typeof meta.last_run_initialisation_time !== "number" ||
      typeof meta.last_run_availability_time !== "number"
    ) {
      console.error("ICON-CH1-Metadaten: unerwartetes Format", Object.keys(meta ?? {}));
      return null;
    }
    return {
      runIso: new Date(meta.last_run_initialisation_time * 1000).toISOString(),
      availableMs: meta.last_run_availability_time * 1000,
    };
  } catch (err) {
    console.error("ICON-CH1-Metadaten nicht abrufbar:", err);
    return null;
  }
}

// Zeitpunkt des jüngsten gespeicherten ICON-CH1-Abrufs (fetched_at), oder
// null (leere Tabelle oder Fehler → dann wird normal abgefragt).
async function loadLastFetchedMs(
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<number | null> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/wind_forecasts?model=eq.${MODEL_DB}` +
        `&select=fetched_at&order=fetched_at.desc&limit=1`,
      { headers },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ fetched_at?: string }>;
    const t = rows[0]?.fetched_at ? Date.parse(rows[0].fetched_at) : NaN;
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
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

  const supabaseHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  // 1b) Gibt es einen neuen Modelllauf? (siehe "NUR BEI EINEM NEUEN
  //     MODELLLAUF ABFRAGEN" oben). Jeder Fehler dabei führt zum normalen
  //     Abruf — lieber einmal zu viel abfragen als eine Prognose verpassen.
  let force = false;
  try {
    force = ((await request.json()) as { force?: unknown })?.force === true;
  } catch {
    // leerer oder kein JSON-Body (so ruft der Cron-Job auf) — kein force
  }
  const modelRun = await loadModelRun();
  if (!force) {
    const lastFetchedMs = await loadLastFetchedMs(supabaseUrl, supabaseHeaders);
    if (lastFetchedMs !== null) {
      const upToDate = modelRun
        ? lastFetchedMs >= modelRun.availableMs
        : Date.now() - lastFetchedMs < MIN_REFETCH_WITHOUT_META_MS;
      if (upToDate) {
        return json({
          ok: true,
          skipped: true,
          reason: modelRun
            ? "Kein neuer ICON-CH1-Lauf seit dem letzten Abruf"
            : "Metadaten nicht lesbar, letzter Abruf jünger als 170 min",
          modelRun: modelRun?.runIso ?? null,
          lastFetched: new Date(lastFetchedMs).toISOString(),
        });
      }
    }
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
  try {
    stations = [...stations, ...(await loadSlfStations())];
  } catch (err) {
    console.error("SLF-Stationsliste nicht abrufbar:", err);
  }
  try {
    stations = [...stations, ...(await loadGeoSphereStations())];
  } catch (err) {
    console.error("GeoSphere-Stationsliste nicht abrufbar:", err);
  }
  // Stationen außerhalb des Modellgebiets gar nicht erst abfragen (siehe
  // ICON_CH1_MAX_LNG).
  const beforeFilter = stations.length;
  stations = stations.filter(insideIconCh1);
  const outsideFiltered = beforeFilter - stations.length;
  if (stations.length === 0) {
    return json({ error: "Keine Station mit Windsensoren und Koordinaten gefunden" }, 502);
  }

  // 3) Bodenwind (ICON-CH1) batchweise abfragen. Ein fehlgeschlagener
  //    Batch bricht nicht den ganzen Lauf ab — die übrigen Stationen werden
  //    trotzdem gespeichert, der Fehler wird geloggt und in der Antwort
  //    gemeldet.
  const fetchedAt = new Date().toISOString();
  const rows: ForecastRow[] = [];
  let skippedNullHours = 0;
  const batchErrors: string[] = [];

  const outsideModel: string[] = [];

  // Ein Block wird im Fehlerfall halbiert und erneut versucht: Open-Meteo
  // lehnt die GANZE Anfrage ab ("No data is available for this location"),
  // sobald auch nur EINE Station außerhalb des ICON-CH1-Gebiets liegt — am
  // 29.09.2026 fielen so 4 von 6 GeoSphere-Blöcken (200 Stationen) komplett
  // aus. Durch das Halbieren bleiben am Ende nur die wirklich betroffenen
  // Stationen ohne Prognose (in der Antwort unter "outsideModel"). Kosten:
  // gezählt wird je Station, die zusätzlichen kleinen Anfragen fallen kaum
  // ins Gewicht. Die bekannten Außen-Stationen filtert ohnehin schon
  // insideIconCh1() vorab heraus, das Halbieren ist das Sicherheitsnetz.
  async function fetchWithSplit(batch: Station[]): Promise<void> {
    try {
      const result = await fetchForecastBatch(batch, fetchedAt);
      rows.push(...result.rows);
      skippedNullHours += result.skippedNullHours;
    } catch (err) {
      const message = (err as Error).message;
      if (/No data is available/i.test(message)) {
        if (batch.length === 1) {
          outsideModel.push(batch[0].code);
          return;
        }
        const half = Math.ceil(batch.length / 2);
        await fetchWithSplit(batch.slice(0, half));
        await fetchWithSplit(batch.slice(half));
        return;
      }
      const full = `Batch ab Station ${batch[0].code}: ${message}`;
      console.error(full);
      batchErrors.push(full);
    }
  }

  for (let i = 0; i < stations.length; i += BATCH_SIZE) {
    await fetchWithSplit(stations.slice(i, i + BATCH_SIZE));
  }
  if (outsideModel.length > 0) {
    console.error(`Außerhalb des ICON-CH1-Gebiets (${outsideModel.length}):`, outsideModel.join(","));
  }

  // Laufzeit an alle Zeilen hängen. Die Metadaten wurden oben VOR dem Abruf
  // gelesen; gleich danach geholte Werte stammen aus genau diesem Lauf (ein
  // neuer kommt frühestens 3 h später). Konnte die Metadaten-Datei nicht
  // gelesen werden, bleibt das Feld leer — die Seite zeigt dann nur
  // "ICON-CH1" ohne Uhrzeit.
  const modelRunIso = modelRun?.runIso ?? null;
  for (const row of rows) row.model_run = modelRunIso;

  if (rows.length === 0) {
    return json(
      { error: "Keine Prognosewerte erhalten", batchErrors },
      502,
    );
  }

  // 4) Upsert: vorhandene (station_code, model, forecast_time)-Kombinationen
  //    werden aktualisiert statt doppelt angelegt.
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
    model: MODEL_DB,
    modelRun: modelRun?.runIso ?? null,
    stations: stations.length,
    saved: rows.length,
    skippedNullHours,
    outsideFiltered,
    outsideModel,
    batchErrors,
    cleanupBefore: cutoff,
    cleanupOk,
  });
}

Deno.serve(handleRequest);
