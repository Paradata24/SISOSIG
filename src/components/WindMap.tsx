"use client";

import { useEffect, useState } from "react";
import {
  LayerGroup,
  LayersControl,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getWindColor, toCompassPoint, type WindStation } from "@/lib/wind";

const SOUTH_TYROL_CENTER: [number, number] = [46.5, 11.35];
const SOUTH_TYROL_ZOOM = 9;
const POLL_INTERVAL_MS = 300_000; // 5 Minuten

const ARROW_SIZE = 44;
const LABEL_HEIGHT = 18;

// Pfeil-Icon (SVG) für eine Windstation. Der Pfeil wird so gedreht, dass er
// dorthin zeigt, wohin der Wind weht (Windrichtung + 180°, da die Station
// die Richtung meldet, AUS der der Wind kommt). 44px Kantenlänge, damit die
// Marker auch auf Touchscreens gut antippbar sind. Die Füllfarbe zeigt den
// Mittelwind, die Randfarbe die Böe (beide über dieselbe Farbskala). Als
// DivIcon mit fester iconSize bleibt die Pixelgröße unabhängig vom Zoom
// gleich, da Leaflet DivIcons nie mit der Karte mitskaliert.
function createWindIcon(
  direction: number | null,
  speedKmh: number | null,
  gustKmh: number | null,
) {
  const fillColor = getWindColor(speedKmh);
  const strokeColor = getWindColor(gustKmh);
  const rotation = direction !== null ? (direction + 180) % 360 : 0;
  const speedLabel = speedKmh !== null ? Math.round(speedKmh) : "–";
  const gustLabel = gustKmh !== null ? Math.round(gustKmh) : "–";

  const html = `
    <div style="display: flex; flex-direction: column; align-items: center; width: ${ARROW_SIZE}px;">
      <div style="transform: rotate(${rotation}deg); width: ${ARROW_SIZE}px; height: ${ARROW_SIZE}px;">
        <svg width="${ARROW_SIZE}" height="${ARROW_SIZE}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
          <circle cx="20" cy="20" r="17" fill="white" stroke="#d1d5db" stroke-width="1.5" />
          <path
            d="M20 7 L27 24 L20 20 L13 24 Z"
            fill="${fillColor}"
            stroke="${strokeColor}"
            stroke-width="2.5"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <div style="margin-top: -2px; padding: 1px 4px; background: white; border: 1px solid #9ca3af; border-radius: 4px; font-size: 11px; font-weight: 600; line-height: 1.3; color: #1f2937; white-space: nowrap;">
        ${speedLabel} / ${gustLabel}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: "",
    iconSize: [ARROW_SIZE, ARROW_SIZE + LABEL_HEIGHT],
    iconAnchor: [ARROW_SIZE / 2, ARROW_SIZE / 2],
    popupAnchor: [0, -ARROW_SIZE / 2],
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
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Standard">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Relief">
            <LayerGroup>
              <TileLayer
                attribution='Tiles &copy; <a href="https://www.esri.com">Esri</a>'
                url="https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"
              />
              <TileLayer
                attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
              />
            </LayerGroup>
          </LayersControl.BaseLayer>
        </LayersControl>
        {stations
          .filter((s) => s.lat !== null && s.lng !== null)
          .map((station) => (
            <Marker
              key={station.stationCode}
              position={[station.lat!, station.lng!]}
              icon={
                station.stale
                  ? createStaleIcon()
                  : createWindIcon(station.direction, station.speedKmh, station.gustKmh)
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
