"use client";

import { useEffect, useRef, useState } from "react";
import {
  HIGH_ALTITUDE_THRESHOLD_M,
  VERY_HIGH_ALTITUDE_THRESHOLD_M,
  type BaseLayer,
  type StationFilter,
} from "@/lib/wind";
import WindMapLoader from "@/components/WindMapLoader";

// Titel-Balken + Karte. Der Menü-Button (3 Linien) sitzt ganz rechts im
// Balken und öffnet ein Popup, in dem Kartenhintergrund und Stationsfilter
// umgeschaltet werden. Der Zustand lebt hier (und nicht in WindMap), weil der
// Balken und die Karte getrennte Bereiche der Seite sind.
export default function WindApp() {
  const [baseLayer, setBaseLayer] = useState<BaseLayer>("relief");
  const [stationFilter, setStationFilter] = useState<StationFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Popup schließen, sobald außerhalb von Button/Popup geklickt (oder auf dem
  // Handy getippt) wird. "pointerdown" deckt Maus und Touch gemeinsam ab.
  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  function optionClass(active: boolean) {
    return `w-full border px-2 py-1.5 text-left text-xs font-medium transition-colors ${
      active
        ? "border-emerald-700 bg-emerald-600 text-white"
        : "border-black/10 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
    }`;
  }

  return (
    <>
      <header className="relative border-b border-zinc-200 bg-white px-4 py-3 text-center dark:border-zinc-800 dark:bg-black">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Should I stay or should I go
        </h1>
        <div ref={menuRef} className="absolute top-1/2 right-3 z-[1100] -translate-y-1/2">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menü"
            aria-expanded={menuOpen}
            className="flex h-9 w-9 items-center justify-center border border-black bg-white"
          >
            {/* 3 horizontale schwarze Linien, bewusst mit geraden Enden (nicht abgerundet) */}
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2" y="4" width="16" height="2" fill="#000000" />
              <rect x="2" y="9" width="16" height="2" fill="#000000" />
              <rect x="2" y="14" width="16" height="2" fill="#000000" />
            </svg>
          </button>
          {/* -right-3 gleicht den right-3-Abstand des Buttons aus, damit das
              Popup bündig am rechten Bildschirmrand anliegt. Bewusst ohne
              abgerundete Ecken, passend zum eckigen Menü-Button. */}
          {menuOpen && (
            <div className="absolute top-full -right-3 mt-2 w-52 border border-black/10 bg-white p-3 text-left shadow-lg dark:border-white/10 dark:bg-zinc-900">
              <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                Karte
              </p>
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => setBaseLayer("standard")}
                  aria-pressed={baseLayer === "standard"}
                  className={optionClass(baseLayer === "standard")}
                >
                  Standard
                </button>
                <button
                  type="button"
                  onClick={() => setBaseLayer("relief")}
                  aria-pressed={baseLayer === "relief"}
                  className={optionClass(baseLayer === "relief")}
                >
                  Relief (Grau)
                </button>
              </div>
              <p className="mt-3 mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                Stationen
              </p>
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => setStationFilter("all")}
                  aria-pressed={stationFilter === "all"}
                  className={optionClass(stationFilter === "all")}
                >
                  Alle
                </button>
                <button
                  type="button"
                  onClick={() => setStationFilter("windanzeiger")}
                  aria-pressed={stationFilter === "windanzeiger"}
                  className={optionClass(stationFilter === "windanzeiger")}
                >
                  Windanzeiger
                </button>
                <button
                  type="button"
                  onClick={() => setStationFilter("high")}
                  aria-pressed={stationFilter === "high"}
                  className={optionClass(stationFilter === "high")}
                >
                  Stationen &gt;{HIGH_ALTITUDE_THRESHOLD_M.toLocaleString("de-DE")}m
                </button>
                <button
                  type="button"
                  onClick={() => setStationFilter("veryHigh")}
                  aria-pressed={stationFilter === "veryHigh"}
                  className={optionClass(stationFilter === "veryHigh")}
                >
                  Stationen &gt;{VERY_HIGH_ALTITUDE_THRESHOLD_M.toLocaleString("de-DE")}m
                </button>
              </div>
            </div>
          )}
        </div>
      </header>
      <main className="flex-1">
        <WindMapLoader baseLayer={baseLayer} stationFilter={stationFilter} />
      </main>
    </>
  );
}
