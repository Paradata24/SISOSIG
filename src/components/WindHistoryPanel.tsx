"use client";

import { useEffect, useRef, useState } from "react";
import {
  FORECAST_MODELS,
  FUTURE_MARGIN_HOURS,
  getWindColor,
  HISTORY_HOURS,
  snapDirectionTo8,
  SOURCE_INFO,
  UPPER_FORECAST_MODEL,
  WIND_COLOR_SCALE,
  type WindStation,
} from "@/lib/wind";
import type { HistoryEntry } from "@/app/api/history/route";
import type {
  ForecastEntry,
  ForecastsByModel,
  UpperForecast,
} from "@/app/api/forecast/route";

// Verlaufspanel am unteren Bildschirmrand (Vorbild: Meteoparapente).
// Zeigt für die angeklickte Station die letzten 12 Stunden (HISTORY_HOURS):
//  - Zeitachse (Lokalzeit) oben
//  - Liniendiagramm: Mittelwind (unten) und Böen (oben), beide gleich dick,
//    mit halbtransparent gefüllter Fläche dazwischen, vor horizontalen
//    Farbbändern der Windstärke-Skala
//  - darunter eine Reihe Windrichtungs-Pfeile
// Farben und Pfeil-Drehung nutzen exakt dieselbe Logik wie die Karten-
// Pfeile (getWindColor bzw. auf 8 Himmelsrichtungen eingerastete Richtung
// + 180°), damit nichts auseinanderläuft. Der exakte Grad-Wert bleibt in
// den Tooltips (title) der Pfeile erhalten.

// Geometrie des SVG (alle Angaben in px). Gegenüber der ursprünglichen
// Version bewusst ca. 10% größer und mit mehr Abstand zwischen den Zeilen,
// damit das Panel nicht mehr gedrängt wirkt.
const TIME_LABEL_H = 20; // Zeile mit den Uhrzeiten oben
const CHART_H = 154; // Höhe des Kurvenbereichs
const ARROW_GAP = 14; // Abstand Kurvenbereich → Pfeilreihe
const ARROW_ROW_H = 29; // Höhe der Pfeilreihe
const VALUES_GAP = 8; // Abstand Pfeilreihe → Werte-Text
const VALUE_LINE_H = 12; // Zeilenhöhe je Textzeile (Mittelwind / Böe)
const VALUES_ROW_H = VALUE_LINE_H * 2; // zwei Zeilen: oben Mittelwind, unten Böe
const D2_ROW_GAP = 12; // Trennung zwischen Messwert-Block (schwarz) und Prognose-Vergleichsblock
const BOTTOM_PAD = 10; // zusätzlicher Freiraum unterhalb der Werte-Zeilen
// Grundhöhe des SVG: Zeitachse + Kurvenbereich + Messwert-Block (Pfeile + 2
// Zeilen) + Prognose-Vergleichsblock (Pfeile + 2 Zeilen; die sichtbaren
// Modelle stehen dort je Stunde nebeneinander) + unterer Rand.
const SVG_H_BASE =
  TIME_LABEL_H + CHART_H +
  ARROW_GAP + ARROW_ROW_H + VALUES_GAP + VALUES_ROW_H +
  D2_ROW_GAP + ARROW_ROW_H + VALUES_GAP + VALUES_ROW_H +
  BOTTOM_PAD;
// Zusatzhöhe NUR bei Windanzeiger-Stationen: eine fette Höhenwind-Zahl unter
// den beiden ICON-D2-Zahlen plus darunter der Höhenwind-Richtungspfeil.
const UPPER_BLOCK_H = VALUE_LINE_H + VALUES_GAP + ARROW_ROW_H;
const PAD_X = 11; // linker/rechter Innenabstand des Diagramms

// Mindestabstand (px) zwischen zwei Pfeil-/Werte-Spalten, damit sich die
// (bis zu 3-stelligen) Zahlen nicht überlappen. Bestimmt die feste Achsen-
// Breite und – als Sicherheitsnetz – die Ausdünnung weiter unten.
const MIN_LABEL_SPACING = 31;
// Gewünschte Anzeige-Dichte: zu jeder vollen Stunde eine Messung, dazwischen
// alle 10 Minuten eine — also 6 Werte pro Stunde.
const LABEL_INTERVAL_MIN = 10;
// Breite pro Stunde für den Geschichts-Teil (jetzt − 12h bis jetzt). FEST (nicht
// datenabhängig) so gewählt, dass die 6 Messungen pro Stunde (alle 10 min) mit
// dem Mindestabstand nebeneinander Platz haben — mit kleinem Puffer, damit genau
// 10 min auseinanderliegende Werte sicher über dem Mindestabstand liegen.
// Dadurch ist die Achse zugleich breiter als der Bildschirm → das Diagramm
// bleibt horizontal scrollbar.
const HISTORY_PX_PER_HOUR = Math.ceil((60 / LABEL_INTERVAL_MIN) * (MIN_LABEL_SPACING + 2));
// Die Prognose-Reserve rechts von der "jetzt"-Linie enthält keine echten
// Messwerte mehr und darf daher 50% enger gepackt sein als der Geschichts-Teil.
const FUTURE_PX_PER_HOUR = HISTORY_PX_PER_HOUR / 2;
const ARROW_SIZE = 17; // Kantenlänge eines Richtungspfeils
// Wie weit die Historie zurückreicht (HISTORY_HOURS) bzw. wie viel Platz rechts
// nach "jetzt" bleibt (FUTURE_MARGIN_HOURS) — beides zentral in src/lib/wind.ts,
// weil /api/history und /api/forecast dieselben Werte brauchen. Die Zeitachse
// läuft fest von (jetzt − 12h) bis (jetzt + 4h), sodass die aktuelle Uhrzeit
// immer nahe dem rechten Rand steht.
// Zwei aufeinanderfolgende Messpunkte werden nur dann zu einer Linie
// verbunden, wenn sie höchstens so weit auseinanderliegen. Gesammelt wird alle
// 10 Minuten (/api/collect, per Supabase Cron); 1 Stunde ist also das Sechsfache
// des Normalabstands und übersteht einzelne verpasste Läufe, verdeckt aber auf
// der 12h-Achse keine echten Datenlücken mehr. Größere Lücken bleiben als
// Unterbrechung sichtbar (die Messpunkte selbst werden ohnehin als Punkte
// gezeichnet).
const LINE_GAP_MS = 60 * 60 * 1000;

