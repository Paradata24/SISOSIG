"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  TileLayer,
  useMapEvents,
  WMSTileLayer,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  CARTO_API_KEY,
  getWindColor,
  matchesStationFilter,
  snapDirectionTo8,
  type BaseLayer,
  type StationFilter,
  type TimelineFrame,
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
    <div className="absolute inset-x-0 bottom-0 z-[1100] flex h-24 items-center justify-center border-t border-zinc-200 bg-white text-sm text-zinc-500 shadow-[0_-4px_16px_rgba(0,0,0,0.18)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      Verlauf wird geladen…
    </div>
  ),
});

const STAATSGRENZE_STYLE = { color: "#555555", weight: 2, opacity: 0.8, fill: false };

const SOUTH_TYROL_CENTER: [number, number] = [46.5, 11.35];
const SOUTH_TYROL_ZOOM = 9;

// Wie weit man höchstens hineinzoomen darf.
//
// Vorher stand hier NICHTS — und genau das war das Problem: ohne eigene
// Angabe nimmt Leaflet die Obergrenze der Kachel-Ebenen, also 18. So weit
// reicht aber die Esri-Schummerung ("Relief (Grau)") in Südtirol nicht: ab
// einem gewissen Punkt liefert sie nur noch graue Platzhalter-Kacheln mit dem
// Text "Map data not yet available".
//
// Der Wert steht BEWUSST an der Karte selbst und nicht an den Kachel-Ebenen.
// Nur so hört auch das Scrollrad, der Doppelklick und das Aufziehen mit zwei
// Fingern am Handy an dieser Stelle auf; eine Grenze allein an der Ebene
// würde die Karte weiterzoomen lassen und nur die Kacheln vergrößert
// stehenlassen.
//
// 15 gilt für BEIDE Basiskarten, obwohl OpenTopoMap (bis 17) und die
// Beschriftungen (CARTO, bis 20) mehr könnten: Die Karte soll sich beim
// Umschalten nicht unterschiedlich verhalten. Zum Fliegen reicht Stufe 15
// bequem (rund 3,5 m je Bildpunkt).
const MAP_MAX_ZOOM = 15;

// --- OpenTopoMap (Standardkarte) ---
// Frei nutzbare Topografie-Karte auf Basis von OpenStreetMap und SRTM-
// Höhendaten (CC BY-SA, Quellenangabe im Menü unter "Quellen"). Ohne
// "{s}."-Unterdomain, siehe Kommentar im JSX weiter unten. OpenTopoMap
// liefert nur bis Zoom 17; die eigene Obergrenze der Karte (MAP_MAX_ZOOM)
// liegt darunter, der Wert hier schützt nur vor einer späteren Änderung.
const TOPO_URL = "https://tile.opentopomap.org/{z}/{x}/{y}.png";
const TOPO_MAX_NATIVE_ZOOM = 17;

// --- Höhenlinien-Ebene (nur bei "Relief (Grau)") ---
// Kartendienst des Landes Südtirol (Geoportal). Die Linien liegen als
// durchsichtiges Bild ÜBER der Esri-Schummerung; die Schummerung selbst
// bleibt unverändert der Untergrund.
//
// Der Dienst rechnet die Daten (Original EPSG:25832) selbst nach
// EPSG:3857 um, das Leaflet braucht, und liefert transparentes PNG — beides
// vorab am fertigen Bild geprüft.
const CONTOUR_WMS_URL =
  "https://geoservices9.civis.bz.it/geoserver/p_bz-Elevation/ows";
// Von den mehreren angebotenen Varianten die für HELLE Hintergründe — also
// genau unser Fall (graue Reliefkarte). Der Dienst dünnt die Linien beim
// Herauszoomen selbst aus, wir bekommen also nicht überall die vollen 2,5 m
// Abstand des Geländemodells.
const CONTOUR_WMS_LAYER = "p_bz-Elevation:ContourLines-ForLightBackgrounds";
// Erst ab dieser Stufe einblenden. Darunter lägen die Linien so dicht
// beieinander, dass sie nur ein grauer Schleier wären und die Windpfeile
// stören würden. Leaflet lädt unterhalb der Grenze gar keine Kacheln — das
// spart nebenbei Anfragen an den Landesserver.
const CONTOUR_MIN_ZOOM = 13;
// Deckkraft: die Linien sollen das Gelände andeuten, nicht mit den
// Windpfeilen konkurrieren. Zusammen mit dem Graufilter in globals.css
// (Klasse .hoehenlinien-ebene) treten sie deutlich zurück.
const CONTOUR_OPACITY = 0.5;
// Die Geodaten des Landes stehen unter CC BY: Quellenangabe ist Pflicht.
// Sie steht (wie Esri, CARTO und OpenStreetMap) seit Sept. 2026 im Menü-Popup
// unter "Quellen" — siehe MAP_SOURCES in src/lib/wind.ts.
// Ortsnamen-Ebenen über dem Relief (siehe Kommentar im JSX): CARTO braucht
// seit Sept. 2026 einen Schlüssel (CARTO_API_KEY), Esri ist der Ersatz ohne.
const CARTO_LABELS_URL =
  "https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png";
