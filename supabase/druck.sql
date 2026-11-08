-- Luftdruck der Flughäfen Innsbruck und Bozen für die Föhn-Anzeige
-- (Druckdifferenz Bozen − Innsbruck, Nov. 2026, Wunsch des Projektbesitzers).
-- Einmalig im Supabase SQL-Editor ausführen (nur bei BESTEHENDEN Datenbanken;
-- schema.sql enthält das für Neuinstallationen schon). Ein zweites Ausführen
-- schadet nicht.
--
-- Sicher: Es wird nur eine NEUE Tabelle angelegt — keine bestehenden Daten
-- gelöscht oder verändert.
--
-- REIHENFOLGE: Erst dieses Skript ausführen, DANN die Edge Function
-- fetch-wind-forecasts neu deployen (sie schreibt die Druckprognose hierher).
-- Fehlt die Tabelle, scheitert nur der Druck-Teil (Sammler und Prognose
-- melden es in ihrer Antwort), der Wind läuft unverändert weiter.
--
-- Eine Zeile je Flughafen (bzw. Bergstation), Art und Zeitpunkt:
--   station    ICAO-Kennung des Flughafens: 'LOWI' (Innsbruck), 'LIPB' (Bozen);
--              seit 8. Nov. 2026 auch die Bergstationen 'RITTNERHORN' und
--              'HAFELEKAR' (nur Temperatur, siehe unten; bis 8. Nov.
--              2026 'PATSCHERKOFEL')
--   kind       'station'  = gemessen, QNH alle 10 min, selbst gerechnet aus den
--                           Wetterstationen Innsbruck-Flughafen (GeoSphere)
--                           und Bozen (Land) — station bleibt dabei 'LOWI'
--                           bzw. 'LIPB' (die Seite); geschrieben vom Sammler
--                           (seit Nov. 2026, src/lib/stationPressure.ts)
--              'metar'    = bis 8. Nov. 2026: gemessen (Flugwetter-Meldung
--                           METAR); seitdem nicht mehr gesammelt, alte Zeilen
--                           räumt der Sammler nach 3 Tagen weg
--              'kamm'     = gemessen, Temperatur und Feuchte auf Kammhöhe
--                           (Rittnerhorn, Hafelekar; seit 8. Nov. 2026,
--                           vom Sammler, src/lib/crestTemperature.ts) — ohne
--                           QNH
--              'icon_ch1' = Prognose (ICON-CH1 über Open-Meteo, geschrieben
--                           von der Edge Function fetch-wind-forecasts); für
--                           die Bergstationen nur die Temperatur, ohne QNH
--              'ecmwf_ifs' = Prognose (ECMWF über Open-Meteo, nur Flughäfen)
--   valid_at   Messzeit bzw. Prognosestunde (UTC)
--   qnh_hpa    QNH in hPa (Luftdruck nach Normatmosphäre auf Meereshöhe
--              umgerechnet — der Wert, den die Flughäfen melden); leer bei
--              den Bergstationen. ANGEZEIGT wird seit 8. Nov. 2026 das QFF
--              (mit echter Temperatur und Feuchte): /api/pressure rechnet es
--              beim Auslesen aus qnh_hpa, temp_c und humidity_pct.
--   model_run  bei Prognosen: Startzeit des Modelllaufs, sonst leer
--   fetched_at wann der Wert geholt wurde
-- Aufbewahrung 3 Tage wie bei den Windwerten (räumt der Sammler auf).
create table if not exists public.pressure_values (
  station text not null,
  kind text not null,
  valid_at timestamptz not null,
  qnh_hpa real not null,
  model_run timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (station, kind, valid_at)
);

-- Wie bei den anderen Tabellen: Row Level Security an, OHNE Policies — nur
-- der service_role Key (Sammler, API-Routen, Edge Function) kommt heran.
alter table public.pressure_values enable row level security;

-- Seit Nov. 2026 (Wunsch des Projektbesitzers): Temperatur und
-- Luftfeuchtigkeit — gemessen (kind 'station', 'kamm') und seit 8. Nov. 2026
-- auch in den Prognosen. Gebraucht für das QFF und das Temperatur-Diagramm
-- im Druck-Verlaufsbalken. Ein zweites Ausführen schadet nicht.
alter table public.pressure_values add column if not exists temp_c real;
alter table public.pressure_values add column if not exists humidity_pct real;

-- Seit 8. Nov. 2026 (Wunsch des Projektbesitzers): Temperatur auf Kammhöhe
-- (Rittnerhorn, Hafelekar) für das Temperatur-Diagramm im
-- Druck-Verlaufsbalken. Diese Bergstationen haben keinen QNH — deshalb darf
-- qnh_hpa leer sein. Sicher: Es wird nur eine Pflicht-Regel gelockert, keine
-- Daten geändert. REIHENFOLGE wie oben: erst diese Zeile ausführen, DANN die
-- Edge Function neu deployen (fehlt sie, scheitert nur das Speichern der
-- Kammtemperaturen, der Luftdruck läuft weiter). Ein zweites Ausführen
-- schadet nicht.
alter table public.pressure_values alter column qnh_hpa drop not null;
