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

Ein GitHub-Actions-Workflow (`.github/workflows/collect-wind.yml`) fragt
alle 10 Minuten den Wetterdienst ab und schreibt die Windwerte aller
Stationen in die Supabase-Tabelle `wind_measurements`
(Schema: `supabase/schema.sql`, einmalig im Supabase SQL-Editor
ausführen). Einträge älter als 7 Tage werden bei jedem Lauf gelöscht.

`/api/history?station=<SCODE>` liefert die Messwerte der letzten
48 Stunden einer Station.

Benötigte Zugangsdaten (niemals in den Code schreiben!):

| Variable | Wert | Wo eintragen |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL des Supabase-Projekts | GitHub: Settings → Secrets and variables → Actions. Vercel: Settings → Environment Variables |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role Key des Supabase-Projekts | ebenda |

Die GitHub Secrets braucht der Sammel-Workflow, die Vercel-Variablen
braucht die `/api/history`-Route.

## Hinweis zur Sandbox-Umgebung

Innerhalb dieser Cloud-Sandbox sind sowohl der Wetterdienst der Provinz
Bozen als auch die OpenStreetMap-Kartenkacheln durch die
Netzwerk-Richtlinie der Umgebung blockiert (nur eine begrenzte Liste an
Hosts ist erlaubt). Lokal auf dem eigenen Rechner oder nach einem
Deployment (z. B. auf Vercel) sind beide öffentlich frei erreichbar.
