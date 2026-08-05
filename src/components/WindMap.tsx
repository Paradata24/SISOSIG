"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  TileLayer,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  getWindColor,
  HIGH_ALTITUDE_THRESHOLD_M,
  isWindanzeigerStation,
  snapDirectionTo8,
  VERY_HIGH_ALTITUDE_THRESHOLD_M,
  type BaseLayer,
  type StationFilter,
  type WindStation,
} from "@/lib/wind";
import staatsgrenzen from "@/data/staatsgrenzen.json";

// Der Verlaufsbalken wird ERST GELADEN, WENN ER GEBRAUCHT WIRD (also beim
// ersten Klick auf eine Station) und steckt deshalb in einem eigenen
// JavaScript-Paket. Vorher lag er im selben Paket wie die Kartenbibliothek und
// musste mitgeladen werden, bevor überhaupt die erste Kachel zu sehen war —
// obwohl ihn viele Besucher nie öffnen.
// Damit sich der erste Klick trotzdem nicht zäh anfühlt, wird das Paket im
// Leerlauf nach dem Kartenaufbau schon im Voraus geholt (siehe useEffect mit
// prefetchHistoryPanel weiter unten). In der Praxis ist es also da, bevor
// jemand klickt, und die "Verlauf wird geladen…"-Leiste unten erscheint gar
// nicht erst.
const loadHistoryPanel = () => import("@/components/WindHistoryPanel");

const WindHistoryPanel = dynamic(loadHistoryPanel, {
  ssr: false,
  loading: () => (
    <div className="fixed inset-x-0 bottom-0 z-[1100] flex h-24 items-center justify-center border-t border-zinc-200 bg-white text-sm text-zinc-500 shadow-[0_-4px_16px_rgba(0,0,0,0.5)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      Verlauf wird geladen…
    </div>
  ),
});

const STAATSGRENZE_STYLE = { color: "#555555", weight: 2, opacity: 0.8, fill: false };

const SOUTH_TYROL_CENTER: [number, number] = [46.5, 11.35];
const SOUTH_TYROL_ZOOM = 9;
// Wie oft im Hintergrund neue Winddaten geholt werden. Die Stationen messen
// nur alle 5-10 Minuten, ein kürzerer Takt holt also meistens nur dieselben
// Werte noch einmal und kostet auf dem Handy unnötig Datenvolumen. Der Wert
// stand früher auf 90 s und wurde auf Wunsch des Projektbesitzers auf
// 3 Minuten erhöht. Wichtig dabei: die Anzeige wird dadurch NICHT träger,
// wenn man zur Seite zurückkehrt — der visibilitychange-Zuhörer weiter unten
// holt dann sofort frische Werte, unabhängig vom Takt.
const POLL_INTERVAL_MS = 180_000; // 3 Minuten

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

// Ist ein Stationsfilter aktiv (also NICHT "Alle"), stehen deutlich weniger
// Pfeile auf der Karte — dann ist Platz da, und Pfeile samt Zahlen werden auf
// Wunsch des Projektbesitzers um 25 % vergrößert, damit sie besser ablesbar
// sind.
const FILTERED_ICON_SCALE_BOOST = 1.25;

function getFilterScaleBoost(stationFilter: StationFilter): number {
  return stationFilter === "all" ? 1 : FILTERED_ICON_SCALE_BOOST;
}

