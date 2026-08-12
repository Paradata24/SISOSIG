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
     Diagramm: ICON-CH1; ICON-D2 wird weiter gesammelt, AROME wurde auf
     Wunsch komplett entfernt)

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
npm run dev          # dev server (Next 16 → Turbopack), http://localhost:3000
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
   "Zwischenspeicherung (Caching)". The response is sorted by station name;
   an optional `?station=CODE1,CODE2` narrows it down (for testing/debugging,
   works with `pioupiou-…` codes too). The three upstream fetches (`/sensors`,
   `/stations`, Pioupiou) are independent and run **in parallel** via one
   `Promise.all` over three small helpers that never reject (`fetchSensors`,
   `fetchStationMeta`, `fetchOpenWindMapSafely`) — don't serialize them back
   into sequential `await`s, that made a cache-miss run cost the sum of all
   three. Output `lat`/`lng` are rounded to 5 decimals (~1 m) by `round5()`
   (same in `src/lib/pioupiou.ts`).
2. `src/app/page.tsx` → `src/components/WindApp.tsx` → `WindMapLoader.tsx` →
   `src/components/WindMap.tsx` — the client UI, in that order.
   `page.tsx` is a thin Server Component: page shell (`h-dvh` flex column) and
   `<WindApp />`. It used to carry an OpenWindMap credit footer below the
   Zeitbalken; the owner had it removed and wants the source credit solved
   differently later (see "Quellenangabe" below).
   **`WindApp.tsx`** draws the title bar ("Should I stay or should I go") and,
   at its right edge, a square hamburger button that opens a popover menu
   holding **both** settings: **"Karte"** (base layer — `Relief (Grau)` = Esri
   hillshade + CARTO place-name overlay, the default, vs. `Standard` OSM tiles)
   and **"Stationen"** (station filter — `Alle`, `>2000 m`, `>3000 m`,
   `Windanzeiger`, mutually exclusive). Both values live as state here, not
   inside `WindMap`, and are handed down as props (`BaseLayer` /
   `StationFilter`, typed in `src/lib/wind.ts` together with the altitude
   thresholds so menu labels and filter logic can't drift apart). Leaflet's own
   `LayersControl` and the former top-left `StationFilterToggle` are gone —
   everything is that one menu now, and the map runs with
   `zoomControl={false}`. The popover closes on a `pointerdown` outside it
   (covers mouse and touch); its buttons are deliberately square (no rounded
   corners), matching the menu button.
   The **"Windanzeiger"** filter shows only the curated list of stations the
   owner picked — `WINDANZEIGER_STATION_NAMES`/`isWindanzeigerStation` in
   `src/lib/wind.ts`, matched by name, accent/umlaut- and whitespace-insensitive
   via `normalizeStationName`; currently Rittner Horn, Schöntaufspitze, Wilder
   Freiger, Lengspitze, Piz Pisciadù, Plose, Pfelders Rau(h)joch (both
   spellings are listed because the "h" is not normalized away), Graun
   Elferspitze, Pfunders Dannelspitz. Add a station there.
   `WindApp` also owns the **Zeitbalken** state (see `TimeSlider.tsx` below):
   `slots` (the 10-min grid from `buildTimelineSlots`, refreshed by a 60s
   interval that idles while the tab is hidden), `selectedTime` (**the time,
   not the slider index** — the slot list scrolls forward every 10 min, so an
   index would silently drift; `null` = live), the lazily fetched
   `TimelinePayload` and `ensureTimeline()`. The frame handed down to the map
   is `buildTimelineFrame(timeline, useDeferredValue(clampedTime))` — the
   `useDeferredValue` is what keeps the time label snappy while ~130 markers
   redraw during a fast drag; don't remove it. `ensureTimeline` guards with two
   **refs** (`timelineLoading`, `timelineFetchedAt`) rather than state on
   purpose: during a drag it is called many times before React re-renders, and
   a state value would still be the old one there (that bug caused three
   parallel `/api/timeline` fetches). The out-of-range clamp
   (`clampedTime`) is derived during render, not set in an effect — the
   `react-hooks/set-state-in-effect` lint rule rejects the effect version.
   **`WindMap.tsx`** (client component) polls `/api/wind` every **3 minutes**
   (`POLL_INTERVAL_MS`, raised from 90s at the owner's request since stations
   only measure every 5-10 min) and additionally refetches as soon as the tab
   becomes visible again (`visibilitychange`, e.g. phone unlocked) — that
   refresh, not the interval, is what makes it feel live, so don't lower the
   interval again to "fix" freshness. The interval also **skips fetching
   entirely while `document.visibilityState === "hidden"`**, so a
   backgrounded tab costs no mobile data. A failed
   *background* refresh keeps the last known markers on the map — only the very
   first load may replace them with an error banner. It renders one marker per
   station: a rotating SVG arrow whose **fill = mean wind** and **stroke =
   gust** (both through the same color scale), with the rounded
   "mean / gust" numbers underneath (white text halo so they stay legible on any
   tile). The arrow direction is snapped to the 8 main compass points
   (`snapDirectionTo8`) and turned by +180°, so it points where the wind blows
   *to*. Marker size scales continuously with the zoom level (`getIconScale`,
   with `MIN_ICON_SCALE` as floor so the map doesn't drown in arrows when zoomed
   out) instead of using a fixed pixel size, and is multiplied by
   `getFilterScaleBoost(stationFilter)`: as soon as the station filter is
   anything other than `Alle`, arrows *and* their numbers grow by 25 %
   (`FILTERED_ICON_SCALE_BOOST`, owner's request — fewer markers on screen, so
   there is room for bigger ones). That's the only reason `WindMarkers` takes
   the `stationFilter` prop; the selection ring scales with it automatically
   since it derives from the same `scale`. Clicking a marker opens the
   Verlaufsbalken and draws a black `CircleMarker` ring around that station
   (radius covers arrow *and* its number label); the panel reads its station
   from `stations` by code on every render, so the "Stand" timestamp keeps
   updating with each background refresh. A GeoJSON overlay of the national
   borders (`src/data/staatsgrenzen.json`, `STAATSGRENZE_STYLE`) and the
   "Zuletzt aktualisiert" badge (bottom left) complete the map. When the
   Zeitbalken is off "jetzt" that badge is simply **hidden** — an amber
   "Verlauf: HH:MM Uhr" badge stood there for a while and was removed at the
   owner's request; the Zeitbalken itself already shows the selected time.
   Don't reintroduce it without asking.
   The `historyFrame` prop (from `WindApp` via `WindMapLoader`) is applied in
   `displayStations`, a `useMemo` that runs **after** `visibleStations` (filter
   first, then replace — a few dozen objects per step instead of ~130). It
   swaps only `direction`/`speedKmh`/`gustKmh`/`timestamp` and recomputes
   `stale` with the same rule as `/api/wind` (`direction === null ||
   speedKmh === null`). **It must never add, drop or reorder stations**: a
   station with no measurement at that slot becomes a gray dot, it is *not*
   filtered out, because `handlersByCode` below is keyed on the joined station
   codes and would otherwise rebuild all ~130 Leaflet listeners on every
   10-minute step. `selectedStation` (for the Verlaufsbalken) deliberately
   still comes from the live `stations` list, so the panel's "Stand:" stays
   real and scrubbing triggers no refetch there.
   **Marker rendering is memoized and must stay that way**: react-leaflet
   calls `marker.setIcon()` whenever the `icon` prop is a new object, and
   Leaflet's `DivIcon` then re-parses that marker's `innerHTML`. Building
   icons inline meant doing that for all ~130 markers on *every* poll.
   `getMarkerIcon()` therefore hands back the *same* `L.DivIcon` instance for
   an unchanged (stale | direction, speed, gust, scale) tuple, from a
   module-level LRU `iconCache` capped at `ICON_CACHE_LIMIT` (800). The key
   uses the **displayed** values — `snapDirectionTo8(direction)` and rounded
   speed/gust — not the raw ones: the icon depends on nothing else, and with
   raw values like `137.4°` scrubbing the Zeitbalken would practically never
   hit the cache. The click
   handlers are memoized the same way (`handlersByCode`, keyed on the joined
   station codes), which is why `WindMarkers`' `onSelect` takes a plain
   `stationCode: string` rather than the whole station object.
   The arrow color comes from **discrete color bands** — one flat color per
   speed range, no blending (`WIND_COLOR_SCALE`/`getWindColor` in
   `src/lib/wind.ts`). The bands, exactly as specified by the owner: 0–10 km/h
   light blue → 11–20 green → 21–25 yellow → 26–30 orange → 31+ red (the exact
   hex tones were matched to a reference scale the owner supplied; the band
   boundaries stayed put). Each entry
   carries only its inclusive upper bound (`upTo`, `null` = open-ended), so the
   ranges can't overlap or leave holes. `getWindColor()` rounds to whole km/h
   first, so a value's displayed number and its color always agree. This was a
   continuous per-km/h gradient (anchors at 0/5/15/20/25/30/35/45, mixed with
   `mixHexColors`) for a while and was turned back into hard steps at the
   owner's request — don't reintroduce the blend. The
   lowest step deliberately deviates from the original legend screenshot: it is
   a very light blue instead of white, because a white arrow would be invisible
   on a light map background — don't change it back to white (the owner
   explicitly asked for light blue and against adding an arrow outline).
   Stations
   whose `stale` flag is set (missing reading or measurement older than 2h)
   get a gray dot instead. There is no on-map legend overlay any more (the
   former `WindLegend.tsx` was removed). `WindMap` is loaded through
   `WindMapLoader.tsx` (`next/dynamic`, `ssr: false`) because Leaflet needs
   `window` — Next 16 no longer allows `ssr: false` directly inside a Server
   Component, so the dynamic import lives in its own `"use client"` wrapper
   that just passes the two props through. Switching the base layer swaps the
   `<TileLayer>`s (each with a `key`, so the old tiles and their attribution
   are fully removed); the markers are rendered outside that switch and stay
   visible on both. Tile URLs deliberately carry **no `{s}.` subdomain
   sharding** — that's an HTTP/1 workaround that under HTTP/2 only buys extra
   TLS handshakes, and OSM's tile policy now advises against it; don't add it
   back. `layout.tsx` carries `preconnect`/`dns-prefetch` hints for the tile
   hosts so the handshake happens while the JS is still downloading.
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
   ... add column if not exists`), and `supabase/add-measured-at-index.sql`
   for the index `/api/timeline` needs (also non-destructive; both are already
   in `schema.sql` for fresh installs).
4. `src/app/api/history/route.ts` — reads the last `HISTORY_HOURS` (12h) for one
   station (`?station=<SCODE>`) straight from Supabase via the REST API (no
   `@supabase/supabase-js` dependency, just `fetch`). `/api/forecast` mirrors it
   and additionally caps the upper end at `now + FUTURE_MARGIN_HOURS` so the
   edge function's deliberate extra forecast hours don't land outside the chart
   axis. It serves exactly the one model the panel draws: `entries` =
   `model='icon_ch1'`. `model='icon_d2'` rows keep being collected but are not
   queried or delivered; AROME (`model='arome'`) was removed entirely at the
   owner's request — don't reintroduce it without asking. **Both window
   constants live in one place**, `HISTORY_HOURS` /
   `FUTURE_MARGIN_HOURS` in `src/lib/wind.ts` — the two API routes and the panel
   import them from there; don't reintroduce local copies. Both successful
   responses carry a CDN `Cache-Control` (`s-maxage=60` for history,
   `s-maxage=120` for the hourly-refreshed forecast) so clicking back and
   forth between stations doesn't re-query Supabase every time; error
   responses deliberately get no header, same convention as `/api/wind`.
4b. `src/app/api/timeline/route.ts` — the same 12h window but for **all**
   stations at once, feeding the Zeitbalken. Returns a compact **columnar**
   `TimelinePayload` (typed in `src/lib/wind.ts`): one shared `times` array
   plus, per station code, three parallel arrays `d`/`s`/`g` with `null` for
   missing slots. Row-shaped JSON for ~130 stations × 73 slots would be several
   hundred KB; this is ~95 KB raw / ~15–25 KB compressed. Values are rounded to
   whole numbers — lossless for the map, which rounds anyway.
   Three things here are load-bearing and easy to break:
   (a) `export const dynamic = "force-dynamic"` — the route reads *nothing*
   from the request but its output depends on `Date.now()`, so without it Next
   is free to prerender it at build time and serve a frozen window;
   (b) the paging loop advances by the **actual** `page.length` and stops only
   on an **empty** page. Checking "page shorter than PAGE_SIZE" silently
   truncates the history as soon as Supabase's "Max rows" setting is below
   `PAGE_SIZE` (verified: with a 500-row cap the loop still returns all 9392
   rows). `MAX_PAGES` (30) is the runaway guard and sets `truncated` in the
   payload;
   (c) sorting is `measured_at.asc,station_code.asc`, which makes offset paging
   safe against concurrent writes — `/api/collect` inserts always carry the
   largest `measured_at` and append at the end, and its retention delete only
   touches rows outside the `gte` filter. Sorting `desc` would break that.
   Slot assignment reuses `snapToGrid` and the same "values beat empties, then
   nearest wins" rule as `snapPointsToGrid`. Same `Cache-Control` convention as
   `/api/history` (success only). Needs the `measured_at` index, see 3.
5. `src/components/WindHistoryPanel.tsx` — the **"Verlaufsbalken"** (the
   project owner's reference name for this feature; use it when they ask to
   change "den Verlaufsbalken"). A full-width panel pinned to the bottom of
   the **map area** — `absolute`, not `fixed`, because it lives inside
   `WindMap`'s `relative h-full w-full` wrapper and must leave the Zeitbalken
   visible below it (don't turn this back into `fixed`; the dynamic loading
   skeleton in `WindMap.tsx` carries the same class, and the former
   `pb-[env(safe-area-inset-bottom)]` was dropped with the switch since the
   panel no longer touches the screen edge).
   Opened by clicking a station marker in `WindMap.tsx` (the
   marker's `click` handler calls `onSelect`, which sets `selectedStationCode`);
   closed via the X button or the Escape key. Its header line carries station
   name, altitude, "Stand: <measurement time>" and the color legend ("weiss:
   Messung · rot: Prognose (ICON-CH1)"), the footer the "Quelle:" link
   (`SOURCE_INFO`).
   It is **code-split into its own chunk** (`next/dynamic` via
   `loadHistoryPanel` in `WindMap.tsx`) so it isn't part of the Leaflet chunk
   that gates the first map paint — many visitors never open it. `WindMap`
   then prefetches that chunk on `requestIdleCallback` (with a `setTimeout`
   fallback for older Safari), so it is in practice already loaded by the time
   anyone clicks and the `loading` bar never shows. Don't turn this back into
   a plain static import.
   It fetches `/api/history?station=<SCODE>` **and** `/api/forecast` (additive:
   a failed forecast never blocks the measurements) and draws an SVG chart of
   the last 12h: a **fixed** time axis from `now − 12h` to `now + 4h` (dashed
   "jetzt" marker near the right edge), a mean-wind (thin) and a gust (thick)
   curve over the wind scale's **flat color bands** (one `<rect>` per band from
   `COLOR_BANDS`, hard edges, `BAND_OPACITY` 0.55 — this was an SVG
   `<linearGradient>` for a while and went back to bands at the owner's
   request), and a row of wind-direction arrows below. The area **between the
   two measurement curves** (gust above, mean wind below) is filled white at
   50% opacity (`buildBandPath`, `fill-zinc-900/50 dark:fill-zinc-100/50` —
   added at the owner's request after having been removed earlier). **Curves
   and band deliberately use different point sets** (owner's decision): the two
   measurement *curves* connect **only the full-hour points** (`hourlyPoints`,
   i.e. grid slots with minute 00) exactly like the hourly forecast curves, so
   measurement and forecast can be compared in the same raster and the line
   isn't blurred by 10-minute jitter; the *band* keeps following **every**
   10-minute value. Gaps are honest on both: a missing full hour breaks the
   curves (`LINE_GAP_MS` = 1h, so a 2h step can't be bridged), and a single
   missing 10-minute value tears the band (`BAND_GAP_MS` = one grid step —
   accepted side effect: a skipped `/api/collect` run now shows as a narrow
   gap). Both `buildLinePath` and `buildBandPath` take the allowed gap as a
   parameter. The **ICON-CH1 forecast has the same kind of band** between its
   own two curves, added at the owner's request: `buildBandPath(forecastPoints,
   …, LINE_GAP_MS)` filled with `CH1_COLOR` at `FORECAST_BAND_OPACITY` (0.5) —
   the red counterpart to the white measurement band. Its allowed gap is a full
   hourly step because the forecast only has one value per hour. There is still
   **no fill between measurement and forecast**: a red/blue "comparison area"
   between the two curve pairs existed briefly and was dropped again at the
   owner's request — don't reintroduce it without asking. **Draw order** (both
   bands first, then both curve pairs — owner's decision, don't regroup it back
   into two self-contained "band + its curves" blocks without asking):
   forecast band → measurement band → forecast curves → measurement curves. So
   the **measurement curves sit in the foreground** ("die Messung soll immer im
   Vordergrund sein") while the **red forecast curves stay in front of the
   white measurement band** — otherwise the 50%-opacity band washes them out.
   The order has been changed several times; treat it as a settled decision.
   In every pair the
   **upper (gust) curve is ~15% thicker** than its mean-wind curve
   (`GUST_LINE_WIDTH = LINE_WIDTH * 1.15`), for measurement and ICON-CH1
   alike. Below the
   measurement arrows, each measured number (mean wind on top, gust below) sits
   in a **square (`MEAS_BOX_W === MEAS_BOX_H`, no rounded corners — owner's
   decision, don't reintroduce `rx`) filled with its own `getWindColor(value)`**
   (`MEAS_BOX_*` constants; `contrastTextColor()` switches the digits to white
   on the dark red/black steps), and below those two rows the hour labels are
   repeated. Measured numbers **on the full hour are bold**, so they stand out
   from the 10-minute in-between values and line up visually with the (hourly)
   forecast row. **The forecast numbers sit in exactly the same squares** — one
   shared `ValueBox` component draws measurement and forecast cells, so the two
   rows can't drift apart. Unlike the measurement row, the forecast row has
   **no arrow row of its own above it** — the direction arrow sits directly to
   the left of the square pair instead, while the pair itself is centred under
   its hour. The squares have **no colored border** (removed
   again at the owner's request); `CH1_COLOR` only
   tints the "–" placeholder text for hours with a missing value. Dropping the
   forecast arrow row saves `ARROW_ROW_H + VALUES_GAP` of panel height. Box size
   and font were raised ~10% (15 → `MEAS_BOX_H` 16.5 px, 10 → 11 px) and
   `VALUES_GAP` shrank (8 → 4) so the numbers sit closer under their arrows;
   `MEAS_BOX_GAP_X` was lowered by the same amount the boxes grew (13.5 → 12) so
   the column spacing — and with it the whole panel width — stayed unchanged.
   Because the forecast arrow overhangs the time axis by
   `FORECAST_ARROW_CX_OFFSET + ARROW_SIZE / 2` on the left, the inner padding
   of the SVG is widened to `AXIS_PAD` (`Math.max(PAD_X, …)`) on both sides
   (symmetric, even though only the left side needs it). The color gradient
   (measurement chart background) still uses the smaller `PAD_X`/`bandWidth`,
   since only the forecast row below needs the wider margin — otherwise the
   outermost arrows get clipped.
   Two layers can appear: **black** = measurement and **red** =
   ICON-CH1 ground-wind forecast (`/api/forecast`'s `entries`), which gets one
   value row below the measurement row. A former yellow AROME layer
   (`#FFD400`) was removed again at the owner's request ("brauche ich nicht"),
   as was a blue ICON-D2 layer before it; ICON-D2 is still collected into the
   database, it is only not drawn, while AROME is no longer collected at all.
   A former fourth layer
   (blue dashed "Höhenwind", upper-air wind on a pressure level) was removed
   again — don't reintroduce it without asking. Colors and arrow rotation deliberately reuse
   `getWindColor`/`WIND_COLOR_SCALE` and the map's `(direction + 180) % 360`
   convention so the panel and the map markers can never drift apart. The
   The y-axis is **fixed** at 0–45 km/h (`Y_MAX_KMH` in the panel, owner's
   decision) — it used to grow with the data, which made calm and stormy days
   look identical. `y()` clamps to that ceiling, so higher values ride along
   the top edge instead of overflowing into the time-label row; the numbers
   under the arrows and the arrow colors still use the true (uncapped) values.
   Its labels are the wind scale's band boundaries (`WIND_COLOR_SCALE[].upTo`
   — 0/10/20/25/30, plus `Y_MAX_KMH` on top), not round 10-steps, so each
   number sits exactly where the color changes; they follow the scale
   automatically if it's ever edited. That axis
   is **not** part of the SVG: it's a narrow HTML column to the right of the
   scroll container, so the numbers stay put while the chart scrolls
   horizontally.
   There are **no dashed horizontal threshold lines** any more — 5/15/25 km/h
   guides existed briefly (`THRESHOLD_LINES_KMH`) and were removed again at the
   owner's request; the band edges now do that job. Don't reintroduce them
   without asking.
   The
   chart is wider than the viewport (horizontally scrollable; on open it jumps
   to the right end, i.e. to "now") — its horizontal density has **one knob**,
   `MEAS_BOX_GAP_X` (the gap between two neighbouring value squares);
   `COLUMN_SPACING`, `MIN_LABEL_SPACING` and `HISTORY_PX_PER_HOUR` /
   `FUTURE_PX_PER_HOUR` all derive from it, so widening or tightening the whole
   Verlaufsbalken means editing that one constant; two points are only joined
   into a line when at most `LINE_GAP_MS` (1h, one hourly step) apart, and the
   band only when at most `BAND_GAP_MS` (10 min, one grid step) apart, so every
   real hole in the data stays visible on the short 12h axis. Measurements and
   forecast values used to be drawn as small dots on the curves as well; **both
   dot rows were removed** at the owner's request and replaced by **very thin
   vertical grid lines every 10 minutes** (`minuteTicks`, drawn first so hour
   lines, threshold lines and all curves stay on top; full hours are skipped
   because the stronger hour line already sits there). Loading /
   error / "Keine Daten verfügbar" states are handled. A forecast model with no
   data for the selected station (a station outside the model's edge) simply
   yields no points: empty path, no dots, no arrows/numbers in the forecast
   row — never a line pinned to 0 km/h and never an error state.
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
   **Render structure:** everything that depends only on the constants above
   (`chartTop`/`chartBottom`/`y()`/the box rows/`COLOR_BANDS`/`Y_TICKS`/
   `LINE_WIDTH`) lives at module scope and is computed once at import. The
   data-dependent half (grid snapping, tick arrays, thinning, all six SVG
   paths) sits in one `useMemo` keyed on `[entries, forecast, now, containerW]`
   and is destructured back into the original variable names so the JSX below
   stays untouched. This matters because the map re-renders this panel every
   poll (the `station` prop is a fresh object each poll, which is intentional —
   it keeps the "Stand:" timestamp live); without the memo the whole ~400-node
   chart was recomputed each time.

6. `supabase/functions/fetch-wind-forecasts/index.ts` — a **Supabase Edge
   Function** (Deno, not Next.js!) for phase 3: fetches ground-wind
   forecasts from Open-Meteo for **two models** (`SURFACE_MODELS`) — ICON-CH1
   (`meteoswiss_icon_ch1`, DB `model='icon_ch1'`, red in the panel) and ICON-D2
   (`dwd_icon_d2`, DB `model='icon_d2'`, collected but not drawn). A third
   model, AROME from GeoSphere Austria (`geosphere_arome_austria`, DB
   `model='arome'`), was removed again at the owner's request — it is no longer
   fetched or stored; `supabase/remove-arome-forecasts.sql` is the optional
   one-off cleanup for databases that still hold those rows. Both models go out
   in **one request per station batch** (`models=a,b`, owner's requirement —
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
   change** — that's how AROME was once added. Stations are queried in batches
   of 50 (comma-separated coordinates; the response list has the same order as
   the request) and hours where Open-Meteo returns only nulls for a model
   (station at/outside that model's edge) are skipped for that model only; the
   other model still gets its rows, and the panel simply draws no line
   there. An **upper-air wind (Höhenwind)** branch used to live here
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
8. `src/components/TimeSlider.tsx` — the **"Zeitbalken"** (the owner's
   reference name; use it when they ask to change "den Zeitbalken"). Its own
   fixed-height row in the page flex column, below `<main>` (the map) —
   deliberately **not** an overlay on the map: sitting outside the Leaflet
   container means Leaflet's drag/touch handlers can't swallow the slider
   gesture. Dragging it left makes
   the map show the recorded measurements of that moment instead of the live
   ones, in 10-minute steps over `HISTORY_HOURS`.
   It is a plain `<input type="range">` on purpose (reliable touch dragging,
   arrow keys = exactly one 10-min step, Home/End, no custom pointer math),
   styled via `.time-slider` in `globals.css`; `THUMB_PX` (22) is duplicated
   there and in the component because the hour ticks are inset by half a thumb
   to line up with it. The far-right position **is** "jetzt", so dragging back
   to the end returns to live with no extra tap; the "Jetzt" button does the
   same from anywhere. Hour labels are the bare padded hour — `de-DE`
   `toLocaleTimeString({hour:"2-digit"})` yields "08 Uhr", far too wide for the
   spacing on a phone. The slot list comes from the browser clock alone, so the
   bar renders at first paint, before any data exists.
   **Layout** (owner's request): top to bottom it is **range input → hour
   numbers → time/"Jetzt" row** — the slider sits directly under the map, its
   labelling below it. The input spans the **full width** (container `px-2`,
   the 8 px only keeping the round thumb off the screen edge). In the bottom
   row the time is **absolutely centred** (`absolute left-1/2
   -translate-x-1/2`), not a flex item — so it stays exactly under the middle
   of the slider no matter how wide the status hint on the left ("vor 3 h
   20 min" / "Verlauf wird geladen…") or the "Jetzt" button on the right
   happen to be. Verified at 320/390/1100 px: 0 px deviation. That row has a
   fixed `h-7` so nothing jumps while scrubbing, and the whole bar is ~73 px
   tall.
9. Shared 10-minute grid helpers in `src/lib/wind.ts`: `TIMELINE_STEP_MINUTES`,
   `GRID_MS`, `TIMELINE_SLOT_COUNT`, `snapToGrid`, `buildTimelineSlots`,
   `buildTimelineFrame` and the `Timeline*` types. `GRID_MS`/`snapToGrid` used
   to be module-private in `WindHistoryPanel.tsx` and moved here so panel,
   `/api/timeline` and the Zeitbalken share one grid; the panel's
   `LABEL_INTERVAL_MIN` now derives from `TIMELINE_STEP_MINUTES` (same value,
   so its column spacing is unchanged) instead of the other way round.
   `snapPointsToGrid` stayed in the panel on purpose — it produces *display*
   points with `tActual` for tooltips, while the route writes straight into
   columnar arrays and would only allocate ~9400 throwaway objects for nothing.
   `snapToGrid` anchors on the full **local** hour; server (UTC on Vercel) and
   visitors (CET/CEST) differ by whole hours, so both land on the identical
   lattice — and `buildTimelineFrame` looks slots up by nearest absolute time
   within half a step anyway, so the payload's `times` are authoritative rather
   than the browser's clock.

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
- **`WIND_COLOR_SCALE`** in `src/lib/wind.ts` — all band colors unchanged,
  including the red "zu stark" band.
The Verlaufsbalken legend therefore says "**weiss**: Messung" (not "schwarz"),
because the measurement curve is drawn `dark:stroke-zinc-100`.

**Font:** the whole site uses **Barlow Semi Condensed** (weights 400/700),
loaded via `next/font/google` in `src/app/layout.tsx` and wired into Tailwind
as `--font-sans` *and* `--font-mono` in `src/app/globals.css` — the narrow
letterforms are what keep the Verlaufsbalken's value squares readable at 11 px.

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

**Quellenangabe / License requirement (offen):** OpenWindMap's free Community
License requires a visible credit with a link wherever its data is shown. That
credit used to sit in the site footer, `src/app/page.tsx` — "Winddaten ©
contributors of the OpenWindMap wind network, openwindmap.org". The owner had
the footer removed and explicitly said the source credit will be solved
differently at a later point ("die Quellenangabe für die Winddaten machen wir
anders ein anderes mal"), so this is a known open item — mention it when
touching the topic, but don't re-add the footer unasked. The per-station
"Quelle:" link at the bottom of the Verlaufsbalken (`SOURCE_INFO`) is still
there.
