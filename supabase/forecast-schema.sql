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
  -- Pro Station, Modell und Prognosestunde nur ein Eintrag: der stündliche
  -- Abruf überschreibt vorhandene Zeitpunkte per Upsert statt sie zu
  -- duplizieren.
  unique (station_code, model, forecast_time)
);

-- Beschleunigt die Abfrage der Prognosen einer einzelnen Station.
create index if not exists wind_forecasts_station_model_time_idx
  on public.wind_forecasts (station_code, model, forecast_time desc);

-- Row Level Security aktivieren, OHNE Policies anzulegen: damit kann
-- NUR der service_role Key (die Edge Function und später die API-Route)
-- auf die Tabelle zugreifen — der öffentliche anon-Key hat keinen Zugriff.
alter table public.wind_forecasts enable row level security;
