-- Tabelle für die Wind-Historie (12h-Anzeige, 2 Tage Aufbewahrung).
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

-- Beschleunigt die 12h-Abfrage einer einzelnen Station (/api/history,
-- Verlaufsbalken).
create index if not exists wind_measurements_station_time_idx
  on public.wind_measurements (station_code, measured_at desc);

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
