"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  getStationFilterLabel,
  getStationFilterMapLabel,
  STATION_FILTER_ORDER,
  type StationFilter,
} from "@/lib/wind";

// Filter-Schild — zugleich der Schalter für den Stationsfilter (Wunsch des
// Projektbesitzers, Okt. 2026): Antippen klappt darunter die Liste aller
// Filter auf, ein Tipp auf einen Eintrag schaltet um und klappt wieder zu.
//
// Auf der Hauptseite steht das Schild oben rechts im Titel-Balken, an der
// Stelle des früheren Menü-Knopfs (3 Linien); unter der Filterliste stehen
// dort die Quellen (footer, kommt aus WindApp). Im Flugmodus gibt es keinen
// Titel-Balken, dort steht das Schild wie bisher oben mittig auf der Karte
// (WindMap).
//
// Das Schild selbst zeigt den aktiven Filter immer in Großbuchstaben (auch
// "ALLE"), die aufgeklappte Liste die normale Schreibweise — beides aus
// wind.ts, damit Reihenfolge, Beschriftung und Filterlogik beisammenbleiben.
export default function StationFilterPicker({
  value,
  onChange,
  align = "center",
  tall = false,
  footer,
}: {
  value: StationFilter;
  onChange: (filter: StationFilter) => void;
  /** Liste mittig unter dem Schild (Karte) oder rechtsbündig (Titel-Balken). */
  align?: "center" | "right";
  /** Gleiche Höhe wie die Knöpfe im Titel-Balken (36 px). */
  tall?: boolean;
  /** Zusätzlicher Inhalt unter der Filterliste (Quellen im Titel-Balken). */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Zuklappen bei einem Tipp außerhalb (wie früher beim Menü in
  // WindApp: "pointerdown" deckt Maus und Touch ab) und mit der Escape-Taste.
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
    // pointer-events-auto: Die umgebende Spalte in WindMap ist bewusst
    // durchlässig (Fehlermeldung), nur das Schild und die Liste fangen Tipps ab.
    <div ref={rootRef} className="pointer-events-auto relative">
      {/* Stil wie die Knöpfe im Titel-Balken (eckig, schwarzer Rahmen, weiß).
          Das kleine Dreieck zeigt, dass man das Schild antippen kann. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Stationsfilter: ${getStationFilterLabel(value)}`}
        className={`flex items-center gap-1.5 border border-black bg-white px-2 text-xs ${tall ? "h-9" : "py-0.5"} font-semibold tracking-wide whitespace-nowrap text-zinc-900 shadow-sm hover:bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800`}
      >
        {getStationFilterMapLabel(value)}
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M0 2h8L4 7z" fill="currentColor" />
        </svg>
      </button>
      {/* Die Liste liegt ÜBER der Karte (absolut), damit Schild und eine
          eventuelle Fehlermeldung darunter nicht verrutschen. Mittig unter dem
          Schild (Karte) bzw. rechtsbündig (Titel-Balken), immer eckig. */}
      {/* Einfache Knopf-Liste mit aria-pressed (wie früher im Menü) statt einer
          "listbox": Die verlangt eine eigene Pfeiltasten-Steuerung, und eine
          halbe Umsetzung ist für Bildschirmleser schlechter als gar keine. */}
      {open && (
        <div
          className={`absolute top-full z-[1100] mt-1 border border-black/10 bg-white p-2 text-left shadow-lg dark:border-white/10 dark:bg-zinc-800 ${
            align === "right" ? "right-0 w-52" : "left-1/2 w-44 -translate-x-1/2"
          }`}
        >
          <ul aria-label="Stationsfilter" className="flex flex-col gap-1.5">
            {STATION_FILTER_ORDER.map((filter) => {
              const active = filter === value;
              return (
                <li key={filter}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      onChange(filter);
                      setOpen(false);
                    }}
                    className={`w-full border px-2 py-1.5 text-left text-xs font-medium transition-colors ${
                      active
                        ? "border-emerald-700 bg-emerald-600 text-white dark:border-emerald-500"
                        : "border-black/10 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
                    }`}
                  >
                    {getStationFilterLabel(filter)}
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
