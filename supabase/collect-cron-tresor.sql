-- Einmalig für die BESTEHENDE Datenbank (Okt. 2026): stellt den Zeitplan-Job
-- "collect-data" so um, dass er das Geheimnis (CRON_SECRET) aus dem
-- Supabase-Tresor (Vault) liest, statt es im Klartext im Befehl zu tragen
-- (dort stand es auch in jedem Eintrag des Protokolls cron.job_run_details).
-- Für eine neue Installation: supabase/collect-cron.sql.
--
-- Das Geheimnis wird dabei direkt aus dem bisherigen Job in den Tresor
-- übernommen — es muss also nirgends eingetippt werden und wird nicht
-- angezeigt. Der Wert in Vercel bleibt unverändert.
--
-- Ausführen im Supabase SQL-Editor: Inhalt einfügen und "Run" klicken.

-- 1) Geheimnis aus dem bisherigen Job in den Tresor übernehmen (nur, wenn es
--    dort noch nicht liegt und der Job noch den Klartext enthält).
select vault.create_secret(
  substring(command from '"Authorization":"Bearer ([^"]+)"'),
  'cron_secret',
  'CRON_SECRET für /api/collect'
)
from cron.job
where jobname = 'collect-data'
  and substring(command from '"Authorization":"Bearer ([^"]+)"') is not null
  and not exists (select 1 from vault.secrets where name = 'cron_secret');

-- 2) Job auf den Tresor umstellen — nur, wenn das Geheimnis dort wirklich
--    liegt (sonst würde der Job ohne Passwort anklopfen und die Sammel-Route
--    jeden Lauf mit 401 ablehnen).
select cron.alter_job(
  job_id := j.jobid,
  command := $cmd$
  select net.http_post(
    url := 'https://sisosig.vercel.app/api/collect',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $cmd$
)
from cron.job j
where j.jobname = 'collect-data'
  and exists (
    select 1 from vault.decrypted_secrets
    where name = 'cron_secret' and length(decrypted_secret) > 0
  );

-- Kontrolle nach ein paar Minuten (Status 200 = alles gut):
--   select status_code, left(content::text, 300), created
--   from net._http_response order by created desc limit 5;
