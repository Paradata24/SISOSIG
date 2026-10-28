import { NextResponse } from "next/server";
import { MISSING_SOURCES_HEADER, type WindStation } from "@/lib/wind";
import { fetchBolzanoStations } from "@/lib/bolzano";
import { fetchOpenWindMapStations } from "@/lib/pioupiou";
import { fetchSlfStations } from "@/lib/slf";
import { fetchGeoSphereStations } from "@/lib/geosphere";
import { fetchMeteoSwissStations } from "@/lib/meteoswiss";
import { fetchLwdTirolStations } from "@/lib/lwdtirol";
import { fetchDwdStations } from "@/lib/dwd";
import { fetchLastKnownStations } from "@/lib/stationList";

// Live-Werte ALLER Stationen für die Karte: Bozner Wetterdienst
// (src/lib/bolzano.ts), OpenWindMap/Pioupiou, SLF, GeoSphere, MeteoSchweiz,
// LWD Tirol und DWD — jede Quelle hat ihre eigene Datei in src/lib/.
//
// --- Zwischenspeicherung (Caching) ---
// Die Stationen messen nur alle 5-10 Minuten, daher muss nicht jeder
// Seitenaufruf die Upstream-Dienste neu abfragen:
// - Die fertige JSON-Antwort wird über den Cache-Control-Header (s-maxage)
//   60 s vom CDN (Vercel) geteilt: gleichzeitige Besucher bekommen dieselbe
//   Antwort, ohne dass die Route erneut läuft. Damit fragt die Route den
//   Bozner Dienst höchstens etwa einmal pro Minute ab.
// - Die Bozner Messwerte (/sensors) holt src/lib/bolzano.ts dabei immer
//   frisch (`cache: "no-store"`). Bis Okt. 2026 lagen sie zusätzlich 60 s im
//   Next.js-Daten-Cache, und das CDN durfte eine abgelaufene Antwort noch
//   240 s weiter ausliefern (stale-while-revalidate). Beide Speicher geben
//   nach Ablauf ZUERST den alten Stand heraus und holen erst danach im
//   Hintergrund neu — bei wenigen Besuchern und dem 3-min-Takt der Karte sah
//   man so den Stand von vor zwei Abrufen. Ergebnis: Die Karte hing bis zu
//   ~10 min hinter der Datenbank her (Rittner Horn "Stand 15:40", obwohl der
//   15:50-Wert seit 16:05 im Verlaufsbalken stand). Jetzt bleibt nur der
//   CDN-Speicher, mit kurzer Nachfrist (RESPONSE_CACHE_CONTROL).
// - Die übrigen Quellen (Pioupiou, GeoSphere mit Anfrage-Grenze, MeteoSchweiz,
//   LWD Tirol, DWD, SLF) haben ihren eigenen kurzen Zwischenspeicher in
//   src/lib/, der nach Ablauf ebenfalls sofort frisch holt
//   (src/lib/freshCache.ts bzw. der eigene Speicher in slf.ts).
// - Die Stationsmetadaten (Name, Koordinaten, Höhe) ändern sich praktisch
//   nie und werden 6 h gehalten.
// Das stale-Flag (grauer Ring) wird trotzdem bei jedem echten Routen-Lauf
// frisch gegen die aktuelle Uhrzeit berechnet (STALE_AFTER_MINUTES in
// src/lib/wind.ts) — bis zu 60 s alte Cache-Daten sind dafür bedeutungslos.
//
// --- Gleichzeitige Abrufe und Ausfälle ---
// Die Quellen hängen NICHT voneinander ab und werden gleichzeitig abgefragt:
// Die Route dauert damit nur so lange wie die langsamste Quelle, höchstens
// aber bis zu deren Zeitlimit (SOURCE_TIMEOUT_MS in src/lib/wind.ts).
// Jede Quelle ist ein "Zusatz": Scheitert sie oder liefert sie keine einzige
// Station, zeigt die Karte die übrigen trotzdem. Das gilt seit Okt. 2026
// auch für Bozen — vorher war bei einem Ausfall des Bozner Dienstes die ganze
// Karte leer, auch die Schweiz und Österreich. Welche Quellen gerade fehlen,
// steht in der Kopfzeile MISSING_SOURCES_HEADER; WindMap zeigt daraus den
// Hinweis "… liefert gerade keine Daten".
// Die Stationen einer fehlenden Quelle verschwinden dabei nicht (Okt. 2026):
// Sie kommen mit ihrem letzten gespeicherten Wert aus der Datenbank
// (src/lib/stationList.ts) und werden nach der Grau-Grenze grau, wie bei
// einem Sensorausfall. So bleiben auch Zeitbalken und Verlaufsbalken für sie
// nutzbar.

// Nachfrist (stale-while-revalidate) bewusst nur 30 s: Gerade wenn kaum
// jemand zuschaut, wäre jede abgelaufene Antwort sonst noch Minuten alt.
const RESPONSE_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=30";

// Alle Quellen der Karte. Eine neue Quelle braucht hier einen Eintrag (und in
// /api/collect, damit ihr Verlauf gespeichert wird).
const SOURCES: Array<[WindStation["source"], () => Promise<WindStation[]>]> = [
  ["bolzano", fetchBolzanoStations],
  ["openwindmap", fetchOpenWindMapStations],
  ["slf", fetchSlfStations],
  ["geosphere", fetchGeoSphereStations],
  ["meteoswiss", fetchMeteoSwissStations],
  ["lwdtirol", fetchLwdTirolStations],
  ["dwd", fetchDwdStations],
];

// Eine Quelle abfragen, ohne dass ihr Fehler (oder ihr Zeitlimit) die
// anderen mitreißt: Im Fehlerfall wird nur protokolliert und eine leere Liste
// geliefert.
async function fetchSafely(
  source: WindStation["source"],
  fetchStations: () => Promise<WindStation[]>,
): Promise<WindStation[]> {
  try {
    return await fetchStations();
  } catch (err) {
    console.error(`Quelle ${source} nicht abrufbar:`, err);
    return [];
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedStations = searchParams.get("station");

  const results = await Promise.all(
    SOURCES.map(([source, fetchStations]) => fetchSafely(source, fetchStations)),
  );
  // Quellen ohne eine einzige Station: Fehler, Zeitlimit oder leere Antwort
  // (z. B. veröffentlicht MeteoSchweiz zeitweise eine Datei ohne Windwerte).
  const missingSources = SOURCES.filter((_, i) => results[i].length === 0).map(
    ([source]) => source,
  );
  // Ihre Stationen mit dem letzten gespeicherten Wert (siehe oben). Nur bei
  // einem Ausfall wird dafür die Datenbank gefragt.
  const lastKnown = await fetchLastKnownStations(missingSources);

  let stations = [...results.flat(), ...lastKnown].sort((a, b) =>
    a.stationName.localeCompare(b.stationName, "de"),
  );

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
  return NextResponse.json(stations, { headers });
}
