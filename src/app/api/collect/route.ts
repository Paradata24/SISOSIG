import { NextResponse } from "next/server";
import { SOURCE_IDS, WIND_SOURCES, type MeasurementRow, type SourceId } from "@/lib/sources";
import { saveStationList } from "@/lib/stationList";
import { saveSourceStatus, type SourceOutcome } from "@/lib/sourceStatus";
import { DATABASE_TIMEOUT_MS, type WindStation } from "@/lib/wind";

// Sammel-Route: ruft alle Wetterdienste ab (Liste in src/lib/sources.ts,
// Logik je Quelle in src/lib/) und schreibt die Windwerte in die
// Supabase-Tabelle wind_measurements. Ersetzt den früheren
// GitHub-Actions-Workflow und wird stattdessen von Supabase Cron per POST
// angestoßen.
//
// EIN SAMMLER, EINE WAHRHEIT (Nov. 2026, Punkt 14 der Code-Durchsicht): Diese
// Route ist die EINZIGE Stelle, die mit den Wetterdiensten spricht. Die Karte
// (/api/wind) liest die Werte aus der Datenbank, die Prognose-Funktion die
// Stationsliste. Deshalb speichert der Sammler neben den Messwerten auch
//  - die Stationsliste (Tabelle wind_stations: Name, Lage, Höhe; Okt. 2026)
//  - den Zustand jeder Quelle (Tabelle wind_status, src/lib/sourceStatus.ts):
//    Daraus zeigt die Karte den Hinweis "… liefert gerade keine Daten".
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
// eine solche einzelne Lücke überbrückt (measurementGapMs in src/lib/wind.ts).
//
// AUSFÄLLE: Alle Quellen werden gleichzeitig abgefragt, jede mit Zeitlimit
// (SOURCE_TIMEOUT_MS in src/lib/wind.ts). Scheitert eine, werden die übrigen
// trotzdem gespeichert — seit Okt. 2026 auch dann, wenn der Bozner Dienst
// ausfällt (vorher brach der ganze Lauf ab, und es entstand eine Lücke bei
// ALLEN Quellen). Seit Nov. 2026 (Punkt 13) speichert auch jede Quelle für
// sich: Vorher gingen alle Werte in einem gemeinsamen Schreibvorgang, und ein
// einziger Wert, den die Datenbank ablehnt, hätte den ganzen Lauf verworfen.
// Die Antwort nennt je Quelle die Zahl der Werte und die gescheiterten Quellen
// samt Grund.
//
// Aufruf nur mit gültigem Token:
//   POST /api/collect
//   Header: Authorization: Bearer <CRON_SECRET>
//
// Benötigte serverseitige Umgebungsvariablen (in Vercel hinterlegen):
//   SUPABASE_URL               z.B. https://xyz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service_role Key des Supabase-Projekts
//   CRON_SECRET                selbst gewähltes Geheimnis für den Cron-Aufruf

// Aufbewahrung in der Datenbank. Verlaufs- und Zeitbalken zeigen HISTORY_HOURS
// (48 h, siehe src/lib/wind.ts) — die Aufbewahrung muss LÄNGER sein, sonst
// fehlt am linken Rand ein Stück. 3 Tage = 1 Tag Puffer (Nov. 2026; bei der
// 12-h-Anzeige waren es 2 Tage). Rund 200.000 Zeilen, also weiter klein.
// Gleicher Wert wie RETENTION_DAYS in der Edge Function (Prognosen).
const RETENTION_DAYS = 3;
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

// Ergebnis eines Laufs für eine Quelle: Zustand (für wind_status) und ihre
// Stationen (für die Stationsliste).
interface SourceRun extends SourceOutcome {
  stations: WindStation[];
}

