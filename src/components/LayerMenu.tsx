"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  KK7_SEASON_OPTIONS,
  KK7_TIME_OPTIONS,
  type Kk7Season,
  type Kk7TimeOfDay,
} from "@/lib/kk7";
import {
  ASPECT_COLORS,
  COMPASS_DIRECTIONS,
  TERRAIN_MIN_ZOOM,
  type CompassDirection,
} from "@/lib/terrain";

// Ebenen-Menü oben rechts im Titel-Balken der Hauptseite (Nov. 2026, Wunsch
// des Projektbesitzers): Knopf mit drei Strichen ("Sandwich-Knopf", wie die
// Menü-Taste im Flugmodus). Antippen klappt darunter die Ebenen auf — KK7-
// Thermikkarte und Kabel (Leitungen) ein/aus, eingeschaltet GELB wie im
// Flugmodus — und darunter die Quellen (footer, kommt aus WindApp). Ein Tipp
// auf eine Ebene schaltet um, das Menü bleibt offen; zu geht es mit einem
// Tipp daneben oder der Escape-Taste.
//
// Ist KK7 an, stehen darunter zwei Auswahlreihen für Jahreszeit und Tageszeit
// (Nov. 2026, Wunsch des Projektbesitzers; nur hier, im Flugmodus bleibt KK7
// automatisch). "Automatisch" = wie im Flugmodus nach Datum und Uhrzeit.
//
// Dazu seit Nov. 2026 (Wunsch des Projektbesitzers) die Gelände-Ebenen:
// "Hangausrichtung" (Farben wie im Wolkenatlas, kleine Legenden-Rose darunter)
// und "Windrose / Lee-Hänge" — blendet die Windrose auf der Karte ein
// (WindRosePicker), mit der man die Windrichtung wählt; die Hänge im Lee
// werden dann rot. Gerechnet in src/components/terrain.ts.
//
// Darunter seit Nov. 2026 die Föhn-Linie (Druckdifferenz der Flughäfen Bozen
// und Innsbruck, src/components/pressure.ts) — als einzige Ebene von Haus aus
// an, weil sie klein ist und die Windkarte kaum verändert.
//
// Ganz oben lässt sich seit Nov. 2026 auch der Zeitbalken (Zeitrad unten)
// ausblenden (Wunsch des Projektbesitzers); WindApp zeigt dann nur die
// aktuellen Werte.
//
// Der Stationsfilter steht seit Nov. 2026 wieder oben mittig auf der Karte
// (StationFilterPicker in WindMap), nicht mehr hier.

export type MainLayers = {
  /**
   * Zeitbalken (Zeitrad unten) sichtbar (Nov. 2026, Wunsch des
   * Projektbesitzers). Von Haus aus an; aus = Karte zeigt nur die aktuellen
   * Werte, unten ist frei.
   */
  timeSlider: boolean;
  /** KK7-Thermikkarte (src/components/flight/kk7.ts). */
  kk7: boolean;
  /** Kabel = Luftfahrthindernisse (src/components/flight/cables.ts). */
  cables: boolean;
  /**
   * Föhn-Linie Innsbruck–Bozen mit der Druckdifferenz der Flughäfen
   * (src/components/pressure.ts, Nov. 2026). Von Haus aus an.
   */
  foehn: boolean;
  /** Von Hand gewählte Jahres- und Tageszeit der KK7-Karte (src/lib/kk7.ts). */
  kk7Season: Kk7Season;
  kk7Time: Kk7TimeOfDay;
  /** Hangausrichtung (src/components/terrain.ts). */
  aspect: boolean;
  /** Windrose auf der Karte ein-/ausgeblendet (WindRosePicker). */
  windRose: boolean;
  /** In der Windrose gewählte Richtung ("Wind aus …"); null = keine. */
  leeFrom: CompassDirection | null;
};

type LayerSwitch = "timeSlider" | "foehn" | "kk7" | "cables" | "aspect" | "windRose";

const LAYER_ENTRIES: { key: LayerSwitch; label: string; note?: string }[] = [
  // Kein Kartenbild, aber ebenfalls etwas, das man ein- und ausblendet —
  // darum hier ganz oben (Wunsch des Projektbesitzers, Nov. 2026).
  { key: "timeSlider", label: "Zeitbalken", note: "Zeitrad unten, 48 h zurückblättern" },
  // Föhn-Anzeige (Nov. 2026, Wunsch des Projektbesitzers): Linie mit der
  // Druckdifferenz der Flughäfen Bozen und Innsbruck.
  { key: "foehn", label: "Föhn (Druck BZ–IBK)", note: "Druckdifferenz der Flughäfen, antippen für Verlauf" },
  { key: "kk7", label: "KK7-Thermikkarte" },
  // Kabel gibt es nur in Südtirol und erst ab Zoom 11 (CABLE_MIN_ZOOM).
  { key: "cables", label: "Leitungen / Kabel", note: "nur Südtirol, ab Zoomstufe 11" },
  // Gelände-Ebenen (Nov. 2026): erst ab der Startansicht Südtirol.
  { key: "aspect", label: "Hangausrichtung", note: `ab Zoomstufe ${TERRAIN_MIN_ZOOM}` },
  {
    key: "windRose",
    label: "Windrose / Lee-Hänge",
    note: "Windrichtung wählen, Lee-Hänge rot",
  },
];

