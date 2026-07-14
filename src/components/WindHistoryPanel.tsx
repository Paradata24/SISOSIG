"use client";

import { useEffect, useRef, useState } from "react";
import { getWindColor, WIND_COLOR_SCALE, type WindStation } from "@/lib/wind";
import type { HistoryEntry } from "@/app/api/history/route";

// Verlaufspanel am unteren Bildschirmrand (Vorbild: Meteoparapente).
// Zeigt für die angeklickte Station die letzten 48 Stunden:
//  - Zeitachse (Lokalzeit) oben
//  - Liniendiagramm: Mittelwind (dünn) und Böen (dick) vor horizontalen
//    Farbbändern der Windstärke-Skala
//  - darunter eine Reihe Windrichtungs-Pfeile
// Farben und Pfeil-Drehung nutzen exakt dieselbe Logik wie die Karten-
// Pfeile (getWindColor bzw. Richtung + 180°), damit nichts auseinanderläuft.

// Geometrie des SVG (alle Angaben in px)
const TIME_LABEL_H = 18; // Zeile mit den Uhrzeiten oben
const CHART_H = 140; // Höhe des Kurvenbereichs
const ARROW_GAP = 8; // Abstand Kurvenbereich → Pfeilreihe
const ARROW_ROW_H = 26; // Höhe der Pfeilreihe
const SVG_H = TIME_LABEL_H + CHART_H + ARROW_GAP + ARROW_ROW_H;
const PAD_X = 10; // linker/rechter Innenabstand des Diagramms

