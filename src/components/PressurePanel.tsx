"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CREST_PAIR,
  CREST_STATIONS,
  FOEHN_COLOR_SCALE,
  FOEHN_PAIR,
  foehnColor,
  formatPressureDiff,
  pressureDiffAt,
  PRESSURE_STATIONS,
  type PressureDiffPoint,
} from "@/lib/pressure";
import { HISTORY_HOURS } from "@/lib/wind";

// Druck-Verlaufsbalken der Föhn-Anzeige (Nov. 2026, Wunsch des
// Projektbesitzers): öffnet sich beim Antippen der Linie Innsbruck–Bozen auf
// der Karte. Oben die aktuellen Werte (QFF seit 8. Nov. 2026, vorher QNH;
// gerechnet in /api/pressure) beider Seiten und die Differenz,
// darunter das Diagramm: Differenz Bozen − Innsbruck der letzten 48 h —
// schwarz die 10-Minuten-Werte der Stationen (Hauptkurve) — und die
// Prognosen ICON-CH1 (grau gestrichelt, 33 h voraus) und ECMWF (violett
// gestrichelt, 72 h voraus, seit Nov. 2026). KEINE Flughafen-Werte mehr
// (METAR: erst dünn grau punktierte Vergleichslinie, dann nur noch Ersatz
// für Kopfzeile und Karte; am 8. Nov. 2026 auf Wunsch des Projektbesitzers
// ganz entfernt — nicht wieder einführen).
// PROGNOSE AUCH IN DER VERGANGENHEIT (7. Nov. 2026, Wunsch des
// Projektbesitzers, "wie im Verlaufsbalken"): Die gespeicherten Prognosen
// (ICON-CH1, ECMWF, Temperatur) laufen über die ganzen 48 h, hinter der
// Messung — so sieht man, wie gut die Prognose getroffen hat. Vorher endeten
// die Linien links an "jetzt".
// Darunter ein zweites, flacheres Diagramm: Temperatur auf Kammhöhe,
// Rittnerhorn und Hafelekar (seit 8. Nov. 2026; siehe TEMP_* unten). Über der Nulllinie = Süd höher (Südföhn-Lage), darunter = Nord
// höher (Nordföhn-Lage). Die Fläche zwischen gemessener Kurve und Nulllinie
// ist rot (oberhalb) bzw. blau (unterhalb), die Farbstufen der Karte stehen
// als schmaler Farbstreifen neben den hPa-Zahlen (siehe AREA_* / scaleBands).
//
// AUFRÄUMEN (Nov. 2026, Wunsch des Projektbesitzers, "Anzeige noch etwas
// unübersichtlich"): Kopfzeile nur zwei Zeilen (großes Differenz-Schild); jedes
// Diagramm hat seine EIGENE Titelzeile mit Legende (nichts liegt mehr auf den
// Kurven); die Prognose-Zone rechts von "jetzt" ist grau hinterlegt; ECMWF ist
// violett (Blau und Rot gehören den Flächen); die Stufen der Farbskala stehen
// als Streifen am Rand statt als fünf Linien quer durchs Diagramm; die
// Temperatur-Differenz zählt wie der Druck Süd − Nord. Die Quellen
// stehen unter "Quellen" im Ebenen-Menü (Wunsch des Projektbesitzers).
// Aufbau wie der Wind-Verlaufsbalken (WindHistoryPanel: weiß, unten,
// Schließen-Kreuz oben rechts, Escape schließt). Die Zeitachse ist STÜNDLICH
// beschriftet und das Diagramm seitlich verschiebbar (Wunsch des
// Projektbesitzers, Nov. 2026; vorher in die Breite gestaucht): am Handy mit
// dem Finger wischen, am Computer mit der Maus ziehen oder scrollen. Beim
// Öffnen steht "jetzt" in der Mitte (wie im Wind-Verlaufsbalken). Die
// hPa-Zahlen links stehen fest und wandern nicht mit.

