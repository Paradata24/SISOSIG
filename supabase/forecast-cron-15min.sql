-- Einmalig für BESTEHENDE Datenbanken (Sept. 2026): stellt den vorhandenen
-- Cron-Job der Prognosen von "stündlich um Minute 10" auf "alle 15 Minuten"
-- um. Bei einer Neuinstallation nicht nötig — supabase/forecast-cron.sql legt
-- den Job gleich mit dem neuen Takt an.
--
-- Warum das kein Open-Meteo-Kontingent kostet: Die Edge Function
-- fetch-wind-forecasts fragt nur ab, wenn es einen neuen ICON-CH1-Lauf gibt
-- (8-mal am Tag); alle anderen Aufrufe enden sofort ("skipped"). Der
-- kürzere Takt bringt einen neuen Lauf nur schneller auf die Seite
-- (spätestens 15 statt 60 Minuten nach Erscheinen).
--
-- Wichtig: ERST die neue Edge Function deployen, dann dieses Skript
-- ausführen. Die alte Funktion kennt die Prüfung noch nicht und würde bei
-- 15-Minuten-Takt 4-mal so viele Abrufe machen.
--
-- Ausführen im Supabase-Dashboard unter SQL Editor. Nicht destruktiv: es
-- ändert nur den Zeitplan, nichts wird gelöscht.

select cron.alter_job(jobid, schedule := '*/15 * * * *')
from cron.job
where jobname = 'fetch-wind-forecasts-hourly';

-- Kontrolle: select jobid, jobname, schedule from cron.job;
