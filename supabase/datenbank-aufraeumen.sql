-- Aufräumen der Datenbank (Okt. 2026). Einmalig im Supabase SQL-Editor
-- ausführen (nur bei BESTEHENDEN Datenbanken; schema.sql und
-- forecast-schema.sql enthalten den neuen Stand schon). Ein zweites Ausführen
-- schadet nicht.
--
-- Sicher: Es werden keine Messwerte oder Prognosen verändert oder gelöscht.

-- 1) Doppelte Suchhilfen (Indizes) entfernen. Die Eindeutigkeits-Regeln
--    unique (station_code, measured_at) bzw. unique (station_code, model,
--    forecast_time) bringen schon je eine gleichwertige Suchhilfe mit; die
--    zusätzlichen Kopien (zusammen 18 MB) bremsten nur jedes Speichern.
drop index if exists public.wind_measurements_station_time_idx;
drop index if exists public.wind_forecasts_station_model_time_idx;

-- 2) Suchhilfe für "wann wurde ein Modell zuletzt geholt?" (Edge Function
--    fetch-wind-forecasts, zweimal pro Viertelstunde): vorher ~0,3 s, jetzt
--    ~1 ms.
create index if not exists wind_forecasts_model_fetched_idx
  on public.wind_forecasts (model, fetched_at desc);

-- 3) Das Protokoll der Zeitplan-Jobs (cron.job_run_details) wuchs ohne Grenze
--    (Okt. 2026: 35.000 Einträge, 21 MB). Ein täglicher Job (03:23 UTC) löscht
--    jetzt alles, was älter als 7 Tage ist. Gleicher Name überschreibt einen
--    schon angelegten Job, statt einen zweiten anzulegen.
--    Hinweis: "succeeded" heißt in diesem Protokoll nur "Anfrage abgeschickt".
--    Die echte Antwort steht in net._http_response (wird 6 h aufbewahrt).
select cron.schedule(
  'cron-protokoll-aufraeumen',
  '23 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
