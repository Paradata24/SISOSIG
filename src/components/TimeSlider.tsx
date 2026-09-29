"use client";

import { useEffect, useRef, useState } from "react";
import {
  FUTURE_MARGIN_HOURS,
  getWindColor,
  GRID_MS,
  TIMELINE_STEP_PX,
  type TimelinePayload,
} from "@/lib/wind";

// Zeitbalken unter der Karte ("Zeitband", Umbau Sept. 2026).
//
// Idee (vom Projektbesitzer aus mehreren Vorschau-Varianten ausgewählt):
// Der Balken ist ein Stück ZEITACHSE im selben Maßstab wie der Verlaufsbalken
// (TIMELINE_STEP_PX = Spaltenabstand dort). Man WISCHT das Band nach links oder
// rechts; eine feste schwarze Linie in der Mitte zeigt, welchen Zeitpunkt die
// Karte gerade darstellt. Nach rechts wischen = zurück in der Zeit.
// Darunter ein dünner Farbstrich: je 10-Minuten-Schritt die Windfarbe der
// windigsten Stationen im gerade sichtbaren Kartenausschnitt (siehe
// buildStripColors). So sieht man ohne Suchen, wann es aufgefrischt hat —
// z. B. wann der Föhn durchgebrochen ist.
//
// Farben bewusst schwarz/grau wie der Menü-Knopf (früher grün, Wunsch des
// Projektbesitzers). Der Zustand "jetzt" heißt überall "Aktuell" (nicht
// "Live"/"Jetzt", ebenfalls Wunsch des Projektbesitzers).
//
// Technik: ein ganz normaler waagrechter Scrollbereich mit CSS-Einrasten
// (scroll-snap) auf jedem 10-Minuten-Schritt. Wischen am Handy und das
// Nachgleiten nach dem Loslassen macht also der Browser selbst — das ist
// flüssiger und zuverlässiger als eigene Zeiger-Rechnerei. Nur für Maus,
// Mausrad und Tastatur gibt es kleine Ergänzungen (siehe unten).
// Die Position im Band ist direkt der Zeitpunkt: scrollLeft / TIMELINE_STEP_PX
// = Index in der Slot-Liste. Links und rechts ist je eine halbe Bandbreite
// Luft, damit auch der erste und der letzte Zeitpunkt bis zur Mitte kommen.

export type TimelineStatus = "idle" | "loading" | "ready" | "error";

// Tempo beim Abspielen: so lange steht jeder 10-Minuten-Schritt. 73 Schritte
// × 300 ms ≈ 22 s für die ganzen 12 Stunden.
const PLAY_STEP_MS = 300;
// Welcher Wert des Kartenausschnitts den Farbstrich bestimmt: 0,9 = die
// windigsten 10 % der Stationen. Der Mittelwert würde einen Föhndurchbruch in
// einem einzelnen Tal zwischen vielen ruhigen Stationen verschlucken, das
// Maximum dagegen jede einzelne Gipfelstation hervorheben.
const STRIP_QUANTILE = 0.9;
// Die Prognose-Reserve rechts von "jetzt" ist (wie im Verlaufsbalken) halb so
// dicht wie die Vergangenheit. Sie dient nur der Orientierung: Die Karte hat
// für die Zukunft keine Werte, das Band rastet deshalb auf "jetzt" zurück.
const FUTURE_STEP_PX = TIMELINE_STEP_PX / 2;
const FUTURE_WIDTH_PX = ((FUTURE_MARGIN_HOURS * 3_600_000) / GRID_MS) * FUTURE_STEP_PX;
// Breite der km/h-Spalte rechts im Verlaufsbalken (w-10). Das Band lässt
// rechts genauso viel Platz, damit seine Mittellinie genau unter der
// Zeitmarke des Verlaufsbalkens steht, wenn beide übereinander stehen.
const Y_AXIS_GUTTER_CLASS = "w-10";
// Senkrechte Aufteilung des Bands (px).
const BAND_H = 34;
const LABEL_Y = 11; // Grundlinie der Uhrzeiten
const TICK_TOP = 14;
const STRIP_Y = 25;
const STRIP_H = 7;
// Farbe für Schritte ohne Messwerte (Daten fehlen oder noch nicht geladen).
const STRIP_EMPTY = "#e4e4e7"; // zinc-200

