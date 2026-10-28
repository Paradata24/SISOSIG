-- Stationsliste (Okt. 2026, Punkt 10 der Code-Durchsicht). Einmalig im
-- Supabase SQL-Editor ausführen (nur bei BESTEHENDEN Datenbanken; schema.sql
-- enthält das für Neuinstallationen schon). Ein zweites Ausführen schadet
-- nicht.
--
-- Sicher: Es wird nur etwas NEU angelegt, nichts gelöscht oder verändert.
--
-- Wozu: Liefert eine Quelle (z. B. MeteoSchweiz) gerade gar nichts, zeigt die
-- Karte ihre Stationen trotzdem — mit dem letzten gespeicherten Wert, nach der
-- Grau-Grenze grau (src/lib/stationList.ts). Dafür braucht es Name, Lage und
-- Höhe jeder Station in der Datenbank; die trägt der Sammler (/api/collect)
-- ein. Bis zu seinem ersten Lauf nach dem Anlegen ist die Liste leer.

-- 1) Die Stationsliste. updated_at = wann der Sammler die Station zuletzt
--    eingetragen bzw. aufgefrischt hat (bekannte Stationen einmal pro Stunde).
create table if not exists public.wind_stations (
  station_code text primary key,
  source text not null,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  altitude real,
  updated_at timestamptz not null default now()
);

-- Wie bei wind_measurements: Row Level Security an, OHNE Policies — nur der
-- service_role Key (Sammler und API-Routen) kommt an die Tabelle.
alter table public.wind_stations enable row level security;

-- 2) Neuester gespeicherter Messwert je Station (für /api/wind). Je Station
--    genügt ein Griff in die Suchhilfe unique (station_code, measured_at) von
--    wind_measurements. Stationen ganz ohne gespeicherten Wert (älter als die
--    Aufbewahrung von 2 Tagen) fehlen hier bewusst.
--    security_invoker: Die Sicht gilt mit den Rechten dessen, der fragt — der
--    öffentliche anon-Key sieht dadurch wie bei den Tabellen nichts.
create or replace view public.wind_stations_latest
with (security_invoker = true) as
select s.station_code, s.source, s.name, s.lat, s.lng, s.altitude,
       m.measured_at, m.direction, m.speed_kmh, m.gust_kmh
from public.wind_stations s
cross join lateral (
  select w.measured_at, w.direction, w.speed_kmh, w.gust_kmh
  from public.wind_measurements w
  where w.station_code = s.station_code
  order by w.measured_at desc
  limit 1
) m;
