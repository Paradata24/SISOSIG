// Hintergrund-Helfer ("Service Worker") der Web-App SISOSIG (Okt. 2026).
//
// Angemeldet wird er nur, wenn die Seite als App läuft (siehe
// src/components/ServiceWorkerRegistration.tsx). Aufgaben:
//   1. Die App startet auch OHNE NETZ (Seite und Programmteile gespeichert).
//   2. Ohne Netz zeigt sie die zuletzt geladenen Windwerte — mit dem Zeitpunkt,
//      von dem sie stammen (Kopfzeile "x-sisosig-gespeichert", ausgewertet in
//      WindMap/FlightMode), damit niemand alte Werte für aktuell hält.
//   3. Jedes angesehene Kartenstück wird gespeichert. Wer das Fluggebiet vor
//      dem Start einmal in den gebrauchten Zoomstufen anschaut, hat es in der
//      Luft auch ohne Empfang.
//
// Grundregel: MIT Netz verhält sich alles wie die normale Website — Seite und
// Windwerte kommen immer zuerst frisch aus dem Netz, der Speicher ist nur der
// Ersatz bei Netzausfall. Das ist wichtig, weil der Helfer bei Android auch
// für die Website in Chrome gilt, sobald die App installiert ist.
//
// Bewusst KEIN Knopf "ganzes Gebiet herunterladen": Die Kartendienste
// (OpenTopoMap, Esri) verbieten Massen-Downloads in ihren Nutzungsregeln.
// Gespeichert wird nur, was man sich ohnehin ansieht.
//
// Bewusst ohne Zusatzpaket (z. B. Serwist) geschrieben: Das bräuchte eine
// webpack-Einstellung, die Seite baut aber mit Turbopack.

// Bei einer grundlegenden Änderung an diesem Helfer hochzählen: Die alten
// Speicher werden dann beim nächsten Start gelöscht.
const VERSION = "v1";
const PAGE_CACHE = `sisosig-seite-${VERSION}`;
const STATIC_CACHE = `sisosig-programm-${VERSION}`;
const DATA_CACHE = `sisosig-daten-${VERSION}`;
const TILE_CACHE = `sisosig-karte-${VERSION}`;
// Kabel des Flugmodus (/api/kabel) in einem eigenen Speicher ohne Obergrenze
// (nur ein Eintrag): Im gemeinsamen Datenspeicher könnten sie sonst von vielen
// angeschauten Stationen (MAX_DATA) verdrängt werden — und im Flug ohne Netz
// fehlen.
const CABLE_CACHE = `sisosig-kabel-${VERSION}`;
const ALL_CACHES = [PAGE_CACHE, STATIC_CACHE, DATA_CACHE, TILE_CACHE, CABLE_CACHE];

// Obergrenzen, damit das Handy nicht vollläuft. Ein Kartenstück hat rund
// 10–30 KB, 4000 Stück sind also höchstens ~100 MB — genug für ein Fluggebiet
// in mehreren Zoomstufen. Darüber fliegen die ältesten zuerst raus.
const MAX_TILES = 4000;
// Programmteile: Jede neue Version der Website bringt neue Dateien mit; die
// der aktuellen Version sind immer die zuletzt gespeicherten und bleiben.
const MAX_STATIC = 300;
// Windwerte, Verlauf, Prognosen (je Station ein Eintrag).
const MAX_DATA = 150;
// Kartenstücke werden nach so langer Zeit (mit Netz) neu geholt, damit
// Änderungen an der Karte irgendwann ankommen.
const TILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Kopfzeile mit dem Zeitpunkt, an dem eine Antwort gespeichert wurde.
const STORED_HEADER = "x-sisosig-gespeichert";

// Kartendienste, deren Kartenstücke gespeichert werden (gleiche Liste wie in
// src/components/WindMap.tsx). Alle vier erlauben den Abruf von fremden Seiten
// (CORS, im Okt. 2026 geprüft) — nur so lassen sich die Stücke speichern.
const TILE_HOSTS = [
  "tile.opentopomap.org",
  "server.arcgisonline.com",
  "basemaps.cartocdn.com",
  "geoservices9.civis.bz.it",
];

