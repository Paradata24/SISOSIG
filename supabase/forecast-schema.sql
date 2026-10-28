-- Tabelle für Windprognosen (Phase 3: Prognosevergleich).
-- Einmalig im Supabase SQL-Editor ausführen.
--
-- Die Spalte "model" macht die Tabelle erweiterbar: ICON-CH1 speichert
-- 'icon_ch1', ein späteres zweites Modell (z. B. ICON-D2) kommt einfach
-- als zusätzliche Zeilen mit model = 'icon_d2' dazu — ohne Schemaänderung.

create table if not exists public.wind_forecasts (
  id bigint generated always as identity primary key,
  -- Stationscode (SCODE) des Bozner Wetterdienstes, derselbe Wert wie
  -- station_code in wind_measurements — darüber lassen sich Messung und
  -- Prognose einer Station später nebeneinander anzeigen.
  station_code text not null,
  -- Prognosemodell, z. B. 'icon_ch1' (später auch 'icon_d2').
  model text not null,
  -- Die Stunde (UTC), für die die Prognose gilt.
  forecast_time timestamptz not null,
  -- Einheiten wie in wind_measurements: Richtung in Grad, Wind in km/h.
  direction real,
  speed_kmh real,
  gust_kmh real,
  -- Wann dieser Wert zuletzt von Open-Meteo abgerufen wurde.
  fetched_at timestamptz not null default now(),
  -- Startzeit (UTC) des Modelllaufs, aus dem der Wert stammt (z. B.
  -- 06:00 UTC). Wird im Verlaufsbalken als "Lauf HH:MM" angezeigt. Leer,
  -- wenn Open-Meteo beim Abruf keine Laufzeit meldete.
  model_run timestamptz,
  -- Pro Station, Modell und Prognosestunde nur ein Eintrag: der stündliche
  -- Abruf überschreibt vorhandene Zeitpunkte per Upsert statt sie zu
  -- duplizieren.
  unique (station_code, model, forecast_time)
);

-- Die Abfrage der Prognosen einer einzelnen Station nutzt die Suchhilfe, die
-- unique (station_code, model, forecast_time) oben schon mitbringt. Eine eigene
-- zweite gab es bis Okt. 2026 — sie war doppelt (supabase/datenbank-aufraeumen.sql
-- entfernt sie bei bestehenden Datenbanken).

-- Beschleunigt "wann wurde ein Modell zuletzt geholt?" (Edge Function, vor
-- jedem Lauf).
create index if not exists wind_forecasts_model_fetched_idx
  on public.wind_forecasts (model, fetched_at desc);

-- Row Level Security aktivieren, OHNE Policies anzulegen: damit kann
-- NUR der service_role Key (die Edge Function und später die API-Route)
-- auf die Tabelle zugreifen — der öffentliche anon-Key hat keinen Zugriff.
alter table public.wind_forecasts enable row level security;
