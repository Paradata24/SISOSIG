-- Zeitbalken in einem Schritt (Okt. 2026, Punkt 7 der Code-Durchsicht).
-- Einmalig im Supabase SQL-Editor ausführen (nur bei BESTEHENDEN Datenbanken;
-- schema.sql enthält das für Neuinstallationen schon). Ein zweites Ausführen
-- schadet nicht.
--
-- Sicher: Es wird nur eine Rechenfunktion angelegt, keine Daten verändert.
--
-- Wozu: /api/timeline braucht die Messwerte ALLER Stationen der letzten 12 h
-- (Okt. 2026 rund 30.000 Zeilen). Supabase gibt pro Anfrage höchstens 1000
-- Zeilen heraus ("Max rows"), deshalb las die Route bis dahin gut 30 Seiten,
-- je 8 gleichzeitig — zusammen gut 2 s. Diese Funktion packt alle Zeilen in
-- EINE Antwort (ein einziger JSON-Wert zählt nicht als viele Zeilen).
--
-- Jede Zeile kommt als kurze Liste statt als Objekt (spart gut die Hälfte):
--   [Stationscode, Messzeit in Millisekunden (UTC), Richtung, Mittelwind, Böe, Quelle]
-- Sortiert nach Zeit, dann Station (wie zuvor beim seitenweisen Lesen).
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

-- Nur der Server (service_role Key) darf sie aufrufen — wie bei den Tabellen
-- kommt der öffentliche anon-Key nicht an die Messwerte.
revoke execute on function public.wind_timeline(timestamptz) from public, anon, authenticated;
grant execute on function public.wind_timeline(timestamptz) to service_role;
