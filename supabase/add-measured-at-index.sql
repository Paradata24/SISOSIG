-- Beschleunigt die Abfrage des Zeitbalkens (/api/timeline): ALLE Stationen
-- innerhalb eines Zeitfensters. Der vorhandene Index
-- (station_code, measured_at desc) hilft dort nicht, weil gar nicht nach
-- einer einzelnen Station gefiltert wird — ohne diesen Index muss die
-- Datenbank die ganze Tabelle durchgehen.
--
-- Nebeneffekt: beschleunigt auch das Aufräumen alter Zeilen in /api/collect
-- (delete ... where measured_at < cutoff).
--
-- Nur einmalig nötig, wenn die Tabelle wind_measurements schon VOR dieser
-- Änderung angelegt wurde (die aktuelle schema.sql enthält den Index
-- bereits, bei einer neuen Installation ist dieses Skript also nicht nötig).
-- Einmalig im Supabase SQL-Editor ausführen.
--
-- Sicher/nicht-destruktiv: legt nur einen Index an, es werden keine Daten
-- verändert oder gelöscht. Ein erneutes Ausführen schadet nicht
-- ("if not exists").

create index if not exists wind_measurements_time_idx
  on public.wind_measurements (measured_at desc);
