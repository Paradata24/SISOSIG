"use client";

import { useEffect, useRef, useState } from "react";
import {
  getWindColor,
  snapDirectionTo8,
  SOURCE_INFO,
  WIND_COLOR_SCALE,
  type WindStation,
} from "@/lib/wind";
import type { HistoryEntry } from "@/app/api/history/route";
import type { ForecastEntry, UpperForecast } from "@/app/api/forecast/route";

// Verlaufspanel am unteren Bildschirmrand (Vorbild: Meteoparapente).
// Zeigt für die angeklickte Station die letzten 48 Stunden:
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
const BOTTOM_PAD = 10; // zusätzlicher Freiraum unterhalb der Werte-Zeilen
const SVG_H =
  TIME_LABEL_H + CHART_H + ARROW_GAP + ARROW_ROW_H + VALUES_GAP + VALUES_ROW_H + BOTTOM_PAD;
const PAD_X = 11; // linker/rechter Innenabstand des Diagramms

// Mindestabstand (px) zwischen zwei Pfeil-/Werte-Spalten, damit sich die
// (bis zu 3-stelligen) Zahlen nicht überlappen. Bestimmt die feste Achsen-
// Breite und – als Sicherheitsnetz – die Ausdünnung weiter unten.
const MIN_LABEL_SPACING = 31;
// Gewünschte Anzeige-Dichte: zu jeder vollen Stunde eine Messung, dazwischen
// alle 10 Minuten eine — also 6 Werte pro Stunde.
const LABEL_INTERVAL_MIN = 10;
// Breite pro Stunde für den Geschichts-Teil (jetzt − 48h bis jetzt). FEST (nicht
// datenabhängig) so gewählt, dass die 6 Messungen pro Stunde (alle 10 min) mit
// dem Mindestabstand nebeneinander Platz haben — mit kleinem Puffer, damit genau
// 10 min auseinanderliegende Werte sicher über dem Mindestabstand liegen.
// Dadurch ist die Achse zugleich breiter als der Bildschirm → das Diagramm
// bleibt horizontal scrollbar.
const HISTORY_PX_PER_HOUR = Math.ceil((60 / LABEL_INTERVAL_MIN) * (MIN_LABEL_SPACING + 2));
// Die 3h-Reserve rechts von der "jetzt"-Linie enthält keine echten Messwerte
// mehr und darf daher 50% enger gepackt sein als der Geschichts-Teil.
const FUTURE_PX_PER_HOUR = HISTORY_PX_PER_HOUR / 2;
const ARROW_SIZE = 17; // Kantenlänge eines Richtungspfeils
// Wie weit die Historie zurückreicht bzw. wie viel Platz rechts nach "jetzt"
// bleibt. Die Zeitachse läuft fest von (jetzt − 48h) bis (jetzt + 3h), sodass
// die aktuelle Uhrzeit immer nahe dem rechten Rand steht.
const HISTORY_HOURS = 48;
const FUTURE_MARGIN_HOURS = 3;
// Zwei aufeinanderfolgende Messpunkte werden nur dann zu einer Linie
// verbunden, wenn sie höchstens so weit auseinanderliegen. Die Sammlung
// (/api/collect, per Supabase Cron) kann je nach Taktung mal seltener laufen,
// daher großzügig auf 3 Stunden gesetzt — größere echte Lücken bleiben als
// Unterbrechung sichtbar.
const LINE_GAP_MS = 3 * 60 * 60 * 1000;

interface Point {
  t: number; // Zeitstempel (ms)
  speed: number | null;
  gust: number | null;
  direction: number | null;
}

