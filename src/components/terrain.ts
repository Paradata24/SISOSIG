import { useEffect } from "react";
import L from "leaflet";
import {
  ASPECT_COLORS,
  COMPASS_DIRECTIONS,
  compassDegrees,
  LEE_COLOR,
  LEE_HALF_ANGLE_DEG,
  TERRAIN_MIN_ZOOM,
  type CompassDirection,
} from "@/lib/terrain";

// --- Gelände-Ebenen der Hauptseite (Nov. 2026, Wunsch des Projektbesitzers) ---
// Hangausrichtung (in welche Himmelsrichtung ein Hang abfällt) und Lee-Hänge
// zur Windrose (rot = vom gewählten Wind abgewandte Hänge). Nachgebaut nach
// der Karte im Wolkenatlas: Fertige Kacheln dafür gibt es nicht, der Browser
// rechnet sie selbst aus freien Höhendaten ("Terrain Tiles" auf Amazon, ohne
// Schlüssel und ohne Konto). Jeder Bildpunkt dieser Kacheln ist eine Höhe; aus
// dem Unterschied zu den Nachbarpunkten ergibt sich, wohin der Hang schaut.
// Schalter im Ebenen-Menü (LayerMenu), Windrose auf der Karte
// (WindRosePicker), eingebunden über MainPageLayers in WindMap.

const TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// Feiner gibt es die Höhenkacheln nicht — darüber würde vergrößert (die
// Hauptseite geht ohnehin nur bis Zoom 15, MAP_MAX_ZOOM).
const TERRAIN_DATA_MAX_ZOOM = 15;
// Flache Stellen (Talböden, Hochflächen) schauen nirgendwohin und bleiben
// ohne Farbe — wie im Wolkenatlas.
const FLAT_BELOW_DEG = 5;
// Deckkraft wie im Wolkenatlas für die Ausrichtung (deckt fast alles, darum
// durchsichtig, damit Höhenlinien und Namen lesbar bleiben). Lee: "Rot
// halbtransparent" (Wunsch des Projektbesitzers).
const ASPECT_OPACITY = 0.55;
const LEE_OPACITY = 0.45;
// Über OpenTopoMap (1) und KK7 (2), Lee über der Ausrichtung — alle
// Kachel-Ebenen liegen unter Kabeln und Windpfeilen.
const ASPECT_Z_INDEX = 3;
const LEE_Z_INDEX = 4;
// Höhenkacheln merken, damit Umschalten der Windrichtung und Verschieben nicht
// alles neu laden. Eine Kachel braucht 256 KB; 64 Stück = 16 MB.
const HEIGHT_CACHE_MAX = 64;

const heightCache = new Map<string, Promise<Float32Array>>();

