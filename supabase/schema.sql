-- Tabelle für die Wind-Historie (48h-Anzeige, 7 Tage Aufbewahrung).
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
  -- /api/collect (per Supabase Cron, z. B. alle 10 Minuten) und die
  -- Stationen (messen alle 5-10 Minuten) können sich überschneiden —
  -- Duplikate werden beim Einfügen einfach ignoriert (Upsert).
  unique (station_code, measured_at)
);

-- Beschleunigt die 48h-Abfrage einer einzelnen Station.
create index if not exists wind_measurements_station_time_idx
  on public.wind_measurements (station_code, measured_at desc);

-- Row Level Security aktivieren, OHNE Policies anzulegen: damit kann
-- NUR der service_role Key (der Sammel-Job und die API-Route) auf die
-- Tabelle zugreifen — der öffentliche anon-Key hat keinen Zugriff.
alter table public.wind_measurements enable row level security;
