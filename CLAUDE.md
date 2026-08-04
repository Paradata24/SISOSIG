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
  1. Südtirol: Live-Wind + 12h-Historie auf Karte (aktuell in Arbeit)
  2. Erweiterung auf weitere Länder/Regionen (Schweiz, Österreich)
  3. Prognosevergleich mehrerer Modelle via Open-Meteo API (aktuell im
     Diagramm: ICON-CH1 vs. AROME; ICON-D2 wird weiter gesammelt)

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
Tyrol weather stations on a Leaflet map, plus a 12h history backed by
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
   colored by speed on a **continuous gradient** (originally a 6-step scale
   agreed with the project owner via a legend screenshot, later turned into a
   smooth per-km/h blend at the owner's request — see `WIND_COLOR_SCALE`/
   `getWindColor` in `src/lib/wind.ts`). The scale's anchor points: flat light
   blue 0–5 → green 15 → yellow-green 20 (extra anchor so the color visibly
   turns toward yellow starting around 20 km/h, not just at 25) → yellow 25 →
   orange 30 → dark red 35 → black 45 (`Y_MAX_KMH`, the chart's y-axis
   ceiling); `getWindColor()` linearly mixes the RGB values between whichever
   two anchors bracket the given speed, so every whole km/h gets its own
   color instead of a hard step. The top two anchors were earlier lowered
   from 31/37 to 30/35, and the flat light-blue stretch was shortened from
   0–7 to 0–5, both at the owner's request — that history now lives in the
   anchor list itself. The
   lowest step deliberately deviates from the original screenshot: it is a
   very light blue instead of white, because a white arrow would be invisible
   on a light map background — don't change it back to white (the owner
   explicitly asked for light blue and against adding an arrow outline).
   Stations
   whose `stale` flag is set (missing reading or measurement older than 2h)
   get a gray dot instead. There is no on-map legend overlay any more (the
   former `WindLegend.tsx` was removed). It's loaded via `WindMapLoader.tsx`
   (`next/dynamic`, `ssr: false`) because Leaflet needs `window` — Next 16
   no longer allows `ssr: false` directly inside a Server Component, so the
   dynamic import must live in its own `"use client"` wrapper. The map
   itself offers two base layers via Leaflet's `LayersControl` (Standard
   OSM tiles vs. an Esri hillshade + CARTO place-name overlay); markers are
   rendered outside the base-layer group so they stay visible on both.
   Top-left `StationFilterToggle` offers three mutually-exclusive station
   filters: **"Windanzeiger"** (shows only the curated list of stations the
   owner picked — `WINDANZEIGER_STATION_NAMES`/`isWindanzeigerStation` in
   `src/lib/wind.ts`, matched by name — accent/umlaut- and whitespace-insensitive
   via `normalizeStationName`; currently Rittner Horn, Schöntaufspitze, Wilder
   Freiger, Lengspitze, Piz Pisciadù, Plose, Pfelders Raujoch; add a station
   there) and the two altitude thresholds (>2000 m / >3000 m).