// Werte in die Datenbank schreiben. Upsert über (station_code, measured_at):
// Doppelte werden bei jungen Werten aktualisiert ("merge-duplicates"), bei
// älteren übersprungen ("ignore-duplicates"). Gibt null zurück, wenn alles
// geklappt hat, sonst die Fehlermeldung.
async function upsertMeasurements(
  supabaseUrl: string,
  headers: Record<string, string>,
  rows: MeasurementRow[],
  resolution: "merge-duplicates" | "ignore-duplicates",
): Promise<string | null> {
  if (rows.length === 0) return null;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/wind_measurements?on_conflict=station_code,measured_at`,
      {
        method: "POST",
        headers: { ...headers, Prefer: `resolution=${resolution},return=minimal` },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
      },
    );
    return res.ok ? null : `Status ${res.status}: ${await res.text()}`;
  } catch (err) {
    return String(err);
  }
}

// Eine Quelle abrufen und ihre Werte speichern — unabhängig von den anderen:
// Weder ein Abruf- noch ein Speicherfehler betrifft eine andere Quelle.
async function collectSource(
  source: SourceId,
  supabaseUrl: string,
  headers: Record<string, string>,
  now: number,
): Promise<SourceRun> {
  let rows: MeasurementRow[];
  let stations: WindStation[];
  try {
    ({ rows, stations } = await WIND_SOURCES[source].collect(now - HISTORY_WINDOW_MS));
  } catch (err) {
    console.error(`Quelle ${source} nicht abrufbar:`, err);
    return { source, values: 0, error: `Abruf: ${String(err)}`, stations: [] };
  }

  // Zeilen aufteilen: jung = überschreiben, älter als OVERWRITE_WINDOW_MS =
  // nur ergänzen. Längst ausgefallene Stationen (letzter Wert älter als die
  // Aufbewahrung, z. B. ein seit Tagen toter Sensor) würden nach dem Speichern
  // sofort wieder gelöscht — gar nicht erst schreiben.
  const recentRows: MeasurementRow[] = [];
  const olderRows: MeasurementRow[] = [];
  for (const row of rows) {
    const t = Date.parse(row.measured_at);
    if (Number.isNaN(t) || t < now - RETENTION_MS) continue;
    (t >= now - OVERWRITE_WINDOW_MS ? recentRows : olderRows).push(row);
  }
  const values = recentRows.length + olderRows.length;
  if (values === 0) {
    // Ohne eine einzige Station gilt die Quelle als ausgefallen (z. B.
    // veröffentlicht MeteoSchweiz zeitweise eine Datei ohne Windwerte) — wie
    // früher in /api/wind. Liefert sie Stationen, nur eben ohne neue Werte
    // (z. B. lauter gestörte Sensoren), ist das kein Ausfall der Quelle: Die
    // Stationen werden auf der Karte grau, ohne gelben Hinweis.
    return {
      source,
      values: 0,
      error: stations.length === 0 ? "Keine Stationen erhalten" : null,
      stations,
    };
  }

  const writeErrors = [
    await upsertMeasurements(supabaseUrl, headers, recentRows, "merge-duplicates"),
    await upsertMeasurements(supabaseUrl, headers, olderRows, "ignore-duplicates"),
  ].filter((e): e is string => e !== null);
  if (writeErrors.length > 0) {
    console.error(`Quelle ${source}: Speichern schlug fehl:`, writeErrors.join("; "));
    return { source, values, error: `Speichern: ${writeErrors.join("; ")}`, stations };
  }
  return { source, values, error: null, stations };
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

  // 2) Alle Quellen gleichzeitig abrufen, jede speichert für sich (siehe
  //    collectSource). Eine gescheiterte Quelle hält die übrigen nicht auf.
  const now = Date.now();
  const runs = await Promise.all(
    SOURCE_IDS.map((source) => collectSource(source, supabaseUrl, supabaseHeaders, now)),
  );
  const perSource = Object.fromEntries(runs.map((r) => [r.source, r.values]));
  const errors = Object.fromEntries(
    runs.filter((r) => r.error !== null).map((r) => [r.source, r.error]),
  );
  const failedSources = Object.keys(errors);
  const saved = runs.reduce((sum, r) => sum + (r.error === null ? r.values : 0), 0);

  // 3) Zustand jeder Quelle eintragen — gerade auch dann, wenn etwas
  //    gescheitert ist: Daraus zeigt die Karte "… liefert gerade keine Daten",
  //    und /api/wind erkennt daran, dass der Sammler läuft.
  const statusError = await saveSourceStatus(
    supabaseUrl,
    supabaseHeaders,
    runs,
    new Date(now).toISOString(),
  );
  if (statusError) {
    console.error(`WARNUNG: Zustand der Quellen nicht gespeichert: ${statusError}`);
  }

  if (saved === 0) {
    return NextResponse.json(
      {
        error: "Keine Windmesswerte gespeichert",
        sources: perSource,
        failedSources,
        errors,
        sourceStatusOk: statusError === null,
      },
      { status: 502 },
    );
  }

  // 4) Stationsliste pflegen (siehe STATION_LIST_REFRESH_MINUTES). Unkritisch —
  //    ein Fehler wird nur protokolliert und in der Antwort gemeldet.
  const stationListError = await saveStationList(
    supabaseUrl,
    supabaseHeaders,
    runs.flatMap((r) => r.stations),
    new Date(now).getUTCMinutes() < STATION_LIST_REFRESH_MINUTES,
  );
  if (stationListError) {
    console.error(`WARNUNG: Stationsliste nicht gespeichert: ${stationListError}`);
  }

  // 5) Aufräumen: Einträge älter als RETENTION_DAYS Tage löschen.
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
    saved,
    sources: perSource,
    failedSources,
    errors,
    stationListOk: stationListError === null,
    sourceStatusOk: statusError === null,
    cleanupBefore: cutoff,
    cleanupOk: deleted,
  });
}