/**
 * Farbe des Strichs je Rasterzeitpunkt (parallel zu slots): Windfarbe des
 * STRIP_QUANTILE-Werts (Mittelwind) aller angegebenen Stationen. null =
 * keine Messung (grau). Maßgeblich ist wie in buildTimelineFrame die
 * Zeitliste des Servers; gesucht wird der nächstgelegene Rasterpunkt.
 */
export function buildStripColors(
  payload: TimelinePayload | null,
  slots: number[],
  stationCodes: string[] | null,
): (string | null)[] | null {
  if (!payload || payload.times.length === 0 || !stationCodes) return null;
  const start = payload.times[0];
  const series = stationCodes
    .map((code) => payload.stations[code])
    .filter((s) => s !== undefined);
  return slots.map((time) => {
    const idx = Math.round((time - start) / GRID_MS);
    if (idx < 0 || idx >= payload.times.length) return null;
    if (Math.abs(payload.times[idx] - time) > GRID_MS / 2) return null;
    const speeds: number[] = [];
    for (const s of series) {
      const v = s.s[idx];
      if (v !== null && v !== undefined) speeds.push(v);
    }
    if (speeds.length === 0) return null;
    speeds.sort((a, b) => a - b);
    return getWindColor(speeds[Math.floor((speeds.length - 1) * STRIP_QUANTILE)]);
  });
}

/** "14:40 Uhr"; über Mitternacht hinweg zusätzlich der Wochentag. */
function formatSlotLabel(time: number, now: number): string {
  const date = new Date(time);
  const hhmm = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  // Ein 12-Stunden-Fenster reicht regelmäßig über Mitternacht. "23:50 Uhr"
  // allein wäre dann zweideutig, deshalb der Wochentag davor.
  if (new Date(now).toDateString() === date.toDateString()) return `${hhmm} Uhr`;
  const weekday = date.toLocaleDateString("de-DE", { weekday: "short" });
  return `${weekday} ${hhmm} Uhr`;
}

/** "vor 3 h 20 min" — wie weit der gewählte Zeitpunkt zurückliegt. */
function formatAgo(time: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `vor ${rest} min`;
  if (rest === 0) return `vor ${hours} h`;
  return `vor ${hours} h ${rest} min`;
}

