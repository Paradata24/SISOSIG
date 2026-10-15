"use client";

import { useEffect, useRef, useState } from "react";
import { getWindColor, GRID_MS, type TimelinePayload } from "@/lib/wind";

// Zeitbalken unter der Karte — ein Zeitrad.
//
// Idee (Wunsch des Projektbesitzers, Vorbild: die Höhenauswahl bei
// Meteoparapente): Der Zeitbalken sieht aus wie ein waagrecht liegendes Rad,
// das man nach vorne und hinten dreht. In der Mitte steht ein fester
// Rahmen — der Zeitpunkt unter dem Rahmen ist der, den die Karte zeigt.
// Zu den Rändern hin "kippt" das Rad weg: Striche und Zahlen rücken enger
// zusammen und werden blasser, wie bei einer Walze.
//
// Bedienung: Den Finger (oder die Maus) auf das Rad legen und ziehen. Nach
// RECHTS ziehen dreht zurück in der Zeit, nach LINKS vor (wie beim Greifen
// einer Zeitleiste). Loslassen mit Schwung lässt das Rad auslaufen, es rastet
// immer auf einem 10-Minuten-Schritt ein. Ein kurzes Antippen springt zu der
// angetippten Stelle. Der Knopf "Aktuell" dreht ganz nach vorne zurück.
//
// Im Rad liegt außerdem ein Farbstrich: je 10-Minuten-Schritt die Windfarbe
// der windigsten Stationen im sichtbaren Kartenausschnitt (buildStripColors).
// So sieht man schon vor dem Drehen, wann es aufgefrischt hat.
//
// Technik: Das Rad wird als SVG selbst gezeichnet, die Bewegung rechnet die
// Komponente selbst (Zeigerereignisse, eigener Auslauf per requestAnimationFrame).
// Die frühere Fassung mit dem Browser-eigenen Scrollen und Einrasten ließ sich
// am Handy nicht benutzen (Schwung nicht steuerbar, Position kämpfte gegen den
// Finger) — deshalb hier bewusst eigene, einfache Physik.
//
// Farben schwarz/grau wie der Menü-Knopf (kein Grün, Wunsch des
// Projektbesitzers). Der Zustand "jetzt" heißt "Aktuell". Bei geöffneter
// Station ist der Zeitbalken ganz ausgeblendet (WindApp).

export type TimelineStatus = "idle" | "loading" | "ready" | "error";

// Welcher Wert des Kartenausschnitts den Farbstrich bestimmt: 0,9 = die
// windigsten 10 % der Stationen. Der Mittelwert würde einen Föhndurchbruch in
// einem einzelnen Tal zwischen vielen ruhigen Stationen verschlucken, das
// Maximum dagegen jede einzelne Gipfelstation hervorheben.
const STRIP_QUANTILE = 0.9;

// --- Geometrie des Rads ---
// Jeder 10-Minuten-Schritt dreht das Rad um diesen Winkel weiter (Grad).
const ANGLE_PER_SLOT_DEG = 6;
// Bis zu diesem Winkel von der Mitte aus ist das Rad sichtbar; der Rand der
// Anzeige liegt genau dort. Ein Rad mit 80° wirkt rund, ohne dass die
// äußersten Striche zu einem Klumpen verschmelzen.
const MAX_ANGLE_DEG = 80;
const ANGLE_PER_SLOT = (ANGLE_PER_SLOT_DEG * Math.PI) / 180;
const MAX_ANGLE = (MAX_ANGLE_DEG * Math.PI) / 180;
// So viele Pixel muss der Finger wandern, damit das Rad um einen
// 10-Minuten-Schritt weiterdreht. Fest statt aus der Radbreite gerechnet: Das
// Rad liegt in einer Zeile mit Uhrzeit und Knopf und ist schmal; die
// Fingerstrecke soll trotzdem für 12 Stunden angenehm kurz bleiben.
const DRAG_PX_PER_SLOT = 14;
// Ab dieser Fingerbewegung (px) gilt eine Berührung als Ziehen, nicht mehr als Antippen.
const TAP_MAX_MOVE_PX = 6;
const TAP_MAX_MS = 350;
// Auslauf: Das Rad rollt in dieser Zeitkonstante (ms) aus; das Ziel ist die
// Position, an der der Schwung ohne Reibung verbraucht wäre, aufgerundet auf
// einen ganzen Schritt. Eine große Zeitkonstante = langes Auslaufen.
const FLING_TAU_MS = 320;
// Schnelles Einrasten nach langsamem Loslassen, Antippen, Tasten, "Aktuell".
const SNAP_TAU_MS = 110;
// Unter dieser Geschwindigkeit (Schritte pro ms) gilt das Loslassen als
// "ohne Schwung".
const FLING_MIN_SPEED = 0.004;
// Obergrenze für den Schwung: Ein sehr schneller Wisch soll das Rad nicht über
// die ganzen 12 Stunden schleudern. 0,06 Schritte/ms ≙ höchstens rund 3 Stunden
// Auslauf (0,06 · 320 ms ≈ 19 Schritte).
const FLING_MAX_SPEED = 0.06;
// Aus den letzten Bewegungen der letzten so vielen ms wird die Geschwindigkeit
// beim Loslassen bestimmt.
const VELOCITY_WINDOW_MS = 90;

