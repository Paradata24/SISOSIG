-- Löscht die Reste der wieder entfernten AROME-Prognose
-- (model = 'arome') aus der Tabelle wind_forecasts.
--
-- FREIWILLIG und nur EINMALIG nötig: Die Edge Function fragt AROME nicht
-- mehr bei Open-Meteo ab, und alte Zeilen verschwinden ohnehin von selbst,
-- weil bei jedem Lauf alles gelöscht wird, was älter als 2 Tage ist. Dieses
-- Skript räumt nur sofort auf. Wer nichts tut, hat für höchstens zwei Tage
-- noch ein paar ungenutzte Zeilen in der Tabelle stehen.
--
-- Ausführen im Supabase SQL-Editor: Inhalt einfügen und "Run" klicken.
--
-- Die übrigen Prognosen (model = 'icon_ch1' und 'icon_d2') bleiben
-- unberührt, ebenso alle Messwerte in wind_measurements.

delete from public.wind_forecasts where model = 'arome';
