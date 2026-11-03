// Supabase Edge Function "fetch-wind-forecasts": holt die Windprognose des
// Modells ICON-CH1 (MeteoSwiss) von Open-Meteo für alle Stationen der Karte
// und schreibt sie per Upsert in die Supabase-Tabelle wind_forecasts
// (Schema: supabase/forecast-schema.sql).
//
// Welche Stationen: die Stationsliste in der Datenbank (Tabelle
// wind_stations), die der Sammler (/api/collect) pflegt — seit Nov. 2026
// (Punkt 14 der Code-Durchsicht, "Ein Sammler, eine Wahrheit"). Vorher fragte
// diese Funktion selbst beim Bozner Dienst, bei OpenWindMap (nur Südtirol),
// beim SLF und bei GeoSphere nach und hatte dafür Kopien von deren Adressen
// und vom Alpen-Umriss; MeteoSchweiz, LWD Tirol, DWD und OpenWindMap
// außerhalb Südtirols bekamen gar keine Prognose. Jetzt bekommt jede Station
// der Karte eine (soweit sie im Modellgebiet liegt), und eine neue Quelle
// braucht hier nichts mehr.
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
// wir fragen 3 Reihen über 1 Tag ab, also genau 1 je Station. Bei ~650
// Stationen (alle Stationen der Karte, Nov. 2026) und 8 Modellläufen am Tag
// sind das ~5.200 Aufrufe (52 %); bis Okt. 2026 waren es ~490 Stationen.
// Das Nachholen gescheiterter Stationen (s. u.) kostet nur bei Fehlern etwas
// und höchstens RETRY_MAX_ATTEMPTS-mal je Lauf.
// Dazu kommt eine Grenze von 600 Aufrufen pro MINUTE (und 5.000 pro Stunde).
// Mehr als MAX_STATIONS_PER_RUN Stationen fragt ein Anstoß deshalb nicht ab;
// der Rest folgt beim nächsten Anstoß (siehe dort).
// Der Höhenwind (ICON-D2, s. u.) kostet je Lauf nur 1 Aufruf pro Station
// (2 Werte-Reihen), bei 2 Stationen also 16 Aufrufe am Tag. Ebenso der
// Luftdruck der Flughäfen Innsbruck und Bozen (Föhn-Anzeige, s. u.): 2
// Standorte × 8 Läufe = 16 Aufrufe am Tag.
//
// --- GESCHEITERTE STATIONEN NACHHOLEN (Nov. 2026, Punkt 13) ---
// Scheitert beim Abruf eines neuen Laufs ein Teil der Blöcke (Zeitlimit,
// Fehler bei Open-Meteo), werden die übrigen gespeichert — und weil damit ein
// Abruf nach dem neuen Lauf in der Tabelle steht, galt der Lauf als erledigt:
// Die betroffenen Stationen warteten bis zum nächsten Lauf (3 h). Jetzt merkt
// sich die Funktion diese Stationen (Tabelle wind_status, Zeile "prognose",
// Feld detail) und holt sie bei den nächsten Cron-Anstößen (alle 15 min)
// nach, höchstens RETRY_MAX_ATTEMPTS-mal. Stationen außerhalb des
// Modellgebiets ("No data is available") werden nicht nachgeholt — dort
// kommt auch beim nächsten Mal nichts. Auf demselben Weg kommen die Stationen
// über MAX_STATIONS_PER_RUN beim nächsten Anstoß dran (Minutengrenze).
//
// Ablauf pro Aufruf:
//   1. Zugriffsschutz: nur POST mit "Authorization: Bearer <service_role Key>"
//      (gleiches Muster wie CRON_SECRET bei /api/collect).
//   (danach: Höhenwind ICON-D2 mit eigener Laufprüfung, siehe
//   refreshUpperWind; dann Prüfung, ob es einen neuen ICON-CH1-Lauf gibt —
//   wenn nicht, nur gescheiterte Stationen nachholen, siehe retryPending)
//   2. Stationsliste aus der Datenbank (wind_stations, nur Stationen, die der
//      Sammler in den letzten STATION_LIST_MAX_AGE_MS gesehen hat), nach
//      Stationscode sortiert, damit die Blöcke über Läufe hinweg stabil sind.
//   3. Bodenwind in Batches (je 50 Stationen, Koordinaten komma-getrennt)
//      abfragen — nur ICON-CH1 (meteoswiss_icon_ch1, in der Datenbank
//      'icon_ch1'). Letzte 12 h + kommende 12 h, Einheit km/h (wie in
//      wind_measurements), Zeiten als Unix-Sekunden (eindeutig UTC). Die
//      Antwort-Liste hat dieselbe Reihenfolge wie die Koordinaten und wird
//      per Index den Stationen zugeordnet.
//   4. Stunden ohne Werte (Station am/außerhalb des Modellrands liefert
//      null) werden übersprungen; der Rest wird per Upsert gespeichert
//      (on_conflict station_code,model,forecast_time).
//   5. Zustand speichern (wind_status "prognose": Ergebnis, Fehler und die
//      Stationen zum Nachholen).
//   6. Prognosen älter als 3 Tage löschen (wie bei wind_measurements).
//
// Umgebungsvariablen: SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY werden von
// Supabase automatisch in jede Edge Function injiziert — es müssen keine
// eigenen Secrets gesetzt werden. OPEN_METEO_BASE_URL / OPEN_METEO_META_URL
// sind optionale Overrides für Tests mit einem lokalen Mock-Server.

