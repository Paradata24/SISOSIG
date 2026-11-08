# CLAUDE.md

Diese Datei ist die **Landkarte** des Projekts für Claude Code
(claude.ai/code): Wer ist wofür zuständig, welche Regeln gelten, welche
Entscheidungen stehen fest.

**Details stehen im Code, nicht hier.** Alle Dateien sind durchgehend auf
Deutsch kommentiert — inklusive Begründung, warum etwas so gebaut ist. Vor
einer Änderung deshalb: hier die Zuständigkeit und die Regeln nachschlagen,
dann die betreffende Datei lesen. Nutzer-/Einrichtungsdokumentation (Supabase,
Vercel, Cron, Schritt-für-Schritt-Anleitungen) steht in `README.md`.

@AGENTS.md

## Über den Projektbesitzer
- Ich bin absoluter Nicht-Programmierer (keine Kenntnisse in
  JavaScript, TypeScript, HTML, CSS oder generell Programmieren)
- Erkläre Änderungen und Vorschläge immer in einfacher, klarer
  Sprache, ohne Fachjargon vorauszusetzen
- Wenn ich etwas außerhalb des Codes tun muss (z.B. in GitHub, Vercel,
  Supabase klicken), gib mir genaue Schritt-für-Schritt-Anleitungen
  mit den exakten Menüpunkten/Buttons
- Ausnahme: Den Ablauf Pull Request → Vercel-Vorschau → „Merge pull request"
  kenne ich inzwischen. Nicht jedes Mal erklären; es reicht zu sagen, auf
  welchem Zweig die Änderung liegt und ob ein Pull Request angelegt wurde.
- Bei mehreren möglichen Lösungswegen: triff eine klare Empfehlung
  statt mich mit Optionen zu überfordern, außer ich frage explizit
  danach

## Projektkontext
- Website für Live-Windwerte für Gleitschirmflieger, Startpunkt:
  Südtiroler Wetterstationen (Provinz Bozen Open Data API)
- Aktuell nur ich + wenige Nutzer, aber die Architektur soll
  skalierbar bleiben
- Phasenplan:
  1. Südtirol: Live-Wind + 48h-Historie auf Karte (aktuell in Arbeit)
  2. Erweiterung auf weitere Länder/Regionen (Schweiz, Österreich)
  3. Prognosevergleich mehrerer Modelle via Open-Meteo API

## Kommunikation bei Fehlern
- Wenn etwas fehlschlägt: kurz erklären WAS und WARUM, dann direkt
  einen Lösungsvorschlag machen - keine langen technischen
  Fehlerausgaben ohne Einordnung
- Bei Unsicherheit lieber nachfragen als etwas Riskantes einfach
  auszuführen (z.B. Datenbank löschen, force push)

## Kommunikation bei Änderungen
- Bei jeder Code-Änderung immer angeben, in welcher Datei (Dateiname
  + Pfad) sie gemacht wurde, z.B. "in app/components/WindMarker.tsx"
- Bei mehreren betroffenen Dateien: alle auflisten, nicht nur
  zusammenfassen

## Eigenständige Umsetzung von Änderungen
- Änderungen, die ich (Claude) fachlich für richtig und sinnvoll
  halte, immer direkt umsetzen — nicht nur vorschlagen und auf eine
  ausdrückliche Freigabe warten. Der Projektbesitzer ist
  Nicht-Programmierer und vertraut hier auf die fachliche Einschätzung.
- Weiterhin ZUERST nachfragen bei: riskanten oder schwer umkehrbaren
  Aktionen (z.B. Datenbank löschen, force push) und bei allem, was unten
  unter „Feste Entscheidungen" bzw. „Nicht wieder einführen" steht.
- Jede umgesetzte Änderung danach kurz und in einfacher Sprache
  erklären (was, warum, in welcher Datei) — siehe „Kommunikation bei
  Änderungen".

