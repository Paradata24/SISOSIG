"use client";

import { useEffect, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getWindColor, toCompassPoint, type WindStation } from "@/lib/wind";

const SOUTH_TYROL_CENTER: [number, number] = [46.5, 11.35];
const SOUTH_TYROL_ZOOM = 9;
const POLL_INTERVAL_MS = 300_000; // 5 Minuten

// Pfeil-Icon (SVG) für eine Windstation. Der Pfeil wird so gedreht, dass er
// dorthin zeigt, wohin der Wind weht (Windrichtung + 180°, da die Station
// die Richtung meldet, AUS der der Wind kommt). 44px Kantenlänge, damit die
// Marker auch auf Touchscreens gut antippbar sind.
function createWindIcon(direction: number | null, speedKmh: number | null) {
  const color = getWindColor(speedKmh);
  const rotation = direction !== null ? (direction + 180) % 360 : 0;

  const html = `
    <div style="transform: rotate(${rotation}deg); width: 44px; height: 44px;">
      <svg width="44" height="44" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="20" r="17" fill="white" stroke="${color}" stroke-width="2.5" />
        <path d="M20 7 L27 24 L20 20 L13 24 Z" fill="${color}" />
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: "",
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -22],
  });
}

// Grauer Punkt für Stationen mit Windsensoren, die gerade keine aktuellen
// Werte liefern (Ausfall oder veraltete Messung).
function createStaleIcon() {
  const html = `
    <div style="width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;">
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
        <circle cx="9" cy="9" r="7" fill="#9ca3af" stroke="white" stroke-width="2" />
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: "",
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -12],
  });
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "unbekannt";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

function StationPopup({ station }: { station: WindStation }) {
  return (
    <div className="text-sm leading-6">
      <p className="font-semibold">
        {station.stationName}
        {station.altitude !== null && ` (${station.altitude} m)`}
      </p>
      {station.stale ? (
        <p className="text-zinc-500">Keine aktuellen Winddaten</p>
      ) : (
        <>
          <p>Mittelwind: {station.speedKmh} km/h</p>
          {station.gustKmh !== null && <p>Böe: {station.gustKmh} km/h</p>}
          {station.direction !== null && (
            <p>
              Richtung: {Math.round(station.direction)}° /{" "}
              {toCompassPoint(station.direction)}
            </p>
          )}
        </>
      )}
      <p className="text-zinc-500">Stand: {formatTimestamp(station.timestamp)}</p>
    </div>
  );
}

export default function WindMap() {
  const [stations, setStations] = useState<WindStation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadWind() {
      try {
        const res = await fetch("/api/wind");
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Unbekannter Fehler");
          setStations([]);
          return;
        }
        setError(null);
        setStations(data as WindStation[]);
      } catch {
        if (!cancelled) setError("Winddaten konnten nicht geladen werden");
      }
    }

    loadWind();
    const interval = setInterval(loadWind, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={SOUTH_TYROL_CENTER}
        zoom={SOUTH_TYROL_ZOOM}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {stations
          .filter((s) => s.lat !== null && s.lng !== null)
          .map((station) => (
            <Marker
              key={station.stationCode}
              position={[station.lat!, station.lng!]}
              icon={
                station.stale
                  ? createStaleIcon()
                  : createWindIcon(station.direction, station.speedKmh)
              }
            >
              <Popup>
                <StationPopup station={station} />
              </Popup>
            </Marker>
          ))}
      </MapContainer>
      {error && (
        <div className="absolute top-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
