import { NextResponse } from "next/server";
import { fetchBolzanoForCollect } from "@/lib/bolzano";
import { fetchOpenWindMapStations } from "@/lib/pioupiou";
import { fetchGeoSphereStations } from "@/lib/geosphere";
import { fetchMeteoSwissStations } from "@/lib/meteoswiss";
import { fetchLwdTirolStations } from "@/lib/lwdtirol";
import { fetchDwdReadingsSince, fetchDwdStations } from "@/lib/dwd";
import { fetchSlfReadingsSince, fetchSlfStations } from "@/lib/slf";
import { saveStationList } from "@/lib/stationList";
import { DATABASE_TIMEOUT_MS, type WindStation } from "@/lib/wind";

// Sammel-Route: ruft alle Wetterdienste ab (dieselben Quellen wie /api/wind,
// Logik je Quelle in src/lib/) und schreibt die Windwerte in die
// Supabase-Tabelle wind_measurements. Ersetzt den früheren
// GitHub-Actions-Workflow und wird stattdessen von Supabase Cron per POST
// angestoßen.
//
// Nebenbei pflegt sie die Stationsliste (Tabelle wind_stations: Name, Lage,
// Höhe, Okt. 2026). Aus ihr zeigt /api/wind die Stationen einer gerade
// ausgefallenen Quelle mit ihrem letzten Wert weiter (src/lib/stationList.ts).
//
// TAKT: alle 5 Minuten (Cron-Job "collect-data", `*/5 * * * *`) — bewusst
// doppelt so oft, wie die Stationen messen. Grund: /sensors liefert immer nur
// den NEUESTEN Wert je Sensor, und der Bozner Dienst veröffentlicht ihn erst
// 5–10 Minuten nach der Messung (nachgemessen an inserted_at − measured_at:
// über 2400 von ~2500 Zeilen liegen bei exakt 10 Minuten). Jeder Wert ist also
// rund 10 Minuten lang der "neueste"; mit einem 5-Minuten-Takt trifft ihn
// garantiert mindestens ein Abruf. Bei einem 10-Minuten-Takt wäre das der
// Grenzfall — eine Verzögerung von wenigen Sekunden würde dann Werte
// verschlucken. NICHT auf 10 Minuten zurückstellen.
//
// Was auch ein schnellerer Takt NICHT verhindern kann: Liefert der Bozner
// Dienst einen Wert verspätet nach, nachdem der nächste schon da war, wird er
// nie der "neueste" und taucht in /sensors überhaupt nicht auf. Dann fehlt eine
// 10-Minuten-Spalte bei allen Stationen gleichzeitig. Im Verlaufsbalken wird
// eine solche einzelne Lücke überbrückt (BAND_GAP_MS in WindHistoryPanel.tsx).
//
// AUSFÄLLE: Alle Quellen werden gleichzeitig abgefragt, jede mit Zeitlimit
// (SOURCE_TIMEOUT_MS in src/lib/wind.ts). Scheitert eine, werden die übrigen
// trotzdem gespeichert — seit Okt. 2026 auch dann, wenn der Bozner Dienst
// ausfällt (vorher brach der ganze Lauf ab, und es entstand eine Lücke bei
// ALLEN Quellen). Die Antwort nennt je Quelle die Zahl der Werte und die
// gescheiterten Quellen.
//
// Aufruf nur mit gültigem Token:
//   POST /api/collect
//   Header: Authorization: Bearer <CRON_SECRET>
//
// Benötigte serverseitige Umgebungsvariablen (in Vercel hinterlegen):
//   SUPABASE_URL               z.B. https://xyz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service_role Key des Supabase-Projekts
//   CRON_SECRET                selbst gewähltes Geheimnis für den Cron-Aufruf

// Aufbewahrung in der Datenbank. Der Verlaufsbalken zeigt nur HISTORY_HOURS
// (12h, siehe src/lib/wind.ts) — 2 Tage sind damit ein großzügiger Puffer für
// ausgefallene Sammel-Läufe und halten die Tabelle klein.
const RETENTION_DAYS = 2;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// SLF und DWD liefern ihren Verlauf mit (SLF die letzten 24 h, DWD den
// laufenden Tag). Deshalb schreibt jeder Lauf ihre Werte der letzten 3
// Stunden, nicht nur den neuesten: Ein verpasster Lauf oder ein verspätet
// gelieferter Wert füllt sich so beim nächsten Lauf von selbst auf. Beim DWD
// ist das sogar nötig, weil er nur alle 30 min eine neue Datei mit drei neuen
// Werten bereitstellt (siehe src/lib/dwd.ts).
const HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000;