const ESRI_LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
// Durchsichtiger 1×1-Punkt für Kacheln, die der Landesserver nicht liefert
// (Ausfall, Zeitüberschreitung, Gebiet außerhalb Südtirols). Damit ist eine
// fehlende Höhenlinien-Kachel schlicht LEER und kein sichtbarer Fehler — die
// Karte, die Windpfeile und der Rest funktionieren unverändert weiter.
const TRANSPARENT_TILE =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

// Zeichenreihenfolge der Kachel-Ebenen innerhalb der Karte (kleiner = weiter
// unten). Bewusst ausgeschrieben statt der Einfügereihenfolge überlassen:
// Schummerung ganz unten, darüber die Höhenlinien, obenauf die Ortsnamen —
// sonst könnten die Höhenlinien die Beschriftung überdecken.
// Windpfeile und Auswahl-Ring liegen ohnehin darüber: Leaflet setzt Marker
// und Linien grundsätzlich in eine höhere Ebene als alle Kartenkacheln.
const Z_HILLSHADE = 1;
// Deckkraft der Esri-Schummerung. Sie liegt auf weißem Kartengrund (siehe
// style am MapContainer), 0,75 hellt das Relief also um ein Viertel auf —
// die Windfarben leuchten dadurch stärker (Umbau "Karte lesbarer", Sept. 2026).
const HILLSHADE_OPACITY = 0.75;
// Kartengrund hinter den Kacheln. Leaflet setzt von sich aus Grau (#ddd); bei
// halbdurchsichtigem Relief würde das durchscheinen. Inline statt über eine
// Tailwind-Klasse, weil leaflet.css sonst Vorrang hätte.
const MAP_BACKGROUND = "#ffffff";
const Z_CONTOURS = 2;
const Z_LABELS = 3;
// Wie oft im Hintergrund neue Winddaten geholt werden. Die Stationen messen
// nur alle 5-10 Minuten, ein kürzerer Takt holt also meistens nur dieselben
// Werte noch einmal und kostet auf dem Handy unnötig Datenvolumen. Der Wert
// stand früher auf 90 s und wurde auf Wunsch des Projektbesitzers auf
// 3 Minuten erhöht. Wichtig dabei: die Anzeige wird dadurch NICHT träger,
// wenn man zur Seite zurückkehrt — der visibilitychange-Zuhörer weiter unten
// holt dann sofort frische Werte, unabhängig vom Takt.
const POLL_INTERVAL_MS = 180_000; // 3 Minuten

// --- Drei Zoomstufen (Sept. 2026, Umbau "Karte lesbarer") ---
// Früher schrumpften die Pfeile mit jedem Zoomschritt stufenlos, herausgezoomt
// bis auf 8 px, und die Zahlen waren in der Startansicht nur 7 px hoch. Jetzt
// gibt es drei klar getrennte Ansichten mit festen Größen, jede mit einer
// eigenen Aufgabe:
//   - Übersicht (bis Zoom 8):   "Wo ist es ruhig, wo zu stark?" — nur Pfeile,
//                               überlappende werden ausgedünnt (siehe unten)
//   - Region    (Zoom 9–11):    "Wie stark genau, wie böig?" — große Pfeile,
//                               Zahlen erst ab Zoom 10 (LABEL_MIN_ZOOM)
//   - Detail    (ab Zoom 12):   "Welche Station ist das?" — zusätzlich
//                               Stationsname und Höhe
type ZoomTier = "overview" | "region" | "detail";

