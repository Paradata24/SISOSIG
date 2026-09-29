"use client";

import { useEffect, useRef, useState } from "react";
import { getWindColor, GRID_MS, type TimelinePayload } from "@/lib/wind";

// Zeitbalken unter der Karte.
//
// Aufbau (Sept. 2026, zweiter Umbau):
//  - oben eine Zeile mit Abspielknopf, Schritt-Knöpfen (± 10 min), der
//    gewählten Uhrzeit und dem Knopf "Aktuell"
//  - darunter die GANZEN 12 Stunden auf einen Blick: Uhrzeiten, Striche und
//    ein Farbstrich (je 10-Minuten-Schritt die Windfarbe der windigsten
//    Stationen im sichtbaren Kartenausschnitt, siehe buildStripColors).
//    Eine schwarze senkrechte Linie zeigt, welchen Zeitpunkt die Karte zeigt.
//
// Bedienung: Den Finger (oder die Maus) irgendwo auf das Band legen — die
// Linie springt genau dorthin — und ziehen. Die Stelle unter dem Finger IST
// der Zeitpunkt. Für einzelne 10-Minuten-Schritte die Knöpfe ◀ ▶.
//
// Warum nicht mehr "wischen" (erster Umbau, Sept. 2026)? Am Handy war das
// nicht benutzbar (Rückmeldung des Projektbesitzers):
//  - Das Band war nur 34 px hoch und zeigte nur ~2 Stunden; wo es windig
//    wurde, sah man erst nach langem Suchen.
//  - Ein Wisch glitt mit Schwung viele Schritte weiter, ein bestimmter
//    Zeitpunkt war kaum zu treffen, und "nach rechts wischen = zurück in der
//    Zeit" war verkehrt herum gedacht.
//  - Das Nachführen der Position kämpfte bei schnellem Wischen gegen den
//    Finger (Rucken).
// Deshalb jetzt: alles sichtbar, direkt antippen, ziehen ohne Schwung.
//
// Farben bewusst schwarz/grau wie der Menü-Knopf (kein Grün, Wunsch des
// Projektbesitzers). Der Zustand "jetzt" heißt überall "Aktuell" (nicht
// "Live"/"Jetzt", ebenfalls Wunsch des Projektbesitzers).

export type TimelineStatus = "idle" | "loading" | "ready" | "error";

// Tempo beim Abspielen: so lange steht jeder 10-Minuten-Schritt. 73 Schritte
// × 300 ms ≈ 22 s für die ganzen 12 Stunden.
const PLAY_STEP_MS = 300;
// Welcher Wert des Kartenausschnitts den Farbstrich bestimmt: 0,9 = die
// windigsten 10 % der Stationen. Der Mittelwert würde einen Föhndurchbruch in
// einem einzelnen Tal zwischen vielen ruhigen Stationen verschlucken, das
// Maximum dagegen jede einzelne Gipfelstation hervorheben.
const STRIP_QUANTILE = 0.9;
// Senkrechte Aufteilung des Bands (px). Das ganze Band (48 px, also gut
// fingerbreit) ist Tippfläche — nicht nur der Farbstrich.
const BAND_H = 48;
const LABEL_Y = 14; // Grundlinie der Uhrzeiten
const TICK_TOP = 20;
const STRIP_Y = 28;
const STRIP_H = 14;
// Innenabstand links/rechts (px): Die erste und letzte Uhrzeit sollen nicht
// am Bildschirmrand angeschnitten werden, und die Enden müssen mit dem
// Finger erreichbar bleiben.
const SIDE_PAD = 12;
// Alle wieviel Stunden eine Uhrzeit dasteht. Unter ~300 px Breite (sehr
// schmale Handys) nur alle 3 Stunden, sonst liefen die Zahlen ineinander.
const labelEveryHours = (width: number) => (width < 300 ? 3 : 2);
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

/** "vor 3 h 20 min" — wie weit der gewählte Zeitpunkt zurückliegt. */
function formatAgo(time: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `vor ${rest} min`;
  if (rest === 0) return `vor ${hours} h`;
  return `vor ${hours} h ${rest} min`;
}

