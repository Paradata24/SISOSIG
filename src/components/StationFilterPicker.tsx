"use client";

import { useEffect, useRef, useState } from "react";
import {
  getStationFilterLabel,
  getStationFilterMapLabel,
  STATION_FILTER_ORDER,
  type StationFilter,
} from "@/lib/wind";

// Filter-Schild oben mittig auf der Karte — zugleich der Schalter für den
// Stationsfilter (Wunsch des Projektbesitzers, Okt. 2026): Antippen klappt
// darunter die Liste aller Filter auf, ein Tipp auf einen Eintrag schaltet um
// und klappt wieder zu. Früher stand die Auswahl im Menü im Titel-Balken; dort
// gibt es jetzt nur noch die Karte und die Quellen.
//
// Das Schild selbst zeigt den aktiven Filter immer in Großbuchstaben (auch
// "ALLE"), die aufgeklappte Liste die normale Schreibweise — beides aus
// wind.ts, damit Reihenfolge, Beschriftung und Filterlogik beisammenbleiben.
export default function StationFilterPicker({
  value,
  onChange,
}: {
  value: StationFilter;
  onChange: (filter: StationFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Zuklappen bei einem Tipp außerhalb (gleiches Vorgehen wie beim Menü in
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
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Stationsfilter: ${getStationFilterLabel(value)}`}
        className="flex items-center gap-1.5 border border-black bg-white px-2 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap text-zinc-900 shadow-sm hover:bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
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
          Schild, eckig wie das Menü-Popup. */}
      {open && (
        <ul
          role="listbox"
          aria-label="Stationsfilter"
          className="absolute top-full left-1/2 z-[1100] mt-1 flex w-44 -translate-x-1/2 flex-col gap-1.5 border border-black/10 bg-white p-2 shadow-lg dark:border-white/10 dark:bg-zinc-800"
        >
          {STATION_FILTER_ORDER.map((filter) => {
            const active = filter === value;
            return (
              <li key={filter}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
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
      )}
    </div>
  );
}
