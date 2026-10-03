"use client";

import dynamic from "next/dynamic";
import type { BaseLayer, StationFilter, TimelineFrame } from "@/lib/wind";

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
  historyFrame,
  refreshToken,
  onViewportStationsChange,
  selectedStationCode,
  onSelectStation,
}: {
  baseLayer: BaseLayer;
  stationFilter: StationFilter;
  /** Gewählter Verlaufs-Zeitpunkt aus dem Zeitbalken; null = Live-Werte. */
  historyFrame: TimelineFrame | null;
  /** Zähler des Refresh-Buttons, siehe WindMap. */
  refreshToken: number;
  /** Meldet die Stationscodes im sichtbaren Kartenausschnitt, siehe WindMap. */
  onViewportStationsChange: (codes: string[]) => void;
  /** Geöffnete Station (null = keine), siehe WindMap. */
  selectedStationCode: string | null;
  onSelectStation: (stationCode: string | null) => void;
}) {
  return (
    <WindMap
      baseLayer={baseLayer}
      stationFilter={stationFilter}
      historyFrame={historyFrame}
      refreshToken={refreshToken}
      onViewportStationsChange={onViewportStationsChange}
      selectedStationCode={selectedStationCode}
      onSelectStation={onSelectStation}
    />
  );
}
