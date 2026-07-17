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

Praktische Folgen:

- Angezeigte Werte können bis zu ~1–2 Minuten „alt" sein — bei
  Messintervallen von 5–10 Minuten ist das ohne Bedeutung.
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
`measured_at`), und Einträge älter als 7 Tage werden bei jedem Lauf
gelöscht.

**Wenn `wind_measurements` schon vor dieser Änderung angelegt wurde:**
einmalig `supabase/add-source-column.sql` im Supabase SQL-Editor ausführen
(ergänzt nur die neue Spalte `source`, ohne bestehende Daten zu löschen —
bei einer komplett neuen Installation über `schema.sql` ist das nicht
nötig, die Spalte ist dort schon enthalten).

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
letzten 48 Stunden einer Station (für den Verlaufsbalken).

### Benötigte Zugangsdaten

Niemals in den Code schreiben! Alle als **Environment Variables in Vercel**
(Settings → Environment Variables), danach einmal **neu deployen**:

| Variable | Wert | Wofür |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL des Supabase-Projekts | `/api/collect` und `/api/history` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role Key des Supabase-Projekts | `/api/collect` und `/api/history` |
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

## Verlaufsbalken (48h-Windverlauf beim Klick auf eine Station)

Der **Verlaufsbalken** ist das Panel, das unten über die volle
Bildschirmbreite erscheint, sobald man auf der Karte auf eine Station
klickt. Er zeigt den Windverlauf der letzten 48 Stunden dieser Station:

- eine Zeitachse in Lokalzeit mit fester Spanne von „jetzt − 48 h" bis
  „jetzt + 3 h" (gestrichelte „jetzt"-Linie nahe dem rechten Rand),
- zwei Kurven — Mittelwind (dünn) und Böen (dick) — vor den Farbbändern
  der Windstärke-Skala (dieselbe Skala wie die Windpfeile auf der Karte),
- darunter eine Reihe Windrichtungs-Pfeile, einer je Messpunkt, jeweils in
  die Windrichtung gedreht und nach Windstärke eingefärbt.

Das Diagramm ist breiter als der Bildschirm und lässt sich horizontal
scrollen (Desktop und Handy); beim Öffnen steht es am rechten Rand
(aktuelle Zeit), nach links scrollen zeigt die älteren Stunden. Schließen
per X-Button oder Escape-Taste.

Code: `src/components/WindHistoryPanel.tsx`. Geöffnet wird der Balken per
Klick auf einen Marker in `src/components/WindMap.tsx`; die Daten kommen
von `/api/history?station=<SCODE>`.

**Hinweis zur Auflösung:** Wie fein die Kurve ist, hängt davon ab, wie oft
Messwerte gesammelt werden, also wie eng der Supabase-Cron-Job für
`/api/collect` getaktet ist (empfohlen alle 10 Minuten, siehe oben).

> **Bezugsname für Änderungswünsche: „Verlaufsbalken".** Wenn du hier etwas
> ändern möchtest, genügt z. B. „Bitte im Verlaufsbalken die … anpassen".

## Windprognosen ICON-CH1 (Supabase Edge Function)

Die Supabase Edge Function `fetch-wind-forecasts`
(Code: `supabase/functions/fetch-wind-forecasts/index.ts`) holt stündlich
ICON-CH1-Windprognosen von [Open-Meteo](https://open-meteo.com) für alle
Stationen, die auch auf der Karte erscheinen — Bozner Stationen
(Windsensoren + Koordinaten, abgeleitet aus demselben Bozner Wetterdienst
wie `/api/wind`) **und** die Südtiroler OpenWindMap/Pioupiou-Stationen
(gleiche Bounding-Box-Filterung wie in `src/lib/pioupiou.ts`, hier in der
Edge Function dupliziert, weil Deno nichts aus `src/lib` importieren kann)
— und schreibt sie in die Tabelle `wind_forecasts` (Schema:
`supabase/forecast-schema.sql`). Details:

- Zeitfenster: letzte 24 Stunden + kommende ~3 Stunden (gleitendes
  Fenster, deshalb läuft der Abruf stündlich, obwohl das Modell nur alle
  3 Stunden neu rechnet).
- Einheiten wie in `wind_measurements`: Wind/Böen in **km/h**, Richtung in
  Grad, Prognosezeiten als UTC (`timestamptz`).
- Die Spalte `model` (aktuell immer `'icon_ch1'`) macht die Tabelle
  erweiterbar: ICON-D2 kommt später einfach als zusätzliche Zeilen dazu.
- Upsert über `station_code` + `model` + `forecast_time` — wiederholte
  Abrufe überschreiben dieselben Stunden, statt Duplikate anzulegen.
  Prognosen älter als 7 Tage werden bei jedem Lauf gelöscht.
- Stationen am/außerhalb des Modellrands liefern `null` und werden
  übersprungen (in der Antwort als `skippedNullHours` gezählt).
- Zugriffsschutz wie bei `/api/collect`: nur **POST** mit
  `Authorization: Bearer <service_role Key>`, sonst `401`.

**Antwort der Funktion (Erfolg):** Status `200` mit z. B.
`{ "ok": true, "model": "icon_ch1", "stations": 120, "saved": 3300,
"skippedNullHours": 0, "batchErrors": [], … }`.

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

**Pflicht-Lizenzhinweis:** Die OpenWindMap-Daten stehen unter der
kostenlosen Community-Lizenz, die einen sichtbaren Credit mit Link
verlangt. Dieser steht in der Fußzeile jeder Seite (`src/app/page.tsx`):
„Winddaten © contributors of the OpenWindMap wind network,
[openwindmap.org](https://openwindmap.org)". Dieser Hinweis darf nicht
entfernt werden, solange OpenWindMap-Daten angezeigt werden.

## Hinweis zur Sandbox-Umgebung

Innerhalb dieser Cloud-Sandbox sind sowohl der Wetterdienst der Provinz
Bozen als auch die OpenStreetMap-Kartenkacheln und die Pioupiou-API
(`api.pioupiou.fr`) durch die Netzwerk-Richtlinie der Umgebung blockiert
(nur eine begrenzte Liste an Hosts ist erlaubt). Lokal auf dem eigenen
Rechner oder nach einem Deployment (z. B. auf Vercel) sind alle drei
öffentlich frei erreichbar.
