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
- Hosting: Vercel, Datenbank: Supabase, Datensammlung: Vercel-API-Route
  `/api/collect`, angestoßen von Supabase Cron (früher GitHub Actions)
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

## Eigenständige Umsetzung von Änderungen
- Änderungen, die ich (Claude) fachlich für richtig und sinnvoll
  halte, immer direkt umsetzen — nicht nur vorschlagen und auf eine
  ausdrückliche Freigabe warten. Der Projektbesitzer ist
  Nicht-Programmierer und vertraut hier auf die fachliche Einschätzung.
- Weiterhin ZUERST nachfragen bei: riskanten oder schwer umkehrbaren
  Aktionen (z.B. Datenbank löschen, force push) und bei Änderungen an
  den oben unter „Wichtige Entscheidungen" gelisteten Punkten.
- Jede umgesetzte Änderung danach kurz und in einfacher Sprache
  erklären (was, warum, in welcher Datei) — siehe „Kommunikation bei
  Änderungen".

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
   (metadata: name, coordinates, altitude). It then merges in South Tyrol's
   OpenWindMap/Pioupiou stations via `fetchOpenWindMapStations()`
   (`src/lib/pioupiou.ts`) — additive: a failed Pioupiou fetch just means
   fewer markers, not a broken map. Each `WindStation` now carries a
   `source: "bolzano" | "openwindmap"` field (see `SOURCE_INFO` in
   `src/lib/wind.ts` for the matching display label/link, shown as a
   "Quelle:" line at the bottom of the Verlaufsbalken). **Caching** (don't
   revert to `cache: "no-store"` — stations only measure every 5-10 min, so
   per-request upstream fetches are pure waste): `/sensors` and the Pioupiou
   fetch use `next: { revalidate: 60 }`, `/stations` metadata (essentially
   static) uses 6h, and the successful JSON response carries
   `Cache-Control: s-maxage=60, stale-while-revalidate=240` so Vercel's CDN
   shares one response across concurrent visitors. Error responses are
   deliberately NOT CDN-cached (no Cache-Control header) so a brief upstream
   outage can't stick for 60s. The `stale` flag is still computed against
   the current time on every actual route run; ≤60s-old cached readings are
   irrelevant against the 2h staleness threshold. See README section
   "Zwischenspeicherung (Caching)".
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
3. `src/app/api/collect/route.ts` — a **POST** API route triggered by
   **Supabase Cron** (formerly a GitHub Actions workflow, now removed),
   configured for **every 10 minutes** and covering both sources (Bozen +
   OpenWindMap). It re-fetches the same upstream APIs as `/api/wind`
   (Bozen webservice + `fetchOpenWindMapStations()`, the latter additive —
   a failed Pioupiou fetch doesn't block the Bozen rows), upserts rows into
   the Supabase table `wind_measurements` (schema in `supabase/schema.sql`,
   including a `source` column so each row's origin is known), and deletes
   rows older than 7 days, then answers with a small JSON summary
   (`{ ok, saved, ... }`). It is guarded by a bearer token: callers must
   send `Authorization: Bearer <CRON_SECRET>` or the route returns 401
   (`CRON_SECRET` is a Vercel env var). This deliberately reuses the same
   sensor-parsing logic as `/api/wind` but is a separate route because it
   *writes* to Supabase rather than serving the map. Existing databases
   created before the `source` column existed need
   `supabase/add-source-column.sql` run once (non-destructive `alter table
   ... add column if not exists`).
4. `src/app/api/history/route.ts` — reads the last 48h for one station
   (`?station=<SCODE>`) straight from Supabase via the REST API (no
   `@supabase/supabase-js` dependency, just `fetch`).
5. `src/components/WindHistoryPanel.tsx` — the **"Verlaufsbalken"** (the
   project owner's reference name for this feature; use it when they ask to
   change "den Verlaufsbalken"). A full-width panel pinned to the bottom of
   the screen, opened by clicking a station marker in `WindMap.tsx` (the
   marker's `click` handler calls `onSelect`, which sets `selectedStation`).
   It fetches `/api/history?station=<SCODE>` and draws an SVG chart of the
   last 48h: a **fixed** time axis from `now − 48h` to `now + 3h` (dashed
   "jetzt" marker near the right edge), a mean-wind (thin) and a gust (thick)
   curve over horizontal wind-scale color bands, and a row of wind-direction
   arrows below. Colors and arrow rotation deliberately reuse
   `getWindColor`/`WIND_COLOR_SCALE` and the map's `(direction + 180) % 360`
   convention so the panel and the map markers can never drift apart. The
   chart is wider than the viewport (horizontally scrollable, auto-scrolled
   to "now" on open); two points are only joined into a line when ≤ 3h apart
   (`LINE_GAP_MS`) to stay robust even if the Supabase cron for `/api/collect`
   runs less often than configured, and every
   measurement is also drawn as a dot so sparse data stays visible. Loading /
   error / "Keine Daten verfügbar" states are handled.

6. `supabase/functions/fetch-wind-forecasts/index.ts` — a **Supabase Edge
   Function** (Deno, not Next.js!) for phase 3: fetches ICON-CH1 wind
   forecasts from Open-Meteo (`models=meteoswiss_icon_ch1`, rolling window
   `past_hours=24` + `forecast_hours=4`, `wind_speed_unit=kmh`,
   `timeformat=unixtime` so times are unambiguous UTC) for every station
   that has wind sensors and coordinates — derived from the same two Bozen
   webservice calls as `/api/wind`, **plus** South Tyrol's OpenWindMap
   stations (`loadOpenWindMapStations()`, same bounding-box filter as
   `src/lib/pioupiou.ts` but duplicated here since Deno can't import from
   `src/lib`; additive — a failed Pioupiou fetch just means no forecasts
   for those stations, the Bozen ones still run) — and upserts into the
   table `wind_forecasts` (schema in `supabase/forecast-schema.sql`;
   `on_conflict=station_code,model,forecast_time`, 7-day retention). The
   `model` column exists so ICON-D2 can later be added as extra rows, no
   schema change. Stations are queried in batches of 50 (comma-separated
   coordinates; the response list has the same order as the request) and
   hours where Open-Meteo returns only nulls (station at/outside the model
   edge) are skipped. Triggered hourly at minute 10 by pg_cron + pg_net
   (`supabase/forecast-cron.sql`; project URL + service_role key live in
   Supabase Vault, never in the repo). Auth mirrors `/api/collect`: POST
   with `Authorization: Bearer <service_role key>` or 401 — deploy the
   function with JWT verification **disabled** since it does its own check.
   Because this is Deno code, `supabase/functions` is excluded in
   `tsconfig.json` and ignored in `eslint.config.mjs`; `WIND_API_BASE_URL`,
   `OPEN_METEO_BASE_URL` and `PIOUPIOU_API_BASE_URL` allow pointing all
   upstreams at a local mock for testing (the function also runs under
   Node if you provide a tiny `Deno.env`/`Deno.serve` shim before importing
   it).
7. `src/lib/pioupiou.ts` — shared logic (used by `/api/wind` and
   `/api/collect`, but *not* importable by the Deno edge function, see
   above) that fetches `https://api.pioupiou.fr/v1/live/all` (all stations
   worldwide, no region filter) and keeps only those inside a rough South
   Tyrol bounding box (`SOUTH_TYROL_BBOX`: lat 46.2–47.1, lng 10.3–12.5 —
   adjust here if needed). Station codes are prefixed `pioupiou-<id>` to
   avoid colliding with Bozen SCODEs. Internal unit is km/h for both
   sources — Pioupiou's API docs say `wind_speed_avg`/`wind_speed_max` are
   already km/h, so `toKmh()` here is currently a no-op, kept as a single
   named conversion point in case that assumption turns out wrong (outbound
   requests to `api.pioupiou.fr` are blocked in some sandboxes, so this
   couldn't be verified against live data during development — sanity-check
   displayed values against a known windy day after deploying). Staleness
   reuses the same 2h/missing-value rule as Bozen stations (battery-powered
   sensors that don't report continuously). `PIOUPIOU_API_BASE_URL`
   overrides the endpoint for local mock testing. The `/live/all` fetch is
   cached 60s via `next: { revalidate: 60 }` (same duration as the Bozen
   sensors fetch in `/api/wind`); this is harmless for `/api/collect` too —
   it runs every 10 min and stores the station's own measurement timestamp,
   with the upsert absorbing duplicates.

**Upstream API quirks worth knowing before touching `/api/wind` or
`/api/collect`:**
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
  `/api/collect` replace the `CEST`/`CET` suffix with a numeric UTC
  offset (`toIsoTimestamp`) before returning or storing it — keep these two
  in sync if the conversion logic changes.
- A station only ends up in `/api/wind`'s output if it has wind sensors
  **and** resolvable coordinates; stations with sensors but no metadata
  match are dropped rather than shown at an unknown location.

**Secrets:** `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are required by
`/api/history` and `/api/collect`, and `CRON_SECRET` guards `/api/collect`
— all as Vercel environment variables; never hardcode them or the
webservice URL override; see the README's setup table.

**Sandboxed dev environments:** outbound requests to
`daten.buergernetz.bz.it`, `tile.openstreetmap.org`, `api.pioupiou.fr`, and
Supabase may be blocked by network policy in some sandboxes. When that's
the case, `/api/wind` and `/api/history` will return their real error
responses (502/500) rather than throwing — this is expected there, not a
bug. Set `WIND_API_BASE_URL` / `PIOUPIOU_API_BASE_URL` to a local mock HTTP
server to test the route logic without live network access.

**License requirement:** OpenWindMap's free Community License requires a
visible credit with a link wherever its data is shown. That lives in the
site footer, `src/app/page.tsx` — "Winddaten © contributors of the
OpenWindMap wind network, openwindmap.org" — don't remove it while
OpenWindMap stations are displayed.
