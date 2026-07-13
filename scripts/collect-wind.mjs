// Fragt den Open-Data-Wetterdienst der Provinz Bozen ab und schreibt die
// aktuellen Windwerte aller Stationen in die Supabase-Tabelle
// wind_measurements. Läuft als GitHub-Actions-Workflow alle 10 Minuten.
//
// Benötigte Umgebungsvariablen (als GitHub Secrets hinterlegt):
//   SUPABASE_URL               z.B. https://xyz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service_role Key des Supabase-Projekts

const API_BASE =
  process.env.WIND_API_BASE_URL ??
  "http://daten.buergernetz.bz.it/services/meteo/v1";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RETENTION_DAYS = 7;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "FEHLER: Die Secrets SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY sind " +
      "nicht gesetzt. Bitte im Repo unter Settings → Secrets and variables " +
      "→ Actions eintragen.",
  );
  process.exit(1);
}

const supabaseHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const isDirection = (desc) => /windrichtung/i.test(desc);
const isSpeed = (desc) => /windgeschwindigkeit/i.test(desc) && !/böe/i.test(desc);
const isGust = (desc) => /böe/i.test(desc);

// "2026-07-13T14:10:00CEST" → gültiges ISO 8601 mit numerischem Offset.
function toIsoTimestamp(date) {
  if (!date) return null;
  return date.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
}

function toKmh(value, unit) {
  if (unit && unit.toLowerCase().includes("m/s")) return value * 3.6;
  return value;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

const sensorsRes = await fetch(`${API_BASE}/sensors`);
if (!sensorsRes.ok) {
  console.error(`FEHLER: Wetterdienst antwortete mit Status ${sensorsRes.status}`);
  process.exit(1);
}
const sensors = await sensorsRes.json();

const byStation = new Map();
for (const s of sensors) {
  if (!byStation.has(s.SCODE)) byStation.set(s.SCODE, []);
  byStation.get(s.SCODE).push(s);
}

const rows = [];
for (const [code, readings] of byStation) {
  const dir = readings.find((r) => isDirection(r.DESC_D));
  const speed = readings.find((r) => isSpeed(r.DESC_D));
  if (!dir && !speed) continue; // Station ohne Windsensoren

  const gust = readings.find((r) => isGust(r.DESC_D));
  const measuredAt = toIsoTimestamp(speed?.DATE ?? dir?.DATE);
  if (!measuredAt || Number.isNaN(Date.parse(measuredAt))) continue;

  const direction = dir?.VALUE ?? null;
  const speedKmh = speed?.VALUE != null ? round1(toKmh(speed.VALUE, speed.UNIT)) : null;
  if (direction === null && speedKmh === null) continue; // aktuell kein Messwert

  rows.push({
    station_code: code,
    measured_at: measuredAt,
    direction,
    speed_kmh: speedKmh,
    gust_kmh: gust?.VALUE != null ? round1(toKmh(gust.VALUE, gust.UNIT)) : null,
  });
}

if (rows.length === 0) {
  console.error("FEHLER: Keine Windmesswerte im Datenbestand gefunden.");
  process.exit(1);
}

// Upsert: bereits vorhandene (station_code, measured_at)-Paare werden
// aktualisiert statt doppelt angelegt.
const insertRes = await fetch(
  `${SUPABASE_URL}/rest/v1/wind_measurements?on_conflict=station_code,measured_at`,
  {
    method: "POST",
    headers: {
      ...supabaseHeaders,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  },
);
if (!insertRes.ok) {
  console.error(
    `FEHLER: Supabase-Insert schlug fehl (Status ${insertRes.status}): ` +
      (await insertRes.text()),
  );
  process.exit(1);
}
console.log(`${rows.length} Windmesswerte gespeichert.`);

// Aufräumen: Einträge älter als RETENTION_DAYS Tage löschen.
const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
const deleteRes = await fetch(
  `${SUPABASE_URL}/rest/v1/wind_measurements?measured_at=lt.${encodeURIComponent(cutoff)}`,
  { method: "DELETE", headers: supabaseHeaders },
);
if (!deleteRes.ok) {
  console.error(
    `WARNUNG: Aufräumen alter Einträge schlug fehl (Status ${deleteRes.status}): ` +
      (await deleteRes.text()),
  );
  process.exit(1);
}
console.log(`Einträge vor ${cutoff} gelöscht.`);
