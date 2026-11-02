"use client";

import {
  COMPASS_DIRECTIONS,
  COMPASS_NAMES,
  LEE_COLOR,
  type CompassDirection,
} from "@/lib/terrain";

// Windrose auf der Karte der Hauptseite (Nov. 2026, Wunsch des
// Projektbesitzers): ein- und ausblendbar im Ebenen-Menü ("Windrose /
// Lee-Hänge"). Man tippt an, WOHER der Wind kommt (das Feld oben = Wind aus
// Nord); die Karte färbt dann alle Hänge rot halbtransparent, die vom Wind
// abgewandt im Lee liegen (Wind aus Ost → Westhänge; Rechnung in
// src/components/terrain.ts). Nochmals auf dasselbe Feld tippen hebt die Wahl
// auf. Das gewählte Feld ist im selben Rot wie die Lee-Hänge.

const SIZE = 112;
const CENTER = 50;
const OUTER = 48;
const INNER = 14;

function point(deg: number, radius: number): string {
  const rad = (deg * Math.PI) / 180;
  return `${(CENTER + radius * Math.sin(rad)).toFixed(1)} ${(CENTER - radius * Math.cos(rad)).toFixed(1)}`;
}

// Ein Tortenstück (45°) zwischen innerem und äußerem Kreis.
function sectorPath(index: number): string {
  const from = index * 45 - 22.5;
  const to = index * 45 + 22.5;
  return (
    `M${point(from, INNER)}L${point(from, OUTER)}` +
    `A${OUTER} ${OUTER} 0 0 1 ${point(to, OUTER)}` +
    `L${point(to, INNER)}A${INNER} ${INNER} 0 0 0 ${point(from, INNER)}Z`
  );
}

export default function WindRosePicker({
  value,
  onChange,
}: {
  /** Gewählte Windrichtung ("Wind aus …"); null = keine. */
  value: CompassDirection | null;
  onChange: (direction: CompassDirection | null) => void;
}) {
  const red = `rgb(${LEE_COLOR.join(",")})`;
  return (
    // pointer-events-auto: Die Spalte darum ist für die Karte durchlässig.
    // Eckig, schwarzer Rahmen, weiß — wie Filter-Schild und Ebenen-Knopf.
    <div className="pointer-events-auto border border-black bg-white/90 p-1 text-zinc-900 shadow-sm">
      <p className="text-center text-[10px] leading-tight font-semibold">
        {value ? `Wind aus ${COMPASS_NAMES[value]}` : "Wind aus …"}
      </p>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox="0 0 100 100"
        role="group"
        aria-label="Windrichtung wählen"
        className="block"
      >
        {COMPASS_DIRECTIONS.map((direction, index) => {
          const active = direction === value;
          const [tx, ty] = point(index * 45, (OUTER + INNER) / 2).split(" ");
          return (
            <g
              key={direction}
              role="button"
              aria-pressed={active}
              aria-label={`Wind aus ${COMPASS_NAMES[direction]}`}
              tabIndex={0}
              className="cursor-pointer outline-none"
              onClick={() => onChange(active ? null : direction)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onChange(active ? null : direction);
                }
              }}
            >
              <path
                d={sectorPath(index)}
                fill={active ? red : "#ffffff"}
                stroke="#18181b"
                strokeWidth="1"
                className={active ? undefined : "hover:fill-zinc-100"}
              />
              <text
                x={tx}
                y={ty}
                dy=".35em"
                textAnchor="middle"
                fontSize={direction.length > 1 ? 9 : 11}
                fontWeight={700}
                fill={active ? "#ffffff" : "#18181b"}
                pointerEvents="none"
              >
                {direction}
              </text>
            </g>
          );
        })}
        {/* Mitte: zeigt bei gewählter Richtung, wohin das Lee liegt
            (Pfeil in Windrichtung = vom Wind weg). */}
        <circle cx={CENTER} cy={CENTER} r={INNER} fill="#ffffff" stroke="#18181b" strokeWidth="1" />
        {value && (
          <path
            d="M50 40 L55 52 L50 49 L45 52 Z"
            fill={red}
            transform={`rotate(${COMPASS_DIRECTIONS.indexOf(value) * 45 + 180} 50 50)`}
            pointerEvents="none"
          />
        )}
      </svg>
      <p className="text-center text-[10px] leading-tight text-zinc-600">
        {value ? (
          <>
            <span className="mr-1 inline-block h-2 w-2 align-middle" style={{ background: red, opacity: 0.6 }} />
            Lee-Hänge
          </>
        ) : (
          "Richtung antippen"
        )}
      </p>
    </div>
  );
}
