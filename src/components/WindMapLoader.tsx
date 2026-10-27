"use client";

import dynamic from "next/dynamic";
import type { StationFilter, TimelineFrame, TimelinePayload } from "@/lib/wind";

const WindMap = dynamic(() => import("@/components/WindMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-zinc-500 dark:text-zinc-400">
      Karte wird geladen…
    </div>
  ),
});

export default function WindMapLoader({
  stationFilter,
  onStationFilterChange,
  historyFrame,
  timeline,
  onViewportStationsChange,
  selectedStationCode,
  onSelectStation,
  onDataLoaded,
  flightMode,
  lastUpdated,
  onExitFlightMode,
  topInset,
}: {
  stationFilter: StationFilter;
  /** Stationsfilter umschalten (Filter-Schild auf der Karte), siehe WindMap. */
  onStationFilterChange: (filter: StationFilter) => void;
  /** Gewählter Verlaufs-Zeitpunkt aus dem Zeitbalken; null = Live-Werte. */
  historyFrame: TimelineFrame | null;
  /** Verlauf aller Stationen (für die Messfehler-Prüfung der Live-Werte), siehe WindMap. */
  timeline: TimelinePayload | null;
  /** Meldet die Stationscodes im sichtbaren Kartenausschnitt, siehe WindMap. */
  onViewportStationsChange: (codes: string[]) => void;
  /** Geöffnete Station (null = keine), siehe WindMap. */
  selectedStationCode: string | null;
  onSelectStation: (stationCode: string | null) => void;
  /** Zeitpunkt jedes erfolgreichen Abrufs der Live-Werte, siehe WindMap. */
  onDataLoaded: (time: Date) => void;
  /** Flugmodus an/aus und was er braucht, siehe WindMap/FlightMode. */
  flightMode: boolean;
  lastUpdated: Date | null;
  onExitFlightMode: () => void;
  /** Höhe des Titel-Balkens über der Karte (px), siehe WindMap. */
  topInset: number;
}) {
  return (
    <WindMap
      stationFilter={stationFilter}
      onStationFilterChange={onStationFilterChange}
      historyFrame={historyFrame}
      timeline={timeline}
      onViewportStationsChange={onViewportStationsChange}
      selectedStationCode={selectedStationCode}
      onSelectStation={onSelectStation}
      onDataLoaded={onDataLoaded}
      flightMode={flightMode}
      lastUpdated={lastUpdated}
      onExitFlightMode={onExitFlightMode}
      topInset={topInset}
    />
  );
}