## Begriffe des Projektbesitzers
- **Hauptseite** = die normale Seite mit Karte und Live-Werten (früher
  „Live-Werte-Seite"), im Gegensatz zum Flugmodus
- **Verlaufsbalken** = das Panel unten mit dem 48h-Diagramm einer Station
  (`src/components/WindHistoryPanel.tsx`)
- **Zeitbalken** = das Zeitrad unter der Karte, mit dem man die ganze Karte
  durch die letzten 48 h dreht (`src/components/TimeSlider.tsx`)
- **Windanzeiger** = die vom Besitzer ausgewählte Stationsliste im
  Stationsfilter (Südtirol über Namen: `WINDANZEIGER_STATION_NAMES`, alle
  anderen Quellen über Stationscodes: `WINDANZEIGER_STATION_CODES`, beide in
  `src/lib/wind.ts`)

## Commands

```bash
npm run dev          # dev server (Next 16 → Turbopack), http://localhost:3000
npm run build         # production build (also type-checks)
npm run lint          # eslint
npx tsc --noEmit       # type-check only, faster than a full build
```

Es gibt **keine Tests**. Prüfen über `npm run build` bzw. Dev-Server und durch
direktes Aufrufen der API-Routen (`curl`).

## Landkarte

Next.js (App Router) + Leaflet-Karte, Daten aus dem Bozner Wetterdienst, dem
OpenWindMap/Pioupiou-Netz, den SLF-IMIS-Stationen (Schweiz), MeteoSchweiz
(alle SwissMetNet-Stationen), GeoSphere Austria (TAWES) und Meteotrentino
(alle 46 Windstationen der Provinz Trient)
sowie einzelnen Stationen des Lawinenwarndienstes Tirol und des DWD, Historie
und Prognose in Supabase.

**Ablauf:** Browser → `/api/wind` (aktuelle Werte, alle 3 min) und `/api/timeline`
(48 h für alle Stationen, beim Seitenaufruf + alle 10 min) und `/api/history` + `/api/forecast`
(48 h + Prognose einer Station) — **alle lesen nur aus Supabase** („Ein
Sammler, eine Wahrheit", Nov. 2026). Gefüttert wird Supabase von zwei Cron-Jobs:
`/api/collect` alle 5 min (die EINZIGE Stelle, die mit den Wetterdiensten
spricht: Messwerte, Stationsliste, Zustand der Quellen) und der Edge Function
`fetch-wind-forecasts` (Prognosen für die Stationen der Stationsliste; holt
nur bei einem neuen ICON-CH1-Lauf, also alle 3 h, wirklich neue Werte).

| Datei | Zuständig für |
| --- | --- |
| `src/lib/wind.ts` | Gemeinsame Typen, Farbskala, Zeitraster, Konstanten — die zentrale Stelle für fast alle Einstellwerte (auch Grau-Grenzen `STALE_AFTER_MINUTES` und Zeitlimits) |
| `src/lib/bolzano.ts` | Bozner Wetterdienst (Abruf, Zeitstempel-Umwandlung) — für Karte und Sammler |
| `src/lib/pioupiou.ts` | OpenWindMap/Pioupiou-Stationen im Alpenraum (Abruf, Höhe aus dem Namen) |
| `src/lib/slf.ts` | Schweizer IMIS-Stationen des SLF (wie auf whiterisk.ch), Messtakt 30 min |
| `src/lib/freshCache.ts` | Kurzer Zwischenspeicher für Live-Messwerte (Pioupiou, GeoSphere, MeteoSchweiz, LWD Tirol, DWD), der nach Ablauf sofort frisch holt |
| `src/lib/plausibility.ts` | Erkennung wahrscheinlicher Messfehler (eingefroren, Windfahne klemmt, unmögliche Werte) |
| `src/lib/alps.ts` | Alpen-Regel für ALLE Quellen: `isInAlps(lat, lon)` (Umriss `ALPS_POLYGON`) |
| `src/lib/geosphere.ts` | Österreichische Stationen mit Wind von GeoSphere Austria (früher ZAMG) |
| `src/lib/meteoswiss.ts` | Alle MeteoSchweiz-Stationen mit Wind (eine CSV-Datei, 10-min-Werte) |
| `src/lib/lwdtirol.ts` | Ausgewählte Stationen des Lawinenwarndienstes Tirol (`LWD_TIROL_STATIONS`, derzeit Hafelekar) |
| `src/lib/dwd.ts` | Ausgewählte DWD-Stationen (`DWD_STATIONS`, derzeit Zugspitze; liest ZIP-Dateien selbst) |
| `src/lib/meteotrentino.ts` | Alle 46 Windstationen von Meteotrentino (Provinz Trient; eine Anfrage je Station, ohne Alpen-Umriss-Prüfung) |
| `src/lib/sources.ts` | Liste ALLER Quellen (Punkt 17): je Quelle der Abruf für den Sammler und für den Notbetrieb von `/api/wind` — eine neue Quelle ist hier ein Eintrag |
| `src/app/api/wind/route.ts` | Aktuelle Werte aller Stationen aus der Datenbank (Funktion `wind_latest`), fehlende Quellen in einer Kopfzeile, CDN-Caching; Notbetrieb direkt bei den Quellen, wenn Datenbank oder Sammler ausfallen |
| `src/app/api/collect/route.ts` | Einzige Stelle, die mit den Wetterdiensten spricht: schreibt Messwerte je Quelle getrennt nach Supabase (POST, per `CRON_SECRET` geschützt), pflegt Stationsliste und Zustand der Quellen |
| `src/lib/stationList.ts` | Stationsliste in der Datenbank (`wind_stations`, Sicht `wind_stations_latest`): schreiben (Sammler) und alle aktuellen Werte für die Karte lesen (`fetchLatestFromDatabase`) |
| `src/lib/sourceStatus.ts` | Zustand jeder Quelle (Tabelle `wind_status`): schreiben (Sammler), daraus fehlende Quellen und einen Sammler-Ausfall erkennen (`/api/wind`) |
| `src/lib/earlyWind.ts` | Winddaten schon beim Öffnen der Seite anfordern (Punkt 8): kleine Zeile im `<head>` von `layout.tsx`, `WindMap` übernimmt die Antwort |
| `vercel.json` | Server-Region der Vercel-Funktionen: Dublin (`dub1`), neben der Datenbank |
| `src/app/api/history/route.ts` | 48 h Messwerte **einer** Station |
| `src/app/api/forecast/route.ts` | Prognose (ICON-CH1) **einer** Station |
| `src/app/api/timeline/route.ts` | 48 h **aller** Stationen, kompaktes Spaltenformat für den Zeitbalken; mit `?hours=8` nur die letzten 8 h (Punkt 27), gerechnet immer mit 3 h Vorlauf |
| `src/lib/timelineMerge.ts` | Fügt die letzten 8 h in den vorhandenen Zeitbalken-Stand ein (Punkt 27), Ergebnis wie beim vollen Laden |
| `src/lib/pressure.ts` | Föhn-Anzeige: Flughäfen LOWI/LIPB, Bergstationen der Kammtemperatur, Vorzeichen (Bozen − Innsbruck), Umrechnung QNH → QFF, Farbstufen, Paaren der Messungen (gemeinsam für Route, Karte, Verlaufsbalken) |
| `src/lib/stationPressure.ts` | Föhn-Anzeige: QNH alle 10 min selbst rechnen aus GeoSphere Innsbruck-Flughafen und Landesstation Bozen, mit Temperatur und Feuchte (gespeichert; angezeigt wird das QFF, `toQffSeries` in `src/lib/pressure.ts`; nur Server) |
| `src/lib/crestTemperature.ts` | Föhn-Anzeige: Temperatur auf Kammhöhe, Rittnerhorn und Hafelekar (Temperatur-Diagramm; nur Server; Stationen in `CREST_STATIONS`, `src/lib/pressure.ts`) |
| `src/app/api/pressure/route.ts` | Luftdruck Innsbruck/Bozen (48 h Stationen, ICON-CH1- und ECMWF-Prognose) und Kammtemperatur aus `pressure_values`; Notbetrieb direkt bei den Diensten |
| `src/components/pressure.ts` + `src/components/PressurePanel.tsx` | Föhn-Linie Innsbruck–Bozen auf der Karte der Hauptseite (Farbe/Schild mit Differenz) und ihr Druck-Verlaufsbalken |
| `src/app/api/kabel/route.ts` | Kabel (Luftfahrthindernisse Südtirol) für den Flugmodus, einmal am Tag vom Land geholt |
| `src/lib/kabel.ts` | Antwortformat von `/api/kabel` und Höhenklassen der Kabel (gemeinsam für Route und Flugmodus) |
| `src/app/page.tsx` / `layout.tsx` | Seitengerüst, Schrift, Hell-/Dunkelmodus-Schalter (Klasse am `<html>`) |
| `src/components/WindApp.tsx` | Titelbalken (Titel = Flugmodus-Knopf, Ebenen-Menü mit Quellen), Zustand von Stationsfilter, Ebenen der Hauptseite und Zeitbalken |
| `src/components/WindMapLoader.tsx` | Lädt die Karte ohne Server-Rendering (Leaflet braucht `window`) |
| `src/components/StationFilterPicker.tsx` | Filter-Schild oben mittig auf der Karte der Hauptseite (eingebunden in `WindMap`), klappt beim Antippen die Stationsfilter auf (im Flugmodus nur Info-Schild, Umschalten im Menü) |
| `src/components/LayerMenu.tsx` | Ebenen-Menü der Hauptseite (Knopf mit drei Strichen oben rechts im Titelbalken): Zeitbalken, KK7, Kabel, Gelände-Ebenen ein/aus, darunter die Quellen |
| `src/lib/terrain.ts` + `src/components/terrain.ts` | Gelände-Ebenen der Hauptseite: Hangausrichtung und Lee-Hänge zur Windrose, im Browser aus Höhenkacheln gerechnet (Grundwerte ohne Leaflet in `lib/`, Ebene in `components/`) |
| `src/components/WindRosePicker.tsx` | Windrose oben links auf der Karte der Hauptseite: Windrichtung wählen → Lee-Hänge rot |
| `src/components/WindMap.tsx` | Karte, Kachel-Ebene (OpenTopoMap, normal und Flugmodus), Zoom-Grenzen, Marker/Pfeile, Abruf-Takt, Auswahl einer Station |
| `src/components/FlightMode.tsx` | Flugmodus (Titel-Knopf „Should I stay or should I GO"): Tasten (Zoom, Rücksetzen, Übersicht, START/STOP, Beenden), Statuszeile, Menü, Mitführen der Karte, Standort-Marker |
| `src/components/flight/` | Teile des Flugmodus (Okt. 2026 ausgelagert): `position.ts` (GPS, Flugrichtung, Standort-Icon), `device.ts` (Bildschirm wach halten, Netz, Uhr), `track.ts` (Track-Aufzeichnung und -Linie), `igc.ts` (IGC-Datei), `cables.ts` (Kabel), `kk7.ts` (KK7-Thermikkarte) |
| `src/app/manifest.ts`, `public/apple-touch-icon.png`, `public/icons/` | Web-App „SISOSIG": App-Beschreibung (Name, Symbol, Abkürzung Flugmodus) |
| `public/sw.js` + `src/components/ServiceWorkerRegistration.tsx` | Hintergrund-Helfer der Web-App (Start ohne Netz, gespeicherte Windwerte und Kartenstücke) — nur in der App angemeldet |
| `src/components/WindHistoryPanel.tsx` | Verlaufsbalken (Diagramm, Werte-Quadrate, Prognose) |
| `src/components/TimeSlider.tsx` | Zeitbalken (Zeitrad mit Schwung, Farbstrich des Kartenausschnitts, „Aktuell"-Knopf) |
| `supabase/functions/fetch-wind-forecasts/` | Edge Function (Deno!), holt Open-Meteo-Prognosen für alle Stationen der Stationsliste, holt gescheiterte Stationen beim nächsten Anstoß nach |
| `supabase/*.sql` | Tabellen-Schemas, Cron (`collect-cron.sql`, `forecast-cron.sql`), einmalige Migrations-/Aufräumskripte |

## Feste Entscheidungen (nicht ohne Rücksprache ändern)

**Technik-Grundsatz**
- Karten-Bibliothek: **Leaflet** (bewusst statt MapLibre GL JS)
- Hosting **Vercel**, Datenbank **Supabase**, Datensammlung über
  `/api/collect`, angestoßen von **Supabase Cron** (nicht GitHub Actions)
- Secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`)
  **niemals** im Code — nur Umgebungsvariablen in Vercel/Supabase (in den
  Zeitplan-Jobs aus dem Supabase-Tresor/Vault, siehe `supabase/collect-cron.sql`)
- **Server-Region Dublin** (`vercel.json`, Okt. 2026): Vorher liefen die
  Vercel-Funktionen in Washington (`iad1`, Vercel-Standard) — jede
  Datenbankabfrage (Supabase steht in Dublin) und jeder Abruf bei den
  Wetterdiensten ging über den Atlantik (gemessen: eine Verlaufsabfrage 7 ms
  in der Datenbank, ~0,3 s mit dem Umweg). Nicht zurückstellen. Die Datei hat
  Vorrang vor der Einstellung im Vercel-Dashboard.

**Angezeigter Zeitraum: 48 h, Aufbewahrung 3 Tage** (Nov. 2026, Wunsch des
Projektbesitzers; vorher 12 h Anzeige und 2 Tage Aufbewahrung)
- `HISTORY_HOURS` in `src/lib/wind.ts` gilt für Verlaufsbalken und Zeitbalken.
  Die Aufbewahrung (`RETENTION_DAYS` in `/api/collect` UND in der Edge
  Function) muss immer länger sein, sonst fehlt links ein Stück.
- `/api/timeline` liest dafür rund 136.000 Zeilen (~8 MB aus der Datenbank,
  ~0,6 s; Nov. 2026 gemessen) — das volle Laden braucht die Seite aber nur
  noch beim Öffnen, danach genügen die letzten 8 h (Punkt 27, siehe
  „Zeitbalken = Zeitrad"). Die Edge Function fragt weiter nur 12 h
  Vergangenheit ab (`PAST_HOURS`), ältere Prognose-Stunden bleiben aus
  früheren Läufen gespeichert — kein Mehrverbrauch bei Open-Meteo.
- Schwung des Zeitrads verdoppelt (`FLING_MAX_SPEED`, höchstens ~6 h je Wisch).

**Ein Sammler, eine Wahrheit (Punkt 14, Nov. 2026, vom Projektbesitzer beauftragt)**
- **Nur der Sammler (`/api/collect`) spricht mit den Wetterdiensten.** Er
  speichert Messwerte, Stationsliste (`wind_stations`) und den Zustand jeder
  Quelle (`wind_status`, `src/lib/sourceStatus.ts`). Die Karte (`/api/wind`)
  liest alles in EINER Anfrage aus der Datenbank (Funktion `wind_latest`,
  `supabase/ein-sammler.sql`, ~20 ms in der Datenbank), die Prognose-Funktion
  nimmt ihre Stationen aus `wind_stations`. Karte, Zeitbalken und
  Verlaufsbalken zeigen dadurch immer denselben Stand.
- **Bewusst in Kauf genommen:** Ein neuer Messwert erscheint im Schnitt 2–3
  Minuten später als vorher, höchstens 5 (bis zum nächsten Sammel-Lauf). Wer
  das verkürzen will, müsste den Sammel-Takt erhöhen — nicht `/api/wind`
  wieder selbst bei den Diensten fragen lassen.
- **Notbetrieb:** Antwortet die Datenbank nicht (`LIVE_DATABASE_TIMEOUT_MS`
  5 s), ist sie leer oder hat der Sammler seit 15 min nichts eingetragen
  (`COLLECTOR_SILENT_AFTER_MS`), holt `/api/wind` die Werte wie früher direkt
  bei den Quellen (Kopfzeile `x-sisosig-notbetrieb`). Nicht entfernen — sonst
  bliebe die Karte bei einem Ausfall von Supabase oder des Cron-Jobs grau.
- **Stationen, die ihre Quelle nicht mehr führt,** verschwinden nach rund 2 h
  (`STATION_DROPPED_AFTER_MS` in `src/lib/stationList.ts`: Eintrag deutlich
  älter als der jüngste ihrer Quelle). Fällt eine ganze Quelle aus, bleiben
  ihre Stationen dagegen stehen (alle gleich alt).
- **Eine neue Quelle** ist ein Eintrag in `WIND_SOURCES` (`src/lib/sources.ts`,
  Punkt 17) plus die Angaben je Quelle in `src/lib/wind.ts` (`SOURCE_INFO`,
  `STALE_AFTER_MINUTES` usw. — TypeScript meldet fehlende). Karte und
  Prognose-Funktion brauchen nichts.

**Datenbeschaffung (Okt. 2026)**
- **Jede Quelle ist ein Zusatz — auch Bozen.** Der Sammler fragt alle Quellen
  gleichzeitig ab und speichert jede für sich (Punkt 13, Nov. 2026; vorher ein
  gemeinsamer Schreibvorgang); scheitert eine, laufen die übrigen weiter
  (vorher war bei einem Ausfall des Bozner Dienstes alles leer). Eine Quelle
  ohne eine einzige Station (Fehler, Zeitlimit, leere Antwort) oder mit
  gescheitertem Speichern trägt er in `wind_status` als gescheitert ein;
  `/api/wind` meldet sie in der Kopfzeile `MISSING_SOURCES_HEADER`, und die
  Karte zeigt dann den Hinweis „MeteoSchweiz liefert gerade keine Daten"
  (Hauptseite oben mittig, gelb; im Flugmodus als gelbe Zeile in der
  Statuszeile, damit oben keine Tasten verdeckt werden). Stationen ohne neue
  Werte werden nur grau, ohne Hinweis.
- **Grau (ausgefallen) schon nach einer halben Stunde** (Wunsch des
  Projektbesitzers, Okt. 2026; vorher 2 h): `STALE_AFTER_MINUTES` in
  `src/lib/wind.ts`. Grundregel 30 min; Quellen, die schon im Normalbetrieb
  später oder seltener liefern, haben mehr (Bozen 35, MeteoSchweiz 40,
  LWD Tirol 50, SLF 55, DWD 75 — an echten Daten gemessen, Begründung dort;
  Meteotrentino 35 ist erst geschätzt und noch an echten Daten nachzuprüfen).
  Nicht pauschal auf 30 setzen, sonst blinken diese Stationen vor jedem neuen
  Wert grau.
- **Zeitlimits für alle Abrufe** (`SOURCE_TIMEOUT_MS` 8 s,
  `METADATA_TIMEOUT_MS`, `DATABASE_TIMEOUT_MS` in `src/lib/wind.ts`; eigene in
  der Edge Function und in `/api/kabel`). Vorher hatte keine Anfrage eines —
  ein hängender Dienst hielt die ganze Karte auf. Nicht entfernen.
- **Sammler: Werte älter als 1 h werden nur ergänzt, nicht überschrieben**
  (`OVERWRITE_WINDOW_MS` in `/api/collect`; vorher schrieb jeder Lauf ~1.200
  längst gespeicherte SLF-Werte neu). SLF und DWD liefern ihren Verlauf mit,
  der Sammler nimmt von beiden die letzten 3 h.
- **Ausgefallene Quelle: Stationen bleiben stehen** (Punkt 10 der
  Code-Durchsicht, Okt. 2026; vorher verschwanden sie samt Zeitbalken und
  Verlaufsbalken). Seit Punkt 14 ergibt sich das von selbst: `/api/wind` zeigt
  immer den letzten gespeicherten Wert jeder Station (Tabelle `wind_stations`
  + Sicht `wind_stations_latest`, `supabase/stationsliste.sql`); nach der
  Grau-Grenze werden sie grau wie bei einem Sensorausfall, der gelbe Hinweis
  bleibt. Die Stationsliste pflegt der Sammler: neue Stationen sofort,
  Name/Lage/Höhe der bekannten nur zur vollen Stunde
  (`STATION_LIST_REFRESH_MINUTES`, sonst ~700 unveränderte Zeilen je Lauf).
  Stationen ohne gespeicherten Wert fehlen — nach 3 Tagen Ausfall
  (Aufbewahrung) verschwinden sie also doch.

**Darstellung**
- **Filter und Kartenausschnitt werden gemerkt** (Punkt 20 der
  Code-Durchsicht, Okt. 2026): Der zuletzt gewählte Stationsfilter
  (`FILTER_STORAGE_KEY` in `WindApp`, gilt auch im Flugmodus) und der zuletzt
  angesehene Ausschnitt der Hauptseite (`VIEW_STORAGE_KEY` in `WindMap`, im
  Flugmodus wird nichts gemerkt) liegen im Browser des Geräts; ohne
  Gemerktes startet die Karte wie bisher mit „Alle" über Südtirol. Der Filter
  wird erst nach dem ersten Bildaufbau übernommen (der Server kennt den
  Speicher nicht), die Zoomstufe der Pfeile kommt aus der Karte selbst
  (`WindMarkers`), nicht mehr fest aus `SOUTH_TYROL_ZOOM`.
- **Heller Modus dauerhaft an**, unabhängig vom Gerät des Besuchers (früher
  war es umgekehrt der Dunkelmodus). Umgesetzt dadurch, dass in
  `src/app/layout.tsx` **keine** Klasse `dark` am `<html>` steht; die
  `dark:`-Klassen im Code bleiben absichtlich stehen und greifen dadurch
  nirgends — so ist der Dunkelmodus mit einer Zeile wieder herstellbar.
  Die Karte (Kacheln, Pfeile, Beschriftungen, Auswahlring, Grenzen) und die
  Farbskala `WIND_COLOR_SCALE` waren schon immer hell und bleiben unverändert.
- **Zoom-Obergrenze der Karte: 15** (`MAP_MAX_ZOOM` in
  `src/components/WindMap.tsx`). Sie steht bewusst an der Karte selbst
  (`maxZoom` am `MapContainer`) und nicht an den Kachel-Ebenen — nur so hören
  auch Scrollrad, Doppelklick und Pinch-Zoom am Handy dort auf. Grund: Die
  Esri-Schummerung der früheren Karte „Relief (Grau)" lieferte darüber nur
  graue Platzhalter-Kacheln. Seit Okt. 2026 gibt es auf der Hauptseite nur
  noch OpenTopoMap (echte Kacheln bis 17); die Grenze 15 bleibt trotzdem,
  bis der Projektbesitzer etwas anderes wünscht. **Ausnahme Flugmodus: bis Zoom 16** (`FLIGHT_MAX_ZOOM`,
  Wunsch des Projektbesitzers, Okt. 2026) — dort gibt es nur OpenTopoMap,
  die echte Kacheln bis 17 hat. Standard-Zoom im Flugmodus bleibt 15.
- **Drei Zoomstufen für die Windpfeile** (Umbau „Karte lesbarer", Sept. 2026,
  alles in `src/components/WindMap.tsx`): Übersicht bis Zoom 8 (20-px-Pfeile, wie Region,
  keine Zahlen), Region Zoom 9–11 (20 px, Zahlen-Plakette ab Zoom 10), Detail ab Zoom 12
  (`DETAIL_MIN_ZOOM`, 24 px + Stationsname und Höhe). Feste Größen je Stufe
  (`ARROW_SIZE`), kein stufenloses Schrumpfen mehr.
  - **Zahlen erst ab Zoom 10** (`LABEL_MIN_ZOOM`), also eine Stufe über der
    Startansicht Südtirol (Zoom 9): Beim Öffnen stehen nur die Pfeile da, die
    Zahlen kommen beim ersten Hineinzoomen (Wunsch des Projektbesitzers).
    Die Region-Stufe (große Pfeile, kein Ausdünnen) beginnt trotzdem schon
    bei Zoom 9 (`REGION_MIN_ZOOM`).
  - **Jeder Stationsfilter folgt denselben Regeln wie „Alle"** (Größen,
    Zahlen, Ausdünnen). Die früheren Sonderregeln bei aktivem Filter (Zahlen
    immer sichtbar, alles 25 % größer) hat der Projektbesitzer im Sept. 2026
    ausdrücklich abgeschafft.
  - **Pfeil-Aufbau:** bisherige Pfeilform mit runden Ecken (`ARROW_PATH`;
    eine spitzere Form wurde ausprobiert und vom Projektbesitzer verworfen),
    dunkler Umriss außen (`OUTLINE_PX`) → Rand in
    **Böenfarbe** (`GUST_STROKE_PX`) → Fläche in Mittelwindfarbe. Der
    Böenrand bleibt ausdrücklich erhalten (Wunsch des Projektbesitzers), auch
    wenn die Böe zusätzlich in der Plakette steht.
  - **Zahlen-Plakette:** links Mittelwind, rechts Böe, jedes Feld in seiner
    Windfarbe, dünner dunkler Rahmen, eckig.
  - **Ausdünnen in der Übersicht** (bei jedem Filter): Überdecken sich
    zwei Pfeile, bleibt die höher gelegene Station (`THIN_DISTANCE_FACTOR`).
    Rangfolge nur nach Höhe, nicht nach Wind — sonst spränge das Bild beim
    Blättern im Zeitbalken. Ausgedünnte Marker bleiben als unsichtbare Marker
    bestehen (Anzahl/Reihenfolge unverändert). Ausgefallene Stationen sind in
    der Übersicht unsichtbar, sonst ein blasser hohler Ring.
  - **Aktiver Filter steht als Schild oben mittig auf der Karte** (Nov.
    2026, Wunsch des Projektbesitzers; im Okt. 2026 stand es oben rechts im
    Titel-Balken, davor schon einmal mittig auf der Karte).
    „ALLE"/„WINDANZEIGER" in Großbuchstaben, Höhenfilter nur kurz als
    „≥3000m"/„≤1000m" (ohne „Stationen", ohne Tausenderpunkt; Wunsch des
    Projektbesitzers; `getStationFilterMapLabel` in `src/lib/wind.ts`). **Das Schild ist zugleich der Filter-Schalter:**
    Antippen klappt die Liste aller Filter auf; der aktive Filter ist dort
    **gelb** (`amber-300`, wie im Menü des Flugmodus)
    (`src/components/StationFilterPicker.tsx`, eingebunden in `WindMap`).
    Im Flugmodus steht an derselben Stelle nur
    ein **Info-Schild** mit dem aktiven Filter (`WindMap`, nicht antippbar;
    Wunsch des Projektbesitzers) — umgestellt wird dort im Menü; Fehlermeldungen
    stehen immer oben mittig auf der Karte, unter dem Schild.
    **Das Schild selbst ist gelb, sobald ein Filter aktiv ist** (alles außer
    „Alle“, Hauptseite und Flugmodus; nur bei „Alle“ weiß — Wunsch des
    Projektbesitzers, Nov. 2026: ein gemerkter Höhenfilter ließ eine Station
    scheinbar fehlen).
  - **Ebenen-Menü oben rechts im Titel-Balken** (Nov. 2026, Wunsch des
    Projektbesitzers): Knopf mit drei Strichen („Sandwich-Knopf", wie die
    Menü-Taste im Flugmodus), klappt die **Ebenen** auf — KK7-Thermikkarte
    und Kabel (Leitungen) ein/aus, eingeschaltet gelb — und darunter die
    **Quellen** (`src/components/LayerMenu.tsx`, eingebunden in `WindApp`).
    Auf der Hauptseite sind beide Ebenen von Haus aus **aus**, die Wahl wird
    im Browser gemerkt (`LAYERS_STORAGE_KEY` in `WindApp`, getrennt von der
    KK7-Wahl im Flugmodus). Gezeichnet von `MainPageLayers` in `WindMap` mit
    denselben Bausteinen wie im Flugmodus (`useKk7Tiles`, `useCables(map,
    enabled)`). Links im Titel-Balken steht ein gleich breiter leerer
    Platzhalter, damit der Titel genau mittig bleibt.
  - **Gelände-Ebenen: Hangausrichtung und Windrose/Lee-Hänge** (Nov. 2026,
    Wunsch des Projektbesitzers; Vorbild die Hangausrichtung der Karte im
    Repo Wolkenatlas, dieselben acht Farben `ASPECT_COLORS`). Beide im
    Ebenen-Menü, von Haus aus aus, nur Hauptseite (nicht im Flugmodus).
    Der Browser rechnet die Kacheln selbst aus freien Höhendaten („Terrain
    Tiles“ auf AWS, ohne Schlüssel; `src/components/terrain.ts`), erst ab
    Zoom 9 (`TERRAIN_MIN_ZOOM`, darunter steht „Gelände: näher zoomen“).
    „Windrose / Lee-Hänge“ blendet oben links auf der Karte eine Windrose
    ein (`WindRosePicker`): Man tippt an, WOHER der Wind kommt, und alle
    vom Wind abgewandten Hänge werden **rot halbtransparent** (Wind aus Ost →
    Westhänge; ±45° um die Lee-Richtung, `LEE_HALF_ANGLE_DEG`; flache Stellen
    unter 5° bleiben frei). Nochmal tippen hebt die Wahl auf. Quelle der
    Höhendaten unter „Quellen“ im Ebenen-Menü (`TERRAIN_SOURCE`).
  - Nur Pfeil, Plakette und Ring sind anklickbar, nicht der breitere
    Icon-Kasten (`.wind-marker` in `src/app/globals.css`).
- **Einzige Karte der Hauptseite ist OpenTopoMap, gleich dargestellt wie im
  Flugmodus** (Okt. 2026, Wunsch des Projektbesitzers; bis dahin sehr helle
  Graustufen. Seit Sept. 2026 OpenTopoMap; die frühere Karte „Standard" =
  OpenStreetMap wurde dafür entfernt, im Okt. 2026 auch „Relief (Grau)",
  siehe „Nicht wieder einführen"). Es gibt deshalb keine Kartenauswahl
  mehr. Kachel-Adresse
  `TOPO_URL` in `src/components/WindMap.tsx`; sie bringt Höhenlinien,
  Schummerung und Ortsnamen selbst mit, deshalb keine weiteren Ebenen darüber.
  Das Aussehen macht der CSS-Filter `.topo-ebene` in `src/app/globals.css`
  (eine Ebene, ein Filter für Hauptseite und Flugmodus, siehe unten bei
  „Eigene, kräftigere Karte"). **Keine eigene Staatsgrenzen-Linie mehr**,
  weder auf der Hauptseite noch im Flugmodus (Okt. 2026 auf Wunsch entfernt,
  samt `src/data/staatsgrenzen.json`; OpenTopoMap zeigt die Grenzen selbst).
- **Titel- und Zeitbalken der Hauptseite durchscheinend** (Okt. 2026,
  Wunsch des Projektbesitzers): Titel-Balken 50 %, Zeitbalken 70 %
  Hintergrund-Deckkraft; **nicht** der Verlaufsbalken, der bleibt voll
  deckend. **iPhone-Statusleiste** (Uhrzeit/Akku): Die Seite reicht in der
  App bis darunter (`viewportFit: "cover"`, `statusBarStyle:
  "black-translucent"` in `src/app/layout.tsx`), der Titel-Balken samt
  50-%-Hintergrund wächst um `env(safe-area-inset-top)` hinein. Folge: iOS
  schreibt Uhrzeit/Akku weiß; wirkt erst nach erneutem Hinzufügen der App
  zum Home-Bildschirm. Im Flugmodus rücken die Tasten oben um denselben
  Abstand nach unten. Dafür füllt die Karte den
  ganzen Bildschirm, und beide Balken liegen darüber (`WindApp`: `<main>`
  `absolute inset-0`, Balken `absolute` oben/unten). Die gemessene Höhe des
  Titel-Balkens geht als `topInset` an `WindMap`, damit die Fehlermeldung
  oben mittig darunter rückt. Die weichen Ränder des Zeitrads haben dazu
  passend dieselbe Deckkraft wie der Zeitbalken (0,7; sonst weiße Flecken). **Lizenz:**
  CC BY-SA, die Quellenangabe (Kartendaten OpenStreetMap/SRTM,
  Kartendarstellung OpenTopoMap) steht unter „Quellen" im Ebenen-Menü
  (`MAP_SOURCES`) — nicht entfernen.
- **„Zuletzt aktualisiert" steht mittig unter dem Rad** im Zeitbalken (nicht
  mehr als Plakette auf der Karte; Wunsch des Projektbesitzers, Okt. 2026).
  `WindMap` meldet jeden Abruf über `onDataLoaded`, `WindApp` reicht ihn an
  `TimeSlider` weiter. Bei geöffneter Station (Zeitbalken weg) steht er nirgends.
  Leaflets Quellen-Zeile unten rechts ist per `attributionControl={false}`
  abgeschaltet (belegte am Handy zwei Zeilen und überdeckte die Plakette).
  Die Quellenangaben stehen stattdessen im Ebenen-Menü (siehe oben).
- **Zeitbalken = Zeitrad** (dritter Umbau, Okt. 2026, Wunsch des Projektbesitzers,
  Vorbild: die Höhenauswahl bei Meteoparapente): ein waagrecht liegendes **Rad**,
  das man nach vorne und hinten dreht (`src/components/TimeSlider.tsx`). Fester
  Rahmen in der Mitte = gewählter Zeitpunkt; zu den Rändern kippt das Rad weg
  (Striche rücken zusammen, werden blasser, der Farbstrich wird dünner).
  Nach **rechts** ziehen = zurück in der Zeit. Loslassen mit Schwung lässt es
  auslaufen, es rastet immer auf einem 10-Minuten-Schritt ein; Antippen springt
  zur Stelle. **Alles in EINER Zeile** (Wunsch des Projektbesitzers): links Datum
  und Uhrzeit des gewählten Schritts, in der Mitte das Rad, rechts der Knopf
  „Aktuell"; darunter mittig „Zuletzt aktualisiert". Die Zeile hat unten Abstand: Am iPhone-Rand ganz unten löst die
  Wischgeste (Home-Leiste) sonst das Verschieben der Seite aus (Rückmeldung
  des Projektbesitzers). Stellschrauben als Konstanten oben in der Datei
  (`ANGLE_PER_SLOT_DEG`, `DRAG_PX_PER_SLOT`, `FLING_*`). Die Bewegung ist **bewusst
  eigene Physik** per Zeigerereignissen, nicht Browser-Scrollen.
  - Im Rad liegt ein **Farbstrich**: Windfarbe der windigsten 10 % der
    Stationen **im sichtbaren Kartenausschnitt** (`STRIP_QUANTILE`; WindMap
    meldet die Stationen über `onViewportStationsChange`).
  - **Bei geöffneter Station ist der Zeitbalken weg** (Wunsch des
    Projektbesitzers): Die Karte zeigt dann nur die aktuellen Werte, der
    Verlaufsbalken reicht bis zum Seitenende. Beim Schließen steht der
    Zeitbalken wieder auf „Aktuell". Der Zustand „geöffnete Station" liegt
    dafür in `WindApp` (nicht in `WindMap`). Die Karte selbst ändert dabei
    ihre Größe nicht mehr (der Zeitbalken liegt über ihr);
    `ContainerResizeWatcher` in `WindMap` bleibt als Absicherung.
  - **Im Ebenen-Menü ausblendbar** (Nov. 2026, Wunsch des
    Projektbesitzers; Eintrag „Zeitbalken" ganz oben, von Haus aus an, Wahl
    gemerkt als `timeSlider` in `LAYERS_STORAGE_KEY`). Ausgeblendet zeigt die
    Karte nur die aktuellen Werte (Zeitpunkt springt auf „Aktuell"), und
    „Zuletzt aktualisiert" steht nirgends. Der Verlauf wird trotzdem weiter
    geladen (Messfehler-Erkennung der Live-Werte braucht ihn).
  - **Kein Abspielknopf** (Wunsch des Projektbesitzers: unnötig) — nicht
    wieder einführen. Die ◀ ▶-Knöpfe sind ebenfalls weg; per Tastatur gehen die
    Pfeiltasten.
  - **Nicht auf Browser-Scrollen (scroll-snap) oder ein Band ohne Rad
    zurückbauen:** Beide früheren Fassungen (wischbares Band, Antipp-Band) waren
    am Handy laut Projektbesitzer nicht gut benutzbar.
  - Farben **schwarz/grau wie die Knöpfe im Titel-Balken**, kein Grün (Wunsch des
    Projektbesitzers). Der Zustand „jetzt" heißt **„Aktuell"**, nicht „Live" oder
    „Jetzt". **Ausnahme:** Der Knopf „Aktuell" ist **gelb**, solange das Rad
    nicht auf „Aktuell" steht (Nov. 2026, Wunsch des Projektbesitzers, wie das
    gelbe Filter-Schild bei aktivem Filter).
  - Die Verlaufsdaten (`/api/timeline`) werden **gleich beim Seitenaufruf**
    und alle 10 min geladen (früher erst beim ersten Anfassen).
  - **Sparsam laden (Punkt 27, Nov. 2026, auf Wunsch des Projektbesitzers):**
    Die vollen 48 h (~450 KB) holt nur die Hauptseite beim Öffnen. Danach
    kommen alle 10 min nur die letzten 8 h (`/api/timeline?hours=8`,
    `TIMELINE_RECENT_HOURS`, ~80 KB) und werden eingefügt
    (`mergeRecentTimeline` in `src/lib/timelineMerge.ts`). Der Flugmodus holt
    überhaupt nur die 8 h (er braucht den Verlauf nur für die
    Messfehler-Erkennung). Volle 48 h wieder nach einem Start im Flugmodus,
    sobald die Hauptseite sie braucht, oder wenn das letzte Laden über 4 h her
    ist (`TIMELINE_MERGE_MAX_GAP_MS`). Das Ergebnis ist **dasselbe wie beim
    vollen Laden** (Simulation mit 96 Auffrischungen geprüft). Dafür rechnet
    `/api/timeline` jedes Fenster mit **3 h Vorlauf** (`LEAD_SLOTS`, so lang
    wie die längste Messfehler-Regel, `LONGEST_RULE_MINUTES`) — nicht
    entfernen, sonst stimmen Messfehler-Kennzeichen und gehaltene SLF-Werte am
    Fensteranfang nicht. Wird eine Messfehler-Regel länger, schrumpft der
    erlaubte Abstand zwischen zwei Ständen (8 h minus Regel); passt er nicht
    mehr, lädt die Seite von selbst voll.
- **Farbskala als harte Stufen**, kein weicher Verlauf; die unterste Stufe ist
  hellblau (nicht weiß, sonst unsichtbar auf heller Karte)
- **Mitwachsende y-Achse im Verlaufsbalken**: untere Grenze immer 0, obere
  Grenze mindestens 45 km/h und darüber in 15er-Schritten wachsend, bis der
  höchste Wert (Messung oder Prognose) hineinpasst. So wird nichts mehr
  abgeschnitten, ruhige Tage bleiben aber untereinander vergleichbar.
  Stellknöpfe: `Y_MIN_MAX_KMH`, `Y_MAX_STEP_KMH`, `Y_MAX_HEADROOM_KMH` in
  `src/components/WindHistoryPanel.tsx`
- Zeichenreihenfolge und Flächen im Verlaufsbalken sind mehrfach abgestimmt —
  die Messung bleibt im Vordergrund (Kommentar direkt im JSX beachten)
- **Caching nicht entfernen** (`/api/wind` und die Verlaufs-Routen): Stationen
  messen nur alle 5–10 min. Ebenso bleibt der Abruf-Takt der Karte bei 3 min —
  „frischer" wird die Anzeige über den `visibilitychange`-Abruf, nicht über
  einen kürzeren Takt. **Kein Aktualisieren-Knopf** im Titel-Balken (Okt.
  2026 entfernt, Wunsch des Projektbesitzers): Karte und ein offener
  Verlaufsbalken laden alle 3 min und beim Zurückkehren zur Seite selbst
  nach, der Zeitbalken alle 10 min. **Aber keine lange „Nachfrist" (stale-while-revalidate)
  in `/api/wind`:** Bis Okt. 2026 hingen die Live-Werte dadurch bis zu ~10 min
  hinter der Datenbank (Kopfzeile „Stand 15:40", Verlaufsbalken schon mit
  15:50). Seit Punkt 14 (Nov. 2026) liest `/api/wind` ohnehin aus der
  Datenbank; die folgenden Regeln gelten jetzt für den Sammler und den
  Notbetrieb. Die Bozner `/sensors` werden deshalb ohne Daten-Cache geholt; der
  60-s-CDN-Speicher der Antwort bleibt (Begründung oben in der Route). Aus
  demselben Grund holen die übrigen Quellen ihre Messwerte nicht mehr über
  den Next.js-Daten-Cache (`next: { revalidate }`), sondern über
  `cachedFresh` (`src/lib/freshCache.ts`, gleiche Haltedauer, nach Ablauf
  sofort frisch) — das betraf auch `/api/collect`: Neue Werte landeten dort
  5 min später in der Datenbank. Für Live-Messwerte keinen
  `next: { revalidate }` mehr verwenden (Metadaten dürfen es).
  `/api/history` hat ebenfalls nur noch 30 s Nachfrist; `/api/timeline`
  behält 300 s (eingeführt, als seine Abfrage noch mehrere Sekunden dauerte;
  seit Okt. 2026 holt sie alles in einem Schritt über die Datenbank-Funktion
  `wind_timeline`, `supabase/zeitbalken-funktion.sql`, ~0,2 s in der
  Datenbank).
- **Sammel-Takt bleibt bei 5 min** (Supabase-Cron-Job `collect-data`), obwohl
  die Stationen nur alle 10 min messen — siehe die Begründung oben in
  `src/app/api/collect/route.ts`. Nicht auf 10 min „aufräumen". Seit Punkt 14
  ist das zugleich der Takt, in dem neue Werte auf die Karte kommen.
- **Einzelne Messlücken werden im Verlaufsbalken überbrückt**
  (`measurementGapMs` in `src/lib/wind.ts`, 2,5 Messtakte = 25 min, beim SLF
  75 min): Der Bozner Dienst überspringt gelegentlich einen Zeitpunkt bei allen
  Stationen gleichzeitig. Ab zwei fehlenden Werten am Stück reißt die Kurve
  weiterhin sichtbar auf — dieser Teil war ausdrücklicher Wunsch des
  Projektbesitzers.
- **SLF-Stationen messen nur alle 30 min** — vom Projektbesitzer bezweifelt,
  im Sept. 2026 nachgeprüft (auch whiterisk.ch hat nichts Feineres). Der Takt
  steht je Quelle in `SOURCE_INTERVAL_MINUTES` (`src/lib/wind.ts`); im
  Zeitbalken bleibt ein SLF-Wert bis zum nächsten stehen (`/api/timeline`).

**Föhn-Anzeige: Druckdifferenz Bozen − Innsbruck (Nov. 2026, Wunsch des Projektbesitzers)**
- Vorbild: die „Live-Druckdifferenzen" der burnair Map. burnair und
  Breezedude nehmen dafür die METAR von LOWI/LIPB über aviationweather.gov
  (Nov. 2026 nachgesehen; QFF/QFE von burnair sind nur aus dem QNH
  gerechnet).
- **QFF statt QNH** (8. Nov. 2026, Wunsch des Projektbesitzers nach einer
  Recherche; bis dahin „immer QNH“): Angezeigt wird der Druck auf
  Meereshöhe, gerechnet mit der **echten Temperatur und Feuchte** der Station
  (`qffFromStation`/`toQffSeries` in `src/lib/pressure.ts`). Grund: Bozen
  liegt 333 m tiefer als Innsbruck, der QNH nimmt für dieses Stück immer
  „Normluft“ (~12 °C) an — das verfälscht die Differenz um ~0,14 hPa je Grad
  Abweichung, bis gut 2 hPa bei Sommerhitze oder Winterkälte. MeteoSchweiz
  empfiehlt für Druckdifferenzen das QFF, Wettermodelle und Föhndiagramme
  rechnen ebenso mit Temperatur. Am 5.–8. Nov. 2026 lag die QFF-Differenz im
  Mittel 0,9 hPa unter der QNH-Differenz. **Temperatur = Mittel aus jetzt
  und vor 12 h** (`QFF_TEMP_LAG_MS`; übliche Praxis, AMS-Glossar und
  US-Wetterdienst: sonst erschiene der Tagesgang der Bodentemperatur als
  Druckschwankung), Säule bis zur Mitte mit 0,65 K/100 m, Feuchte als
  virtuelle Temperatur (bis ~0,3 hPa). **Gespeichert wird weiter der QNH**
  (exakt in den Stationsdruck zurückrechenbar, `stationFromQnh`) mit
  Temperatur und Feuchte; `/api/pressure` rechnet das QFF beim Auslesen —
  für Messung und Prognose nach derselben Regel, deshalb liest es 12 h mehr
  als angezeigt. Rückgerechnet wird mit der Höhe, mit der der QNH entstand:
  Messung 578/245 m (`MEASURED_ELEVATION_M`), Prognose 581/240 m
  (`PRESSURE_STATIONS`). Die Farbstufen (0,5/1,5/2,5/3 hPa) blieben.
- **Messreihe (Nov. 2026, vom Projektbesitzer beauftragt):** alle 10 min
  auf 0,1 hPa, **selbst gerechnet** aus GeoSphere 11121 „Innsbruck-Flughafen“
  (Stationsdruck `P`) und Landesstation 83200MS „Bozen“ (reduzierter Druck
  `LD.RED` mit Temperatur `LT` auf Stationsdruck zurückgerechnet), beide nach
  der Normatmosphäre wie die Flughäfen (`src/lib/stationPressure.ts`) — für
  Hauptkurve, Linie und Schild. Am 03.11.2026 über 48 h geprüft: Differenz im
  Mittel 0,02 hPa neben der METAR-Differenz, höchstens ±1 hPa (Rundung der
  METAR). Die reduzierten Werte der Landesdienste NICHT direkt vergleichen
  (GeoSphere lag 1,6 hPa über dem METAR-QNH — laut Recherche Nov. 2026 vor
  allem der Unterschied QFF/QNH bei kaltem Wetter).
- **Keine Flughafen-Werte (METAR) mehr** (8. Nov. 2026, Wunsch des
  Projektbesitzers; siehe „Nicht wieder einführen“): Die erste Fassung
  zeigte nur die METAR von LOWI/LIPB (ganze hPa, Bozen nachts ohne Meldung —
  treppig und nachts unterbrochen), danach waren sie dünne graue punktierte
  Vergleichslinie, zuletzt nur Ersatz für Karte und Kopfzeile. Jetzt
  komplett entfernt (`src/lib/metar.ts` gelöscht, Sammler holt sie nicht
  mehr). Fehlen die Stationswerte, wird die Linie nach 2 h grau
  (`PRESSURE_STALE_AFTER_MS`). **Als Windstation nicht nötig:** Am Flughafen
  Innsbruck steht schon die GeoSphere-Station „Innsbruck-Flughafen“
  (10-min-Werte), 3,5 km vom Flughafen Bozen die Landesstation „Bozen“; die
  METAR hätten nur grobe Werte (ganze Knoten, 10°-Schritte, Böen nur bei
  starkem Wind; Bozen stündlich und nachts nicht).
- **Vorzeichen Bozen − Innsbruck:** positiv = Süd höher (Südföhn-Lage),
  negativ = Nord höher (Nordföhn-Lage). Auf der Karte zeigt ein Pfeil im
  Schild vom hohen zum tiefen Druck. **Farbstufen vom Projektbesitzer
  festgelegt** (Nov. 2026; zuerst die Stufen von burnair), dieselben Farben
  wie die Windskala, für plus und minus gleich: bis 0,5 hPa blau, bis
  1,5 grün, bis 2,5 gelb, bis 3 orange, darüber rot (`FOEHN_COLOR_SCALE`, gilt
  für Linie, Schild und Diagramm), grau ab 2 h ohne Messung
  (`PRESSURE_STALE_AFTER_MS`). **Quellen** (GeoSphere, Land Südtirol,
  ICON-CH1, ECMWF; `PRESSURE_SOURCES`) stehen unter
  „Quellen" im Ebenen-Menü, nicht im Druck-Verlaufsbalken (Wunsch des
  Projektbesitzers).
- **Gespeichert** in der eigenen Tabelle `pressure_values`
  (`supabase/druck.sql`, Spalte `kind`: `station`, `kamm`
  (Kammtemperatur, seit 8. Nov. 2026, ohne QNH), `icon_ch1`, `ecmwf_ifs`):
  Messungen schreibt der Sammler, jeweils die letzten 3 h (Zustand in
  `wind_status` als „druck", zählt nicht als Windquelle), die Prognose die
  Edge Function (`refreshPressure`, `PRESSURE_MODELS`, eigene Laufprüfung je
  Modell): **ICON-CH1** (33 h voraus, grau gestrichelt) und seit Nov. 2026
  auf Wunsch des Projektbesitzers **ECMWF IFS** (`ecmwf_ifs`, 9 km, 72 h
  voraus, violett gestrichelt — nicht blau, Blau/Rot gehören den Flächen). Beide als Druck **am Boden** geholt und nach
  derselben Regel in den QNH umgerechnet (`qnhFromSurface`) und mit
  Temperatur und Feuchte (`relative_humidity_2m`, seit 8. Nov. 2026)
  gespeichert; angezeigt wird daraus wie bei der Messung das QFF. (Nicht
  `pressure_msl` direkt: Es lag in Innsbruck ~2 hPa über dem QNH — der
  Unterschied QFF/QNH bei kaltem Wetter — und rechnet nach der Regel des
  Modells, nicht nach unserer.) ECMWF gibt es NUR hier
  beim Druck, nicht beim Wind (siehe „Prognosemodelle“).
  `/api/pressure` hat je Messreihe einen Notbetrieb direkt bei den Diensten.
- **Anzeige:** nur Hauptseite, im Ebenen-Menü „Föhn (Druck BZ–IBK)", als
  einzige Ebene **von Haus aus an** (gemerkt als `foehn`). Linie zwischen
  den Flughäfen, in der Mitte ein Schild (über den Windpfeilen), folgt dem
  Zeitbalken. Antippen öffnet den Druck-Verlaufsbalken (`PressurePanel`):
  48 h gemessen (schwarz; Druck- und Temperaturkurven **nur ein Wert alle
  20 min** zu :00/:20/:40 — Wunsch des Projektbesitzers,
  `MEASURED_STEP_MINUTES`; gespeichert wird weiter alle 10 min, Kopfzeile und
  Karte zeigen den neuesten Wert) +
  Prognose (grau gestrichelt); **Fläche zwischen gemessener Kurve und
  Nulllinie rot (oberhalb) bzw. blau (unterhalb)** wie im ΔT-Diagramm (nach
  einer Skizze des Projektbesitzers, Nov. 2026), Hintergrund weiß, die
  Stufen der Farbskala als **schmaler Farbstreifen links neben den
  hPa-Zahlen**; **waagrechte Linien nur auf den Farbsprüngen**
  (±0,5/1,5/2,5/3 hPa, dünn und GRAU, nicht bunt; **±1,5 und ±2,5 dicker
  und gestrichelt**, 7. Nov. 2026, `STRONG_STEP_HPA`) plus die Nulllinie — die
  Gitterlinien bei ganzen hPa sind weg; **die hPa-Zahlen links stehen genau auf
  den Farbsprüngen** (`stepLines`, „+0,5“ … „−3,0“, die „0“ weicht ihnen),
  nichts steht rechts (Wunsch des Projektbesitzers, 7. Nov. 2026), **stündliche Zeitachse, seitlich verschiebbar** (Wischen bzw.
  Ziehen mit der Maus; `PX_PER_HOUR` 16 = Breite eines Wert-Quadrats im
  Wind-Verlaufsbalken, beschriftet jede 2. Stunde, auch unter dem Druck-Diagramm; beim Öffnen „jetzt“ in der Mitte,
  hPa-Zahlen links fest; Wunsch des Projektbesitzers, Nov. 2026),
  **mitwachsende y-Achse** wie im Wind-Verlaufsbalken (je Seite
  mindestens 3 hPa, wächst für sich in ganzen hPa: `Y_MIN_EXTENT_HPA`);
  **das Fenster reicht bis an den Titel-Balken** (7. Nov. 2026, Wunsch des
  Projektbesitzers, nach Zwischenschritten mit 30 % und 40 % der
  Bildschirmhöhe): das Druck-Diagramm bekommt den ganzen restlichen Platz
  (`useChartHeight`, mindestens 180 px), das Temperatur-Diagramm bleibt
  100 px; zwischen beiden Diagrammen mehr Luft (`PRESSURE_TIME_H`,
  `TEMP_TITLE_PAD_PX`); dabei verschwindet der Zeitbalken wie bei einer Station
  (`pressureOpen` in `WindApp`).
- **Temperatur auf Kammhöhe: Rittnerhorn und Hafelekar** (8. Nov. 2026,
  Wunsch des Projektbesitzers; vorher die Talstationen Bozen und Innsbruck):
  eigenes Diagramm unter dem Druck auf derselben Zeitachse, Titel
  „Temperatur auf 2260 m“. Grund (Recherche Nov. 2026: DHV, SHV, XCTherm,
  MeteoSchweiz): Föhn treibt auch der Temperaturunterschied der Luftmassen
  **auf Höhe der Pässe** — am Talboden überdecken Tagesgang, Kaltluftseen und
  Inversionen das. Rittnerhorn (Land Südtirol `82500WS`, 2260 m, Süden) und
  **Hafelekar** (Nordkette, Lawinenwarndienst Tirol `ISEE1`, 2270 m, Norden)
  liegen fast gleich hoch, deshalb keine Höhenbereinigung. **Im Norden zuerst
  der Patscherkofel** (GeoSphere 11126, 2251 m) — noch am selben Tag auf
  Wunsch des Projektbesitzers ersetzt: Er liegt am Ausgang des Wipptals und
  steht bei Südföhn selbst in der Föhnströmung (zeigt dann Luft aus dem
  Süden); der Hafelekar liegt weiter vom Alpenhauptkamm weg (wie Matro–
  Pilatus im SHV-Beispiel). **Der Hafelekar hat keinen Verlauf beim Dienst**
  (die Datei des LWD Tirol enthält nur den neuesten Wert, meist alle 10 min,
  manchmal Lücken von 20–80 min): Den Verlauf baut der Sammler selbst auf,
  im Notbetrieb gibt es nur den aktuellen Wert. Die Temperaturlinien zeigen
  deshalb je 20-Minuten-Abschnitt den ersten Wert (`oneEveryStep` in
  `PressurePanel`) statt starr :00/:20/:40. Stationen in
  `CREST_STATIONS`/`CREST_PAIR` (`src/lib/pressure.ts`), Abruf in
  `src/lib/crestTemperature.ts` und `fetchLwdTirolTemperature`
  (`src/lib/lwdtirol.ts`). Gemessene
  Temperaturen als Linien (Norden blau, Süden braun), die **Fläche zwischen
  den Linien = ΔT Süd − Nord** (gezählt wie der Druck): rot, wo der Süden
  wärmer ist, blau, wo der Norden wärmer ist. Lesehilfe: Süden kälter (blau)
  stützt Südföhn, Norden kälter (rot) Nordföhn. Über den ganzen Zeitraum die
  **ICON-CH1-Temperatur** beider Bergstationen gestrichelt, Fläche blasser
  (`temperature_2m` auf Stationshöhe, in derselben Open-Meteo-Anfrage wie
  der Druck der Flughäfen, `CREST_STATIONS` in der Edge Function). Der
  Sammler speichert Temperatur und Feuchte der Bergstationen als
  `kind = 'kamm'` **ohne QNH** (`qnh_hpa` darf deshalb seit 8. Nov. 2026 leer
  sein, `supabase/druck.sql`; in einem eigenen Schreibvorgang, damit ein
  Fehler dort den Druck nicht trifft); die Feuchte wird noch nicht
  angezeigt. Temperatur und Feuchte der **Talstationen** (`kind = 'station'`)
  speichert er weiter (gebraucht für das QFF), `/api/pressure` liefert sie
  aber nicht mehr als Kurve aus.
- **Lesbarkeit des Druck-Verlaufsbalkens** (Nov. 2026, zweimal auf Wunsch
  des Projektbesitzers aufgeräumt, zuletzt am 6. Nov.): Kopfzeile nur zwei
  Zeilen (großes Differenz-Schild, rechts die Druckwerte in größerer Schrift; **kein erklärender
  Satz** wie „kein nennenswertes Gefälle“ — vom Projektbesitzer abgelehnt);
  das Druck-Diagramm hat nur seine Legende (keine Titelzeile „Druck (hPa)“,
  kein „Süd höher/Nord höher“ — abgelehnt), das Temperatur-Diagramm eine
  Titelzeile, in der links ein **Rechteck „Δ +3,5 °C“** (= Süd − Nord,
  wie das Differenz-Schild des Drucks; hellrot bei Süden wärmer, hellblau bei
  Norden wärmer) steht (nichts liegt auf den Kurven); **seit 7. Nov. 2026
  aufgebaut wie die Kopfzeile über dem Druck-Diagramm** (Titel „Temperatur
  auf 2260 m · Stand: …“, gleich großes Schild, rechts die beiden
  Temperaturen in 15 px — seit 8. Nov. 2026 **untereinander**, je mit einem
  Linienstück in der Farbe der Kurve, weil die Namen der Bergstationen
  für eine Zeile zu lang sind —, darunter die Legende in 11 px; Wunsch des
  Projektbesitzers); **Prognose-Zone rechts von „jetzt“ grau hinterlegt** und mit
  „Prognose“ beschriftet; **die Prognosen (ICON-CH1, ECMWF, Temperatur)
  laufen seit 7. Nov. 2026 auch in der Vergangenheit weiter, hinter der
  Messung** (Wunsch des Projektbesitzers, „wie im Verlaufsbalken“; vorher
  endeten sie an „jetzt“); senkrechte Rasterlinien und Stundenzahlen nur alle 2 h; um Mitternacht
  steht unter **beiden** Diagrammen der **Tag („Sa., 7.11.“) statt „00“**
  (keine zweite Datumszeile mehr).

**Flugmodus (Okt. 2026, Wunsch des Projektbesitzers)**
- Gestartet über den **ganzen Titel als Knopf** („Should I stay or should I
  GO"; Okt. 2026, Wunsch des Projektbesitzers, vorher nur ein blaues „GO").
  Aussehen vom Projektbesitzer aus Entwürfen gewählt, **„London Calling"**
  (Plattencover von The Clash): Der Satz steht schlicht in Schwarz, nur
  **„GO" steht in Pink (`#f06ea9`) auf einem geraden schwarzen Feld** —
  ohne grünen Schatten und nicht schräg (beides auf Wunsch des
  Projektbesitzers wieder entfernt).
  Antippbar ist die ganze Zeile. **Der Titel darf sich beim Filterwechsel
  nicht verschieben** (Wunsch des Projektbesitzers): Seit Nov. 2026 steht
  daneben nur noch der Ebenen-Knopf mit fester Größe (das Filter-Schild ist
  auf der Karte); ab 360 px Bildschirmbreite steht der Titel in einer
  Zeile, darunter rutscht „GO" in die zweite. Beendet über die ✕-Taste oben links auf der Karte (mit
  zweitem Tipper „BEENDEN?" wie bei START/STOP). Titel-
  und Zeitbalken sind dann weg, die Karte zeigt nur Live-Werte; Antippen der
  Windpfeile öffnet nichts (Handschuhe, Verlaufsbalken würde Karte verdecken).
- In `src/components/FlightMode.tsx` und seinen Teilen in
  `src/components/flight/` (bis Okt. 2026 eine Datei mit 1.700 Zeilen):
  eigener Standort (blauer
  **Navigationspfeil** mit Kerbe hinten, ohne Richtung ein blauer Punkt; vom
  Projektbesitzer aus Entwürfen gewählt, `createOwnPositionIcon` in
  `flight/position.ts`;
  **Flugrichtung aus dem GPS**, nicht Kompass; GPS-Ungenauigkeit als leicht
  durchsichtiger blauer Kreis erst ab 10 m, `ACCURACY_CIRCLE_MIN_M`, statt
  „GPS ±… m" in der Statuszeile — dort steht nur noch, wenn GPS fehlt;
  **ist der Standort nicht freigegeben, fragt ein Tipp auf Rücksetz- oder
  Übersichtstaste erneut nach** — `retry` in `flight/position.ts`, Nov. 2026;
  bei im Browser dauerhaft gesperrtem Standort steht „Standort gesperrt – in
  den Einstellungen erlauben"), Karte folgt dem
  Standort bis man sie verschiebt und springt **10 s nach dem Loslassen von
  selbst zurück** (`RECENTER_AFTER_MS`, Zoomstufe bleibt; Wunsch des
  Projektbesitzers nach Vorbild burnair Go), große Tasten, Bildschirm-Wachhalten
  (Screen Wake Lock), Statuszeile. Diese großen Tasten gelten nur im
  Flugmodus — die normale Karte bleibt ohne Zoom-Knöpfe.
- **Zoomen im Flugmodus über die +/−-Tasten und mit zwei Fingern** (Wunsch
  des Projektbesitzers, Okt. 2026; der Zwei-Finger-Zoom war zuerst auch aus
  und wurde ausdrücklich zurückgewünscht). Er zoomt um die Kartenmitte, damit
  der eigene Standort beim Mitführen in der Mitte bleibt. Doppeltippen,
  Mausrad und Rahmen-Zoom sind dort abgeschaltet, Verschieben geht weiter.
  Die normale Karte zoomt wie bisher.
- **Anordnung der Tasten** (Okt. 2026 vom Projektbesitzer in einer
  Layout-Vorschau festgelegt und danach nachgeschärft): oben links ✕
  (Beenden) und rechts daneben START/STOP, beide 48 px, darunter die
  Statuszeile; alle Tasten oben bündig 12 px unter dem Rand; oben rechts
  +/−; unten links IGC und Papierkorb (darüber die Menü-Taste mit drei Strichen); unten rechts die Rücksetztaste (eigener Standort auf Zoom 15
  `FLIGHT_ZOOM`, ohne GPS die Startansicht) über der **Übersichtstaste**
  (eigener Standort auf Zoom 10 `OVERVIEW_ZOOM`; Nov. 2026 von 11 auf 10,
  Wunsch des Projektbesitzers — Kabel erscheinen erst ab 11, in der
  Übersicht also nicht). Abstände 12 px, unten
  28 px (Wischleiste des iPhones). Die vier Zoomtasten (+, −, Rücksetzen, Übersicht)
  haben einen **halb durchsichtigen Hintergrund** (50 %, `zoomButtonLight`/
  `zoomButtonDark`), Zeichen und Rand bleiben voll deckend. Ebenso ✕ und
  START/STOP oben links (STOP halb durchsichtig rot); die gelben Nachfragen
  bleiben voll deckend.
- **Kräftigere Karte, zuerst für den Flugmodus** (Okt. 2026; seit Ende Okt.
  2026 auch auf der Hauptseite): OpenTopoMap mit `.topo-ebene`
  (`src/app/globals.css`: Farbstärke 30 % statt
  reinem Grau — vom Projektbesitzer am Bild gewählt —, doppelter Kontrast,
  weniger aufgehellt), damit das Gelände auch bei Sonne lesbar ist. Nur
  OpenTopoMap selbst, keine zweite Quelle darunter mischen (Wunsch des
  Projektbesitzers; Höhen-Graustufen aus Fremd-Höhendaten verworfen). Bewusst
  hell, **kein Dunkelmodus und keine Umschalttaste** (Wunsch des
  Projektbesitzers; dunkle Flächen spiegeln in der Sonne).
- **Stationshöhe im Flugmodus direkt unter der Zahlen-Plakette** („2260 m"),
  sobald die Zahlen sichtbar sind (ab Zoom 10) — nicht erst in der
  Detail-Stufe wie auf der normalen Karte (`showAltitude` in
  `src/components/WindMap.tsx`).
- **Kabel (Luftfahrthindernisse) im Flugmodus immer, auf der Hauptseite
  zuschaltbar** (Okt. 2026, Wunsch des Projektbesitzers; seit Nov. 2026 auch
  im Ebenen-Menü der Hauptseite, von Haus aus aus): Stromleitungen, Material-/Seilbahnen, Schussdrähte und
  Lifte aus der Hinderniskarte des Landes (Forstdienst, Meldepflicht nach
  LG 1/2006; WFS `p_bz-FlightObstacles:LinearObstacles` auf
  `geoservices6.civis.bz.it`). Abgeholt von `/api/kabel` und **einmal am Tag
  aktualisiert** über den Vercel-CDN-Cache (`s-maxage` 24 h,
  `stale-while-revalidate`) — kein Cron nötig. Die lange Nachfrist ist hier
  Absicht (Kabel sind keine Live-Werte; die Regel „kurze Nachfrist" unter
  „Caching nicht entfernen" gilt für sie nicht). Gezeichnet in
  `flight/cables.ts` (`useCables`): **magentarote Linie (`#c2255c`, 2 px) mit
  weißem Saum, alle Kabel gleich breit** (vom Projektbesitzer am Probebild
  gewählt), **erst ab Zoom 11** (`CABLE_MIN_ZOOM`; hing bis Okt. 2026 an der
  Flug-Zoomstufe und lag deshalb ungewollt bei 15).
  **Höhen-Schilder** („60–100 m") an **allen** Kabeln, auch „< 15 m" und
  „15–25 m" (seit Nov. 2026, Wunsch des Projektbesitzers; vorher nur über
  25 m), im Flugmodus und auf der Hauptseite gleich, **erst
  ab Zoom 15** (`CABLE_LABEL_MIN_ZOOM`; Vorschauen ab Zoom 11–13 waren dem
  Projektbesitzer zu unruhig), bei langen Kabeln wiederholt im festen
  Bildschirmabstand (`CABLE_LABEL_SPACING_PX`), überlappende ausgedünnt
  (höhere Klasse gewinnt). Die Klasse des Landes gilt für das ganze Kabel
  (höchste Stelle), Höhen je Abschnitt gibt es nicht — ein „max" davor hat
  der Projektbesitzer trotzdem bewusst weggelassen. Klassen in
  `CABLE_HEIGHT_CLASSES` (`src/lib/kabel.ts`), Aussehen `.kabel-schild` in
  `src/app/globals.css`. Masten
  (`VerticalObstacles`) bewusst nicht. Statuszeile:
  „Kabel TT.MM." (nur Datum) = wann der Server sie zuletzt beim Land abgeholt hat.
  **Scheitert die Aktualisierung, bleiben die letzten Kabel** (Wunsch des
  Projektbesitzers): Das Handy merkt sich die letzte Fassung
  (`CABLE_STORAGE_KEY`, localStorage), das CDN gibt bei Fehlern die alte
  weiter (`stale-if-error`). Das Kabel-Feld der Statuszeile wird dann **gelb** und
  zeigt weiter das Datum dieser Fassung — auch wenn die Kabel älter als 30 h
  sind (`CABLE_OUTDATED_MS`; vorher wird einmal nachgefragt, falls nur der
  Zwischenspeicher gerade auffrischt).
  **Kein Hinweistext** zur Vollständigkeit (Wunsch des Projektbesitzers).
  Quelle unter „Quellen" im Ebenen-Menü (`CABLE_SOURCE` in `src/lib/wind.ts`). Nur
  Südtirol.
- **KK7-Thermikkarte im Flugmodus und zuschaltbar auf der Hauptseite** (Okt.
  2026, Wunsch des Projektbesitzers; Hauptseite seit Nov. 2026 über das
  Ebenen-Menü, von Haus aus aus): Thermik-Wahrscheinlichkeit von thermal.kk7.ch als halb
  durchsichtige Ebene über OpenTopoMap (`useKk7Layer` in `flight/kk7.ts`).
  Ein/aus im **Menü** (siehe nächster Punkt), Voreinstellung an, Wahl im Handy gemerkt (`KK7_STORAGE_KEY`).
  **Automatisch nach Jahreszeit und Tageszeit gefiltert** wie in burnair Go
  (`kk7Category`: Jahreszeit aus dem Datum, Morgen/Mittag/Abend aus den
  Stunden seit Sonnenaufgang am eigenen Standort, `sunriseMs`). **Auf der
  Hauptseite** lassen sich Jahreszeit und Tageszeit im Ebenen-Menü auch von
  Hand wählen (Nov. 2026, Wunsch des Projektbesitzers; Voreinstellung
  „Automatisch", dazu „Ganzjährig"/„Ganztags"; Auswahl in `src/lib/kk7.ts`).
  Im Flugmodus bleibt es immer automatisch. Deckkraft
  `KK7_OPACITY` 0,6 (30 % weniger als zuerst, Wunsch des Projektbesitzers).
  Folge: Im Winter und morgens ist die Karte in Südtirol deutlich lückenhafter
  (Datenmenge im Okt. 2026 gezählt, steht im Code) — kein Fehler. Bedingungen von KK7: Lizenz
  **CC BY-NC-SA 4.0 (nur nicht-kommerziell!)**, Nennung unter „Quellen"
  im Ebenen-Menü (`KK7_SOURCE` in `src/lib/wind.ts`, nicht entfernen), jede
  Anfrage mit `src=<Adresse>`, Kacheln in TMS-Zählung bis Zoom 12. Wird die
  Seite je kommerziell, muss die Ebene raus oder mit KK7 gesprochen werden.
- **Menü im Flugmodus** (Okt. 2026, Wunsch des Projektbesitzers): Taste mit
  drei Strichen unten links öffnet ein großes Menü mit „Ebenen" (KK7 an/aus) und „Windstationen" (alle
  Stationsfilter). Zeilen 40 px (`menuOption`; zuerst 56 px, flacher gewünscht,
  damit weitere Einträge Platz haben). **Eingeschaltetes hat gelben Hintergrund.** Ein Tipp
  schaltet um, das Menü bleibt offen; zu über ✕. Oben mittig bleibt der
  aktive Filter als reines Info-Schild stehen (Wunsch des Projektbesitzers). In `FlightMode.tsx` (`menuOpen`, `menuOption`).
- **Track-Aufzeichnung** (Taste START/STOP oben links neben ✕): violette
  Linie (`TRACK_COLOR`), Länge in der Statuszeile. START und STOP brauchen
  **zwei Tipper**: Nach dem ersten steht an derselben Stelle ✕ zum
  Abbrechen und darunter die gelbe Bestätigung („STARTEN?" /
  „STOPPEN?", ohne „WIRKLICH"; gilt genauso für Beenden), erst die löst aus; nach 5 s
  (`CONFIRM_MS`) springt sie von selbst zurück (Wunsch des
  Projektbesitzers; bewusst kein Handy-Nachfragefenster, dessen Knöpfe sind
  mit Handschuhen zu klein). STOP unterbricht nur,
  START setzt denselben Track fort (versehentliches Stop kostet nichts); neu
  beginnen nur über die Papierkorb-Taste (mit Rückfrage). Gespeichert im
  Browser des Handys (localStorage, `TRACK_STORAGE_KEY` in
  `flight/track.ts`), nicht in Supabase —
  übersteht Neuladen und Wiederöffnen, eine laufende Aufzeichnung läuft beim
  nächsten Öffnen des Flugmodus weiter. Aufgezeichnet wird nur bei offener
  Seite; Pausen > 60 s bleiben als Lücke sichtbar. Die Linie besteht aus
  Stücken zu höchstens 200 Punkten (`TRACK_CHUNK_POINTS`); ein neuer Punkt
  verlängert nur das jüngste Stück (bis Okt. 2026 wurde bei jedem Punkt die
  ganze Linie neu gezeichnet).
- **IGC-Export** (Taste „IGC" unten links neben dem Papierkorb, bei gestopptem Track):
  Datei mit Zeit, Position und **GPS-Höhe** je Punkt, am Handy über das
  Teilen-Menü, sonst als Download (`buildIgc`/`exportIgc` in
  `flight/igc.ts`). Keine Druckhöhe (Browser haben keinen Zugriff auf den
  Luftdruck-Sensor) und keine Signatur (G-Zeile) — für Wettbewerbe mit
  Signaturpflicht reicht die Datei nicht. Zeit und Höhe werden erst seit Okt.
  2026 mitgespeichert; ältere Tracks lassen sich nicht exportieren.
- Geplante weitere Schritte: Landeplätze vorübergehend setzen, Akku-Feinschliff.

**Web-App „SISOSIG" (Okt. 2026, Wunsch des Projektbesitzers)**
- **Eine Website, eine Adresse, ein Code.** Die Website im Browser bleibt wie
  sie ist; als App (Home-Bildschirm / „App installieren") kommen Symbol,
  Name und Offline-Fähigkeit dazu. Kein getrenntes Projekt, keine eigene
  Unteradresse.
- **Symbol:** gelber Stern mit rotem Schatten nach links unten auf Schwarz
  (Vorlage vom Projektbesitzer). Name **SISOSIG**. Startet normal (Karte mit
  Zeitbalken); Abkürzung „Flugmodus" (Android, langes Drücken) öffnet `/?flug`.
- **Hintergrund-Helfer (`public/sw.js`) nur in der App angemeldet**
  (`ServiceWorkerRegistration`, prüft `display-mode: standalone`). Bei
  Android gilt er nach der Installation trotzdem auch für Chrome (gleicher
  Speicher) — deshalb die Grundregel: **mit Netz verhält sich alles wie die
  Website** (Seite und `/api/` immer zuerst aus dem Netz, Speicher nur bei
  Netzausfall). Nicht auf „zuerst aus dem Speicher" umbauen. Als Netzausfall
  zählt seit Okt. 2026 auch ein Netz, das nicht rechtzeitig antwortet (5 s
  Seite, 8 s Daten: `PAGE_TIMEOUT_MS`/`DATA_TIMEOUT_MS` in `sw.js`) — typisch
  bei schwachem Empfang am Berg; vorher hing die App dann minutenlang.
- Ohne Netz kommen gespeicherte Windwerte mit der Kopfzeile
  `x-sisosig-gespeichert` (Speicherzeitpunkt); `WindMap` meldet dann diesen
  Zeitpunkt statt „jetzt", der Flugmodus zeigt „Offline" und färbt die
  Wind-Uhrzeit ab 15 min Alter gelb.
- **Kartenstücke:** nur gespeichert, was man ansieht (max. 4000, nach 30
  Tagen erneuert). **Kein „Gebiet herunterladen"** — die Nutzungsregeln von
  OpenTopoMap verbietet Massen-Downloads. Gespeichert wird per
  CORS-Abruf im Helfer (OpenTopoMap und KK7 erlauben das, Okt. 2026 geprüft); kommt ein Kartendienst dazu, muss er in `TILE_HOSTS` in `sw.js`.
- Bei grundlegenden Änderungen am Helfer `VERSION` in `sw.js` hochzählen
  (alte Speicher werden dann gelöscht). `sw.js` wird nie zwischengespeichert
  (`next.config.ts`).
- iPhone: App und Safari haben **getrennte Speicher** (Track, Standort-
  Erlaubnis) — für den Flug immer die App benutzen.

**Prognosemodelle**
- Gezeichnet wird nur **ICON-CH1** — seit Sept. 2026 **dunkelgrau** statt
  rot, beide Kurven **gestrichelt**, Fläche dazwischen blasser als die
  Messfläche (`CH1_COLOR`, `FORECAST_DASH`, `FORECAST_BAND_OPACITY` in
  `src/components/WindHistoryPanel.tsx`). Die Prognose-Windrichtung steht als
  Pfeilreihe **oben im Diagramm** (je Stunde ein Pfeil). **Nur ICON-CH1 wird
  überhaupt abgefragt und gespeichert** — **ICON-D2** (bis Sept. 2026
  mitgesammelt, nie angezeigt) und **AROME** sind komplett entfernt.
  Einzige Ausnahme ist der Höhenwind (nächster Punkt). Die Druckprognose der
  Föhn-Anzeige (ICON-CH1 und ECMWF) ist davon getrennt, siehe dort.
- **Höhenwind (Okt. 2026, Wunsch des Projektbesitzers)** nur für
  **Rittnerhorn** (`82500WS`) und **Leiterspitz** (`pioupiou-2163`): blaue
  gestrichelte Linie im Verlaufsbalken (`UPPER_WIND_COLOR`), nur Mittelwind
  (Druckflächen haben keine Böen). Quelle **ICON-D2**: bewusst die
  **nächsthöhere Druckfläche** über der Station **ohne Umrechnung** (beide:
  700 hPa), im Verlaufsbalken beschriftet als „700 hPa (ca. 3000 m)“ —
  Wunsch des Projektbesitzers, damit ersichtlich ist, welche Werte es sind.
  Gespeichert als `model = 'icon_d2_upper'` ohne neue Spalten. Eigene
  Laufprüfung (`refreshUpperWind` in der Edge Function), unabhängig von
  ICON-CH1: Fehlt der Höhenwind, kommt er beim nächsten Cron-Anstoß.
  Stationsliste `UPPER_WIND_STATIONS` in `src/lib/wind.ts` (Druckfläche),
  Kopie mit Koordinaten in der Edge Function — beide anfassen.
- **Modell und Lauf stehen im Verlaufsbalken:** rechts im Prognosebereich
  „Prognose ICON-CH1" und „Lauf HH:MM Uhr" (Startzeit des Modelllaufs,
  Ortszeit; Wunsch des Projektbesitzers, Sept. 2026). Die Laufzeit speichert
  die Edge Function in der Spalte `model_run` von `wind_forecasts`
  (`supabase/add-model-run-column.sql`). **Reihenfolge bei einer neuen
  Datenbank-Spalte für die Edge Function: erst Spalte anlegen, dann Funktion
  deployen** — sonst schlägt ihr Speichern fehl. `/api/forecast` fragt
  ohne `model_run` nach, falls die Spalte fehlt.
- **Prognosen nur bei neuem Modelllauf:** ICON-CH1 rechnet alle 3 h neu und
  steht bei Open-Meteo rund 2 h 20 min nach dem Laufstart bereit (00-UTC-Lauf
  gegen 02:20 UTC). Die Edge Function prüft vorher die Metadaten von
  Open-Meteo und fragt nur ab, wenn ein noch nicht gespeicherter Lauf da ist
  — 8 statt 24 Abrufe am Tag, egal wie oft der Cron-Job sie anstößt. Ist die
  Metadaten-Datei nicht lesbar (passiert beim ersten echten Lauf), greift eine
  Zeitregel: höchstens alle 170 min (`MIN_REFETCH_WITHOUT_META_MS`). Diese
  Rückfallregel nicht entfernen — ohne sie fragt jeder Cron-Anstoß alles ab.
- **Gescheiterte Stationen werden nachgeholt** (Punkt 13, Nov. 2026):
  Scheitert beim neuen Lauf ein Teil der Blöcke, merkt sich die Edge Function
  deren Stationen (`wind_status`, Zeile `prognose`, Feld `detail`) und holt sie
  bei den nächsten Cron-Anstößen nach, höchstens `RETRY_MAX_ATTEMPTS` (4)
  Mal — vorher warteten sie bis zum nächsten Lauf (3 h). Nur die offenen
  Stationen werden abgefragt; „No data is available" (außerhalb des
  Modellgebiets) wird nicht nachgeholt.
- **Stationen der Prognose = Stationsliste des Sammlers** (Punkt 14, Nov.
  2026): `wind_stations`, nur Einträge der letzten 2 Tage
  (`STATION_LIST_MAX_AGE_MS`), seitenweise gelesen (Supabase gibt höchstens
  1000 Zeilen je Anfrage). Damit haben alle Stationen der Karte eine
  Prognose-Kurve, auch MeteoSchweiz, LWD Tirol, DWD und OpenWindMap außerhalb
  Südtirols (vorher nur Bozen, Südtiroler OpenWindMap, SLF, GeoSphere).
- **Ostrand von ICON-CH1: 16,64° Länge** (`ICON_CH1_MAX_LNG` in der Edge
  Function). Die 10 GeoSphere-Stationen östlich davon (Burgenland,
  Weinviertel) liefern bei Open-Meteo "No data is available" — und eine
  einzige solche Station lässt die GANZE 50er-Anfrage scheitern. Deshalb
  Vorfilter plus Halbieren gescheiterter Blöcke (`fetchWithSplit`). Diese
  Stationen haben keine Prognose-Kurve, das ist kein Fehler.

**Windanzeiger-Quellen (Sept. 2026)**
- Die neuen Quellen (MeteoSchweiz, LWD Tirol, DWD, Bälmeten und seit Okt.
  2026 alle OpenWindMap-Stationen außerhalb Südtirols) hatten bis Okt. 2026
  **keine Prognose-Kurve**; seit Punkt 14 (Nov. 2026) bekommen sie eine, weil
  die Edge Function die Stationsliste des Sammlers nimmt.
- Der Windanzeiger wählt sie über **Stationscodes** aus, nicht über Namen
  (Fehltreffer, z. B. SLF „Titlisboden" ↔ MeteoSchweiz „Titlis"). Robiei ist
  bewusst nicht dabei: MeteoSchweiz-Kürzel `ROB` = Poschiavo/Robbia im Tal.
- **Zugspitze (DWD):** Der DWD stellt nur alle 30 min eine neue Datei mit den
  10-Minuten-Werten bereit; der Sammler speichert deshalb alle Werte der
  letzten 3 h (`fetchDwdReadingsSince`), nicht nur den neuesten (bis Okt. 2026
  fehlten 2 von 3 Werten, und im Verlaufsbalken erschien keine Kurve). Ab dem
  25.09.2026 lieferte der DWD eine Zeit lang nichts, spätestens seit
  25.10.2026 wieder.

**Nur Stationen in den Alpen (Okt. 2026)**
- Gilt für ALLE Quellen: Angezeigt, gesammelt und prognostiziert werden nur
  Stationen im Alpenraum (`isInAlps()` / `ALPS_POLYGON` in `src/lib/alps.ts`;
  die Edge Function braucht seit Punkt 14 keine Kopie mehr, sie nimmt die
  schon gefilterte Stationsliste des Sammlers). Wunsch des Projektbesitzers: Entscheidend ist
  der **Ort (Alpen ja/nein), nicht die Meereshöhe** — Talstationen in den
  Alpen (Innsbruck, Chur, Sion, Bozen, Klagenfurt, Graz …) bleiben bewusst
  drin; Flachland und Mittelgebirge außerhalb der Alpen (Wien, Burgenland,
  Mühl-/Waldviertel, Schweizer Mittelland mit Bern/Zürich/Basel/Genf, Jura)
  fallen weg, auch wenn sie höher liegen. Nicht auf eine Höhengrenze
  umbauen und nicht auf „alle Stationen" zurückbauen.
- Angewendet in `geosphere.ts`, `meteoswiss.ts`, `slf.ts`, `pioupiou.ts`
  (beim Abruf durch den Sammler; Karte und Prognose nehmen, was er
  gespeichert hat). Bozen, LWD Tirol und Zugspitze liegen ohnehin komplett in
  den Alpen.
- **OpenWindMap im ganzen Umriss** (Punkt 26, Okt. 2026, Wunsch des
  Projektbesitzers; vorher nur eine Südtirol-Box mit 6 Stationen, jetzt rund
  90). Stationen, die seit über 2 Tagen nichts gemeldet haben, erscheinen
  nicht (`MAX_SILENCE_MS`). Prognosen gibt es seit Punkt 14 für alle (vorher
  nur in Südtirol). **Offen:** Der gerade
  West-/Südrand des Umrisses schneidet die französischen und italienischen
  Alpen ab (dort gut 170 weitere aktive OpenWindMap-Stationen) — Erweiterung
  nur auf Wunsch des Projektbesitzers.
- **Ausnahme Windanzeiger:** Die vom Projektbesitzer gewählten
  Windanzeiger-Stationen bleiben immer, auch außerhalb des Umrisses
  (MeteoSchweiz **Chasseral** und **La Dôle** liegen im Jura). Steht in
  `meteoswiss.ts`.
- **Ausnahme Meteotrentino (Nov. 2026):** Alle 46 Windstationen der Provinz
  Trient bleiben, ohne Prüfung gegen den Umriss (Wunsch des Projektbesitzers:
  „alle 46“). Der Umriss schneidet sonst sechs Stationen im Süden ab
  (Torbole am Gardasee, Rovereto, Ala, Tremalzo, Malga Zugna, Passo Pian delle
  Fugazze). Steht in `meteotrentino.ts`; den Umriss selbst nicht deswegen
  ändern.

**Wahrscheinliche Messfehler (Okt. 2026)**
- Wunsch des Projektbesitzers: Liefert eine Station auffällige Werte, steht sie
  auf der Karte als **voller grauer Punkt** (anders als der blasse hohle Ring
  einer ausgefallenen Station), und beim Anklicken steht im Verlaufsbalken ein
  Hinweis „Wahrscheinlich Messfehler: …". Gilt live und beim Blättern im
  Zeitbalken; im Farbstrich des Zeitbalkens zählen solche Werte nicht mit.
- Regeln in `src/lib/plausibility.ts`: (1) Mittelwind, Böe und Richtung
  ≥ 90 min exakt gleich (nur ab 3 km/h — Windstille ist kein Fehler),
  (2) Richtung ≥ 3 h auf das Grad gleich bei ≥ 5 km/h (nicht für Pioupiou und
  DWD, die liefern nur grobe Richtungsschritte; Meteotrentino ist dabei, im
  Nov. 2026 an 48 h Daten der 46 Stationen geprüft: 13.069 Messungen, nichts
  markiert, längste gleiche Richtung 20 min), (3) physikalisch unmögliche
  Einzelwerte (z. B. Böe deutlich kleiner als Mittelwind).
- Die Grenzwerte sind an 2 Tagen echter Daten geprüft (keine Fehlalarme).
  **Nicht verschärfen ohne erneute Prüfung an echten Daten.**
- Berechnet wird für den Verlauf in `/api/timeline` (Feld `q` je Station), für
  die Live-Werte in `WindMap` (`assessLive`: 48 h Verlauf + aktueller Wert).

## Nicht wieder einführen (ohne Rücksprache)

Alles Folgende gab es schon einmal und wurde auf ausdrücklichen Wunsch des
Projektbesitzers entfernt:

- AROME-Prognose (gelb) im Verlaufsbalken (der Höhenwind, blau gestrichelt,
  wurde ebenfalls einmal entfernt und im Okt. 2026 auf ausdrücklichen Wunsch
  für zwei Stationen wieder eingeführt, siehe „Prognosemodelle")
- Fläche zwischen Mess- und Prognosekurve („Vergleichsfläche")
- Gestrichelte Schwellenlinien (5/15/25 km/h) im Diagramm
- Punkte auf den Kurven (Mess- und Prognosepunkte)
- Prognose-Block unter den Messwerten (ICON-CH1-Zahlen in Quadraten mit
  Pfeil daneben) und die wiederholte Uhrzeit-Zeile darüber — ersetzt durch
  die Prognose-Pfeile oben im Diagramm, damit das Panel flacher ist
- Farbiger Rahmen und runde Ecken an den Werte-Quadraten
- Bernsteinfarbene Plakette „Verlauf: HH:MM Uhr" auf der Karte
- Legenden-Overlay auf der Karte, Leaflets eigene Bedienelemente
  (Zoom-Buttons, Layer-Umschalter, Quellen-Zeile unten rechts) und der
  frühere Filter oben links
- Fußzeile mit dem OpenWindMap-Credit (siehe „Quellenangaben")
- `{s}.`-Subdomains in den Kachel-URLs
- Karte „Relief (Grau)" auf der Hauptseite (Esri-Schummerung, Höhenlinien
  des Landes Südtirol, CARTO-/Esri-Ortsnamen; Okt. 2026 entfernt). Damit
  entfiel auch die Umgebungsvariable `NEXT_PUBLIC_CARTO_API_KEY` — sie kann in
  Vercel gelöscht werden.
- Stil „Erklärfilm" (tiefblaue Balken, orange Rahmen, runde Creme-Knöpfe,
  Serifenschrift, Creme-Karte; Okt. 2026 eingebaut und zwei Tage später
  komplett zurückgenommen, PR #123)
- Flughafen-Werte (METAR) in der Föhn-Anzeige: weder als Linie im
  Druck-Diagramm (dünn grau punktiert) noch als Ersatz für Karte und
  Kopfzeile (8. Nov. 2026 ganz entfernt, samt `src/lib/metar.ts`)

## Fallen, die man einer einzelnen Datei nicht ansieht

- **Deno kann nicht aus `src/` importieren.** Die Edge Function
  `supabase/functions/fetch-wind-forecasts/index.ts` hat deshalb eigene Kopien
  der Zeitfenster-Konstanten, von `UPPER_WIND_STATIONS` (mit Koordinaten),
  von `PRESSURE_STATIONS` (Flughäfen, `src/lib/pressure.ts`) und von
  `CREST_STATIONS` (Bergstationen der Kammtemperatur, ebenda).
  Wird `HISTORY_HOURS` / `FUTURE_MARGIN_HOURS` oder `UPPER_WIND_STATIONS` in
  `src/lib/wind.ts` geändert, muss die Edge Function mitgezogen werden (und
  danach im Supabase-Dashboard neu deployt). Die früheren Kopien von
  Quell-Adressen, SLF-/GeoSphere-Abruf, Südtirol-Box und Alpen-Umriss sind
  seit Punkt 14 (Nov. 2026) weg — die Funktion liest die Stationsliste aus
  der Datenbank.
- **Edge Function prüfen ohne Deno:** In der Entwicklungsumgebung gibt es kein
  Deno. Typprüfung mit `tsc` und einer kleinen Ersatz-Deklaration für `Deno`
  (`env.get`, `serve`); Probeläufe mit Node (`--experimental-strip-types`),
  einem Ersatz-`Deno` und nachgebauten Antworten für Supabase und Open-Meteo
  (`handleRequest` ist dafür exportiert). So im Nov. 2026 für das Nachholen
  gescheiterter Stationen gemacht.
- **GeoSphere erlaubt nur 240 Anfragen pro Stunde** (je Absender). Deshalb
  cacht `src/lib/geosphere.ts` die Messwerte 120 s statt 60 s. Nicht
  verkürzen; die Lizenz (CC BY 4.0) verlangt außerdem die Quellenangabe, die
  über `SOURCE_INFO` im Verlaufsbalken steht. Seit Nov. 2026 fragt der
  Sammler zusätzlich alle 5 min den Druck von Innsbruck-Flughafen ab
  (`src/lib/stationPressure.ts`, 12 Anfragen pro Stunde). (Die
  Kammtemperatur im Norden kommt seit 8. Nov. 2026 vom Hafelekar aus der
  ohnehin geladenen Datei des LWD Tirol — keine GeoSphere-Anfrage.)
- **Der Bozner Dienst hinkt 5–10 min nach und zeigt nur den neuesten Wert.**
  `/sensors` liefert je Sensor genau einen Wert, und der ist beim Abruf typisch
  10 min alt (gemessen an `inserted_at − measured_at`). Folge: Ein Messwert, den
  der Dienst verspätet nachliefert — nachdem der nächste schon da war —, wird
  nie der „neueste" und ist für uns unerreichbar. Solche Lücken sind KEIN Fehler
  der Sammel-Route; sie treten bei allen Stationen gleichzeitig auf und lassen
  sich nur über die Archiv-Schnittstelle des Dienstes nachladen (noch nicht
  gebaut). Vor der Fehlersuche in `/api/collect` erst prüfen, ob eine Lücke alle
  Stationen betrifft.
- **Leistung ist im Verlaufsbalken und in `WindMap` empfindlich**: Icon- und
  Handler-Zwischenspeicher, `useMemo`, `useDeferredValue` und die Refs in
  `WindApp` sind bewusst so gebaut (jeweils ausführlich im Code kommentiert).
  Nicht „aufräumen", ohne den zugehörigen Kommentar gelesen zu haben.
- **Reihenfolge/Anzahl der Stationen darf sich beim Blättern im Zeitbalken
  nicht ändern** — fehlende Messwerte werden zu grauen Punkten, nicht
  herausgefiltert.
- **Bestehende Datenbanken** brauchen die einmaligen SQL-Skripte in
  `supabase/` (Spalte `source`, `measured_at`-Index, Aufräumskripte, seit
  Okt. 2026 `datenbank-aufraeumen.sql`, `collect-cron-tresor.sql`,
  `stationsliste.sql` und `zeitbalken-funktion.sql`, seit Nov. 2026
  `ein-sammler.sql` und `druck.sql`) — bei
  einer Neuinstallation ist alles schon in `schema.sql`/`forecast-schema.sql`
  bzw. `collect-cron.sql`. In der Datenbank des Projekts sind alle ausgeführt
  (die letzte Zeile von `druck.sql`, `qnh_hpa` darf leer sein, am 8. Nov.
  2026).
- **Zeitplan-Jobs melden nur „abgeschickt“:** In `cron.job_run_details`
  steht bei jedem Lauf „succeeded“, auch wenn `/api/collect` scheitert (pg_net
  arbeitet asynchron). Die echte Antwort steht in `net._http_response`, aber
  nur 6 Stunden lang. `/api/collect` nennt darin je Quelle die Zahl der Werte
  und die gescheiterten Quellen. Dauerhaft steht der letzte Zustand jeder
  Quelle und der Prognose-Funktion seit Nov. 2026 in der Tabelle `wind_status`
  (`ok`, `ok_at` = seit wann es zuletzt geklappt hat, `error`).
- **Adresse des Bozner Dienstes** (`src/lib/bolzano.ts`; bis Nov. 2026 stand
  sie zusätzlich in der Edge Function) — seit Sept. 2026
  `geoservices.buergernetz.bz.it`, die alte `daten.buergernetz.bz.it` liefert
  nur noch 404. Ebenso **LWD Tirol**: seit Okt. 2026 `wiski.tirol.gv.at` (die
  alte Adresse `lawine.tirol.gv.at/data/…` leitet nur noch um).
- **Open-Meteo-Kontingent:** kostenlos 10.000 Aufrufe am Tag. Gezählt wird
  je **Station** einer Anfrage (1 Aufruf, solange ≤10 Werte-Reihen und ≤2
  Wochen — laut Quellcode von Open-Meteo); weitere Modelle in derselben
  Anfrage kosten erst ab 10 Reihen extra. Stand Nov. 2026: ~650 Stationen
  (alle Stationen der Karte, seit Punkt 14; mit den 46 von Meteotrentino
  ~700, der Rest eines Laufs kommt beim nächsten Anstoß) × 8 Modellläufe ≈
  5.200 (mit Meteotrentino ≈ 5.600) am Tag,
  plus 16 für den Höhenwind (2 Stationen × 8), 24 für den Luftdruck der
  Flughäfen (ICON-CH1 2 × 8, ECMWF 2 × 4) und 16 für die Kammtemperatur
  (ICON-CH1 2 × 8, seit 8. Nov. 2026); das Nachholen gescheiterter
  Stationen kostet nur bei Fehlern etwas. **Außerdem höchstens 600 Aufrufe
  pro Minute** (und 5.000 pro Stunde): Der erste Lauf mit allen 657 Stationen
  (01.11.2026) bekam für die letzten 57 Status 429. Deshalb fragt ein Anstoß
  höchstens `MAX_STATIONS_PER_RUN` (450) Stationen ab, der Rest kommt beim
  nächsten Anstoß 15 min später (wie gescheiterte Stationen, aber ohne
  Fehler). Nicht hochsetzen, ohne die Minutengrenze zu bedenken (Luft für
  Höhenwind und das Halbieren bei „No data"). Wird die
  Laufprüfung (`loadModelRun`/`loadLastFetchedMs` in der Edge Function)
  entfernt, wären es stündlich ≈ 15.600 — über der Grenze.
- **Sandbox:** Ausgehende Verbindungen zu `geoservices.buergernetz.bz.it`,
  `api.pioupiou.fr`, `dataset.api.hub.geosphere.at`, den Kartenkacheln und Supabase sind in
  manchen Entwicklungsumgebungen blockiert. Kartendienste lassen sich dort
  also **nicht** per `curl` prüfen — das geht nur am realen Kartenbild
  (Vercel-Vorschau) oder indem der Projektbesitzer eine Test-Adresse im
  Browser öffnet. Fehlerantworten (502/500) sind dort
  normal. Mit `WIND_API_BASE_URL`, `PIOUPIOU_API_BASE_URL`, `SLF_API_BASE_URL`,
  `GEOSPHERE_API_BASE_URL`, `METEOTRENTINO_API_BASE_URL` und `OPEN_METEO_BASE_URL` lässt sich auf einen
  lokalen Mock umbiegen.

## Quellenangaben (Lizenzpflicht)

- **Kartenquellen** (OpenTopoMap/OpenStreetMap/SRTM, Kabel, Höhendaten der Gelände-Ebenen, Luftdruck der Föhn-Anzeige, KK7-Thermikkarte) stehen unter
  „Quellen" im Ebenen-Menü (Knopf mit drei Strichen oben rechts;
  `MAP_SOURCES` in `src/lib/wind.ts`).
- **Winddaten-Quellen** stehen NICHT dort (Wunsch des Projektbesitzers,
  keine Doppelung), sondern stationsweise unten im Verlaufsbalken als
  „Quelle:"-Link (`SOURCE_INFO`). Offener Punkt: Die OpenWindMap-
  Community-Lizenz verlangt einen sichtbaren Credit mit Link, SLF und
  GeoSphere Austria stehen unter CC BY 4.0 — diese Nennungen sind damit nur
  sichtbar, wenn eine Station der jeweiligen Quelle geöffnet ist. Beim Thema erwähnen,
  die Fußzeile aber nicht ungefragt zurückbringen.
