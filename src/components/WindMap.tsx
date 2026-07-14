"use client";

import { useEffect, useState } from "react";
import {
  CircleMarker,
  LayerGroup,
  LayersControl,
  MapContainer,
  Marker,
  TileLayer,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getWindColor, type WindStation } from "@/lib/wind";
import WindLegend from "@/components/WindLegend";
import WindHistoryPanel from "@/components/WindHistoryPanel";

const SOUTH_TYROL_CENTER: [number, number] = [46.5, 11.35];
const SOUTH_TYROL_ZOOM = 9;
const POLL_INTERVAL_MS = 90_000; // 90 Sekunden
const HIGH_ALTITUDE_THRESHOLD_M = 2000;

const ARROW_BASE_SIZE = 22;
const LABEL_BASE_HEIGHT = 10;
const MIN_ICON_SCALE = 0.35;

// Die Pfeile skalieren stufenlos mit dem Kartenzoom mit (größer beim
// Reinzoomen, kleiner beim Rauszoomen) statt eine feste Pixelgröße zu haben.
// Beim Rauszoomen wird der Skalierfaktor nach unten hin gedeckelt
// (MIN_ICON_SCALE), damit die Pfeile nicht auf der ganzen Karte verschwinden
// und diese übersichtlich bleibt. getIconScale() rechnet eine Zoomstufe in
// diesen Skalierfaktor um.
function getIconScale(zoom: number): number {
  const scale = 1 + (zoom - SOUTH_TYROL_ZOOM) * 0.15;
  return Math.max(MIN_ICON_SCALE, scale);
}

// Pfeil-Icon (SVG) für eine Windstation. Der Pfeil wird so gedreht, dass er
// dorthin zeigt, wohin der Wind weht (Windrichtung + 180°, da die Station
// die Richtung meldet, AUS der der Wind kommt). Die Füllfarbe zeigt den
// Mittelwind, die Randfarbe die Böe (beide über dieselbe Farbskala).
function createWindIcon(
  direction: number | null,
  speedKmh: number | null,
  gustKmh: number | null,
  scale: number,
) {
  const fillColor = getWindColor(speedKmh);
  const strokeColor = getWindColor(gustKmh);
  const rotation = direction !== null ? (direction + 180) % 360 : 0;
  const speedLabel = speedKmh !== null ? Math.round(speedKmh) : "–";
  const gustLabel = gustKmh !== null ? Math.round(gustKmh) : "–";

  const arrowSize = Math.round(ARROW_BASE_SIZE * scale);
  const labelHeight = Math.round(LABEL_BASE_HEIGHT * scale);
  const fontSize = Math.max(5, Math.round(6.5 * scale));
  const strokeWidth = Math.max(0.75, 1.5 * scale);

  const textHalo = "-1.5px 0 white, 1.5px 0 white, 0 -1.5px white, 0 1.5px white, -1px -1px white, 1px -1px white, -1px 1px white, 1px 1px white";

  const html = `
    <div style="display: flex; flex-direction: column; align-items: center; width: ${arrowSize}px;">
      <div style="transform: rotate(${rotation}deg); width: ${arrowSize}px; height: ${arrowSize}px;">
        <svg width="${arrowSize}" height="${arrowSize}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M20 2 L34 34 L20 26 L6 34 Z"
            fill="${fillColor}"
            stroke="${strokeColor}"
            stroke-width="${strokeWidth}"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </svg>
      </div>
      <div style="margin-top: -2px; font-size: ${fontSize}px; font-weight: 700; line-height: 1.3; color: #1f2937; white-space: nowrap; text-shadow: ${textHalo};">
        ${speedLabel} / ${gustLabel}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: "",
    iconSize: [arrowSize, arrowSize + labelHeight],
    iconAnchor: [arrowSize / 2, arrowSize / 2],
    popupAnchor: [0, -arrowSize / 2],
  });
}

// Grauer Punkt für Stationen mit Windsensoren, die gerade keine aktuellen
// Werte liefern (Ausfall oder veraltete Messung).
function createStaleIcon(scale: number) {
  const size = Math.round(ARROW_BASE_SIZE * scale);
  const dotSize = Math.max(4, Math.round(9 * scale));

  const html = `
    <div style="width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center;">
      <svg width="${dotSize}" height="${dotSize}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
        <circle cx="9" cy="9" r="7" fill="#9ca3af" stroke="white" stroke-width="2" />
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

// Schalter oben links auf der Karte: blendet Stationen unterhalb der
// Höhenschwelle aus, sobald aktiviert. Ausreichend groß für Touch-Bedienung.
function ElevationFilterToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`absolute top-20 left-3 z-[1000] rounded-md border px-3 py-2.5 text-sm font-medium shadow-lg transition-colors ${
        active
          ? "border-emerald-700 bg-emerald-600 text-white hover:bg-emerald-700"
          : "border-black/10 bg-white/90 text-zinc-700 hover:bg-white dark:border-white/10 dark:bg-zinc-900/85 dark:text-zinc-100 dark:hover:bg-zinc-900"
      }`}
    >
      Nur Stationen &gt;{HIGH_ALTITUDE_THRESHOLD_M}m
    </button>
  );
}