interface Point {
  t: number; // Zeitstempel (ms)
  speed: number | null;
  gust: number | null;
  direction: number | null;
}

function formatHourLabel(date: Date): string {
  // Um Mitternacht das Datum statt "00:00" zeigen, damit der Tageswechsel
  // in der Zeitachse erkennbar ist.
  if (date.getHours() === 0) {
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  }
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

function formatTime(t: number): string {
  return new Date(t).toLocaleString("de-DE", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "unbekannt";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

// Baut den SVG-Pfad einer Kurve. Bei fehlenden Werten oder größeren
// Messlücken wird der Pfad unterbrochen (neues "M"-Segment).
function buildLinePath(
  points: Point[],
  getValue: (p: Point) => number | null,
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  let prevT: number | null = null;
  for (const p of points) {
    const v = getValue(p);
    if (v === null) {
      prevT = null;
      continue;
    }
    const cmd = prevT !== null && p.t - prevT <= LINE_GAP_MS ? "L" : "M";
    d += `${cmd}${x(p.t).toFixed(1)} ${y(v).toFixed(1)} `;
    prevT = p.t;
  }
  return d.trim();
}

// Baut den SVG-Pfad der Fläche zwischen zwei Kurven (oben = Böen,
// unten = Mittelwind). Für jeden zusammenhängenden Abschnitt (beide Werte
// vorhanden, benachbarte Punkte ≤ LINE_GAP_MS auseinander) entsteht ein
// geschlossenes Polygon: erst oben (Böen) von links nach rechts, dann unten
// (Mittelwind) von rechts nach links zurück. Bei Lücken/fehlenden Werten
// bleibt die Fläche — wie die Linien — unterbrochen.
function buildAreaPath(
  points: Point[],
  getUpper: (p: Point) => number | null,
  getLower: (p: Point) => number | null,
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  let run: Point[] = [];
  const flush = () => {
    if (run.length >= 2) {
      let top = "";
      for (const p of run) {
        const cmd = top === "" ? "M" : "L";
        top += `${cmd}${x(p.t).toFixed(1)} ${y(getUpper(p)!).toFixed(1)} `;
      }
      let bottom = "";
      for (let i = run.length - 1; i >= 0; i--) {
        const p = run[i];
        bottom += `L${x(p.t).toFixed(1)} ${y(getLower(p)!).toFixed(1)} `;
      }
      d += `${top}${bottom}Z `;
    }
    run = [];
  };
  let prevT: number | null = null;
  for (const p of points) {
    if (getUpper(p) === null || getLower(p) === null) {
      flush();
      prevT = null;
      continue;
    }
    if (prevT !== null && p.t - prevT > LINE_GAP_MS) flush();
    run.push(p);
    prevT = p.t;
  }
  flush();
  return d.trim();
}

export default function WindHistoryPanel({
  station,
  onClose,
}: {
  station: WindStation;
  onClose: () => void;
}) {
  // Ergebnis des letzten Ladevorgangs, inklusive Stationscode. Solange der
  // Code nicht zur aktuell gewählten Station passt, gilt das Panel als
  // "lädt" — so braucht es beim Stationswechsel kein separates Zurücksetzen.
  const [result, setResult] = useState<{
    code: string;
    entries?: HistoryEntry[];
    // Prognosen je Modell — optional/additiv: schlagen sie fehl oder sind sie
    // leer, bleibt dieses Feld leer, ohne die Messwert-Anzeige zu blockieren.
    models?: ForecastsByModel;
    // Höhenwind (nur für Windanzeiger-Stationen vorhanden), ebenfalls additiv.
    upper?: UpperForecast | null;
    error?: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  // Bezugszeitpunkt "jetzt" für die feste Zeitachse. Wird beim Laden gesetzt,
  // damit der Render selbst rein bleibt (kein Date.now() während des Renderns).
  const [now, setNow] = useState(() => Date.now());
  // Über die Legende ausgeblendete Prognoselinien (Modellschlüssel). Leer =
  // alles sichtbar, das ist bewusst der Startzustand. Vier Prognosen auf
  // einmal machen das Diagramm sonst schnell unübersichtlich.
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const toggleModel = (key: string) =>
    setHiddenModels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const loading = result?.code !== station.stationCode;
  const entries = loading ? null : (result?.entries ?? null);
  const forecastsByModel = loading ? null : (result?.models ?? null);
  const upper = loading ? null : (result?.upper ?? null);
  const error = loading ? null : (result?.error ?? null);

  // Historie der angeklickten Station laden.
  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      const code = station.stationCode;
      try {
        // Messwerte und Prognose parallel laden. Die Prognose ist additiv:
        // scheitert sie (Netzfehler, 502, oder Station ohne Prognose), zeigen
        // wir einfach keine Prognose-Kurven, ohne die Messwerte zu blockieren.
        const [res, forecastJson] = await Promise.all([
          fetch(`/api/history?station=${encodeURIComponent(code)}`),
          fetch(`/api/forecast?station=${encodeURIComponent(code)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        const forecastModels =
          (forecastJson?.models as ForecastsByModel | undefined) ?? {};
        const upperForecast =
          (forecastJson?.upper as UpperForecast | undefined) ?? null;
        const data = await res.json();
        if (cancelled) return;
        setNow(Date.now());
        if (!res.ok) {
          setResult({
            code,
            error: data.error ?? "Verlauf konnte nicht geladen werden",
          });
        } else {
          setResult({
            code,
            entries: data.entries as HistoryEntry[],
            models: forecastModels,
            upper: upperForecast,
          });
        }
      } catch {
        if (!cancelled) {
          setResult({ code, error: "Verlauf konnte nicht geladen werden" });
        }
      }
    }

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [station.stationCode]);

  // Escape schließt das Panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Breite des Scrollbereichs beobachten, damit das SVG auf großen
  // Bildschirmen die volle Breite füllt.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Nach dem Laden ans rechte Ende scrollen (neueste Werte zuerst sichtbar).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && entries && entries.length > 0) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [entries]);

  const points: Point[] = (entries ?? [])
    .map((e) => ({
      t: Date.parse(e.measured_at),
      speed: e.speed_kmh,
      gust: e.gust_kmh,
      direction: e.direction,
    }))
    .filter((p) => !Number.isNaN(p.t));

  // Prognose-Punkte genau wie die Messpunkte aufbereiten (nur andere Quelle).
  const toForecastPoints = (list: ForecastEntry[] | undefined): Point[] =>
    (list ?? [])
      .map((e) => ({
        t: Date.parse(e.forecast_time),
        speed: e.speed_kmh,
        gust: e.gust_kmh,
        direction: e.direction,
      }))
      .filter((p) => !Number.isNaN(p.t));

  // Eine Zeichenebene je Prognosemodell — Reihenfolge, Name und Farbe kommen
  // aus FORECAST_MODELS (src/lib/wind.ts). "hasData" unterscheidet dabei
  // "Modell deckt diese Station nicht ab" (Legendeneintrag grau/deaktiviert)
  // von "vom Nutzer ausgeblendet" (anklickbar).
  const forecastLayers = FORECAST_MODELS.map((model) => {
    const layerPoints = toForecastPoints(forecastsByModel?.[model.key]);
    return {
      ...model,
      points: layerPoints,
      byT: new Map(layerPoints.map((p) => [p.t, p])),
      hasData: layerPoints.some((p) => p.speed !== null || p.gust !== null),
      visible: !hiddenModels.has(model.key),
    };
  });
  // Nur diese Ebenen werden tatsächlich gezeichnet (vorhanden UND eingeblendet).
  const shownLayers = forecastLayers.filter((l) => l.hasData && l.visible);

  // Höhenwind-Punkte (nur Windanzeiger-Stationen). Nur Mittelwind + Richtung,
  // keine Böen (die gibt es auf Druckflächen nicht).
  const upperPoints: Point[] = (upper?.entries ?? [])
    .map((e) => ({
      t: Date.parse(e.forecast_time),
      speed: e.speed_kmh,
      gust: null,
      direction: e.direction,
    }))
    .filter((p) => !Number.isNaN(p.t));

  // Auch eine Station mit Prognose, aber (noch) ohne Messwerte soll angezeigt
  // werden — nicht fälschlich "Keine Daten verfügbar". Bewusst unabhängig
  // davon, was gerade eingeblendet ist: wer alle Modelle ausblendet, soll
  // nicht plötzlich "Keine Daten" lesen.
  const hasData =
    points.some((p) => p.speed !== null || p.gust !== null) ||
    forecastLayers.some((l) => l.hasData) ||
    upperPoints.some((p) => p.speed !== null);

  // --- Skalen ---
  // Feste Zeitachse von (jetzt − 12h) bis (jetzt + 4h), unabhängig davon,
  // welche Messpunkte tatsächlich vorliegen. So sitzen die Werte immer an der
  // richtigen Stelle der Achse, fehlende Zeiträume bleiben als Lücke sichtbar
  // (statt die wenigen Punkte über die ganze Breite zu strecken), und die
  // aktuelle Uhrzeit steht dank der Prognose-Reserve stets nahe dem rechten Rand.
  const minT = now - HISTORY_HOURS * 3_600_000;
  const maxT = now + FUTURE_MARGIN_HOURS * 3_600_000;

  // Nominale Breite der beiden Achsen-Abschnitte (Geschichte / Prognose-Reserve).
  // Die Reserve ist bewusst nur halb so breit pro Stunde wie die Geschichte.
  const historyWidth0 = HISTORY_HOURS * HISTORY_PX_PER_HOUR;
  const futureWidth0 = FUTURE_MARGIN_HOURS * FUTURE_PX_PER_HOUR;
  const contentWidth0 = historyWidth0 + futureWidth0;

  const svgWidth = Math.max(
    containerW,
    Math.ceil(contentWidth0) + 2 * PAD_X,
  );
  const innerW = svgWidth - 2 * PAD_X;
  // Auf breiten Bildschirmen füllt das Diagramm die volle Breite; beide
  // Abschnitte werden dabei im gleichen Verhältnis gestreckt.
  const stretch = innerW / contentWidth0;
  const historyWidth = historyWidth0 * stretch;
  const futureWidth = futureWidth0 * stretch;

  // Höhenwind: eigene Sichtbarkeit (eigener Legendeneintrag), eigene Zeile
  // unter dem Vergleichsblock. Wird nur bei Windanzeiger-Stationen geliefert.
  const hasUpperData = upperPoints.some((p) => p.speed !== null);
  const upperVisible = !hiddenModels.has(UPPER_FORECAST_MODEL.key);
  const hasUpper = hasUpperData && upperVisible;

  // yMax muss alle SICHTBAREN Kurven einschließen, sonst würde eine davon oben
  // abgeschnitten (der Höhenwind ist oft deutlich stärker). Umgekehrt heißt
  // das: Blendet man ein starkes Modell aus, wird die Achse automatisch
  // feiner — die übrigen Kurven sind dann besser ablesbar.
  const maxValue = [
    ...points,
    ...shownLayers.flatMap((l) => l.points),
    ...(hasUpper ? upperPoints : []),
  ].reduce((m, p) => Math.max(m, p.speed ?? 0, p.gust ?? 0), 0);
  // Obergrenze der y-Achse auf volle 10er runden, mindestens 20 km/h.
  const yMax = Math.max(20, Math.ceil(maxValue / 10) * 10);
  const yTickStep = yMax > 50 ? 20 : 10;

  const x = (t: number) =>
    t <= now
      ? PAD_X + ((t - minT) / (now - minT)) * historyWidth
      : PAD_X + historyWidth + ((t - now) / (maxT - now)) * futureWidth;
  const chartTop = TIME_LABEL_H;
  const chartBottom = TIME_LABEL_H + CHART_H;
  const y = (v: number) => chartBottom - (v / yMax) * CHART_H;
  const arrowCy = chartBottom + ARROW_GAP + ARROW_ROW_H / 2;
  const arrowRowBottom = chartBottom + ARROW_GAP + ARROW_ROW_H;
  const speedValueY = arrowRowBottom + VALUES_GAP + VALUE_LINE_H - 2;
  const gustValueY = speedValueY + VALUE_LINE_H;

  // Prognose-Vergleichsblock, direkt unter dem Messwert-Block: eine gemeinsame
  // Pfeilreihe + zwei Zahlenzeilen (Mittelwind, Böe) — dieselbe Darstellung
  // wie beim Messwert-Block, nur stehen hier je Stunde die sichtbaren Modelle
  // nebeneinander, jedes in seiner Farbe.
  const d2ArrowCy = gustValueY + D2_ROW_GAP + ARROW_ROW_H / 2;
  const d2ArrowRowBottom = gustValueY + D2_ROW_GAP + ARROW_ROW_H;
  const d2SpeedValueY = d2ArrowRowBottom + VALUES_GAP + VALUE_LINE_H - 2;
  const d2GustValueY = d2SpeedValueY + VALUE_LINE_H;
  // Spaltenbreite je Modell im Vergleichsblock. Die sichtbaren Modelle werden
  // symmetrisch um den Stundenpunkt verteilt (bei zwei Modellen also links und
  // rechts wie bisher, bei vieren entsprechend breiter).
  const FORECAST_COL_W = 22;
  const forecastColOffset = (i: number) =>
    (i - (shownLayers.length - 1) / 2) * FORECAST_COL_W;

  // Höhenwind (nur Windanzeiger-Stationen): eine fette Zahl direkt UNTER den
  // Prognose-Zahlen, darunter der Richtungspfeil (nur Kontur).
  const upperValueY = d2GustValueY + VALUE_LINE_H;
  const upperArrowCy = upperValueY + VALUES_GAP + ARROW_ROW_H / 2;
  // Das SVG wird nur dann höher, wenn es tatsächlich Höhenwind-Werte gibt.
  const svgH = SVG_H_BASE + (hasUpper ? UPPER_BLOCK_H : 0);

  // --- Farbbänder aus der Windskala (bis yMax gekappt) ---
  const bands: { from: number; to: number; color: string; opacity: number }[] = [];
  let bandFrom = 0;
  for (const stop of WIND_COLOR_SCALE) {
    if (bandFrom >= yMax) break;
    bands.push({
      from: bandFrom,
      to: Math.min(stop.max, yMax),
      color: stop.color,
      // Standard-Deckkraft 0.55; die schwarze Stufe "zu stark" bekommt über
      // bandOpacity einen kleineren Wert, sonst verschwindet die schwarze
      // Messkurve auf dem schwarzen Band.
      opacity: stop.bandOpacity ?? 0.55,
    });
    bandFrom = stop.max;
  }

  // --- Stunden-Raster ---
  const hourTicks: Date[] = [];
  {
    const first = new Date(minT);
    first.setMinutes(0, 0, 0);
    if (first.getTime() < minT) first.setHours(first.getHours() + 1);
    for (let d = first; d.getTime() <= maxT; d = new Date(d.getTime() + 3_600_000)) {
      hourTicks.push(d);
    }
  }
  // Kleinster Wert der beiden Abschnitte, damit auch die enger gepackte
  // Prognose-Reserve keine überlappenden Beschriftungen bekommt.
  const pxPerHour = Math.min(HISTORY_PX_PER_HOUR, FUTURE_PX_PER_HOUR) * stretch;
  // Uhrzeiten nur so dicht beschriften, dass sie sich nicht überlappen.
  const labelEveryHours = pxPerHour >= 44 ? 1 : pxPerHour >= 22 ? 2 : 4;

  // --- "Stündliche" Messpunkte bestimmen ---
  // Die ICON-CH1-Prognose (oben, rot) liefert stündliche Werte. Damit man sie
  // gut mit den Messwerten vergleichen kann, heben wir unten die "stündlichen"
  // Messwerte hervor: je voller Stunde den zeitlich nächstgelegenen Messpunkt
  // (höchstens 30 min von der vollen Stunde entfernt). Diese Punkte werden
  // immer angezeigt und ihre Werte fett dargestellt.
  const hourlyPointIndices = new Set<number>();
  {
    const bestByHour = new Map<number, { idx: number; dist: number }>();
    points.forEach((p, idx) => {
      if (p.speed === null && p.gust === null) return;
      const hourStart = new Date(p.t);
      hourStart.setMinutes(0, 0, 0);
      const lower = hourStart.getTime();
      const upper = lower + 3_600_000;
      // Auf die näher gelegene volle Stunde runden.
      const hourKey = p.t - lower <= upper - p.t ? lower : upper;
      const dist = Math.abs(p.t - hourKey);
      const cur = bestByHour.get(hourKey);
      if (!cur || dist < cur.dist) bestByHour.set(hourKey, { idx, dist });
    });
    for (const { idx, dist } of bestByHour.values()) {
      if (dist <= 30 * 60 * 1000) hourlyPointIndices.add(idx);
    }
  }

  // --- Pfeile + Werte ggf. ausdünnen, damit sie sich nicht überlappen ---
  // Die Achse ist fest so breit, dass 6 Messungen/Stunde (alle 10 min) passen.
  // Bei genau dieser Dichte wird nichts ausgedünnt; nur wenn eine Station noch
  // dichter misst, dünnt der Mindestabstand (MIN_LABEL_SPACING) auf ~10 min aus.
  // Auswahl: zuerst die stündlichen Punkte (Pflicht, damit der Vergleich mit
  // der Prognose immer sichtbar ist), danach weitere Punkte als Lückenfüller —
  // aber nur, solange sie den Mindestabstand zu allen bereits gewählten Punkten
  // einhalten. Die stündlichen Punkte liegen mindestens eine Stunde (also klar
  // mehr als MIN_LABEL_SPACING) auseinander und passen daher immer alle rein.
  const arrowIndices: number[] = [];
  const selectedX: number[] = [];
  const tryAdd = (i: number) => {
    const px = x(points[i].t);
    if (selectedX.some((sx) => Math.abs(px - sx) < MIN_LABEL_SPACING)) return;
    selectedX.push(px);
    arrowIndices.push(i);
  };
  for (let i = points.length - 1; i >= 0; i--) {
    if (hourlyPointIndices.has(i)) tryAdd(i);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    if (!hourlyPointIndices.has(i)) tryAdd(i);
  }

  // Gemeinsame Ausdünnung für den Prognose-Vergleichsblock: Vereinigung aller
  // Zeitpunkte der sichtbaren Modelle (ein Modell kann für einzelne Stunden
  // fehlen, etwa am Rand seines Vorhersagehorizonts), damit an jeder gezeigten
  // Stunde zumindest ein Wert erscheint. Der Platzbedarf wächst mit der Zahl
  // der sichtbaren Modelle — blendet man Modelle aus, rücken die Stunden
  // automatisch wieder enger zusammen.
  const combinedForecastTimes = Array.from(
    new Set(shownLayers.flatMap((l) => l.points.map((p) => p.t))),
  ).sort((a, b) => a - b);
  const combinedPxPerPoint =
    combinedForecastTimes.length > 1
      ? (x(combinedForecastTimes[combinedForecastTimes.length - 1]) -
          x(combinedForecastTimes[0])) /
        (combinedForecastTimes.length - 1)
      : historyWidth;
  const combinedForecastStep = Math.max(
    1,
    Math.ceil(
      Math.max(
        ARROW_SIZE + Math.max(0, shownLayers.length - 1) * FORECAST_COL_W,
        MIN_LABEL_SPACING,
      ) / combinedPxPerPoint,
    ),
  );
  const combinedForecastTimeSelection: number[] = [];
  for (let i = combinedForecastTimes.length - 1; i >= 0; i -= combinedForecastStep) {
    combinedForecastTimeSelection.push(combinedForecastTimes[i]);
  }

  // Gleiche Ausdünnung für die Höhenwind-Zahlen/-Pfeile unter dem ICON-D2-Block.
  const upperPxPerPoint =
    upperPoints.length > 1
      ? (x(upperPoints[upperPoints.length - 1].t) - x(upperPoints[0].t)) /
        (upperPoints.length - 1)
      : historyWidth;
  const upperArrowStep = Math.max(
    1,
    Math.ceil(Math.max(ARROW_SIZE + 2, MIN_LABEL_SPACING) / upperPxPerPoint),
  );
  const upperArrowIndices: number[] = [];
  for (let i = upperPoints.length - 1; i >= 0; i -= upperArrowStep) {
    upperArrowIndices.push(i);
  }

  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += yTickStep) yTicks.push(v);

  const speedPath = buildLinePath(points, (p) => p.speed, x, y);
  const gustPath = buildLinePath(points, (p) => p.gust, x, y);
  const areaPath = buildAreaPath(points, (p) => p.gust, (p) => p.speed, x, y);
  // Je sichtbarem Modell dieselben drei Pfade wie bei den Messwerten:
  // Böen-Linie, Mittelwind-Linie und die Fläche dazwischen.
  const forecastPaths = shownLayers.map((layer) => ({
    key: layer.key,
    color: layer.color,
    speedPath: buildLinePath(layer.points, (p) => p.speed, x, y),
    gustPath: buildLinePath(layer.points, (p) => p.gust, x, y),
    areaPath: buildAreaPath(layer.points, (p) => p.gust, (p) => p.speed, x, y),
    points: layer.points,
  }));
  // Höhenwind: nur eine (Mittelwind-)Linie, gestrichelt.
  const upperSpeedPath = buildLinePath(upperPoints, (p) => p.speed, x, y);

  // Deckkraft der Fläche zwischen Mittelwind und Böe. Bei bis zu zwei
  // sichtbaren Prognosen bleibt es bei den gewohnten 30%; ab drei würden sich
  // die Flächen zu einem undurchsichtigen Brei überlagern, deshalb dann nur
  // noch halb so kräftig. Die Linien selbst bleiben unverändert.
  const forecastAreaOpacity = shownLayers.length <= 2 ? 0.3 : 0.15;

  // Beide Linien (Böen oben, Mittelwind unten) gleich dick.
  const LINE_WIDTH = 1.8;

  return (
    <section
      aria-label={`Windverlauf ${station.stationName}`}
      className="fixed inset-x-0 bottom-0 z-[1100] border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(0,0,0,0.2)] dark:border-zinc-700 dark:bg-zinc-900"
    >
      <header className="flex items-center gap-3 px-3 pt-2 pb-1">
        <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {station.stationName}
          {station.altitude !== null && (
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              {" "}
              ({station.altitude} m)
            </span>
          )}
          <span className="font-normal text-zinc-500 dark:text-zinc-400">
            {" "}
            · Stand: {formatTimestamp(station.timestamp)}
          </span>
        </h2>
        <span className="hidden shrink-0 text-xs text-zinc-500 sm:inline dark:text-zinc-400">
          letzte 12 Stunden
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Verlauf schließen"
          className="ml-auto shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 3 L13 13 M13 3 L3 13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {/* Legende: Messung (fest) + ein Eintrag je Prognosemodell. Ein Klick auf
          einen Modell-Eintrag blendet dessen Linien, Pfeile und Zahlen aus bzw.
          wieder ein — bei vier Prognosen sonst schnell unübersichtlich. Modelle
          ohne Daten für diese Station stehen ausgegraut da (nicht anklickbar):
          so sieht man sofort, dass z. B. AROME diese Station nicht abdeckt. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 pb-1 text-[11px]">
        <span className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-200">
          <span className="inline-block h-[3px] w-4 rounded-full bg-zinc-900 dark:bg-zinc-100" />
          Messung
        </span>
        {forecastLayers.map((layer) => (
          <button
            key={layer.key}
            type="button"
            disabled={!layer.hasData}
            aria-pressed={layer.hasData && layer.visible}
            onClick={() => toggleModel(layer.key)}
            title={
              layer.hasData
                ? `${layer.label} (${layer.provider}) ein-/ausblenden`
                : `Für diese Station liegt keine ${layer.label}-Prognose vor`
            }
            className={`flex items-center gap-1.5 rounded px-1 py-0.5 ${
              layer.hasData
                ? "cursor-pointer text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                : "cursor-not-allowed text-zinc-400 line-through dark:text-zinc-600"
            } ${layer.hasData && !layer.visible ? "opacity-40 line-through" : ""}`}
          >
            <span
              className="inline-block h-[3px] w-4 rounded-full"
              style={{
                backgroundColor: layer.hasData ? layer.color : "currentColor",
              }}
            />
            {layer.label}
          </button>
        ))}
        {hasUpperData && (
          <button
            type="button"
            aria-pressed={upperVisible}
            onClick={() => toggleModel(UPPER_FORECAST_MODEL.key)}
            title="Höhenwind ein-/ausblenden"
            className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 ${
              upperVisible ? "" : "opacity-40 line-through"
            }`}
          >
            <svg width="16" height="3" aria-hidden="true">
              <line
                x1="0"
                y1="1.5"
                x2="16"
                y2="1.5"
                stroke={UPPER_FORECAST_MODEL.color}
                strokeWidth="3"
                strokeDasharray="5 3"
              />
            </svg>
            {UPPER_FORECAST_MODEL.label}
            {upper?.pressure_level !== null && upper?.pressure_level !== undefined && (
              <span className="text-zinc-400 dark:text-zinc-500">
                {upper.pressure_level} hPa
                {upper.height_m !== null && ` ≈ ${upper.height_m} m`}
              </span>
            )}
          </button>
        )}
      </div>

      <div className="flex px-1 pb-4">
        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-x-auto"
          style={{ height: svgH }}
        >
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Verlauf wird geladen…
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : !hasData ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Keine Daten verfügbar
            </div>
          ) : (
            <svg
              width={svgWidth}
              height={svgH}
              viewBox={`0 0 ${svgWidth} ${svgH}`}
              role="img"
              aria-label="Windverlauf: Mittelwind und Böen der letzten 12 Stunden"
            >
              {/* Farbbänder der Windstärke-Bereiche (gleiche Skala wie die
                  Kartenpfeile), leicht transparent, damit die Kurven gut
                  lesbar bleiben */}
              {bands.map((band) => (
                <rect
                  key={band.from}
                  x={PAD_X}
                  y={y(band.to)}
                  width={innerW}
                  height={y(band.from) - y(band.to)}
                  fill={band.color}
                  fillOpacity={band.opacity}
                />
              ))}

              {/* Stunden-Raster + Uhrzeiten */}
              {hourTicks.map((d) => {
                const tx = x(d.getTime());
                const isMidnight = d.getHours() === 0;
                const showLabel = d.getHours() % labelEveryHours === 0;
                return (
                  <g key={d.getTime()}>
                    <line
                      x1={tx}
                      y1={chartTop}
                      x2={tx}
                      y2={chartBottom}
                      className={
                        isMidnight
                          ? "stroke-zinc-500/70 dark:stroke-zinc-400/70"
                          : "stroke-zinc-400/40 dark:stroke-zinc-500/40"
                      }
                      strokeWidth={isMidnight ? 1.5 : 1}
                    />
                    {showLabel && (
                      <text
                        x={tx}
                        y={TIME_LABEL_H - 6}
                        textAnchor="middle"
                        className="fill-zinc-500 text-[11px] tabular-nums dark:fill-zinc-400"
                      >
                        {formatHourLabel(d)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* "Jetzt"-Markierung: senkrechte Linie an der aktuellen Uhrzeit,
                  rechts davon die 4h-Prognose-Reserve */}
              <line
                x1={x(now)}
                y1={chartTop}
                x2={x(now)}
                y2={chartBottom}
                className="stroke-zinc-900/70 dark:stroke-zinc-100/70"
                strokeWidth={1.6}
                strokeDasharray="3 3"
              />
              <text
                x={x(now)}
                y={chartTop + 11}
                textAnchor="middle"
                className="fill-zinc-700 text-[10px] font-semibold dark:fill-zinc-200"
              >
                jetzt
              </text>

              {/* Prognosen, VOR den schwarzen Messwert-Kurven gezeichnet: im
                  Überlappungsbereich liegt so die echte Messung optisch oben;
                  rechts der "jetzt"-Linie stehen die Prognosen ohnehin allein.
                  Je Modell dieselbe Darstellung: Böen- und Mittelwind-Linie
                  gleich dick, die Fläche dazwischen in derselben Farbe mit 30%
                  Deckkraft, dazu ein Punkt je Prognosestunde. Welche Modelle
                  hier auftauchen, steuert die Legende. Endet ein Modell früher
                  (kürzerer Vorhersagehorizont), endet einfach seine Linie. */}
              {forecastPaths.map((layer) => (
                <g key={`fc-${layer.key}`}>
                  <path
                    d={layer.areaPath}
                    stroke="none"
                    fill={layer.color}
                    fillOpacity={forecastAreaOpacity}
                  />
                  <path
                    d={layer.gustPath}
                    fill="none"
                    stroke={layer.color}
                    strokeWidth={LINE_WIDTH}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <path
                    d={layer.speedPath}
                    fill="none"
                    stroke={layer.color}
                    strokeWidth={LINE_WIDTH}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {layer.points.map((p) => (
                    <g key={`fdot-${layer.key}-${p.t}`}>
                      {p.gust !== null && (
                        <circle cx={x(p.t)} cy={y(p.gust)} r={2} fill={layer.color} />
                      )}
                      {p.speed !== null && (
                        <circle cx={x(p.t)} cy={y(p.speed)} r={1.7} fill={layer.color} />
                      )}
                    </g>
                  ))}
                </g>
              ))}

              {/* Höhenwind (nur Windanzeiger-Stationen): eine gestrichelte
                  Mittelwind-Linie plus Punkte. Keine Böen/Fläche, da es auf
                  Druckflächen keine Böen gibt. Welche Druckfläche und Höhe
                  gemeint ist, steht im Legendeneintrag über dem Diagramm. */}
              {hasUpper && (
                <g>
                  <path
                    d={upperSpeedPath}
                    fill="none"
                    stroke={UPPER_FORECAST_MODEL.color}
                    strokeWidth={LINE_WIDTH}
                    strokeDasharray="5 3"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {upperPoints.map((p) =>
                    p.speed !== null ? (
                      <circle
                        key={`udot-${p.t}`}
                        cx={x(p.t)}
                        cy={y(p.speed)}
                        r={1.8}
                        fill={UPPER_FORECAST_MODEL.color}
                      >
                        <title>
                          {`Höhenwind ${formatTime(p.t)} Uhr — ${Math.round(p.speed)} km/h${
                            p.direction !== null
                              ? `, Richtung ${Math.round(p.direction)}°`
                              : ""
                          }`}
                        </title>
                      </circle>
                    ) : null,
                  )}
                </g>
              )}

              {/* Messkurven: beide Linien gleich dick (Böen oben, Mittelwind
                  unten), die Fläche dazwischen in derselben Farbe mit 30%
                  Deckkraft. */}
              <path
                d={areaPath}
                stroke="none"
                fillOpacity={0.3}
                className="fill-zinc-900 dark:fill-zinc-100"
              />
              <path
                d={gustPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-zinc-900 dark:stroke-zinc-100"
              />
              <path
                d={speedPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-zinc-900 dark:stroke-zinc-100"
              />

              {/* Messpunkte als kleine Punkte — dadurch bleiben auch einzelne
                  Werte sichtbar, wenn wegen einer größeren Messlücke keine
                  Linie zum Nachbarpunkt gezogen wird */}
              {points.map((p) => (
                <g key={`dot-${p.t}`}>
                  {p.gust !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.gust)}
                      r={2}
                      className="fill-zinc-900 dark:fill-zinc-100"
                    />
                  )}
                  {p.speed !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.speed)}
                      r={1.7}
                      className="fill-zinc-900 dark:fill-zinc-100"
                    />
                  )}
                </g>
              ))}

              {/* Windrichtungs-Pfeile: gleiche Form, Drehung (auf 8
                  Himmelsrichtungen eingerastete Richtung + 180°, Pfeil zeigt
                  wohin der Wind weht) und Farben wie auf der Karte (Füllung =
                  Mittelwind, Rand = Böe) */}
              {arrowIndices.map((i) => {
                const p = points[i];
                if (p.direction === null) return null;
                const rotation = (snapDirectionTo8(p.direction) + 180) % 360;
                return (
                  <g
                    key={p.t}
                    transform={`translate(${x(p.t).toFixed(1)} ${arrowCy}) rotate(${rotation.toFixed(0)}) scale(${(ARROW_SIZE / 40).toFixed(3)})`}
                  >
                    <title>
                      {`${formatTime(p.t)} Uhr — Wind ${p.speed ?? "–"} km/h, Böen ${p.gust ?? "–"} km/h, Richtung ${Math.round(p.direction)}°`}
                    </title>
                    <path
                      d="M20 2 L34 34 L20 26 L6 34 Z"
                      transform="translate(-20 -20)"
                      fill={getWindColor(p.speed)}
                      stroke={getWindColor(p.gust)}
                      strokeWidth={3}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </g>
                );
              })}

              {/* Werte-Text unter jedem Pfeil: oben Mittelwind, darunter Böe
                  (gleiche Auswahl an Punkten wie die Pfeile, damit nichts
                  überlappt) */}
              {arrowIndices.map((i) => {
                const p = points[i];
                if (p.direction === null) return null;
                const tx = x(p.t).toFixed(1);
                // Stündliche Messwerte fett und kräftiger, damit sie sich zum
                // Vergleich mit der (ebenfalls stündlichen) roten Prognose von
                // den Zwischenwerten abheben.
                const isHourly = hourlyPointIndices.has(i);
                const emphasisClass = isHourly
                  ? "font-bold fill-zinc-900 dark:fill-zinc-100"
                  : "fill-zinc-500 dark:fill-zinc-400";
                return (
                  <g key={`values-${p.t}`}>
                    <text
                      x={tx}
                      y={speedValueY}
                      textAnchor="middle"
                      className={`text-[10px] tabular-nums ${emphasisClass}`}
                    >
                      {p.speed !== null ? Math.round(p.speed) : "–"}
                    </text>
                    <text
                      x={tx}
                      y={gustValueY}
                      textAnchor="middle"
                      className={`text-[10px] tabular-nums ${emphasisClass}`}
                    >
                      {p.gust !== null ? Math.round(p.gust) : "–"}
                    </text>
                  </g>
                );
              })}

              {/* Prognose-Vergleichsblock UNTER dem Messwert-Block: für jede
                  gezeigte Stunde stehen die sichtbaren Modelle nebeneinander
                  (Reihenfolge wie in der Legende), jedes mit Windpfeil
                  (Mittelwind) und darunter Mittelwind- und Böen-Zahl in seiner
                  Farbe. Fehlt ein Modell für eine Stunde, bleibt seine Spalte
                  dort einfach leer — die übrigen bleiben an ihrem Platz. */}
              {combinedForecastTimeSelection.map((t) => (
                <g key={`fcarrow-${t}`}>
                  {shownLayers.map((layer, i) => {
                    const p = layer.byT.get(t);
                    if (!p || p.direction === null) return null;
                    const cx = x(t) + forecastColOffset(i);
                    const rotation = (snapDirectionTo8(p.direction) + 180) % 360;
                    return (
                      <g
                        key={layer.key}
                        transform={`translate(${cx.toFixed(1)} ${d2ArrowCy}) rotate(${rotation.toFixed(0)}) scale(${(ARROW_SIZE / 40).toFixed(3)})`}
                      >
                        <title>
                          {`Prognose ${layer.label} ${formatTime(t)} Uhr — Wind ${p.speed ?? "–"} km/h, Böen ${p.gust ?? "–"} km/h, Richtung ${Math.round(p.direction)}°`}
                        </title>
                        <path
                          d="M20 2 L34 34 L20 26 L6 34 Z"
                          transform="translate(-20 -20)"
                          fill={layer.color}
                        />
                      </g>
                    );
                  })}
                </g>
              ))}
              {combinedForecastTimeSelection.map((t) => (
                <g key={`fcvalues-${t}`}>
                  {shownLayers.map((layer, i) => {
                    const p = layer.byT.get(t);
                    if (!p) return null;
                    const cx = (x(t) + forecastColOffset(i)).toFixed(1);
                    return (
                      <g key={layer.key} fill={layer.color}>
                        <text
                          x={cx}
                          y={d2SpeedValueY}
                          textAnchor="middle"
                          className="text-[10px] tabular-nums"
                        >
                          {p.speed !== null ? Math.round(p.speed) : "–"}
                        </text>
                        <text
                          x={cx}
                          y={d2GustValueY}
                          textAnchor="middle"
                          className="text-[10px] tabular-nums"
                        >
                          {p.gust !== null ? Math.round(p.gust) : "–"}
                        </text>
                      </g>
                    );
                  })}
                </g>
              ))}

              {/* Höhenwind (nur Windanzeiger-Stationen): fette Zahl direkt
                  unter den Prognose-Zahlen, darunter der Richtungspfeil nur als
                  Kontur (ohne Füllung). Mittig unter der jeweiligen Stunde,
                  weil im Block darüber inzwischen bis zu vier Modelle
                  nebeneinander stehen. */}
              {hasUpper &&
                upperArrowIndices.map((i) => {
                  const p = upperPoints[i];
                  if (p.speed === null) return null;
                  return (
                    <text
                      key={`uvalue-${p.t}`}
                      x={x(p.t).toFixed(1)}
                      y={upperValueY}
                      textAnchor="middle"
                      fill={UPPER_FORECAST_MODEL.color}
                      className="text-[10px] font-bold tabular-nums"
                    >
                      {Math.round(p.speed)}
                    </text>
                  );
                })}
              {hasUpper &&
                upperArrowIndices.map((i) => {
                  const p = upperPoints[i];
                  if (p.direction === null) return null;
                  const rotation = (snapDirectionTo8(p.direction) + 180) % 360;
                  return (
                    <g
                      key={`uarrow-${p.t}`}
                      transform={`translate(${x(p.t).toFixed(1)} ${upperArrowCy}) rotate(${rotation.toFixed(0)}) scale(${(ARROW_SIZE / 40).toFixed(3)})`}
                    >
                      <title>
                        {`Höhenwind ${formatTime(p.t)} Uhr — ${p.speed ?? "–"} km/h, Richtung ${Math.round(p.direction)}°`}
                      </title>
                      <path
                        d="M20 2 L34 34 L20 26 L6 34 Z"
                        transform="translate(-20 -20)"
                        fill="none"
                        stroke={UPPER_FORECAST_MODEL.color}
                        strokeWidth={3}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </g>
                  );
                })}
            </svg>
          )}
        </div>

        {/* km/h-Achse rechts, außerhalb des Scrollbereichs, damit sie beim
            Scrollen sichtbar bleibt */}
        {!loading && !error && hasData && (
          <div
            className="relative w-10 shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400"
            style={{ height: svgH }}
          >
            {yTicks.map((v) => (
              <span
                key={v}
                className="absolute left-1.5 -translate-y-1/2 tabular-nums"
                style={{ top: y(v) }}
              >
                {v}
              </span>
            ))}
            <span className="absolute left-1.5" style={{ top: chartBottom + 8 }}>
              km/h
            </span>
          </div>
        )}
      </div>

      <p className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Quelle:{" "}
        <a
          href={SOURCE_INFO[station.source].url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {SOURCE_INFO[station.source].label}
        </a>
      </p>
    </section>
  );
}
