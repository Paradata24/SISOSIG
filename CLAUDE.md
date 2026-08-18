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

Next.js (App Router) + Leaflet-Karte, Daten aus dem Bozner Wetterdienst und dem
OpenWindMap/Pioupiou-Netz, Historie und Prognose in Supabase.

**Ablauf:** Browser → `/api/wind` (Live-Werte, alle 3 min) und `/api/timeline`
(12 h für alle Stationen, nur bei Bedarf) und `/api/history` + `/api/forecast`
(12 h + Prognose einer Station). Gefüttert wird Supabase von zwei Cron-Jobs:
`/api/collect` alle 5 min (Messwerte) und der Edge Function
`fetch-wind-forecasts` stündlich (Prognosen).

| Datei | Zuständig für |
| --- | --- |
| `src/lib/wind.ts` | Gemeinsame Typen, Farbskala, Zeitraster, Konstanten — die zentrale Stelle für fast alle Einstellwerte |
| `src/lib/pioupiou.ts` | OpenWindMap/Pioupiou-Stationen (Abruf + Südtirol-Bounding-Box) |
| `src/app/api/wind/route.ts` | Live-Werte aller Stationen (Bozen + Pioupiou), inkl. Caching |
| `src/app/api/collect/route.ts` | Schreibt Messwerte nach Supabase (POST, per `CRON_SECRET` geschützt) |
| `src/app/api/history/route.ts` | 12 h Messwerte **einer** Station |
| `src/app/api/forecast/route.ts` | Prognose (ICON-CH1) **einer** Station |
| `src/app/api/timeline/route.ts` | 12 h **aller** Stationen, kompaktes Spaltenformat für den Zeitbalken |
| `src/app/page.tsx` / `layout.tsx` | Seitengerüst, Schrift, Dunkelmodus-Klasse |
| `src/components/WindApp.tsx` | Titelbalken, Menü (Karte/Stationen), Zustand des Zeitbalkens |
| `src/components/WindMapLoader.tsx` | Lädt die Karte ohne Server-Rendering (Leaflet braucht `window`) |
| `src/components/WindMap.tsx` | Karte, Marker/Pfeile, Abruf-Takt, Auswahl einer Station |
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
- **Dunkelmodus dauerhaft an**, unabhängig vom Gerät des Besuchers.
  Ausdrücklich **ausgenommen und hell**: die Karte selbst (Kacheln, Pfeile,
  Beschriftungen, Auswahlring, Grenzen) und die Farbskala `WIND_COLOR_SCALE`.
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
- **Einzelne Messlücken werden im Verlaufsbalken überbrückt** (`BAND_GAP_MS`,
  25 min): Der Bozner Dienst überspringt gelegentlich einen Zeitpunkt bei allen
  Stationen gleichzeitig. Ab zwei fehlenden Werten am Stück reißt die Kurve
  weiterhin sichtbar auf — dieser Teil war ausdrücklicher Wunsch des
  Projektbesitzers.

**Prognosemodelle**
- Gezeichnet wird nur **ICON-CH1** (rot). **ICON-D2** wird weiter gesammelt,
  aber nicht angezeigt. **AROME** ist komplett entfernt.

## Nicht wieder einführen (ohne Rücksprache)

Alles Folgende gab es schon einmal und wurde auf ausdrücklichen Wunsch des
Projektbesitzers entfernt:

- AROME-Prognose (gelb) und „Höhenwind"-Ebene (blau gestrichelt) im
  Verlaufsbalken
- Fläche zwischen Mess- und Prognosekurve („Vergleichsfläche")
- Gestrichelte Schwellenlinien (5/15/25 km/h) im Diagramm
- Punkte auf den Kurven (Mess- und Prognosepunkte)
- Farbiger Rahmen und runde Ecken an den Werte-Quadraten
- Bernsteinfarbene Plakette „Verlauf: HH:MM Uhr" auf der Karte
- Legenden-Overlay auf der Karte, Leaflets eigene Bedienelemente
  (Zoom-Buttons, Layer-Umschalter) und der frühere Filter oben links
- Fußzeile mit dem OpenWindMap-Credit (siehe „Offener Punkt")
- `{s}.`-Subdomains in den Kachel-URLs

## Fallen, die man einer einzelnen Datei nicht ansieht

- **Deno kann nicht aus `src/` importieren.** Die Edge Function
  `supabase/functions/fetch-wind-forecasts/index.ts` hat deshalb eigene Kopien
  von Zeitfenster-Konstanten und der Pioupiou-Bounding-Box. Wird `HISTORY_HOURS`
  / `FUTURE_MARGIN_HOURS` in `src/lib/wind.ts` oder `SOUTH_TYROL_BBOX` in
  `src/lib/pioupiou.ts` geändert, muss die Edge Function mitgezogen werden.
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
- **Sandbox:** Ausgehende Verbindungen zu `daten.buergernetz.bz.it`,
  `api.pioupiou.fr`, den Kartenkacheln und Supabase sind in manchen
  Entwicklungsumgebungen blockiert. Fehlerantworten (502/500) sind dort
  normal. Mit `WIND_API_BASE_URL`, `PIOUPIOU_API_BASE_URL` und
  `OPEN_METEO_BASE_URL` lässt sich auf einen lokalen Mock umbiegen.

## Offener Punkt: Quellenangabe OpenWindMap

Die Community-Lizenz von OpenWindMap verlangt einen sichtbaren Credit mit
Link. Er stand in der Fußzeile, die entfernt wurde; der Projektbesitzer will
das später anders lösen. Aktuell gibt es ihn nur stationsweise als
„Quelle:"-Link im Verlaufsbalken (`SOURCE_INFO` in `src/lib/wind.ts`). Beim
Thema erwähnen, die Fußzeile aber nicht ungefragt zurückbringen.