// Werte, die älter als eine Stunde sind, werden nur noch ERGÄNZT, nicht mehr
// überschrieben (Okt. 2026): Bis dahin schrieb jeder Lauf rund 1.200
// SLF-Werte neu, die längst gespeichert waren — gut drei Viertel der ganzen
// Schreibarbeit, ohne dass sich etwas änderte. Jüngere Werte werden weiter
// überschrieben, falls ein Dienst einen Wert nachträglich vervollständigt.
const OVERWRITE_WINDOW_MS = 60 * 60 * 1000;

// Aus demselben Grund trägt jeder Lauf nur NEUE Stationen in die
// Stationsliste ein. Name, Lage und Höhe der bekannten frischt nur der Lauf
// zur vollen Stunde auf (der Cron-Job läuft zu :00, :05, …).
const STATION_LIST_REFRESH_MINUTES = 5;

// Nicht cachen und immer serverseitig zur Laufzeit ausführen — sonst würde
// Next.js die Route eventuell zur Build-Zeit vorberechnen.
export const dynamic = "force-dynamic";

interface MeasurementRow {
  station_code: string;
  measured_at: string;
  direction: number | null;
  speed_kmh: number | null;
  gust_kmh: number | null;
  source: WindStation["source"];
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

// Was eine Quelle liefert: die Messwerte für wind_measurements und ihre
// Stationen (Name, Lage, Höhe) für die Stationsliste.
interface SourceResult {
  rows: MeasurementRow[];
  stations: WindStation[];
}

function fromReadings(readings: Reading[], source: WindStation["source"]): MeasurementRow[] {
  return readings.map((r) => ({
    station_code: r.stationCode,
    measured_at: r.measuredAt,
    direction: r.direction,
    speed_kmh: r.speedKmh,
    gust_kmh: r.gustKmh,
    source,
  }));
}

// Quellen, die nur ihren neuesten Wert liefern (Live-Format der Karte): Ihre
// Stationen sind zugleich die Einträge der Stationsliste.
function fromStations(stations: WindStation[]): SourceResult {
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
): Promise<SourceResult> {
  const [rows, list] = await Promise.all([
    readings,
    stations.catch((err) => {
      console.error("Stationen für die Stationsliste nicht abrufbar:", err);
      return [];
    }),
  ]);
  return { rows, stations: list };
}

// Alle Quellen, je mit ihrer Umwandlung in Datenbankzeilen. Dieselben Quellen
// wie in /api/wind — eine neue Quelle braucht an beiden Stellen einen Eintrag.
const SOURCES: Array<[WindStation["source"], () => Promise<SourceResult>]> = [
  [
    "bolzano",
    async () => {
      const { readings, stations } = await fetchBolzanoForCollect();
      return { rows: fromReadings(readings, "bolzano"), stations };
    },
  ],
  ["openwindmap", async () => fromStations(await fetchOpenWindMapStations())],
  ["geosphere", async () => fromStations(await fetchGeoSphereStations())],
  ["meteoswiss", async () => fromStations(await fetchMeteoSwissStations())],
  ["lwdtirol", async () => fromStations(await fetchLwdTirolStations())],
  [
    "dwd",
    () =>
      withStations(
        fetchDwdReadingsSince(Date.now() - HISTORY_WINDOW_MS).then((r) => fromReadings(r, "dwd")),
        fetchDwdStations(),
      ),
  ],
  [
    "slf",
    () =>
      withStations(
        fetchSlfReadingsSince(Date.now() - HISTORY_WINDOW_MS).then((r) => fromReadings(r, "slf")),
        fetchSlfStations(),
      ),
  ],
];

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

  // 2) Alle Quellen gleichzeitig abrufen. Eine gescheiterte Quelle liefert
  //    keine Zeilen, die übrigen werden trotzdem gespeichert.
  const results = await Promise.all(
    SOURCES.map(async ([source, load]) => {
      try {
        return { source, ...(await load()), error: null };
      } catch (err) {
        console.error(`Quelle ${source} nicht abrufbar:`, err);
        return { source, rows: [] as MeasurementRow[], stations: [] as WindStation[], error: String(err) };
      }
    }),
  );