const OPEN_METEO_BASE =
  Deno.env.get("OPEN_METEO_BASE_URL") ?? "https://api.open-meteo.com";

// Stationen, die der Sammler so lange nicht mehr eingetragen hat (er frischt
// alle gelieferten Stationen einmal pro Stunde auf), führt ihre Quelle nicht
// mehr — sie bekommen keine Prognose mehr. Gleiche Dauer wie MAX_SILENCE_MS
// für OpenWindMap in src/lib/pioupiou.ts.
const STATION_LIST_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
// Supabase gibt höchstens 1000 Zeilen je Anfrage heraus ("Max rows") — die
// Stationsliste wird deshalb seitenweise gelesen.
const STATION_LIST_PAGE_SIZE = 1000;

// Name der Zeile in wind_status (siehe "GESCHEITERTE STATIONEN NACHHOLEN").
const STATUS_NAME = "prognose";
// So oft werden gescheiterte Stationen eines Laufs höchstens nachgeholt
// (je Cron-Anstoß einmal, also innerhalb von rund einer Stunde).
const RETRY_MAX_ATTEMPTS = 4;

// Höchstens so viele Stationen fragt ein Anstoß bei Open-Meteo ab. Grund:
// Kostenlos sind nur 600 Aufrufe pro Minute erlaubt. Seit alle ~650
// Stationen der Karte eine Prognose bekommen (Nov. 2026), lag ein Lauf
// darüber — beim ersten Lauf am 01.11.2026 lehnte Open-Meteo die letzten
// beiden Blöcke ab (Status 429, "Minutely API request limit exceeded"). Die
// übrigen Stationen werden wie gescheiterte vorgemerkt und beim nächsten
// Anstoß (15 min später) geholt, nur eben ohne Fehler. Luft bis 600 für den
// Höhenwind (2 Aufrufe), für das Halbieren eines Blocks bei "No data is
// available" (bis ~100 Aufrufe zusätzlich, siehe fetchForecasts) und falls sich
// andere Nutzer den Absender teilen.
const MAX_STATIONS_PER_RUN = 450;

// Modellname in der Datenbank (Spalte "model") — kurz und stabil — und der
// dazu passende Modellname der Open-Meteo-API. Bodenwind für alle Stationen
// kommt NUR aus ICON-CH1 (dunkelgraue, gestrichelte Kurve im Verlaufsbalken).
// Entfernt auf Wunsch des Projektbesitzers:
//   - AROME (GeoSphere Austria, 'arome')
//   - ICON-D2-Bodenwind (DWD, 'icon_d2') — wurde bis Sept. 2026 mitgesammelt,
//     aber nie angezeigt. Alte icon_d2-Zeilen löscht das Aufräumen
//     (RETENTION_DAYS) nach 3 Tagen von selbst.
const MODEL_DB = "icon_ch1";
const MODEL_API = "meteoswiss_icon_ch1";

// --- HÖHENWIND (ICON-D2, Okt. 2026, Wunsch des Projektbesitzers) ---
// Für einzelne Gipfelstationen zusätzlich der Wind der FREIEN ATMOSPHÄRE —
// im Verlaufsbalken eine blaue gestrichelte Linie. Der Bodenwind eines
// Modells gilt für dessen geglättetes Gelände (10 m über Grund), der
// Höhenwind zeigt dagegen, was oberhalb von Tal- und Hangwinden
// "durchzieht".
// ICON-D2 liefert Wind nur auf festen Druckflächen (DWD-Open-Data: 1000, 975,
// 950, 850, 700, 600 … hPa). Genommen wird bewusst die NÄCHSTHÖHERE Fläche
// über der Station, ohne Umrechnung (Wunsch des Projektbesitzers: im
// Verlaufsbalken soll ersichtlich sein, mit welchen Werten gearbeitet wird —
// dort steht z. B. "700 hPa (ca. 3000 m)"). Für Rittnerhorn (2260 m) und
// Leiterspitz (2320 m) ist das 700 hPa; 850 hPa (~1500 m) läge darunter.
// Böen gibt es auf Druckflächen nicht — gust_kmh bleibt leer.
// Gespeichert als model = 'icon_d2_upper', ohne neue Spalten.
// Kopie von UPPER_WIND_STATIONS aus src/lib/wind.ts (dort nur Druckfläche),
// hier zusätzlich MIT Koordinaten, damit der Höhenwind ohne die großen
// Stationslisten auskommt (siehe refreshUpperWind) — eine neue Station an
// beiden Stellen eintragen.
const UPPER_WIND_STATIONS: Record<string, { lat: number; lng: number; pressureHPa: number }> = {
  "82500WS": { lat: 46.6156, lng: 11.4604, pressureHPa: 700 }, // Ritten Rittner Horn, 2260 m
  "pioupiou-2163": { lat: 46.707, lng: 11.3834, pressureHPa: 700 }, // Leiterspitz, 2320 m
};
const UPPER_MODEL_DB = "icon_d2_upper";
const UPPER_MODEL_API = "dwd_icon_d2";
const UPPER_META_URL = `${OPEN_METEO_BASE}/data/${UPPER_MODEL_API}/static/meta.json`;

