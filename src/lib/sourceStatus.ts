import { DATABASE_TIMEOUT_MS } from "./wind";
import { SOURCE_IDS, type SourceId } from "./sources";

// Zustand jeder Datenquelle in der Datenbank (Punkt 14 der Code-Durchsicht,
// Nov. 2026): Tabelle wind_status (supabase/ein-sammler.sql).
//
// Der Sammler (/api/collect) trägt nach jedem Lauf je Quelle ein, ob sie
// erreichbar war (mindestens eine Station geliefert hat) und ob das Speichern
// ihrer Werte geklappt hat. /api/wind liest daraus, welche Quellen "gerade
// keine Daten liefern" (gelber Hinweis auf der Karte) — nach derselben Regel
// wie früher in /api/wind: Eine Quelle fehlt, wenn sie keine einzige Station
// liefert. Stationen ohne aktuelle Werte werden nur grau.
// Vorher stellte /api/wind das bei jedem Abruf selbst bei den Diensten fest —
// seit Punkt 14 fragt die Karte die Dienste aber gar nicht mehr.
//
// In derselben Tabelle steht unter dem Namen "prognose" der Zustand der
// Prognose-Funktion (supabase/functions/fetch-wind-forecasts) — gedacht auch
// für eine spätere Überwachung (Punkt 12): Alles, was regelmäßig laufen muss,
// steht an einer Stelle.

/** Ergebnis eines Sammel-Laufs für eine Quelle. */
export interface SourceOutcome {
  source: SourceId;
  /** Zahl der Messwerte, die gespeichert werden sollten. */
  values: number;
  /** null = alles gut; sonst, was schiefging (Abruf, keine Station, Speichern). */
  error: string | null;
}

/** Eine Zeile aus wind_latest() (Feld "sources"): Name, letzter Lauf (ms), geklappt? */
export type SourceStatusRow = [string, number, boolean];

/**
 * Hat der Sammler so lange nichts eingetragen, gilt er als ausgefallen: Der
 * Cron-Job läuft alle 5 min, 15 min sind drei verpasste Läufe. /api/wind holt
 * die Werte dann im Notbetrieb direkt bei den Quellen.
 */
export const COLLECTOR_SILENT_AFTER_MS = 15 * 60 * 1000;

// Lange Fehlermeldungen (z. B. eine ganze HTML-Fehlerseite) gekürzt speichern.
const MAX_ERROR_LENGTH = 500;

/**
 * Zustand aller Quellen eines Sammel-Laufs speichern. Zwei Schreibvorgänge,
 * weil ok_at bei einer gescheiterten Quelle stehen bleiben soll (seit wann sie
 * fehlt) — Supabase verlangt bei mehreren Zeilen auf einmal überall dieselben
 * Spalten. Gibt null zurück, wenn alles geklappt hat, sonst die Fehlermeldung.
 */
export async function saveSourceStatus(
  supabaseUrl: string,
  headers: Record<string, string>,
  outcomes: SourceOutcome[],
  checkedAt: string,
): Promise<string | null> {
  const succeeded = outcomes
    .filter((o) => o.error === null)
    .map((o) => ({
      name: o.source,
      checked_at: checkedAt,
      ok: true,
      ok_at: checkedAt,
      value_count: o.values,
      error: null,
    }));
  const failed = outcomes
    .filter((o) => o.error !== null)
    .map((o) => ({
      name: o.source,
      checked_at: checkedAt,
      ok: false,
      value_count: o.values,
      error: (o.error ?? "").slice(0, MAX_ERROR_LENGTH),
    }));

  const save = async (rows: object[]): Promise<string | null> => {
    if (rows.length === 0) return null;
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/wind_status?on_conflict=name`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
      });
      return res.ok ? null : `Status ${res.status}: ${await res.text()}`;
    } catch (err) {
      return String(err);
    }
  };
  const errors = (await Promise.all([save(succeeded), save(failed)])).filter(
    (e): e is string => e !== null,
  );
  return errors.length > 0 ? errors.join("; ") : null;
}

/**
 * Welche Quellen gerade keine Daten liefern: Ihr letzter Sammel-Lauf ist
 * gescheitert. Quellen ohne Eintrag (z. B. kurz nach dem Anlegen der Tabelle)
 * gelten nicht als fehlend — ihre Stationen werden ohnehin grau, sobald die
 * Werte zu alt sind.
 */
export function missingSourcesFromStatus(rows: SourceStatusRow[]): SourceId[] {
  const failed = new Set(rows.filter(([, , ok]) => !ok).map(([name]) => name));
  return SOURCE_IDS.filter((id) => failed.has(id));
}

/**
 * true, wenn der Sammler seit COLLECTOR_SILENT_AFTER_MS keine Quelle mehr
 * eingetragen hat. Ohne jeden Eintrag false (siehe oben).
 */
export function collectorIsSilent(rows: SourceStatusRow[], now: number): boolean {
  const sourceRows = rows.filter(([name]) => (SOURCE_IDS as string[]).includes(name));
  if (sourceRows.length === 0) return false;
  const newest = Math.max(...sourceRows.map(([, checkedAt]) => checkedAt));
  return now - newest > COLLECTOR_SILENT_AFTER_MS;
}
