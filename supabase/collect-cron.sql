-- Zeitplan-Job "collect-data": stößt alle 5 Minuten die Sammel-Route
-- /api/collect an (warum 5 Minuten: siehe src/app/api/collect/route.ts).
-- Für eine NEUE Installation; eine bestehende Datenbank stellt
-- supabase/collect-cron-tresor.sql um.
--
-- Das Geheimnis (CRON_SECRET) liegt im Supabase-Tresor (Vault) unter dem
-- Namen 'cron_secret' — nicht im Klartext im Job (sonst stünde es auch in
-- jedem Protokolleintrag von cron.job_run_details). Genauso macht es der
-- Prognose-Job (supabase/forecast-cron.sql).
--
-- Voraussetzungen: Erweiterungen pg_cron und pg_net sind aktiviert.
-- WICHTIG: Die Platzhalter VOR dem Ausführen ersetzen — die echten Werte
-- gehören nur in den SQL-Editor, NIEMALS in diese Datei im Repository!

-- 1) Einmalig: Geheimnis im Tresor ablegen — derselbe Wert wie die
--    Umgebungsvariable CRON_SECRET in Vercel (ohne "Bearer "). Schlägt der
--    Befehl fehl, weil der Name schon existiert, liegt es schon im Tresor —
--    dann diesen Schritt überspringen.
select vault.create_secret('DEIN_CRON_SECRET', 'cron_secret', 'CRON_SECRET für /api/collect');

-- 2) Job anlegen (gleicher Name überschreibt einen vorhandenen Job).
--    Adresse anpassen, falls die Seite nicht unter sisosig.vercel.app läuft.
select cron.schedule(
  'collect-data',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://sisosig.vercel.app/api/collect',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $$
);

-- Kontrolle nach ein paar Minuten (echte Antworten der Sammel-Route):
--   select status_code, left(content::text, 300), created
--   from net._http_response order by created desc limit 5;
