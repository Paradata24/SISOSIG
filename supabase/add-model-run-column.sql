-- Einmalig im Supabase SQL-Editor ausführen (nur bei BESTEHENDEN
-- Datenbanken; bei einer Neuinstallation steht die Spalte schon in
-- forecast-schema.sql).
--
-- Neue Spalte model_run: Startzeit des ICON-CH1-Modelllaufs, aus dem eine
-- Prognose stammt. Der Verlaufsbalken zeigt sie rechts bei der
-- Prognosekurve an ("ICON-CH1 · Lauf 08:00").
--
-- WICHTIG — Reihenfolge: ERST dieses Skript ausführen, DANN die Edge
-- Function fetch-wind-forecasts neu deployen. Andersherum schlüge das
-- Speichern der Prognosen fehl, weil die Spalte noch fehlt.
-- Die Webseite selbst kommt mit und ohne Spalte zurecht (siehe
-- src/app/api/forecast/route.ts).

alter table public.wind_forecasts
  add column if not exists model_run timestamptz;