// --- Senkrechte Aufteilung (px) ---
const WHEEL_H = 52;
const CENTER_Y = 36; // Mitte des Farbstrichs
const STRIP_HALF = 9; // halbe Höhe des Farbstrichs in der Mitte des Rads
const STRIP_EDGE_FACTOR = 0.5; // Höhe am Rand relativ zur Mitte ("Walze")
const HOUR_TICK = 9;
const MINUTE_TICK = 5;
const TICK_GAP = 1.5;
const FRAME_TOP = 15;
const FRAME_BOTTOM = 49;
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
      // Wahrscheinliche Messfehler (siehe src/lib/plausibility.ts) zählen
      // nicht mit — ein eingefrorener Sturmwert soll den Strich nicht rot färben.
      if (s.q && s.q[idx] !== ".") continue;
      if (v !== null && v !== undefined) speeds.push(v);
    }
    if (speeds.length === 0) return null;
    speeds.sort((a, b) => a - b);
    return getWindColor(speeds[Math.floor((speeds.length - 1) * STRIP_QUANTILE)]);
  });
}

/** "14:40"; über Mitternacht hinweg zusätzlich der Wochentag. */
function formatSlotLabel(time: number, now: number): string {
  const date = new Date(time);
  const hhmm = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  // Ein 12-Stunden-Fenster reicht regelmäßig über Mitternacht. "23:50" allein
  // wäre dann zweideutig, deshalb der Wochentag davor.
  if (new Date(now).toDateString() === date.toDateString()) return hhmm;
  const weekday = date.toLocaleDateString("de-DE", { weekday: "short" });
  return `${weekday} ${hhmm}`;
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
  "flex h-10 shrink-0 items-center justify-center border border-black bg-white text-zinc-900 hover:bg-zinc-100 disabled:opacity-30 disabled:hover:bg-white dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800";

export default function TimeSlider({
  slots,
  selectedTime,
  onChange,
  status,
  stripColors,
  lastUpdated,
}: {
  /** Rasterzeitpunkte (Epoch-ms), aufsteigend; der letzte ist "jetzt". */
  slots: number[];
  /** Gewählter Zeitpunkt, null = aktuell. */
  selectedTime: number | null;
  onChange: (time: number | null) => void;
  status: TimelineStatus;
  /** Farbe je Rasterzeitpunkt (parallel zu slots), siehe buildStripColors. */
  stripColors: (string | null)[] | null;
  /** Zeitpunkt des letzten Abrufs der Live-Werte (null = noch keiner). */
  lastUpdated: Date | null;
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

  const wheelRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Position des Rads in Schritten (Kommazahl: zwischen zwei Schritten). Als
  // Ref UND als State: die Ref ist für die Bewegungsrechnung immer aktuell,
  // der State löst das Neuzeichnen aus.
  const posRef = useRef(index);
  const [pos, setPosState] = useState(index);
  const setPos = (value: number) => {
    posRef.current = value;
    setPosState(value);
  };

  const rafRef = useRef(0);
  // true, solange das Rad von selbst ausläuft/einrastet. Dann darf die
  // Angleichung an einen von außen geänderten Zeitpunkt (Effekt unten) nicht
  // dazwischenfunken.
  const animatingRef = useRef(false);
  const dragRef = useRef<{
    startX: number;
    startPos: number;
    startTime: number;
    moved: boolean;
    samples: { t: number; pos: number }[];
  } | null>(null);

  // Die jeweils neuesten Werte für Funktionen, die über mehrere Bilder laufen.
  const latest = useRef({ index, lastIndex, slots, onChange });
  useEffect(() => {
    latest.current = { index, lastIndex, slots, onChange };
  });

  // Schritt-Nummer → Zeitpunkt melden. Ganz vorne IST "jetzt" → null (aktuell).
  // Nur bei einer echten Änderung: Beim Drehen kommt das 60-mal pro Sekunde,
  // und jede Meldung lässt die Karte neu zeichnen.
  const report = (i: number) => {
    const { index: shown, lastIndex: last, slots: s, onChange: change } = latest.current;
    const clamped = Math.min(last, Math.max(0, i));
    if (clamped === shown) return;
    latest.current.index = clamped;
    change(clamped >= last ? null : s[clamped]);
  };

  // Rad sanft auf `target` (ganze Schritte) laufen lassen. `tau` bestimmt, wie
  // zügig (kleiner = schneller). Läuft auch den Auslauf nach dem Loslassen.
  const animateTo = (target: number, tau: number) => {
    cancelAnimationFrame(rafRef.current);
    animatingRef.current = true;
    let last = performance.now();
    const step = (time: number) => {
      const dt = Math.min(48, time - last);
      last = time;
      const from = posRef.current;
      const next = from + (target - from) * (1 - Math.exp(-dt / tau));
      if (Math.abs(target - next) < 0.02) {
        setPos(target);
        report(target);
        animatingRef.current = false;
        return;
      }
      setPos(next);
      report(Math.round(next));
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };
  const clampPos = (value: number) => Math.min(latest.current.lastIndex, Math.max(0, value));
  const goTo = (i: number, tau = SNAP_TAU_MS) => animateTo(clampPos(Math.round(i)), tau);

  // Kommt der Zeitpunkt von AUSSEN (Knopf "Aktuell" im Refresh, oder die
  // Slot-Liste rückt nach 10 min weiter), das Rad nachdrehen. Beim eigenen
  // Drehen stimmt die Position schon (und animatingRef/dragRef sind gesetzt).
  useEffect(() => {
    if (dragRef.current || animatingRef.current) return;
    if (Math.round(posRef.current) !== index) goTo(index, 160);
    // goTo/animateTo lesen nur Refs und brauchen deshalb nicht in die Liste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Breite beobachten (Handy drehen, Fenster ändern).
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // --- Rad-Geometrie aus der Breite ---
  // Radius so, dass der Rand der Anzeige genau bei MAX_ANGLE liegt.
  const cx = width / 2;
  const radius = width > 0 ? (cx - 2) / Math.sin(MAX_ANGLE) : 1;
  // Abstand zweier Striche in der Mitte (px) — Maß für Ziehen und Rahmenbreite.
  const stepPx = radius * ANGLE_PER_SLOT;

  // --- Bedienung mit Finger/Maus ---
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cancelAnimationFrame(rafRef.current);
    animatingRef.current = false;
    // Das Rad wird sofort auf die gerade angezeigte Stelle "festgehalten".
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = performance.now();
    dragRef.current = {
      startX: e.clientX,
      startPos: posRef.current,
      startTime: t,
      moved: false,
      samples: [{ t, pos: posRef.current }],
    };
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || stepPx <= 0) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < TAP_MAX_MOVE_PX) return;
    drag.moved = true;
    // Nach rechts ziehen = zurück in der Zeit (kleinere Schritt-Nummer).
    const next = clampPos(drag.startPos - dx / DRAG_PX_PER_SLOT);
    const t = performance.now();
    drag.samples.push({ t, pos: next });
    while (drag.samples.length > 2 && t - drag.samples[0].t > VELOCITY_WINDOW_MS) {
      drag.samples.shift();
    }
    setPos(next);
    report(Math.round(next));
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const t = performance.now();
    if (!drag.moved) {
      // Antippen: zu der angetippten Stelle drehen. Umkehrung der Rad-Formel
      // x = Mitte + Radius · sin(Winkel).
      if (t - drag.startTime > TAP_MAX_MS || !wheelRef.current) return;
      const rect = wheelRef.current.getBoundingClientRect();
      const offset = (e.clientX - rect.left - cx) / radius;
      const angle = Math.asin(Math.min(1, Math.max(-1, offset)));
      goTo(posRef.current + angle / ANGLE_PER_SLOT);
      return;
    }
    // Schwung aus den letzten Bewegungen (Schritte pro ms). Hat der Finger vor
    // dem Loslassen kurz gestanden, gibt es keinen Schwung.
    const first = drag.samples[0];
    const lastSample = drag.samples[drag.samples.length - 1];
    const span = lastSample.t - first.t;
    const fresh = t - lastSample.t <= VELOCITY_WINDOW_MS;
    const speed = fresh && span > 0 ? (lastSample.pos - first.pos) / span : 0;
    if (Math.abs(speed) >= FLING_MIN_SPEED) {
      const capped = Math.sign(speed) * Math.min(FLING_MAX_SPEED, Math.abs(speed));
      goTo(posRef.current + capped * FLING_TAU_MS, FLING_TAU_MS);
    } else {
      goTo(posRef.current);
    }
  };
  const handlePointerCancel = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    goTo(posRef.current);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const here = Math.round(posRef.current);
    if (e.key === "ArrowLeft") goTo(here - 1);
    else if (e.key === "ArrowRight") goTo(here + 1);
    else if (e.key === "Home") goTo(0, 160);
    else if (e.key === "End") goTo(lastIndex, 160);
    else return;
    e.preventDefault();
  };

  // --- Rad zeichnen ---
  // Nur die Schritte nahe der Mitte (±MAX_ANGLE) kommen überhaupt in Frage.
  const visibleSlots = Math.ceil(MAX_ANGLE / ANGLE_PER_SLOT) + 1;
  const firstSlot = Math.max(0, Math.floor(pos) - visibleSlots);
  const lastSlot = Math.min(lastIndex, Math.ceil(pos) + visibleSlots);
  // Waagrechte Lage und "Dicke" des Rads bei einem Winkel (Bogenmaß von der Mitte).
  const xAt = (angle: number) => cx + radius * Math.sin(angle);
  const halfAt = (angle: number) =>
    STRIP_HALF * (STRIP_EDGE_FACTOR + (1 - STRIP_EDGE_FACTOR) * Math.cos(angle));
  const clampAngle = (angle: number) => Math.min(MAX_ANGLE, Math.max(-MAX_ANGLE, angle));

  const strips: React.ReactNode[] = [];
  const marks: React.ReactNode[] = [];
  if (width > 0) {
    for (let i = firstSlot; i <= lastSlot; i++) {
      const centerAngle = (i - pos) * ANGLE_PER_SLOT;
      // Farbstrich: Viereck zwischen den halben Schritten links und rechts,
      // an den Rändern der Sichtbarkeit abgeschnitten.
      const a = clampAngle(centerAngle - ANGLE_PER_SLOT / 2);
      const b = clampAngle(centerAngle + ANGLE_PER_SLOT / 2);
      if (b > a) {
        const xa = xAt(a);
        const xb = xAt(b);
        const ha = halfAt(a);
        const hb = halfAt(b);
        const fill = stripColors?.[i] ?? STRIP_EMPTY;
        strips.push(
          <polygon
            key={slots[i]}
            points={`${xa},${CENTER_Y - ha} ${xb},${CENTER_Y - hb} ${xb},${CENTER_Y + hb} ${xa},${CENTER_Y + ha}`}
            fill={fill}
            stroke={fill}
            strokeWidth={0.6}
          />,
        );
      }
      // Striche und Stundenzahlen: nur im sichtbaren Bereich.
      if (Math.abs(centerAngle) > MAX_ANGLE) continue;
      const date = new Date(slots[i]);
      const hour = date.getMinutes() === 0;
      const depth = Math.cos(centerAngle); // 1 in der Mitte, → 0 am Rand
      const x = xAt(centerAngle);
      const bottom = CENTER_Y - halfAt(centerAngle) - TICK_GAP;
      const length = (hour ? HOUR_TICK : MINUTE_TICK) * (0.4 + 0.6 * depth);
      marks.push(
        <line
          key={`t-${slots[i]}`}
          x1={x}
          x2={x}
          y1={bottom}
          y2={bottom - length}
          stroke={hour ? "#52525b" : "#a1a1aa"}
          strokeWidth={hour ? 1.4 : 1}
          strokeOpacity={0.3 + 0.7 * depth}
        />,
      );
      if (hour && depth > 0.3) {
        marks.push(
          <text
            key={`l-${slots[i]}`}
            x={x}
            y={bottom - length - 3}
            textAnchor="middle"
            fontSize={11 * (0.65 + 0.35 * depth)}
            fillOpacity={depth * depth}
            className="fill-zinc-600 tabular-nums dark:fill-zinc-300"
          >
            {formatHourLabel(date)}
          </text>,
        );
      }
    }
  }

  // Datum (Wochentag, Tag.Monat.) und Uhrzeit des gewählten Schritts, links.
  const shown = new Date(slots[index]);
  const dateText = `${shown.toLocaleDateString("de-DE", { weekday: "short" })} ${String(shown.getDate()).padStart(2, "0")}.${String(shown.getMonth() + 1).padStart(2, "0")}.`;
  const timeText = shown.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  return (
    // Unterstes Element der Seite: der zusätzliche untere Innenabstand hält
    // alles über dem Bedienbalken, den iPhones unten einblenden (auf anderen
    // Geräten ist env(...) gleich 0).
    // ALLES IN EINER ZEILE (Wunsch des Projektbesitzers): links Datum und
    // Uhrzeit, in der Mitte das Rad, rechts der Knopf "Aktuell". Die Zeile
    // liegt bewusst mit etwas Abstand zum Seitenrand unten: Am unteren
    // iPhone-Rand löst die Wischgeste (Home-Leiste) sonst das Verschieben der
    // Seite aus, wenn man am Rad zieht.
    <div className="shrink-0 border-t border-zinc-200 bg-white pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 px-2">
        <div className="w-[68px] shrink-0 leading-tight tabular-nums" aria-live="off">
          {status === "error" ? (
            <div className="text-[11px] text-red-600 dark:text-red-400">Kein Verlauf</div>
          ) : (
            <div className="text-[11px] whitespace-nowrap text-zinc-500 dark:text-zinc-400">{dateText}</div>
          )}
          <div className="text-base font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-50">
            {timeText}
          </div>
        </div>
        <div
          ref={wheelRef}
          className="zeitband relative min-w-0 flex-1"
          style={{ height: WHEEL_H }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          role="slider"
          aria-label="Zeitpunkt der Karte (Rad drehen)"
          aria-valuemin={0}
          aria-valuemax={lastIndex}
          aria-valuenow={index}
          aria-valuetext={current ? "Aktuell" : `${formatSlotLabel(slots[index], now)} Uhr`}
        >
          {width > 0 && (
            <svg width={width} height={WHEEL_H} aria-hidden="true" className="block">
              <defs>
                {/* Weiche Ränder: Dort "kippt" das Rad weg. */}
                <linearGradient id="zeitrad-rand-links" x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" className="dark:[stop-color:#18181b]" />
                  <stop offset="1" stopColor="#ffffff" stopOpacity="0" className="dark:[stop-color:#18181b]" />
                </linearGradient>
                <linearGradient id="zeitrad-rand-rechts" x1="1" x2="0" y1="0" y2="0">
                  <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" className="dark:[stop-color:#18181b]" />
                  <stop offset="1" stopColor="#ffffff" stopOpacity="0" className="dark:[stop-color:#18181b]" />
                </linearGradient>
              </defs>
              {strips}
              {marks}
              <rect x={0} y={0} width={width * 0.24} height={WHEEL_H} fill="url(#zeitrad-rand-links)" />
              <rect x={width * 0.76} y={0} width={width * 0.24} height={WHEEL_H} fill="url(#zeitrad-rand-rechts)" />
              {/* Fester Rahmen in der Mitte: der Zeitpunkt darin gilt. Weißer
                  Rand darunter, damit er auch auf rotem Farbstrich klar bleibt. */}
              <rect
                x={cx - stepPx / 2 - 1}
                y={FRAME_TOP}
                width={stepPx + 2}
                height={FRAME_BOTTOM - FRAME_TOP}
                fill="none"
                strokeWidth={5}
                className="stroke-white dark:stroke-zinc-900"
              />
              <rect
                x={cx - stepPx / 2 - 1}
                y={FRAME_TOP}
                width={stepPx + 2}
                height={FRAME_BOTTOM - FRAME_TOP}
                fill="none"
                strokeWidth={2}
                className="stroke-zinc-900 dark:stroke-zinc-100"
              />
            </svg>
          )}
        </div>
        <button
          type="button"
          onClick={() => goTo(lastIndex, 160)}
          disabled={current}
          className={`${BUTTON_CLASS} px-2.5 text-sm font-medium`}
        >
          Aktuell
        </button>
      </div>
      {/* "Zuletzt aktualisiert" mittig unter dem Rad (früher als Plakette auf
          der Karte). Zusammen mit dem größeren unteren Abstand hebt es das
          Rad um rund 25 px vom Seitenrand weg (Wunsch des Projektbesitzers,
          wegen der iPhone-Wischgeste unten). */}
      <div className="mt-1.5 text-center text-[11px] leading-4 text-zinc-500 tabular-nums dark:text-zinc-400">
        {lastUpdated
          ? `Zuletzt aktualisiert: ${lastUpdated.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
          : "\u00A0"}
      </div>
    </div>
  );
}
