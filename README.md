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

## Wind-Historie (Supabase)

### Wie die Daten gesammelt werden

Die Sammel-Route `src/app/api/collect/route.ts` (Aufruf per **POST** unter
`/api/collect`) fragt denselben Wetterdienst wie `/api/wind` ab und schreibt
die aktuellen Windwerte aller Stationen in die Supabase-Tabelle
`wind_measurements` (Schema: `supabase/schema.sql`, einmalig im Supabase
SQL-Editor ausführen). Bereits vorhandene Messungen werden dabei nicht
doppelt angelegt (Upsert über `station_code` + `measured_at`), und Einträge
älter als 7 Tage werden bei jedem Lauf gelöscht.

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
2. Zeitplan wählen, z. B. alle 5 oder 10 Minuten (`*/5 * * * *` bzw.
   `*/10 * * * *`) — je enger, desto feiner die spätere Historie.
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
`/api/collect` getaktet ist (empfohlen z. B. alle 10 Minuten).

> **Bezugsname für Änderungswünsche: „Verlaufsbalken".** Wenn du hier etwas
> ändern möchtest, genügt z. B. „Bitte im Verlaufsbalken die … anpassen".

## Windprognosen ICON-CH1 (Supabase Edge Function)

Die Supabase Edge Function `fetch-wind-forecasts`
(Code: `supabase/functions/fetch-wind-forecasts/index.ts`) holt stündlich
ICON-CH1-Windprognosen von [Open-Meteo](https://open-meteo.com) für alle
Stationen, die auch auf der Karte erscheinen (Windsensoren + Koordinaten,
abgeleitet aus demselben Bozner Wetterdienst wie `/api/wind`), und schreibt
sie in die Tabelle `wind_forecasts` (Schema:
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

Für lokale Tests ohne echte Dienste lassen sich beide Quellen per
Umgebungsvariable auf einen Mock-Server umbiegen (`WIND_API_BASE_URL`,
`OPEN_METEO_BASE_URL`).

### Stolpersteine bei der Ersteinrichtung (aus der Praxis)

- **Zwei Schlüssel-Systeme in Supabase:** Neuere Projekte zeigen unter
  **Project Settings → API Keys** zuerst die *neuen* Schlüssel
  (`sb_publishable_…` / `sb_secret_…`). Die Edge Function bekommt von
  Supabase aber automatisch den **alten** Schlüssel eingesetzt — den
  findet man erst im Reiter **„Legacy anon, service_role API keys"**,
  Zeile **`service_role`** (beginnt mit `eyJ…`). Für den Cron-Aufruf und
  jeden manuellen Test **immer diesen legacy `service_role`-Schlüssel**
  verwenden, sonst antwortet die Funktion mit `401`.
- **`apikey`-Header nicht vergessen:** Der Supabase-Gateway vor der
  Funktion verlangt zusätzlich zum `Authorization`-Header einen
  `apikey`-Header (sonst `401 "No API key found in request"`, noch bevor
  die Funktion überhaupt läuft) — siehe Beispiel oben.
- **Richtige URL:** `/functions/v1/fetch-wind-forecasts` ruft die
  Funktion auf; `/rest/v1/wind_forecasts` spricht direkt die Tabelle an
  (kein Funktionsaufruf, führt bestenfalls zu einem Datenbankfehler).

**Testlauf vom 14.07.2026:** Aufruf über `net.http_post` im SQL Editor
ergab `200` mit `{"ok":true,"saved":84,"cleanupBefore":"…","cleanupOk":true}`
— die Kette Funktion → Open-Meteo → Supabase funktioniert grundsätzlich.
**Offen:** `saved: 84` wirkt niedrig für die Gesamtzahl der Windstationen
(84 = z. B. nur 3 Stationen × 28 Stunden) und die Antwort enthielt nicht
die erwarteten Zusatzfelder `model`/`skippedNullHours` — das deutet auf
eine ältere/vereinfachte Version der Funktion im Supabase-Dashboard hin,
nicht auf ein Problem im Code hier im Repository. Vor dem produktiven
Einsatz prüfen mit:

```sql
select model, count(*) as zeilen, count(distinct station_code) as stationen,
       min(forecast_time) as fruehester, max(forecast_time) as spaetester
from wind_forecasts group by model;
```

Erwartet: `stationen` in der Größenordnung aller Windstationen (siehe
Anzahl der Marker auf der Karte), Zeitspanne von ca. „jetzt − 24h" bis
„jetzt + 3h". Falls die Zahlen deutlich abweichen: im Supabase-Dashboard
unter **Edge Functions → fetch-wind-forecasts** den Funktionscode mit
`supabase/functions/fetch-wind-forecasts/index.ts` aus diesem Repository
vergleichen/neu deployen.

## Hinweis zur Sandbox-Umgebung

Innerhalb dieser Cloud-Sandbox sind sowohl der Wetterdienst der Provinz
Bozen als auch die OpenStreetMap-Kartenkacheln durch die
Netzwerk-Richtlinie der Umgebung blockiert (nur eine begrenzte Liste an
Hosts ist erlaubt). Lokal auf dem eigenen Rechner oder nach einem
Deployment (z. B. auf Vercel) sind beide öffentlich frei erreichbar.
