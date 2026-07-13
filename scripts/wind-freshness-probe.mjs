// TEMPORÄRES Diagnose-Skript (2. Runde): prüft, ob der alternative
// Wetterdienst der Provinz (services/weather/station) aktuellere Werte
// liefert als der meteo/v1-Dienst. Wird nach der Diagnose gelöscht.

function toIso(date) {
  if (!date) return null;
  return date.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
}

const now = new Date();
console.log(`Abruf um ${now.toISOString()}`);

// 1) Alternativer Dienst: weather/station
const res = await fetch(
  "https://daten.buergernetz.bz.it/services/weather/station?categoryId=1&lang=de&format=json",
);
console.log(`weather/station: HTTP ${res.status}`);
if (res.ok) {
  const data = await res.json();
  const rows = data.rows ?? data;
  console.log(`Einträge: ${Array.isArray(rows) ? rows.length : "?"}`);
  if (Array.isArray(rows) && rows.length > 0) {
    console.log("Feldnamen:", JSON.stringify(Object.keys(rows[0])));
    for (const r of rows.slice(0, 3)) {
      console.log(JSON.stringify(r).slice(0, 600));
    }
    // Alle Datums-/Zeitfelder einsammeln und Frische berechnen
    const dateKeys = Object.keys(rows[0]).filter((k) =>
      /date|time|lastUpdate|zeit/i.test(k),
    );
    console.log("Zeitfelder:", JSON.stringify(dateKeys));
    for (const k of dateKeys) {
      const ages = rows
        .map((r) => Date.parse(toIso(String(r[k] ?? ""))))
        .filter((t) => !Number.isNaN(t))
        .map((t) => (now.getTime() - t) / 60000)
        .sort((a, b) => a - b);
      if (ages.length) {
        console.log(
          `Feld ${k}: min=${ages[0].toFixed(1)} median=${ages[Math.floor(ages.length / 2)].toFixed(1)} max=${ages[ages.length - 1].toFixed(1)} min alt (n=${ages.length})`,
        );
      }
    }
  }
}

// 2) Vergleich: meteo/v1 im selben Moment
const res2 = await fetch(
  "https://daten.buergernetz.bz.it/services/meteo/v1/sensors",
);
console.log(`meteo/v1/sensors: HTTP ${res2.status}`);
if (res2.ok) {
  const sensors = await res2.json();
  const ages = sensors
    .filter((s) => /windgeschwindigkeit/i.test(s.DESC_D) && !/böe/i.test(s.DESC_D))
    .map((s) => Date.parse(toIso(s.DATE)))
    .filter((t) => !Number.isNaN(t))
    .map((t) => (now.getTime() - t) / 60000)
    .sort((a, b) => a - b);
  console.log(
    `meteo/v1 Wind: min=${ages[0].toFixed(1)} median=${ages[Math.floor(ages.length / 2)].toFixed(1)} max=${ages[ages.length - 1].toFixed(1)} min alt (n=${ages.length})`,
  );
}