// --- LUFTDRUCK DER FLUGHÄFEN (ICON-CH1, Nov. 2026, Wunsch des Projektbesitzers) ---
// Für die Föhn-Anzeige (Druckdifferenz Bozen − Innsbruck, src/lib/pressure.ts)
// die Druckprognose von ICON-CH1 an den Flughäfen Innsbruck (LOWI) und Bozen
// (LIPB). Gemessen wird dort der QNH aus der Flugwetter-Meldung (METAR,
// gespeichert vom Sammler). Damit Messung und Prognose vergleichbar sind,
// rechnet diese Funktion den Druck AM BODEN (surface_pressure, von Open-Meteo
// auf die angegebene Flughafenhöhe bezogen) nach derselben Regel in den QNH
// um wie die Flughäfen (Normatmosphäre, siehe qnhFromSurface). Der Druck auf
// Meereshöhe des Modells (pressure_msl) rechnet anders und lag am 03.11.2026
// in Innsbruck rund 2 hPa über dem METAR; der so gerechnete QNH traf ihn auf
// wenige Zehntel.
// Länger als der Wind (33 statt 12 h, so weit rechnet ICON-CH1): Für Föhn
// ist auch der nächste Tag interessant. Kostet trotzdem nur 1 Aufruf je
// Standort (gezählt wird erst ab 2 Wochen Zeitraum).
// Gespeichert in der eigenen Tabelle pressure_values (supabase/druck.sql) als
// kind = 'icon_ch1'. Eigene Laufprüfung wie beim Höhenwind (refreshPressure):
// Fehlt die Prognose, kommt sie beim nächsten Cron-Anstoß.
// Kopie von PRESSURE_STATIONS aus src/lib/pressure.ts (Deno kann dort nicht
// importieren) — bei einer Änderung beide Stellen anfassen.
const PRESSURE_STATIONS: Record<string, { lat: number; lng: number; elevationM: number }> = {
  LOWI: { lat: 47.2602, lng: 11.3439, elevationM: 581 }, // Innsbruck Flughafen
  LIPB: { lat: 46.4603, lng: 11.3264, elevationM: 240 }, // Bozen Flughafen
};
const PRESSURE_KIND = "icon_ch1";
const PRESSURE_FORECAST_HOURS = 33;

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

// Rollendes Zeitfenster je Lauf, abgeleitet von HISTORY_HOURS und
// FUTURE_MARGIN_HOURS (4) aus src/lib/wind.ts — Deno kann von dort nicht
// importieren, deshalb bei einer Änderung beide Stellen anfassen.
// PAST_HOURS muss NICHT so lang sein wie HISTORY_HOURS (seit Nov. 2026 48 h):
// Jeder Lauf überschreibt nur seine letzten 12 h, ältere Stunden bleiben aus
// früheren Läufen in der Tabelle stehen (bis RETENTION_DAYS). So reicht die
// Prognosekurve über die ganzen 48 h, ohne mehr bei Open-Meteo abzufragen.
const PAST_HOURS = 12;
// Deutlich MEHR als FUTURE_MARGIN_HOURS (4): Neu geholt wird nur noch alle
// 3 Stunden (bei jedem neuen Modelllauf, s. o.), und Open-Meteo zählt ab der
// aktuellen vollen Stunde. Kurz vor dem nächsten Lauf muss der gespeicherte
// Stand also noch bis "jetzt + 4 h" reichen: bis zu 1 h (angebrochene
// Stunde) + 3 h (bis zum nächsten Lauf) + 4 h = 8 h. 12 h decken zusätzlich
// einen ausgefallenen Lauf ab. Kostet nichts extra (gezählt wird erst ab
// 2 Wochen Zeitraum). /api/forecast schneidet den Überhang wieder ab.
const FORECAST_HOURS = 12;
// Aufbewahrung wie bei den Messwerten (/api/collect): 3 Tage, also länger als
// die 48-h-Anzeige (HISTORY_HOURS). Bei 2 Tagen fehlte links bis zu 3 h
// Prognose (gelöscht wird beim Lauf, der nur alle 3 h kommt).
const RETENTION_DAYS = 3;

// Stationen pro Open-Meteo-Request. Überschreibbar für Tests, damit sich
// das Batching auch mit wenigen Mock-Stationen prüfen lässt.
const BATCH_SIZE = Number(Deno.env.get("FORECAST_BATCH_SIZE") ?? "50");

