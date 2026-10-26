-- Räumt die Reste einer FRÜHEREN Höhenwind-Fassung auf: entfernt die beiden
-- nur dafür angelegten Spalten pressure_level und height_m aus der Tabelle
-- wind_forecasts.
--
-- Seit Okt. 2026 gibt es den Höhenwind wieder (model = 'icon_d2_upper', für
-- Rittnerhorn und Leiterspitz), er braucht diese Spalten aber nicht. Die
-- frühere Zeile, die alle icon_d2_upper-Zeilen löschte, ist deshalb
-- entfernt — sie würde den aktuellen Höhenwind löschen.
--
-- FREIWILLIG und nur EINMALIG nötig: Wer nichts tut, hat lediglich zwei
-- ungenutzte (leere) Spalten in der Tabelle stehen.
--
-- Ausführen im Supabase SQL-Editor: Inhalt einfügen und "Run" klicken.
--
-- ACHTUNG: Die beiden Spalten werden endgültig entfernt; alle Prognose-Daten
-- bleiben davon unberührt.

alter table public.wind_forecasts
  drop column if exists pressure_level,
  drop column if exists height_m;
