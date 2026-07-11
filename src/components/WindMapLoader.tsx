"use client";

import dynamic from "next/dynamic";

const WindMap = dynamic(() => import("@/components/WindMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-zinc-500">
      Karte wird geladen…
    </div>
  ),
});

export default function WindMapLoader() {
  return <WindMap />;
}