// Breite pro Stunde. Bewusst so groß, dass die volle Zeitspanne breiter ist
// als der Bildschirm — dadurch ist das Diagramm sowohl am Desktop als auch am
// Handy horizontal scrollbar und die Stundenbeschriftungen liegen dicht genug
// beisammen, um gut lesbar zu sein.
const PX_PER_HOUR = 118;
const ARROW_SIZE = 15; // Kantenlänge eines Richtungspfeils
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
    error?: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  // Bezugszeitpunkt "jetzt" für die feste Zeitachse. Wird beim Laden gesetzt,
  // damit der Render selbst rein bleibt (kein Date.now() während des Renderns).
  const [now, setNow] = useState(() => Date.now());

  const loading = result?.code !== station.stationCode;
  const entries = loading ? null : (result?.entries ?? null);
  const error = loading ? null : (result?.error ?? null);

  // Historie der angeklickten Station laden.
  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      const code = station.stationCode;
      try {
        const res = await fetch(`/api/history?station=${encodeURIComponent(code)}`);
        const data = await res.json();
        if (cancelled) return;
        setNow(Date.now());
        if (!res.ok) {
          setResult({
            code,
            error: data.error ?? "Verlauf konnte nicht geladen werden",
          });
        } else {
          setResult({ code, entries: data.entries as HistoryEntry[] });
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

  const hasData = points.some((p) => p.speed !== null || p.gust !== null);

  // --- Skalen ---
  // Feste Zeitachse von (jetzt − 48h) bis (jetzt + 3h), unabhängig davon,
  // welche Messpunkte tatsächlich vorliegen. So sitzen die Werte immer an der
  // richtigen Stelle der Achse, fehlende Zeiträume bleiben als Lücke sichtbar
  // (statt die wenigen Punkte über die ganze Breite zu strecken), und die
  // aktuelle Uhrzeit steht dank der 3h-Reserve stets nahe dem rechten Rand.
  const minT = now - HISTORY_HOURS * 3_600_000;
  const maxT = now + FUTURE_MARGIN_HOURS * 3_600_000;
  const hoursSpan = (maxT - minT) / 3_600_000;

  const svgWidth = Math.max(
    containerW,
    Math.ceil(hoursSpan * PX_PER_HOUR) + 2 * PAD_X,
  );
  const innerW = svgWidth - 2 * PAD_X;

  const maxValue = points.reduce(
    (m, p) => Math.max(m, p.speed ?? 0, p.gust ?? 0),
    0,
  );
  // Obergrenze der y-Achse auf volle 10er runden, mindestens 20 km/h.
  const yMax = Math.max(20, Math.ceil(maxValue / 10) * 10);
  const yTickStep = yMax > 50 ? 20 : 10;

  const x = (t: number) => PAD_X + ((t - minT) / (maxT - minT)) * innerW;
  const chartTop = TIME_LABEL_H;
  const chartBottom = TIME_LABEL_H + CHART_H;
  const y = (v: number) => chartBottom - (v / yMax) * CHART_H;
  const arrowCy = chartBottom + ARROW_GAP + ARROW_ROW_H / 2;

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
  const pxPerHour = hoursSpan > 0 ? innerW / hoursSpan : innerW;
  // Uhrzeiten nur so dicht beschriften, dass sie sich nicht überlappen.
  const labelEveryHours = pxPerHour >= 44 ? 1 : pxPerHour >= 22 ? 2 : 4;

  // --- Pfeile ggf. ausdünnen, damit sie sich nicht überlappen ---
  const pxPerPoint = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const arrowStep = Math.max(1, Math.ceil((ARROW_SIZE + 2) / pxPerPoint));
  const arrowIndices: number[] = [];
  for (let i = points.length - 1; i >= 0; i -= arrowStep) arrowIndices.push(i);

  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += yTickStep) yTicks.push(v);

  const speedPath = buildLinePath(points, (p) => p.speed, x, y);
  const gustPath = buildLinePath(points, (p) => p.gust, x, y);

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
        </h2>
        <span className="hidden text-xs text-zinc-500 sm:inline dark:text-zinc-400">
          letzte 48 Stunden
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-zinc-600 dark:text-zinc-300">
          <span className="flex items-center gap-1.5">
            <span className="h-px w-5 bg-zinc-900 dark:bg-zinc-100" />
            Mittelwind
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[3px] w-5 rounded-full bg-zinc-900 dark:bg-zinc-100" />
            Böen
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Verlauf schließen"
          className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
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

      <div className="flex px-1 pb-2">
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
                        className="fill-zinc-500 text-[10px] tabular-nums dark:fill-zinc-400"
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
                strokeWidth={1.5}
                strokeDasharray="3 3"
              />
              <text
                x={x(now)}
                y={chartTop + 10}
                textAnchor="middle"
                className="fill-zinc-700 text-[9px] font-semibold dark:fill-zinc-200"
              >
                jetzt
              </text>

              {/* Kurven: Böen dick, Mittelwind dünn (wie im Vorbild) */}
              <path
                d={gustPath}
                fill="none"
                strokeWidth={2.4}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-zinc-900 dark:stroke-zinc-100"
              />
              <path
                d={speedPath}
                fill="none"
                strokeWidth={1.3}
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
                      r={1.8}
                      className="fill-zinc-900 dark:fill-zinc-100"
                    />
                  )}
                  {p.speed !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.speed)}
                      r={1.5}
                      className="fill-zinc-900 dark:fill-zinc-100"
                    />
                  )}
                </g>
              ))}

              {/* Windrichtungs-Pfeile: gleiche Form, Drehung (Richtung + 180°,
                  Pfeil zeigt wohin der Wind weht) und Farben wie auf der
                  Karte (Füllung = Mittelwind, Rand = Böe) */}
              {arrowIndices.map((i) => {
                const p = points[i];
                if (p.direction === null) return null;
                const rotation = (p.direction + 180) % 360;
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
            </svg>
          )}
        </div>

        {/* km/h-Achse rechts, außerhalb des Scrollbereichs, damit sie beim
            Scrollen sichtbar bleibt */}
        {!loading && !error && hasData && (
          <div
            className="relative w-9 shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400"
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
    </section>
  );
}
