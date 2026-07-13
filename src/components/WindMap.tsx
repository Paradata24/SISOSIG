"use client";

import { useEffect, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getWindColor, type WindStation } from "@/lib/wind";

const SOUTH_TYROL_CENTER: [number, number] = [46.5, 11.35];
const SOUTH_TYROL_ZOOM = 9;
const POLL_INTERVAL_MS = 600_000; // 10 Minuten

// Pfeil-Icon (SVG) für eine Windstation. Der Pfeil wird so gedreht, dass er
// dorthin zeigt, wohin der Wind weht (Windrichtung + 180°, da die Station
// die Richtung meldet, AUS der der Wind kommt).
function createWindIcon(direction: number | null, speedKmh: number | null) {
  const color = getWindColor(speedKmh);
  const rotation = direction !== null ? (direction + 180) % 360 : 0;

  const html = `
    <div style="transform: rotate(${rotation}deg); width: 40px; height: 40px;">
      <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="20" r="17" fill="white" stroke="${color}" stroke-width="2.5" />
        <path d="M20 7 L27 24 L20 20 L13 24 Z" fill="${color}" />
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: "",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -20],
  });
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "unbekannt";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium" });
}

export default function WindMap() {
  const [station, setStation] = useState<WindStation | null>(null);
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
          setStation(null);
          return;
        }
        setError(null);
        setStation(data as WindStation);
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
        {station && station.lat !== null && station.lng !== null && (
          <Marker
            position={[station.lat, station.lng]}
            icon={createWindIcon(station.direction, station.speedKmh)}
          >
            <Popup>
              <div className="text-sm">
                <p className="font-semibold">{station.stationName}</p>
                <p>Richtung: {station.direction ?? "–"}°</p>
                <p>Geschwindigkeit: {station.speedKmh ?? "–"} km/h</p>
                <p>Böe: {station.gustKmh ?? "–"} km/h</p>
                <p className="text-zinc-500">
                  Stand: {formatTimestamp(station.timestamp)}
                </p>
              </div>
            </Popup>
          </Marker>
        )}
      </MapContainer>
      {error && (
        <div className="absolute top-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
