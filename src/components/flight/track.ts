import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import { exportIgc } from "./igc";
import type { OwnPosition } from "./position";

// --- Track-Aufzeichnung ---
// Start-Taste im Flugmodus: Ab dann wird der geflogene Weg als violette Linie
// auf der Karte gezeichnet. Stop unterbricht nur — erneutes Start setzt
// denselben Track fort (ein versehentliches Stop mit Handschuhen kostet so
// nichts). Neu beginnen = Track über die Papierkorb-Taste löschen.
//
// Gespeichert wird im Browser des Handys (localStorage), nicht in der
// Datenbank: Der Track gehört nur diesem Gerät, und er übersteht so ein
// Neuladen der Seite, ein Beenden und Wiederöffnen des Flugmodus oder einen
// Absturz des Browsers. War die Aufzeichnung beim Verlassen an, läuft sie beim
// nächsten Öffnen des Flugmodus weiter.
// Einschränkung wie beim Standort: Aufgezeichnet wird nur, solange die Seite
// offen und im Vordergrund ist. Lücken (Bildschirm aus, andere App) bleiben
// sichtbar als Lücke in der Linie (TRACK_GAP_MS).

const TRACK_STORAGE_KEY = "sisosig-flugtrack-v1";
// Violett: kommt in der Windskala (Blau/Grün/Gelb/Orange/Rot) nicht vor und
// unterscheidet sich vom blauen eigenen Standort.
export const TRACK_COLOR = "#a21caf";
// Neuer Punkt erst ab diesem Abstand zum letzten. Spart Speicher und
// Zeichenarbeit (im Flug mit ~30 km/h etwa alle 2 s ein Punkt) und filtert
// das GPS-Zittern im Stand heraus.
const TRACK_MIN_STEP_M = 15;
// Ungenaue GPS-Werte (z. B. kurz nach dem Start) werden nicht aufgezeichnet,
// sonst entstehen Zacken.
const TRACK_MAX_ACCURACY_M = 50;
// Längere Pause zwischen zwei Werten = Lücke: Die Linie verbindet die beiden
// Stellen dann nicht mit einer geraden Linie.
const TRACK_GAP_MS = 60_000;
// Wie oft der Track höchstens gespeichert wird. Bei jedem GPS-Wert zu
// speichern würde nach ein paar Stunden (~10.000 Punkte) jede Sekunde ein paar
// hundert KB schreiben — unnötige Akku-Last. Zusätzlich wird bei Start/Stop,
// beim Verlassen und wenn die Seite in den Hintergrund geht gespeichert.
const TRACK_SAVE_INTERVAL_MS = 15_000;

// Ein Punkt: [Breite, Länge, Zeit in s seit 1970, GPS-Höhe in m oder null].
// Zeit und Höhe gibt es erst seit dem IGC-Export (Okt. 2026); ältere
// gespeicherte Tracks haben nur [Breite, Länge] und bleiben lesbar.
export type TrackPoint = [number, number] | [number, number, number, number | null];

type StoredTrack = {
  recording: boolean;
  /** Teilstücke ohne Lücke. */
  segments: TrackPoint[][];
  /** Zeitpunkt des letzten Punkts (für die Lücken-Erkennung). */
  lastTime: number | null;
};

function loadTrack(): StoredTrack {
  try {
    const raw = window.localStorage.getItem(TRACK_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as StoredTrack;
      if (Array.isArray(data.segments)) return data;
    }
  } catch {
    // Privater Modus, gesperrter Speicher, kaputter Inhalt: leer beginnen.
  }
  return { recording: false, segments: [], lastTime: null };
}

function saveTrack(track: StoredTrack) {
  try {
    window.localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(track));
  } catch {
    // Speicher voll oder gesperrt: Die Linie bleibt trotzdem auf der Karte,
    // sie übersteht dann nur kein Neuladen.
  }
}

// Leaflet versteht nur [Breite, Länge(, Höhe)] — ein Punkt mit vier Werten
// würde verworfen. Deshalb vor dem Zeichnen auf zwei Werte kürzen.
function pointLatLng(p: TrackPoint): L.LatLng {
  return L.latLng(p[0], p[1]);
}

// Die Linie auf der Karte, in Stücken zu höchstens TRACK_CHUNK_POINTS Punkten
// (je Stück eine eigene Leaflet-Linie). Ein neuer GPS-Punkt verlängert nur das
// jüngste Stück. Bis Okt. 2026 wurde bei jedem Punkt (im Flug etwa alle 2 s)
// die GANZE Linie neu umgerechnet und gezeichnet — nach drei Stunden über
// 5.000 Punkte, unnötige Akku-Last. Ein neues Stück beginnt am letzten Punkt
// des vorigen, die Linie bleibt also durchgehend; nur ein neues Teilstück
// (Lücke, Start nach Stop) beginnt ohne Verbindung.
const TRACK_CHUNK_POINTS = 200;
const TRACK_LINE_STYLE: L.PolylineOptions = {
  color: TRACK_COLOR,
  weight: 3,
  opacity: 0.9,
  interactive: false,
};

type TrackLine = {
  /** Punkt anhängen; newSegment = erster Punkt eines neuen Teilstücks. */
  add: (point: TrackPoint, newSegment: boolean) => void;
  clear: () => void;
  remove: () => void;
};

