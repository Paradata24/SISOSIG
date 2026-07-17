-- Ergänzt die Spalten "pressure_level" und "height_m" in der bereits
-- bestehenden Tabelle wind_forecasts. Sie werden für den Höhenwind
-- (model = 'icon_ch1_upper') gebraucht: welche Druckfläche verwendet wurde
-- (z. B. 800 hPa) und deren vom Modell gerechnete Höhe in Metern.
--
-- Nur einmalig nötig, wenn die Tabelle wind_forecasts schon VOR dieser
-- Änderung angelegt wurde (die aktuelle forecast-schema.sql enthält beide
-- Spalten bereits, bei einer neuen Installation dieses Skript also nicht
-- nötig). Einmalig im Supabase SQL-Editor ausführen.
--
-- Sicher/nicht-destruktiv: fügt nur zwei Spalten hinzu (beide dürfen leer
-- sein), bestehende Zeilen bleiben unverändert — es wird nichts gelöscht
-- oder überschrieben.

alter table public.wind_forecasts
  add column if not exists pressure_level integer,
  add column if not exists height_m real;