// Ab welcher Zoomstufe die Zahlen (Mittelwind / Böe) unter den Pfeilen
// stehen. Seit Schweiz (SLF) und ganz Österreich (GeoSphere) dabei sind, hat
// die Karte ~560 Stationen; herausgezoomt überdeckten sich die Zahlen zu
// einem unlesbaren Teppich. Darunter zeigt die Karte deshalb nur die farbigen
// Pfeile (Farbe = Mittelwind, Rand = Böe).
// 10 = eine Stufe über der Startansicht Südtirol (SOUTH_TYROL_ZOOM = 9): Beim
// Öffnen der Seite stehen nur die Pfeile da, die Zahlen erscheinen erst beim
// ersten Hineinzoomen (Wunsch des Projektbesitzers, Sept. 2026 — vorher
// waren sie schon in der Startansicht sichtbar).
// Das gilt genauso bei aktivem Stationsfilter: Früher blieben die Zahlen dort
// immer sichtbar und alles war 25 % größer — auf Wunsch des Projektbesitzers
// (Sept. 2026) gelten jetzt für jeden Filter dieselben Regeln wie für "Alle".
const LABEL_MIN_ZOOM = SOUTH_TYROL_ZOOM + 1;
// Ab hier beginnt die Stufe "Region" (große Pfeile, kein Ausdünnen). Bewusst
// getrennt von LABEL_MIN_ZOOM: Die Startansicht soll schon die großen,
// vollständigen Pfeile zeigen, nur eben noch ohne Zahlen.
const REGION_MIN_ZOOM = SOUTH_TYROL_ZOOM;
// Ab hier kommen Stationsname und Höhe unter die Zahlen. Darunter wären die
// Namen zu lang für den Abstand zwischen den Stationen.
const DETAIL_MIN_ZOOM = 12;

function getZoomTier(zoom: number): ZoomTier {
  if (zoom >= DETAIL_MIN_ZOOM) return "detail";
  if (zoom >= REGION_MIN_ZOOM) return "region";
  return "overview";
}

function shouldShowLabels(zoom: number): boolean {
  return zoom >= LABEL_MIN_ZOOM;
}

// Kantenlänge der Pfeile je Zoomstufe (Bildschirmpixel). Sept. 2026 auf
// Wunsch des Projektbesitzers um rund ein Viertel verkleinert (vorher
// 16 / 26 / 32). Die Größe springt bewusst nur an den Stufengrenzen
// (Zoom 9 und 12), dazwischen bleibt sie fest.
// Übersicht (bis Zoom 8) und Region (Zoom 9–11) haben seit Sept. 2026 auf
// Wunsch des Projektbesitzers dieselbe, gut lesbare Größe — beim Wechsel von
// Zoom 8 auf 9 springt der Pfeil also nicht mehr. Der Unterschied der beiden
// Stufen ist nur noch das Ausdünnen in der Übersicht (siehe unten).
const ARROW_SIZE: Record<ZoomTier, number> = { overview: 20, region: 20, detail: 24 };
// Breite des böenfarbigen Pfeilrands (Bildschirmpixel). Bewusst deutlich
// breiter als früher (knapp 1 px), damit die Böe am Pfeil ablesbar bleibt —
// Wunsch des Projektbesitzers: die Böe bleibt im Pfeilrand, ZUSÄTZLICH zur
// Zahl in der Plakette.
// Mit den kleineren Pfeilen (siehe ARROW_SIZE) im gleichen Verhältnis
// schmaler geworden (vorher 2 / 2,6 / 3).
const GUST_STROKE_PX: Record<ZoomTier, number> = { overview: 2.1, region: 2.1, detail: 2.4 };
// Dunkler Umriss AUSSEN um den Böenrand. Ohne ihn verschwanden hellblaue und
// gelbe Pfeile auf dem hellgrauen Relief, und bei gleicher Farbe von Mittelwind
// und Böe war gar kein Rand zu sehen. Der Umriss macht jede Farbe der Skala auf
// jedem Untergrund sichtbar, ohne die Farbskala selbst anzufassen.
const OUTLINE_PX = 1.1;
// Pfeilform im 40er-Raster des SVG: Spitze oben, Kerbe hinten, runde Ecken.
// Eine spitzere Variante wurde im Sept. 2026 ausprobiert und vom
// Projektbesitzer wieder verworfen — die Form bleibt so.
const ARROW_PATH = "M20 3 L34 34 L20 26 L6 34 Z";
const OUTLINE_COLOR = "#1f2937";
// Schriftgröße der Zahlen-Plakette (Mittelwind; die Böe steht eine Spur
// kleiner daneben). Früher 7 px in der Startansicht.
const LABEL_FONT_PX: Record<ZoomTier, number> = { overview: 12, region: 12, detail: 14 };
// Ungefähre Höhe der Plakette — nur für den Auswahl-Ring, der Pfeil und
// Plakette umschließen soll.
const LABEL_HEIGHT_PX: Record<ZoomTier, number> = { overview: 16, region: 16, detail: 19 };
// Breite des Icon-Kastens (Pfeil ist mittig darin). Breiter als der Pfeil,
// damit Plakette und Stationsname Platz haben. Klicks fängt der Kasten
// trotzdem nicht ab: nur Pfeil und Plakette sind anklickbar (Klasse
// .wind-marker in globals.css).
const ICON_BOX_WIDTH: Record<ZoomTier, number> = { overview: 64, region: 64, detail: 180 };

