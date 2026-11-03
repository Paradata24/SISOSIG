"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  describeFoehn,
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
// Projektbesitzers) — und die ICON-CH1-Prognose (grau gestrichelt) bis zu
// 33 h voraus. Über der Nulllinie = Süd höher (Südföhn-Lage), darunter = Nord
// höher (Nordföhn-Lage). Die Hintergrundstreifen zeigen die Farbstufen der
// Karte (dieselben Farben wie die Windskala, über 3 hPa rot). Die Quellen
// stehen unter "Quellen" im Ebenen-Menü (Wunsch des Projektbesitzers).
// Aufbau wie der Wind-Verlaufsbalken (WindHistoryPanel: weiß, unten,
// Schließen-Kreuz oben rechts, Escape schließt), aber eigenständig — das
// Diagramm passt sich der Breite an, statt seitlich zu scrollen.

const CHART_H = 150;
const TIME_LABEL_H = 18;
const PAD_LEFT = 30; // Platz für die hPa-Zahlen
const PAD_RIGHT = 8;
const PAD_TOP = 6;
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
// Messlücke, ab der eine Kurve unterbrochen wird. Stationen: alle 10 min,
// bis zu drei fehlende Werte werden überbrückt. METAR: Bozen meldet
// stündlich, ein fehlender wird überbrückt, die Nacht (keine Meldungen) nicht.
const MEASURED_GAP_MS = 40 * 60 * 1000;
const METAR_GAP_MS = 150 * 60 * 1000;
// Vergleichslinie der Flughafen-Meldungen: dünn, grau, punktiert.
const METAR_COLOR = "#71717a";
const METAR_DASH = "1 3";
const FORECAST_GAP_MS = 90 * 60 * 1000;
// Wie die Prognose im Wind-Verlaufsbalken (CH1_COLOR, FORECAST_DASH).
const FORECAST_COLOR = "#52525b";
const FORECAST_DASH = "5 3";
const MEASURED_COLOR = "#18181b";
const BAND_OPACITY = 0.3;

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
  loading,
  onClose,
}: {
  /** 10-Minuten-Werte der Stationen (Hauptkurve). */
  measured: PressureDiffPoint[];
  /** Flugwetter-Meldungen der Flughäfen (Vergleichslinie). */
  metar: PressureDiffPoint[];
  forecast: PressureDiffPoint[];
  modelRun: string | null;
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

  // Breite messen: Das Diagramm füllt die ganze Breite des Balkens.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // "Jetzt" beim Öffnen bzw. bei neuen Daten (die kommen alle 10 min).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // Fehlen die Stationswerte, die Flughafen-Meldungen (wie auf der Karte).
  const current = pressureDiffAt(measured, now) ?? pressureDiffAt(metar, now);

  const chart = useMemo(() => {
    // px-1 des Rahmens abziehen.
    const svgW = width - 8;
    if (svgW <= PAD_LEFT + PAD_RIGHT + 50) return null;
    const start = now - HISTORY_HOURS * 60 * 60 * 1000;
    const lastForecast = forecast.length > 0 ? forecast[forecast.length - 1].time : now;
    const end = Math.max(now + 60 * 60 * 1000, lastForecast);
    const inRange = (p: PressureDiffPoint) => p.time >= start && p.time <= end;
    const m = measured.filter(inRange);
    const f = forecast.filter(inRange);
    const mt = metar.filter(inRange);
    const values = [...m, ...mt, ...f].map((p) => p.diff);
    const grow = (extent: number) =>
      Math.max(Y_MIN_EXTENT_HPA, Math.ceil((extent + Y_HEADROOM_HPA) / Y_STEP_HPA) * Y_STEP_HPA);
    const yTop = grow(Math.max(0, ...values));
    const yBottom = -grow(Math.max(0, ...values.map((v) => -v)));
    const plotW = svgW - PAD_LEFT - PAD_RIGHT;
    const x = (t: number) => PAD_LEFT + ((t - start) / (end - start)) * plotW;
    const y = (v: number) =>
      PAD_TOP + ((yTop - Math.max(yBottom, Math.min(yTop, v))) / (yTop - yBottom)) * CHART_H;
    // Beschriftung: jede hPa, bei großer Spanne jede zweite bzw. vierte.
    const span = yTop - yBottom;
    const tickStep = span > 20 ? 4 : span > 10 ? 2 : 1;
    const ticks: number[] = [];
    for (let v = Math.ceil(yBottom / tickStep) * tickStep; v <= yTop; v += tickStep) ticks.push(v);
    // Zeitmarken alle 6 h (Ortszeit), Mitternacht mit Datum.
    const times: number[] = [];
    const first = new Date(start);
    first.setMinutes(0, 0, 0);
    first.setHours(Math.ceil(first.getHours() / 6) * 6);
    for (let t = first.getTime(); t <= end; t += 6 * 60 * 60 * 1000) times.push(t);
    // Farbstreifen je Stufe, oberhalb und unterhalb der Nulllinie gespiegelt
    // (jede Seite bis zu ihrem Achsenende).
    const bands: { from: number; to: number; color: string }[] = [];
    let lower = 0;
    for (const step of FOEHN_COLOR_SCALE) {
      if (lower < yTop) bands.push({ from: lower, to: Math.min(step.upTo, yTop), color: step.color });
      if (-lower > yBottom) bands.push({ from: Math.max(-step.upTo, yBottom), to: -lower, color: step.color });
      lower = step.upTo;
      if (lower >= Math.max(yTop, -yBottom)) break;
    }
    return {
      svgW,
      plotW,
      x,
      y,
      ticks,
      times,
      bands,
      measuredPath: buildPath(m, x, y, MEASURED_GAP_MS),
      metarPath: buildPath(mt, x, y, METAR_GAP_MS),
      forecastPath: buildPath(f, x, y, FORECAST_GAP_MS),
      nowX: x(now),
    };
  }, [width, now, measured, metar, forecast]);

  const svgH = PAD_TOP + CHART_H + TIME_LABEL_H;
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

      {/* Aktuelle Werte: beide Flughäfen (QNH) und die Differenz. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-1 text-xs text-zinc-700 dark:text-zinc-200">
        {current ? (
          <>
            <span>
              {south.short} <strong className="tabular-nums">{formatHpa(current.south)}</strong> hPa
            </span>
            <span>
              {north.short} <strong className="tabular-nums">{formatHpa(current.north)}</strong> hPa
            </span>
            <span
              className="border border-black px-1.5 py-0.5 font-bold tabular-nums"
              style={{ background: currentColor?.color, color: currentColor?.text }}
            >
              {formatPressureDiff(current.diff)}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">{describeFoehn(current.diff)}</span>
          </>
        ) : (
          <span className="text-zinc-500">{loading ? "Druckwerte werden geladen…" : "Kein aktueller Messwert"}</span>
        )}
      </div>

      <div ref={boxRef} className="px-1" style={{ height: svgH }}>
        {chart && (
          <svg width={chart.svgW} height={svgH} viewBox={`0 0 ${chart.svgW} ${svgH}`} className="block">
            {chart.bands.map((band) => (
              <rect
                key={`${band.from}`}
                x={PAD_LEFT}
                width={chart.plotW}
                y={chart.y(band.to)}
                height={chart.y(band.from) - chart.y(band.to)}
                fill={band.color}
                opacity={BAND_OPACITY}
              />
            ))}
            {chart.ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD_LEFT}
                  x2={PAD_LEFT + chart.plotW}
                  y1={chart.y(tick)}
                  y2={chart.y(tick)}
                  stroke={tick === 0 ? "#18181b" : "#e4e4e7"}
                  strokeWidth={tick === 0 ? 1.2 : 1}
                />
                <text
                  x={PAD_LEFT - 4}
                  y={chart.y(tick)}
                  dy=".32em"
                  textAnchor="end"
                  fontSize={10}
                  fill="#71717a"
                  className="tabular-nums"
                >
                  {tick > 0 ? `+${tick}` : tick < 0 ? `−${-tick}` : "0"}
                </text>
              </g>
            ))}
            {chart.times.map((t) => {
              const date = new Date(t);
              const midnight = date.getHours() === 0;
              return (
                <g key={t}>
                  <line
                    x1={chart.x(t)}
                    x2={chart.x(t)}
                    y1={PAD_TOP}
                    y2={PAD_TOP + CHART_H}
                    stroke={midnight ? "#a1a1aa" : "#e4e4e7"}
                    strokeWidth={1}
                  />
                  <text
                    x={chart.x(t)}
                    y={PAD_TOP + CHART_H + 13}
                    textAnchor="middle"
                    fontSize={10}
                    fill={midnight ? "#3f3f46" : "#71717a"}
                    fontWeight={midnight ? 600 : 400}
                  >
                    {midnight
                      ? date.toLocaleDateString("de-DE", { weekday: "short", day: "numeric" })
                      : String(date.getHours()).padStart(2, "0")}
                  </text>
                </g>
              );
            })}
            {/* Seitenangabe: oberhalb der Nulllinie Süd höher, darunter Nord höher. */}
            <text x={PAD_LEFT + 4} y={PAD_TOP + 11} fontSize={10} fill="#52525b">
              ▲ Süd höher (Südföhn)
            </text>
            <text x={PAD_LEFT + 4} y={PAD_TOP + CHART_H - 4} fontSize={10} fill="#52525b">
              ▼ Nord höher (Nordföhn)
            </text>
            {/* Jetzt-Linie zwischen Messung und Prognose. */}
            <line
              x1={chart.nowX}
              x2={chart.nowX}
              y1={PAD_TOP}
              y2={PAD_TOP + CHART_H}
              stroke="#18181b"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <path d={chart.forecastPath} fill="none" stroke={FORECAST_COLOR} strokeWidth={1.8} strokeDasharray={FORECAST_DASH} />
            {/* Unter der Hauptkurve: die Flughafen-Meldungen zum Vergleich. */}
            <path d={chart.metarPath} fill="none" stroke={METAR_COLOR} strokeWidth={1.2} strokeDasharray={METAR_DASH} strokeLinecap="round" />
            <path d={chart.measuredPath} fill="none" stroke={MEASURED_COLOR} strokeWidth={2} strokeLinejoin="round" />
          </svg>
        )}
      </div>

      <p className="px-3 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="text-zinc-800 dark:text-zinc-100">schwarz</span>: gemessen (Wetterstationen, 10 min) ·{" "}
        <span style={{ color: METAR_COLOR }}>grau punktiert</span>: Flughäfen (METAR) ·{" "}
        <span style={{ color: FORECAST_COLOR }}>grau gestrichelt</span>: Prognose ICON-CH1
        {modelRun && <>, Lauf {formatClock(Date.parse(modelRun))} Uhr</>}
      </p>
    </section>
  );
}