// Zeitlimits (Okt. 2026; vorher ohne): Hängt ein Dienst, bricht die Funktion
// diesen Abruf ab, statt zu warten, bis Supabase sie an ihrer Laufzeitgrenze
// beendet (dann ginge auch alles schon Geholte verloren).
const META_TIMEOUT_MS = 10_000; // Laufzeit-Datei (meta.json) von Open-Meteo
const OPEN_METEO_TIMEOUT_MS = 30_000; // ein Block von bis zu 50 Stationen
const DATABASE_TIMEOUT_MS = 60_000; // Supabase (Speichern von ~16.000 Zeilen)

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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Stationsliste aus der Datenbank (Tabelle wind_stations, gepflegt vom
// Sammler /api/collect): alle Stationen der Karte, die der Sammler in den
// letzten STATION_LIST_MAX_AGE_MS gesehen hat. Nach Code sortiert, damit die
// Blöcke über Läufe hinweg gleich bleiben.
async function loadStationList(
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Station[]> {
  const since = new Date(Date.now() - STATION_LIST_MAX_AGE_MS).toISOString();
  const stations: Station[] = [];
  for (let offset = 0; ; offset += STATION_LIST_PAGE_SIZE) {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/wind_stations?select=station_code,lat,lng` +
        `&updated_at=gte.${encodeURIComponent(since)}` +
        `&order=station_code&limit=${STATION_LIST_PAGE_SIZE}&offset=${offset}`,
      { headers, signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS) },
    );
    if (!res.ok) {
      throw new Error(`Stationsliste: Supabase antwortete mit Status ${res.status}`);
    }
    const page = (await res.json()) as Array<{ station_code: string; lat: number; lng: number }>;
    for (const s of page) {
      if (typeof s.lat !== "number" || typeof s.lng !== "number") continue;
      stations.push({ code: s.station_code, lat: s.lat, lng: s.lng });
    }
    if (page.length < STATION_LIST_PAGE_SIZE) break;
  }
  return stations;
}

// Ergebnis eines Prognose-Abrufs für eine Liste von Stationen.
interface ForecastFetch {
  rows: ForecastRow[];
  skippedNullHours: number;
  /** Stationen, für die Open-Meteo "No data is available" meldet. */
  outsideModel: string[];
  batchErrors: string[];
  /** Stationen in gescheiterten Blöcken — werden später nachgeholt. */
  failed: Station[];
}

// Alle Stationen in Blöcken zu BATCH_SIZE abfragen. Ein gescheiterter Block
// bricht nicht den ganzen Lauf ab — die übrigen Stationen werden trotzdem
// gespeichert, der Fehler wird geloggt, gemeldet und die Stationen des Blocks
// zum Nachholen vorgemerkt (failed).
//
// Ein Block wird bei "No data is available" halbiert und erneut versucht:
// Open-Meteo lehnt die GANZE Anfrage ab, sobald auch nur EINE Station
// außerhalb des ICON-CH1-Gebiets liegt — am 29.09.2026 fielen so 4 von 6
// GeoSphere-Blöcken (200 Stationen) komplett aus. Durch das Halbieren bleiben
// am Ende nur die wirklich betroffenen Stationen ohne Prognose (in der
// Antwort unter "outsideModel"). Kosten: gezählt wird je Station, die
// zusätzlichen kleinen Anfragen fallen kaum ins Gewicht. Die bekannten
// Außen-Stationen filtert ohnehin schon insideIconCh1() vorab heraus, das
// Halbieren ist das Sicherheitsnetz.
async function fetchForecasts(stations: Station[], fetchedAt: string): Promise<ForecastFetch> {
  const result: ForecastFetch = {
    rows: [],
    skippedNullHours: 0,
    outsideModel: [],
    batchErrors: [],
    failed: [],
  };

  async function fetchWithSplit(batch: Station[]): Promise<void> {
    try {
      const fetched = await fetchForecastBatch(batch, fetchedAt);
      result.rows.push(...fetched.rows);
      result.skippedNullHours += fetched.skippedNullHours;
    } catch (err) {
      const message = (err as Error).message;
      if (/No data is available/i.test(message)) {
        if (batch.length === 1) {
          result.outsideModel.push(batch[0].code);
          return;
        }
        const half = Math.ceil(batch.length / 2);
        await fetchWithSplit(batch.slice(0, half));
        await fetchWithSplit(batch.slice(half));
        return;
      }
      const full = `Batch ab Station ${batch[0].code}: ${message}`;
      console.error(full);
      result.batchErrors.push(full);
      result.failed.push(...batch);
    }
  }

  for (let i = 0; i < stations.length; i += BATCH_SIZE) {
    await fetchWithSplit(stations.slice(i, i + BATCH_SIZE));
  }
  if (result.outsideModel.length > 0) {
    console.error(
      `Außerhalb des ICON-CH1-Gebiets (${result.outsideModel.length}):`,
      result.outsideModel.join(","),
    );
  }
  return result;
}

// Upsert: vorhandene (station_code, model, forecast_time)-Kombinationen
// werden aktualisiert statt doppelt angelegt. Gibt null zurück, wenn alles
// geklappt hat, sonst die Fehlermeldung.
async function saveForecastRows(
  supabaseUrl: string,
  headers: Record<string, string>,
  rows: ForecastRow[],
): Promise<string | null> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/wind_forecasts?on_conflict=station_code,model,forecast_time`,
      {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
      },
    );
    return res.ok ? null : `Status ${res.status}: ${await res.text()}`;
  } catch (err) {
    return (err as Error).message;
  }
}

// Zusatzangaben der Zeile "prognose" in wind_status (Feld detail): woraus
// die gerade gespeicherte Prognose stammt und welche Stationen noch fehlen.
interface ForecastStatusDetail {
  /** Startzeit des Modelllaufs (ISO), null wenn unbekannt. */
  modelRun: string | null;
  /** Zeitpunkt des Abrufs des Laufs (ISO). */
  fetchedAt: string;
  /** Stationen, deren Abruf gescheitert ist (zum Nachholen). */
  pending: Station[];
  /** Wie oft schon nachgeholt wurde. */
  attempts: number;
}

async function loadForecastStatus(
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<ForecastStatusDetail | null> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/wind_status?name=eq.${STATUS_NAME}&select=detail`,
      { headers, signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ detail?: ForecastStatusDetail | null }>;
    const detail = rows[0]?.detail;
    return detail && Array.isArray(detail.pending) ? detail : null;
  } catch {
    return null;
  }
}

// Zustand eintragen (Tabelle wind_status, supabase/ein-sammler.sql). ok_at
// nur bei Erfolg mitschicken: Bei einer einzelnen Zeile ändert Supabase nur
// die mitgeschickten Spalten, ok_at bleibt bei einem Fehler also stehen
// (seit wann es hakt). Ein Fehler hier betrifft nur das Nachholen und wird
// nur protokolliert.
async function saveForecastStatus(
  supabaseUrl: string,
  headers: Record<string, string>,
  status: { ok: boolean; valueCount: number; error: string | null; detail: ForecastStatusDetail },
): Promise<boolean> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    name: STATUS_NAME,
    checked_at: now,
    ok: status.ok,
    value_count: status.valueCount,
    error: status.error?.slice(0, 500) ?? null,
    detail: status.detail,
  };
  if (status.ok) row.ok_at = now;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/wind_status?on_conflict=name`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`Zustand nicht gespeichert (Status ${res.status}): ${await res.text()}`);
    return res.ok;
  } catch (err) {
    console.error("Zustand nicht gespeichert:", err);
    return false;
  }
}