export default function LayerMenu({
  layers,
  onChange,
  footer,
}: {
  layers: MainLayers;
  /** Geänderte Felder (Ein/Aus oder KK7-Auswahl). */
  onChange: (patch: Partial<MainLayers>) => void;
  /** Inhalt unter den Ebenen (Quellenangaben). */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Zuklappen bei einem Tipp außerhalb ("pointerdown" deckt Maus und Touch
  // ab) und mit der Escape-Taste — wie beim Stationsfilter.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {/* Eckig, schwarzer Rahmen, weiß — wie das Filter-Schild. Feste Größe,
          damit der Titel daneben immer an derselben Stelle steht. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Ebenen und Quellen"
        title="Ebenen"
        className={`flex h-9 w-9 items-center justify-center border border-black text-zinc-900 shadow-sm ${
          open ? "bg-amber-300" : "bg-white hover:bg-zinc-100"
        }`}
      >
        {/* Drei Striche mit geraden Enden wie die Menü-Taste im Flugmodus. */}
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 5 H21 M3 12 H21 M3 19 H21" stroke="currentColor" strokeWidth="2.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-[1100] mt-1 max-h-[calc(100dvh-5rem)] w-64 overflow-y-auto border border-black/10 bg-white p-2 text-left shadow-lg">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
            Ebenen
          </p>
          <ul aria-label="Ebenen" className="flex flex-col gap-1.5">
            {LAYER_ENTRIES.map((entry) => {
              const active = layers[entry.key];
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChange({ [entry.key]: !active })}
                    className={`flex w-full items-center justify-between gap-2 border px-2 py-1.5 text-left text-xs font-medium transition-colors ${
                      active
                        ? "border-black bg-amber-300 text-zinc-900"
                        : "border-black/10 bg-white text-zinc-700 hover:bg-zinc-100"
                    }`}
                  >
                    <span>
                      {entry.label}
                      {entry.note && (
                        <span className="block text-[10px] font-normal text-zinc-500">
                          {entry.note}
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] font-bold">{active ? "AN" : "AUS"}</span>
                  </button>
                  {entry.key === "aspect" && active && <AspectLegend />}
                  {entry.key === "kk7" && active && (
                    <div className="mt-1.5 mb-1 flex flex-col gap-1.5 pl-1">
                      <ChoiceRow
                        title="Jahreszeit"
                        options={KK7_SEASON_OPTIONS}
                        value={layers.kk7Season}
                        onSelect={(kk7Season) => onChange({ kk7Season })}
                      />
                      <ChoiceRow
                        title="Tageszeit"
                        options={KK7_TIME_OPTIONS}
                        value={layers.kk7Time}
                        onSelect={(kk7Time) => onChange({ kk7Time })}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {footer}
        </div>
      )}
    </div>
  );
}

// Eine Auswahlreihe (Jahreszeit bzw. Tageszeit) unter KK7: kleine Knöpfe,
// der gewählte gelb wie alles Eingeschaltete.
function ChoiceRow<T extends string>({
  title,
  options,
  value,
  onSelect,
}: {
  title: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold text-zinc-500">{title}</p>
      <div role="group" aria-label={title} className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(option.value)}
              className={`border px-1.5 py-1 text-[11px] font-medium ${
                active
                  ? "border-black bg-amber-300 text-zinc-900"
                  : "border-black/10 bg-white text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Legende der Hangausrichtung: kleine Rose in den Farben der Ebene, wie im
// Wolkenatlas. Nur N, O, S und W beschriftet, damit die Schrift lesbar bleibt;
// auf dunklen Feldern weiß. Zeigt, wohin ein Hang ABFÄLLT.
function AspectLegend() {
  const center = 50;
  const outer = 48;
  const inner = 12;
  const point = (deg: number, radius: number) => {
    const rad = (deg * Math.PI) / 180;
    return [center + radius * Math.sin(rad), center - radius * Math.cos(rad)];
  };
  const isDark = ([r, g, b]: [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b < 110;
  return (
    <div className="mt-1.5 mb-1 flex items-center gap-2 pl-1">
      <svg width="84" height="84" viewBox="0 0 100 100" aria-hidden="true" className="shrink-0">
        {COMPASS_DIRECTIONS.map((direction, index) => {
          const [x1, y1] = point(index * 45 - 22.5, inner);
          const [x2, y2] = point(index * 45 - 22.5, outer);
          const [x3, y3] = point(index * 45 + 22.5, outer);
          const [x4, y4] = point(index * 45 + 22.5, inner);
          const [tx, ty] = point(index * 45, (outer + inner) / 2);
          const rgb = ASPECT_COLORS[direction];
          return (
            <g key={direction}>
              <path
                d={`M${x1} ${y1}L${x2} ${y2}A${outer} ${outer} 0 0 1 ${x3} ${y3}L${x4} ${y4}A${inner} ${inner} 0 0 0 ${x1} ${y1}Z`}
                fill={`rgb(${rgb.join(",")})`}
                fillOpacity={0.85}
                stroke="#a1a1aa"
                strokeWidth={1}
              />
              {index % 2 === 0 && (
                <text
                  x={tx}
                  y={ty}
                  dy=".35em"
                  textAnchor="middle"
                  fontSize={14}
                  fontWeight={700}
                  fill={isDark(rgb) ? "#ffffff" : "#18181b"}
                >
                  {direction}
                </text>
              )}
            </g>
          );
        })}
        <circle cx={center} cy={center} r={inner} fill="#ffffff" stroke="#a1a1aa" strokeWidth={1} />
      </svg>
      <p className="text-[10px] leading-snug text-zinc-500">
        Farbe = Richtung, in die der Hang abfällt. Flache Stellen bleiben frei.
      </p>
    </div>
  );
}
