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
- Bei mehreren möglichen Lösungswegen: triff eine klare Empfehlung
  statt mich mit Optionen zu überfordern, außer ich frage explizit
  danach

## Projektkontext
- Website für Live-Windwerte für Gleitschirmflieger, Startpunkt:
  Südtiroler Wetterstationen (Provinz Bozen Open Data API)
- Aktuell nur ich + wenige Nutzer, aber die Architektur soll
  skalierbar bleiben
- Phasenplan:
  1. Südtirol: Live-Wind + 12h-Historie auf Karte (aktuell in Arbeit)
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
- **Verlaufsbalken** = das Panel unten mit dem 12h-Diagramm einer Station
  (`src/components/WindHistoryPanel.tsx`)
- **Zeitbalken** = der Schieberegler unter der Karte, mit dem man die ganze
  Karte durch die letzten 12 h blättert (`src/components/TimeSlider.tsx`)
- **Windanzeiger** = die vom Besitzer ausgewählte Stationsliste im
  Stationsfilter (`WINDANZEIGER_STATION_NAMES` in `src/lib/wind.ts`)

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
OpenWindMap/Pioupiou-Netz, den SLF-IMIS-Stationen (Schweiz) und GeoSphere
Austria (TAWES, ganz Österreich), Historie und Prognose in Supabase.

**Ablauf:** Browser → `/api/wind` (Live-Werte, alle 3 min) und `/api/timeline`
(12 h für alle Stationen, nur bei Bedarf) und `/api/history` + `/api/forecast`
(12 h + Prognose einer Station). Gefüttert wird Supabase von zwei Cron-Jobs:
`/api/collect` alle 5 min (Messwerte) und der Edge Function
`fetch-wind-forecasts` stündlich (Prognosen).

| Datei | Zuständig für |
| --- | --- |
| `src/lib/wind.ts` | Gemeinsame Typen, Farbskala, Zeitraster, Konstanten — die zentrale Stelle für fast alle Einstellwerte |
| `src/lib/pioupiou.ts` | OpenWindMap/Pioupiou-Stationen (Abruf + Südtirol-Bounding-Box) |
| `src/lib/slf.ts` | Schweizer IMIS-Stationen des SLF (wie auf whiterisk.ch), Messtakt 30 min |
| `src/lib/geosphere.ts` | Alle österreichischen Stationen mit Wind von GeoSphere Austria (früher ZAMG) |
| `src/app/api/wind/route.ts` | Live-Werte aller Stationen (Bozen, Pioupiou, SLF, GeoSphere), inkl. Caching |
| `src/app/api/collect/route.ts` | Schreibt Messwerte nach Supabase (POST, per `CRON_SECRET` geschützt) |
| `src/app/api/history/route.ts` | 12 h Messwerte **einer** Station |
| `src/app/api/forecast/route.ts` | Prognose (ICON-CH1) **einer** Station |
| `src/app/api/timeline/route.ts` | 12 h **aller** Stationen, kompaktes Spaltenformat für den Zeitbalken |
| `src/app/page.tsx` / `layout.tsx` | Seitengerüst, Schrift, Hell-/Dunkelmodus-Schalter (Klasse am `<html>`) |
| `src/components/WindApp.tsx` | Titelbalken, Menü (Karte/Stationen), Zustand des Zeitbalkens |
| `src/components/WindMapLoader.tsx` | Lädt die Karte ohne Server-Rendering (Leaflet braucht `window`) |
| `src/components/WindMap.tsx` | Karte, Kachel-Ebenen (Schummerung/Höhenlinien/Beschriftung), Zoom-Grenzen, Marker/Pfeile, Abruf-Takt, Auswahl einer Station |
| `src/components/WindHistoryPanel.tsx` | Verlaufsbalken (Diagramm, Werte-Quadrate, Prognose) |
| `src/components/TimeSlider.tsx` | Zeitbalken |
| `supabase/functions/fetch-wind-forecasts/` | Edge Function (Deno!), holt Open-Meteo-Prognosen |
| `supabase/*.sql` | Tabellen-Schemas, Cron, einmalige Migrations-/Aufräumskripte |
| `src/data/staatsgrenzen.json` | Staatsgrenzen-Overlay der Karte |

## Feste Entscheidungen (nicht ohne Rücksprache ändern)

**Technik-Grundsatz**
- Karten-Bibliothek: **Leaflet** (bewusst statt MapLibre GL JS)
- Hosting **Vercel**, Datenbank **Supabase**, Datensammlung über
  `/api/collect`, angestoßen von **Supabase Cron** (nicht GitHub Actions)
- Secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`)
  **niemals** im Code — nur Umgebungsvariablen in Vercel/Supabase

**Darstellung**
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
  Esri-Schummerung liefert in Südtirol darüber hinaus nur noch graue
  Platzhalter-Kacheln ("Map data not yet available"). Die Grenze gilt
  **einheitlich für beide Basiskarten**, obwohl OpenStreetMap (19) und die
  CARTO-Beschriftungen (20) mehr könnten — die Karte soll sich beim
  Umschalten nicht unterschiedlich verhalten. Nicht „großzügiger" machen,
  ohne vorher am realen Kartenbild zu prüfen, ob die Schummerung dort noch
  echte Kacheln hat.
- **Zahlen unter den Pfeilen erst ab Zoom 9** (`LABEL_MIN_ZOOM` in
  `src/components/WindMap.tsx`, = Startansicht Südtirol). Herausgezoomt
  überdeckten sich die Zahlen der ~560 Stationen (Schweiz + Österreich) zu
  einem unlesbaren Teppich; dort zeigt die Karte nur die farbigen Pfeile.
  Bei aktivem Stationsfilter (nicht „Alle") bleiben die Zahlen immer sichtbar.
  Wunsch des Projektbesitzers, Sept. 2026.
- **Höhenlinien-Ebene nur bei „Relief (Grau)"**, nicht bei „Standard".
  Quelle ist der WMS-Dienst des Landes Südtirol
  (`CONTOUR_WMS_URL`/`CONTOUR_WMS_LAYER` in `src/components/WindMap.tsx`,
  Layer `p_bz-Elevation:ContourLines-ForLightBackgrounds` — die Variante für
  helle Hintergründe; der Dienst dünnt beim Herauszoomen selbst aus, wir
  bekommen also nicht die vollen 2,5 m Abstand des Geländemodells).
  Sie liegt als transparentes PNG **über** der Esri-Schummerung und **unter**
  den CARTO-Ortsnamen (`Z_HILLSHADE`/`Z_CONTOURS`/`Z_LABELS`); Windpfeile und
  Auswahl-Ring liegen ohnehin über allen Kacheln.
  Eingeblendet **erst ab Zoom 13** (`CONTOUR_MIN_ZOOM`) — darunter lädt
  Leaflet gar keine Kacheln, das spart auch Anfragen an den Landesserver.
  Zurückgenommen über `CONTOUR_OPACITY` (0,5) und den Graufilter
  `.hoehenlinien-ebene` in `src/app/globals.css`; die Windpfeile müssen klar
  im Vordergrund bleiben.
  **Ausfallsicherheit:** `errorTileUrl` ist ein durchsichtiger 1×1-Punkt
  (`TRANSPARENT_TILE`) — fehlende Kacheln sind damit nur fehlende Kacheln und
  kein Fehlerzustand der Karte.
  **Lizenz:** Die Geodaten des Landes stehen unter CC BY, die Quellenangabe
  muss sichtbar bleiben. Sie steht (wie Esri, CARTO, OpenStreetMap) seit
  Sept. 2026 **ganz unten im Menü-Popup unter „Quellen"** (`MAP_SOURCES` in
  `src/lib/wind.ts`) — nicht entfernen.
- **Auf der Karte unten steht nur „Zuletzt aktualisiert"**: Leaflets
  Quellen-Zeile unten rechts ist per `attributionControl={false}`
  abgeschaltet (belegte am Handy zwei Zeilen und überdeckte die Plakette).
  Die Quellenangaben stehen stattdessen im Menü-Popup (siehe oben).
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
  einen kürzeren Takt.
- **Sammel-Takt bleibt bei 5 min** (Supabase-Cron-Job `collect-data`), obwohl
  die Stationen nur alle 10 min messen — siehe die Begründung oben in
  `src/app/api/collect/route.ts`. Nicht auf 10 min „aufräumen".
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

**Prognosemodelle**
- Gezeichnet wird nur **ICON-CH1** — seit Sept. 2026 **dunkelgrau** statt
  rot, beide Kurven **gestrichelt**, Fläche dazwischen blasser als die
  Messfläche (`CH1_COLOR`, `FORECAST_DASH`, `FORECAST_BAND_OPACITY` in
  `src/components/WindHistoryPanel.tsx`). Die Prognose-Windrichtung steht als
  Pfeilreihe **oben im Diagramm** (je Stunde ein Pfeil). **ICON-D2** wird
  weiter gesammelt, aber nicht angezeigt. **AROME** ist komplett entfernt.

## Nicht wieder einführen (ohne Rücksprache)

Alles Folgende gab es schon einmal und wurde auf ausdrücklichen Wunsch des
Projektbesitzers entfernt:

- AROME-Prognose (gelb) und „Höhenwind"-Ebene (blau gestrichelt) im
  Verlaufsbalken
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

## Fallen, die man einer einzelnen Datei nicht ansieht

- **Deno kann nicht aus `src/` importieren.** Die Edge Function
  `supabase/functions/fetch-wind-forecasts/index.ts` hat deshalb eigene Kopien
  von Zeitfenster-Konstanten, der Pioupiou-Bounding-Box, des SLF-
  Stationsabrufs und der GeoSphere-Adresse. Wird `HISTORY_HOURS` /
  `FUTURE_MARGIN_HOURS` in `src/lib/wind.ts`, `SOUTH_TYROL_BBOX` in
  `src/lib/pioupiou.ts` (gilt auch für die GeoSphere-Prognosen) oder
  Adresse/Codepräfix in `src/lib/slf.ts` bzw. `src/lib/geosphere.ts` geändert,
  muss die Edge Function mitgezogen werden.
- **GeoSphere erlaubt nur 240 Anfragen pro Stunde** (je Absender). Deshalb
  cacht `src/lib/geosphere.ts` die Messwerte 120 s statt 60 s. Nicht
  verkürzen; die Lizenz (CC BY 4.0) verlangt außerdem die Quellenangabe, die
  über `SOURCE_INFO` im Verlaufsbalken steht.
- **Prognosen nur für Stationen in der Südtirol-Box**, obwohl alle ~275
  österreichischen Stationen auf der Karte sind: Mit allen würde die Edge
  Function die kostenlose Open-Meteo-Grenze (10.000 Abrufe/Tag) sprengen
  (Begründung in `loadGeoSphereStations()` der Edge Function). Österreichische
  Stationen außerhalb der Box haben deshalb keine ICON-CH1-Kurve — das ist
  kein Fehler.
- **Zeitstempel-Umwandlung doppelt:** `/api/wind` und `/api/collect` wandeln
  beide das nicht-normgerechte Format des Bozner Dienstes um — bei Änderungen
  beide anfassen.
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
  `supabase/` (Spalte `source`, `measured_at`-Index, Aufräumskripte) — bei
  einer Neuinstallation ist alles schon in `schema.sql`.
- **Adresse des Bozner Dienstes steht dreifach** (`/api/wind`, `/api/collect`,
  Edge Function) — seit Sept. 2026 `geoservices.buergernetz.bz.it`, die alte
  `daten.buergernetz.bz.it` liefert nur noch 404. Bei einem Umzug alle drei
  ändern; die Edge Function muss danach im Supabase-Dashboard neu deployt
  werden.
- **Open-Meteo-Kontingent:** Seit den ~200 SLF-Stationen und den 13
  grenznahen GeoSphere-Stationen fragt die Edge Function rund 315 Standorte
  pro Stunde ab (≈ 7.500 am Tag). Das kostenlose
  Open-Meteo-Kontingent liegt bei 10.000 Aufrufen am Tag — weitere Stationen
  oder ein kürzerer Prognose-Takt würden es sprengen.
- **Sandbox:** Ausgehende Verbindungen zu `geoservices.buergernetz.bz.it`,
  `api.pioupiou.fr`, `dataset.api.hub.geosphere.at`, den Kartenkacheln (auch `server.arcgisonline.com` und
  dem Höhenlinien-Dienst `geoservices9.civis.bz.it`) und Supabase sind in
  manchen Entwicklungsumgebungen blockiert. Kartendienste lassen sich dort
  also **nicht** per `curl` prüfen — das geht nur am realen Kartenbild
  (Vercel-Vorschau) oder indem der Projektbesitzer eine Test-Adresse im
  Browser öffnet. Fehlerantworten (502/500) sind dort
  normal. Mit `WIND_API_BASE_URL`, `PIOUPIOU_API_BASE_URL`, `SLF_API_BASE_URL`,
  `GEOSPHERE_API_BASE_URL` und `OPEN_METEO_BASE_URL` lässt sich auf einen
  lokalen Mock umbiegen.

## Quellenangaben (Lizenzpflicht)

- **Kartenquellen** (Esri, Höhenlinien des Landes, CARTO/OpenStreetMap)
  stehen ganz unten im Menü-Popup unter „Quellen" (`MAP_SOURCES` in
  `src/lib/wind.ts`).
- **Winddaten-Quellen** stehen NICHT im Menü (Wunsch des Projektbesitzers,
  keine Doppelung), sondern stationsweise unten im Verlaufsbalken als
  „Quelle:"-Link (`SOURCE_INFO`). Offener Punkt: Die OpenWindMap-
  Community-Lizenz verlangt einen sichtbaren Credit mit Link, SLF und
  GeoSphere Austria stehen unter CC BY 4.0 — diese Nennungen sind damit nur
  sichtbar, wenn eine Station der jeweiligen Quelle geöffnet ist. Beim Thema erwähnen,
  die Fußzeile aber nicht ungefragt zurückbringen.

## CARTO-Ortsnamen brauchen einen Schlüssel

Seit Sept. 2026 liefert CARTO (`basemaps.cartocdn.com`) ohne Schlüssel nur
Kacheln mit dem Wasserzeichen „API KEY REQUIRED". Der Schlüssel ist für
nicht-kommerzielle Nutzung kostenlos und steht als Umgebungsvariable
`NEXT_PUBLIC_CARTO_API_KEY` in Vercel (nach dem Eintragen neu deployen).
**Ohne Schlüssel** nimmt die Karte automatisch die Esri-Ortsnamen
(`World_Light_Gray_Reference`, keine Anmeldung nötig, aber nur italienische
Namen) — so gibt es nie Wasserzeichen. Umschaltung in `src/components/WindMap.tsx`
(`CARTO_API_KEY` aus `src/lib/wind.ts`), die Quellenzeile folgt automatisch.
