"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Ebenen-Menü oben rechts im Titel-Balken der Hauptseite (Nov. 2026, Wunsch
// des Projektbesitzers): Knopf mit drei Strichen ("Sandwich-Knopf", wie die
// Menü-Taste im Flugmodus). Antippen klappt darunter die Ebenen auf — KK7-
// Thermikkarte und Kabel (Leitungen) ein/aus, eingeschaltet GELB wie im
// Flugmodus — und darunter die Quellen (footer, kommt aus WindApp). Ein Tipp
// auf eine Ebene schaltet um, das Menü bleibt offen; zu geht es mit einem
// Tipp daneben oder der Escape-Taste.
//
// Der Stationsfilter steht seit Nov. 2026 wieder oben mittig auf der Karte
// (StationFilterPicker in WindMap), nicht mehr hier.

export type MainLayers = {
  /** KK7-Thermikkarte (src/components/flight/kk7.ts). */
  kk7: boolean;
  /** Kabel = Luftfahrthindernisse (src/components/flight/cables.ts). */
  cables: boolean;
};

const LAYER_ENTRIES: { key: keyof MainLayers; label: string; note?: string }[] = [
  { key: "kk7", label: "KK7-Thermikkarte" },
  // Kabel gibt es nur in Südtirol und erst ab Zoom 11 (CABLE_MIN_ZOOM).
  { key: "cables", label: "Leitungen / Kabel", note: "nur Südtirol, ab Zoomstufe 11" },
];

export default function LayerMenu({
  layers,
  onToggle,
  footer,
}: {
  layers: MainLayers;
  onToggle: (key: keyof MainLayers) => void;
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
        <div className="absolute top-full right-0 z-[1100] mt-1 w-56 border border-black/10 bg-white p-2 text-left shadow-lg">
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
                    onClick={() => onToggle(entry.key)}
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
