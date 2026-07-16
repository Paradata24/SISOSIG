-- Ergänzt die Spalte "source" in der bereits bestehenden Tabelle
-- wind_measurements, damit man erkennt, ob ein Messwert vom Bozner
-- Wetterdienst ('bolzano') oder vom OpenWindMap/Pioupiou-Netzwerk
-- ('openwindmap') stammt.
--
-- Nur einmalig nötig, wenn die Tabelle wind_measurements schon VOR dieser
-- Änderung angelegt wurde (die aktuelle schema.sql enthält die Spalte
-- bereits, bei einer neuen Installation dieses Skript also nicht nötig).
-- Einmalig im Supabase SQL-Editor ausführen.
--
-- Sicher/nicht-destruktiv: fügt nur eine Spalte hinzu, bestehende Zeilen
-- bekommen automatisch den Vorgabewert 'bolzano' — es wird nichts gelöscht
-- oder überschrieben.

alter table public.wind_measurements
  add column if not exists source text not null default 'bolzano';