// Gescheiterte Stationen des aktuellen Laufs nachholen (siehe "GESCHEITERTE
// STATIONEN NACHHOLEN" oben). Nur solange der Lauf noch der aktuelle ist
// (jünger als MIN_REFETCH_WITHOUT_META_MS — danach kommt ohnehin ein neuer)
// und höchstens RETRY_MAX_ATTEMPTS-mal. Gibt die Angaben für die Antwort
// zurück, oder null, wenn nichts nachzuholen war.
async function retryPending(
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const status = await loadForecastStatus(supabaseUrl, headers);
  if (!status || status.pending.length === 0) return null;
  if (status.attempts >= RETRY_MAX_ATTEMPTS) return null;
  // So geschrieben, dass auch eine unlesbare Zeit (NaN) zum Abbruch führt.
  const ageMs = Date.now() - Date.parse(status.fetchedAt);
  if (!(ageMs <= MIN_REFETCH_WITHOUT_META_MS)) return null;

  // Auch hier höchstens MAX_STATIONS_PER_RUN (Minutengrenze von Open-Meteo).
  const batch = status.pending.slice(0, MAX_STATIONS_PER_RUN);
  const rest = status.pending.slice(MAX_STATIONS_PER_RUN);
  const fetched = await fetchForecasts(batch, new Date().toISOString());
  for (const row of fetched.rows) row.model_run = status.modelRun;
  let saveError: string | null = null;
  if (fetched.rows.length > 0) {
    saveError = await saveForecastRows(supabaseUrl, headers, fetched.rows);
  }
  // Konnte nicht gespeichert werden, bleiben alle offen.
  const stillPending = saveError ? status.pending : [...fetched.failed, ...rest];
  const errors = [...fetched.batchErrors, ...(saveError ? [`Speichern: ${saveError}`] : [])];
  await saveForecastStatus(supabaseUrl, headers, {
    ok: errors.length === 0,
    valueCount: saveError ? 0 : fetched.rows.length,
    error: errors.length > 0 ? errors.join("; ") : null,
    detail: { ...status, pending: stillPending, attempts: status.attempts + 1 },
  });
  return {
    stations: batch.length,
    saved: saveError ? 0 : fetched.rows.length,
    stillPending: stillPending.length,
    attempt: status.attempts + 1,
    errors,
  };
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

  const res = await fetch(`${OPEN_METEO_BASE}/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(OPEN_METEO_TIMEOUT_MS),
  });
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

// Höhenwind (ICON-D2) für alle Stationen in UPPER_WIND_STATIONS holen: Wind
// und Richtung auf der eingetragenen Druckfläche, unverändert übernommen.
// Nur wenige Stationen, deshalb eine einzige Anfrage ohne Batching.
async function fetchUpperWind(
  fetchedAt: string,
  modelRunIso: string | null,
): Promise<ForecastRow[]> {
  const codes = Object.keys(UPPER_WIND_STATIONS);
  const stations = codes.map((code) => ({ code, ...UPPER_WIND_STATIONS[code] }));
  const levels = [...new Set(stations.map((s) => s.pressureHPa))];
  const params = new URLSearchParams({
    latitude: stations.map((s) => s.lat).join(","),
    longitude: stations.map((s) => s.lng).join(","),
    models: UPPER_MODEL_API,
    hourly: levels
      .flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`])
      .join(","),
    wind_speed_unit: "kmh",
    past_hours: String(PAST_HOURS),
    forecast_hours: String(FORECAST_HOURS),
    timeformat: "unixtime",
  });

  const res = await fetch(`${OPEN_METEO_BASE}/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(OPEN_METEO_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo (ICON-D2) antwortete mit Status ${res.status}: ${await res.text()}`);
  }
  const data: unknown = await res.json();
  if (data && typeof data === "object" && (data as { error?: boolean }).error) {
    throw new Error(`Open-Meteo (ICON-D2) meldet Fehler: ${(data as { reason?: string }).reason}`);
  }
  const locations = (Array.isArray(data) ? data : [data]) as OpenMeteoLocation[];
  if (locations.length !== stations.length) {
    throw new Error(
      `Open-Meteo (ICON-D2) lieferte ${locations.length} Standorte, erwartet waren ${stations.length}`,
    );
  }

  const rows: ForecastRow[] = [];
  locations.forEach((loc, i) => {
    const station = stations[i];
    const hourly = loc.hourly;
    const times = Array.isArray(hourly?.time)
      ? (hourly.time as Array<number | null>)
      : undefined;
    if (!hourly || !times) return;

    const level = station.pressureHPa;
    const speeds = hourlySeries(hourly, `wind_speed_${level}hPa`, UPPER_MODEL_API);
    const directions = hourlySeries(hourly, `wind_direction_${level}hPa`, UPPER_MODEL_API);

    times.forEach((t, k) => {
      if (typeof t !== "number") return;
      const speed = speeds?.[k] ?? null;
      const direction = directions?.[k] ?? null;
      if (speed === null && direction === null) return;
      rows.push({
        station_code: station.code,
        model: UPPER_MODEL_DB,
        forecast_time: new Date(t * 1000).toISOString(),
        direction,
        speed_kmh: speed !== null ? round1(speed) : null,
        gust_kmh: null,
        fetched_at: fetchedAt,
        model_run: modelRunIso,
      });
    });
  });
  return rows;
}

