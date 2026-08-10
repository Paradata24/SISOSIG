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
}: {
  baseLayer: BaseLayer;
  stationFilter: StationFilter;
  /** Gewählter Verlaufs-Zeitpunkt aus dem Zeitbalken; null = Live-Werte. */
  historyFrame: TimelineFrame | null;
}) {
  return (
    <WindMap
      baseLayer={baseLayer}
      stationFilter={stationFilter}
      historyFrame={historyFrame}
    />
  );
}
