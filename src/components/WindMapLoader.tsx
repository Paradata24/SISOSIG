"use client";

import dynamic from "next/dynamic";
import type { BaseLayer, StationFilter } from "@/lib/wind";

const WindMap = dynamic(() => import("@/components/WindMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-zinc-500">
      Karte wird geladen…
    </div>
  ),
});

export default function WindMapLoader({
  baseLayer,
  stationFilter,
}: {
  baseLayer: BaseLayer;
  stationFilter: StationFilter;
}) {
  return <WindMap baseLayer={baseLayer} stationFilter={stationFilter} />;
}