// --- Ausdünnen in der Übersicht ---
// Herausgezoomt liegen hunderte Pfeile übereinander. In der Übersicht (bei
// jedem Stationsfilter, auch "Alle") bleibt deshalb von zwei Pfeilen, die sich überdecken
// würden, nur der der HÖHER GELEGENEN Station — die ist für Flieger meist die
// wichtigere. Mindestabstand = Pfeilgröße × dieser Faktor.
//
// Wichtig: Die Rangfolge hängt nur an der Höhe (und bei Gleichstand am
// Stationscode), NICHT am Wind. So springt beim Blättern im Zeitbalken nichts
// hin und her. Ausgedünnte Stationen bleiben als unsichtbare Marker bestehen
// — Anzahl und Reihenfolge der Marker ändern sich nie (siehe displayStations
// in WindMap).
// Ausgefallene Stationen (grau) zählen beim Ausdünnen nicht mit und sind in
// der Übersicht ganz unsichtbar: Ein Ausfall soll keinen echten Messwert
// daneben verdrängen.
const THIN_DISTANCE_FACTOR = 1.25;

// Stationsnamen kommen von fremden Diensten und landen im HTML des Icons —
// deshalb Sonderzeichen entschärfen.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Pfeil-Icon (SVG) für eine Windstation. Der Pfeil wird so gedreht, dass er
// dorthin zeigt, wohin der Wind weht (Windrichtung + 180°, da die Station
// die Richtung meldet, AUS der der Wind kommt). Die angezeigte Richtung wird
// dabei auf die 8 Haupt-Himmelsrichtungen (0/45/…/315°) eingerastet, damit der
// Pfeil nicht "krumme" Zwischenwinkel zeigt.
//
// Aufbau von außen nach innen: dunkler Umriss → Rand in Böenfarbe → Fläche in
// Mittelwindfarbe. Gezeichnet wird das als zwei gleiche Pfade übereinander:
// unten ein breiter dunkler Strich, darüber der Pfeil mit Böenrand, der den
// inneren Teil des dunklen Strichs verdeckt.
//
// Darunter (ab Zoom 9 oder bei aktivem Filter) die Zahlen-Plakette: links der
// Mittelwind, rechts die Böe, jedes Feld in seiner Windfarbe. Im Detail
// zusätzlich Stationsname und Höhe.
function createWindIcon(
  station: WindStation,
  tier: ZoomTier,
  showLabel: boolean,
) {
  const { direction, speedKmh, gustKmh } = station;
  const fillColor = getWindColor(speedKmh);
  const gustColor = getWindColor(gustKmh);
  const snappedDirection = direction !== null ? snapDirectionTo8(direction) : null;
  const rotation = snappedDirection !== null ? (snappedDirection + 180) % 360 : 0;
  const speedLabel = speedKmh !== null ? Math.round(speedKmh) : "–";
  const gustLabel = gustKmh !== null ? Math.round(gustKmh) : "–";

  const arrowSize = ARROW_SIZE[tier];
  // Das SVG rechnet in einem 40er-Raster; Strichbreiten also umrechnen.
  const toUnits = 40 / arrowSize;
  const gustWidth = GUST_STROKE_PX[tier] * toUnits;
  const outlineWidth = gustWidth + 2 * OUTLINE_PX * toUnits;
  const arrowPath = ARROW_PATH;

  const boxWidth = Math.max(arrowSize, ICON_BOX_WIDTH[tier]);
  const fontSize = LABEL_FONT_PX[tier];
  const gustFontSize = Math.round(fontSize * 0.88);
  const labelHeight = showLabel ? LABEL_HEIGHT_PX[tier] : 0;

  let label = "";
  if (showLabel) {
    label = `<div style="display: flex; margin-top: 1px; border: 1px solid rgba(31,41,55,0.85); font-weight: 700; line-height: 1.2; color: #111827; white-space: nowrap; font-variant-numeric: tabular-nums; pointer-events: auto; cursor: pointer;">
        <span style="background: ${fillColor}; padding: 0 4px; font-size: ${fontSize}px;">${speedLabel}</span>
        <span style="background: ${gustColor}; padding: 0 4px; font-size: ${gustFontSize}px; display: flex; align-items: center; border-left: 1px solid rgba(31,41,55,0.5);">${gustLabel}</span>
      </div>`;
    if (tier === "detail") {
      const altitude = station.altitude !== null ? ` · ${Math.round(station.altitude)} m` : "";
      label += `<div style="margin-top: 2px; font-size: 12px; font-weight: 700; line-height: 1.2; color: #1f2937; white-space: nowrap; text-shadow: 0 0 2px white, 0 0 2px white, 0 0 3px white;">${escapeHtml(station.stationName)}${altitude}</div>`;
    }
  }

  const html = `
    <div style="display: flex; flex-direction: column; align-items: center; width: ${boxWidth}px; font-family: var(--font-barlow-semi-condensed), Arial, sans-serif;">
      <div style="transform: rotate(${rotation}deg); width: ${arrowSize}px; height: ${arrowSize}px; pointer-events: auto; cursor: pointer;">
        <svg width="${arrowSize}" height="${arrowSize}" viewBox="0 0 40 40" style="overflow: visible;" xmlns="http://www.w3.org/2000/svg">
          <path d="${arrowPath}" fill="none" stroke="${OUTLINE_COLOR}" stroke-width="${outlineWidth}" stroke-linejoin="round" />
          <path d="${arrowPath}" fill="${fillColor}" stroke="${gustColor}" stroke-width="${gustWidth}" stroke-linejoin="round" />
        </svg>
      </div>
      ${label}
    </div>
  `;

  return L.divIcon({
    html,
    className: "wind-marker",
    iconSize: [boxWidth, arrowSize + labelHeight],
    iconAnchor: [boxWidth / 2, arrowSize / 2],
    popupAnchor: [0, -arrowSize / 2],
  });
}