// FENSTER BIS ZUM TITEL-BALKEN (7. Nov. 2026, Wunsch des Projektbesitzers,
// nach zwei Zwischenschritten mit 30 % und 40 % der Bildschirmhöhe): Der
// Druck-Verlaufsbalken reicht von unten bis an die Unterkante des
// Titel-Balkens (`topInset`, von WindApp gemessen). Das Temperatur-Diagramm
// behält seine feste Höhe; das Druck-Diagramm bekommt den ganzen restlichen
// Platz (useChartHeight misst den Diagramm-Bereich), mindestens CHART_MIN_H —
// auf sehr kleinen Bildschirmen lässt sich das Fenster dann senkrecht
// verschieben.
const CHART_MIN_H = 180;
function useChartHeight(): [number, (el: HTMLDivElement | null) => void] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(() => setAvailable(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  // Alles im Diagramm-Bereich außer dem Druck-Diagramm selbst.
  const fixed = PAD_TOP + TEMP_GAP + TEMP_H + TIME_LABEL_H;
  return [Math.max(CHART_MIN_H, available - fixed), setEl];
}
// Eine Zeile unter dem Diagramm: Stunde, an Mitternacht der Tag statt "00".
const TIME_LABEL_H = 18;
const PAD_TOP = 6;
// Breite einer Stunde (px): so breit wie ein Wert-Quadrat im
// Wind-Verlaufsbalken (Wunsch des Projektbesitzers, Nov. 2026: Stunden viel
// enger als zuerst mit 30 px). Am Handy sind so gut 20 h auf einmal zu sehen,
// 48 h + 72 h ECMWF ergeben knapp 2.000 px zum Wischen.
const PX_PER_HOUR = 16;
// Beschriftet wird jede zweite Stunde (00, 02, 04 …) — jede Stunde stieße bei
// 16 px aneinander. Rasterlinien gibt es trotzdem für jede Stunde.
const LABEL_EVERY_HOURS = 2;
// Rand links/rechts im Diagramm, damit die äußersten Stundenzahlen nicht
// abgeschnitten werden.
const PAD_X = 10;
const HOUR_MS = 60 * 60 * 1000;
// Feste y-Achse ±8 hPa (10. Nov. 2026, Wunsch des Projektbesitzers; vorher
// mindestens ±3 hPa und darüber mitwachsend): Oben (Süd höher) und unten
// (Nord höher) reicht sie IMMER Y_MIN_EXTENT_HPA weit, so sind alle Tage
// gleich skaliert und direkt vergleichbar. Die Höhe des Diagramms bleibt
// dieselbe (die Kurven werden dadurch flacher). Nur wenn ein Wert (Messung
// oder Prognose) mit Y_HEADROOM_HPA Luft nicht mehr hineinpasst, wächst die
// betroffene Seite für sich in ganzen hPa (Y_STEP_HPA) wie bisher. Die
// Achsengrenze steht links als Zahl ("+8,0"/"−8,0", EXTRA_LINES_HPA).
const Y_MIN_EXTENT_HPA = 8;
const Y_STEP_HPA = 1;
const Y_HEADROOM_HPA = 0.3;
// Die gemessenen Kurven (Druck UND Temperatur) zeigen nur einen Wert alle
// 20 min (zu :00, :20, :40; Wunsch des Projektbesitzers, Nov. 2026 — mit allen
// 10-Minuten-Werten waren sie zu unruhig, halbstündlich war ihm zu grob).
// Gespeichert und abgefragt wird weiter alle 10 min; Kopfzeile und Karte
// zeigen den neuesten Wert.
const MEASURED_STEP_MINUTES = 20;
// Messlücke, ab der eine Kurve unterbrochen wird. Gemessene Kurven (alle
// 20 min): ein fehlender Wert wird überbrückt, zwei nicht.
const MEASURED_GAP_MS = 50 * 60 * 1000;
const FORECAST_GAP_MS = 90 * 60 * 1000;
// Wie die Prognose im Wind-Verlaufsbalken (CH1_COLOR, FORECAST_DASH).
const FORECAST_COLOR = "#52525b";
const FORECAST_DASH = "5 3";
// ECMWF (seit Nov. 2026, Wunsch des Projektbesitzers): gestrichelt, damit es
// sich klar vom grauen ICON-CH1 abhebt; seit dem Aufräumen (Nov. 2026)
// VIOLETT statt blau, weil Blau und Rot den Flächen gehören (Nord höher /
// Süd höher bzw. Norden wärmer / Süden wärmer). Reicht 72 h voraus,
// ICON-CH1 33 h.
const ECMWF_COLOR = "#7c3aed";
// ICON-D2 (seit 10. Nov. 2026, Wunsch des Projektbesitzers): gestrichelt in
// Dunkel-Türkis — nicht Blau/Rot (Flächen), nicht Grau (ICON-CH1), nicht
// Violett (ECMWF). Reicht 48 h voraus.
const ICON_D2_COLOR = "#0f766e";
const MEASURED_COLOR = "#18181b";
// LESBARKEIT: Senkrechte Rasterlinien nur alle 2 h, hPa-Zahlen nur auf den Farbsprüngen,
// kurze Legende mit Linienmustern in der Titelzeile des Diagramms. Vor "jetzt"
// liegen die Prognosen HINTER der Messung (seit 7. Nov. 2026 wieder, siehe
// oben); rechts von "jetzt" ist der Hintergrund grau und mit "Prognose"
// beschriftet.
const FORECAST_ZONE_FILL = "#f4f4f5";
// Fläche zwischen gemessener Kurve und Nulllinie zweifarbig wie im
// ΔT-Diagramm: rot oberhalb (Süd höher), blau unterhalb (Nord höher) —
// nach einer Skizze des Projektbesitzers (Nov. 2026; vorher waren die Stufen
// als blasse Streifen über den ganzen Hintergrund gelegt). Der Hintergrund
// ist weiß; die Stufen der Farbskala (wie im Schild auf der Karte) stehen als
// schmaler Streifen links neben den hPa-Zahlen (`scaleBands`, SCALE_STRIP_OPACITY).
const AREA_OPACITY = 0.35;
const AREA_ABOVE_FILL = "#dc2626";
const AREA_BELOW_FILL = "#2563eb";
const SCALE_STRIP_OPACITY = 0.9;
// Waagrechte Linien gibt es NUR auf Höhe der Farbsprünge (±1 bis ±5 hPa),
// bei 0 und bei ±6 bis ±8 (EXTRA_LINES_HPA) — dünn und GRAU (nicht bunt), alle anderen Gitterlinien
// (ganze hPa) sind weg. Die hPa-Zahlen links stehen genau auf diesen
// Farbsprüngen (neben dem Farbstreifen), nicht mehr bei +4/+2/0/−2. Wunsch des
// Projektbesitzers, 7. Nov. 2026.
const STEP_LINE_COLOR = "#d4d4d8";
const STEP_LINE_WIDTH = 1;
// Hervorgehobene Farbsprünge (7. Nov. 2026, Wunsch des Projektbesitzers):
// dicker und gestrichelt, etwas dunkler grau (weiter grau, nicht bunt) —
// grün→gelb und gelb→orange, seit der neuen Skala (10. Nov. 2026) bei ±2 und
// ±3 hPa (vorher ±1,5/±2,5). Die übrigen Farbsprünge bleiben dünn.
const STRONG_STEP_HPA = [2, 3];
const STRONG_STEP_LINE_COLOR = "#a1a1aa";
const STRONG_STEP_LINE_WIDTH = 1.6;
const STRONG_STEP_LINE_DASH = "6 4";
// Mindestabstand (px) zweier Zahlen links; liegen zwei Farbsprünge enger
// beieinander (große Achsenspanne), fällt die Zahl der weiter außen liegenden
// weg (die Linie bleibt); die "0" weicht den Farbsprüngen.
const STEP_LABEL_MIN_GAP_PX = 10;
// Zusätzliche dünne graue Linien mit Zahl links bei ±6, ±7 und ±8 hPa
// (10. Nov. 2026, Wunsch des Projektbesitzers), damit man auch im schwarzen
// Bereich über 5 hPa ablesen kann (±5 ist schon ein Farbsprung). Nur soweit
// die Achse reicht.
const EXTRA_LINES_HPA = [6, 7, 8];

// --- Temperatur auf Kammhöhe (Nov. 2026, Wunsch des Projektbesitzers) ---
// Eigenes Diagramm UNTER dem Druck, auf derselben Zeitachse (verschiebt sich
// mit). SEIT 8. NOV. 2026 die Bergstationen Rittnerhorn (2260 m, Süden) und
// Hafelekar (2270 m, Nordkette, Norden; zuerst Patscherkofel, noch am selben
// Tag ersetzt) statt der Talstationen Bozen und Innsbruck
// (Wunsch des Projektbesitzers nach einer Recherche: Für Föhn zählt der
// Temperaturunterschied auf Höhe der Pässe, nicht am Talboden — dort
// überdecken Tagesgang, Kaltluftseen und Inversionen alles; Stationen und
// Begründung in CREST_STATIONS, src/lib/pressure.ts). Beide liegen fast
// gleich hoch (10 m), deshalb keine Höhenbereinigung.
// Gezeigt werden die gemessenen Temperaturen beider Stationen als Linien
// (Norden blau, Süden braun) — die Fläche ZWISCHEN den beiden Linien ist die
// Temperatur-Differenz, gezählt wie beim Druck: Süd − Nord (Rittnerhorn −
// Hafelekar): rot, wo der Süden wärmer ist, blau, wo der Norden wärmer
// ist. Lesehilfe: Ist der Süden KÄLTER (blau), drängt die schwere Kaltluft
// über die Pässe nach Norden — das stützt Südföhn; ist der Norden kälter
// (rot), stützt es Nordföhn. (buildBandPaths rechnet intern aus Sicht des
// Nordens: "warm" = Norden wärmer.) (Erste Fassung zeigte nur ΔT um eine
// Nulllinie; der Projektbesitzer wollte auch die gemessenen Temperaturen
// sehen.) Über den ganzen Zeitraum die ICON-CH1-Prognose beider Stationen
// gestrichelt, die Fläche dazwischen blasser.
// Abstand zwischen Druck- und Temperatur-Diagramm: oben die Stundenzahlen
// unter dem Druck-Diagramm (PRESSURE_TIME_H, Wunsch des Projektbesitzers,
// Nov. 2026), darunter die Titelzeile des Temperatur-Diagramms (zwei kleine
// Zeilen). Seit 7. Nov. 2026 mit mehr Luft (Wunsch des Projektbesitzers;
// vorher 14 + 34 px): TEMP_TITLE_PAD_PX über und unter der Titelzeile.
const PRESSURE_TIME_H = 18;
const TEMP_TITLE_PAD_PX = 8;
// Höhe der Titelzeile selbst: seit 7. Nov. 2026 aufgebaut wie die Kopfzeile
// über dem Druck-Diagramm (Wunsch des Projektbesitzers): Titel mit Stand
// (20 px + 4 px Abstand), großes Δ-Schild, rechts daneben die beiden
// Temperaturen — seit 8. Nov. 2026 untereinander, weil die Namen der
// Bergstationen für eine Zeile zu lang sind (2 × 20 px) —, 8 px Abstand,
// Legende in 11 px (~16 px).
const TEMP_TITLE_CONTENT_H = 88;
const TEMP_TITLE_H = TEMP_TITLE_CONTENT_H + 2 * TEMP_TITLE_PAD_PX;
const TEMP_GAP = PRESSURE_TIME_H + TEMP_TITLE_H;
const TEMP_H = 100;
// Lage des Temperatur-Diagramms und der Zeitachse hängt an der Höhe des
// Druck-Diagramms (siehe useChartHeight), deshalb im Baustein gerechnet.
// Mitwachsende Achse in °C: mindestens 10 °C Spanne, in 5-°C-Schritten.
const T_MIN_SPAN_C = 10;
const T_STEP_C = 5;
const T_HEADROOM_C = 0.5;
const TEMP_GAP_MS = MEASURED_GAP_MS;
// Norden blau (Wunsch des Projektbesitzers, Nov. 2026; vorher schwarz),
// Süden braun — wie vorher Innsbruck und Bozen.
const NORTH_TEMP_COLOR = "#2563eb";
const SOUTH_TEMP_COLOR = "#b45309";
const TEMP_SOUTH_WARMER_FILL = "#dc2626";
const TEMP_NORTH_WARMER_FILL = "#2563eb";
const TEMP_FILL_OPACITY = 0.25;
const TEMP_FORECAST_FILL_OPACITY = 0.1;

type Series = Array<[number, number]>;

/**
 * Höchstens ein Wert je MEASURED_STEP_MINUTES-Abschnitt (aufsteigende Reihe):
 * der erste im Abschnitt — also der zu :00/:20/:40, wenn es ihn gibt. Für die
 * Temperaturlinien — der Hafelekar (Lawinenwarndienst Tirol) meldet meist
 * alle 10 min, manchmal aber nur alle 20–80 min und nicht immer zur vollen
 * 20-Minuten-Marke; ein starres "nur :00/:20/:40" risse die Linie dann auf.
 */
function oneEveryStep(points: Series): Series {
  const stepMs = MEASURED_STEP_MINUTES * 60 * 1000;
  const result: Series = [];
  let lastSlot: number | null = null;
  for (const point of points) {
    const slot = Math.floor(point[0] / stepMs);
    if (slot === lastSlot) continue;
    result.push(point);
    lastSlot = slot;
  }
  return result;
}

// Linie aus einer Reihe [Zeit, Wert] mit Lücken wie buildPath.
function buildSeriesPath(
  points: Series,
  x: (t: number) => number,
  y: (v: number) => number,
  maxGapMs: number,
): string {
  let d = "";
  let prev: number | null = null;
  for (const [t, v] of points) {
    d += `${prev === null || t - prev > maxGapMs ? "M" : "L"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
    prev = t;
  }
  return d;
}

// Fläche zwischen den Temperaturen beider Stationen, getrennt nach "Norden
// wärmer" (warm) und "kälter" (cold). `pairs` kommt aus pairPressureSeries
// (Süd, Nord): Feld north = Süd-Station, Feld south = Nord-Station, diff =
// Nord − Süd (die Feldnamen stammen vom Druck und sind hier vertauscht). Je
// zwei aufeinanderfolgende Punkte ergeben ein Viereck; kreuzen sich die
// Linien dazwischen, wird es am Schnittpunkt in zwei Dreiecke geteilt.
function buildBandPaths(
  pairs: PressureDiffPoint[],
  x: (t: number) => number,
  y: (v: number) => number,
  maxGapMs: number,
): { warm: string; cold: string } {
  let warm = "";
  let cold = "";
  const pt = (t: number, v: number) => `${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
  const add = (positive: boolean, poly: string) => {
    if (positive) warm += poly;
    else cold += poly;
  };
  for (let i = 0; i + 1 < pairs.length; i++) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (b.time - a.time > maxGapMs) continue;
    if (a.diff * b.diff >= 0) {
      add(a.diff + b.diff > 0, `M${pt(a.time, a.south)}L${pt(b.time, b.south)}L${pt(b.time, b.north)}L${pt(a.time, a.north)}Z`);
    } else {
      const f = a.diff / (a.diff - b.diff);
      const tc = a.time + f * (b.time - a.time);
      const vc = a.north + f * (b.north - a.north);
      add(a.diff > 0, `M${pt(a.time, a.south)}L${pt(tc, vc)}L${pt(a.time, a.north)}Z`);
      add(b.diff > 0, `M${pt(tc, vc)}L${pt(b.time, b.south)}L${pt(b.time, b.north)}Z`);
    }
  }
  return { warm, cold };
}

/** Zahl mit Vorzeichen und einer Nachkommastelle, z. B. "−1,6". */
function formatSigned(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Math.abs(rounded).toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return rounded > 0 ? `+${text}` : rounded < 0 ? `−${text}` : text;
}

/** Temperatur mit einer Nachkommastelle, minus als echtes "−", plus ohne Zeichen. */
function formatTemp(value: number): string {
  const text = formatSigned(value);
  return text.startsWith("+") ? text.slice(1) : text;
}

// Fläche zwischen Kurve und Nulllinie, je zusammenhängendem Stück ein
// geschlossener Pfad (Lücken wie bei der Linie).
function buildAreaPath(
  points: PressureDiffPoint[],
  x: (t: number) => number,
  y: (v: number) => number,
  maxGapMs: number,
): string {
  let d = "";
  let segment: PressureDiffPoint[] = [];
  const flush = () => {
    if (segment.length >= 2) {
      d += `M${x(segment[0].time).toFixed(1)} ${y(0).toFixed(1)}`;
      for (const p of segment) d += `L${x(p.time).toFixed(1)} ${y(p.diff).toFixed(1)}`;
      d += `L${x(segment[segment.length - 1].time).toFixed(1)} ${y(0).toFixed(1)}Z`;
    }
    segment = [];
  };
  for (const p of points) {
    const prev = segment[segment.length - 1];
    if (prev && p.time - prev.time > maxGapMs) flush();
    segment.push(p);
  }
  flush();
  return d;
}

/** Druck (QFF) mit einer Nachkommastelle, z. B. "1019,6". */
function formatHpa(value: number): string {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  });
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

function buildPath(
  points: PressureDiffPoint[],
  x: (t: number) => number,
  y: (v: number) => number,
  maxGapMs: number,
): string {
  let d = "";
  let prev: number | null = null;
  for (const p of points) {
    d += `${prev === null || p.time - prev > maxGapMs ? "M" : "L"}${x(p.time).toFixed(1)} ${y(p.diff).toFixed(1)}`;
    prev = p.time;
  }
  return d;
}

export default function PressurePanel({
  measured,
  forecast,
  modelRun,
  ecmwf,
  ecmwfRun,
  iconD2,
  iconD2Run,
  tempDiff,
  tempDiffForecast,
  tempNorth,
  tempSouth,
  tempNorthForecast,
  tempSouthForecast,
  loading,
  onClose,
  topInset,
}: {
  /** Höhe des Titel-Balkens (px): bis dorthin reicht das Fenster. */
  topInset: number;
  /** 10-Minuten-Werte der Stationen (Hauptkurve). */
  measured: PressureDiffPoint[];
  forecast: PressureDiffPoint[];
  modelRun: string | null;
  /** ECMWF-Prognose (violett gestrichelt). */
  ecmwf: PressureDiffPoint[];
  ecmwfRun: string | null;
  /** ICON-D2-Prognose (türkis gestrichelt). */
  iconD2: PressureDiffPoint[];
  iconD2Run: string | null;
  /** Temperatur-Differenz auf Kammhöhe, Nord − Süd (°C), gemessen. */
  tempDiff: PressureDiffPoint[];
  /** Dasselbe aus der ICON-CH1-Prognose. */
  tempDiffForecast: PressureDiffPoint[];
  /** Gemessene Temperaturen (°C): north = Hafelekar, south = Rittnerhorn. */
  tempNorth: Series;
  tempSouth: Series;
  /** ICON-CH1-Temperatur (°C) je Seite. */
  tempNorthForecast: Series;
  tempSouthForecast: Series;
  /** true = noch keine Daten geladen. */
  loading: boolean;
  onClose: () => void;
}) {
  const north = PRESSURE_STATIONS[FOEHN_PAIR.north];
  const south = PRESSURE_STATIONS[FOEHN_PAIR.south];
  const crestNorth = CREST_STATIONS[CREST_PAIR.north];
  const crestSouth = CREST_STATIONS[CREST_PAIR.south];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Seitlich verschiebbarer Bereich des Diagramms.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Einmal beim ersten Zeichnen auf "jetzt" stellen; danach bleibt die
  // Position, die man selbst gewählt hat (auch bei neuen Daten).
  const scrolledToNow = useRef(false);
  // Ziehen mit der Maus (am Handy scrollt der Browser selbst mit dem Finger).
  const drag = useRef<{ x: number; scrollLeft: number } | null>(null);

  // "Jetzt" beim Öffnen bzw. bei neuen Daten (die kommen alle 10 min).
  const [now, setNow] = useState(() => Date.now());
  const [chartH, chartAreaRef] = useChartHeight();
  const tempTop = PAD_TOP + chartH + TEMP_GAP;
  const timeTop = tempTop + TEMP_H;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const current = pressureDiffAt(measured, now);
  const currentTemp = pressureDiffAt(tempDiff, now);

  const chart = useMemo(() => {
    // Volle Stunden: links 48 h zurück, rechts bis zum Ende der längsten
    // Prognose (ECMWF 72 h, ICON-D2 48 h, ICON-CH1 33 h), mindestens bis in einer Stunde.
    const start = Math.floor((now - HISTORY_HOURS * HOUR_MS) / HOUR_MS) * HOUR_MS;
    const lastForecast = Math.max(
      forecast.length > 0 ? forecast[forecast.length - 1].time : now,
      ecmwf.length > 0 ? ecmwf[ecmwf.length - 1].time : now,
      iconD2.length > 0 ? iconD2[iconD2.length - 1].time : now,
    );
    const end = Math.ceil(Math.max(now + HOUR_MS, lastForecast) / HOUR_MS) * HOUR_MS;
    const inRange = (p: PressureDiffPoint) => p.time >= start && p.time <= end;
    // Nur die Werte zu :00, :20, :40 (siehe MEASURED_STEP_MINUTES).
    const onStep = (t: number) => new Date(t).getUTCMinutes() % MEASURED_STEP_MINUTES === 0;
    const m = measured.filter((p) => inRange(p) && onStep(p.time));
    const f = forecast.filter(inRange);
    const e = ecmwf.filter(inRange);
    const d2 = iconD2.filter(inRange);
    // Die Achse richtet sich nach allem, was gezeichnet wird (auch die
    // Prognose in der Vergangenheit, damit nichts abgeschnitten wird).
    const values = [...m, ...f, ...e, ...d2].map((p) => p.diff);
    const grow = (extent: number) =>
      Math.max(Y_MIN_EXTENT_HPA, Math.ceil((extent + Y_HEADROOM_HPA) / Y_STEP_HPA) * Y_STEP_HPA);
    const yTop = grow(Math.max(0, ...values));
    const yBottom = -grow(Math.max(0, ...values.map((v) => -v)));
    const svgW = PAD_X * 2 + ((end - start) / HOUR_MS) * PX_PER_HOUR;
    const x = (t: number) => PAD_X + ((t - start) / HOUR_MS) * PX_PER_HOUR;
    const y = (v: number) =>
      PAD_TOP + ((yTop - Math.max(yBottom, Math.min(yTop, v))) / (yTop - yBottom)) * chartH;
    // Temperatur-Diagramm darunter, eigene mitwachsende Achse in °C.
    const inRangeS = ([t]: [number, number]) => t >= start && t <= end;
    // Je 20-Minuten-Abschnitt ein Wert (siehe oneEveryStep): Der Hafelekar
    // meldet nicht immer zu :00/:20/:40.
    const tN = oneEveryStep(tempNorth.filter(inRangeS));
    const tS = oneEveryStep(tempSouth.filter(inRangeS));
    // Prognose über den ganzen Zeitraum, auch in der Vergangenheit (hinter
    // der Messung, wie im Wind-Verlaufsbalken).
    const tNf = tempNorthForecast.filter(inRangeS);
    const tSf = tempSouthForecast.filter(inRangeS);
    const bandM = tempDiff.filter((p) => inRange(p) && onStep(p.time));
    const bandF = tempDiffForecast.filter(inRange);
    const tAll = [...tN, ...tS, ...tNf, ...tSf].map(([, v]) => v);
    let tLow = tAll.length ? Math.floor((Math.min(...tAll) - T_HEADROOM_C) / T_STEP_C) * T_STEP_C : 0;
    let tHigh = tAll.length ? Math.ceil((Math.max(...tAll) + T_HEADROOM_C) / T_STEP_C) * T_STEP_C : T_MIN_SPAN_C;
    while (tHigh - tLow < T_MIN_SPAN_C) {
      // Abwechselnd oben und unten erweitern, damit die Kurven mittig bleiben.
      if ((tHigh - tLow) % (2 * T_STEP_C) === 0) tHigh += T_STEP_C;
      else tLow -= T_STEP_C;
    }
    const ty = (v: number) =>
      tempTop + ((tHigh - Math.max(tLow, Math.min(tHigh, v))) / (tHigh - tLow)) * TEMP_H;
    const tTickStep = tHigh - tLow > 30 ? 10 : T_STEP_C;
    const tTicks: number[] = [];
    for (let v = Math.ceil(tLow / tTickStep) * tTickStep; v <= tHigh; v += tTickStep) tTicks.push(v);
    // Jede volle Stunde (Ortszeit; bei Zeitzonen mit halben Stunden passt
    // das nicht, für die Alpen egal).
    const times: number[] = [];
    for (let t = start; t <= end; t += HOUR_MS) times.push(t);
    // Farbstreifen der Stufen neben den hPa-Zahlen, oberhalb und unterhalb der
    // Nulllinie gespiegelt (soweit die Achse reicht): blau bis 1, grün bis 2,
    // gelb bis 3, orange bis 4, rot bis 5, darüber schwarz.
    const scaleBands: { top: number; height: number; color: string }[] = [];
    FOEHN_COLOR_SCALE.forEach((step, i) => {
      const lo = i === 0 ? 0 : FOEHN_COLOR_SCALE[i - 1].upTo;
      const hi = step.upTo;
      if (lo < yTop) {
        const top = y(Math.min(hi, yTop));
        scaleBands.push({ top, height: y(lo) - top, color: step.color });
      }
      if (-lo > yBottom) {
        const top = y(-lo);
        scaleBands.push({ top, height: y(Math.max(-hi, yBottom)) - top, color: step.color });
      }
    });
    // Linien an den Farbsprüngen (oberhalb und unterhalb der Nulllinie), grau.
    // Beschriftet wird von innen nach außen, soweit der Platz reicht
    // (STEP_LABEL_MIN_GAP_PX).
    const stepLines: { y: number; label: string; showLabel: boolean; strong: boolean }[] = [];
    FOEHN_COLOR_SCALE.forEach((step, i) => {
      const next = FOEHN_COLOR_SCALE[i + 1];
      if (!next || !Number.isFinite(step.upTo)) return;
      for (const at of [step.upTo, -step.upTo]) {
        if (at < yTop && at > yBottom) {
          stepLines.push({
            y: y(at),
            label: formatSigned(at),
            showLabel: true,
            strong: STRONG_STEP_HPA.includes(Math.abs(at)),
          });
        }
      }
    });
    // Zusatzlinien ±6/7/8 hPa (EXTRA_LINES_HPA), dann die Achsengrenzen
    // oben und unten, falls die Achse über 8 hPa gewachsen ist (z. B. "+10,0").
    for (const at of EXTRA_LINES_HPA.flatMap((v) => [v, -v])) {
      if (at <= yTop && at >= yBottom) {
        stepLines.push({ y: y(at), label: formatSigned(at), showLabel: true, strong: false });
      }
    }
    for (const at of [yTop, yBottom]) {
      if (!EXTRA_LINES_HPA.includes(Math.abs(at))) {
        stepLines.push({ y: y(at), label: formatSigned(at), showLabel: true, strong: false });
      }
    }
    for (const sign of [-1, 1]) {
      // Je Seite von der Nulllinie nach außen; Linien sind nach Betrag sortiert.
      let lastY: number | null = null;
      for (const line of stepLines.filter((l) => Math.sign(y(0) - l.y) === sign)) {
        if (lastY !== null && Math.abs(line.y - lastY) < STEP_LABEL_MIN_GAP_PX) line.showLabel = false;
        else lastY = line.y;
      }
    }
    // Die "0" nur, wenn kein beschrifteter Farbsprung zu nah daneben steht.
    const showZeroLabel = !stepLines.some((l) => l.showLabel && Math.abs(l.y - y(0)) < STEP_LABEL_MIN_GAP_PX);
    return {
      svgW,
      x,
      y,
      showZeroLabel,
      times,
      scaleBands,
      stepLines,
      measuredPath: buildPath(m, x, y, MEASURED_GAP_MS),
      measuredAreaPath: buildAreaPath(m, x, y, MEASURED_GAP_MS),
      forecastPath: buildPath(f, x, y, FORECAST_GAP_MS),
      ecmwfPath: buildPath(e, x, y, FORECAST_GAP_MS),
      iconD2Path: buildPath(d2, x, y, FORECAST_GAP_MS),
      ty,
      tTicks,
      northTempPath: buildSeriesPath(tN, x, ty, TEMP_GAP_MS),
      southTempPath: buildSeriesPath(tS, x, ty, TEMP_GAP_MS),
      northTempForecastPath: buildSeriesPath(tNf, x, ty, FORECAST_GAP_MS),
      southTempForecastPath: buildSeriesPath(tSf, x, ty, FORECAST_GAP_MS),
      band: buildBandPaths(bandM, x, ty, TEMP_GAP_MS),
      bandForecast: buildBandPaths(bandF, x, ty, FORECAST_GAP_MS),
      nowX: x(now),
    };
  }, [chartH, tempTop, now, measured, forecast, ecmwf, iconD2, tempDiff, tempDiffForecast, tempNorth, tempSouth, tempNorthForecast, tempSouthForecast]);

  // Beim ersten Zeichnen "jetzt" in die Mitte schieben.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledToNow.current || (measured.length === 0 && forecast.length === 0)) return;
    el.scrollLeft = Math.max(0, chart.nowX - el.clientWidth / 2);
    scrolledToNow.current = true;
  }, [chart, measured.length, forecast.length]);

  const svgH = timeTop + TIME_LABEL_H;
  const currentColor = current ? foehnColor(current.diff) : null;

  return (
    <section
      aria-label="Föhn: Druckdifferenz Bozen − Innsbruck"
      className="absolute inset-x-0 bottom-0 z-[1100] flex flex-col overflow-y-auto border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(0,0,0,0.18)] dark:border-zinc-700 dark:bg-zinc-900"
      style={{ top: topInset > 0 ? topInset : "env(safe-area-inset-top)" }}
    >
      <header className="flex items-center gap-3 px-3 pt-2 pb-1">
        <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Druck Bozen − Innsbruck
          {current && (
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              {" "}
              · Stand: {formatDateTime(current.time)}
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Druckverlauf schließen"
          className="ml-auto shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3 L13 13 M13 3 L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {/* Aktuelle Lage in einer Zeile: großes Differenz-Schild, rechts klein die
          beiden Druckwerte (QFF). Bewusst ohne erklärenden Satz (Wunsch des
          Projektbesitzers, Nov. 2026). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-xs text-zinc-700 dark:text-zinc-200">
        {current ? (
          <>
            <span
              className="border border-black px-2 py-1 text-base font-bold tabular-nums"
              style={{ background: currentColor?.color, color: currentColor?.text }}
            >
              {formatPressureDiff(current.diff)}
            </span>
            <span className="ml-auto text-[15px] text-zinc-500 dark:text-zinc-400">
              {south.short} <strong className="tabular-nums text-zinc-800 dark:text-zinc-100">{formatHpa(current.south)}</strong>
              {" · "}
              {north.short} <strong className="tabular-nums text-zinc-800 dark:text-zinc-100">{formatHpa(current.north)}</strong> hPa
            </span>
          </>
        ) : (
          <span className="text-zinc-500">{loading ? "Druckwerte werden geladen…" : "Kein aktueller Messwert"}</span>
        )}
      </div>

      {/* Legende des Druck-Diagramms. Ohne Titelzeile "Druck (hPa)" und ohne
          "Süd höher / Nord höher" (vom Projektbesitzer abgelehnt, Nov. 2026). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <LegendItem color={MEASURED_COLOR} width={2}>gemessen</LegendItem>
        <LegendItem color={FORECAST_COLOR} width={1.8} dash={FORECAST_DASH}>
          ICON-CH1{modelRun && <> {formatClock(Date.parse(modelRun))}</>}
        </LegendItem>
        <LegendItem color={ECMWF_COLOR} width={1.6} dash={FORECAST_DASH}>
          ECMWF{ecmwfRun && <> {formatClock(Date.parse(ecmwfRun))}</>}
        </LegendItem>
        <LegendItem color={ICON_D2_COLOR} width={1.6} dash={FORECAST_DASH}>
          ICON-D2{iconD2Run && <> {formatClock(Date.parse(iconD2Run))}</>}
        </LegendItem>
      </div>

      {/* Diagramm-Bereich: füllt den Rest des Fensters (siehe useChartHeight). */}
      <div ref={chartAreaRef} className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex shrink-0 pr-1" style={{ height: svgH }}>
        {/* Feste hPa-Spalte links, wandert beim Verschieben nicht mit. */}
        <div className="relative w-8 shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400" aria-hidden="true">
          {/* Farbstreifen der Stufen (wie im Schild auf der Karte). */}
          {chart.scaleBands.map((band, i) => (
            <span
              key={`b${i}`}
              className="absolute right-0 w-1"
              style={{ top: band.top, height: band.height, background: band.color, opacity: SCALE_STRIP_OPACITY }}
            />
          ))}
          {/* hPa-Zahlen genau auf den Farbsprüngen (und die 0). */}
          {chart.stepLines.map(
            (line, i) =>
              line.showLabel && (
                <span
                  key={`sl${i}`}
                  className="absolute right-2 -translate-y-1/2 leading-[10px] tabular-nums"
                  style={{ top: line.y }}
                >
                  {line.label}
                </span>
              ),
          )}
          {chart.showZeroLabel && (
            <span className="absolute right-2 -translate-y-1/2 leading-[10px] tabular-nums" style={{ top: chart.y(0) }}>
              0
            </span>
          )}
          {chart.tTicks.map((tick) => (
            <span
              key={`t${tick}`}
              className="absolute right-2 -translate-y-1/2 tabular-nums"
              style={{ top: chart.ty(tick) }}
            >
              {tick < 0 ? `−${-tick}` : tick}°
            </span>
          ))}
        </div>
        <div
          ref={scrollRef}
          className="min-w-0 flex-1 cursor-grab overflow-x-auto overflow-y-hidden active:cursor-grabbing"
          style={{ scrollbarWidth: "thin" }}
          onPointerDown={(e) => {
            if (e.pointerType !== "mouse" || !scrollRef.current) return;
            drag.current = { x: e.clientX, scrollLeft: scrollRef.current.scrollLeft };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current || !scrollRef.current) return;
            scrollRef.current.scrollLeft = drag.current.scrollLeft - (e.clientX - drag.current.x);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <svg width={chart.svgW} height={svgH} viewBox={`0 0 ${chart.svgW} ${svgH}`} className="block select-none">
            {/* Fläche zwischen gemessener Kurve und Nulllinie: rot oberhalb,
                blau unterhalb (wie im ΔT-Diagramm darunter). */}
            <defs>
              <clipPath id="dp-above">
                <rect x={0} y={PAD_TOP} width={chart.svgW} height={chart.y(0) - PAD_TOP} />
              </clipPath>
              <clipPath id="dp-below">
                <rect x={0} y={chart.y(0)} width={chart.svgW} height={PAD_TOP + chartH - chart.y(0)} />
              </clipPath>
            </defs>
            {/* Prognose-Zone: rechts von "jetzt" grau hinterlegt. */}
            <rect x={chart.nowX} y={PAD_TOP} width={Math.max(0, chart.svgW - chart.nowX)} height={timeTop - PAD_TOP} fill={FORECAST_ZONE_FILL} />
            <text x={chart.nowX + 5} y={PAD_TOP + 10} fontSize={10} fill="#71717a">
              Prognose ▸
            </text>
            <path d={chart.measuredAreaPath} fill={AREA_ABOVE_FILL} opacity={AREA_OPACITY} clipPath="url(#dp-above)" />
            <path d={chart.measuredAreaPath} fill={AREA_BELOW_FILL} opacity={AREA_OPACITY} clipPath="url(#dp-below)" />
            {/* Graue Linien nur auf den Farbsprüngen (Zahlen links), dazu die
                Nulllinie. */}
            {chart.stepLines.map((line, i) => (
              <line
                key={`s${i}`}
                x1={0}
                x2={chart.svgW}
                y1={line.y}
                y2={line.y}
                stroke={line.strong ? STRONG_STEP_LINE_COLOR : STEP_LINE_COLOR}
                strokeWidth={line.strong ? STRONG_STEP_LINE_WIDTH : STEP_LINE_WIDTH}
                strokeDasharray={line.strong ? STRONG_STEP_LINE_DASH : undefined}
              />
            ))}
            <line x1={0} x2={chart.svgW} y1={chart.y(0)} y2={chart.y(0)} stroke="#18181b" strokeWidth={1.2} />
            {/* Temperatur-Diagramm: Gitter, Fläche zwischen den Kurven
                (rot = Süden wärmer, blau = Norden wärmer; Prognose blasser).
                "warm"/"cold" in buildBandPaths = Norden wärmer/kälter. */}
            {chart.tTicks.map((tick) => (
              <line
                key={`tg${tick}`}
                x1={0}
                x2={chart.svgW}
                y1={chart.ty(tick)}
                y2={chart.ty(tick)}
                stroke={tick === 0 ? "#a1a1aa" : "#e4e4e7"}
                strokeWidth={1}
              />
            ))}
            {/* Prognose-Fläche zuerst (liegt in der Vergangenheit hinter der Messung). */}
            <path d={chart.bandForecast.warm} fill={TEMP_NORTH_WARMER_FILL} opacity={TEMP_FORECAST_FILL_OPACITY} />
            <path d={chart.bandForecast.cold} fill={TEMP_SOUTH_WARMER_FILL} opacity={TEMP_FORECAST_FILL_OPACITY} />
            <path d={chart.band.warm} fill={TEMP_NORTH_WARMER_FILL} opacity={TEMP_FILL_OPACITY} />
            <path d={chart.band.cold} fill={TEMP_SOUTH_WARMER_FILL} opacity={TEMP_FILL_OPACITY} />
            {chart.times.map((t) => {
              const date = new Date(t);
              const hour = date.getHours();
              const midnight = hour === 0;
              // Um Mitternacht steht unter beiden Diagrammen der Tag statt "00".
              const dayLabel = date.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" });
              return (
                <g key={t}>
                  {/* Senkrechte Linien nur alle 2 h (Lesbarkeit), Mitternacht kräftiger. */}
                  {hour % LABEL_EVERY_HOURS === 0 && (
                    <>
                      <line
                        x1={chart.x(t)}
                        x2={chart.x(t)}
                        y1={tempTop}
                        y2={timeTop + (midnight ? 4 : 0)}
                        stroke={midnight ? "#71717a" : "#e4e4e7"}
                        strokeWidth={1}
                      />
                      <line
                        x1={chart.x(t)}
                        x2={chart.x(t)}
                        y1={PAD_TOP}
                        y2={PAD_TOP + chartH}
                        stroke={midnight ? "#71717a" : "#e4e4e7"}
                        strokeWidth={1}
                      />
                    </>
                  )}
                  {hour % LABEL_EVERY_HOURS === 0 && (
                    <text
                      x={chart.x(t)}
                      y={PAD_TOP + chartH + 11}
                      textAnchor="middle"
                      fontSize={10}
                      fill={midnight ? "#18181b" : "#71717a"}
                      fontWeight={midnight ? 600 : 400}
                      className="tabular-nums"
                    >
                      {midnight ? dayLabel : String(hour).padStart(2, "0")}
                    </text>
                  )}
                  {hour % LABEL_EVERY_HOURS === 0 && (
                    <text
                      x={chart.x(t)}
                      y={timeTop + 12}
                      textAnchor="middle"
                      fontSize={10}
                      fill={midnight ? "#18181b" : "#71717a"}
                      fontWeight={midnight ? 600 : 400}
                      className="tabular-nums"
                    >
                      {midnight ? dayLabel : String(hour).padStart(2, "0")}
                    </text>
                  )}
                </g>
              );
            })}
            {/* Jetzt-Linie zwischen Messung und Prognose. */}
            <line
              x1={chart.nowX}
              x2={chart.nowX}
              y1={PAD_TOP}
              y2={timeTop}
              stroke="#18181b"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            {/* Temperaturen: gemessen durchgezogen, ICON-CH1 gestrichelt. */}
            <path d={chart.southTempForecastPath} fill="none" stroke={SOUTH_TEMP_COLOR} strokeWidth={1.4} strokeDasharray={FORECAST_DASH} />
            <path d={chart.northTempForecastPath} fill="none" stroke={NORTH_TEMP_COLOR} strokeWidth={1.4} strokeDasharray={FORECAST_DASH} />
            <path d={chart.southTempPath} fill="none" stroke={SOUTH_TEMP_COLOR} strokeWidth={1.6} strokeLinejoin="round" />
            <path d={chart.northTempPath} fill="none" stroke={NORTH_TEMP_COLOR} strokeWidth={1.6} strokeLinejoin="round" />
            {/* Druck-Prognosen über den ganzen Zeitraum, hinter der Messung. */}
            <path d={chart.ecmwfPath} fill="none" stroke={ECMWF_COLOR} strokeWidth={1.6} strokeDasharray={FORECAST_DASH} />
            <path d={chart.iconD2Path} fill="none" stroke={ICON_D2_COLOR} strokeWidth={1.6} strokeDasharray={FORECAST_DASH} />
            <path d={chart.forecastPath} fill="none" stroke={FORECAST_COLOR} strokeWidth={1.8} strokeDasharray={FORECAST_DASH} />
            <path d={chart.measuredPath} fill="none" stroke={MEASURED_COLOR} strokeWidth={2} strokeLinejoin="round" />
          </svg>
        </div>
        {/* Titelzeile des Temperatur-Diagramms, fest (wandert nicht mit), in
            der Lücke zwischen den beiden Diagrammen. Seit 7. Nov. 2026 wie
            die Kopfzeile über dem Druck-Diagramm (Wunsch des
            Projektbesitzers): links das große Δ-Schild (Süd − Nord, hellrot =
            Süden wärmer, hellblau = Norden wärmer), rechts die beiden
            Temperaturen in 15 px, darunter die Legende in 11 px. Seit 8. Nov.
            2026 Rittnerhorn/Hafelekar: Die beiden Temperaturen stehen
            untereinander, jede mit einem Linienstück in ihrer Farbe (statt
            in der Legende) — für eine Zeile sind die Namen zu lang. */}
        <div
          className="pointer-events-none absolute inset-x-0 bg-white px-3 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          style={{ top: PAD_TOP + chartH + PRESSURE_TIME_H + TEMP_TITLE_PAD_PX, height: TEMP_TITLE_CONTENT_H }}
        >
          {/* Titel wie ganz oben beim Druck: "Temperatur auf 2260 m · Stand: …". */}
          <h3 className="truncate pb-1 text-sm leading-5 font-semibold text-zinc-900 dark:text-zinc-50">
            Temperatur auf 2260 m
            {currentTemp && (
              <span className="font-normal text-zinc-500 dark:text-zinc-400">
                {" "}
                · Stand: {formatDateTime(currentTemp.time)}
              </span>
            )}
          </h3>
          <div className="flex items-center gap-x-3 pb-2">
            {currentTemp ? (
              <>
                <span
                  className="border border-black px-2 py-1 text-base font-bold tabular-nums text-zinc-900"
                  style={{ background: -currentTemp.diff > 0 ? "#fecaca" : -currentTemp.diff < 0 ? "#bfdbfe" : "#e4e4e7" }}
                >
                  Δ {formatSigned(-currentTemp.diff)} °C
                </span>
                {/* Feld north = Süd-Station, south = Nord-Station (siehe buildBandPaths). */}
                <span className="ml-auto flex flex-col items-end text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">
                  <TempValue color={SOUTH_TEMP_COLOR} name={crestSouth.name} value={currentTemp.north} />
                  <TempValue color={NORTH_TEMP_COLOR} name={crestNorth.name} value={currentTemp.south} />
                </span>
              </>
            ) : (
              <span className="py-1 text-base text-zinc-500">Kein aktueller Messwert</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <LegendItem color={FORECAST_COLOR} width={1.8} dash={FORECAST_DASH}>ICON-CH1</LegendItem>
            <span className="whitespace-nowrap">
              <span style={{ color: TEMP_SOUTH_WARMER_FILL }}>■</span> Süden wärmer
            </span>
            <span className="whitespace-nowrap">
              <span style={{ color: TEMP_NORTH_WARMER_FILL }}>■</span> Norden wärmer
            </span>
          </div>
        </div>
      </div>

      </div>

      {/* Luft unter der Zeitachse. */}
      <div className="h-2 shrink-0" />
    </section>
  );
}

// Eine Temperatur rechts neben dem Δ-Schild: Linienstück in der Farbe der
// Kurve, Name der Station, Wert, z. B. "— Rittnerhorn −2,7 °C".
function TempValue({ color, name, value }: { color: string; name: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <svg width="16" height="6" aria-hidden="true">
        <line x1={1} y1={3} x2={15} y2={3} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      </svg>
      <span>
        {name} <strong className="tabular-nums text-zinc-800 dark:text-zinc-100">{formatTemp(value)}</strong> °C
      </span>
    </span>
  );
}

// Ein Eintrag der Legende: kurzes Linienstück im Muster der Kurve, daneben der Text.
function LegendItem({
  color,
  width,
  dash,
  children,
}: {
  color: string;
  width: number;
  dash?: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <svg width="18" height="6" aria-hidden="true">
        <line x1={1} y1={3} x2={17} y2={3} stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
      </svg>
      {children}
    </span>
  );
}