// Höhenwind auffrischen — UNABHÄNGIG vom ICON-CH1-Abruf, mit eigener
// Laufprüfung über die ICON-D2-Metadaten (gleiches Prinzip wie bei ICON-CH1,
// siehe oben). Dadurch kommt der Höhenwind beim nächsten Cron-Anstoß (alle
// 15 min) von selbst, sobald er fehlt oder ein neuer ICON-D2-Lauf da ist —
// auch wenn es keinen neuen ICON-CH1-Lauf gibt. Kosten: 1 Aufruf je Station
// und Lauf (ICON-D2 rechnet alle 3 h, also 2 × 8 = 16 am Tag). Ein Fehler hier
// betrifft nur den Höhenwind und wird in der Antwort gemeldet.
async function refreshUpperWind(
  supabaseUrl: string,
  headers: Record<string, string>,
  force: boolean,
): Promise<Record<string, unknown>> {
  try {
    const run = await loadModelRun(UPPER_META_URL, "ICON-D2");
    if (!force) {
      const last = await loadLastFetchedMs(supabaseUrl, headers, UPPER_MODEL_DB);
      const upToDate =
        last !== null &&
        (run ? last >= run.availableMs : Date.now() - last < MIN_REFETCH_WITHOUT_META_MS);
      if (upToDate) return { skipped: true, modelRun: run?.runIso ?? null };
    }
    const rows = await fetchUpperWind(new Date().toISOString(), run?.runIso ?? null);
    if (rows.length === 0) return { saved: 0, error: "Keine Höhenwind-Werte erhalten" };
    const res = await fetch(
      `${supabaseUrl}/rest/v1/wind_forecasts?on_conflict=station_code,model,forecast_time`,
      {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      return { saved: 0, error: `Supabase-Upsert schlug fehl (Status ${res.status}): ${await res.text()}` };
    }
    return { saved: rows.length, modelRun: run?.runIso ?? null };
  } catch (err) {
    console.error("Höhenwind (ICON-D2):", err);
    return { saved: 0, error: (err as Error).message };
  }
}

// QNH aus dem Druck am Boden (hPa) und der Höhe (m) nach der Normatmosphäre
// der ICAO — dieselbe Regel, nach der die Flughäfen ihren QNH melden.
function qnhFromSurface(surfaceHpa: number, elevationM: number): number {
  return Math.pow(Math.pow(surfaceHpa, 0.190263) + 8.417286e-5 * elevationM, 1 / 0.190263);
}

interface PressureRow {
  station: string;
  kind: string;
  valid_at: string;
  qnh_hpa: number;
  model_run: string | null;
  fetched_at: string;
}

// Druckprognose (ICON-CH1) für die Flughäfen in PRESSURE_STATIONS, als QNH.
async function fetchPressureForecast(
  fetchedAt: string,
  modelRunIso: string | null,
): Promise<PressureRow[]> {
  const codes = Object.keys(PRESSURE_STATIONS);
  const stations = codes.map((code) => ({ code, ...PRESSURE_STATIONS[code] }));
  const params = new URLSearchParams({
    latitude: stations.map((s) => s.lat).join(","),
    longitude: stations.map((s) => s.lng).join(","),
    elevation: stations.map((s) => s.elevationM).join(","),
    models: MODEL_API,
    hourly: "surface_pressure",
    past_hours: String(PAST_HOURS),
    forecast_hours: String(PRESSURE_FORECAST_HOURS),
    timeformat: "unixtime",
  });
  const res = await fetch(`${OPEN_METEO_BASE}/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(OPEN_METEO_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo (Luftdruck) antwortete mit Status ${res.status}: ${await res.text()}`);
  }
  const data: unknown = await res.json();
  if (data && typeof data === "object" && (data as { error?: boolean }).error) {
    throw new Error(`Open-Meteo (Luftdruck) meldet Fehler: ${(data as { reason?: string }).reason}`);
  }
  const locations = (Array.isArray(data) ? data : [data]) as OpenMeteoLocation[];
  if (locations.length !== stations.length) {
    throw new Error(
      `Open-Meteo (Luftdruck) lieferte ${locations.length} Standorte, erwartet waren ${stations.length}`,
    );
  }

  const rows: PressureRow[] = [];
  locations.forEach((loc, i) => {
    const station = stations[i];
    const hourly = loc.hourly;
    const times = Array.isArray(hourly?.time) ? (hourly.time as Array<number | null>) : undefined;
    if (!hourly || !times) return;
    const surface = hourlySeries(hourly, "surface_pressure", MODEL_API);
    times.forEach((t, k) => {
      const value = surface?.[k];
      if (typeof t !== "number" || typeof value !== "number") return;
      rows.push({
        station: station.code,
        kind: PRESSURE_KIND,
        valid_at: new Date(t * 1000).toISOString(),
        qnh_hpa: round1(qnhFromSurface(value, station.elevationM)),
        model_run: modelRunIso,
        fetched_at: fetchedAt,
      });
    });
  });
  return rows;
}