// Blasser, hohler Ring für Stationen mit Windsensoren, die gerade keine
// aktuellen Werte liefern (Ausfall oder veraltete Messung). Früher ein voller
// grauer Punkt, der genauso viel Blick zog wie ein echter Messwert.
function createStaleIcon(tier: ZoomTier) {
  const size = ARROW_SIZE[tier];
  const ringSize = tier === "detail" ? 11 : 9;

  const html = `
    <div style="width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center;">
      <svg width="${ringSize}" height="${ringSize}" viewBox="0 0 10 10" style="opacity: 0.6; pointer-events: auto; cursor: pointer;" xmlns="http://www.w3.org/2000/svg">
        <circle cx="5" cy="5" r="3.7" fill="white" fill-opacity="0.6" stroke="#6b7280" stroke-width="1.5" />
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: "wind-marker",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

// Leeres Icon für Stationen, die in der Übersicht ausgedünnt werden. Der
// Marker bleibt bestehen (siehe THIN_DISTANCE_FACTOR), ist aber unsichtbar
// und nicht anklickbar (.wind-marker in globals.css).
const HIDDEN_ICON = L.divIcon({ html: "", className: "wind-marker", iconSize: [0, 0] });

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
// viele Icons. Das reicht bequem für ~560 Stationen auf mehreren Zoomstufen;
// darüber hinaus fliegt jeweils das am längsten nicht benutzte Icon raus
// (Map behält die Einfügereihenfolge, deshalb ist der erste Eintrag der
// älteste).
// Beim Schieben des Zeitbalkens laufen deutlich mehr Zustände durch als beim
// reinen Live-Betrieb (jeder 10-Minuten-Schritt bringt neue Werte), deshalb
// etwas mehr Platz als früher (400). Seit Schweiz und Österreich dabei sind
// (~560 statt ~130 Stationen), noch einmal mehr — mit 800 hätte schon eine
// einzige Aktualisierung aller Stationen den Speicher fast ganz ausgetauscht.
// Ein Icon ist nur ein kleines Objekt mit etwas HTML-Text, 3.000 sind harmlos.
const ICON_CACHE_LIMIT = 3000;
const iconCache = new Map<string, L.DivIcon>();

// Der Schlüssel benutzt bewusst die ANGEZEIGTEN Werte, nicht die rohen: das
// Icon hängt nur von der auf 8 Himmelsrichtungen eingerasteten Richtung und
// den gerundeten Zahlen ab (die Farben runden intern ebenfalls). Rohwerte wie
// 137.4° oder 12.3 km/h wären dagegen fast immer verschieden — beim Schieben
// des Zeitbalkens hätte der Zwischenspeicher dann praktisch nie einen Treffer.
// In der Detail-Stufe steht der Stationsname im Icon — dort gehört der
// Stationscode mit in den Schlüssel.
function iconCacheKey(
  station: WindStation,
  tier: ZoomTier,
  showLabel: boolean,
): string {
  if (station.stale) return `stale|${tier}`;
  const dir = station.direction === null ? "x" : snapDirectionTo8(station.direction);
  const speed = station.speedKmh === null ? "x" : Math.round(station.speedKmh);
  const gust = station.gustKmh === null ? "x" : Math.round(station.gustKmh);
  const named = tier === "detail" && showLabel ? station.stationCode : "";
  return `wind|${dir}|${speed}|${gust}|${tier}|${showLabel ? "z" : "-"}|${named}`;
}

function getMarkerIcon(
  station: WindStation,
  tier: ZoomTier,
  showLabel: boolean,
): L.DivIcon {
  const key = iconCacheKey(station, tier, showLabel);
  const cached = iconCache.get(key);
  if (cached) {
    // Neu einsortieren = "zuletzt benutzt", damit der Deckel unten die
    // richtigen Icons wegwirft.
    iconCache.delete(key);
    iconCache.set(key, cached);
    return cached;
  }
  const icon = station.stale
    ? createStaleIcon(tier)
    : createWindIcon(station, tier, showLabel);
  iconCache.set(key, icon);
  while (iconCache.size > ICON_CACHE_LIMIT) {
    const oldest = iconCache.keys().next().value;
    if (oldest === undefined) break;
    iconCache.delete(oldest);
  }
  return icon;
}

// Rendert die Windmarker und hält ihre Darstellung mit dem aktuellen Zoom
// synchron (siehe getZoomTier). Muss innerhalb von <MapContainer> stehen,
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
  // Bewusst nur der Stationscode (nicht das ganze Stations-Objekt): so bleibt
  // der Klick-Handler eines Markers über alle Aktualisierungen hinweg
  // derselbe — siehe handlersByCode unten.
  onSelect: (stationCode: string) => void;
  selectedStationCode: string | null;
}) {
  const [zoom, setZoom] = useState(SOUTH_TYROL_ZOOM);
  const map = useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });
  const tier = getZoomTier(zoom);
  const showLabels = shouldShowLabels(zoom);
  const selectedStation = stations.find(
    (s) => s.stationCode === selectedStationCode && s.lat !== null && s.lng !== null,
  );
  // Radius so bemessen, dass sowohl der Pfeil als auch die Zahlen-Plakette
  // darunter innerhalb des Kreises liegen (Anker sitzt in der Pfeilmitte).
  // Ohne Zahlen (herausgezoomt) umschließt der Kreis nur den Pfeil.
  const selectionRadius = Math.round(
    ARROW_SIZE[tier] / 2 + (showLabels ? LABEL_HEIGHT_PX[tier] : 0) + 4,
  );

  const positionedStations = useMemo(
    () => stations.filter((s) => s.lat !== null && s.lng !== null),
    [stations],
  );

  // Welche Stationen in der Übersicht ausgedünnt werden (siehe
  // THIN_DISTANCE_FACTOR). null = keine. Gerechnet wird in Bildschirmpixeln
  // der aktuellen Zoomstufe; map.project mit fester Zoomstufe hängt nicht vom
  // Kartenausschnitt ab, Verschieben löst also keine Neuberechnung aus.
  // Auch bei ~560 Stationen ist das nur ein paar Zehntausend Abstandsvergleiche
  // — schnell genug, um bei jedem Schritt im Zeitbalken neu zu laufen.
  const thinOut = tier === "overview";
  const hiddenCodes = useMemo(() => {
    if (!thinOut) return null;
    const minDistance = ARROW_SIZE.overview * THIN_DISTANCE_FACTOR;
    const minDistanceSq = minDistance * minDistance;
    const hidden = new Set<string>();
    const candidates: WindStation[] = [];
    for (const s of positionedStations) {
      if (s.stale) hidden.add(s.stationCode);
      else candidates.push(s);
    }
    candidates.sort(
      (a, b) =>
        (b.altitude ?? -1) - (a.altitude ?? -1) || a.stationCode.localeCompare(b.stationCode),
    );
    const kept: L.Point[] = [];
    for (const s of candidates) {
      const p = map.project([s.lat!, s.lng!], zoom);
      const overlaps = kept.some((k) => {
        const dx = k.x - p.x;
        const dy = k.y - p.y;
        return dx * dx + dy * dy < minDistanceSq;
      });
      if (overlaps) hidden.add(s.stationCode);
      else kept.push(p);
    }
    return hidden;
  }, [thinOut, positionedStations, map, zoom]);

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
          icon={
            hiddenCodes?.has(station.stationCode)
              ? HIDDEN_ICON
              : getMarkerIcon(station, tier, showLabels)
          }
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
  historyFrame,
  refreshToken,
}: {
  baseLayer: BaseLayer;
  stationFilter: StationFilter;
  /** Aus dem Zeitbalken gewählter Verlaufs-Zeitpunkt; null = Live-Werte. */
  historyFrame: TimelineFrame | null;
  /**
   * Zähler des Refresh-Buttons im Titel-Balken (WindApp). Jede Erhöhung holt
   * sofort frische Live-Werte (und den Verlauf einer offenen Station).
   */
  refreshToken: number;
}) {
  const [stations, setStations] = useState<WindStation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedStationCode, setSelectedStationCode] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Die Filterung hängt nur an der Stationsliste und dem gewählten Filter —
  // useMemo verhindert, dass sie bei jedem Neuzeichnen (z. B. beim Zoomen)
  // erneut über alle ~130 Stationen läuft.
  const visibleStations = useMemo(() => {
    // "Alle" braucht gar nicht erst durchlaufen zu werden — so bleibt auch die
    // Liste selbst unverändert (gleiche Referenz), was ein unnötiges
    // Neuzeichnen der Karte spart.
    if (stationFilter === "all") return stations;
    return stations.filter((s) => matchesStationFilter(s, stationFilter));
  }, [stations, stationFilter]);

  // Zeitbalken: Steht er nicht auf "jetzt", werden bei den sichtbaren
  // Stationen die MESSWERTE durch die des gewählten Zeitpunkts ersetzt —
  // Name, Koordinaten und Reihenfolge bleiben unangetastet.
  //
  // Das ist wichtig und kein Zufall: Die Klick-Handler der Marker hängen an
  // der reinen Liste der Stationscodes (siehe handlersByCode in WindMarkers).
  // Würde man Stationen ohne Messwert einfach weglassen, müssten bei jedem
  // Schritt alle ~130 Handler neu angemeldet werden. Stationen ohne Wert
  // werden deshalb grau (stale) statt entfernt — genau wie im Live-Betrieb bei
  // einem Sensorausfall.
  //
  // Erst filtern, dann ersetzen: bei aktivem Filter sind das ein paar Dutzend
  // statt ~130 Objekte pro Schritt.
  const displayStations = useMemo(() => {
    if (!historyFrame) return visibleStations;
    const timestamp = new Date(historyFrame.time).toISOString();
    return visibleStations.map((station) => {
      const value = historyFrame.values.get(station.stationCode);
      const direction = value?.direction ?? null;
      const speedKmh = value?.speedKmh ?? null;
      const gustKmh = value?.gustKmh ?? null;
      return {
        ...station,
        direction,
        speedKmh,
        gustKmh,
        timestamp,
        // Gleiche Regel wie bei den Live-Werten in /api/wind.
        stale: direction === null || speedKmh === null,
      };
    });
  }, [visibleStations, historyFrame]);

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

  // Zeigt auf die jeweils aktuelle loadWind-Funktion aus dem Abruf-Effekt
  // unten, damit der Refresh-Button sie von außen anstoßen kann, ohne dass
  // dafür Takt und visibilitychange-Zuhörer neu angemeldet werden müssen.
  const loadWindRef = useRef<(() => Promise<void>) | null>(null);

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
    loadWindRef.current = () => loadWind(false);
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
      loadWindRef.current = null;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // Refresh-Button: sofort frische Werte holen. Beim ersten Aufbau (Zähler 0)
  // nichts tun — da lädt der Effekt oben ohnehin schon. Wie beim Takt bleiben
  // bei einem Fehlschlag die bisherigen Pfeile stehen.
  useEffect(() => {
    if (refreshToken === 0) return;
    void loadWindRef.current?.();
  }, [refreshToken]);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={SOUTH_TYROL_CENTER}
        zoom={SOUTH_TYROL_ZOOM}
        maxZoom={MAP_MAX_ZOOM}
        zoomControl={false}
        // Leaflets Quellen-Zeile unten rechts ist aus: Sie belegte auf dem
        // Handy zwei Zeilen und schob sich über "Zuletzt aktualisiert". Die
        // Quellenangaben stehen stattdessen im Menü-Popup (MAP_SOURCES in
        // src/lib/wind.ts) — NICHT ersatzlos streichen, sie sind Pflicht.
        attributionControl={false}
        className="h-full w-full"
        style={{ background: MAP_BACKGROUND }}
      >
        {/* Die key-Attribute sorgen dafür, dass beim Umschalten die alten
            Kachel-Ebenen komplett entfernt und neue angelegt werden.

            Die Kachel-Adressen stehen bewusst OHNE das früher übliche
            "{s}."-Kürzel (a./b./c.-Unterdomains). Das stammt noch aus der
            HTTP/1-Zeit, als Browser pro Server nur wenige Downloads
            gleichzeitig erlaubten. Mit HTTP/2 lädt EINE Verbindung alle
            Kacheln parallel — drei Unterdomains bedeuten dann nur drei
            getrennte Verbindungsaufbauten (langsamer, vor allem im
            Mobilfunk). OpenStreetMap rät inzwischen selbst davon ab. */}
        {baseLayer === "topo" ? (
          // OpenTopoMap (Standardkarte): bringt Höhenlinien, Schummerung und
          // Ortsnamen schon selbst mit, deshalb keine weiteren Ebenen darüber.
          // Die Klasse .topo-ebene (globals.css) macht daraus eine sehr
          // helle Graustufenkarte, damit die Windfarben leuchten.
          <TileLayer
            key="opentopomap"
            url={TOPO_URL}
            className="topo-ebene"
            maxNativeZoom={TOPO_MAX_NATIVE_ZOOM}
          />
        ) : (
          <>
            <TileLayer
              key="esri-hillshade"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"
              zIndex={Z_HILLSHADE}
              opacity={HILLSHADE_OPACITY}
            />
            {/* Höhenlinien des Landes Südtirol, nur bei "Relief (Grau)":
                Bei "OpenTopoMap" sind Höhenlinien schon im Kartenbild
                enthalten. Weil dieser Zweig nur im Relief-Fall gerendert
                wird, ist die Ebene bei "OpenTopoMap" gar nicht erst
                vorhanden und fragt auch nichts ab.
                Fällt der Landesserver aus, bleiben die Kacheln dank
                errorTileUrl einfach leer (siehe TRANSPARENT_TILE oben). */}
            <WMSTileLayer
              key="hoehenlinien"
              url={CONTOUR_WMS_URL}
              layers={CONTOUR_WMS_LAYER}
              format="image/png"
              transparent
              version="1.3.0"
              minZoom={CONTOUR_MIN_ZOOM}
              opacity={CONTOUR_OPACITY}
              className="hoehenlinien-ebene"
              errorTileUrl={TRANSPARENT_TILE}
              zIndex={Z_CONTOURS}
            />
            {/* Ortsnamen obenauf. Mit CARTO-Schlüssel (Umgebungsvariable,
                siehe CARTO_API_KEY in wind.ts) die CARTO-Namen — zweisprachig
                deutsch/italienisch. Ohne Schlüssel liefert CARTO seit
                Sept. 2026 nur "API KEY REQUIRED"-Wasserzeichen; dann
                ersatzweise die Esri-Ortsnamen (kein Schlüssel nötig, aber nur
                italienische Namen). Unterschiedliche key-Attribute, damit
                Leaflet beim Wechsel die Ebene sauber neu anlegt. */}
            {CARTO_API_KEY ? (
              <TileLayer
                key="carto-labels"
                url={`${CARTO_LABELS_URL}?key=${encodeURIComponent(CARTO_API_KEY)}`}
                zIndex={Z_LABELS}
              />
            ) : (
              <TileLayer
                key="esri-labels"
                url={ESRI_LABELS_URL}
                zIndex={Z_LABELS}
              />
            )}
          </>
        )}
        <GeoJSON
          data={staatsgrenzen as GeoJSON.GeoJsonObject}
          style={STAATSGRENZE_STYLE}
          interactive={false}
        />
        <WindMarkers
          stations={displayStations}
          onSelect={handleSelect}
          selectedStationCode={selectedStationCode}
        />
      </MapContainer>
      {/* Zeigt die Karte gerade einen Zeitpunkt aus dem Zeitbalken, bleibt die
          Plakette weg — die Uhrzeit steht dann ohnehin im Zeitbalken. */}
      {!historyFrame && lastUpdated ? (
        <div className="absolute bottom-4 left-4 z-[1000] rounded-md bg-white/85 px-2 py-1 text-xs text-zinc-600 shadow-md dark:bg-zinc-900/80 dark:text-zinc-300">
          Zuletzt aktualisiert:{" "}
          {lastUpdated.toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      ) : null}
      {error && (
        <div className="absolute top-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          {error}
        </div>
      )}
      {selectedStation && (
        <WindHistoryPanel
          station={selectedStation}
          onClose={() => setSelectedStationCode(null)}
          markerTime={historyFrame?.time ?? null}
          refreshToken={refreshToken}
        />
      )}
    </div>
  );
}