3. `src/app/api/collect/route.ts` — a **POST** API route triggered by
   **Supabase Cron** (formerly a GitHub Actions workflow, now removed),
   configured for **every 10 minutes** and covering both sources (Bozen +
   OpenWindMap). It re-fetches the same upstream APIs as `/api/wind`
   (Bozen webservice + `fetchOpenWindMapStations()`, the latter additive —
   a failed Pioupiou fetch doesn't block the Bozen rows), upserts rows into
   the Supabase table `wind_measurements` (schema in `supabase/schema.sql`,
   including a `source` column so each row's origin is known), and deletes
   rows older than 2 days (`RETENTION_DAYS`), then answers with a small JSON summary
   (`{ ok, saved, ... }`). It is guarded by a bearer token: callers must
   send `Authorization: Bearer <CRON_SECRET>` or the route returns 401
   (`CRON_SECRET` is a Vercel env var). This deliberately reuses the same
   sensor-parsing logic as `/api/wind` but is a separate route because it
   *writes* to Supabase rather than serving the map. Existing databases
   created before the `source` column existed need
   `supabase/add-source-column.sql` run once (non-destructive `alter table
   ... add column if not exists`).
4. `src/app/api/history/route.ts` — reads the last `HISTORY_HOURS` (12h) for one
   station (`?station=<SCODE>`) straight from Supabase via the REST API (no
   `@supabase/supabase-js` dependency, just `fetch`). `/api/forecast` mirrors it
   and additionally caps the upper end at `now + FUTURE_MARGIN_HOURS` so the
   edge function's deliberate extra forecast hours don't land outside the chart
   axis. It serves exactly the two models the panel draws: `entries` =
   `model='icon_ch1'` (required) and `entriesArome` = `model='arome'`
   (additive, its own catch — a station outside the AROME area just returns an
   empty list). `model='icon_d2'` rows keep being collected but are no longer
   queried or delivered. **Both window constants live in one place**, `HISTORY_HOURS` /
   `FUTURE_MARGIN_HOURS` in `src/lib/wind.ts` — the two API routes and the panel
   import them from there; don't reintroduce local copies.
5. `src/components/WindHistoryPanel.tsx` — the **"Verlaufsbalken"** (the
   project owner's reference name for this feature; use it when they ask to
   change "den Verlaufsbalken"). A full-width panel pinned to the bottom of
   the screen, opened by clicking a station marker in `WindMap.tsx` (the
   marker's `click` handler calls `onSelect`, which sets `selectedStation`).
   It fetches `/api/history?station=<SCODE>` **and** `/api/forecast` (additive:
   a failed forecast never blocks the measurements) and draws an SVG chart of
   the last 12h: a **fixed** time axis from `now − 12h` to `now + 4h` (dashed
   "jetzt" marker near the right edge), a mean-wind (thin) and a gust (thick)
   curve over a horizontal wind-scale color gradient (an SVG `<linearGradient>`
   built from `WIND_COLOR_SCALE`'s anchor points, not separate flat bands
   anymore), and a row of wind-direction arrows below. The area **between the
   two measurement curves** (gust above, mean wind below) is filled white at
   50% opacity (`buildBandPath`, `fill-zinc-900/50 dark:fill-zinc-100/50` —
   added at the owner's request after having been removed earlier; the band
   breaks at the same gaps as the lines, see `LINE_GAP_MS`). There is still
   deliberately **no fill anywhere else** — not between the two curves of a
   forecast model and not between measurement and forecast. **Draw order:**
   measurement band → measurement curves + dots → the two forecast models, so
   the forecasts sit in the **foreground** where they overlap the measurement
   (owner's decision; it used to be the other way round). In every pair the
   **upper (gust) curve is ~15% thicker** than its mean-wind curve
   (`GUST_LINE_WIDTH = LINE_WIDTH * 1.15`), for measurement, ICON-CH1 and
   AROME alike. Below the
   measurement arrows, each measured number (mean wind on top, gust below) sits
   in a **square (`MEAS_BOX_W === MEAS_BOX_H`, no rounded corners — owner's
   decision, don't reintroduce `rx`) filled with its own `getWindColor(value)`**
   (`MEAS_BOX_*` constants; `contrastTextColor()` switches the digits to white
   on the dark red/black steps), and below those two rows the hour labels are
   repeated. **The forecast numbers sit in exactly the same squares** — one
   shared `ValueBox` component draws measurement and forecast cells, so the two
   rows can't drift apart. Unlike the measurement row, the forecast comparison
   row has **no arrow row of its own above it** — each model's direction arrow
   sits directly beside its own square pair instead (CH1's arrow to the left of
   the CH1 pair, AROME's arrow to the right of the AROME pair; the pairs
   themselves stay `FORECAST_PAIR_HALF_GAP` apart, CH1 left / AROME right of
   each hour, same as before). The squares have **no colored border** (removed
   again at the owner's request — model identity is now shown by arrow color
   and position, not a ring around the number); `CH1_COLOR`/`AROME_COLOR` only
   tint the "–" placeholder text for hours with a missing value. Dropping the
   forecast arrow row saves `ARROW_ROW_H + VALUES_GAP` of panel height. Box size
   and font were raised ~10% (15 → `MEAS_BOX_H` 16.5 px, 10 → 11 px) and
   `VALUES_GAP` shrank (8 → 4) so the numbers sit closer under their arrows;
   `MEAS_BOX_GAP_X` was lowered by the same amount the boxes grew (13.5 → 12) so
   the column spacing — and with it the whole panel width — stayed unchanged.
   Because a forecast arrow can now overhang the time axis by up to
   `FORECAST_ARROW_CX_OFFSET + ARROW_SIZE / 2` on **either** side (CH1's arrow
   sticks out past the left edge of its hour, AROME's past the right edge),
   both the left and right inner padding of the SVG are widened to `AXIS_PAD`
   (`Math.max(PAD_X, …)`) — asymmetric `RIGHT_PAD`-only padding stopped being
   enough once arrows moved outward on both sides. The color gradient
   (measurement chart background) still uses the smaller `PAD_X`/`bandWidth`,
   since only the forecast row below needs the wider margin — otherwise the
   outermost arrows get clipped.
   Three layers can appear: **black** = measurement, **red** =
   ICON-CH1 ground-wind forecast, and **yellow `#FFD400`** = AROME ground-wind
   forecast (`/api/forecast`'s `entriesArome`, same representation as the red
   CH1 layer — the two share one comparison row below the measurement row,
   CH1 left / AROME right of each hour). The yellow layer replaced a blue
   ICON-D2 layer at the owner's request; ICON-D2 is still collected into the
   database, it is only no longer drawn. Its color is a hard-coded hex constant
   (`AROME_COLOR`) rather than a Tailwind class so curve, dots, arrows and
   numbers match exactly. A former fourth layer
   (blue dashed "Höhenwind", upper-air wind on a pressure level) was removed
   again — don't reintroduce it without asking. Colors and arrow rotation deliberately reuse
   `getWindColor`/`WIND_COLOR_SCALE` and the map's `(direction + 180) % 360`
   convention so the panel and the map markers can never drift apart. The
   The y-axis is **fixed** at 0–45 km/h (`Y_MAX_KMH` in the panel, owner's
   decision) — it used to grow with the data, which made calm and stormy days
   look identical. `y()` clamps to that ceiling, so higher values ride along
   the top edge instead of overflowing into the time-label row; the numbers
   under the arrows and the arrow colors still use the true (uncapped) values.
   Its labels are the wind-scale gradient's anchor points (`WIND_COLOR_SCALE[].label`
   — 0/5/15/20/25/30/35, plus `Y_MAX_KMH` on top), not round 10-steps, so each
   number sits exactly where the gradient is pinned to one of the agreed
   colors; they follow the scale automatically if it's ever edited.
   Dashed **horizontal threshold lines** (`THRESHOLD_LINES_KMH` in the panel,
   currently 5/15/25 km/h) cross the chart so it's obvious at a glance when a
   curve passes those speeds; they're drawn above the gradient but below every
   curve, and carry no label of their own since the same numbers already sit on
   the y-axis. Add or remove a threshold by editing that one array.
   The
   chart is wider than the viewport (horizontally scrollable, auto-scrolled
   to "now" on open) — its horizontal density has **one knob**,
   `MEAS_BOX_GAP_X` (the gap between two neighbouring value squares);
   `COLUMN_SPACING`, `MIN_LABEL_SPACING` and `HISTORY_PX_PER_HOUR` /
   `FUTURE_PX_PER_HOUR` all derive from it, so widening or tightening the whole
   Verlaufsbalken means editing that one constant; two points are only joined into a line when ≤ 1h apart
   (`LINE_GAP_MS` — 6× the 10-minute collection interval, so a missed cron run
   still connects, but a real gap stays visible on the short 12h axis), and every
   measurement is also drawn as a dot so sparse data stays visible. Loading /
   error / "Keine Daten verfügbar" states are handled. A forecast model with no
   data for the selected station (AROME's model edge, e.g. the western
   Vinschgau) simply yields no points: empty path, no dots, no arrows/numbers
   in its half of the forecast row — never a line pinned to 0 km/h and never an
   error state.
   **Measurement times are snapped to a fixed 10-minute display grid**
   (`snapPointsToGrid`/`GRID_MS`, anchored on the local full hour, so the
   columns land on :00/:10/:20 … in any timezone): per 10-minute slot exactly
   one point survives — the real measurement closest to that slot (≤5 min off),
   preferring one that actually has values. Reason: Bozen stations already
   report on that grid, but the OpenWindMap/Pioupiou stations send at arbitrary
   times (:03, :17, :26 …), which made their arrows and value squares sit
   unevenly and the thinning drop columns at random. Nothing is invented — a
   slot without a measurement stays an empty gap — and the arrow tooltip still
   shows the **real** measurement time (`Point.tActual`). With that grid the
   `MIN_LABEL_SPACING` thinning never actually triggers for measurements; it
   stays as a safety net.

6. `supabase/functions/fetch-wind-forecasts/index.ts` — a **Supabase Edge
   Function** (Deno, not Next.js!) for phase 3: fetches ground-wind
   forecasts from Open-Meteo for **three models** (`SURFACE_MODELS`) — ICON-CH1
   (`meteoswiss_icon_ch1`, DB `model='icon_ch1'`, red in the panel), ICON-D2
   (`dwd_icon_d2`, DB `model='icon_d2'`, collected but no longer drawn) and
   **AROME from GeoSphere Austria** (`geosphere_arome_austria`, DB
   `model='arome'`, yellow). The AROME model id is the **Austrian** one, taken
   from Open-Meteo's model list — the French `arome_france`/`arome_france_hd`
   domains don't cover South Tyrol; don't swap them in. All three models go out
   in **one request per station batch** (`models=a,b,c`, owner's requirement —
   don't split it back into one call per model). With several models Open-Meteo
   suffixes each variable with the model name
   (`wind_speed_10m_dwd_icon_d2`, …) while `hourly.time` stays shared; the
   `hourlySeries()` helper reads the suffixed key and falls back to the plain
   one. `fetchForecastBatch(batch, fetchedAt)` then emits rows for every model
   (rolling window `past_hours=12` + `forecast_hours=7` — the latter is
   deliberately larger than the panel's 4h look-ahead because Open-Meteo counts
   from the current full hour and this function only runs hourly, so the newest
   stored data can be nearly an hour old; `wind_speed_unit=kmh`,
   `timeformat=unixtime` so times are unambiguous UTC) for every station
   that has wind sensors and coordinates — derived from the same two Bozen
   webservice calls as `/api/wind`, **plus** South Tyrol's OpenWindMap
   stations (`loadOpenWindMapStations()`, same bounding-box filter as
   `src/lib/pioupiou.ts` but duplicated here since Deno can't import from
   `src/lib`; additive — a failed Pioupiou fetch just means no forecasts
   for those stations, the Bozen ones still run) — and upserts into the
   table `wind_forecasts` (schema in `supabase/forecast-schema.sql`;
   `on_conflict=station_code,model,forecast_time`, 2-day retention). Its
   `PAST_HOURS`/`FORECAST_HOURS`/`RETENTION_DAYS` mirror `HISTORY_HOURS` /
   `FUTURE_MARGIN_HOURS` (`src/lib/wind.ts`) and `/api/collect`'s
   `RETENTION_DAYS` — Deno can't import from `src/`, so change both sides. The
   `model` column is what lets extra models be added as extra rows, **no schema
   change** — that's how AROME was added. Stations are queried in batches of 50
   (comma-separated coordinates; the response list has the same order as the
   request) and hours where Open-Meteo returns only nulls for a model (station
   at/outside that model's edge — AROME's western edge cuts through the
   Vinschgau) are skipped for that model only; the other models still get their
   rows, and the panel simply draws no yellow line there. An **upper-air wind (Höhenwind)** branch used to live here
   (pressure levels from ICON-D2 for the Windanzeiger stations, stored as
   `model='icon_d2_upper'`); it was removed again together with the panel layer
   — `supabase/remove-upper-wind.sql` is the optional one-off cleanup for
   databases that still hold those rows/columns. Triggered hourly at minute 10 by pg_cron + pg_net
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

**Dunkelmodus (dark mode):** the site runs permanently in dark mode, on the
owner's request — never depending on the visitor's OS setting. Two pieces make
that work: `@custom-variant dark (&:where(.dark, .dark *))` in
`src/app/globals.css` rebinds all Tailwind `dark:` utilities from the default
`@media (prefers-color-scheme: dark)` to a CSS class, and `<html>` in
`src/app/layout.tsx` carries that `dark` class unconditionally (plus
`color-scheme: dark` in `:root` for scrollbars, and a `viewport.themeColor` for
the mobile browser bar). So components keep their light base classes and their
`dark:` counterparts; making the theme switchable later means only toggling the
class in `layout.tsx`. Surfaces: page/header/footer/Verlaufsbalken `zinc-900`
(**not** pure black — the owner asked for dark gray), raised surfaces like the
menu popover `zinc-800`, its inactive buttons `zinc-700`.
Two things are deliberately **excluded** from dark mode and must stay light
(explicit owner decisions, don't "fix" them):
- **The map itself** — tile layers, wind-arrow markers, the white text halo and
  `#1f2937` label color in `createWindIcon`, stale-station dots, the selection
  ring and `STAATSGRENZE_STYLE` in `src/components/WindMap.tsx`, plus Leaflet's
  own attribution chrome. The dark "Zuletzt aktualisiert" badge sitting on the
  light map is intentional.
- **`WIND_COLOR_SCALE`** in `src/lib/wind.ts` — all anchor colors unchanged,
  including the black "zu stark" anchor. Known accepted trade-off: black
  arrows and value boxes are hard to see inside the dark Verlaufsbalken.
The Verlaufsbalken legend therefore says "**weiss**: Messung" (not "schwarz"),
because the measurement curve is drawn `dark:stroke-zinc-100`.

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
