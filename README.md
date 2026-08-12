# SISOSIG – Südtirol Live-Wind

Eine Website, die Live-Windwerte Südtiroler Wetterstationen auf einer Karte
anzeigt (Leaflet + OpenStreetMap).

## Lokal starten

```bash
npm install
npm run dev
```

Danach im Browser [http://localhost:3000](http://localhost:3000) öffnen.

## Wie die Winddaten geladen werden

Die Winddaten kommen vom offenen Datenportal der Provinz Bozen
([data.civis.bz.it](https://data.civis.bz.it/de/dataset/misure-meteo-e-idrografiche)),
über den Webservice unter `daten.buergernetz.bz.it/services/meteo/v1`:

- `/sensors` liefert die aktuellen Messwerte aller Stationen.
- `/stations` liefert Name und Koordinaten der Stationen.

Die Next.js-Route `src/app/api/wind/route.ts` ruft beide Endpunkte ab
(insgesamt nur 2 Anfragen pro Aktualisierung) und gibt alle Stationen
mit Windsensoren und Koordinaten als JSON-Liste zurück: Richtung,
Mittelwind und Böe (umgerechnet in km/h) sowie ein `stale`-Flag für
Stationen, deren Messwerte fehlen oder älter als 2 Stunden sind — diese
erscheinen auf der Karte als grauer Punkt statt als Windpfeil.

Bestimmte Stationen lassen sich über `/api/wind?station=<SCODE1>,<SCODE2>`
filtern. Die Stationscodes findet man in der Antwort von
`/services/meteo/v1/stations`.

Zusätzlich holt `/api/wind` über `src/lib/pioupiou.ts` die Südtiroler
Stationen des **OpenWindMap/Pioupiou-Netzwerks** dazu (Endpunkt
`https://api.pioupiou.fr/v1/live/all`, gefiltert über eine grobe
Südtirol-Bounding-Box, da die API keinen Regionsfilter kennt) und zeigt sie
genau wie die Bozner Stationen auf der Karte an — Pfeil, Farbskala,
Klick-Historie, alles identisch. Ihre Stationscodes haben das Format
`pioupiou-<ID>` (z. B. `pioupiou-413`), damit sie nicht mit den Bozner
SCODEs kollidieren. Schlägt der Abruf fehl, zeigt die Karte trotzdem die
Bozner Stationen (additiv, kein Blocker). Details zu Lizenz und Einheiten
siehe unten unter „OpenWindMap/Pioupiou-Stationen".

### Zwischenspeicherung (Caching)

Die Stationen messen nur alle 5–10 Minuten. Deshalb fragt nicht jeder
Seitenaufruf die fremden Dienste neu ab, sondern `/api/wind` nutzt drei
Cache-Ebenen (alle in `src/app/api/wind/route.ts` bzw.
`src/lib/pioupiou.ts` konfiguriert):

| Was wird gecacht?                            | Wie lange? | Warum?                                       |
| -------------------------------------------- | ---------- | -------------------------------------------- |
| Messwerte Bozen (`/sensors`)                 | 60 Sekunden | Neue Messungen kommen eh nur alle 5–10 min   |
| Messwerte OpenWindMap/Pioupiou (`/live/all`) | 60 Sekunden | dito                                         |
| Stationsmetadaten Bozen (`/stations`)        | 6 Stunden   | Name/Koordinaten/Höhe ändern sich praktisch nie |

Zusätzlich wird die **fertige JSON-Antwort** von `/api/wind` über den
`Cache-Control`-Header (`s-maxage=60`) 60 Sekunden vom Vercel-CDN
geteilt: Rufen mehrere Besucher die Seite gleichzeitig auf, bekommen
alle dieselbe Antwort, ohne dass der Server die Daten mehrfach
zusammenbaut. Fehlerantworten (z. B. wenn der Bozner Dienst nicht
erreichbar ist) werden bewusst **nicht** gecacht, damit sich ein kurzer
Ausfall nicht festsetzt.

Nach demselben Muster arbeiten auch die beiden Verlaufsbalken-Routen:
`/api/history` wird 60 Sekunden vom CDN geteilt (neue Messwerte kommen nur
alle 10 Minuten dazu), `/api/forecast` 120 Sekunden (die Prognose wird nur
stündlich neu geholt). Klickt man auf der Karte zwischen zwei Stationen hin
und her, kommt die Antwort dadurch direkt aus dem Zwischenspeicher statt
jedes Mal aus der Datenbank.

Die drei fremden Dienste, die `/api/wind` braucht (`/sensors`, `/stations`,
Pioupiou), werden außerdem **gleichzeitig** abgefragt statt nacheinander:
muss die Route wirklich einmal laufen (Cache-Miss), dauert sie damit nur so
lange wie der langsamste einzelne Abruf.

Praktische Folgen:

- Angezeigte Werte können bis zu ~1–2 Minuten „alt" sein — bei
  Messintervallen von 5–10 Minuten ist das ohne Bedeutung.
- Die Karte fragt im Hintergrund alle **3 Minuten** neue Werte ab
  (`POLL_INTERVAL_MS` in `src/components/WindMap.tsx`) und im Hintergrund
  laufender Tabs gar nicht. Kehrt man zur Seite zurück, wird sofort
  aktualisiert — der Takt macht die Anzeige also nicht träger, spart auf
  dem Handy aber deutlich Datenvolumen.
- Die Sammel-Route `/api/collect` (läuft alle 10 Minuten) ist davon
  nicht betroffen: gespeichert wird immer der Mess-Zeitstempel der
  Station, Duplikate fängt der Upsert in Supabase ab.
- Beim lokalen Entwickeln: ein „harter" Browser-Reload
  (Strg+Shift+R bzw. Cmd+Shift+R) umgeht den Cache, falls man beim
  Testen wirklich frische Daten sehen will.

## Wind-Historie (Supabase)

### Wie die Daten gesammelt werden

Die Sammel-Route `src/app/api/collect/route.ts` (Aufruf per **POST** unter
`/api/collect`) fragt denselben Wetterdienst wie `/api/wind` ab — sowohl den
Bozner Wetterdienst als auch die Südtiroler OpenWindMap/Pioupiou-Stationen
(siehe oben) — und schreibt die aktuellen Windwerte aller Stationen in die
Supabase-Tabelle `wind_measurements` (Schema: `supabase/schema.sql`,
einmalig im Supabase SQL-Editor ausführen). Jede Zeile trägt in der Spalte
`source` die Herkunft (`bolzano` oder `openwindmap`), damit sich das später
auch bei weiteren Regionen/Quellen unterscheiden lässt. Bereits vorhandene
Messungen werden dabei nicht doppelt angelegt (Upsert über `station_code` +
`measured_at`), und Einträge älter als 2 Tage werden bei jedem Lauf
gelöscht (die Anzeige braucht nur 12 Stunden, der Rest ist Puffer).

**Wenn `wind_measurements` schon vor dieser Änderung angelegt wurde:**
einmalig `supabase/add-source-column.sql` im Supabase SQL-Editor ausführen
(ergänzt nur die neue Spalte `source`, ohne bestehende Daten zu löschen —
bei einer komplett neuen Installation über `schema.sql` ist das nicht
nötig, die Spalte ist dort schon enthalten).

**Ebenfalls einmalig bei einer bestehenden Datenbank:**
`supabase/add-measured-at-index.sql` ausführen. Das legt nur einen
zusätzlichen Index an (nichts wird gelöscht oder verändert) und macht die
Abfrage des Zeitbalkens deutlich schneller. Schritt für Schritt:

1. [supabase.com](https://supabase.com) öffnen und beim Projekt anmelden.
2. In der linken Leiste auf **SQL Editor** klicken.
3. Oben auf **New query** klicken.
4. Den kompletten Inhalt der Datei `supabase/add-measured-at-index.sql`
   hineinkopieren.
5. Rechts unten auf **Run** klicken. Es sollte
   *„Success. No rows returned"* erscheinen.

Ein zweites Ausführen schadet nicht (`if not exists`).

Angestoßen wird die Route von **Supabase Cron** (früher lief das über einen
GitHub-Actions-Workflow; der ist entfernt, damit nicht doppelt geschrieben
wird). Jeder Aufruf muss den Header `Authorization: Bearer <CRON_SECRET>`
mitschicken.

**Antwort der Route:**

- **Erfolg:** Status `200` mit JSON, z. B.
  `{ "ok": true, "saved": 42, "cleanupBefore": "…", "cleanupOk": true }`
  (`saved` = Anzahl gespeicherter Stationswerte).
- **Falsches/fehlendes Token:** Status `401` (`{ "error": "Nicht autorisiert" }`).
- **Fehlende Server-Variablen:** Status `500`.
- **Wetterdienst nicht erreichbar / keine Werte:** Status `502`.

`/api/history?station=<SCODE>` liefert die so gesammelten Messwerte der
letzten 12 Stunden einer Station (für den Verlaufsbalken).
`/api/timeline` liefert dieselben 12 Stunden für **alle** Stationen
gemeinsam (für den Zeitbalken unter der Karte, siehe unten).

### Benötigte Zugangsdaten

Niemals in den Code schreiben! Alle als **Environment Variables in Vercel**
(Settings → Environment Variables), danach einmal **neu deployen**:

| Variable | Wert | Wofür |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL des Supabase-Projekts | `/api/collect`, `/api/history` und `/api/timeline` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role Key des Supabase-Projekts | `/api/collect`, `/api/history` und `/api/timeline` |
| `CRON_SECRET` | selbst gewähltes, langes Geheimnis | schützt `/api/collect` vor fremden Aufrufen |

Der Wert von `CRON_SECRET` in Vercel wird **ohne** `Bearer ` eingetragen; im
Supabase-Cron-Header steht derselbe Wert **mit** `Bearer ` davor.

### Supabase Cron einrichten

1. In Supabase links auf **Integrations → Cron** (bzw. **Database → Cron
   Jobs**) und **Create a new cron job**.
2. Zeitplan **alle 10 Minuten** wählen (`*/10 * * * *`) — dieser Takt gilt
   für alle Stationen (Bozen und OpenWindMap gemeinsam). Läuft bei dir
   bereits ein Cron-Job mit einem anderen Takt (z. B. `*/20 * * * *`), den
   bestehenden Job öffnen und den Zeitplan auf `*/10 * * * *` ändern statt
   einen zweiten anzulegen.
3. Als Aktion **HTTP Request** wählen:
   - Methode: **POST**
   - Endpoint URL: `https://<deine-vercel-domain>/api/collect`
   - Timeout: der zulässige Maximalwert (z. B. 5000 ms) genügt.
   - Header: `Authorization` = `Bearer <CRON_SECRET>` (derselbe Wert wie die
     Vercel-Variable) und optional `Content-Type` = `application/json`
   - Request Body: leer lassen.
4. Speichern. Im Reiter **Runs/History** erscheint bei Erfolg „Succeeded";
   dass die Werte auch wirklich in der Tabelle landen, sieht man im
   **Table Editor → `wind_measurements`** (nach `inserted_at` absteigend
   sortieren → oben stehen die neuesten Einträge).

### Manuell testen (optional)

Auf einem Rechner mit Internetzugang lässt sich die Route direkt aufrufen:

```bash
curl -X POST https://<deine-vercel-domain>/api/collect \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Ohne oder mit falschem Token muss `401` zurückkommen, mit korrektem Token
`200` samt `{"ok":true,"saved":…}`.

## Verlaufsbalken (12h-Windverlauf beim Klick auf eine Station)

Der **Verlaufsbalken** ist das Panel, das unten über die volle
Bildschirmbreite erscheint, sobald man auf der Karte auf eine Station
klickt. Er zeigt den Windverlauf der letzten 12 Stunden dieser Station:

- eine Zeitachse in Lokalzeit mit fester Spanne von „jetzt − 12 h" bis
  „jetzt + 4 h" (gestrichelte „jetzt"-Linie nahe dem rechten Rand),
- zwei weisse Messkurven — Mittelwind (dünn) und Böen (etwas dicker) — vor
  den Farbflächen der Windstärke-Skala (dieselbe Skala wie die Windpfeile
  auf der Karte); die Fläche **zwischen** den beiden Kurven ist
  halbtransparent weiss gefüllt, damit man den Abstand zwischen Mittelwind
  und Böen auf einen Blick sieht,
- dasselbe Kurvenpaar noch einmal in **rot** für die ICON-CH1-Prognose,
  inklusive roter Fläche dazwischen,
- darunter eine Reihe Windrichtungs-Pfeile, einer je Messpunkt, jeweils in
  die Windrichtung gedreht und nach Windstärke eingefärbt,
- darunter die Messwerte als Zahlen (oben Mittelwind, unten Böe), jede Zahl
  in einem **eingefärbten Quadrat**: die Farbe entspricht der Windskala des
  jeweiligen Werts, sodass sich die Windstärke schon an der Zahlenreihe
  ablesen lässt (Zahlen zu vollen Stunden sind fett),
- darunter noch einmal die Uhrzeiten, damit man die Zahlenreihen ohne
  Blick nach ganz oben zeitlich einordnen kann,
- ganz unten die Prognosewerte (ICON-CH1) in denselben Quadraten, mit dem
  Richtungspfeil links daneben.

Das Diagramm ist breiter als der Bildschirm und lässt sich horizontal
scrollen (Desktop und Handy); beim Öffnen steht es am rechten Rand
(aktuelle Zeit), nach links scrollen zeigt die älteren Stunden. Schließen
per X-Button oder Escape-Taste.

Code: `src/components/WindHistoryPanel.tsx`. Geöffnet wird der Balken per
Klick auf einen Marker in `src/components/WindMap.tsx`; die Daten kommen
von `/api/history?station=<SCODE>`.

**Zeitfenster ändern:** Die beiden Werte stehen zentral in
`src/lib/wind.ts` (`HISTORY_HOURS = 12`, `FUTURE_MARGIN_HOURS = 4`) und
gelten für das Panel und die beiden APIs gemeinsam. Wird dort etwas
geändert, müssen `PAST_HOURS`/`FORECAST_HOURS` in der Edge Function
`supabase/functions/fetch-wind-forecasts/index.ts` mitgezogen werden (Deno
kann nicht aus `src/lib` importieren).

**Feste km/h-Skala:** Die senkrechte Achse geht immer von 0 bis 45 km/h
(`Y_MAX_KMH` in `src/components/WindHistoryPanel.tsx`) — früher wuchs sie
mit den Daten mit, wodurch ein ruhiger und ein stürmischer Tag gleich hoch
aussahen. Werte über 45 km/h werden oben gekappt: die Kurve läuft dann am
oberen Rand entlang. Die echten Zahlen stehen unverändert in den
Werte-Zeilen unter den Pfeilen, und die Pfeilfarben nutzen weiterhin die
volle Windskala.

Die Zahlen an der Achse stehen bewusst nicht in runden 10er-Schritten,
sondern genau dort, wo im Diagramm die Farbe wechselt (0 / 10 / 20 / 25 /
30, plus die Obergrenze 45 ganz oben). Sie kommen direkt aus
`WIND_COLOR_SCALE` in `src/lib/wind.ts`: Wird die Skala dort geändert,
ändert sich die Achsenbeschriftung automatisch mit.

**Farbskala:** Die Windstärke wird in klaren Farbflächen dargestellt, nicht
als weicher Verlauf: 0–10 km/h hellblau, 11–20 grün, 21–25 gelb, 26–30
orange, ab 31 rot. Dieselben Farben gelten für die Pfeile auf der Karte, die
Wert-Quadrate im Verlaufsbalken und die Flächen hinter den Kurven. Geändert
wird das an einer Stelle: `WIND_COLOR_SCALE` in `src/lib/wind.ts`.

**Hinweis zur Auflösung:** Wie fein die Kurve ist, hängt davon ab, wie oft
Messwerte gesammelt werden, also wie eng der Supabase-Cron-Job für
`/api/collect` getaktet ist (empfohlen alle 10 Minuten, siehe oben).

> **Bezugsname für Änderungswünsche: „Verlaufsbalken".** Wenn du hier etwas
> ändern möchtest, genügt z. B. „Bitte im Verlaufsbalken die … anpassen".

## Zeitbalken (Windhistorie auf der Karte)

Unter der Karte, über der Fußzeile, sitzt ein **Zeitbalken**. Schiebt man ihn
nach links, zeigen die Pfeile **aller** Stationen nicht mehr die aktuellen
Werte, sondern die aufgezeichneten Messwerte zu diesem Zeitpunkt — man kann
also durch den Windverlauf der ganzen Karte blättern und z. B. sehen, wie der
Talwind über den Vormittag aufgezogen ist.

- **Schrittweite 10 Minuten**, genau der Takt, in dem `/api/collect` die Werte
  sammelt. Ein Druck auf die Pfeiltasten links/rechts entspricht einem Schritt.
- **Zeitraum: die letzten 12 Stunden** (dieselben `HISTORY_HOURS` wie beim
  Verlaufsbalken). Weiter zurück geht es bewusst nicht, auch wenn die Datenbank
  2 Tage aufbewahrt.
- Ganz rechts steht **„jetzt"** — dort zeigt die Karte wieder die Live-Werte.
  Der Knopf **„Jetzt"** springt von überall dorthin zurück.
- Zeigt die Karte einen vergangenen Zeitpunkt, wird die Plakette unten links
  **bernsteinfarben** („Verlauf: 14:40 Uhr"), damit man das nicht verwechselt.
- Stationen, für die zu diesem Zeitpunkt keine Messung gespeichert ist,
  erscheinen als **grauer Punkt** — genauso wie eine Station, die gerade
  ausgefallen ist. Es wird nichts dazugerechnet oder geschätzt.
- Ist der Verlaufsbalken einer Station geöffnet, bleibt der Zeitbalken
  bedienbar; eine **senkrechte bernsteinfarbene Linie** im Diagramm zeigt, wo
  man gerade steht.

**Datenquelle:** `src/app/api/timeline/route.ts` (Komponente:
`src/components/TimeSlider.tsx`). Die Route liest die Tabelle
`wind_measurements` seitenweise und liefert ein kompaktes Spaltenformat — eine
gemeinsame Zeitliste und pro Station drei Zahlenreihen. Das sind rund
15–25 KB. Diese Daten werden **erst geholt, wenn der Balken das erste Mal
angefasst wird**: wer nur die Live-Karte anschaut, lädt sie gar nicht.

> **Bezugsname für Änderungswünsche: „Zeitbalken".**

## Windprognosen ICON-CH1 & ICON-D2 (Supabase Edge Function)

Die Supabase Edge Function `fetch-wind-forecasts`
(Code: `supabase/functions/fetch-wind-forecasts/index.ts`) holt stündlich
Windprognosen von [Open-Meteo](https://open-meteo.com) für alle
Stationen, die auch auf der Karte erscheinen — Bozner Stationen
(Windsensoren + Koordinaten, abgeleitet aus demselben Bozner Wetterdienst
wie `/api/wind`) **und** die Südtiroler OpenWindMap/Pioupiou-Stationen
(gleiche Bounding-Box-Filterung wie in `src/lib/pioupiou.ts`, hier in der
Edge Function dupliziert, weil Deno nichts aus `src/lib` importieren kann)
— und schreibt sie in die Tabelle `wind_forecasts` (Schema:
`supabase/forecast-schema.sql`). Details:

- **Zwei Modelle in einem Aufruf:** Der Bodenwind wird aus **ICON-CH1**
  (`model = 'icon_ch1'`, im Panel rot) und **ICON-D2**
  (`model = 'icon_d2'`) geholt — pro Stationsbatch mit einer einzigen
  Anfrage (`models=a,b`), nicht mit einer Anfrage je Modell.
  **ICON-D2 wird weiterhin gesammelt, aber nicht im Verlaufsbalken
  gezeichnet** (die Daten bleiben also für spätere Auswertungen erhalten).
- Zeitfenster: letzte 12 Stunden + kommende ~7 Stunden (gleitendes
  Fenster, deshalb läuft der Abruf stündlich, obwohl die Modelle nur alle
  paar Stunden neu rechnen). Angezeigt werden davon nur 4 Stunden Zukunft —
  der Rest ist Puffer, weil die Funktion nur einmal pro Stunde läuft;
  `/api/forecast` schneidet den Überhang beim Ausliefern ab.
- Einheiten wie in `wind_measurements`: Wind/Böen in **km/h**, Richtung in
  Grad, Prognosezeiten als UTC (`timestamptz`).
- Upsert über `station_code` + `model` + `forecast_time` — wiederholte
  Abrufe überschreiben dieselben Stunden, statt Duplikate anzulegen.
  Prognosen älter als 2 Tage werden bei jedem Lauf gelöscht.
- Stationen am/außerhalb des Modellrands liefern `null` und werden
  übersprungen (in der Antwort als `skippedNullHours` gezählt): dort werden
  einfach keine Zeilen gespeichert, im Diagramm fehlt dann die Linie — sie
  fällt nicht auf 0 km/h und es erscheint keine Fehlermeldung.
- Zugriffsschutz wie bei `/api/collect`: nur **POST** mit
  `Authorization: Bearer <service_role Key>`, sonst `401`.

**Antwort der Funktion (Erfolg):** Status `200` mit z. B.
`{ "ok": true, "models": ["icon_ch1","icon_d2"],
"stations": 89, "saved": 5000, "ch1Saved": 2500, "d2Saved": 2500,
"skippedNullHours": 0, "batchErrors": [], … }`.

> **Früher gab es hier zusätzlich eine AROME-Prognose** von GeoSphere Austria
> (`model = 'arome'`, im Verlaufsbalken gelb). Sie ist auf Wunsch wieder
> entfernt worden: Sie wird weder abgefragt noch gespeichert noch angezeigt.
> Bestehende Datenbanken haben eventuell noch alte `arome`-Zeilen; die stören
> nicht (sie laufen nach 2 Tagen von selbst ab). Wer sofort aufräumen möchte,
> führt einmalig den Inhalt von `supabase/remove-arome-forecasts.sql` im
> **SQL Editor** aus.

> **Früher gab es hier zusätzlich einen „Höhenwind"** (Wind auf einer
> Druckfläche, `model = 'icon_d2_upper'`, im Verlaufsbalken blau gestrichelt).
> Der ist wieder entfernt worden. Bestehende Datenbanken haben eventuell noch
> alte Höhenwind-Zeilen und die zwei ungenutzten Spalten `pressure_level` /
> `height_m`. Beides stört nicht (die Zeilen laufen nach 2 Tagen von selbst
> ab). Wer sofort aufräumen möchte, führt einmalig den Inhalt von
> `supabase/remove-upper-wind.sql` im **SQL Editor** aus.

### Einmalige Einrichtung

1. **Tabelle anlegen:** In Supabase links **SQL Editor** öffnen, den
   Inhalt von `supabase/forecast-schema.sql` einfügen und **Run** klicken.
2. **Edge Function deployen:** In Supabase links **Edge Functions** →
   **Deploy a new function** → **Via Editor**. Als Namen exakt
   `fetch-wind-forecasts` eintragen, den kompletten Inhalt von
   `supabase/functions/fetch-wind-forecasts/index.ts` in den Editor
   einfügen und **Deploy** klicken.
3. **JWT-Prüfung ausschalten:** Auf der Seite der neuen Funktion den
   Schalter **„Enforce JWT verification"** (je nach Dashboard-Version auch
   „Verify JWT with legacy secret") **deaktivieren** — die Funktion prüft
   den service_role Key selbst und lehnt fremde Aufrufe mit `401` ab.
   Eigene Secrets müssen **nicht** gesetzt werden (`SUPABASE_URL` und
   `SUPABASE_SERVICE_ROLE_KEY` stellt Supabase automatisch bereit).
4. **Stündlichen Abruf einrichten:** Wieder im **SQL Editor** den Inhalt
   von `supabase/forecast-cron.sql` einfügen, vorher die zwei Platzhalter
   ersetzen (Projekt-URL und service_role Key — dieselben Werte wie in den
   Vercel-Umgebungsvariablen), dann **Run** klicken. Die echten Werte
   niemals in die Datei im Repository zurückschreiben!
5. **Prüfen:** Nach dem nächsten vollen Stundenwechsel (Minute 10) im
   **Table Editor → `wind_forecasts`** nachsehen (nach `fetched_at`
   absteigend sortieren). Ob der Cron-Job lief, zeigt
   `select * from cron.job_run_details order by start_time desc limit 10;`
   im SQL Editor.

### Manuell testen (optional)

```bash
curl -X POST https://<projekt-ref>.supabase.co/functions/v1/fetch-wind-forecasts \
  -H "apikey: <SERVICE_ROLE_KEY>" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

Der `apikey`-Header ist nötig, weil der Supabase-Gateway sonst schon vor der
Funktion mit `401 "No API key found in request"` abweist; die Funktion selbst
prüft danach den `Authorization`-Bearer. Ohne/mit falschem Token muss `401`
zurückkommen, mit korrektem Token `200` samt `{"ok":true,"saved":…}`. Die Logs
der Funktion stehen im Dashboard unter
**Edge Functions → fetch-wind-forecasts → Logs**.

### Fehlersuche

Bleibt die Tabelle `wind_forecasts` leer, obwohl der Cron-Job als
„succeeded" gilt (`select * from cron.job_run_details order by start_time
desc limit 10;`)? Das heißt nur, dass die Anfrage *abgeschickt* wurde — nicht,
dass sie ankam. Die tatsächliche HTTP-Antwort des pg_net-Aufrufs zeigen:

```sql
select id, status_code, content, created
from net._http_response order by created desc limit 5;
```

Zwei Ursachen, die hier bereits aufgetreten sind:

- **`404` / `{"code":"PGRST125", … "Invalid path specified in request URL"}`**
  — die im Vault gespeicherte `project_url` ist falsch. Sie muss die *reine*
  Basis-URL sein (`https://<projekt-ref>.supabase.co`), **ohne** `/rest/v1/`
  und **ohne** Schrägstrich am Ende; sonst entsteht `…/rest/v1//functions/v1/…`
  und die Anfrage landet beim Datenbank-Teil (PostgREST) statt bei der
  Funktion. Prüfen mit `select decrypted_secret from vault.decrypted_secrets
  where name = 'project_url';`, korrigieren mit `select vault.update_secret(
  (select id from vault.secrets where name = 'project_url'),
  'https://<projekt-ref>.supabase.co', 'project_url');`.
- **`401` / `{"message":"No API key found in request"}`** — dem Cron-Job fehlt
  der `apikey`-Header. Achtung: Ein bereits angelegter Cron-Job wird **nicht**
  automatisch aktualisiert, wenn `supabase/forecast-cron.sql` später geändert
  wird; die Datei dann erneut im SQL-Editor ausführen (`cron.schedule` mit
  gleichem Job-Namen überschreibt den alten Eintrag) und mit `select jobid,
  jobname, command from cron.job;` kontrollieren, dass die `apikey`-Zeile in
  der Spalte `command` steht.

Für lokale Tests ohne echte Dienste lassen sich beide Quellen per
Umgebungsvariable auf einen Mock-Server umbiegen (`WIND_API_BASE_URL`,
`OPEN_METEO_BASE_URL`).

## OpenWindMap/Pioupiou-Stationen

Zusätzlich zu den Bozner Stationen zeigt die Karte Südtiroler Stationen aus
dem **OpenWindMap/Pioupiou-Netzwerk** (batteriebetriebene, private
Windsensoren, vor allem an Startplätzen für Gleitschirmflieger). Code:
`src/lib/pioupiou.ts` (genutzt von `/api/wind` und `/api/collect`), in der
Edge Function `fetch-wind-forecasts` aus Deno-Gründen separat dupliziert
(siehe oben).

- **Endpunkt:** `https://api.pioupiou.fr/v1/live/all` liefert ALLE
  Stationen weltweit ohne Regionsfilter. Südtirol wird über eine grobe
  Bounding Box herausgefiltert (Breite 46.2–47.1, Länge 10.3–12.5,
  `SOUTH_TYROL_BBOX` in `src/lib/pioupiou.ts` — bei Bedarf dort
  nachjustieren).
- **Stationscodes:** `pioupiou-<ID>` (z. B. `pioupiou-413`), damit sie
  nicht mit den Bozner SCODEs kollidieren.
- **Stationshöhe aus dem Namen:** Die Pioupiou-API liefert keine
  Höhenangabe (der Bozner Dienst hat dafür das Feld `ALT`). Die Betreiber
  schreiben die Höhe aber meist in den Stationsnamen, deshalb liest
  `parseAltitudeFromName()` in `src/lib/pioupiou.ts` sie dort heraus —
  erkannt werden z. B. „2275m", „2.275 m", „1200 mt", „1900 m ü. M.".
  Ohne das fielen die Pioupiou-Stationen aus jedem Höhenfilter der Karte
  heraus. **Nur mit Einheit:** eine blanke Zahl im Namen gilt nicht als
  Höhe, sonst würde „Meran 2000" (Ortsname) oder „Pioupiou 1234"
  (Ersatzname ohne hinterlegten Stationsnamen) falsch gelesen. Zusätzlich
  muss der Wert zwischen 100 m und 4.000 m liegen. Der angezeigte Name
  bleibt unverändert, die Höhe wird also nicht herausgeschnitten.
- **Einheit:** Intern gilt für alle Quellen einheitlich **km/h** (wie bei
  den Bozner Stationen). Laut Pioupiou-API-Dokumentation liefert die API
  `wind_speed_avg`/`wind_speed_max` bereits in km/h, es findet also keine
  Umrechnung statt — die Stelle dafür (`toKmh()` in `src/lib/pioupiou.ts`)
  ist trotzdem vorbereitet, falls sich das mit echten Live-Daten als falsch
  herausstellen sollte (in dieser Sandbox war der Pioupiou-Dienst durch die
  Netzwerk-Richtlinie nicht erreichbar, die Werte ließen sich hier also
  nicht an echten Daten gegenprüfen — nach dem Deployment einmal die
  angezeigten Werte an einem bekannten Tag plausibilisieren).
- **Veraltete Werte:** Pioupiou-Stationen melden nicht durchgehend
  (nachts/windstill teils gar nicht). Es gilt dieselbe Regel wie bei Bozen:
  fehlt Richtung/Geschwindigkeit oder ist die letzte Messung älter als 2
  Stunden, erscheint die Station als grauer Punkt statt als Windpfeil.
- **Ausfallsicher:** Schlägt der Abruf fehl (Dienst nicht erreichbar),
  zeigen `/api/wind`, `/api/collect` und die Prognose-Edge-Function
  trotzdem weiterhin die Bozner Stationen — die OpenWindMap-Stationen
  fallen für diesen einen Durchlauf einfach weg, statt alles zu blockieren.
- **Herkunft:** In `wind_measurements` markiert die Spalte `source`
  (`bolzano`/`openwindmap`), woher eine Zeile stammt. Im Verlaufsbalken
  steht unten außerdem ein direkter „Quelle:"-Link zur jeweiligen Station.
- **Mock-Server für lokale Tests:** `PIOUPIOU_API_BASE_URL` überschreibt
  den Endpunkt, analog zu `WIND_API_BASE_URL`/`OPEN_METEO_BASE_URL`.

**Pflicht-Lizenzhinweis (offener Punkt):** Die OpenWindMap-Daten stehen
unter der kostenlosen Community-Lizenz, die einen sichtbaren Credit mit
Link verlangt. Dieser stand bis Aug. 2026 in der Fußzeile jeder Seite
(`src/app/page.tsx`): „Winddaten © contributors of the OpenWindMap wind
network, [openwindmap.org](https://openwindmap.org)". Die Fußzeile wurde
auf Wunsch des Projektbesitzers entfernt; die Quellenangabe für die
Winddaten soll später in anderer Form gelöst werden. Bis dahin gibt es
den Hinweis nur noch stationsweise als „Quelle:"-Link unten im
Verlaufsbalken.

## Hinweis zur Sandbox-Umgebung

Innerhalb dieser Cloud-Sandbox sind sowohl der Wetterdienst der Provinz
Bozen als auch die OpenStreetMap-Kartenkacheln und die Pioupiou-API
(`api.pioupiou.fr`) durch die Netzwerk-Richtlinie der Umgebung blockiert
(nur eine begrenzte Liste an Hosts ist erlaubt). Lokal auf dem eigenen
Rechner oder nach einem Deployment (z. B. auf Vercel) sind alle drei
öffentlich frei erreichbar.
