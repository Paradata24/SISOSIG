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

Die Next.js-Route `src/app/api/wind/route.ts` ruft beide Endpunkte ab,
sucht sich (falls kein `?station=<Code>` angegeben ist) automatisch die
erste Station mit vollständigen Winddaten heraus und gibt Richtung,
Windgeschwindigkeit und Windböe als JSON zurück (umgerechnet in km/h).

Eine bestimmte Station lässt sich über `/api/wind?station=<SCODE>`
abrufen. Die Stationscodes findet man in der Antwort von
`/services/meteo/v1/stations`.

## Hinweis zur Sandbox-Umgebung

Innerhalb dieser Cloud-Sandbox sind sowohl der Wetterdienst der Provinz
Bozen als auch die OpenStreetMap-Kartenkacheln durch die
Netzwerk-Richtlinie der Umgebung blockiert (nur eine begrenzte Liste an
Hosts ist erlaubt). Lokal auf dem eigenen Rechner oder nach einem
Deployment (z. B. auf Vercel) sind beide öffentlich frei erreichbar.