// Pfeil-Icon (SVG) für eine Windstation. Der Pfeil wird so gedreht, dass er
// dorthin zeigt, wohin der Wind weht (Windrichtung + 180°, da die Station
// die Richtung meldet, AUS der der Wind kommt). Die angezeigte Richtung wird
// dabei auf die 8 Haupt-Himmelsrichtungen (0/45/…/315°) eingerastet, damit der
// Pfeil nicht "krumme" Zwischenwinkel zeigt. Die Füllfarbe zeigt den
// Mittelwind, die Randfarbe die Böe (beide über dieselbe Farbskala).
function createWindIcon(
  direction: number | null,
  speedKmh: number | null,
  gustKmh: number | null,
  scale: number,
) {
  const fillColor = getWindColor(speedKmh);
  const strokeColor = getWindColor(gustKmh);
  const snappedDirection = direction !== null ? snapDirectionTo8(direction) : null;
  const rotation = snappedDirection !== null ? (snappedDirection + 180) % 360 : 0;
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

// --- Zwischenspeicher für Marker-Icons ---
// Leaflet baut das komplette DOM eines Markers neu auf, sobald er ein NEUES
// Icon-Objekt bekommt (react-leaflet ruft dann marker.setIcon auf) — und zwar
// auch dann, wenn das neue Icon exakt gleich aussieht. Ohne Zwischenspeicher
// passierte genau das bei JEDER Hintergrund-Aktualisierung (siehe
// POLL_INTERVAL_MS): für
// alle ~130 Stationen wurde ein neues Icon gebaut und die ganze Markerschicht
// neu aufgebaut, obwohl sich meist nur eine Handvoll Messwerte geändert hat.
// Deshalb merken wir uns hier ein Icon pro sichtbarem Zustand (Werte + Größe):
// unveränderte Stationen bekommen dasselbe Icon-Objekt zurück, und Leaflet
// fasst ihren Marker gar nicht erst an.
// Damit der Speicher nicht unbegrenzt wächst, merken wir uns höchstens so
// viele Icons. Das reicht bequem für ~150 Stationen auf mehreren Zoomstufen;
// darüber hinaus fliegt jeweils das am längsten nicht benutzte Icon raus
// (Map behält die Einfügereihenfolge, deshalb ist der erste Eintrag der
// älteste).
const ICON_CACHE_LIMIT = 400;
const iconCache = new Map<string, L.DivIcon>();

function iconCacheKey(station: WindStation, scale: number): string {
  if (station.stale) return `stale|${scale}`;
  return `wind|${station.direction}|${station.speedKmh}|${station.gustKmh}|${scale}`;
}

function getMarkerIcon(station: WindStation, scale: number): L.DivIcon {
  const key = iconCacheKey(station, scale);
  const cached = iconCache.get(key);
  if (cached) {
    // Neu einsortieren = "zuletzt benutzt", damit der Deckel unten die
    // richtigen Icons wegwirft.
    iconCache.delete(key);
    iconCache.set(key, cached);
    return cached;
  }
  const icon = station.stale
    ? createStaleIcon(scale)
    : createWindIcon(station.direction, station.speedKmh, station.gustKmh, scale);
  iconCache.set(key, icon);
  while (iconCache.size > ICON_CACHE_LIMIT) {
    const oldest = iconCache.keys().next().value;
    if (oldest === undefined) break;
    iconCache.delete(oldest);
  }
  return icon;
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
  stationFilter,
}: {
  stations: WindStation[];
  // Bewusst nur der Stationscode (nicht das ganze Stations-Objekt): so bleibt
  // der Klick-Handler eines Markers über alle Aktualisierungen hinweg
  // derselbe — siehe handlersByCode unten.
  onSelect: (stationCode: string) => void;
  selectedStationCode: string | null;
  // Nur für die Pfeilgröße: bei aktivem Filter größere Marker
  // (siehe getFilterScaleBoost).
  stationFilter: StationFilter;
}) {
  const [zoom, setZoom] = useState(SOUTH_TYROL_ZOOM);
  const map = useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });
  const scale = getIconScale(zoom) * getFilterScaleBoost(stationFilter);
  const selectedStation = stations.find(
    (s) => s.stationCode === selectedStationCode && s.lat !== null && s.lng !== null,
  );
  // Radius so bemessen, dass sowohl der Pfeil als auch die Werte-Beschriftung
  // darunter innerhalb des Kreises liegen (Anker sitzt in der Pfeilmitte).
  const selectionRadius = Math.round(
    scale * (ARROW_BASE_SIZE / 2 + LABEL_BASE_HEIGHT) + 4,
  );

  const positionedStations = useMemo(
    () => stations.filter((s) => s.lat !== null && s.lng !== null),
    [stations],
  );

  // Auch die Klick-Handler werden festgehalten: bekommt ein Marker ein NEUES
  // Handler-Objekt, meldet react-leaflet den alten Leaflet-Listener ab und den
  // neuen an — bisher also für alle ~130 Marker bei jeder Aktualisierung. Da
  // sich nur die MESSWERTE ändern und nie die Stationsliste selbst, hängen die
  // Handler hier an der reinen Liste der Stationscodes und bleiben damit über
  // alle Aktualisierungen hinweg dieselben.
  const stationCodesKey = positionedStations.map((s) => s.stationCode).join(",");
  const handlersByCode = useMemo(() => {
    const map = new Map<string, { click: () => void }>();
    for (const code of stationCodesKey.split(",")) {
      if (code) map.set(code, { click: () => onSelect(code) });
    }
    return map;
  }, [stationCodesKey, onSelect]);

  return (
    <>
      {positionedStations.map((station) => (
        <Marker
          key={station.stationCode}
          position={[station.lat!, station.lng!]}
          icon={getMarkerIcon(station, scale)}
          eventHandlers={handlersByCode.get(station.stationCode)}
        />
      ))}
      {selectedStation && (
        <CircleMarker
          center={[selectedStation.lat!, selectedStation.lng!]}
          radius={selectionRadius}
          pathOptions={{
            color: "#000000",
            weight: 1.5,
            opacity: 0.8,
            fillOpacity: 0,
          }}
          interactive={false}
        />
      )}
    </>
  );
}

