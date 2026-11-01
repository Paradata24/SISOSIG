import { NextResponse } from "next/server";
import { MISSING_SOURCES_HEADER, type WindStation } from "@/lib/wind";
import { SOURCE_IDS, WIND_SOURCES, type SourceId } from "@/lib/sources";
import { fetchLatestFromDatabase } from "@/lib/stationList";
import { collectorIsSilent, missingSourcesFromStatus } from "@/lib/sourceStatus";

// Aktuelle Werte ALLER Stationen für die Karte.
//
// --- Ein Sammler, eine Wahrheit (Nov. 2026, Punkt 14 der Code-Durchsicht) ---
// Die Werte kommen aus der Datenbank: Der Sammler (/api/collect) holt alle
// 5 Minuten bei den Wetterdiensten ab und speichert Messwerte, Stationsliste
// und den Zustand jeder Quelle; hier wird das in EINER Anfrage gelesen
// (fetchLatestFromDatabase in src/lib/stationList.ts, ~0,1 s). Vorher fragte
// diese Route bei jedem Abruf alle sieben Dienste selbst (bis zu 8 s
// Zeitlimit je Quelle), und Karte und Verlaufsbalken konnten verschiedene
// Stände zeigen.
// Preis: Ein neuer Messwert erscheint erst nach dem nächsten Sammel-Lauf, im
// Schnitt 2–3 Minuten später als vorher, höchstens 5 (vom Projektbesitzer so
// entschieden).
//
// --- Ausfälle ---
// Liefert eine Quelle nichts, bleiben ihre Stationen mit dem letzten Wert
// stehen und werden nach der Grau-Grenze grau (wie bei einem Sensorausfall).
// Welche Quellen gerade fehlen, hat der Sammler eingetragen; es steht in der
// Kopfzeile MISSING_SOURCES_HEADER, und WindMap zeigt daraus den Hinweis
// "… liefert gerade keine Daten".
//
// NOTBETRIEB: Antwortet die Datenbank nicht (oder ist sie leer), oder hat der
// Sammler seit 15 Minuten nichts eingetragen (COLLECTOR_SILENT_AFTER_MS),
// holt die Route die Werte wie früher selbst bei den Quellen — alle
// gleichzeitig, jede mit Zeitlimit (SOURCE_TIMEOUT_MS). So bleibt die Karte
// auch dann benutzbar. Kopfzeile "x-sisosig-notbetrieb" mit dem Grund (nur zur
// Fehlersuche).
//
// --- Zwischenspeicherung (Caching) ---
// Die fertige Antwort teilt das CDN (Vercel) 60 s lang zwischen allen
// Besuchern (RESPONSE_CACHE_CONTROL). Die Nachfrist (stale-while-revalidate)
// ist bewusst kurz: Bis Okt. 2026 hingen die Live-Werte durch lange
// Nachfristen bis zu ~10 min hinter der Datenbank her. Das stale-Flag (grauer
// Ring) wird bei jedem echten Lauf frisch gegen die Uhrzeit berechnet
// (STALE_AFTER_MINUTES in src/lib/wind.ts).

const RESPONSE_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=30";

const NOTBETRIEB_HEADER = "x-sisosig-notbetrieb";

// Eine Quelle abfragen, ohne dass ihr Fehler (oder ihr Zeitlimit) die
// anderen mitreißt: Im Fehlerfall wird nur protokolliert und eine leere Liste
// geliefert.
async function fetchSafely(source: SourceId): Promise<WindStation[]> {
  try {
    return await WIND_SOURCES[source].live();
  } catch (err) {
    console.error(`Quelle ${source} nicht abrufbar:`, err);
    return [];
  }
}

// Notbetrieb: alle Quellen gleichzeitig direkt abfragen (die Arbeitsweise bis
// Nov. 2026). Fehlende Quellen sind hier die ohne eine einzige Station
// (Fehler, Zeitlimit oder leere Antwort) — deren Stationen fehlen dann, die
// Datenbank ist ja gerade keine Hilfe.
async function fetchFromSources(): Promise<{
  stations: WindStation[];
  missingSources: SourceId[];
}> {
  const results = await Promise.all(SOURCE_IDS.map(fetchSafely));
  return {
    stations: results.flat(),
    missingSources: SOURCE_IDS.filter((_, i) => results[i].length === 0),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedStations = searchParams.get("station");

  // Normalbetrieb: alles aus der Datenbank (siehe oben).
  let stations: WindStation[];
  let missingSources: SourceId[];
  let notbetrieb: string | null = null;
  const fromDatabase = await fetchLatestFromDatabase();
  if (!fromDatabase) {
    notbetrieb = "datenbank";
  } else if (fromDatabase.stations.length === 0) {
    notbetrieb = "datenbank-leer";
  } else if (collectorIsSilent(fromDatabase.sources, Date.now())) {
    notbetrieb = "sammler";
  }
  if (fromDatabase && notbetrieb === null) {
    stations = fromDatabase.stations;
    missingSources = missingSourcesFromStatus(fromDatabase.sources);
  } else {
    console.error(`/api/wind im Notbetrieb (${notbetrieb}): Werte direkt von den Quellen`);
    ({ stations, missingSources } = await fetchFromSources());
  }

  stations.sort((a, b) => a.stationName.localeCompare(b.stationName, "de"));

  if (stations.length === 0) {
    return NextResponse.json(
      { error: "Winddaten sind gerade nicht verfügbar – keine Quelle liefert Werte" },
      { status: 502 },
    );
  }

  // Optional gefiltert über ?station=CODE1,CODE2 (für Tests/Debugging;
  // funktioniert auch mit Codes wie "pioupiou-413", "slf-ZNZ1" oder "meteoswiss-SAE").
  if (requestedStations) {
    const wanted = new Set(
      requestedStations.split(",").map((c) => c.trim()).filter(Boolean),
    );
    stations = stations.filter((s) => wanted.has(s.stationCode));
    if (stations.length === 0) {
      return NextResponse.json(
        { error: "Keine der angefragten Stationen gefunden" },
        { status: 404 },
      );
    }
  }

  // Nur die erfolgreiche Antwort darf vom CDN zwischengespeichert werden —
  // Fehlerantworten (oben) bekommen bewusst keinen Cache-Control-Header,
  // damit sich ein kurzer Ausfall nicht 60 s lang "festsetzt".
  const headers: Record<string, string> = { "Cache-Control": RESPONSE_CACHE_CONTROL };
  if (missingSources.length > 0) headers[MISSING_SOURCES_HEADER] = missingSources.join(",");
  if (notbetrieb) headers[NOTBETRIEB_HEADER] = notbetrieb;
  return NextResponse.json(stations, { headers });
}