// Druckprognose auffrischen — wie refreshUpperWind unabhängig vom Wind, mit
// eigener Laufprüfung (über die ICON-CH1-Metadaten, die handleRequest schon
// gelesen hat). Ein Fehler hier (z. B. Tabelle pressure_values fehlt noch)
// betrifft nur den Luftdruck und wird in der Antwort gemeldet.
async function refreshPressure(
  supabaseUrl: string,
  headers: Record<string, string>,
  run: { runIso: string; availableMs: number } | null,
  force: boolean,
): Promise<Record<string, unknown>> {
  try {
    if (!force) {
      let last: number | null = null;
      const res = await fetch(
        `${supabaseUrl}/rest/v1/pressure_values?kind=eq.${PRESSURE_KIND}` +
          `&select=fetched_at&order=fetched_at.desc&limit=1`,
        { headers, signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS) },
      );
      if (res.ok) {
        const found = (await res.json()) as Array<{ fetched_at?: string }>;
        const t = found[0]?.fetched_at ? Date.parse(found[0].fetched_at) : NaN;
        last = Number.isNaN(t) ? null : t;
      }
      const upToDate =
        last !== null &&
        (run ? last >= run.availableMs : Date.now() - last < MIN_REFETCH_WITHOUT_META_MS);
      if (upToDate) return { skipped: true, modelRun: run?.runIso ?? null };
    }
    const rows = await fetchPressureForecast(new Date().toISOString(), run?.runIso ?? null);
    if (rows.length === 0) return { saved: 0, error: "Keine Druckwerte erhalten" };
    const res = await fetch(
      `${supabaseUrl}/rest/v1/pressure_values?on_conflict=station,kind,valid_at`,
      {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      return { saved: 0, error: `Supabase-Upsert schlug fehl (Status ${res.status}): ${await res.text()}` };
    }
    return { saved: rows.length, modelRun: run?.runIso ?? null };
  } catch (err) {
    console.error("Luftdruck (ICON-CH1):", err);
    return { saved: 0, error: (err as Error).message };
  }
}

// Neuester Lauf eines Modells laut Open-Meteo (Voreinstellung: ICON-CH1):
// Startzeit (nur für die Antwort) und Zeitpunkt der Bereitstellung. null,
// wenn die Datei nicht lesbar ist.
async function loadModelRun(
  metaUrl = MODEL_META_URL,
  label = "ICON-CH1",
): Promise<{ runIso: string; availableMs: number } | null> {
  try {
    const res = await fetch(metaUrl, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`${label}-Metadaten: Status ${res.status} (${metaUrl})`);
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
      console.error(`${label}-Metadaten: unerwartetes Format`, Object.keys(meta ?? {}));
      return null;
    }
    return {
      runIso: new Date(meta.last_run_initialisation_time * 1000).toISOString(),
      availableMs: meta.last_run_availability_time * 1000,
    };
  } catch (err) {
    console.error(`${label}-Metadaten nicht abrufbar:`, err);
    return null;
  }
}

