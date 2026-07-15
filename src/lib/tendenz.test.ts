// Unit-Tests für die Tendenzkurve-Berechnung (§9 des Auftrags).
//
// Ausführen (Node 22+, kann TypeScript direkt ausführen):
//     node --test src/lib/tendenz.test.ts
//
// Diese Datei ist bewusst von tsconfig.json / eslint ausgeschlossen, weil sie
// zum Laufen die .ts-Endung im Import braucht (Node-Type-Stripping) — das mag
// der Next-Build sonst nicht. Für den App-Code ändert sich dadurch nichts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  berechneTendenz,
  winkelDifferenz,
  tendenzKopfzeile,
  FENSTER_STUNDEN,
} from "./tendenz.ts";

// Kleiner Helfer: prüft eine Zahl auf ~gleich (Rundungstoleranz).
function nah(actual: number, expected: number, toleranz = 0.1) {
  assert.ok(
    Math.abs(actual - expected) <= toleranz,
    `erwartet ~${expected}, war ${actual}`,
  );
}

test("winkelDifferenz: zyklisch korrekt", () => {
  assert.equal(winkelDifferenz(10, 350), 20); // über Nord hinweg
  assert.equal(winkelDifferenz(90, 0), 90);
  assert.equal(winkelDifferenz(0, 180), 180);
  assert.equal(winkelDifferenz(200, 10), 170);
});

test("Fall A – Modell untertreibt, fallend (Rittner Horn)", () => {
  const e = berechneTendenz([28, 29, 25], 200, [6, 5, 3, 4], 205);
  assert.equal(e.zeichnen, true);
  if (!e.zeichnen) return; // Typ-Enge für TypeScript
  // realJetzt ≈ 27.3, offset ≈ +21.3
  nah(e.offset, 21.3, 0.2);
  // Punkte ≈ 27.3 / 19.2 / 10.1 / 4.0
  nah(e.punkte[0].wert, 27.3);
  nah(e.punkte[1].wert, 19.2);
  nah(e.punkte[2].wert, 10.1);
  nah(e.punkte[3].wert, 4.0);
  assert.equal(e.tendenz, "fallend");
  assert.equal(e.vertrauen, "niedrig"); // Offset > 15
  // Kontrolle: korrigiert(0) == realJetzt, korrigiert(FENSTER) == rohe Prognose
  nah(e.punkte[0].wert, (28 + 29 + 25) / 3);
  nah(e.punkte[FENSTER_STUNDEN].wert, 4);
});

test("Fall B – Modell trifft gut (kleiner Offset)", () => {
  const e = berechneTendenz([14, 15, 16], 180, [13, 14, 15, 16], 180);
  assert.equal(e.zeichnen, true);
  if (!e.zeichnen) return;
  nah(e.offset, 2);
  assert.equal(e.vertrauen, "gut");
  // Band schmal: halbe Breite bei t=0 = BAND_BASIS + |offset|*0.15 = 2 + 0.3
  nah(e.punkte[0].oben - e.punkte[0].wert, 2.3);
});

test("Fall C – Richtungskonflikt setzt Linie aus", () => {
  const e = berechneTendenz([20], 90, [12, 12, 12, 12], 0);
  assert.equal(e.zeichnen, false);
  if (e.zeichnen) return;
  assert.equal(e.grund, "richtung_konflikt");
  if (e.grund !== "richtung_konflikt") return;
  assert.equal(e.richtungUnsicher, true);
});

test("Fall D – Daten fehlen, kein Absturz", () => {
  const e = berechneTendenz([], 90, [12, 12, 12, 12], 90);
  assert.equal(e.zeichnen, false);
  if (e.zeichnen) return;
  assert.equal(e.grund, "daten_fehlen");
});

test("Datencheck: unvollständige Prognose → daten_fehlen", () => {
  const e = berechneTendenz([15], 90, [12, 12], 90); // nur 2 statt 4 Werte
  assert.equal(e.zeichnen, false);
  if (e.zeichnen) return;
  assert.equal(e.grund, "daten_fehlen");
});

test("Datencheck: NaN in Prognose → daten_fehlen", () => {
  const e = berechneTendenz([15], 90, [12, NaN, 12, 12], 90);
  assert.equal(e.zeichnen, false);
  if (e.zeichnen) return;
  assert.equal(e.grund, "daten_fehlen");
});

test("Kopfzeile-Texte je Fall", () => {
  const a = berechneTendenz([28, 29, 25], 200, [6, 5, 3, 4], 205);
  assert.equal(
    tendenzKopfzeile(a),
    "Modell untertreibt Mittel +21 · Tendenz fallend · Absolutwert unsicher.",
  );
  const b = berechneTendenz([14, 15, 16], 180, [13, 14, 15, 16], 180);
  assert.equal(
    tendenzKopfzeile(b),
    "Modell trifft aktuell gut (Offset +2) · Tendenz gleichbleibend.",
  );
  const c = berechneTendenz([20], 90, [12, 12, 12, 12], 0);
  assert.equal(
    tendenzKopfzeile(c),
    "Richtung real ≠ Prognose – Korrektur ausgesetzt.",
  );
  const d = berechneTendenz([], 90, [12, 12, 12, 12], 90);
  assert.equal(tendenzKopfzeile(d), "Keine Tendenz verfügbar (Daten fehlen).");
});
