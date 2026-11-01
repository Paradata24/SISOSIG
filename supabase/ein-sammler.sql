-- "Ein Sammler, eine Wahrheit" (Nov. 2026, Punkt 14 der Code-Durchsicht).
-- Einmalig im Supabase SQL-Editor ausführen (nur bei BESTEHENDEN Datenbanken;
-- schema.sql enthält das für Neuinstallationen schon). Ein zweites Ausführen
-- schadet nicht. Voraussetzung: supabase/stationsliste.sql ist ausgeführt.
--
-- Sicher: Es wird nur etwas NEU angelegt bzw. die Sicht um eine Spalte
-- ergänzt — keine Daten gelöscht oder verändert.
--
-- Wozu: Seitdem spricht nur noch der Sammler (/api/collect) mit den
-- Wetterdiensten. Die Karte (/api/wind) liest die neuesten Werte aller
-- Stationen und den Zustand der Quellen aus der Datenbank, die
-- Prognose-Funktion die Stationsliste (wind_stations).

-- 1) Zustand der Datenquellen und der Prognose-Funktion. Eine Zeile je Quelle
--    ("bolzano", "openwindmap", …; geschrieben vom Sammler nach jedem Lauf)
--    und eine Zeile "prognose" (geschrieben von der Edge Function
--    fetch-wind-forecasts).
--      checked_at  letzter Lauf
--      ok          hat er geklappt? Bei einer Quelle: mindestens eine Station
--                  geliefert und ihre Werte gespeichert. Stationen ohne
--                  aktuelle Werte zählen nicht als Fehler (sie werden grau).
--      ok_at       letzter Lauf, der geklappt hat (bleibt bei Fehlern stehen
--                  — daran sieht man, seit wann etwas fehlt)
--      value_count Zahl der Werte im letzten Lauf
--      error       Fehlermeldung des letzten Laufs
--      detail      Zusatzangaben; bei "prognose" die Stationen, deren Abruf
--                  gescheitert ist und beim nächsten Anstoß nachgeholt wird
create table if not exists public.wind_status (
  name text primary key,
  checked_at timestamptz not null,
  ok boolean not null,
  ok_at timestamptz,
  value_count integer not null default 0,
  error text,
  detail jsonb
);

-- Wie bei den anderen Tabellen: Row Level Security an, OHNE Policies — nur
-- der service_role Key (Sammler, API-Routen, Edge Function) kommt heran.
alter table public.wind_status enable row level security;

-- 2) Sicht wind_stations_latest (aus stationsliste.sql) um updated_at
--    ergänzen: Daran erkennt /api/wind Stationen, die ihre Quelle nicht mehr
--    führt (src/lib/stationList.ts). Neue Spalten dürfen nur HINTEN angehängt
--    werden, sonst lehnt Postgres das "create or replace" ab.
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

-- 3) Alles, was die Karte braucht, in EINER Antwort (wie wind_timeline: ein
--    einziger JSON-Wert unterliegt nicht der Grenze von 1000 Zeilen je
--    Anfrage). Nov. 2026 gemessen: ~20 ms für rund 650 Stationen.
--      stations: [Code, Quelle, Name, Breite, Länge, Höhe,
--                 Messzeit (ms, UTC), Richtung, Mittelwind, Böe,
--                 zuletzt in der Stationsliste aufgefrischt (ms)]
--      sources:  [Name, letzter Lauf (ms), geklappt?]
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

-- Nur der Server (service_role Key) darf sie aufrufen.
revoke execute on function public.wind_latest() from public, anon, authenticated;
grant execute on function public.wind_latest() to service_role;
