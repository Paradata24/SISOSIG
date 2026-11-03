-- Tabelle für die Wind-Historie (48h-Anzeige, 3 Tage Aufbewahrung).
-- Einmalig im Supabase SQL-Editor ausführen.

create table if not exists public.wind_measurements (
  id bigint generated always as identity primary key,
  station_code text not null,
  measured_at timestamptz not null,
  direction real,
  speed_kmh real,
  gust_kmh real,
  -- Woher der Messwert stammt: 'bolzano' (Bozner Wetterdienst) oder
  -- 'openwindmap' (Pioupiou-Netzwerk). Erleichtert die geplante Erweiterung
  -- auf weitere Regionen/Quellen (siehe CLAUDE.md, Phase 2).
  source text not null default 'bolzano',
  inserted_at timestamptz not null default now(),
  -- Pro Station und Messzeitpunkt nur ein Eintrag: die Sammel-Route
  -- /api/collect (per Supabase Cron alle 5 Minuten) fragt bewusst öfter ab,
  -- als die Stationen messen (alle 5-10 Minuten) — sie sieht denselben Wert
  -- also mehrfach. Diese Duplikate fängt der Upsert ab.
  unique (station_code, measured_at)
);

-- Die 12h-Abfrage einer einzelnen Station (/api/history, Verlaufsbalken)
-- nutzt die Suchhilfe, die unique (station_code, measured_at) oben schon
-- mitbringt. Eine eigene zweite (station_code, measured_at desc) gab es bis
-- Okt. 2026 — sie war doppelt und bremste nur das Speichern
-- (supabase/datenbank-aufraeumen.sql entfernt sie bei bestehenden Datenbanken).

-- Beschleunigt die Abfrage über ALLE Stationen in einem Zeitfenster
-- (/api/timeline, Zeitbalken unter der Karte) und das Aufräumen alter Zeilen.
-- Der Index darüber hilft dort nicht, weil nicht nach einer Station gefiltert
-- wird. Für bereits bestehende Datenbanken: supabase/add-measured-at-index.sql.
create index if not exists wind_measurements_time_idx
  on public.wind_measurements (measured_at desc);

-- Row Level Security aktivieren, OHNE Policies anzulegen: damit kann
-- NUR der service_role Key (der Sammel-Job und die API-Route) auf die
-- Tabelle zugreifen — der öffentliche anon-Key hat keinen Zugriff.
alter table public.wind_measurements enable row level security;

-- Stationsliste (Name, Lage, Höhe; eingetragen von /api/collect) und der
-- neueste gespeicherte Wert je Station. Daraus liest /api/wind die Werte für
-- die Karte (src/lib/stationList.ts), die Prognose-Funktion ihre Stationen.
-- Erklärungen in supabase/stationsliste.sql und supabase/ein-sammler.sql —
-- dort steht dasselbe für bestehende Datenbanken.
create table if not exists public.wind_stations (
  station_code text primary key,
  source text not null,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  altitude real,
  updated_at timestamptz not null default now()
);
alter table public.wind_stations enable row level security;

-- Zeitbalken: die Messwerte aller Stationen ab einem Zeitpunkt in EINER
-- Antwort (/api/timeline). Erklärungen in supabase/zeitbalken-funktion.sql.
create or replace function public.wind_timeline(since timestamptz)
returns json
language sql
stable
set search_path = ''
as $$
  select coalesce(
    json_agg(
      json_build_array(
        m.station_code,
        round(extract(epoch from m.measured_at) * 1000)::bigint,
        m.direction,
        m.speed_kmh,
        m.gust_kmh,
        m.source
      )
      order by m.measured_at, m.station_code
    ),
    '[]'::json
  )
  from public.wind_measurements m
  where m.measured_at >= since;
$$;
revoke execute on function public.wind_timeline(timestamptz) from public, anon, authenticated;
grant execute on function public.wind_timeline(timestamptz) to service_role;

create or replace view public.wind_stations_latest
with (security_invoker = true) as
select s.station_code, s.source, s.name, s.lat, s.lng, s.altitude,
       m.measured_at, m.direction, m.speed_kmh, m.gust_kmh, s.updated_at
from public.wind_stations s
cross join lateral (
  select w.measured_at, w.direction, w.speed_kmh, w.gust_kmh
  from public.wind_measurements w
  where w.station_code = s.station_code
  order by w.measured_at desc
  limit 1
) m;

-- Zustand der Datenquellen (vom Sammler) und der Prognose-Funktion.
-- Erklärungen in supabase/ein-sammler.sql.
create table if not exists public.wind_status (
  name text primary key,
  checked_at timestamptz not null,
  ok boolean not null,
  ok_at timestamptz,
  value_count integer not null default 0,
  error text,
  detail jsonb
);
alter table public.wind_status enable row level security;

-- Alles, was die Karte braucht, in EINER Antwort (/api/wind).
-- Erklärungen in supabase/ein-sammler.sql.
create or replace function public.wind_latest()
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'stations', (
      select coalesce(json_agg(json_build_array(
        l.station_code, l.source, l.name, l.lat, l.lng, l.altitude,
        round(extract(epoch from l.measured_at) * 1000)::bigint,
        l.direction, l.speed_kmh, l.gust_kmh,
        round(extract(epoch from l.updated_at) * 1000)::bigint
      )), '[]'::json)
      from public.wind_stations_latest l
    ),
    'sources', (
      select coalesce(json_agg(json_build_array(
        s.name,
        round(extract(epoch from s.checked_at) * 1000)::bigint,
        s.ok
      )), '[]'::json)
      from public.wind_status s
    )
  );
$$;
revoke execute on function public.wind_latest() from public, anon, authenticated;
grant execute on function public.wind_latest() to service_role;

-- Luftdruck der Flughäfen Innsbruck und Bozen (Föhn-Anzeige, gemessen und
-- ICON-CH1-Prognose). Erklärungen in supabase/druck.sql.
create table if not exists public.pressure_values (
  station text not null,
  kind text not null,
  valid_at timestamptz not null,
  qnh_hpa real not null,
  model_run timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (station, kind, valid_at)
);
alter table public.pressure_values enable row level security;