  // 3) Zeilen aufteilen: jung = überschreiben, älter als OVERWRITE_WINDOW_MS =
  //    nur ergänzen. Längst ausgefallene Stationen (letzter Wert älter als die
  //    Aufbewahrung, z. B. ein seit Tagen toter Sensor) würden nach dem
  //    Speichern sofort wieder gelöscht — gar nicht erst schreiben.
  const now = Date.now();
  const recentRows: MeasurementRow[] = [];
  const olderRows: MeasurementRow[] = [];
  for (const { rows } of results) {
    for (const row of rows) {
      const t = Date.parse(row.measured_at);
      if (Number.isNaN(t) || t < now - RETENTION_MS) continue;
      (t >= now - OVERWRITE_WINDOW_MS ? recentRows : olderRows).push(row);
    }
  }

  const perSource = Object.fromEntries(results.map((r) => [r.source, r.rows.length]));
  const failedSources = results.filter((r) => r.error !== null).map((r) => r.source);

  if (recentRows.length + olderRows.length === 0) {
    return NextResponse.json(
      { error: "Keine Windmesswerte erhalten", sources: perSource, failedSources },
      { status: 502 },
    );
  }

  // 4) Speichern. Upsert über (station_code, measured_at): Doppelte werden
  //    bei jungen Werten aktualisiert ("merge-duplicates"), bei älteren
  //    übersprungen ("ignore-duplicates"). Gibt null zurück, wenn alles
  //    geklappt hat, sonst die Fehlermeldung.
  const upsert = async (
    rows: MeasurementRow[],
    resolution: "merge-duplicates" | "ignore-duplicates",
  ): Promise<string | null> => {
    if (rows.length === 0) return null;
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/wind_measurements?on_conflict=station_code,measured_at`,
        {
          method: "POST",
          headers: { ...supabaseHeaders, Prefer: `resolution=${resolution},return=minimal` },
          body: JSON.stringify(rows),
          signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
        },
      );
      return res.ok ? null : `Status ${res.status}: ${await res.text()}`;
    } catch (err) {
      return String(err);
    }
  };
  const insertErrors = [
    await upsert(recentRows, "merge-duplicates"),
    await upsert(olderRows, "ignore-duplicates"),
  ].filter((e): e is string => e !== null);
  if (insertErrors.length > 0) {
    return NextResponse.json(
      { error: "Supabase-Insert schlug fehl", details: insertErrors, sources: perSource },
      { status: 502 },
    );
  }

  // 5) Stationsliste pflegen (siehe STATION_LIST_REFRESH_MINUTES). Unkritisch —
  //    ein Fehler wird nur protokolliert und in der Antwort gemeldet.
  const stationListError = await saveStationList(
    supabaseUrl,
    supabaseHeaders,
    results.flatMap((r) => r.stations),
    new Date(now).getUTCMinutes() < STATION_LIST_REFRESH_MINUTES,
  );
  if (stationListError) {
    console.error(`WARNUNG: Stationsliste nicht gespeichert: ${stationListError}`);
  }

  // 6) Aufräumen: Einträge älter als RETENTION_DAYS Tage löschen.
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  let deleted = true;
  try {
    const deleteRes = await fetch(
      `${supabaseUrl}/rest/v1/wind_measurements?measured_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: "DELETE",
        headers: supabaseHeaders,
        signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
      },
    );
    if (!deleteRes.ok) {
      // Aufräumen ist unkritisch — Fehler nur protokollieren, nicht abbrechen.
      console.error(
        `WARNUNG: Aufräumen alter Einträge schlug fehl (Status ${deleteRes.status})`,
      );
      deleted = false;
    }
  } catch (err) {
    console.error("WARNUNG: Aufräumen alter Einträge schlug fehl:", err);
    deleted = false;
  }

  return NextResponse.json({
    ok: true,
    saved: recentRows.length + olderRows.length,
    sources: perSource,
    failedSources,
    stationListOk: stationListError === null,
    cleanupBefore: cutoff,
    cleanupOk: deleted,
  });
}
