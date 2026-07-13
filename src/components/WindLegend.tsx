import { WIND_COLOR_SCALE } from "@/lib/wind";

const BAND_HEIGHT = 20; // px
const BAND_WIDTH = 22; // px

// Legende der Windfarbskala (km/h), von der höchsten zur niedrigsten Stufe
// gestapelt, analog zur XC-Therm-Skala.
export default function WindLegend() {
  const bands = [...WIND_COLOR_SCALE].reverse();
  const totalHeight = bands.length * BAND_HEIGHT;

  return (
    <div className="absolute bottom-4 right-4 z-[1000] rounded-md bg-white/90 px-2 py-2 text-xs text-zinc-700 shadow-lg dark:bg-zinc-900/85 dark:text-zinc-100">
      <p className="mb-1 text-center font-semibold">km/h</p>
      <div className="relative flex" style={{ height: totalHeight }}>
        <div
          className="flex flex-col overflow-hidden rounded-sm border border-black/10"
          style={{ width: BAND_WIDTH }}
        >
          {bands.map((band) => (
            <div
              key={band.label}
              style={{ height: BAND_HEIGHT, backgroundColor: band.color }}
            />
          ))}
        </div>
        <div className="relative ml-1 w-6">
          <span className="absolute -translate-y-1/2 tabular-nums" style={{ top: 0 }}>
            +
          </span>
          {bands.map((band, i) => (
            <span
              key={band.label}
              className="absolute -translate-y-1/2 tabular-nums"
              style={{ top: (i + 1) * BAND_HEIGHT }}
            >
              {band.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
