-- Einmalig (13. Nov. 2026): Der Sammler "collect-data" startet nicht mehr um
-- :00, :05, :10 …, sondern 3 Minuten später (:03, :08, :13 …). Takt bleibt
-- 5 Minuten. Grund: Bozen und MeteoSchweiz veröffentlichen ihre Werte etwa
-- 11 Minuten nach der Messung — der Lauf um :x0 kam knapp zu früh, die Werte
-- kamen erst 5 Minuten später auf die Karte. Messung und Begründung oben in
-- src/app/api/collect/route.ts.
--
-- Ausführen: Supabase → SQL Editor → einfügen → Run.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'collect-data'),
  schedule := '3-58/5 * * * *'
);

-- Kontrolle (sollte '3-58/5 * * * *' zeigen):
--   select jobname, schedule from cron.job where jobname = 'collect-data';
-- Zurück zum alten Zeitplan:
--   select cron.alter_job((select jobid from cron.job where jobname = 'collect-data'), schedule := '*/5 * * * *');
