# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
  1. Südtirol: Live-Wind + 48h-Historie auf Karte (aktuell in Arbeit)
  2. Erweiterung auf weitere Länder/Regionen (Schweiz, Österreich)
  3. Prognosevergleich ICON-D2 vs. ICON-CH1 via Open-Meteo API

## Wichtige Entscheidungen (bitte nicht ohne Rücksprache ändern)
- Karten-Bibliothek: Leaflet (bewusst statt MapLibre GL JS gewählt)
- Hosting: Vercel, Datenbank: Supabase, Datensammlung: GitHub Actions
  (nicht Vercel Cron)
- Secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) NIEMALS im Code,
  nur als Umgebungsvariablen/Secrets in Vercel + GitHub

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

## Commands

```bash
npm run dev          # dev server (Turbopack), http://localhost:3000
npm run build         # production build (also type-checks)
npm run lint          # eslint
npx tsc --noEmit       # type-check only, faster than a full build
```

There is no test suite. Verify changes by running the dev server and/or
`npm run build`, and by curling the API routes directly (see below for
how to point them at a local mock instead of the real services).

## Architecture

This is a Next.js (App Router) site that shows live wind data from South
Tyrol weather stations on a Leaflet map, plus a 48h history backed by
Supabase.

**Data flow:**
1. `src/app/api/wind/route.ts` — fetches the Province of Bozen/Bolzano
   open-data weather webservice (`daten.buergernetz.bz.it/services/meteo/v1`,
   overridable via `WIND_API_BASE_URL`) and returns all stations that have
   wind sensors and known coordinates as a JSON array (`WindStation[]`,
   typed in `src/lib/wind.ts`). Two upstream requests cover every station:
   `/sensors` (current readings for all stations at once) and `/stations`
   (metadata: name, coordinates, altitude).
2. `src/components/WindMap.tsx` (client component) polls `/api/wind` every
   5 minutes and renders one marker per station: a rotating SVG arrow
   colored by speed on a 10-step scale modeled after the XC-Therm legend
   (white → light blue → green → yellow → orange → red → violet → indigo —
   see `WIND_COLOR_SCALE`/`getWindColor` in `src/lib/wind.ts`), or a gray
   dot for stations whose `stale` flag is set (missing reading or
   measurement older than 2h). `WindLegend.tsx` renders the matching
   color-scale legend overlay on the map, driven by the same
   `WIND_COLOR_SCALE` constant so the legend and the markers can never
   drift out of sync. It's loaded via `WindMapLoader.tsx`
   (`next/dynamic`, `ssr: false`) because Leaflet needs `window` — Next 16
   no longer allows `ssr: false` directly inside a Server Component, so the
   dynamic import must live in its own `"use client"` wrapper. The map
   itself offers two base layers via Leaflet's `LayersControl` (Standard
   OSM tiles vs. an Esri hillshade + CARTO place-name overlay); markers are
   rendered outside the base-layer group so they stay visible on both.
3. `scripts/collect-wind.mjs` — a standalone Node script (no npm deps) run
   by `.github/workflows/collect-wind.yml` every 10 minutes. It re-fetches
   the same upstream API, upserts rows into the Supabase table
   `wind_measurements` (schema in `supabase/schema.sql`), and deletes rows
   older than 7 days. This is a separate code path from `/api/wind` (not a
   shared module) because it runs in GitHub Actions, not in the Next.js
   runtime.
4. `src/app/api/history/route.ts` — reads the last 48h for one station
   (`?station=<SCODE>`) straight from Supabase via the REST API (no
   `@supabase/supabase-js` dependency, just `fetch`).

**Upstream API quirks worth knowing before touching `/api/wind` or
`collect-wind.mjs`:**
- The webservice's station list (`/stations`) has been observed in two
  shapes: a flat array, or a GeoJSON `FeatureCollection` (coordinates
  under `geometry.coordinates`). `normalizeStations()` handles both —
  don't assume one shape without re-checking a live response.
- Sensor descriptions (`DESC_D`) are matched by German substring
  (`windrichtung`, `windgeschwindigkeit`, `böe`) rather than by sensor
  `TYPE` code, because the type codes aren't documented anywhere
  findable; this is intentionally more robust than guessing exact codes.
- Timestamps come back as e.g. `"2026-07-13T14:10:00CEST"`, which is not
  valid ISO 8601 and `Date.parse` can't handle it. Both `/api/wind` and
  `collect-wind.mjs` replace the `CEST`/`CET` suffix with a numeric UTC
  offset (`toIsoTimestamp`/inline equivalent) before returning or storing
  it — keep these two in sync if the conversion logic changes.
- A station only ends up in `/api/wind`'s output if it has wind sensors
  **and** resolvable coordinates; stations with sensors but no metadata
  match are dropped rather than shown at an unknown location.

**Secrets:** `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are required by
`/api/history` (as Vercel environment variables) and by the collector
workflow (as GitHub Actions secrets) — never hardcode them or the
webservice URL override; see the README's setup table.

**Sandboxed dev environments:** outbound requests to
`daten.buergernetz.bz.it`, `tile.openstreetmap.org`, and Supabase may be
blocked by network policy in some sandboxes. When that's the case,
`/api/wind` and `/api/history` will return their real error responses
(502/500) rather than throwing — this is expected there, not a bug. Set
`WIND_API_BASE_URL` to a local mock HTTP server to test the route logic
without live network access.
