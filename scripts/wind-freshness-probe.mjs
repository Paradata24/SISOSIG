// TEMPORÄRES Diagnose-Skript: misst, wie aktuell die Windwerte des Bozner
// Open-Data-Webservice sind (Abstand Messzeitstempel ↔ Abrufzeitpunkt),
// mit drei Abrufen im Abstand von 5 Minuten. Wird nach der Diagnose gelöscht.

const API =
  process.env.WIND_API_BASE_URL ??
  "https://daten.buergernetz.bz.it/services/meteo/v1";

function toIso(date) {
  if (!date) return null;
  return date.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
}

async function probe(label) {
  const now = new Date();
  const res = await fetch(`${API}/sensors`);
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status}`);
    return;
  }
  const sensors = await res.json();
  const speeds = sensors.filter(
    (s) => /windgeschwindigkeit/i.test(s.DESC_D) && !/böe/i.test(s.DESC_D),
  );
  const ages = [];
  const perStation = [];
  for (const s of speeds) {
    const t = Date.parse(toIso(s.DATE));
    if (Number.isNaN(t)) continue;
    const ageMin = (now.getTime() - t) / 60000;
    ages.push(ageMin);
    perStation.push({ code: s.SCODE, date: s.DATE, ageMin: ageMin.toFixed(1) });
  }
  ages.sort((a, b) => a - b);
  const q = (p) => ages[Math.min(ages.length - 1, Math.floor(ages.length * p))];
  console.log(`\n===== ${label} — Abruf um ${now.toISOString()} =====`);
  console.log(`Wind-Stationen mit Zeitstempel: ${ages.length}`);
  console.log(
    `Alter der Messwerte (Minuten): min=${q(0).toFixed(1)} ` +
      `median=${q(0.5).toFixed(1)} p90=${q(0.9).toFixed(1)} max=${ages[ages.length - 1].toFixed(1)}`,
  );
  console.log("Beispiele (10 Stationen):");
  for (const s of perStation.slice(0, 10)) {
    console.log(`  ${s.code}  ${s.date}  → ${s.ageMin} min alt`);
  }
  // Verteilung der Minuten im Zeitstempel zeigt das Messraster
  // (z.B. nur :00/:10/:20 → 10-Minuten-Raster).
  const minuteEndings = {};
  for (const s of perStation) {
    const m = s.date.match(/T\d\d:(\d\d)/);
    if (m) minuteEndings[m[1]] = (minuteEndings[m[1]] ?? 0) + 1;
  }
  console.log("Zeitstempel-Minuten (Raster):", JSON.stringify(minuteEndings));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await probe("Abruf 1");
await sleep(5 * 60 * 1000);
await probe("Abruf 2 (nach 5 min)");
await sleep(5 * 60 * 1000);
await probe("Abruf 3 (nach 10 min)");