// Rendert die Windmarker und hält ihre Größe mit dem aktuellen Zoom
// synchron (siehe getIconScale). Muss innerhalb von <MapContainer> stehen,
// da useMapEvents auf den Leaflet-Kartenkontext angewiesen ist.
// Ein Klick auf einen Marker öffnet das Verlaufspanel am unteren
// Bildschirmrand (onSelect) und zeichnet einen Auswahl-Kreis um Pfeil und
// Text der angeklickten Station statt eines Popups.
function WindMarkers({
  stations,
  onSelect,
  selectedStationCode,
}: {
  stations: WindStation[];
  onSelect: (station: WindStation) => void;
  selectedStationCode: string | null;
}) {
  const [zoom, setZoom] = useState(SOUTH_TYROL_ZOOM);
  const map = useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });
  const scale = getIconScale(zoom);
  const selectedStation = stations.find(
    (s) => s.stationCode === selectedStationCode && s.lat !== null && s.lng !== null,
  );
  // Radius so bemessen, dass sowohl der Pfeil als auch die Werte-Beschriftung
  // darunter innerhalb des Kreises liegen (Anker sitzt in der Pfeilmitte).
  const selectionRadius = Math.round(
    scale * (ARROW_BASE_SIZE / 2 + LABEL_BASE_HEIGHT) + 4,
  );

  return (
    <>
      {stations
        .filter((s) => s.lat !== null && s.lng !== null)
        .map((station) => (
          <Marker
            key={station.stationCode}
            position={[station.lat!, station.lng!]}
            icon={
              station.stale
                ? createStaleIcon(scale)
                : createWindIcon(station.direction, station.speedKmh, station.gustKmh, scale)
            }
            eventHandlers={{ click: () => onSelect(station) }}
          />
        ))}
      {selectedStation && (
        <CircleMarker
          center={[selectedStation.lat!, selectedStation.lng!]}
          radius={selectionRadius}
          pathOptions={{
            color: "#2563eb",
            weight: 1.5,
            opacity: 0.5,
            fillOpacity: 0,
          }}
          interactive={false}
        />
      )}
    </>
  );
}

export default function WindMap() {
  const [stations, setStations] = useState<WindStation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [highAltitudeOnly, setHighAltitudeOnly] = useState(false);
  const [selectedStationCode, setSelectedStationCode] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const visibleStations = highAltitudeOnly
    ? stations.filter(
        (s) => s.altitude !== null && s.altitude > HIGH_ALTITUDE_THRESHOLD_M,
      )
    : stations;

  // Aus dem Stationscode abgeleitet (statt eines eingefrorenen Snapshots vom
  // Klickzeitpunkt), damit z. B. der "Stand"-Zeitstempel im Verlaufspanel bei
  // jeder Hintergrund-Aktualisierung von /api/wind mit aktualisiert wird.
  const selectedStation = stations.find((s) => s.stationCode === selectedStationCode) ?? null;

  useEffect(() => {
    let cancelled = false;

    // isInitial=true nur beim allerersten Laden. Bei den Hintergrund-
    // Aktualisierungen bleiben die zuletzt bekannten Marker stehen, falls
    // eine einzelne Anfrage scheitert (z. B. kurzer Netzaussetzer am Handy) —
    // so verschwinden nicht plötzlich alle Pfeile von der Karte.
    async function loadWind(isInitial = false) {
      try {
        const res = await fetch("/api/wind", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          if (isInitial) {
            setError(data.error ?? "Unbekannter Fehler");
            setStations([]);
          }
          return;
        }
        setError(null);
        setStations(data as WindStation[]);
        setLastUpdated(new Date());
      } catch {
        if (!cancelled && isInitial) {
          setError("Winddaten konnten nicht geladen werden");
        }
      }
    }

    loadWind(true);
    const interval = setInterval(() => loadWind(false), POLL_INTERVAL_MS);

    // Sobald der Tab wieder in den Vordergrund kommt (z. B. Handy entsperrt),
    // sofort frische Werte holen statt bis zum nächsten Intervall zu warten.
    function handleVisibility() {
      if (document.visibilityState === "visible") loadWind(false);
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
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
        <WindMarkers
          stations={visibleStations}
          onSelect={(station) => setSelectedStationCode(station.stationCode)}
          selectedStationCode={selectedStationCode}
        />
      </MapContainer>
      <ElevationFilterToggle
        active={highAltitudeOnly}
        onToggle={() => setHighAltitudeOnly((v) => !v)}
      />
      <WindLegend />
      {lastUpdated && (
        <div className="absolute bottom-4 left-4 z-[1000] rounded-md bg-white/85 px-2 py-1 text-xs text-zinc-600 shadow-md dark:bg-zinc-900/80 dark:text-zinc-300">
          Zuletzt aktualisiert:{" "}
          {lastUpdated.toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      )}
      {error && (
        <div className="absolute top-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          {error}
        </div>
      )}
      {selectedStation && (
        <WindHistoryPanel
          station={selectedStation}
          onClose={() => setSelectedStationCode(null)}
        />
      )}
    </div>
  );
}
