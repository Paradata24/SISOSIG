"use client";

import dynamic from "next/dynamic";
import type { BaseLayer, StationFilter, TimelineFrame, TimelinePayload } from "@/lib/wind";

const WindMap = dynamic(() => import("@/components/WindMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-zinc-500 dark:text-zinc-400">
      Karte wird geladen…
    </div>
  ),
});

export default function WindMapLoader({
  baseLayer,
  stationFilter,
  onStationFilterChange,
  historyFrame,
  timeline,
  refreshToken,
  onViewportStationsChange,
  selectedStationCode,
  onSelectStation,
  onDataLoaded,
  flightMode,
  lastUpdated,
  onExitFlightMode,
}: {
  baseLayer: BaseLayer;
  stationFilter: StationFilter;
  /** Stationsfilter umschalten (Filter-Schild auf der Karte), siehe WindMap. */
  onStationFilterChange: (filter: StationFilter) => void;
  /** Gewählter Verlaufs-Zeitpunkt aus dem Zeitbalken; null = Live-Werte. */
  historyFrame: TimelineFrame | null;
  /** Verlauf aller Stationen (für die Messfehler-Prüfung der Live-Werte), siehe WindMap. */
  timeline: TimelinePayload | null;
  /** Zähler des Refresh-Buttons, siehe WindMap. */
  refreshToken: number;
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
}) {
  return (
    <WindMap
      baseLayer={baseLayer}
      stationFilter={stationFilter}
      onStationFilterChange={onStationFilterChange}
      historyFrame={historyFrame}
      timeline={timeline}
      refreshToken={refreshToken}
      onViewportStationsChange={onViewportStationsChange}
      selectedStationCode={selectedStationCode}
      onSelectStation={onSelectStation}
      onDataLoaded={onDataLoaded}
      flightMode={flightMode}
      lastUpdated={lastUpdated}
      onExitFlightMode={onExitFlightMode}
    />
  );
}
