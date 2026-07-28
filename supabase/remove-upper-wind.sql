-- Räumt die Reste der wieder entfernten Höhenwind-Anzeige auf:
--   1. löscht alle gespeicherten Höhenwind-Zeilen (model = 'icon_d2_upper')
--   2. entfernt die beiden nur dafür angelegten Spalten pressure_level
--      und height_m aus der Tabelle wind_forecasts
--
-- FREIWILLIG und nur EINMALIG nötig: Die Edge Function sammelt keinen
-- Höhenwind mehr, und alte Zeilen verschwinden ohnehin von selbst, weil bei
-- jedem Lauf alles gelöscht wird, was älter als 2 Tage ist. Dieses Skript
-- räumt nur sofort und vollständig auf. Wer nichts tut, hat lediglich zwei
-- ungenutzte (leere) Spalten in der Tabelle stehen.
--
-- Ausführen im Supabase SQL-Editor: Inhalt einfügen und "Run" klicken.
--
-- ACHTUNG: Die beiden Spalten werden endgültig entfernt; die Bodenwind-Daten
-- (model = 'icon_ch1' und 'icon_d2') bleiben davon unberührt.

delete from public.wind_forecasts where model = 'icon_d2_upper';

alter table public.wind_forecasts
  drop column if exists pressure_level,
  drop column if exists height_m;