function formatHourLabel(date: Date): string {
  // Um Mitternacht das Datum statt "00:00" zeigen, damit der Tageswechsel
  // in der 48h-Achse erkennbar ist.
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
    // Prognose ist optional/additiv: schlägt sie fehl oder ist leer, bleibt
    // dieses Feld leer, ohne die Messwert-Anzeige zu blockieren.
    forecast?: ForecastEntry[];
    // Höhenwind (nur für Windanzeiger-Stationen vorhanden), ebenfalls additiv.
    upper?: UpperForecast | null;
    error?: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  // Bezugszeitpunkt "jetzt" für die feste Zeitachse. Wird beim Laden gesetzt,
  // damit der Render selbst rein bleibt (kein Date.now() während des Renderns).
  const [now, setNow] = useState(() => Date.now());

  const loading = result?.code !== station.stationCode;
  const entries = loading ? null : (result?.entries ?? null);
  const forecast = loading ? null : (result?.forecast ?? null);
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
        const forecastEntries =
          (forecastJson?.entries as ForecastEntry[] | undefined) ?? [];
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
            forecast: forecastEntries,
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
  const forecastPoints: Point[] = (forecast ?? [])
    .map((e) => ({
      t: Date.parse(e.forecast_time),
      speed: e.speed_kmh,
      gust: e.gust_kmh,
      direction: e.direction,
    }))
    .filter((p) => !Number.isNaN(p.t));

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
  // werden — nicht fälschlich "Keine Daten verfügbar".
  const hasData =
    points.some((p) => p.speed !== null || p.gust !== null) ||
    forecastPoints.some((p) => p.speed !== null || p.gust !== null) ||
    upperPoints.some((p) => p.speed !== null);

  // --- Skalen ---
  // Feste Zeitachse von (jetzt − 48h) bis (jetzt + 3h), unabhängig davon,
  // welche Messpunkte tatsächlich vorliegen. So sitzen die Werte immer an der
  // richtigen Stelle der Achse, fehlende Zeiträume bleiben als Lücke sichtbar
  // (statt die wenigen Punkte über die ganze Breite zu strecken), und die
  // aktuelle Uhrzeit steht dank der 3h-Reserve stets nahe dem rechten Rand.
  const minT = now - HISTORY_HOURS * 3_600_000;
  const maxT = now + FUTURE_MARGIN_HOURS * 3_600_000;

  // Nominale Breite der beiden Achsen-Abschnitte (Geschichte / 3h-Reserve).
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

  // yMax muss auch die Prognose- und Höhenwind-Werte einschließen, sonst würde
  // eine der Kurven oben abgeschnitten (Höhenwind ist oft deutlich stärker).
  const maxValue = [...points, ...forecastPoints, ...upperPoints].reduce(
    (m, p) => Math.max(m, p.speed ?? 0, p.gust ?? 0),
    0,
  );
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

  // Prognose-Werte (rot) oben im Diagramm, unter der "jetzt"-Beschriftung:
  // erst die zwei Textzeilen (Mittelwind, Böe), darunter der Windpfeil.
  // Bewusst als reine Überlagerung innerhalb des bestehenden Kurvenbereichs,
  // damit sich an der übrigen Geometrie (SVG_H, chartTop/-Bottom, …) nichts
  // verschiebt. Eigene Zeile unterhalb von "jetzt" (chartTop + 11), damit
  // sich beide nicht überlappen, falls ein Prognosepunkt an derselben Stelle
  // wie die "jetzt"-Linie liegt.
  const forecastSpeedValueY = chartTop + 2 * VALUE_LINE_H;
  const forecastGustValueY = forecastSpeedValueY + VALUE_LINE_H;
  const forecastArrowCy = forecastGustValueY + VALUES_GAP + ARROW_ROW_H / 2;

  // --- Farbbänder aus der Windskala (bis yMax gekappt) ---
  const bands: { from: number; to: number; color: string }[] = [];
  let bandFrom = 0;
  for (const stop of WIND_COLOR_SCALE) {
    if (bandFrom >= yMax) break;
    bands.push({ from: bandFrom, to: Math.min(stop.max, yMax), color: stop.color });
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
  // 3h-Reserve keine überlappenden Beschriftungen bekommt.
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

  // Dieselbe Ausdünnung für die roten Prognose-Werte/Pfeile oben im
  // Diagramm, aber auf Basis der (stündlichen) Prognosepunkte statt der
  // Messpunkte — deren Abstand in Pixeln unterscheidet sich sonst je nach
  // Stationsabdeckung von der Messreihe.
  const forecastPxPerPoint =
    forecastPoints.length > 1
      ? (x(forecastPoints[forecastPoints.length - 1].t) - x(forecastPoints[0].t)) /
        (forecastPoints.length - 1)
      : historyWidth;
  const forecastArrowStep = Math.max(
    1,
    Math.ceil(Math.max(ARROW_SIZE + 2, MIN_LABEL_SPACING) / forecastPxPerPoint),
  );
  const forecastArrowIndices: number[] = [];
  for (let i = forecastPoints.length - 1; i >= 0; i -= forecastArrowStep) {
    forecastArrowIndices.push(i);
  }

  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += yTickStep) yTicks.push(v);

  const speedPath = buildLinePath(points, (p) => p.speed, x, y);
  const gustPath = buildLinePath(points, (p) => p.gust, x, y);
  const areaPath = buildAreaPath(points, (p) => p.gust, (p) => p.speed, x, y);
  const forecastSpeedPath = buildLinePath(forecastPoints, (p) => p.speed, x, y);
  const forecastGustPath = buildLinePath(forecastPoints, (p) => p.gust, x, y);
  // Höhenwind: nur eine (Mittelwind-)Linie, gestrichelt.
  const upperSpeedPath = buildLinePath(upperPoints, (p) => p.speed, x, y);
  const forecastAreaPath = buildAreaPath(
    forecastPoints,
    (p) => p.gust,
    (p) => p.speed,
    x,
    y,
  );

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
        <span className="hidden text-xs text-zinc-500 sm:inline dark:text-zinc-400">
          letzte 48 Stunden{" "}
          <span className="text-zinc-400 dark:text-zinc-500">
            — <span className="text-zinc-700 dark:text-zinc-200">schwarz</span>:
            Messung ·{" "}
            <span className="text-red-600 dark:text-red-500">rot</span>: Prognose
            (ICON-CH1)
            {upper && upper.entries.length > 0 && (
              <>
                {" · "}
                <span className="text-blue-600 dark:text-blue-400">
                  blau gestrichelt
                </span>
                : Höhenwind
              </>
            )}
          </span>
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

      {/* Immer sichtbare Beschriftung des Höhenwinds (auch auf dem Handy, wo
          die Legende oben ausgeblendet ist): welche Druckfläche + Höhe. */}
      {upper && upper.entries.length > 0 && upper.pressure_level !== null && (
        <p className="px-3 pb-1 text-[11px] text-blue-600 dark:text-blue-400">
          Höhenwind (blau gestrichelt): {upper.pressure_level} hPa
          {upper.height_m !== null && ` ≈ ${upper.height_m} m`}
        </p>
      )}

      <div className="flex px-1 pb-4">
        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-x-auto"
          style={{ height: SVG_H }}
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
              height={SVG_H}
              viewBox={`0 0 ${svgWidth} ${SVG_H}`}
              role="img"
              aria-label="Windverlauf: Mittelwind und Böen der letzten 48 Stunden"
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
                  fillOpacity={0.55}
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
                  rechts davon die 3h-Reserve */}
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

              {/* Prognose (ICON-CH1) in Rot, VOR den schwarzen Messwert-Kurven
                  gezeichnet: im Überlappungsbereich liegt so die echte Messung
                  optisch oben; rechts der "jetzt"-Linie steht Rot ohnehin
                  allein. Beide Linien gleich dick, die Fläche dazwischen in
                  derselben Farbe mit 30% Deckkraft. */}
              <path
                d={forecastAreaPath}
                stroke="none"
                fillOpacity={0.3}
                className="fill-red-600 dark:fill-red-500"
              />
              <path
                d={forecastGustPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-red-600 dark:stroke-red-500"
              />
              <path
                d={forecastSpeedPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-red-600 dark:stroke-red-500"
              />

              {/* Prognose-Punkte je Zeitpunkt (analog zu den schwarzen
                  Messpunkten) */}
              {forecastPoints.map((p) => (
                <g key={`fdot-${p.t}`}>
                  {p.gust !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.gust)}
                      r={2}
                      className="fill-red-600 dark:fill-red-500"
                    />
                  )}
                  {p.speed !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.speed)}
                      r={1.7}
                      className="fill-red-600 dark:fill-red-500"
                    />
                  )}
                </g>
              ))}

              {/* Höhenwind (nur Windanzeiger-Stationen): eine gestrichelte,
                  blaue Mittelwind-Linie plus Punkte. Keine Böen/Fläche, da es
                  auf Druckflächen keine Böen gibt. Welche Druckfläche und Höhe
                  gemeint ist, steht in der Beschriftung über dem Diagramm. */}
              <path
                d={upperSpeedPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeDasharray="5 3"
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-blue-600 dark:stroke-blue-400"
              />
              {upperPoints.map((p) =>
                p.speed !== null ? (
                  <circle
                    key={`udot-${p.t}`}
                    cx={x(p.t)}
                    cy={y(p.speed)}
                    r={1.8}
                    className="fill-blue-600 dark:fill-blue-400"
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

              {/* Prognose-Werte oben im Diagramm, in Rot: zuerst Mittelwind,
                  darunter Böe, darunter der Windpfeil — dieselbe Anordnung wie
                  unten bei den Messwerten, nur oben und komplett rot (auch der
                  Pfeil einfarbig statt windstärke-gefärbt wie auf der Karte). */}
              {forecastArrowIndices.map((i) => {
                const p = forecastPoints[i];
                if (p.direction === null) return null;
                const tx = x(p.t).toFixed(1);
                return (
                  <g key={`fvalues-${p.t}`} className="fill-red-600 dark:fill-red-500">
                    <text
                      x={tx}
                      y={forecastSpeedValueY}
                      textAnchor="middle"
                      className="text-[10px] tabular-nums"
                    >
                      {p.speed !== null ? Math.round(p.speed) : "–"}
                    </text>
                    <text
                      x={tx}
                      y={forecastGustValueY}
                      textAnchor="middle"
                      className="text-[10px] tabular-nums"
                    >
                      {p.gust !== null ? Math.round(p.gust) : "–"}
                    </text>
                  </g>
                );
              })}
              {forecastArrowIndices.map((i) => {
                const p = forecastPoints[i];
                if (p.direction === null) return null;
                const rotation = (snapDirectionTo8(p.direction) + 180) % 360;
                return (
                  <g
                    key={`farrow-${p.t}`}
                    transform={`translate(${x(p.t).toFixed(1)} ${forecastArrowCy}) rotate(${rotation.toFixed(0)}) scale(${(ARROW_SIZE / 40).toFixed(3)})`}
                  >
                    <title>
                      {`Prognose ${formatTime(p.t)} Uhr — Wind ${p.speed ?? "–"} km/h, Böen ${p.gust ?? "–"} km/h, Richtung ${Math.round(p.direction)}°`}
                    </title>
                    <path
                      d="M20 2 L34 34 L20 26 L6 34 Z"
                      transform="translate(-20 -20)"
                      className="fill-red-600 dark:fill-red-500"
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
            style={{ height: SVG_H }}
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