// Kartenhintergrund (baseLayer) und Stationsfilter werden nicht mehr hier,
// sondern im Menü im Titel-Balken umgeschaltet (WindApp.tsx) und kommen als
// Props herein.
export default function WindMap({
  baseLayer,
  stationFilter,
}: {
  baseLayer: BaseLayer;
  stationFilter: StationFilter;
}) {
  const [stations, setStations] = useState<WindStation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedStationCode, setSelectedStationCode] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Die Filterung hängt nur an der Stationsliste und dem gewählten Filter —
  // useMemo verhindert, dass sie bei jedem Neuzeichnen (z. B. beim Zoomen)
  // erneut über alle ~130 Stationen läuft.
  const visibleStations = useMemo(() => {
    const altitudeThreshold =
      stationFilter === "veryHigh"
        ? VERY_HIGH_ALTITUDE_THRESHOLD_M
        : stationFilter === "high"
          ? HIGH_ALTITUDE_THRESHOLD_M
          : null;
    if (stationFilter === "windanzeiger") return stations.filter(isWindanzeigerStation);
    if (altitudeThreshold === null) return stations;
    return stations.filter((s) => s.altitude !== null && s.altitude > altitudeThreshold);
  }, [stations, stationFilter]);

  // Aus dem Stationscode abgeleitet (statt eines eingefrorenen Snapshots vom
  // Klickzeitpunkt), damit z. B. der "Stand"-Zeitstempel im Verlaufspanel bei
  // jeder Hintergrund-Aktualisierung von /api/wind mit aktualisiert wird.
  const selectedStation = stations.find((s) => s.stationCode === selectedStationCode) ?? null;

  // Feste Referenz, damit die Marker-Klick-Handler nicht bei jeder
  // Aktualisierung neu angemeldet werden müssen (siehe WindMarkers).
  const handleSelect = useCallback((stationCode: string) => {
    setSelectedStationCode(stationCode);
  }, []);

  // Das Verlaufsbalken-Paket im Leerlauf vorab holen (siehe loadHistoryPanel
  // oben): Karte und Marker haben Vorrang, sobald der Browser aber nichts
  // Wichtigeres zu tun hat, lädt er den Verlaufsbalken im Hintergrund nach.
  // Klickt jemand dann auf eine Station, ist er sofort da.
  // requestIdleCallback kennen nicht alle Browser (ältere Versionen von Safari
  // auf iPhone/iPad), deshalb ersatzweise ein einfacher Zeitgeber.
  useEffect(() => {
    const prefetchHistoryPanel = () => {
      void loadHistoryPanel();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(prefetchHistoryPanel, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(prefetchHistoryPanel, 2500);
    return () => window.clearTimeout(timer);
  }, []);

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
    // Im Hintergrund (Tab nicht sichtbar, Handy gesperrt, andere App im
    // Vordergrund) wird NICHT abgefragt: Werte, die gerade niemand sieht,
    // müssen auch nicht geladen werden. Das spart auf dem Handy Datenvolumen
    // und Akku. Beim Zurückkommen holt handleVisibility unten sofort frische
    // Werte, die Anzeige ist also trotzdem nie veraltet.
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      loadWind(false);
    }, POLL_INTERVAL_MS);

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
        zoomControl={false}
        className="h-full w-full"
      >
        {/* Die key-Attribute sorgen dafür, dass beim Umschalten die alten
            Kachel-Ebenen komplett entfernt und neue angelegt werden (inkl.
            korrekter Quellenangabe unten rechts).

            Die Kachel-Adressen stehen bewusst OHNE das früher übliche
            "{s}."-Kürzel (a./b./c.-Unterdomains). Das stammt noch aus der
            HTTP/1-Zeit, als Browser pro Server nur wenige Downloads
            gleichzeitig erlaubten. Mit HTTP/2 lädt EINE Verbindung alle
            Kacheln parallel — drei Unterdomains bedeuten dann nur drei
            getrennte Verbindungsaufbauten (langsamer, vor allem im
            Mobilfunk). OpenStreetMap rät inzwischen selbst davon ab. */}
        {baseLayer === "standard" ? (
          <TileLayer
            key="osm"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
        ) : (
          <>
            <TileLayer
              key="esri-hillshade"
              attribution='Tiles &copy; <a href="https://www.esri.com">Esri</a>'
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"
            />
            <TileLayer
              key="carto-labels"
              attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
            />
          </>
        )}
        <GeoJSON
          data={staatsgrenzen as GeoJSON.GeoJsonObject}
          style={STAATSGRENZE_STYLE}
          interactive={false}
        />
        <WindMarkers
          stations={visibleStations}
          onSelect={handleSelect}
          selectedStationCode={selectedStationCode}
          stationFilter={stationFilter}
        />
      </MapContainer>
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
