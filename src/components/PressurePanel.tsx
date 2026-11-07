"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
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
// der Karte. Oben die aktuellen Werte (QNH) beider Seiten und die Differenz,
// darunter das Diagramm: Differenz Bozen − Innsbruck der letzten 48 h —
// schwarz die 10-Minuten-Werte der Stationen (Hauptkurve), dünn grau
// punktiert die Flugwetter-Meldungen der Flughäfen (Vergleich, Wunsch des
// Projektbesitzers) — und die Prognosen ICON-CH1 (grau gestrichelt, 33 h
// voraus) und ECMWF (violett gestrichelt, 72 h voraus, seit Nov. 2026).
// Darunter ein zweites, flacheres Diagramm: Temperatur Innsbruck und Bozen
// (siehe TEMP_* unten). Über der Nulllinie = Süd höher (Südföhn-Lage), darunter = Nord
// höher (Nordföhn-Lage). Die Fläche zwischen gemessener Kurve und Nulllinie
// ist rot (oberhalb) bzw. blau (unterhalb), die Farbstufen der Karte stehen
// als schmaler Farbstreifen neben den hPa-Zahlen (siehe AREA_* / scaleBands).
//
// AUFRÄUMEN (Nov. 2026, Wunsch des Projektbesitzers, "Anzeige noch etwas
// unübersichtlich"): Kopfzeile nur zwei Zeilen (großes Differenz-Schild); jedes
// Diagramm hat seine EIGENE Titelzeile mit Legende (nichts liegt mehr auf den
// Kurven); die Prognose-Zone rechts von "jetzt" ist grau hinterlegt, dafür
// gibt es die blassen Prognose-Linien vor "jetzt" nicht mehr; ECMWF ist
// violett (Blau und Rot gehören den Flächen); die Stufen der Farbskala stehen
// als Streifen am Rand statt als fünf Linien quer durchs Diagramm; die
// Temperatur-Differenz zählt wie der Druck Bozen − Innsbruck. Die Quellen
// stehen unter "Quellen" im Ebenen-Menü (Wunsch des Projektbesitzers).
// Aufbau wie der Wind-Verlaufsbalken (WindHistoryPanel: weiß, unten,
// Schließen-Kreuz oben rechts, Escape schließt). Die Zeitachse ist STÜNDLICH
// beschriftet und das Diagramm seitlich verschiebbar (Wunsch des
// Projektbesitzers, Nov. 2026; vorher in die Breite gestaucht): am Handy mit
// dem Finger wischen, am Computer mit der Maus ziehen oder scrollen. Beim
// Öffnen steht "jetzt" in der Mitte (wie im Wind-Verlaufsbalken). Die
// hPa-Zahlen links stehen fest und wandern nicht mit.

