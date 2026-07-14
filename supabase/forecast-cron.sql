-- Stündlicher Abruf der ICON-CH1-Windprognosen.
-- Einmalig im Supabase SQL-Editor ausführen, NACHDEM die Edge Function
-- "fetch-wind-forecasts" deployt ist (siehe README, Abschnitt Windprognosen).
--
-- Voraussetzungen: die Extensions pg_cron und pg_net sind aktiviert
-- (bei diesem Projekt bereits der Fall).
--
-- WICHTIG: Die beiden Platzhalter unten VOR dem Ausführen ersetzen —
-- die echten Werte gehören nur in den SQL-Editor (Vault), NIEMALS in
-- diese Datei im Repository zurückschreiben!

-- 1) Einmalig: Projekt-URL und service_role Key sicher im Supabase Vault
--    ablegen. So steht der Key nicht im Klartext im Cron-Job.
--    (Schlägt der Befehl fehl, weil der Name schon existiert, wurde er
--    bereits angelegt — dann diesen Schritt überspringen.)
select vault.create_secret('https://DEIN-PROJEKT.supabase.co', 'project_url');
select vault.create_secret('DEIN_SERVICE_ROLE_KEY', 'service_role_key');

-- 2) Cron-Job anlegen: jede Stunde um Minute 10 ruft pg_net die Edge
--    Function per HTTP-POST auf. Stündlich deshalb, weil sich das
--    gleitende Zeitfenster (24 h zurück + ~3 h voraus) mit jeder Stunde
--    mitbewegen soll, auch wenn das Modell nur alle 3 Stunden neu rechnet.
select cron.schedule(
  'fetch-wind-forecasts-hourly',
  '10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'project_url') || '/functions/v1/fetch-wind-forecasts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Der Supabase-Gateway vor der Edge Function verlangt einen apikey-
      -- Header (sonst 401 "No API key found in request"), die Edge Function
      -- selbst prüft zusätzlich den Authorization-Bearer.
      'apikey', (select decrypted_secret from vault.decrypted_secrets
                 where name = 'service_role_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret
                                     from vault.decrypted_secrets
                                     where name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Nützlich bei Bedarf:
--   Alle Cron-Jobs anzeigen:   select jobid, jobname, schedule from cron.job;
--   Letzte Läufe anzeigen:     select * from cron.job_run_details
--                              order by start_time desc limit 10;
--   Job wieder entfernen:      select cron.unschedule('fetch-wind-forecasts-hourly');
