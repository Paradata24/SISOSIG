import { useCallback, useEffect, useState } from "react";
import L from "leaflet";
import { useNow } from "./device";
import type { OwnPosition } from "./position";

// --- KK7-Thermikkarte (Wunsch des Projektbesitzers, Okt. 2026) ---
// Wahrscheinlichkeit, eine Thermik zu finden, berechnet aus Millionen
// hochgeladener Streckenflüge (thermal.kk7.ch): je wärmer die Farbe, desto
// eher steigt es dort. Nur im Flugmodus, als halb durchsichtige Ebene über
// OpenTopoMap und unter Kabeln, Track und Windpfeilen. Ein-/Ausschalten über
// die Taste "KK7" unten links; die Wahl merkt sich das Handy.
//
// Bedingungen von KK7 (Okt. 2026 auf der Seite nachgelesen): Lizenz
// CC BY-NC-SA 4.0 (nur nicht-kommerziell, Nennung unter "Quellen" in der Filterliste,
// KK7_SOURCE in src/lib/wind.ts), jede Anfrage trägt "src=<Adresse der
// Seite>", die Kacheln liegen in TMS-Zählung (y von unten, daher tms: true)
// und gibt es bis Zoom 12 — darüber vergrößert Leaflet sie.
//
// Automatisch nach Jahreszeit und Tageszeit gefiltert (Wunsch des
// Projektbesitzers, Okt. 2026, wie in burnair Go): KK7 hat je eine Karte für
// jede Kombination aus Jahreszeit (jan/apr/jul/oct = je drei Monate drumherum)
// und Tageszeit (04/07/10 = Morgen/Mittag/Abend, gemessen ab
// Sonnenaufgang). Die Wahl folgt Datum, Uhrzeit und Standort; wechselt sie
// (z. B. mittags), tauscht die Karte die Ebene von selbst.
// Datenmenge über Südtirol im Vergleich zur Ganzjahres-Karte (Okt. 2026
// gezählt): Sommer 70–80 %, Frühling 40–70 %, Herbst 25–45 %, Winter
// 10–20 %, morgens jeweils am wenigsten. Im Winter ist die Karte also
// entsprechend lückenhaft — das ist kein Fehler.
const KK7_URL = "https://thermal.kk7.ch/tiles/thermals_{category}/{z}/{x}/{y}.png";
const KK7_MAX_NATIVE_ZOOM = 12;
// 30 % weniger deckend als zuerst (0,85; Wunsch des Projektbesitzers, Okt.
// 2026). Die Kacheln von KK7 sind schon selbst halb durchsichtig.
const KK7_OPACITY = 0.6;
// Grenzen der Tageszeit in Stunden nach Sonnenaufgang, laut Hilfe von KK7:
// Morgen 0–6 h, Mittag 6–10 h, Abend danach. (Die Schaltfläche auf der
// KK7-Seite nennt für Mittag "ca. 6–9 h"; die Hilfe ist ausführlicher.)
const KK7_MIDDAY_FROM_H = 6;
const KK7_EVENING_FROM_H = 10;
// So oft wird geprüft, ob eine andere Karte dran ist.
const KK7_RECHECK_MS = 5 * 60 * 1000;
// Über OpenTopoMap (zIndex 1) in derselben Kachel-Ebene.
const KK7_Z_INDEX = 2;
// Ohne Flüge in der Gegend liefert KK7 keine Kachel; dann bleibt die Stelle
// einfach leer (durchsichtiger 1×1-Punkt, wie bei den Höhenlinien in WindMap).
const KK7_EMPTY_TILE =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const KK7_STORAGE_KEY = "sisosig-kk7-v1";

// Sonnenaufgang (Zeitpunkt in ms) am Tag von `date` für einen Ort.
// Vereinfachte Sonnenstandsformel (NOAA), auf wenige Minuten genau — für die
// Einteilung Morgen/Mittag/Abend reicht das weit.
function sunriseMs(date: Date, lat: number, lng: number): number {
  const rad = Math.PI / 180;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000) + 1;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  // Zeitgleichung (Minuten) und Deklination der Sonne (Bogenmaß).
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  // Stundenwinkel bei Sonnenaufgang (-0,833° = Horizont mit Lichtbrechung).
  const cosH =
    (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) /
    (Math.cos(lat * rad) * Math.cos(decl));
  const hourAngle = Math.acos(Math.min(1, Math.max(-1, cosH))) / rad;
  const minutesUtc = 720 - 4 * (lng + hourAngle) - eqTime;
  const midnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return midnightUtc + minutesUtc * 60_000;
}

// KK7-Karte für Zeitpunkt und Ort, z. B. "oct_07" (Oktober, Mittag).
function kk7Category(nowMs: number, lat: number, lng: number): string {
  const date = new Date(nowMs);
  // Jan/Apr/Jul/Okt stehen für Dez–Feb, Mär–Mai, Jun–Aug, Sep–Nov.
  const season = ["jan", "apr", "jul", "oct"][Math.round(date.getMonth() / 3) % 4];
  // Vor Sonnenaufgang zählt als Morgen.
  const hoursAfterSunrise = (nowMs - sunriseMs(date, lat, lng)) / 3_600_000;
  const timeOfDay =
    hoursAfterSunrise >= KK7_EVENING_FROM_H
      ? "10"
      : hoursAfterSunrise >= KK7_MIDDAY_FROM_H
        ? "07"
        : "04";
  return `${season}_${timeOfDay}`;
}

function loadKk7Enabled(): boolean {
  try {
    return window.localStorage.getItem(KK7_STORAGE_KEY) !== "aus";
  } catch {
    return true;
  }
}

export function useKk7Layer(
  map: L.Map | null,
  position: OwnPosition | null,
  fallbackCenter: [number, number],
) {
  // Standard: eingeschaltet. Direkt aus dem Speicher gelesen — der Flugmodus
  // läuft nur im Browser (WindMap wird ohne Server-Rendering geladen).
  const [enabled, setEnabled] = useState(loadKk7Enabled);

  // Sonnenaufgang am eigenen Standort, ohne GPS an der Startansicht. Die
  // Ebene wird nur neu angelegt, wenn sich die Karte (category) ändert, nicht
  // bei jedem GPS-Wert.
  const now = useNow(KK7_RECHECK_MS);
  const category = kk7Category(
    now,
    position?.lat ?? fallbackCenter[0],
    position?.lng ?? fallbackCenter[1],
  );

  useEffect(() => {
    if (!map || !enabled) return;
    const url = KK7_URL.replace("{category}", category);
    const layer = L.tileLayer(`${url}?src=${encodeURIComponent(window.location.hostname)}`, {
      tms: true,
      maxNativeZoom: KK7_MAX_NATIVE_ZOOM,
      opacity: KK7_OPACITY,
      zIndex: KK7_Z_INDEX,
      errorTileUrl: KK7_EMPTY_TILE,
    }).addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, enabled, category]);

  const toggle = useCallback(() => {
    setEnabled((was) => {
      try {
        window.localStorage.setItem(KK7_STORAGE_KEY, was ? "aus" : "an");
      } catch {
        // Ohne Speicher gilt die Wahl eben nur bis zum Neuladen.
      }
      return !was;
    });
  }, []);

  return { enabled, toggle };
}
