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
// Projektbesitzers) — und die Prognosen ICON-CH1 (grau gestrichelt, 33 h
// voraus) und ECMWF (blau gestrichelt, 72 h voraus, seit Nov. 2026). Über der Nulllinie = Süd höher (Südföhn-Lage), darunter = Nord
// höher (Nordföhn-Lage). Die Hintergrundstreifen zeigen die Farbstufen der
// Karte (dieselben Farben wie die Windskala, über 3 hPa rot). Die Quellen
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
// Breite einer Stunde (px). 30 px lassen Platz für "14" und machen 10-min-
// Schwankungen sichtbar; 48 h + 72 h ECMWF ergeben gut 3.600 px zum Wischen.
const PX_PER_HOUR = 30;
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
// ECMWF (seit Nov. 2026, Wunsch des Projektbesitzers): blau gestrichelt, damit
// es sich klar vom grauen ICON-CH1 abhebt. Reicht 72 h voraus, ICON-CH1 33 h.
const ECMWF_COLOR = "#2563eb";
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
  ecmwf,
  ecmwfRun,
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
    const m = measured.filter(inRange);
    const f = forecast.filter(inRange);
    const mt = metar.filter(inRange);
    const e = ecmwf.filter(inRange);
    const values = [...m, ...mt, ...f, ...e].map((p) => p.diff);
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
    const tickStep = span > 20 ? 4 : span > 10 ? 2 : 1;
    const ticks: number[] = [];
    for (let v = Math.ceil(yBottom / tickStep) * tickStep; v <= yTop; v += tickStep) ticks.push(v);
    // Jede volle Stunde (Ortszeit; bei Zeitzonen mit halben Stunden passt
    // das nicht, für die Alpen egal).
    const times: number[] = [];
    for (let t = start; t <= end; t += HOUR_MS) times.push(t);
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
      x,
      y,
      ticks,
      times,
      bands,
      measuredPath: buildPath(m, x, y, MEASURED_GAP_MS),
      metarPath: buildPath(mt, x, y, METAR_GAP_MS),
      forecastPath: buildPath(f, x, y, FORECAST_GAP_MS),
      ecmwfPath: buildPath(e, x, y, FORECAST_GAP_MS),
      nowX: x(now),
    };
  }, [now, measured, metar, forecast, ecmwf]);

  // Beim ersten Zeichnen "jetzt" in die Mitte schieben.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledToNow.current || (measured.length === 0 && forecast.length === 0)) return;
    el.scrollLeft = Math.max(0, chart.nowX - el.clientWidth / 2);
    scrolledToNow.current = true;
  }, [chart, measured.length, forecast.length]);

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

      <div className="relative flex pr-1" style={{ height: svgH }}>
        {/* Feste hPa-Spalte links, wandert beim Verschieben nicht mit. */}
        <div className="relative w-8 shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400" aria-hidden="true">
          {chart.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-1 -translate-y-1/2 tabular-nums"
              style={{ top: chart.y(tick) }}
            >
              {tick > 0 ? `+${tick}` : tick < 0 ? `−${-tick}` : "0"}
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
            {chart.bands.map((band) => (
              <rect
                key={`${band.from}`}
                x={0}
                width={chart.svgW}
                y={chart.y(band.to)}
                height={chart.y(band.from) - chart.y(band.to)}
                fill={band.color}
                opacity={BAND_OPACITY}
              />
            ))}
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
            {chart.times.map((t) => {
              const date = new Date(t);
              const hour = date.getHours();
              const midnight = hour === 0;
              return (
                <g key={t}>
                  <line
                    x1={chart.x(t)}
                    x2={chart.x(t)}
                    y1={PAD_TOP}
                    y2={PAD_TOP + CHART_H + (midnight ? 4 : 0)}
                    stroke={midnight ? "#71717a" : hour % 6 === 0 ? "#d4d4d8" : "#ececee"}
                    strokeWidth={1}
                  />
                  <text
                    x={chart.x(t)}
                    y={PAD_TOP + CHART_H + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill={midnight ? "#18181b" : "#71717a"}
                    fontWeight={midnight ? 600 : 400}
                    className="tabular-nums"
                  >
                    {String(hour).padStart(2, "0")}
                  </text>
                  {midnight && (
                    <text
                      x={chart.x(t) + 2}
                      y={PAD_TOP + CHART_H + 25}
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
              y2={PAD_TOP + CHART_H}
              stroke="#18181b"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <path d={chart.ecmwfPath} fill="none" stroke={ECMWF_COLOR} strokeWidth={1.6} strokeDasharray={FORECAST_DASH} />
            <path d={chart.forecastPath} fill="none" stroke={FORECAST_COLOR} strokeWidth={1.8} strokeDasharray={FORECAST_DASH} />
            {/* Unter der Hauptkurve: die Flughafen-Meldungen zum Vergleich. */}
            <path d={chart.metarPath} fill="none" stroke={METAR_COLOR} strokeWidth={1.2} strokeDasharray={METAR_DASH} strokeLinecap="round" />
            <path d={chart.measuredPath} fill="none" stroke={MEASURED_COLOR} strokeWidth={2} strokeLinejoin="round" />
          </svg>
        </div>
        {/* Seitenangabe fest links über dem Diagramm (wandert nicht mit):
            oberhalb der Nulllinie Süd höher, darunter Nord höher. */}
        <span
          className="pointer-events-none absolute left-9 bg-white/70 px-0.5 text-[10px] text-zinc-600"
          style={{ top: PAD_TOP + 1 }}
        >
          ▲ Süd höher (Südföhn)
        </span>
        <span
          className="pointer-events-none absolute left-9 bg-white/70 px-0.5 text-[10px] text-zinc-600"
          style={{ top: PAD_TOP + CHART_H - 15 }}
        >
          ▼ Nord höher (Nordföhn)
        </span>
      </div>

      <p className="px-3 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="text-zinc-800 dark:text-zinc-100">schwarz</span>: gemessen (Wetterstationen, 10 min) ·{" "}
        <span style={{ color: METAR_COLOR }}>grau punktiert</span>: Flughäfen (METAR) ·{" "}
        <span style={{ color: FORECAST_COLOR }}>grau gestrichelt</span>: Prognose ICON-CH1
        {modelRun && <>, Lauf {formatClock(Date.parse(modelRun))} Uhr</>} ·{" "}
        <span style={{ color: ECMWF_COLOR }}>blau gestrichelt</span>: Prognose ECMWF
        {ecmwfRun && <>, Lauf {formatClock(Date.parse(ecmwfRun))} Uhr</>}
      </p>
    </section>
  );
}