// Zeitpunkt des jüngsten gespeicherten Abrufs eines Modells (fetched_at,
// Voreinstellung ICON-CH1), oder null (leere Tabelle oder Fehler → dann wird
// normal abgefragt).
async function loadLastFetchedMs(
  supabaseUrl: string,
  headers: Record<string, string>,
  model = MODEL_DB,
): Promise<number | null> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/wind_forecasts?model=eq.${model}` +
        `&select=fetched_at&order=fetched_at.desc&limit=1`,
      { headers, signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS) },
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
  // Höhenwind zuerst und unabhängig von ICON-CH1 (siehe refreshUpperWind).
  const upperWind = await refreshUpperWind(supabaseUrl, supabaseHeaders, force);

  const modelRun = await loadModelRun();
  // Luftdruck der Flughäfen (Föhn-Anzeige), ebenfalls unabhängig vom Wind.
  const pressure = await refreshPressure(supabaseUrl, supabaseHeaders, modelRun, force);
  if (!force) {
    const lastFetchedMs = await loadLastFetchedMs(supabaseUrl, supabaseHeaders);
    if (lastFetchedMs !== null) {
      const upToDate = modelRun
        ? lastFetchedMs >= modelRun.availableMs
        : Date.now() - lastFetchedMs < MIN_REFETCH_WITHOUT_META_MS;
      if (upToDate) {
        // Kein neuer Lauf: höchstens gescheiterte Stationen nachholen.
        const retry = await retryPending(supabaseUrl, supabaseHeaders);
        return json({
          ok: true,
          skipped: true,
          reason: modelRun
            ? "Kein neuer ICON-CH1-Lauf seit dem letzten Abruf"
            : "Metadaten nicht lesbar, letzter Abruf jünger als 170 min",
          modelRun: modelRun?.runIso ?? null,
          lastFetched: new Date(lastFetchedMs).toISOString(),
          retry,
          upperWind,
          pressure,
        });
      }
    }
  }

  // 2) Stationsliste aus der Datenbank (siehe loadStationList). Stationen
  //    außerhalb des Modellgebiets (siehe ICON_CH1_MAX_LNG) gar nicht erst
  //    abfragen.
  let stations: Station[];
  try {
    stations = await loadStationList(supabaseUrl, supabaseHeaders);
  } catch (err) {
    console.error("Stationsliste nicht lesbar:", err);
    return json({ error: `Stationsliste nicht lesbar: ${(err as Error).message}` }, 502);
  }
  const beforeFilter = stations.length;
  stations = stations.filter(insideIconCh1);
  const outsideFiltered = beforeFilter - stations.length;
  if (stations.length === 0) {
    return json({ error: "Keine Station in der Stationsliste (wind_stations)" }, 502);
  }

  // 3) Bodenwind (ICON-CH1) batchweise abfragen (siehe fetchForecasts) —
  //    höchstens MAX_STATIONS_PER_RUN, der Rest folgt beim nächsten Anstoß.
  const fetchedAt = new Date().toISOString();
  const deferred = stations.slice(MAX_STATIONS_PER_RUN);
  const { rows, skippedNullHours, outsideModel, batchErrors, failed } = await fetchForecasts(
    stations.slice(0, MAX_STATIONS_PER_RUN),
    fetchedAt,
  );

  // Laufzeit an alle Zeilen hängen. Die Metadaten wurden oben VOR dem Abruf
  // gelesen; gleich danach geholte Werte stammen aus genau diesem Lauf (ein
  // neuer kommt frühestens 3 h später). Konnte die Metadaten-Datei nicht
  // gelesen werden, bleibt das Feld leer — die Seite zeigt dann nur
  // "ICON-CH1" ohne Uhrzeit.
  const modelRunIso = modelRun?.runIso ?? null;
  for (const row of rows) row.model_run = modelRunIso;

  // Zustand für den Fall eines Fehlers. Nachzuholen gibt es dann nichts: Ohne
  // gespeicherte Zeile gilt der Lauf nicht als abgerufen, beim nächsten
  // Anstoß wird ohnehin alles neu geholt.
  const failedStatus = (error: string) => ({
    ok: false,
    valueCount: 0,
    error,
    detail: { modelRun: modelRunIso, fetchedAt, pending: [], attempts: 0 },
  });

  if (rows.length === 0) {
    await saveForecastStatus(supabaseUrl, supabaseHeaders, failedStatus("Keine Prognosewerte erhalten"));
    return json({ error: "Keine Prognosewerte erhalten", batchErrors }, 502);
  }

  // 4) Speichern (Upsert, siehe saveForecastRows).
  const saveError = await saveForecastRows(supabaseUrl, supabaseHeaders, rows);
  if (saveError) {
    await saveForecastStatus(supabaseUrl, supabaseHeaders, failedStatus(`Speichern: ${saveError}`));
    return json({ error: "Supabase-Upsert schlug fehl", details: saveError }, 502);
  }

  // 5) Zustand speichern — mit den Stationen gescheiterter Blöcke und denen
  //    über MAX_STATIONS_PER_RUN, die bei den nächsten Anstößen geholt werden
  //    (siehe retryPending). Letztere sind kein Fehler.
  const statusOk = await saveForecastStatus(supabaseUrl, supabaseHeaders, {
    ok: batchErrors.length === 0,
    valueCount: rows.length,
    error: batchErrors.length > 0 ? batchErrors.join("; ") : null,
    detail: { modelRun: modelRunIso, fetchedAt, pending: [...failed, ...deferred], attempts: 0 },
  });

  // 6) Aufräumen: Prognosen älter als RETENTION_DAYS Tage löschen.
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  let cleanupOk = true;
  try {
    const deleteRes = await fetch(
      `${supabaseUrl}/rest/v1/wind_forecasts?forecast_time=lt.${encodeURIComponent(cutoff)}`,
      { method: "DELETE", headers: supabaseHeaders, signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS) },
    );
    if (!deleteRes.ok) {
      // Aufräumen ist unkritisch — Fehler nur protokollieren, nicht abbrechen.
      console.error(`WARNUNG: Aufräumen alter Prognosen schlug fehl (Status ${deleteRes.status})`);
      cleanupOk = false;
    }
  } catch (err) {
    console.error("WARNUNG: Aufräumen alter Prognosen schlug fehl:", err);
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
    pending: failed.length + deferred.length,
    deferred: deferred.length,
    statusOk,
    upperWind,
    pressure,
    cleanupBefore: cutoff,
    cleanupOk,
  });
}

Deno.serve(handleRequest);