// Knopf-Stil wie der Menü-Knopf im Titelbalken: eckig, schwarzer Rand.
// 40 px hoch, damit er am Handy sicher zu treffen ist.
const BUTTON_CLASS =
  "flex h-10 shrink-0 items-center justify-center border border-black bg-white text-zinc-900 hover:bg-zinc-100 disabled:opacity-30 disabled:hover:bg-white dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800";

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

  const bandRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Die jeweils neuesten Werte für den Abspiel-Takt, der nicht bei jedem
  // Schritt neu angemeldet werden soll.
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

  // Breite des Bands beobachten (Handy drehen, Fenster ändern).
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Position auf dem Band ↔ Schritt. Die Zeitachse läuft von SIDE_PAD bis
  // (Breite − SIDE_PAD); der Schritt ganz rechts ist "jetzt".
  const usable = Math.max(1, width - 2 * SIDE_PAD);
  const xOfIndex = (i: number) => SIDE_PAD + (lastIndex === 0 ? 0 : (i / lastIndex) * usable);
  const indexAtClientX = (clientX: number) => {
    const el = bandRef.current;
    if (!el) return index;
    const rect = el.getBoundingClientRect();
    return Math.round(((clientX - rect.left - SIDE_PAD) / usable) * lastIndex);
  };

  // Finger/Maus: Antippen setzt die Linie genau dorthin, Ziehen führt sie
  // mit. setPointerCapture sorgt dafür, dass das Ziehen auch weitergeht, wenn
  // der Finger dabei über das Band hinausrutscht. touch-action: none (siehe
  // .zeitband in globals.css) verhindert, dass der Browser die Geste als
  // Seiten-Scrollen oder Zurück-Wischen deutet.
  const draggingRef = useRef(false);
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    setPlaying(false);
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    select(indexAtClientX(e.clientX));
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const i = Math.min(lastIndex, Math.max(0, indexAtClientX(e.clientX)));
    // Nur bei einem echten Schrittwechsel melden — ein Finger zittert, und
    // jede Meldung lässt die Karte neu zeichnen.
    if (i !== latest.current.index) select(i);
  };
  const endDrag = () => {
    draggingRef.current = false;
  };

  const step = (delta: number) => {
    setPlaying(false);
    select(index + delta);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Home") step(-lastIndex);
    else if (e.key === "End") step(lastIndex);
    else return;
    e.preventDefault();
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
  const every = labelEveryHours(width);
  const hourMarks = slots
    .map((t, i) => ({ t, i, date: new Date(t) }))
    .filter(({ date }) => date.getMinutes() === 0);
  const stepWidth = lastIndex === 0 ? usable : usable / lastIndex;
  const markerX = xOfIndex(index);

  return (
    // Unterstes Element der Seite: der zusätzliche untere Innenabstand hält
    // alles über dem Bedienbalken, den iPhones unten einblenden (auf anderen
    // Geräten ist env(...) gleich 0).
    <div className="shrink-0 border-t border-zinc-200 bg-white pt-2 pb-[calc(0.25rem+env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-1.5 px-2">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Anhalten" : "Letzte 12 Stunden abspielen"}
          title={playing ? "Anhalten" : "Abspielen"}
          className={`${BUTTON_CLASS} w-10`}
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
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={index === 0}
          aria-label="10 Minuten zurück"
          title="10 Minuten zurück"
          className={`${BUTTON_CLASS} w-10`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
            <path d="M11 2 L4 8 L11 14 Z" />
          </svg>
        </button>

        {/* Gewählte Uhrzeit, mittig zwischen den Knöpfen. Zwei Zeilen: groß
            die Uhrzeit, klein darunter, wie lange das her ist. */}
        <div className="min-w-0 flex-1 text-center leading-tight tabular-nums" aria-live="polite">
          {status === "error" ? (
            <span className="text-xs text-red-600 dark:text-red-400">Verlauf nicht verfügbar</span>
          ) : current ? (
            <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Aktuell</span>
          ) : (
            <>
              <div className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
                {formatSlotLabel(slots[index], now)} Uhr
              </div>
              <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {formatAgo(slots[index], now)}
              </div>
            </>
          )}
          {status === "loading" && (
            <div className="truncate text-[11px] text-zinc-400">Verlauf wird geladen…</div>
          )}
        </div>

        <button
          type="button"
          onClick={() => step(1)}
          disabled={current}
          aria-label="10 Minuten vor"
          title="10 Minuten vor"
          className={`${BUTTON_CLASS} w-10`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
            <path d="M5 2 L12 8 L5 14 Z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            select(lastIndex);
          }}
          disabled={current && !playing}
          className={`${BUTTON_CLASS} px-2.5 text-sm font-medium`}
        >
          Aktuell
        </button>
      </div>

      <div
        ref={bandRef}
        className="zeitband mt-1.5"
        style={{ height: BAND_H }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="slider"
        aria-label="Zeitpunkt der Karte"
        aria-valuemin={0}
        aria-valuemax={lastIndex}
        aria-valuenow={index}
        aria-valuetext={current ? "Aktuell" : `${formatSlotLabel(slots[index], now)} Uhr`}
      >
        {width > 0 && (
          <svg width={width} height={BAND_H} aria-hidden="true" className="block">
            {/* Farbstrich: je Schritt die Windfarbe des Kartenausschnitts */}
            {slots.map((t, i) => (
              <rect
                key={t}
                x={xOfIndex(i) - stepWidth / 2}
                y={STRIP_Y}
                width={stepWidth + 0.5}
                height={STRIP_H}
                fill={stripColors?.[i] ?? STRIP_EMPTY}
              />
            ))}
            {/* Volle Stunden: Strich, und alle `every` Stunden die Uhrzeit */}
            {hourMarks.map(({ t, i, date }) => (
              <g key={`h-${t}`}>
                <line
                  x1={xOfIndex(i)}
                  x2={xOfIndex(i)}
                  y1={TICK_TOP}
                  y2={STRIP_Y}
                  className="stroke-zinc-400 dark:stroke-zinc-500"
                />
                {date.getHours() % every === 0 && (
                  <text
                    x={xOfIndex(i)}
                    y={LABEL_Y}
                    textAnchor="middle"
                    className="fill-zinc-500 text-[11px] tabular-nums dark:fill-zinc-400"
                  >
                    {String(date.getHours()).padStart(2, "0")}
                  </text>
                )}
              </g>
            ))}
            {/* Zeitmarke: schwarze Linie über das ganze Band, mit weißem Rand,
                damit sie auch auf rotem Farbstrich klar erkennbar bleibt. */}
            <line
              x1={markerX}
              x2={markerX}
              y1={TICK_TOP - 4}
              y2={BAND_H - 2}
              className="stroke-white dark:stroke-zinc-900"
              strokeWidth={5}
            />
            <line
              x1={markerX}
              x2={markerX}
              y1={TICK_TOP - 4}
              y2={BAND_H - 2}
              className="stroke-zinc-900 dark:stroke-zinc-100"
              strokeWidth={2.5}
            />
          </svg>
        )}
      </div>
    </div>
  );
}
