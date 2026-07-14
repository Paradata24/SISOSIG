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

Die Sammel-Route `src/app/api/collect/route.ts` (Aufruf per **POST** unter
`/api/collect`) fragt den Wetterdienst ab und schreibt die Windwerte aller
Stationen in die Supabase-Tabelle `wind_measurements`
(Schema: `supabase/schema.sql`, einmalig im Supabase SQL-Editor
ausführen). Einträge älter als 7 Tage werden bei jedem Lauf gelöscht.

Die Route wird von **Supabase Cron** angestoßen (früher lief das über einen
GitHub-Actions-Workflow). Der Cron-Job muss bei jedem Aufruf den Header
`Authorization: Bearer <CRON_SECRET>` mitschicken — ohne gültiges Token
antwortet die Route mit `401`.

`/api/history?station=<SCODE>` liefert die Messwerte der letzten
48 Stunden einer Station.

Benötigte Zugangsdaten (niemals in den Code schreiben!), alle als
**Environment Variables in Vercel** (Settings → Environment Variables):

| Variable | Wert | Wofür |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL des Supabase-Projekts | `/api/collect` und `/api/history` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role Key des Supabase-Projekts | `/api/collect` und `/api/history` |
| `CRON_SECRET` | selbst gewähltes, langes Geheimnis | schützt `/api/collect` vor fremden Aufrufen |

### Supabase Cron einrichten

1. In Supabase links auf **Integrations → Cron** (bzw. **Database → Cron
   Jobs**) und **Create a new cron job**.
2. Zeitplan z. B. alle 10 Minuten (`*/10 * * * *`).
3. Als Aktion einen HTTP-Request wählen:
   - Methode: **POST**
   - URL: `https://<deine-vercel-domain>/api/collect`
   - Header: `Authorization` = `Bearer <CRON_SECRET>` (denselben Wert wie
     die Vercel-Variable) und `Content-Type` = `application/json`
4. Speichern. Im Cron-Protokoll erscheint bei Erfolg eine JSON-Antwort wie
   `{"ok":true,"saved":42,...}`.

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

## Hinweis zur Sandbox-Umgebung

Innerhalb dieser Cloud-Sandbox sind sowohl der Wetterdienst der Provinz
Bozen als auch die OpenStreetMap-Kartenkacheln durch die
Netzwerk-Richtlinie der Umgebung blockiert (nur eine begrenzte Liste an
Hosts ist erlaubt). Lokal auf dem eigenen Rechner oder nach einem
Deployment (z. B. auf Vercel) sind beide öffentlich frei erreichbar.