const CHART_H = 150;
// Zwei Zeilen unter dem Diagramm: Stunde, darunter an Mitternacht das Datum.
const TIME_LABEL_H = 30;
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
// Mitwachsende y-Achse wie im Wind-Verlaufsbalken (Wunsch des
// Projektbesitzers, Nov. 2026): Oben (Süd höher) und unten (Nord höher)
// reicht sie je mindestens Y_MIN_EXTENT_HPA weit — so ist die Grenze zu Rot
// (3 hPa) immer zu sehen und ruhige Tage bleiben vergleichbar. Darüber wächst
// jede Seite für sich in ganzen hPa (Y_STEP_HPA), bis der höchste bzw.
// tiefste Wert (Messung oder Prognose) mit Y_HEADROOM_HPA Luft hineinpasst.
// Eine Seite ohne große Werte bleibt also schmal, statt gespiegelt
// mitzuwachsen.
const Y_MIN_EXTENT_HPA = 3;
const Y_STEP_HPA = 1;
const Y_HEADROOM_HPA = 0.3;
// Die gemessenen Kurven (Druck UND Temperatur) zeigen nur einen Wert alle
// 20 min (zu :00, :20, :40; Wunsch des Projektbesitzers, Nov. 2026 — mit allen
// 10-Minuten-Werten waren sie zu unruhig, halbstündlich war ihm zu grob).
// Gespeichert und abgefragt wird weiter alle 10 min; Kopfzeile und Karte
// zeigen den neuesten Wert.
const MEASURED_STEP_MINUTES = 20;
// Messlücke, ab der eine Kurve unterbrochen wird. Gemessene Kurven (alle
// 20 min): ein fehlender Wert wird überbrückt, zwei nicht. METAR: Bozen
// meldet stündlich, ein fehlender wird überbrückt, die Nacht (keine
// Meldungen) nicht.
const MEASURED_GAP_MS = 50 * 60 * 1000;
const METAR_GAP_MS = 150 * 60 * 1000;
// Vergleichslinie der Flughafen-Meldungen: dünn, hellgrau, punktiert —
// bewusst zurückhaltend, sie ist nur zum Vergleich da.
const METAR_COLOR = "#a1a1aa";
const METAR_DASH = "1 3";
const FORECAST_GAP_MS = 90 * 60 * 1000;
// Wie die Prognose im Wind-Verlaufsbalken (CH1_COLOR, FORECAST_DASH).
const FORECAST_COLOR = "#52525b";
const FORECAST_DASH = "5 3";
// ECMWF (seit Nov. 2026, Wunsch des Projektbesitzers): gestrichelt, damit es
// sich klar vom grauen ICON-CH1 abhebt; seit dem Aufräumen (Nov. 2026)
// VIOLETT statt blau, weil Blau und Rot den Flächen gehören (Nord höher /
// Süd höher bzw. Innsbruck wärmer / Bozen wärmer). Reicht 72 h voraus,
// ICON-CH1 33 h.
const ECMWF_COLOR = "#7c3aed";
const MEASURED_COLOR = "#18181b";
// LESBARKEIT: Senkrechte Rasterlinien nur alle 2 h, ruhigere hPa-Beschriftung,
// kurze Legende mit Linienmustern in der Titelzeile des Diagramms. Vor "jetzt"
// zählt allein die Messung (die blassen Prognose-Linien dort gibt es seit dem
// Aufräumen im Nov. 2026 nicht mehr); rechts von "jetzt" ist der Hintergrund
// grau und mit "Prognose" beschriftet.
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

// --- Temperatur Innsbruck und Bozen (Nov. 2026, Wunsch des Projektbesitzers) ---
// Eigenes Diagramm UNTER dem Druck, auf derselben Zeitachse (verschiebt sich
// mit). Gezeigt werden die gemessenen Temperaturen beider Stationen als
// Linien (Innsbruck blau, Bozen braun) — die Fläche ZWISCHEN den beiden
// Linien ist die Temperatur-Differenz. Seit Nov. 2026 gezählt wie beim Druck:
// Bozen − Innsbruck (vorher umgekehrt, das verwirrte): rot, wo Bozen (Süden)
// wärmer ist, blau, wo Innsbruck wärmer ist. (buildBandPaths rechnet intern aus
// Innsbrucks Sicht: "warm" = Innsbruck wärmer.) (Erste Fassung zeigte
// nur ΔT um eine Nulllinie; der Projektbesitzer wollte auch die gemessenen
// Temperaturen sehen.) Nach "jetzt" die ICON-CH1-Prognose beider Stationen
// gestrichelt, die Fläche dazwischen blasser. Allein wegen der Höhe
// (Innsbruck ~330 m höher) ist Innsbruck normal ~2 °C kälter.
// Abstand zwischen Druck- und Temperatur-Diagramm: oben die Stundenzahlen
// unter dem Druck-Diagramm (PRESSURE_TIME_H, Wunsch des Projektbesitzers,
// Nov. 2026), darunter die Titelzeile des Temperatur-Diagramms (zwei kleine
// Zeilen).
const PRESSURE_TIME_H = 14;
const TEMP_TITLE_H = 34;
const TEMP_GAP = PRESSURE_TIME_H + TEMP_TITLE_H;
const TEMP_H = 100;
const TEMP_TOP = PAD_TOP + CHART_H + TEMP_GAP;
const TIME_TOP = TEMP_TOP + TEMP_H;
// Mitwachsende Achse in °C: mindestens 10 °C Spanne, in 5-°C-Schritten.
const T_MIN_SPAN_C = 10;
const T_STEP_C = 5;
const T_HEADROOM_C = 0.5;
const TEMP_GAP_MS = MEASURED_GAP_MS;
// Innsbruck blau (Wunsch des Projektbesitzers, Nov. 2026; vorher schwarz).
const IBK_COLOR = "#2563eb";
const BZ_COLOR = "#b45309";
const TEMP_BZ_WARMER_FILL = "#dc2626";
const TEMP_IBK_WARMER_FILL = "#2563eb";
const TEMP_FILL_OPACITY = 0.25;
const TEMP_FORECAST_FILL_OPACITY = 0.1;

type Series = Array<[number, number]>;

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