function loadHeights(z: number, x: number, y: number): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`;
  const hit = heightCache.get(key);
  if (hit) {
    // Zuletzt benutzt nach hinten, damit die ältesten zuerst rausfliegen.
    heightCache.delete(key);
    heightCache.set(key, hit);
    return hit;
  }
  const promise = new Promise<Float32Array>((resolve, reject) => {
    const img = new Image();
    // Nötig, um die Bildpunkte auslesen zu dürfen (Amazon erlaubt das).
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return reject(new Error("Kein Canvas"));
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, 256, 256).data;
      // So steckt die Höhe in den Farben: Rot·256 + Grün + Blau/256 − 32768 m.
      const heights = new Float32Array(256 * 256);
      for (let i = 0; i < heights.length; i++) {
        heights[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
      }
      resolve(heights);
    };
    img.onerror = () => reject(new Error("Höhenkachel nicht erreichbar"));
    img.src = TERRAIN_URL.replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  });
  // Gescheiterte Kacheln nicht merken — beim nächsten Mal neu versuchen.
  promise.catch(() => heightCache.delete(key));
  heightCache.set(key, promise);
  if (heightCache.size > HEIGHT_CACHE_MAX) {
    heightCache.delete(heightCache.keys().next().value as string);
  }
  return promise;
}

// Farbe eines Bildpunkts aus der Hangrichtung (aspectDeg = Richtung, in die
// der Hang abfällt, 0 = Nord); null = durchsichtig lassen.
type Painter = (aspectDeg: number) => readonly [number, number, number] | null;

function aspectPainter(aspectDeg: number) {
  return ASPECT_COLORS[COMPASS_DIRECTIONS[Math.round(aspectDeg / 45) % 8]];
}

// Lee: Wind aus `windFrom` → vom Wind abgewandte Hänge fallen in die
// Gegenrichtung ab (Wind aus Ost → Westhänge).
function leePainter(windFrom: CompassDirection): Painter {
  const leeDeg = (compassDegrees(windFrom) + 180) % 360;
  return (aspectDeg) => {
    const diff = Math.abs(((aspectDeg - leeDeg + 540) % 360) - 180);
    return diff <= LEE_HALF_ANGLE_DEG ? LEE_COLOR : null;
  };
}

// Aus den Höhen einer Kachel ein Farbbild machen (wie gelFaerben im
// Wolkenatlas).
function paintTile(heights: Float32Array, z: number, y: number, painter: Painter) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const image = ctx.createImageData(256, 256);
  const px = image.data;
  const worldPx = 256 * 2 ** z;
  for (let r = 0; r < 256; r++) {
    // Wie viele Meter ein Bildpunkt misst — je weiter nördlich, desto weniger.
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * 256 + r + 0.5)) / worldPx)));
    const metersPerPx = (40075016.686 * Math.cos(lat)) / worldPx;
    const r0 = Math.max(r - 1, 0);
    const r1 = Math.min(r + 1, 255);
    for (let s = 0; s < 256; s++) {
      const s0 = Math.max(s - 1, 0);
      const s1 = Math.min(s + 1, 255);
      // Anstieg nach Osten und nach Norden, in Metern pro Meter.
      const east = (heights[r * 256 + s1] - heights[r * 256 + s0]) / ((s1 - s0) * metersPerPx);
      const north = (heights[r0 * 256 + s] - heights[r1 * 256 + s]) / ((r1 - r0) * metersPerPx);
      const slopeDeg = (Math.atan(Math.hypot(east, north)) * 180) / Math.PI;
      if (slopeDeg < FLAT_BELOW_DEG) continue;
      // Der Hang fällt entgegen dem Anstieg ab.
      const aspectDeg = ((Math.atan2(-east, -north) * 180) / Math.PI + 360) % 360;
      const rgb = painter(aspectDeg);
      if (!rgb) continue;
      const i = (r * 256 + s) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// Leaflet-Ebene, die jede Kachel selbst aus den Höhen rechnet.
class TerrainLayer extends L.GridLayer {
  private painter: Painter;

  constructor(painter: Painter, options: L.GridLayerOptions) {
    super(options);
    this.painter = painter;
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 256;
    // Über Zoom 15 die passende Höhenkachel ausschneiden und vergrößern.
    const dataZoom = Math.min(coords.z, TERRAIN_DATA_MAX_ZOOM);
    const factor = 2 ** (coords.z - dataZoom);
    const x = Math.floor(coords.x / factor);
    const y = Math.floor(coords.y / factor);
    const part = 256 / factor;
    loadHeights(dataZoom, x, y)
      .then((heights) => {
        tile
          .getContext("2d")
          ?.drawImage(
            paintTile(heights, dataZoom, y, this.painter),
            (coords.x % factor) * part,
            (coords.y % factor) * part,
            part,
            part,
            0,
            0,
            256,
            256,
          );
        done(undefined, tile);
      })
      // Nicht erreichbar: Die Stelle bleibt einfach ohne Farbe.
      .catch(() => done(undefined, tile));
    return tile;
  }
}

function useTerrainLayer(
  map: L.Map | null,
  painter: Painter | null,
  opacity: number,
  zIndex: number,
) {
  useEffect(() => {
    if (!map || !painter) return;
    const layer = new TerrainLayer(painter, {
      minZoom: TERRAIN_MIN_ZOOM,
      opacity,
      zIndex,
    }).addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, painter, opacity, zIndex]);
}

/** Hangausrichtung in den acht Farben (ASPECT_COLORS). */
export function useAspectLayer(map: L.Map | null, enabled: boolean) {
  useTerrainLayer(map, enabled ? aspectPainter : null, ASPECT_OPACITY, ASPECT_Z_INDEX);
}

// Ein Maler je Windrichtung, damit die Ebene nur beim Wechsel der Richtung
// neu angelegt wird (nicht bei jedem Neuzeichnen von WindMap).
const leePainters = new Map<CompassDirection, Painter>();
function getLeePainter(windFrom: CompassDirection): Painter {
  let painter = leePainters.get(windFrom);
  if (!painter) {
    painter = leePainter(windFrom);
    leePainters.set(windFrom, painter);
  }
  return painter;
}

/** Lee-Hänge zur gewählten Windrichtung rot; null = keine Ebene. */
export function useLeeLayer(map: L.Map | null, windFrom: CompassDirection | null) {
  useTerrainLayer(map, windFrom ? getLeePainter(windFrom) : null, LEE_OPACITY, LEE_Z_INDEX);
}