self.addEventListener("install", () => {
  // Neue Version sofort übernehmen statt erst nach dem Schließen aller Fenster.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("sisosig-") && !ALL_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// Beim ersten Start war der Helfer noch nicht da, als Seite und Programmteile
// geladen wurden. Die Seite schickt deshalb nach der Anmeldung die Liste der
// schon geladenen Dateien, die hier nachträglich gespeichert werden — sonst
// ginge "ohne Netz starten" erst ab dem zweiten Öffnen.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "dateien-merken" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      for (const url of data.urls) {
        try {
          const parsed = new URL(url, self.location.origin);
          if (parsed.origin !== self.location.origin) continue;
          if (parsed.pathname.startsWith("/_next/static/")) {
            const cache = await caches.open(STATIC_CACHE);
            if (!(await cache.match(parsed.href))) await cache.add(parsed.href);
          } else if (parsed.pathname === "/") {
            const cache = await caches.open(PAGE_CACHE);
            await cache.add("/");
          } else if (parsed.pathname === "/api/wind" || parsed.pathname === "/api/timeline") {
            // Windwerte und Verlauf gleich einmal frisch holen und speichern,
            // nicht erst beim nächsten Abruf der Seite (bis zu 10 min später).
            const response = await fetch(parsed.href);
            if (response.ok) {
              const cache = await caches.open(DATA_CACHE);
              await cache.put(parsed.href, await withStoredTime(response));
            }
          }
        } catch {
          // Einzelne Datei nicht zu holen: egal, sie kommt beim nächsten Mal.
        }
      }
      await trimCache(STATIC_CACHE, MAX_STATIC);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(pageNetworkFirst(request));
    } else if (url.pathname.startsWith("/_next/static/")) {
      event.respondWith(cacheFirst(request, STATIC_CACHE, MAX_STATIC));
    } else if (url.pathname === "/api/kabel") {
      event.respondWith(dataNetworkFirst(request, CABLE_CACHE, null));
    } else if (url.pathname.startsWith("/api/")) {
      event.respondWith(dataNetworkFirst(request, DATA_CACHE, MAX_DATA));
    }
    // Alles andere (Symbole, Manifest …) geht unverändert ans Netz.
    return;
  }

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tile(request));
  }
});

// Seite: frisch aus dem Netz, ohne Netz die zuletzt gespeicherte.
async function pageNetworkFirst(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("/", response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match("/", { ignoreVary: true });
    if (cached) return cached;
    throw error;
  }
}

// Programmteile: Ihr Dateiname ändert sich mit jedem Inhalt, eine gespeicherte
// Datei ist also nie veraltet.
async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    void trimCache(cacheName, maxEntries);
  }
  return response;
}

// Windwerte & Co.: immer zuerst frisch aus dem Netz (die Seite verhält sich
// mit Netz also wie bisher). Ohne Netz die zuletzt gespeicherte Antwort, mit
// dem Zeitpunkt des Speicherns als Kopfzeile. maxEntries null = ohne
// Obergrenze (Kabel, siehe CABLE_CACHE).
async function dataNetworkFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, await withStoredTime(response.clone()));
      if (maxEntries !== null) void trimCache(cacheName, maxEntries);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    throw error;
  }
}

// Kartenstücke: aus dem Speicher, wenn vorhanden (schneller, spart Akku und
// Datenvolumen); sonst aus dem Netz holen und speichern. Sehr alte Stücke
// werden mit Netz erneuert.
let tilePutsSinceTrim = 0;
async function tile(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request.url);
  if (cached && !isOlderThan(cached, TILE_MAX_AGE_MS)) return cached;

  try {
    // Die Karte fragt Kartenstücke als einfache Bilder ab. Für den Speicher
    // braucht es aber eine "offene" Antwort (CORS) — sonst zählt der Browser
    // jedes Stück mit mehreren MB gegen das Speicherlimit. Deshalb hier selbst
    // im CORS-Modus abrufen; die Kartendienste erlauben das.
    const response = await fetch(request.url, { mode: "cors", credentials: "omit" });
    if (response.ok) {
      await cache.put(request.url, await withStoredTime(response.clone()));
      tilePutsSinceTrim += 1;
      if (tilePutsSinceTrim >= 100) {
        tilePutsSinceTrim = 0;
        void trimCache(TILE_CACHE, MAX_TILES);
      }
    }
    return response;
  } catch {
    if (cached) return cached;
    // CORS-Abruf gescheitert (z. B. ein Dienst ändert seine Regeln): ganz
    // normal weiterreichen, dann eben ohne Speichern.
    return fetch(request);
  }
}

async function withStoredTime(response) {
  const headers = new Headers(response.headers);
  headers.set(STORED_HEADER, new Date().toISOString());
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isOlderThan(response, ms) {
  const stored = Date.parse(response.headers.get(STORED_HEADER) || "");
  return Number.isNaN(stored) || Date.now() - stored > ms;
}

// Die ältesten Einträge löschen (der Speicher liefert sie in der Reihenfolge,
// in der sie gespeichert wurden).
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) {
    await cache.delete(keys[i]);
  }
}
