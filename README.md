# SISOSIG – Live-Wind in den Alpen

Eine Website (und Web-App) für Gleitschirmflieger, die Live-Windwerte von
Wetterstationen im Alpenraum auf einer Karte anzeigt (Leaflet + OpenTopoMap):
Südtirol (Wetterdienst und OpenWindMap), Schweiz (SLF, MeteoSchweiz),
Österreich (GeoSphere, LWD Tirol) und die Zugspitze (DWD) — mit
12-Stunden-Verlauf, Prognose und Flugmodus.

## Lokal starten

```bash
npm install
npm run dev
```

Danach im Browser [http://localhost:3000](http://localhost:3000) öffnen.

## Wie die Winddaten geladen werden

Die Winddaten kommen vom offenen Datenportal der Provinz Bozen
([data.civis.bz.it](https://data.civis.bz.it/de/dataset/misure-meteo-e-idrografiche)),
über den Webservice unter `geoservices.buergernetz.bz.it/services/meteo/v1`
(bis Sept. 2026 `daten.buergernetz.bz.it` — die alte Adresse antwortet nur
noch mit `404`; zeigt die Karte dauerhaft „Wetterdienst Südtirol liefert
gerade keine Daten", zuerst auf der Datensatz-Seite nachsehen, ob die Adresse
wieder umgezogen ist — die Adresse steht in `src/lib/bolzano.ts` und in der
Edge Function):

- `/sensors` liefert die aktuellen Messwerte aller Stationen.
- `/stations` liefert Name und Koordinaten der Stationen.

**Ein Sammler, eine Wahrheit (seit Nov. 2026):** Mit den Wetterdiensten
spricht nur noch der Sammler `src/app/api/collect/route.ts` (alle 5 Minuten,
siehe „Wind-Historie" unten; Liste aller Quellen in `src/lib/sources.ts`). Er
speichert Messwerte, Stationsliste und den Zustand jeder Quelle in Supabase.
Die Karte holt ihre Werte über `src/app/api/wind/route.ts` aus der
Datenbank — in einer einzigen Anfrage (Funktion `wind_latest`, ~0,1 s). Karte,
Zeitbalken und Verlaufsbalken zeigen dadurch immer denselben Stand. Preis:
Ein neuer Messwert erscheint im Schnitt 2–3 Minuten später als vorher (höchstens
5), weil er erst beim nächsten Sammel-Lauf ankommt.

`/api/wind` gibt alle Stationen als JSON-Liste zurück: Richtung, Mittelwind
und Böe (in km/h) sowie ein `stale`-Flag für Stationen, deren Messwerte
fehlen oder zu alt sind — diese erscheinen auf der Karte als grauer Ring
statt als Windpfeil.

**Notbetrieb:** Antwortet die Datenbank nicht (5 s Zeitlimit) oder hat der
Sammler seit 15 Minuten nichts eingetragen, holt `/api/wind` die Werte wie
früher selbst bei allen Quellen. Die Karte bleibt so auch dann benutzbar; zur
Fehlersuche steht dann in der Antwort die Kopfzeile `x-sisosig-notbetrieb`.

**Wann eine Station grau wird (seit Okt. 2026):** grundsätzlich, wenn ihr
neuester Wert älter als **30 Minuten** ist (vorher 2 Stunden). Quellen, die
ihre Werte schon im Normalbetrieb später oder seltener liefern, bekommen
mehr Zeit, sonst würden sie vor jedem neuen Wert kurz grau: Bozen 35,
MeteoSchweiz 40, LWD Tirol 50, SLF 55 und DWD (Zugspitze) 75 Minuten.
Einstellbar an einer Stelle: `STALE_AFTER_MINUTES` in `src/lib/wind.ts`.

**Wenn eine Quelle ausfällt:** Der Sammler fragt alle Quellen (auch Bozen)
gleichzeitig ab, jede mit Zeitlimit (8 s), und trägt je Quelle ein, ob es
geklappt hat (Tabelle `wind_status`). Scheitert eine oder liefert sie keine
einzige Station, bleiben ihre Stationen mit dem letzten Wert stehen (nach der
Grau-Grenze grau), und oben erscheint der gelbe Hinweis „… liefert gerade
keine Daten" (im Flugmodus in der Statuszeile). Bis Okt. 2026 war bei einem
Ausfall des Bozner Dienstes die ganze Karte leer.

Bestimmte Stationen lassen sich über `/api/wind?station=<SCODE1>,<SCODE2>`
filtern. Die Stationscodes findet man in der Antwort von
`/services/meteo/v1/stations`.

Zusätzlich kommen über `src/lib/pioupiou.ts` die Stationen des
**OpenWindMap/Pioupiou-Netzwerks** im Alpenraum dazu (Endpunkt
`https://api.pioupiou.fr/v1/live/all`, gefiltert über die Alpen-Regel, da
die API keinen Regionsfilter kennt) und zeigt sie
genau wie die Bozner Stationen auf der Karte an — Pfeil, Farbskala,
Klick-Historie, alles identisch. Ihre Stationscodes haben das Format
`pioupiou-<ID>` (z. B. `pioupiou-413`), damit sie nicht mit den Bozner
SCODEs kollidieren. Schlägt der Abruf fehl, zeigt die Karte trotzdem die
übrigen Stationen (additiv, kein Blocker). Details zu Lizenz und Einheiten
siehe unten unter „OpenWindMap/Pioupiou-Stationen".

Ebenso kommen über `src/lib/slf.ts` die **Schweizer IMIS-Stationen des
SLF** dazu (dieselben wie auf whiterisk.ch, Codes `slf-<CODE>`, z. B.
`slf-ZNZ1`) — siehe unten unter „SLF-IMIS-Stationen (Schweiz)".

### Zwischenspeicherung (Caching)

Die Stationen messen nur alle 5–10 Minuten, und die Karte liest seit Nov. 2026
ohnehin nur noch aus der Datenbank. Die **fertige JSON-Antwort** von
`/api/wind` wird über den `Cache-Control`-Header (`s-maxage=60`) 60 Sekunden
vom Vercel-CDN geteilt: Rufen mehrere Besucher die Seite gleichzeitig auf,
bekommen alle dieselbe Antwort, ohne dass der Server die Daten mehrfach
zusammenbaut. Fehlerantworten werden bewusst **nicht** gecacht, damit sich
ein kurzer Ausfall nicht festsetzt.

Die einzelnen Quellen (in `src/lib/`) halten ihre Messwerte zusätzlich kurz
im Speicher (1–2 Minuten, `src/lib/freshCache.ts`; Stationslisten 6 Stunden).
Das braucht heute vor allem der Notbetrieb von `/api/wind`; der Sammler läuft
nur alle 5 Minuten und bekommt so immer frische Werte.

**Früher anfordern (Punkt 8, Nov. 2026):** Die Seite startet die Anfrage
`/api/wind` schon beim Öffnen, mit einer kleinen Zeile im `<head>`
(`src/lib/earlyWind.ts`), statt erst, wenn das Kartenprogramm geladen ist.
Gemessen bei gedrosseltem Handy-Netz: Die Anfrage startet nach ~0,4 s statt
nach ~2 s, die Pfeile stehen 0,2–0,5 s früher.

Nach demselben Muster arbeiten auch die beiden Verlaufsbalken-Routen:
`/api/history` wird 60 Sekunden vom CDN geteilt (neue Messwerte kommen nur
alle 10 Minuten dazu, so oft messen die Stationen), `/api/forecast` 120
Sekunden (die Prognose wird nur
alle 3 Stunden neu geholt). Klickt man auf der Karte zwischen zwei Stationen hin
und her, kommt die Antwort dadurch direkt aus dem Zwischenspeicher statt
jedes Mal aus der Datenbank.

**Server-Standort:** Die Server-Teile der Seite (alle `/api/…`-Routen) laufen
seit Okt. 2026 in **Dublin**, im selben Rechenzentrum wie die Datenbank
(`vercel.json`, `"regions": ["dub1"]`; diese Datei hat Vorrang vor der
Einstellung im Vercel-Dashboard). Vorher liefen sie im Vercel-Standard
Washington/USA, und jede Abfrage ging über den Atlantik.

Praktische Folgen:

- Ein neuer Messwert ist nach dem Erscheinen beim Wetterdienst spätestens
  nach ~6 Minuten auf der Karte (bis zu 5 Minuten bis zum nächsten
  Sammel-Lauf, bis zu 1 Minute CDN) — bei Messintervallen von 10 Minuten
  vertretbar.
- Die Karte fragt im Hintergrund alle **3 Minuten** neue Werte ab
  (`POLL_INTERVAL_MS` in `src/components/WindMap.tsx`) und im Hintergrund
  laufender Tabs gar nicht. Kehrt man zur Seite zurück, wird sofort
  aktualisiert — der Takt macht die Anzeige also nicht träger, spart auf
  dem Handy aber deutlich Datenvolumen.
- Die Sammel-Route `/api/collect` (läuft alle 5 Minuten) ist davon
  nicht betroffen: gespeichert wird immer der Mess-Zeitstempel der
  Station, Duplikate fängt der Upsert in Supabase ab.
- Beim lokalen Entwickeln: ein „harter" Browser-Reload
  (Strg+Shift+R bzw. Cmd+Shift+R) umgeht den Cache, falls man beim
  Testen wirklich frische Daten sehen will.

## Wind-Historie (Supabase)

### Wie die Daten gesammelt werden

Die Sammel-Route `src/app/api/collect/route.ts` (Aufruf per **POST** unter
`/api/collect`) fragt alle Quellen ab (Liste in `src/lib/sources.ts`, eine
neue Quelle ist dort ein einziger Eintrag) und schreibt die aktuellen
Windwerte aller Stationen in die Supabase-Tabelle `wind_measurements`
(Schema: `supabase/schema.sql`, einmalig im Supabase SQL-Editor ausführen).
Sie ist seit Nov. 2026 die **einzige** Stelle, die mit den Wetterdiensten
spricht (siehe „Ein Sammler, eine Wahrheit" oben). Jede Zeile trägt in der
Spalte `source` die Herkunft (`bolzano`, `openwindmap`, `slf`, …). Bereits vorhandene
Messungen werden dabei nicht doppelt angelegt (Upsert über `station_code` +
`measured_at`), und Einträge älter als 3 Tage werden bei jedem Lauf
gelöscht (die Anzeige braucht 48 Stunden, der Rest ist Puffer).

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

**Aufräumen (Okt. 2026), ebenfalls einmalig bei einer bestehenden
Datenbank:** `supabase/datenbank-aufraeumen.sql` auf dieselbe Weise ausführen.
Es entfernt zwei doppelte Suchhilfen (Indizes), legt eine fehlende für die
Prognose-Funktion an und richtet einen täglichen Job ein, der das Protokoll
der Zeitplan-Jobs auf 7 Tage kürzt. Messwerte und Prognosen bleiben
unberührt.

**Stationsliste (Okt. 2026), ebenfalls einmalig bei einer bestehenden
Datenbank:** `supabase/stationsliste.sql` auf dieselbe Weise ausführen. Es
legt nur die Tabelle `wind_stations` (Name, Lage, Höhe jeder Station) und die
Sicht `wind_stations_latest` (neuester gespeicherter Wert je Station) an;
gelöscht oder verändert wird nichts. Die Liste füllt der Sammler beim
nächsten Lauf. Wozu: Liefert eine Quelle gar nichts, zeigt die Karte deren
Stationen mit dem letzten gespeicherten Wert weiter (nach der Grau-Grenze
grau), statt sie auszublenden (`src/lib/stationList.ts`). Aus derselben Liste
nimmt die Prognose-Funktion seit Nov. 2026 ihre Stationen.

**Ein Sammler, eine Wahrheit (Nov. 2026), ebenfalls einmalig bei einer
bestehenden Datenbank:** `supabase/ein-sammler.sql` auf dieselbe Weise
ausführen (in der Datenbank des Projekts schon geschehen). Es legt die
Tabelle `wind_status` (Zustand jeder Quelle und der Prognose-Funktion) und
die Funktion `wind_latest` (alle aktuellen Werte für die Karte in einer
Antwort) an und ergänzt die Sicht `wind_stations_latest` um eine Spalte;
gelöscht oder verändert wird nichts. Fehlt es, läuft die Karte im Notbetrieb
(siehe oben), und der Sammler meldet `"sourceStatusOk": false`.

Angestoßen wird die Route von **Supabase Cron** (früher lief das über einen
GitHub-Actions-Workflow; der ist entfernt, damit nicht doppelt geschrieben
wird). Jeder Aufruf muss den Header `Authorization: Bearer <CRON_SECRET>`
mitschicken.

Alle Quellen werden gleichzeitig abgefragt, jede mit Zeitlimit, und jede
speichert für sich (seit Nov. 2026; vorher ein gemeinsamer Schreibvorgang, den
ein einziger abgelehnter Wert ganz verworfen hätte). Scheitert eine (seit
Okt. 2026 auch der Bozner Dienst), werden die übrigen trotzdem gespeichert.
SLF und DWD liefern ihren Verlauf mit — von ihnen speichert jeder
Lauf die letzten 3 Stunden, sodass sich Lücken von selbst füllen. Werte, die
älter als eine Stunde sind, werden dabei nur noch ergänzt, nicht neu
geschrieben. Nach jedem Lauf trägt der Sammler den Zustand jeder Quelle in
`wind_status` ein (geklappt, Zahl der Werte, Fehlermeldung, seit wann es
zuletzt geklappt hat).

**Antwort der Route:**

- **Erfolg:** Status `200` mit JSON, z. B.
  `{ "ok": true, "saved": 1661, "sources": { "bolzano": 82, "slf": 1196, … },
  "failedSources": ["lwdtirol"], "errors": { "lwdtirol": "Keine Stationen erhalten" },
  "stationListOk": true, "sourceStatusOk": true, "cleanupBefore": "…", "cleanupOk": true }`
  (`saved` = Anzahl gespeicherter Werte, `sources` = Werte je Quelle,
  `failedSources`/`errors` = Quellen, die diesmal gescheitert sind, mit Grund,
  `stationListOk` = Stationsliste gespeichert, `sourceStatusOk` = Zustand der
  Quellen gespeichert).
- **Falsches/fehlendes Token:** Status `401` (`{ "error": "Nicht autorisiert" }`).
- **Fehlende Server-Variablen:** Status `500`.
- **Keine einzige Quelle konnte gespeichert werden:** Status `502`.

Achtung: Im Protokoll der Zeitplan-Jobs (`cron.job_run_details`) steht bei
jedem Lauf „succeeded" — das heißt nur „Anfrage abgeschickt". Die echte
Antwort (siehe oben) steht 6 Stunden lang in `net._http_response`.

`/api/history?station=<SCODE>` liefert die so gesammelten Messwerte der
letzten 48 Stunden einer Station (für den Verlaufsbalken).
`/api/timeline` liefert dieselben 48 Stunden für **alle** Stationen
gemeinsam (für den Zeitbalken unter der Karte, siehe unten);
`/api/timeline?hours=8` nur die letzten 8 Stunden (zum Auffrischen und für
den Flugmodus).

### Benötigte Zugangsdaten

Niemals in den Code schreiben! Alle als **Environment Variables in Vercel**
(Settings → Environment Variables), danach einmal **neu deployen**:

| Variable | Wert | Wofür |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL des Supabase-Projekts | `/api/collect`, `/api/wind`, `/api/history`, `/api/forecast` und `/api/timeline` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role Key des Supabase-Projekts | `/api/collect`, `/api/wind`, `/api/history`, `/api/forecast` und `/api/timeline` |
| `CRON_SECRET` | selbst gewähltes, langes Geheimnis | schützt `/api/collect` vor fremden Aufrufen |

Der Wert von `CRON_SECRET` in Vercel wird **ohne** `Bearer ` eingetragen; im
Zeitplan-Job wird `Bearer ` davorgesetzt.

### Supabase Cron einrichten

Der Zeitplan-Job heißt `collect-data` und läuft **alle 5 Minuten**
(`*/5 * * * *`). Sein Geheimnis (`CRON_SECRET`) liegt seit Okt. 2026 im
Supabase-Tresor (Vault) statt im Klartext im Job — genauso wie beim
Prognose-Job.

- **Neue Installation:** Im **SQL Editor** den Inhalt von
  `supabase/collect-cron.sql` einfügen, vorher den Platzhalter
  `DEIN_CRON_SECRET` durch denselben Wert wie in Vercel ersetzen (und ggf. die
  Adresse der Seite), dann **Run**. Die echten Werte niemals in die Datei im
  Repository zurückschreiben!
- **Bestehende Datenbank mit Klartext im Job:** den Inhalt von
  `supabase/collect-cron-tresor.sql` ausführen. Es übernimmt das Geheimnis
  direkt aus dem bisherigen Job in den Tresor — eintippen muss man nichts.
- **Kontrolle** nach ein paar Minuten:
  `select status_code, left(content::text, 300), created from net._http_response order by created desc limit 5;`
  — Status `200` und `"ok":true` heißt: läuft. Zusätzlich sieht man im
  **Table Editor → `wind_measurements`** (nach `inserted_at` absteigend
  sortiert) die neuesten Einträge.

**Warum 5 Minuten, obwohl die Stationen nur alle 10 Minuten messen?**
Der Bozner Dienst zeigt unter `/sensors` immer nur den **neuesten** Wert
und veröffentlicht ihn erst 5–10 Minuten nach der Messung. Jeder Wert ist
also rund 10 Minuten lang abrufbar. Mit einem 5-Minuten-Takt erwischt ihn
garantiert mindestens ein Abruf; bei 10 Minuten wäre es Glückssache.
Mehr Zeilen entstehen dadurch **nicht** — doppelt abgeholte Werte
verwirft die Datenbank (Upsert). Noch häufiger abzufragen bringt dagegen
nichts.

**Zeitlimit des Jobs: 30000 ms.** Mit nur 5000 ms meldet
`net._http_response` „Timeout" statt der echten Antwort, und echte Fehler
(z. B. `502`) bleiben unsichtbar.

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
  „jetzt + 4 h" (gestrichelte „jetzt"-Linie nahe dem rechten Rand),
- zwei schwarze Messkurven — Mittelwind (dünn) und Böen (etwas dicker) — vor
  den Farbflächen der Windstärke-Skala (dieselbe Skala wie die Windpfeile
  auf der Karte); die Fläche **zwischen** den beiden Kurven ist
  halbtransparent gefüllt, damit man den Abstand zwischen Mittelwind und
  Böen auf einen Blick sieht,
- dasselbe Kurvenpaar für die ICON-CH1-Prognose in **Dunkelgrau,
  gestrichelt**, mit blasserer Fläche dazwischen; rechts im Prognosebereich
  stehen „Prognose ICON-CH1" und die Startzeit des Modelllaufs
  („Lauf HH:MM Uhr"),
- die Windrichtung der Prognose als Pfeilreihe **oben im Diagramm** (je
  Stunde ein Pfeil),
- bei Rittnerhorn und Leiterspitz zusätzlich der **Höhenwind** (ICON-D2,
  700 hPa, ca. 3000 m) als blaue gestrichelte Linie,
- unter dem Diagramm eine Reihe Windrichtungs-Pfeile der Messung, jeweils in
  die Windrichtung gedreht und nach Windstärke eingefärbt,
- darunter die Messwerte als Zahlen (oben Mittelwind, unten Böe), jede Zahl
  in einem **eingefärbten Quadrat**: die Farbe entspricht der Windskala des
  jeweiligen Werts, sodass sich die Windstärke schon an der Zahlenreihe
  ablesen lässt (Zahlen zu vollen Stunden sind fett),
- ganz unten die Datenquelle der Station als Link („Quelle: …").

Liefert die Station auffällige Werte, steht über dem Diagramm der Hinweis
„Wahrscheinlich Messfehler: …" (Regeln in `src/lib/plausibility.ts`).

Das Diagramm ist breiter als der Bildschirm und lässt sich horizontal
scrollen (Desktop und Handy); beim Öffnen steht die aktuelle Uhrzeit in der
Mitte, nach links scrollen zeigt die älteren Stunden. Schließen per X-Button
oder Escape-Taste.

Code: `src/components/WindHistoryPanel.tsx`. Geöffnet wird der Balken per
Klick auf einen Marker in `src/components/WindMap.tsx`; die Daten kommen
von `/api/history?station=<SCODE>`.

**Zeitfenster ändern:** Die beiden Werte stehen zentral in
`src/lib/wind.ts` (`HISTORY_HOURS = 12`, `FUTURE_MARGIN_HOURS = 4`) und
gelten für das Panel und die beiden APIs gemeinsam. Wird dort etwas
geändert, müssen `PAST_HOURS`/`FORECAST_HOURS` in der Edge Function
`supabase/functions/fetch-wind-forecasts/index.ts` mitgezogen werden (Deno
kann nicht aus `src/lib` importieren).

**Mitwachsende km/h-Skala:** Die senkrechte Achse beginnt immer bei 0 und
reicht **mindestens bis 45 km/h** — so bleiben ruhige Tage untereinander
vergleichbar (dieselbe Kurvenhöhe = dieselbe Windstärke). Ist der höchste
Wert (Messung oder Prognose) größer, wächst die Obergrenze in
15er-Schritten mit, sodass oben nichts mehr abgeschnitten wird.
Stellknöpfe: `Y_MIN_MAX_KMH`, `Y_MAX_STEP_KMH` und `Y_MAX_HEADROOM_KMH` in
`src/components/WindHistoryPanel.tsx`.

Die Zahlen an der Achse stehen bewusst nicht in runden 10er-Schritten,
sondern genau dort, wo im Diagramm die Farbe wechselt (0 / 10 / 20 / 25 /
30, plus die jeweilige Obergrenze ganz oben). Sie kommen direkt aus
`WIND_COLOR_SCALE` in `src/lib/wind.ts`: Wird die Skala dort geändert,
ändert sich die Achsenbeschriftung automatisch mit.

**Farbskala:** Die Windstärke wird in klaren Farbflächen dargestellt, nicht
als weicher Verlauf: 0–10 km/h hellblau, 11–20 grün, 21–25 gelb, 26–30
orange, ab 31 rot. Dieselben Farben gelten für die Pfeile auf der Karte, die
Wert-Quadrate im Verlaufsbalken und die Flächen hinter den Kurven. Geändert
wird das an einer Stelle: `WIND_COLOR_SCALE` in `src/lib/wind.ts`.

**Hinweis zur Auflösung:** Wie fein die Kurve ist, bestimmen die Stationen
selbst — sie messen alle 10 Minuten, und genau so dicht stehen die Spalten
(`TIMELINE_STEP_MINUTES` in `src/lib/wind.ts`). Der Sammel-Job läuft öfter
(alle 5 Minuten, siehe oben), damit kein Messwert durchrutscht; feiner wird
die Kurve dadurch aber nicht.

**Hinweis zu Lücken in der Kurve:** Der Bozner Dienst überspringt gelegentlich
einen einzelnen Messzeitpunkt — dann fehlt bei **allen** Stationen gleichzeitig
eine Spalte. Solche einzelnen Aussetzer überbrückt die Kurve
(`measurementGapMs` in `src/lib/wind.ts`: 2,5 Messtakte, also 25 Minuten, beim
SLF mit seinem 30-Minuten-Takt 75 Minuten). Fehlen zwei oder mehr Werte
am Stück — also bei einem echten Stationsausfall —, reißt die Kurve weiterhin
sichtbar auf. Pfeil und Werte-Quadrat fehlen an einer übersprungenen Stelle in
jedem Fall, es wird also nichts dazuerfunden.

> **Bezugsname für Änderungswünsche: „Verlaufsbalken".** Wenn du hier etwas
> ändern möchtest, genügt z. B. „Bitte im Verlaufsbalken die … anpassen".

## Zeitbalken (Windhistorie auf der Karte)

Unter der Karte sitzt ein **Zeitbalken**, der wie ein **Rad** aussieht — man
dreht ihn nach vorne und hinten, ähnlich wie die Höhenauswahl bei
Meteoparapente. Der feste Rahmen in der Mitte zeigt den gewählten Zeitpunkt;
die Pfeile **aller** Stationen zeigen dann die aufgezeichneten Messwerte zu
diesem Zeitpunkt. So kann man durch den Windverlauf der ganzen Karte blättern
und z. B. sehen, wie der Föhn durchbricht.

- **Bedienung:** Finger auf das Rad legen und ziehen. Nach **rechts** ziehen
  geht zurück in der Zeit, nach links wieder vor. Mit Schwung losgelassen läuft
  das Rad aus und rastet auf einem 10-Minuten-Schritt ein. Ein kurzes Antippen
  springt zur angetippten Stelle. Am Computer geht auch die Maus oder die
  Pfeiltasten. Der Knopf **„Aktuell"** dreht ganz nach vorne zurück.
- **Farbstrich** im Rad: je 10 Minuten die Windfarbe der windigsten 10 % der
  Stationen im **gerade sichtbaren Kartenausschnitt**. So sieht man schon vor
  dem Drehen, wann es in diesem Gebiet aufgefrischt hat.
- **Schrittweite 10 Minuten**, genau der Takt, in dem die Stationen messen.
- **Zeitraum: die letzten 48 Stunden** (dieselben `HISTORY_HOURS` wie beim
  Verlaufsbalken; bis Nov. 2026 12 Stunden). Die Datenbank bewahrt 3 Tage auf,
  damit am linken Rand nichts fehlt.
- **Öffnet man eine Station, verschwindet der Zeitbalken:** Die Karte zeigt dann
  nur die aktuellen Werte, und der Verlaufsbalken der Station reicht bis zum
  unteren Rand. Schließt man ihn, ist der Zeitbalken wieder da (auf „Aktuell").
- Stationen, für die zu diesem Zeitpunkt keine Messung gespeichert ist,
  erscheinen als **blasser grauer Ring** — genauso wie eine Station, die
  gerade ausgefallen ist. Es wird nichts dazugerechnet oder geschätzt.

**Datenquelle:** `src/app/api/timeline/route.ts` (Komponente:
`src/components/TimeSlider.tsx`). Die Route holt alle Messwerte der letzten
48 Stunden in **einem** Schritt über die Datenbank-Funktion `wind_timeline`
(seit Okt. 2026; vorher seitenweise in gut 30 Paketen, zusammen gut 2 s — die
Funktion selbst braucht ~0,2 s) und liefert ein kompaktes Spaltenformat: eine
gemeinsame Zeitliste und pro Station drei Zahlenreihen. Das sind rund 450 KB
(komprimiert übertragen, ausgepackt 1,7 MB; Nov. 2026, 48 Stunden, rund 650
Stationen — bei der 12-h-Anzeige waren es rund 110 KB). Sie werden **gleich
beim Öffnen der Seite** geholt (für den Farbstrich).

**Sparsam auffrischen (Punkt 27, Nov. 2026):** Danach holt die Seite alle
10 Minuten nur noch die **letzten 8 Stunden** (`/api/timeline?hours=8`,
rund 80 KB) und fügt sie in den vorhandenen Stand ein
(`src/lib/timelineMerge.ts`) — statt jedes Mal die ganzen 450 KB. Der
**Flugmodus** holt überhaupt nur die 8 Stunden; er zeigt keinen Zeitbalken und
braucht den Verlauf nur für die Messfehler-Erkennung. Das spart pro Stunde
offener Seite gut 2 MB Datenvolumen, vor allem am Berg bei schwachem Empfang.
Die vollen 48 Stunden kommen wieder, wenn die Hauptseite sie nach einem Start
im Flugmodus braucht oder das letzte Laden über 4 Stunden her ist. Das
eingefügte Ergebnis ist dasselbe wie beim vollen Laden: `/api/timeline`
rechnet jedes Fenster mit 3 Stunden Vorlauf, damit Messfehler-Kennzeichen und
gehaltene SLF-Werte auch am Fensteranfang stimmen (geprüft mit einer
Simulation über 96 Auffrischungen).

**Bei einer bestehenden Datenbank einmalig:** `supabase/zeitbalken-funktion.sql`
im Supabase SQL-Editor ausführen (legt nur die Funktion an, verändert keine
Daten; bei einer Neuinstallation steckt sie schon in `schema.sql`). Fehlt
sie, meldet `/api/timeline` „Funktion fehlt: supabase/zeitbalken-funktion.sql
ausführen", und der Zeitbalken bleibt leer.

> **Bezugsname für Änderungswünsche: „Zeitbalken".**

## Windprognosen ICON-CH1 (Supabase Edge Function)

Die Supabase Edge Function `fetch-wind-forecasts`
(Code: `supabase/functions/fetch-wind-forecasts/index.ts`) holt
Windprognosen des Modells **ICON-CH1** (MeteoSwiss) von
[Open-Meteo](https://open-meteo.com) für **alle Stationen der Karte** und
schreibt sie in die Tabelle `wind_forecasts` (Schema:
`supabase/forecast-schema.sql`). Die Stationen nimmt sie seit Nov. 2026 aus
der Stationsliste in der Datenbank (`wind_stations`, gepflegt vom Sammler) —
vorher fragte sie selbst bei Bozen, OpenWindMap (nur Südtirol), SLF und
GeoSphere nach und hatte dafür Kopien von deren Adressen und vom
Alpen-Umriss. Seitdem haben auch MeteoSchweiz, LWD Tirol, DWD und alle
OpenWindMap-Stationen eine Prognose-Kurve, und eine neue Quelle braucht in
der Edge Function nichts. Details:

- **Bodenwind nur aus ICON-CH1** (`model = 'icon_ch1'`). Der ICON-D2-Bodenwind
  wurde bis Sept. 2026 mitgesammelt, aber nie angezeigt, und ist entfernt.
- **Höhenwind (ICON-D2)** nur für Rittnerhorn und Leiterspitz
  (`model = 'icon_d2_upper'`, im Verlaufsbalken blau gestrichelt): Wind der
  freien Atmosphäre auf der nächsthöheren Druckfläche über der Station
  (beide: **700 hPa, ca. 3000 m**), ohne Umrechnung und so beschriftet. Nur
  Mittelwind und Richtung, keine Böen. Eigene Laufprüfung über
  <https://api.open-meteo.com/data/dwd_icon_d2/static/meta.json>: Fehlt der
  Höhenwind oder gibt es einen neuen ICON-D2-Lauf, holt ihn der nächste
  Cron-Anstoß (16 Aufrufe am Tag). Weitere Stationen: `UPPER_WIND_STATIONS`
  in `src/lib/wind.ts` (Druckfläche) **und** in der Edge Function (mit
  Koordinaten) ergänzen, dann die Funktion neu deployen.
- **Wann gibt es neue Daten?** ICON-CH1 rechnet **alle 3 Stunden** neu
  (Läufe um 00, 03, 06, … UTC). Bei Open-Meteo steht ein Lauf rund
  **2 h 20 min** nach dem Start bereit, also etwa um 02:20, 05:20, 08:20, …
  UTC (Sommerzeit: 04:20, 07:20, 10:20, … Uhr). Nachsehen lässt sich das
  jederzeit unter
  <https://api.open-meteo.com/data/meteoswiss_icon_ch1/static/meta.json>
  (`last_run_initialisation_time` = Laufstart,
  `last_run_availability_time` = bereit, beides in Unix-Sekunden).
- **Nur bei neuem Lauf abfragen:** Die Funktion liest zuerst diese
  Metadaten. Ist der neueste Lauf schon gespeichert, endet sie ohne einen
  einzigen Prognose-Abruf (Antwort `"skipped": true`). So wird nur
  **8-mal am Tag** wirklich abgefragt, egal wie oft der Cron-Job läuft.
  Erzwingen: POST mit Body `{"force": true}`. Ist die Metadaten-Datei
  nicht lesbar, fragt die Funktion höchstens alle 170 Minuten ab.
- **Modellgebiet:** ICON-CH1 endet im Osten bei etwa 16,64° Länge. Die 10
  österreichischen Stationen östlich davon (u. a. Neusiedl am See,
  Podersdorf, Andau, Hohenau) bekommen keine Prognose; sie werden vorab
  aussortiert, weil Open-Meteo sonst die ganze Anfrage ablehnt.
- **Gescheiterte Stationen nachholen (Nov. 2026):** Scheitert beim Abruf
  eines neuen Laufs ein Teil der Blöcke, merkt sich die Funktion deren
  Stationen (Tabelle `wind_status`, Zeile `prognose`) und holt sie bei den
  nächsten Cron-Anstößen nach — höchstens 4-mal, also innerhalb von rund
  einer Stunde. Vorher warteten sie bis zum nächsten Lauf (3 h). In der
  Antwort steht das unter `"retry"`.
- **Kontingent:** Open-Meteo erlaubt kostenlos 10.000 Aufrufe pro Tag,
  gezählt je Station. ~650 Stationen × 8 Läufe ≈ **5.200 am Tag**, dazu 16
  für den Höhenwind (Nov. 2026; im Okt. 2026 ~490 Stationen ≈ 3.900, bis
  Sept. 2026 wurde stündlich abgefragt, damals ~7.400 am Tag).
- Zeitfenster: letzte 12 Stunden + kommende 12 Stunden. Die Vergangenheit im
  48-h-Verlaufsbalken kommt aus früheren Läufen, die bis zu 3 Tage gespeichert
  bleiben. Angezeigt werden nur 4 Stunden Zukunft — der Rest ist Puffer bis zum nächsten Lauf
  (und für einen ausgefallenen); `/api/forecast` schneidet den Überhang ab.
- Einheiten wie in `wind_measurements`: Wind/Böen in **km/h**, Richtung in
  Grad, Prognosezeiten als UTC (`timestamptz`).
- Upsert über `station_code` + `model` + `forecast_time` — wiederholte
  Abrufe überschreiben dieselben Stunden, statt Duplikate anzulegen.
  Prognosen älter als 3 Tage werden bei jedem Lauf gelöscht.
- Stationen am/außerhalb des Modellrands liefern `null` und werden
  übersprungen (in der Antwort als `skippedNullHours` gezählt): dort werden
  einfach keine Zeilen gespeichert, im Diagramm fehlt dann die Linie — sie
  fällt nicht auf 0 km/h und es erscheint keine Fehlermeldung.
- Zugriffsschutz wie bei `/api/collect`: nur **POST** mit
  `Authorization: Bearer <service_role Key>`, sonst `401`.

**Antwort der Funktion (Erfolg):** Status `200` mit z. B.
`{ "ok": true, "model": "icon_ch1", "modelRun": "2026-09-29T00:00:00.000Z",
"stations": 582, "saved": 13900, "skippedNullHours": 0, "batchErrors": [], … }`
— oder, wenn es nichts Neues gibt,
`{ "ok": true, "skipped": true, "reason": "Kein neuer ICON-CH1-Lauf …" }`.

> **Früher gab es hier zusätzlich eine AROME-Prognose** von GeoSphere Austria
> (`model = 'arome'`, im Verlaufsbalken gelb). Sie ist auf Wunsch wieder
> entfernt worden: Sie wird weder abgefragt noch gespeichert noch angezeigt.
> Bestehende Datenbanken haben eventuell noch alte `arome`-Zeilen; die stören
> nicht (sie laufen nach 3 Tagen von selbst ab). Wer sofort aufräumen möchte,
> führt einmalig den Inhalt von `supabase/remove-arome-forecasts.sql` im
> **SQL Editor** aus.

> **Alte Höhenwind-Spalten:** Eine frühere Fassung des Höhenwinds legte die
> Spalten `pressure_level` / `height_m` an; der heutige Höhenwind braucht sie
> nicht. Sie stören nicht. Wer sie entfernen möchte, führt einmalig den
> Inhalt von `supabase/remove-upper-wind.sql` im **SQL Editor** aus.

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
4. **Regelmäßigen Abruf einrichten (alle 15 Minuten):** Wieder im
   **SQL Editor** den Inhalt von `supabase/forecast-cron.sql` einfügen,
   vorher die zwei Platzhalter ersetzen (Projekt-URL und service_role Key —
   dieselben Werte wie in den Vercel-Umgebungsvariablen), dann **Run**
   klicken. Die echten Werte niemals in die Datei im Repository
   zurückschreiben! Neue Prognosewerte holt die Funktion trotzdem nur bei
   einem neuen Modelllauf (siehe oben).
5. **Prüfen:** Nach spätestens 15 Minuten im **Table Editor →
   `wind_forecasts`** nachsehen (nach `fetched_at` absteigend sortieren). Was
   die Funktion geantwortet hat, zeigt
   `select status_code, content, created from net._http_response order by created desc limit 5;`
   im SQL Editor (siehe „Fehlersuche").

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
- **Takt umstellen (Sept. 2026):** Bestehende Datenbanken laufen noch
  stündlich um Minute 10. Nach dem Deploy der neuen Edge Function einmalig
  `supabase/forecast-cron-15min.sql` im SQL-Editor ausführen — dann ist ein
  neuer ICON-CH1-Lauf spätestens 15 statt 60 Minuten nach Erscheinen auf der
  Seite, ohne zusätzliches Open-Meteo-Kontingent.

Für lokale Tests ohne echte Dienste lässt sich Open-Meteo per
Umgebungsvariable auf einen Mock-Server umbiegen (`OPEN_METEO_BASE_URL`,
`OPEN_METEO_META_URL`); die Stationsliste kommt aus der Datenbank
(`SUPABASE_URL`).

## OpenWindMap/Pioupiou-Stationen

Zusätzlich zu den Bozner Stationen zeigt die Karte die Stationen des
**OpenWindMap/Pioupiou-Netzwerks** im Alpenraum (batteriebetriebene, private
Windsensoren, vor allem an Startplätzen für Gleitschirmflieger; Okt. 2026
rund 90 Stationen in Südtirol, der Schweiz, Österreich, Bayern und am
Rand von Frankreich und Italien). Code: `src/lib/pioupiou.ts` (genutzt vom
Sammler `/api/collect` und im Notbetrieb von `/api/wind`).

- **Endpunkt:** `https://api.pioupiou.fr/v1/live/all` liefert ALLE
  Stationen weltweit ohne Regionsfilter. Behalten werden die im Alpenraum
  (`isInAlps` in `src/lib/alps.ts`, dieselbe Regel wie bei allen Quellen).
  Bis Okt. 2026 war es nur eine grobe Südtirol-Box mit 6 Stationen.
- **Abgeschaltete Stationen:** Wer seit über 2 Tagen nichts gemeldet hat,
  erscheint nicht (`MAX_SILENCE_MS`, gleich lang wie die 48-h-Anzeige) — das sind meist abgebaute oder für die Saison abgeschaltete
  Stationen. Kürzere Pausen (nachts, windstill) zeigen einen grauen Ring.
- **Prognose:** seit Nov. 2026 für alle angezeigten OpenWindMap-Stationen
  (vorher nur in Südtirol).
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
  (nachts/windstill teils gar nicht). Es gilt dieselbe Regel wie bei allen
  Quellen: fehlt Richtung/Geschwindigkeit oder ist die letzte Messung älter
  als 30 Minuten, erscheint die Station als grauer Ring statt als Windpfeil.
- **Ausfallsicher:** Schlägt der Abruf fehl (Dienst nicht erreichbar),
  speichert der Sammler die übrigen Quellen trotzdem; die
  OpenWindMap-Stationen bleiben mit ihrem letzten Wert auf der Karte (nach der
  Grau-Grenze grau), statt alles zu blockieren.
- **Herkunft:** In `wind_measurements` markiert die Spalte `source`
  (`bolzano`/`openwindmap`), woher eine Zeile stammt. Im Verlaufsbalken
  steht unten außerdem ein direkter „Quelle:"-Link zur jeweiligen Station.
- **Mock-Server für lokale Tests:** `PIOUPIOU_API_BASE_URL` überschreibt
  den Endpunkt, analog zu `WIND_API_BASE_URL` (Bozen).

**Pflicht-Lizenzhinweis (offener Punkt):** Die OpenWindMap-Daten stehen
unter der kostenlosen Community-Lizenz, die einen sichtbaren Credit mit
Link verlangt. Dieser stand bis Aug. 2026 in der Fußzeile jeder Seite
(`src/app/page.tsx`): „Winddaten © contributors of the OpenWindMap wind
network, [openwindmap.org](https://openwindmap.org)". Die Fußzeile wurde
auf Wunsch des Projektbesitzers entfernt; die Quellenangabe für die
Winddaten soll später in anderer Form gelöst werden. Bis dahin gibt es
den Hinweis nur noch stationsweise als „Quelle:"-Link unten im
Verlaufsbalken.


## Nur Stationen in den Alpen

Die Karte zeigt (und sammelt, und prognostiziert) nur Wetterstationen **im
Alpenraum** — Gleitschirmflieger brauchen sonst nichts. Entscheidend ist der
**Ort, nicht die Höhe**: Talstationen in den Alpen (Innsbruck, Chur, Sion,
Bozen, Klagenfurt, Graz …) bleiben, Stationen im Flachland oder Mittelgebirge
außerhalb der Alpen (Wien, Burgenland, Mühl-/Waldviertel, Schweizer Mittelland
mit Bern/Zürich/Basel/Genf, Jura) fallen weg.

- **Regel:** `isInAlps(lat, lon)` in `src/lib/alps.ts` — ein grober Umriss der
  Alpen. Die Edge Function `fetch-wind-forecasts` braucht seit Nov. 2026 keine
  eigene Kopie mehr: Sie nimmt die Stationsliste des Sammlers, die schon
  gefiltert ist.
- **Betrifft:** GeoSphere Austria (191 von 286 Stationen bleiben),
  MeteoSchweiz (97 von 151), SLF (207 von 208) und seit Okt. 2026
  OpenWindMap (rund 90 von gut 750 weltweit). Bozen, LWD Tirol und Zugspitze
  liegen sowieso in den Alpen.
- **West- und Südrand:** Der Umriss ist dort eine gerade Linie, weil es
  anfangs in Frankreich und Italien keine Stationen gab. Mit OpenWindMap
  schneidet er den französischen und italienischen Alpenteil ab (Okt. 2026:
  gut 160 aktive Stationen in den französischen Alpen und 13 am italienischen
  Alpenrand liegen außerhalb). Erweitern ginge, ist aber eine Entscheidung des
  Projektbesitzers.
- **Ausnahme Windanzeiger:** Chasseral und La Dôle (MeteoSchweiz, Jura) bleiben,
  weil sie zu den vom Projektbesitzer gewählten Windanzeiger-Stationen gehören.
- Alte Messwerte und Prognosen der entfernten Stationen löscht das
  Aufräumen nach 3 Tagen von selbst.

## GeoSphere-Austria-Stationen (früher ZAMG)

Zusätzlich zeigt die Karte die **österreichischen Wetterstationen mit
Windmessung im Alpenraum** von GeoSphere Austria (Messnetz TAWES,
10-Minuten-Werte), rund 190 Stück. Stationen im Flachland (Wien, Burgenland,
Weinviertel, Donauraum, Mühl-/Waldviertel) fehlen bewusst — siehe Abschnitt
„Nur Stationen in den Alpen" weiter oben. Code: `src/lib/geosphere.ts`
(genutzt vom Sammler `/api/collect` und im Notbetrieb von `/api/wind`).

- **Endpunkt:** `https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min`
  (offen, kein API-Schlüssel). `/metadata` liefert alle Stationen
  Österreichs; Stationen ganz ohne Windwerte werden ausgelassen.
- **Mehrere Zeitpunkte in einer Antwort:** Hinkt eine Station hinterher,
  enthält die Antwort mehrere Zeitpunkte. Je Station gilt der letzte
  Zeitpunkt mit Windwert; ist er älter als 30 Minuten, erscheint die Station
  grau.
- **Stationscodes:** `geosphere-<Nummer>` (z. B. `geosphere-11129` = Brenner).
- **Werte:** `DD` (Richtung), `FF` (10-min-Mittelwind), `FFX` (Böe). Die API
  liefert m/s, umgerechnet wird auf km/h. Höhe kommt direkt aus den Metadaten.
- **Anfrage-Grenze:** höchstens 240 Anfragen pro Stunde — deshalb 120 s Cache
  für die Messwerte (siehe Kommentar in `src/lib/geosphere.ts`).
- **Prognosen:** ICON-CH1 für alle angezeigten Stationen.
- **Lizenz:** CC BY 4.0 — Quellenangabe über den „Quelle:"-Link im
  Verlaufsbalken („GeoSphere Austria (CC BY 4.0)").
- **Ausfallsicher** wie OpenWindMap: fällt der Dienst aus, bleiben die
  übrigen Stationen sichtbar.
- **Mock-Server:** `GEOSPHERE_API_BASE_URL` überschreibt den Endpunkt.

## SLF-IMIS-Stationen (Schweiz)

Seit Sept. 2026 zeigt die Karte auch die rund 200 automatischen
**IMIS-Stationen** des WSL-Instituts für Schnee- und Lawinenforschung SLF
(Schweiz und Liechtenstein) — dieselben Stationen wie auf
[whiterisk.ch](https://whiterisk.ch). Code: `src/lib/slf.ts` (genutzt vom
Sammler `/api/collect` und im Notbetrieb von `/api/wind`).

- **Quelle:** die offizielle, öffentliche
  [SLF Measurement API](https://measurement-api.slf.ch/docs), ohne
  Anmeldung. `/imis/stations` liefert Name, Lage und Höhe,
  `/imis/measurements` die Messwerte aller Stationen der letzten 24 h.
- **Lizenz:** CC BY 4.0 — die Nennung des SLF ist Pflicht und steht als
  „Quelle:" unten im Verlaufsbalken (`SOURCE_INFO` in `src/lib/wind.ts`).
- **Messtakt: nur alle 30 Minuten** (Werte zu :00 und :30, jeweils Mittel
  über die letzten 30 min; Böe = stärkster 5-Sekunden-Wert). Im Sept. 2026
  nachgeprüft: Auch whiterisk.ch selbst bekommt nichts Feineres. Folgen:
  - Verlaufsbalken: Pfeile und Werte-Quadrate stehen nur an jeder dritten
    Spalte; die Kurve reißt erst ab, wenn zwei Halbstundenwerte am Stück
    fehlen (`measurementGapMs` in `src/lib/wind.ts`).
  - Zeitbalken: Ein Halbstundenwert bleibt bis zum nächsten stehen
    (`/api/timeline`), damit die Stationen dazwischen nicht grau werden.
- **Einheit:** Das SLF liefert m/s, umgerechnet wird in `src/lib/slf.ts`.
- **Sammeln:** `/api/collect` schreibt bei jedem Lauf die SLF-Werte der
  letzten 3 Stunden (Upsert), Lücken füllen sich also von selbst.
- **Stationen ohne Windrichtung** (z. B. ZNZ1, auch auf whiterisk.ch ohne
  Richtung) erscheinen als grauer Punkt; der Verlauf mit Mittelwind und
  Böen ist trotzdem abrufbar.
- **Mock-Server für lokale Tests:** `SLF_API_BASE_URL`.

## MeteoSchweiz, Lawinenwarndienst Tirol, DWD und Bälmeten (Windanzeiger)

Seit Sept. 2026 (Wunsch des Projektbesitzers, für den Filter „Windanzeiger")
kommen vier weitere Quellen dazu. Alle laufen wie die übrigen additiv: Fällt
eine aus, zeigt die Karte die anderen weiter. Eine **Prognose-Kurve** haben sie
erst seit Nov. 2026 (vorher kannte die Edge Function `fetch-wind-forecasts` sie
nicht); seitdem nimmt die Funktion alle Stationen aus der Stationsliste des
Sammlers.

- **MeteoSchweiz** (`src/lib/meteoswiss.ts`, Codes `meteoswiss-<Kürzel>`, z. B.
  `meteoswiss-SAE` = Säntis): **alle** ~150 SwissMetNet-Stationen mit Wind.
  Eine einzige kleine Datei mit den jüngsten 10-Minuten-Werten aller
  Stationen (`…/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv`, Zeitstempel UTC,
  km/h) plus die Stationsliste (`…/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv`,
  6 h gecacht). Ohne Anmeldung. Quellenangabe „MeteoSchweiz" steht im
  Verlaufsbalken (`SOURCE_INFO`). Die genauen Lizenzbedingungen von
  MeteoSchweiz sollten vom Projektbesitzer einmal gegengelesen werden.
  Mock/Umbiegen: `METEOSWISS_CURRENT_URL`, `METEOSWISS_META_URL`.
- **Lawinenwarndienst Tirol** (`src/lib/lwdtirol.ts`, Code `lwdtirol-ISEE1`):
  nur die Stationen in `LWD_TIROL_STATIONS` (derzeit **Hafelekar**). Quelle: die
  GeoJSON-Datei `wiski.tirol.gv.at/lawine/produkte/ogd.geojson` (Land Tirol,
  CC BY 4.0, km/h laut Datensatzbeschreibung auf data.gv.at; bis Okt. 2026
  `lawine.tirol.gv.at/data/produkte/ogd.geojson`, die alte Adresse leitet nur
  noch um). Weitere Stationen: Nummer aus dem Feld „LWD-Nummer" der Datei
  eintragen. Umbiegen: `LWD_TIROL_URL`.
- **Deutscher Wetterdienst** (`src/lib/dwd.ts`, Code `dwd-05792`): nur die
  Stationen in `DWD_STATIONS` (derzeit die **Zugspitze**). Quelle: zwei kleine
  ZIP-Dateien der 10-Minuten-Werte (`…/CDC/observations_germany/climate/10_minutes/`,
  Mittelwind/Richtung und Böe). Die ZIP-Dateien liest ein eigener kleiner Leser
  in `dwd.ts` (keine zusätzliche Bibliothek). Der DWD erneuert die Dateien nur
  **alle 30 Minuten** (mit je drei neuen 10-Minuten-Werten); die Sammel-Route
  speichert deshalb alle Werte der letzten 3 Stunden, nicht nur den neuesten
  (bis Okt. 2026 fehlten so 2 von 3 Werten). Grau wird die Zugspitze erst nach
  75 Minuten ohne neuen Wert. Ab dem 25.09.2026 lieferte der DWD eine Zeit
  lang keine Werte, spätestens seit dem 25.10.2026 wieder.
  Umbiegen: `DWD_CDC_BASE_URL`.
- **Bälmeten** (Paradeltaclub Uri, OpenWindMap-Station 1535, Code
  `pioupiou-1535`): kommt seit Okt. 2026 mit allen OpenWindMap-Stationen im
  Alpenraum. Die Höhe (2414 m) steht fest in `ALTITUDE_OVERRIDES` in
  `src/lib/pioupiou.ts`, weil der Stationsname keine enthält.

**Windanzeiger:** Diese Stationen (und die österreichischen GeoSphere-Gipfel)
sind über ihren Stationscode in `WINDANZEIGER_STATION_CODES`
(`src/lib/wind.ts`) ausgewählt, nicht über den Namen — Namen würden Fehltreffer
erzeugen (SLF „Titlisboden" enthält „Titlis"). **Nicht** dabei sind bewusst
Robiei (das MeteoSchweiz-Kürzel `ROB` ist Poschiavo/Robbia im Tal, eine andere
Station), Talstationen, Startplatz-Stationen und der Gaisberg.

## Hinweis zur Sandbox-Umgebung

Innerhalb dieser Cloud-Sandbox sind sowohl der Wetterdienst der Provinz
Bozen als auch die Kartenkacheln und die Pioupiou-API
(`api.pioupiou.fr`) durch die Netzwerk-Richtlinie der Umgebung blockiert
(nur eine begrenzte Liste an Hosts ist erlaubt). Lokal auf dem eigenen
Rechner oder nach einem Deployment (z. B. auf Vercel) sind alle drei
öffentlich frei erreichbar.