// Fläche zwischen den Temperaturen beider Stationen, getrennt nach "Innsbruck
// wärmer" (warm) und "kälter" (cold). `pairs` kommt aus pairPressureSeries
// (Bozen, Innsbruck): north = Bozen, south = Innsbruck, diff = IBK − BZ. Je
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

// Prognose ab "jetzt" (die Vergangenheit zeigt die Messung); der letzte Punkt
// vor jetzt bleibt dabei, damit die Linie nicht erst nach "jetzt" beginnt.
function forecastFromNow(points: PressureDiffPoint[], now: number): PressureDiffPoint[] {
  const last = points.filter((p) => p.time <= now).pop();
  return points.filter((p) => p.time > now || p === last);
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

/** QNH mit einer Nachkommastelle, z. B. "1019,6". */
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
  metar,
  forecast,
  modelRun,
  ecmwf,
  ecmwfRun,
  tempDiff,
  tempDiffForecast,
  tempNorth,
  tempSouth,
  tempNorthForecast,
  tempSouthForecast,
  loading,
  onClose,
}: {
  /** 10-Minuten-Werte der Stationen (Hauptkurve). */
  measured: PressureDiffPoint[];
  /** Flugwetter-Meldungen der Flughäfen (Vergleichslinie). */
  metar: PressureDiffPoint[];
  forecast: PressureDiffPoint[];
  modelRun: string | null;
  /** ECMWF-Prognose (blau gestrichelt). */
  ecmwf: PressureDiffPoint[];
  ecmwfRun: string | null;
  /** Temperatur-Differenz Innsbruck − Bozen (°C), gemessen. */
  tempDiff: PressureDiffPoint[];
  /** Dasselbe aus der ICON-CH1-Prognose. */
  tempDiffForecast: PressureDiffPoint[];
  /** Gemessene Temperaturen (°C): north = Innsbruck, south = Bozen. */
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
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // Fehlen die Stationswerte, die Flughafen-Meldungen (wie auf der Karte).
  const current = pressureDiffAt(measured, now) ?? pressureDiffAt(metar, now);
  const currentTemp = pressureDiffAt(tempDiff, now);

  const chart = useMemo(() => {
    // Volle Stunden: links 48 h zurück, rechts bis zum Ende der längsten
    // Prognose (ECMWF 72 h, ICON-CH1 33 h), mindestens bis in einer Stunde.
    const start = Math.floor((now - HISTORY_HOURS * HOUR_MS) / HOUR_MS) * HOUR_MS;
    const lastForecast = Math.max(
      forecast.length > 0 ? forecast[forecast.length - 1].time : now,
      ecmwf.length > 0 ? ecmwf[ecmwf.length - 1].time : now,
    );
    const end = Math.ceil(Math.max(now + HOUR_MS, lastForecast) / HOUR_MS) * HOUR_MS;
    const inRange = (p: PressureDiffPoint) => p.time >= start && p.time <= end;
    // Nur die Werte zu :00, :20, :40 (siehe MEASURED_STEP_MINUTES).
    const onStep = (t: number) => new Date(t).getUTCMinutes() % MEASURED_STEP_MINUTES === 0;
    const m = measured.filter((p) => inRange(p) && onStep(p.time));
    const f = forecast.filter(inRange);
    const mt = metar.filter(inRange);
    const e = ecmwf.filter(inRange);
    const fFuture = forecastFromNow(f, now);
    const eFuture = forecastFromNow(e, now);
    // Die Achse richtet sich nur nach dem, was gezeichnet wird.
    const values = [...m, ...mt, ...fFuture, ...eFuture].map((p) => p.diff);
    const grow = (extent: number) =>
      Math.max(Y_MIN_EXTENT_HPA, Math.ceil((extent + Y_HEADROOM_HPA) / Y_STEP_HPA) * Y_STEP_HPA);
    const yTop = grow(Math.max(0, ...values));
    const yBottom = -grow(Math.max(0, ...values.map((v) => -v)));
    const svgW = PAD_X * 2 + ((end - start) / HOUR_MS) * PX_PER_HOUR;
    const x = (t: number) => PAD_X + ((t - start) / HOUR_MS) * PX_PER_HOUR;
    const y = (v: number) =>
      PAD_TOP + ((yTop - Math.max(yBottom, Math.min(yTop, v))) / (yTop - yBottom)) * CHART_H;
    // Beschriftung: jede hPa, bei großer Spanne jede zweite bzw. vierte.
    const span = yTop - yBottom;
    const tickStep = span > 20 ? 4 : span > 7 ? 2 : 1;
    const ticks: number[] = [];
    for (let v = Math.ceil(yBottom / tickStep) * tickStep; v <= yTop; v += tickStep) ticks.push(v);
    // Temperatur-Diagramm darunter, eigene mitwachsende Achse in °C.
    const inRangeS = ([t]: [number, number]) => t >= start && t <= end;
    const tN = tempNorth.filter((p) => inRangeS(p) && onStep(p[0]));
    const tS = tempSouth.filter((p) => inRangeS(p) && onStep(p[0]));
    // Prognose nur ab "jetzt" (die Vergangenheit zeigt die Messung).
    const lastHour = now - HOUR_MS;
    const tNf = tempNorthForecast.filter(([t]) => t >= lastHour && t <= end);
    const tSf = tempSouthForecast.filter(([t]) => t >= lastHour && t <= end);
    const bandM = tempDiff.filter((p) => inRange(p) && onStep(p.time));
    const bandF = tempDiffForecast.filter((p) => p.time >= lastHour && p.time <= end);
    const tAll = [...tN, ...tS, ...tNf, ...tSf].map(([, v]) => v);
    let tLow = tAll.length ? Math.floor((Math.min(...tAll) - T_HEADROOM_C) / T_STEP_C) * T_STEP_C : 0;
    let tHigh = tAll.length ? Math.ceil((Math.max(...tAll) + T_HEADROOM_C) / T_STEP_C) * T_STEP_C : T_MIN_SPAN_C;
    while (tHigh - tLow < T_MIN_SPAN_C) {
      // Abwechselnd oben und unten erweitern, damit die Kurven mittig bleiben.
      if ((tHigh - tLow) % (2 * T_STEP_C) === 0) tHigh += T_STEP_C;
      else tLow -= T_STEP_C;
    }
    const ty = (v: number) =>
      TEMP_TOP + ((tHigh - Math.max(tLow, Math.min(tHigh, v))) / (tHigh - tLow)) * TEMP_H;
    const tTickStep = tHigh - tLow > 30 ? 10 : T_STEP_C;
    const tTicks: number[] = [];
    for (let v = Math.ceil(tLow / tTickStep) * tTickStep; v <= tHigh; v += tTickStep) tTicks.push(v);
    // Jede volle Stunde (Ortszeit; bei Zeitzonen mit halben Stunden passt
    // das nicht, für die Alpen egal).
    const times: number[] = [];
    for (let t = start; t <= end; t += HOUR_MS) times.push(t);
    // Farbstreifen der Stufen neben den hPa-Zahlen, oberhalb und unterhalb der
    // Nulllinie gespiegelt (soweit die Achse reicht): blau bis 0,5, grün bis
    // 1,5, gelb bis 2,5, orange bis 3, darüber rot.
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
    return {
      svgW,
      x,
      y,
      ticks,
      times,
      scaleBands,
      measuredPath: buildPath(m, x, y, MEASURED_GAP_MS),
      measuredAreaPath: buildAreaPath(m, x, y, MEASURED_GAP_MS),
      metarPath: buildPath(mt, x, y, METAR_GAP_MS),
      forecastPath: buildPath(fFuture, x, y, FORECAST_GAP_MS),
      ecmwfPath: buildPath(eFuture, x, y, FORECAST_GAP_MS),
      ty,
      tTicks,
      ibkPath: buildSeriesPath(tN, x, ty, TEMP_GAP_MS),
      bzPath: buildSeriesPath(tS, x, ty, TEMP_GAP_MS),
      ibkForecastPath: buildSeriesPath(tNf, x, ty, FORECAST_GAP_MS),
      bzForecastPath: buildSeriesPath(tSf, x, ty, FORECAST_GAP_MS),
      band: buildBandPaths(bandM, x, ty, TEMP_GAP_MS),
      bandForecast: buildBandPaths(bandF, x, ty, FORECAST_GAP_MS),
      nowX: x(now),
    };
  }, [now, measured, metar, forecast, ecmwf, tempDiff, tempDiffForecast, tempNorth, tempSouth, tempNorthForecast, tempSouthForecast]);

  // Beim ersten Zeichnen "jetzt" in die Mitte schieben.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledToNow.current || (measured.length === 0 && forecast.length === 0)) return;
    el.scrollLeft = Math.max(0, chart.nowX - el.clientWidth / 2);
    scrolledToNow.current = true;
  }, [chart, measured.length, forecast.length]);

  const svgH = TIME_TOP + TIME_LABEL_H;
  const currentColor = current ? foehnColor(current.diff) : null;

  return (
    <section
      aria-label="Föhn: Druckdifferenz Bozen − Innsbruck"
      className="absolute inset-x-0 bottom-0 z-[1100] border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(0,0,0,0.18)] dark:border-zinc-700 dark:bg-zinc-900"
    >
      <header className="flex items-center gap-3 px-3 pt-2 pb-1">
        <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Föhn: Druck Bozen − Innsbruck
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
          beiden Druckwerte (QNH). Bewusst ohne erklärenden Satz (Wunsch des
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
        <LegendItem color={METAR_COLOR} width={1.5} dash={METAR_DASH}>Flughäfen</LegendItem>
        <LegendItem color={FORECAST_COLOR} width={1.8} dash={FORECAST_DASH}>
          ICON-CH1{modelRun && <> {formatClock(Date.parse(modelRun))}</>}
        </LegendItem>
        <LegendItem color={ECMWF_COLOR} width={1.6} dash={FORECAST_DASH}>
          ECMWF{ecmwfRun && <> {formatClock(Date.parse(ecmwfRun))}</>}
        </LegendItem>
      </div>

      <div className="relative flex pr-1" style={{ height: svgH }}>
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
          {chart.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-2 -translate-y-1/2 tabular-nums"
              style={{ top: chart.y(tick) }}
            >
              {tick > 0 ? `+${tick}` : tick < 0 ? `−${-tick}` : "0"}
            </span>
          ))}
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
                <rect x={0} y={chart.y(0)} width={chart.svgW} height={PAD_TOP + CHART_H - chart.y(0)} />
              </clipPath>
            </defs>
            {/* Prognose-Zone: rechts von "jetzt" grau hinterlegt. */}
            <rect x={chart.nowX} y={PAD_TOP} width={Math.max(0, chart.svgW - chart.nowX)} height={TIME_TOP - PAD_TOP} fill={FORECAST_ZONE_FILL} />
            <text x={chart.nowX + 5} y={PAD_TOP + 10} fontSize={10} fill="#71717a">
              Prognose ▸
            </text>
            <path d={chart.measuredAreaPath} fill={AREA_ABOVE_FILL} opacity={AREA_OPACITY} clipPath="url(#dp-above)" />
            <path d={chart.measuredAreaPath} fill={AREA_BELOW_FILL} opacity={AREA_OPACITY} clipPath="url(#dp-below)" />
            {chart.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={chart.svgW}
                y1={chart.y(tick)}
                y2={chart.y(tick)}
                stroke={tick === 0 ? "#18181b" : "#e4e4e7"}
                strokeWidth={tick === 0 ? 1.2 : 1}
              />
            ))}
            {/* Temperatur-Diagramm: Gitter, Fläche zwischen den Kurven
                (rot = Bozen wärmer, blau = Innsbruck wärmer; Prognose blasser).
                "warm"/"cold" in buildBandPaths = Innsbruck wärmer/kälter. */}
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
            <path d={chart.band.warm} fill={TEMP_IBK_WARMER_FILL} opacity={TEMP_FILL_OPACITY} />
            <path d={chart.band.cold} fill={TEMP_BZ_WARMER_FILL} opacity={TEMP_FILL_OPACITY} />
            <path d={chart.bandForecast.warm} fill={TEMP_IBK_WARMER_FILL} opacity={TEMP_FORECAST_FILL_OPACITY} />
            <path d={chart.bandForecast.cold} fill={TEMP_BZ_WARMER_FILL} opacity={TEMP_FORECAST_FILL_OPACITY} />
            {chart.times.map((t) => {
              const date = new Date(t);
              const hour = date.getHours();
              const midnight = hour === 0;
              return (
                <g key={t}>
                  {/* Senkrechte Linien nur alle 2 h (Lesbarkeit), Mitternacht kräftiger. */}
                  {hour % LABEL_EVERY_HOURS === 0 && (
                    <>
                      <line
                        x1={chart.x(t)}
                        x2={chart.x(t)}
                        y1={TEMP_TOP}
                        y2={TIME_TOP + (midnight ? 4 : 0)}
                        stroke={midnight ? "#71717a" : "#e4e4e7"}
                        strokeWidth={1}
                      />
                      <line
                        x1={chart.x(t)}
                        x2={chart.x(t)}
                        y1={PAD_TOP}
                        y2={PAD_TOP + CHART_H}
                        stroke={midnight ? "#71717a" : "#e4e4e7"}
                        strokeWidth={1}
                      />
                    </>
                  )}
                  {hour % LABEL_EVERY_HOURS === 0 && (
                    <text
                      x={chart.x(t)}
                      y={PAD_TOP + CHART_H + 11}
                      textAnchor="middle"
                      fontSize={10}
                      fill={midnight ? "#18181b" : "#71717a"}
                      fontWeight={midnight ? 600 : 400}
                      className="tabular-nums"
                    >
                      {String(hour).padStart(2, "0")}
                    </text>
                  )}
                  {hour % LABEL_EVERY_HOURS === 0 && (
                    <text
                      x={chart.x(t)}
                      y={TIME_TOP + 12}
                      textAnchor="middle"
                      fontSize={10}
                      fill={midnight ? "#18181b" : "#71717a"}
                      fontWeight={midnight ? 600 : 400}
                      className="tabular-nums"
                    >
                      {String(hour).padStart(2, "0")}
                    </text>
                  )}
                  {midnight && (
                    <text
                      x={chart.x(t) + 2}
                      y={TIME_TOP + 25}
                      textAnchor="start"
                      fontSize={10}
                      fill="#18181b"
                      fontWeight={600}
                    >
                      {date.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" })}
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
              y2={TIME_TOP}
              stroke="#18181b"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            {/* Temperaturen: gemessen durchgezogen, ICON-CH1 gestrichelt. */}
            <path d={chart.bzForecastPath} fill="none" stroke={BZ_COLOR} strokeWidth={1.4} strokeDasharray={FORECAST_DASH} />
            <path d={chart.ibkForecastPath} fill="none" stroke={IBK_COLOR} strokeWidth={1.4} strokeDasharray={FORECAST_DASH} />
            <path d={chart.bzPath} fill="none" stroke={BZ_COLOR} strokeWidth={1.6} strokeLinejoin="round" />
            <path d={chart.ibkPath} fill="none" stroke={IBK_COLOR} strokeWidth={1.6} strokeLinejoin="round" />
            {/* Druck-Prognosen: nur ab "jetzt". */}
            <path d={chart.ecmwfPath} fill="none" stroke={ECMWF_COLOR} strokeWidth={1.6} strokeDasharray={FORECAST_DASH} />
            <path d={chart.forecastPath} fill="none" stroke={FORECAST_COLOR} strokeWidth={1.8} strokeDasharray={FORECAST_DASH} />
            {/* Unter der Hauptkurve: die Flughafen-Meldungen zum Vergleich. */}
            <path d={chart.metarPath} fill="none" stroke={METAR_COLOR} strokeWidth={1} strokeDasharray={METAR_DASH} strokeLinecap="round" />
            <path d={chart.measuredPath} fill="none" stroke={MEASURED_COLOR} strokeWidth={2} strokeLinejoin="round" />
          </svg>
        </div>
        {/* Titelzeile des Temperatur-Diagramms, fest links (wandert nicht mit),
            in der Lücke zwischen den beiden Diagrammen. */}
        <div
          className="pointer-events-none absolute left-9 bg-white/85 px-0.5 text-[10px] leading-[14px] text-zinc-500 dark:bg-zinc-900/85 dark:text-zinc-400"
          style={{ top: PAD_TOP + CHART_H + PRESSURE_TIME_H + 3 }}
        >
          <div className="flex flex-wrap items-center gap-x-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-800 dark:text-zinc-100">Temperatur (°C)</span>
            <span className="font-semibold" style={{ color: IBK_COLOR }}>
              ━ {north.short}
              {currentTemp && <> {formatHpa(currentTemp.south)}°</>}
            </span>
            <span className="font-semibold" style={{ color: BZ_COLOR }}>
              ━ {south.short}
              {currentTemp && <> {formatHpa(currentTemp.north)}°</>}
            </span>
            {currentTemp && (
              <span>
                Δ{" "}
                <strong className="tabular-nums text-zinc-800 dark:text-zinc-100">{formatSigned(-currentTemp.diff)} °C</strong>
              </span>
            )}
          </div>
          <div>
            Fläche: <span style={{ color: TEMP_BZ_WARMER_FILL }}>■ {south.short} wärmer</span>{" "}
            <span style={{ color: TEMP_IBK_WARMER_FILL }}>■ {north.short} wärmer</span>
          </div>
        </div>
      </div>

      {/* Luft unter der Zeitachse. */}
      <div className="h-2" />
    </section>
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