function createTrackLine(map: L.Map): TrackLine {
  const group = L.layerGroup().addTo(map);
  let active: L.Polyline | null = null;
  return {
    add(point, newSegment) {
      const latLng = pointLatLng(point);
      if (newSegment || !active) {
        active = L.polyline([latLng], TRACK_LINE_STYLE).addTo(group);
        return;
      }
      const latLngs = active.getLatLngs() as L.LatLng[];
      if (latLngs.length >= TRACK_CHUNK_POINTS) {
        active = L.polyline([latLngs[latLngs.length - 1], latLng], TRACK_LINE_STYLE).addTo(group);
      } else {
        active.addLatLng(latLng);
      }
    },
    clear() {
      group.clearLayers();
      active = null;
    },
    remove() {
      group.remove();
    },
  };
}

function trackLengthM(segments: TrackPoint[][]): number {
  let total = 0;
  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++) {
      total += pointLatLng(segment[i - 1]).distanceTo(pointLatLng(segment[i]));
    }
  }
  return total;
}

// Aufzeichnung, Speicher und die Linie auf der Karte. Der Track selbst liegt
// in einem ref (nicht im state): Er wächst mit jedem GPS-Wert und wird nur
// von Leaflet gezeichnet, React braucht ihn nicht. Für die Anzeige gibt es
// nur Aufzeichnungs-Zustand, Länge und "gibt es einen Track".
export function useTrack(map: L.Map | null, position: OwnPosition | null) {
  const track = useRef<StoredTrack | null>(null);
  const [recording, setRecording] = useState(false);
  const [lengthM, setLengthM] = useState(0);
  const dirty = useRef(false);
  const lineRef = useRef<TrackLine | null>(null);

  // Gespeicherten Track laden und die Linie anlegen (einmal je Flugmodus).
  // Die setState-Aufrufe sitzen bewusst in requestAnimationFrame: Laden aus
  // dem Browser-Speicher geht nur im Browser, also erst nach dem Aufbau.
  useEffect(() => {
    if (!map) return;
    const loaded = loadTrack();
    track.current = loaded;
    const line = createTrackLine(map);
    for (const segment of loaded.segments) {
      segment.forEach((point, i) => line.add(point, i === 0));
    }
    lineRef.current = line;
    const frame = requestAnimationFrame(() => {
      setRecording(loaded.recording);
      setLengthM(trackLengthM(loaded.segments));
    });

    const flush = () => {
      if (dirty.current && track.current) {
        saveTrack(track.current);
        dirty.current = false;
      }
    };
    const interval = setInterval(flush, TRACK_SAVE_INTERVAL_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onHide);
      flush();
      lineRef.current?.remove();
      lineRef.current = null;
      track.current = null;
    };
  }, [map]);

  // Jeden neuen GPS-Wert prüfen und ggf. anhängen.
  useEffect(() => {
    const t = track.current;
    if (!t || !t.recording || !position) return;
    if (position.accuracyM > TRACK_MAX_ACCURACY_M) return;
    const point: TrackPoint = [
      Math.round(position.lat * 1e5) / 1e5,
      Math.round(position.lng * 1e5) / 1e5,
      Math.round(position.time / 1000),
      position.altitudeM === null ? null : Math.round(position.altitudeM),
    ];
    let segment = t.segments[t.segments.length - 1];
    const isGap = t.lastTime !== null && position.time - t.lastTime > TRACK_GAP_MS;
    if (!segment || (isGap && segment.length > 0)) {
      segment = [];
      t.segments.push(segment);
    }
    const last = segment[segment.length - 1];
    let step = 0;
    if (last) {
      step = pointLatLng(last).distanceTo(pointLatLng(point));
      if (step < TRACK_MIN_STEP_M) {
        // Zu nah am letzten Punkt: nicht speichern, aber als "noch da"
        // werten, damit langsames Fliegen keine Lücke erzeugt.
        t.lastTime = position.time;
        return;
      }
    }
    segment.push(point);
    t.lastTime = position.time;
    dirty.current = true;
    lineRef.current?.add(point, segment.length === 1);
    if (step > 0) setLengthM((m) => m + step);
  }, [position]);

  const start = useCallback(() => {
    const t = track.current;
    if (!t) return;
    t.recording = true;
    // Neues Teilstück: Nach einer Pause wird nicht quer übers Tal verbunden.
    if (t.segments.length === 0 || t.segments[t.segments.length - 1].length > 0) {
      t.segments.push([]);
    }
    saveTrack(t);
    dirty.current = false;
    setRecording(true);
  }, []);

  const stop = useCallback(() => {
    const t = track.current;
    if (!t) return;
    t.recording = false;
    saveTrack(t);
    dirty.current = false;
    setRecording(false);
  }, []);

  const clear = useCallback(() => {
    const t = track.current;
    if (!t) return;
    if (!window.confirm("Bisherigen Track löschen?")) return;
    t.segments = [];
    t.lastTime = null;
    saveTrack(t);
    dirty.current = false;
    lineRef.current?.clear();
    setLengthM(0);
  }, []);

  const exportFile = useCallback(() => {
    if (track.current) void exportIgc(track.current.segments);
  }, []);

  return { recording, lengthM, start, stop, clear, exportFile };
}