/** Stundenbeschriftung wie im Verlaufsbalken: "14:00", um Mitternacht das Datum. */
function formatHourLabel(date: Date): string {
  if (date.getHours() === 0) {
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  }
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

// Knopf-Stil wie der Menü-Knopf im Titelbalken: eckig, schwarzer Rand.
const BUTTON_CLASS =
  "flex h-9 shrink-0 items-center justify-center border border-black bg-white text-zinc-900 hover:bg-zinc-100 disabled:opacity-30 disabled:hover:bg-white dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800";

export default function TimeSlider({
  slots,
  selectedTime,
  onChange,
  status,
  stripColors,
}: {
  /** Rasterzeitpunkte (Epoch-ms), aufsteigend; der letzte ist "jetzt". */
  slots: number[];
  /** Gewählter Zeitpunkt, null = aktuell. */
  selectedTime: number | null;
  onChange: (time: number | null) => void;
  status: TimelineStatus;
  /** Farbe je Rasterzeitpunkt (parallel zu slots), siehe buildStripColors. */
  stripColors: (string | null)[] | null;
}) {
  const lastIndex = slots.length - 1;
  const now = slots[lastIndex];
  // Gespeichert wird der ZEITPUNKT, nicht die Position — die Slot-Liste wandert
  // ja alle 10 Minuten weiter. Die Position wird daraus zurückgerechnet.
  const index =
    selectedTime === null
      ? lastIndex
      : Math.min(lastIndex, Math.max(0, Math.round((selectedTime - slots[0]) / GRID_MS)));
  const current = selectedTime === null;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Halbe Breite des Bands = Luft links/rechts (siehe oben). Gemessen, weil
  // sie von der Bildschirmbreite abhängt.
  const [halfWidth, setHalfWidth] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Gerade laufendes Ziehen mit der Maus (siehe handlePointerDown).
  const dragRef = useRef<{ x: number; scroll: number } | null>(null);

  // Die jeweils neuesten Werte für Zuhörer, die nicht bei jedem Neuzeichnen
  // neu angemeldet werden sollen (Scrollen, Mausrad, Abspiel-Takt).
  const latest = useRef({ index, lastIndex, slots, onChange });
  useEffect(() => {
    latest.current = { index, lastIndex, slots, onChange };
  });

  // Index → Zeitpunkt melden. Ganz rechts IST "jetzt" → null (aktuell).
  const select = (i: number) => {
    const { lastIndex: last, slots: s, onChange: change } = latest.current;
    const clamped = Math.min(last, Math.max(0, i));
    change(clamped >= last ? null : s[clamped]);
  };

  // Band gezielt auf einen Schritt stellen (Tastatur, Maus, Knöpfe). Das
  // Scroll-Ereignis danach meldet den neuen Zeitpunkt über handleScroll.
  const scrollToIndex = (i: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const clamped = Math.min(latest.current.lastIndex, Math.max(0, i));
    el.scrollLeft = clamped * TIMELINE_STEP_PX;
    select(clamped);
  };

  // Breite beobachten.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setHalfWidth(Math.round(el.clientWidth / 2));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Kommt der Zeitpunkt von AUSSEN (Abspielen, "Aktuell"-Knopf, Refresh, oder
  // die Slot-Liste rückt nach 10 min weiter), das Band nachziehen. Beim
  // Wischen selbst ist die Position schon richtig (Abweichung < ½ Schritt) —
  // dann wird bewusst NICHT geschrieben, sonst würde das Nachgleiten des
  // Fingers am Handy abgewürgt.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || halfWidth === 0 || dragRef.current) return;
    const target = index * TIMELINE_STEP_PX;
    if (Math.abs(el.scrollLeft - target) > TIMELINE_STEP_PX / 2) el.scrollLeft = target;
  }, [index, halfWidth]);

  // Scrollen → Zeitpunkt. Höchstens einmal pro Bild (requestAnimationFrame),
  // die Karte zeichnet ohnehin in ihrem eigenen Tempo nach (useDeferredValue
  // in WindApp).
  const frameRef = useRef(0);
  const handleScroll = () => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const i = Math.round(el.scrollLeft / TIMELINE_STEP_PX);
      const { index: currentIndex, lastIndex: last } = latest.current;
      if (Math.min(last, Math.max(0, i)) !== currentIndex) select(i);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // Mausrad (senkrecht wie waagrecht): je TIMELINE_STEP_PX Drehweg ein
  // Schritt. Ohne das würde ein senkrechtes Rad am Computer gar nichts tun,
  // und kleine Trackpad-Bewegungen würden vom Einrasten wieder
  // zurückgeschnappt. Als eigener Zuhörer angemeldet, weil React Mausrad-
  // Ereignisse nur "passiv" meldet und preventDefault dort nicht wirkt.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let accumulated = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setPlaying(false);
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      accumulated += e.deltaMode === 1 ? delta * 16 : delta;
      const steps = Math.trunc(accumulated / TIMELINE_STEP_PX);
      if (steps === 0) return;
      accumulated -= steps * TIMELINE_STEP_PX;
      const target = Math.min(
        latest.current.lastIndex,
        Math.max(0, Math.round(el.scrollLeft / TIMELINE_STEP_PX) + steps),
      );
      el.scrollLeft = target * TIMELINE_STEP_PX;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Maus: Band mit gedrückter Taste ziehen. Am Handy (Finger, Stift) macht
  // das der Browser selbst — deshalb nur bei pointerType "mouse". Während des
  // Ziehens ist das Einrasten aus, sonst ruckelt es in Schritten.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setPlaying(false);
    if (e.pointerType !== "mouse" || !scrollRef.current) return;
    dragRef.current = { x: e.clientX, scroll: scrollRef.current.scrollLeft };
    scrollRef.current.style.scrollSnapType = "none";
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !scrollRef.current) return;
    scrollRef.current.scrollLeft = drag.scroll - (e.clientX - drag.x);
  };
  const endDrag = () => {
    const el = scrollRef.current;
    if (!dragRef.current || !el) return;
    dragRef.current = null;
    el.style.scrollSnapType = "";
    scrollToIndex(Math.round(el.scrollLeft / TIMELINE_STEP_PX));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : 0;
    if (step === 0) return;
    e.preventDefault();
    setPlaying(false);
    if (step === -Infinity) scrollToIndex(0);
    else if (step === Infinity) scrollToIndex(lastIndex);
    else scrollToIndex(index + step);
  };

  // Abspielen: Schritt für Schritt bis "jetzt", dann stehen bleiben.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const { index: i, lastIndex: last } = latest.current;
      if (i >= last - 1) setPlaying(false);
      select(i + 1);
    }, PLAY_STEP_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Von "aktuell" aus beginnt der Film am Anfang der 12 Stunden.
    if (index >= lastIndex) select(0);
    setPlaying(true);
  }

  // --- Band-Inhalt ---
  const historyWidth = lastIndex * TIMELINE_STEP_PX;
  const svgWidth = halfWidth + historyWidth + Math.max(halfWidth, FUTURE_WIDTH_PX);
  const xOfTime = (t: number) =>
    t <= now
      ? halfWidth + ((t - slots[0]) / GRID_MS) * TIMELINE_STEP_PX
      : halfWidth + historyWidth + ((t - now) / GRID_MS) * FUTURE_STEP_PX;
  const hours: Date[] = [];
  {
    const first = new Date(slots[0]);
    first.setMinutes(0, 0, 0);
    if (first.getTime() < slots[0]) first.setHours(first.getHours() + 1);
    const end = now + FUTURE_MARGIN_HOURS * 3_600_000;
    for (let d = first; d.getTime() <= end; d = new Date(d.getTime() + 3_600_000)) hours.push(d);
  }

  const statusText =
    status === "error" ? (
      <span className="text-red-600 dark:text-red-400">Verlauf nicht verfügbar</span>
    ) : current ? (
      <span className="font-semibold text-zinc-900 dark:text-zinc-50">Aktuell</span>
    ) : (
      <>
        <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          {formatSlotLabel(slots[index], now)}
        </span>
        <span className="text-zinc-500 dark:text-zinc-400"> · {formatAgo(slots[index], now)}</span>
      </>
    );

  return (
    // Unterstes Element der Seite: der zusätzliche untere Innenabstand hält
    // alles über dem Bedienbalken, den iPhones unten einblenden (auf anderen
    // Geräten ist env(...) gleich 0).
    <div className="shrink-0 border-t border-zinc-200 bg-white pt-1.5 pb-[calc(0.25rem+env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 px-2">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Anhalten" : "Letzte 12 Stunden abspielen"}
          title={playing ? "Anhalten" : "Abspielen"}
          className={`${BUTTON_CLASS} w-9`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
            {playing ? (
              <>
                <rect x="3" y="2" width="3.5" height="12" />
                <rect x="9.5" y="2" width="3.5" height="12" />
              </>
            ) : (
              <path d="M4 2 L14 8 L4 14 Z" />
            )}
          </svg>
        </button>
        <div className="min-w-0 flex-1 truncate text-sm tabular-nums" aria-live="polite">
          {statusText}
          {status === "loading" && (
            <span className="text-xs text-zinc-400"> · Verlauf wird geladen…</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            scrollToIndex(lastIndex);
          }}
          disabled={current && !playing}
          className={`${BUTTON_CLASS} px-3 text-sm font-medium`}
        >
          Aktuell
        </button>
      </div>

      {/* Gleicher Aufbau wie der Verlaufsbalken (px-1, Scrollbereich, rechts
          die w-10-Spalte), damit die Mittellinien beider Balken übereinander
          stehen. */}
      <div className="mt-1 flex px-1">
        <div className="relative min-w-0 flex-1">
          <div
            ref={scrollRef}
            className="zeitband"
            style={{ height: BAND_H }}
            onScroll={handleScroll}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onTouchStart={() => setPlaying(false)}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            role="slider"
            aria-label="Zeitpunkt der Karte (wischen)"
            aria-valuemin={0}
            aria-valuemax={lastIndex}
            aria-valuenow={index}
            aria-valuetext={current ? "Aktuell" : formatSlotLabel(slots[index], now)}
          >
            {halfWidth > 0 && (
              <svg width={svgWidth} height={BAND_H} aria-hidden="true" className="block">
                {/* Farbstrich: je Schritt die Windfarbe des Kartenausschnitts */}
                {slots.map((t, i) => (
                  <rect
                    key={t}
                    x={halfWidth + i * TIMELINE_STEP_PX - TIMELINE_STEP_PX / 2}
                    y={STRIP_Y}
                    width={TIMELINE_STEP_PX + 0.5}
                    height={STRIP_H}
                    fill={stripColors?.[i] ?? STRIP_EMPTY}
                  />
                ))}
                {/* 10-Minuten-Striche */}
                {slots.map((t, i) =>
                  new Date(t).getMinutes() === 0 ? null : (
                    <line
                      key={`m-${t}`}
                      x1={halfWidth + i * TIMELINE_STEP_PX}
                      x2={halfWidth + i * TIMELINE_STEP_PX}
                      y1={STRIP_Y - 4}
                      y2={STRIP_Y}
                      className="stroke-zinc-300 dark:stroke-zinc-600"
                    />
                  ),
                )}
                {/* Stunden: längerer Strich + Uhrzeit (in der Prognose-Reserve
                    blasser, dort kann die Karte nichts zeigen) */}
                {hours.map((d) => {
                  const hx = xOfTime(d.getTime());
                  const future = d.getTime() > now;
                  return (
                    <g key={d.getTime()}>
                      <line
                        x1={hx}
                        x2={hx}
                        y1={TICK_TOP}
                        y2={STRIP_Y}
                        className="stroke-zinc-400 dark:stroke-zinc-500"
                      />
                      <text
                        x={hx}
                        y={LABEL_Y}
                        textAnchor="middle"
                        className={`text-[11px] tabular-nums ${
                          future ? "fill-zinc-300 dark:fill-zinc-600" : "fill-zinc-500 dark:fill-zinc-400"
                        }`}
                      >
                        {formatHourLabel(d)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}
            {/* Einrast-Punkte, einer je 10-Minuten-Schritt (siehe .zeitband-
                punkt in globals.css). In der Prognose-Reserve gibt es keine —
                dorthin gewischt, rastet das Band auf "jetzt" zurück. */}
            {halfWidth > 0 &&
              slots.map((t, i) => (
                <span
                  key={`s-${t}`}
                  className="zeitband-punkt"
                  style={{ left: halfWidth + i * TIMELINE_STEP_PX }}
                />
              ))}
          </div>
          {/* Feste Mittellinie mit Uhrzeit-Fähnchen; lässt Klicks durch. */}
          <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-zinc-900 dark:bg-zinc-100" />
          <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 bg-zinc-900 px-1 text-[10px] leading-[14px] font-semibold whitespace-nowrap text-white tabular-nums dark:bg-zinc-100 dark:text-zinc-900">
            {current
              ? "aktuell"
              : new Date(slots[index]).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
        <div className={`${Y_AXIS_GUTTER_CLASS} shrink-0`} aria-hidden="true" />
      </div>
    </div>
  );
}
