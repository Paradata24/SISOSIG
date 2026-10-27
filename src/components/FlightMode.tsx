"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import L from "leaflet";
import { CABLE_HEIGHT_CLASSES, type CablePayload } from "@/lib/kabel";

// Flugmodus ("Flightcomputer", Okt. 2026, Wunsch des Projektbesitzers):
// Angetippt über "GO" im Titel (WindApp). Die Karte füllt dann den ganzen
// Bildschirm, Titel- und Zeitbalken sind weg, und diese Datei legt darüber:
//   - den eigenen Standort mit Flugrichtung (blauer Punkt mit Spitze)
//   - große Plus-/Minus-Tasten und eine Rücksetztaste (handschuhtauglich)
//   - eine Sperre gegen das automatische Abschalten des Bildschirms
// Die Windpfeile kommen unverändert von WindMap und werden dort weiter alle
// 3 min aufgefrischt.
//
// Bewusst als Teil der Website gebaut, nicht als eigene App: Standort und
// Bildschirm-Wachhalten können moderne Browser selbst. Einschränkung: Die Seite
// muss offen und im Vordergrund bleiben — im Hintergrund hält der Browser GPS
// und Abrufe an.

// Zoomstufe der Rücksetztaste (und beim ersten GPS-Fix). 15, Wunsch des
// Projektbesitzers (Okt. 2026, vorher 11); hineinzoomen geht im Flugmodus
// noch eine Stufe weiter (FLIGHT_MAX_ZOOM in WindMap): am Handy rund 1–2 km Kartenbreite, Gelände, Kabel und deren
// Höhen-Schilder (ab 15) im Detail. Für den Überblick über die Windstationen
// herauszoomen.
const FLIGHT_ZOOM = 15;
// Zoomstufe der Übersichtstaste (Wunsch des Projektbesitzers, Okt. 2026):
// eigener Standort mit rund 60 km Kartenbreite am Handy, die Zahlen der
// Windpfeile sind ab hier sichtbar (LABEL_MIN_ZOOM in WindMap).
const OVERVIEW_ZOOM = 10;

// Unterhalb dieser Geschwindigkeit ist die GPS-Flugrichtung nur Rauschen
// (rund 4 km/h). Dann bleibt die zuletzt gültige Richtung stehen.
const MIN_HEADING_SPEED_MS = 1.2;
// Liefert der Browser keine Richtung (manche Android-Browser), wird sie aus
// zwei Positionen errechnet — aber erst ab diesem Abstand, sonst springt sie
// durch die GPS-Ungenauigkeit hin und her.
const MIN_HEADING_DISTANCE_M = 25;

// Beim Mitführen wird die Karte erst verschoben, wenn der Standort so weit
// (Bildschirmpixel) von der Mitte abgewandert ist. Spart Akku: Sonst würde die
// Karte bei jedem GPS-Wert (ca. 1× pro Sekunde) neu gezeichnet.
const FOLLOW_TOLERANCE_PX = 12;

// GPS-Einstellungen. enableHighAccuracy ist nötig: Ohne echtes GPS gibt es
// keine Flugrichtung. maximumAge: ein höchstens 2 s alter Wert darf
// wiederverwendet werden.
const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 30_000,
};

const OWN_POSITION_COLOR = "#2563eb";

type OwnPosition = {
  lat: number;
  lng: number;
  accuracyM: number;
  /** Flugrichtung in Grad (0 = Nord), null = noch unbekannt. */
  heading: number | null;
  /** Zeitpunkt der Messung (ms seit 1970), für die Track-Aufzeichnung. */
  time: number;
  /** GPS-Höhe in m (für den IGC-Track), null = vom Gerät nicht geliefert. */
  altitudeM: number | null;
};

type GpsStatus = "searching" | "ok" | "denied" | "unavailable";

// Richtung (Grad, 0 = Nord, im Uhrzeigersinn) von Punkt a nach Punkt b.
function bearingDeg(a: L.LatLng, b: L.LatLng): number {
  const toRad = Math.PI / 180;
  const φ1 = a.lat * toRad;
  const φ2 = b.lat * toRad;
  const Δλ = (b.lng - a.lng) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Standort laufend verfolgen, solange der Flugmodus an ist. Die Flugrichtung
// kommt aus dem GPS (wohin man sich bewegt), nicht aus dem Kompass: Sie ist
// im Flug die aussagekräftigere Angabe, braucht am iPhone keine zusätzliche
// Erlaubnis und stimmt auch, wenn das Handy schräg im Cockpit hängt.
function useOwnPosition(): { position: OwnPosition | null; status: GpsStatus } {
  const [position, setPosition] = useState<OwnPosition | null>(null);
  const [status, setStatus] = useState<GpsStatus>(() =>
    typeof navigator !== "undefined" && "geolocation" in navigator ? "searching" : "unavailable",
  );
  // Letzte gültige Richtung und der Punkt, an dem sie zuletzt errechnet wurde
  // (für den Ersatz aus zwei Positionen, siehe MIN_HEADING_DISTANCE_M).
  const lastHeading = useRef<number | null>(null);
  const headingAnchor = useRef<L.LatLng | null>(null);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy, heading, speed, altitude } = pos.coords;
        const here = L.latLng(latitude, longitude);
        // Ältere iPhones melden eine ungültige Richtung als -1 statt null.
        const headingValid = heading !== null && !Number.isNaN(heading) && heading >= 0;
        if (headingValid) {
          // Im Stand ist die GPS-Richtung Rauschen: dann die alte behalten.
          if (speed === null || speed >= MIN_HEADING_SPEED_MS) {
            lastHeading.current = heading;
            headingAnchor.current = here;
          }
        } else if (accuracy <= MIN_HEADING_DISTANCE_M) {
          // Ersatz: Richtung aus der Bewegung seit dem letzten Bezugspunkt —
          // nur bei genauem GPS, sonst erzeugt das Zittern falsche Richtungen.
          const anchor = headingAnchor.current;
          if (!anchor) {
            headingAnchor.current = here;
          } else if (anchor.distanceTo(here) >= MIN_HEADING_DISTANCE_M) {
            lastHeading.current = bearingDeg(anchor, here);
            headingAnchor.current = here;
          }
        }
        setPosition({
          lat: latitude,
          lng: longitude,
          accuracyM: accuracy,
          heading: lastHeading.current,
          time: pos.timestamp,
          altitudeM: altitude,
        });
        setStatus("ok");
      },
      (err) => {
        // Nach einem Zeitüberschreitungs-Fehler sucht der Browser weiter; der
        // Status bleibt dann "searching", bis wieder ein Wert kommt.
        if (err.code === err.PERMISSION_DENIED) setStatus("denied");
        else if (err.code === err.POSITION_UNAVAILABLE) setStatus("unavailable");
      },
      GEO_OPTIONS,
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  return { position, status };
}

// Bildschirm wach halten, solange der Flugmodus an ist ("Screen Wake Lock",
// am iPhone ab iOS 16.4). Der Browser gibt die Sperre von selbst frei, sobald
// die Seite in den Hintergrund geht — beim Zurückkommen wird sie deshalb neu
// angefordert. Ergebnis: true = aktiv, false = vom Browser nicht unterstützt
// oder abgelehnt, null = wird gerade angefordert.
function useWakeLock(): boolean | null {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [active, setActive] = useState<boolean | null>(supported ? null : false);

  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const request = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock
        .request("screen")
        .then((s) => {
          if (cancelled) {
            void s.release();
            return;
          }
          sentinel = s;
          setActive(true);
          s.addEventListener("release", () => {
            if (!cancelled) setActive(false);
          });
        })
        .catch(() => {
          if (!cancelled) setActive(false);
        });
    };

    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", request);
      void sentinel?.release();
    };
  }, []);

  return active;
}

// Netz da oder nicht (Handy-Flugmodus, Funkloch). In der Web-App zeigt die
// Karte ohne Netz die zuletzt gespeicherten Windwerte (public/sw.js) — die
// Statuszeile sagt das dann deutlich.
function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

// Ab diesem Alter gelten die angezeigten Windwerte als veraltet und die
// Uhrzeit in der Statuszeile wird gelb hinterlegt. Normal sind sie höchstens
// 3 min alt (Abruf-Takt); 15 min heißt: mehrere Abrufe sind gescheitert.
const WIND_OUTDATED_MS = 15 * 60 * 1000;

// Aktuelle Uhrzeit, alle 30 s aufgefrischt — nur für die Alters-Prüfung oben.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

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

// Start, Stop und das Beenden des Flugmodus brauchen zwei Tipper (Wunsch des
// Projektbesitzers, Okt. 2026): Der erste macht die Taste gelb ("WIRKLICH
// STARTEN?", "STOPPEN?" bzw. "BEENDEN?") und zeigt daneben ✕ zum Abbrechen,
// erst der zweite an derselben Stelle löst aus.
// Bewusst kein window.confirm: dessen kleine OK-/Abbrechen-Knöpfe trifft man
// mit Handschuhen im Flug schlecht. Ohne zweiten Tipper springt die Taste nach
// dieser Zeit von selbst zurück, damit sie nicht "scharf" stehen bleibt.
const CONFIRM_MS = 5000;

const TRACK_STORAGE_KEY = "sisosig-flugtrack-v1";
// Violett: kommt in der Windskala (Blau/Grün/Gelb/Orange/Rot) nicht vor und
// unterscheidet sich vom blauen eigenen Standort.
const TRACK_COLOR = "#a21caf";
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
type TrackPoint = [number, number] | [number, number, number, number | null];

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

function segmentsLatLngs(segments: TrackPoint[][]): L.LatLng[][] {
  return segments.map((segment) => segment.map(pointLatLng));
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

// --- IGC-Export ---
// IGC ist das übliche Dateiformat für Flüge (XContest, DHV-XC, Flugbuch-
// Programme). Aufbau: Kopfzeilen (A, H) und je GPS-Punkt eine B-Zeile mit
// Uhrzeit (UTC), Position, Druckhöhe und GPS-Höhe.
// Einschränkungen, bewusst so:
//   - Keine Druckhöhe: Browser kommen nicht an den Luftdruck-Sensor des
//     Handys. Das Feld steht deshalb auf 00000, die Höhe kommt nur aus dem GPS.
//   - Keine Signatur (G-Zeile): Nur zugelassene Flugrechner dürfen signieren.
//     Für Wettbewerbe, die eine gültige Signatur verlangen, reicht die Datei
//     nicht.
//   - Punkte ohne Zeit (Tracks von vor dem IGC-Export) fehlen in der Datei.
//   - Bezug der GPS-Höhe: Laut Browser-Norm über dem WGS84-Ellipsoid (in den
//     Alpen rund 50 m mehr als über dem Meer), das iPhone liefert aber
//     Meereshöhe. Die Kopfzeile HFALGALTGPS sagt deshalb, welche es ist.

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// Grad → IGC-Schreibweise GGMMmmm (Grad, Minuten mit drei Nachkommastellen).
function igcCoord(value: number, degWidth: number, pos: string, neg: string): string {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let milliMin = Math.round((abs - deg) * 60_000);
  if (milliMin === 60_000) {
    deg += 1;
    milliMin = 0;
  }
  return pad(deg, degWidth) + pad(milliMin, 5) + (value >= 0 ? pos : neg);
}

function igcAltitude(m: number): string {
  const r = Math.round(m);
  return r < 0 ? "-" + pad(-r, 4) : pad(Math.min(r, 99_999), 5);
}

// Fertige IGC-Datei, oder null, wenn kein Punkt eine Zeit hat.
function buildIgc(segments: TrackPoint[][]): { text: string; firstTime: Date } | null {
  const fixes = segments.flat().filter((p) => p.length === 4) as [
    number,
    number,
    number,
    number | null,
  ][];
  if (fixes.length === 0) return null;
  const first = new Date(fixes[0][2] * 1000);
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  const lines = [
    "AXSGSISOSIG",
    `HFDTEDATE:${pad(first.getUTCDate(), 2)}${pad(first.getUTCMonth() + 1, 2)}${pad(first.getUTCFullYear() % 100, 2)},01`,
    "HFPLTPILOTINCHARGE:",
    "HFGTYGLIDERTYPE:",
    "HFGIDGLIDERID:",
    "HFDTMGPSDATUM:WGS84",
    "HFFTYFRTYPE:SISOSIG,Web-App",
    "HFGPSRECEIVER:Smartphone",
    "HFPRSPRESSALTSENSOR:NIL",
    `HFALGALTGPS:${isApple ? "GEO" : "ELL"}`,
    "HFALPALTPRESSURE:ISA",
  ];
  for (const [lat, lng, t, alt] of fixes) {
    const d = new Date(t * 1000);
    lines.push(
      "B" +
        pad(d.getUTCHours(), 2) +
        pad(d.getUTCMinutes(), 2) +
        pad(d.getUTCSeconds(), 2) +
        igcCoord(lat, 2, "N", "S") +
        igcCoord(lng, 3, "E", "W") +
        (alt === null ? "V" : "A") +
        "00000" +
        igcAltitude(alt ?? 0),
    );
  }
  return { text: lines.join("\r\n") + "\r\n", firstTime: first };
}

// IGC-Datei weitergeben: Am Handy über das Teilen-Menü (dort lässt sie sich
// in "Dateien" sichern, per Mail/Messenger schicken oder direkt an eine
// Flugbuch-App geben), sonst als normaler Download. Android-Chrome teilt nur
// bekannte Dateitypen, .igc gehört nicht dazu — dort greift der Download.
async function exportIgc(segments: TrackPoint[][]) {
  const igc = buildIgc(segments);
  if (!igc) {
    window.alert(
      "Dieser Track wurde vor dem IGC-Export aufgezeichnet und hat keine Zeiten. " +
        "IGC geht erst für neue Aufzeichnungen.",
    );
    return;
  }
  const f = igc.firstTime;
  const name = `SISOSIG-${f.getFullYear()}-${pad(f.getMonth() + 1, 2)}-${pad(f.getDate(), 2)}-${pad(f.getHours(), 2)}${pad(f.getMinutes(), 2)}.igc`;
  const file = new File([igc.text], name, { type: "application/octet-stream" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    // Teilen-Menü abgebrochen: nichts weiter tun. Andere Fehler: Download.
    if (err instanceof DOMException && err.name === "AbortError") return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Aufzeichnung, Speicher und die Linie auf der Karte. Der Track selbst liegt
// in einem ref (nicht im state): Er wächst mit jedem GPS-Wert und wird nur
// von Leaflet gezeichnet, React braucht ihn nicht. Für die Anzeige gibt es
// nur Aufzeichnungs-Zustand, Länge und "gibt es einen Track".
function useTrack(map: L.Map | null, position: OwnPosition | null) {
  const track = useRef<StoredTrack | null>(null);
  const [recording, setRecording] = useState(false);
  const [lengthM, setLengthM] = useState(0);
  const dirty = useRef(false);
  const lineRef = useRef<L.Polyline | null>(null);

  // Gespeicherten Track laden und die Linie anlegen (einmal je Flugmodus).
  // Die setState-Aufrufe sitzen bewusst in requestAnimationFrame: Laden aus
  // dem Browser-Speicher geht nur im Browser, also erst nach dem Aufbau.
  useEffect(() => {
    if (!map) return;
    const loaded = loadTrack();
    track.current = loaded;
    lineRef.current = L.polyline(segmentsLatLngs(loaded.segments), {
      color: TRACK_COLOR,
      weight: 3,
      opacity: 0.9,
      interactive: false,
    }).addTo(map);
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
    lineRef.current?.setLatLngs(segmentsLatLngs(t.segments));
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
    lineRef.current?.setLatLngs([]);
    setLengthM(0);
  }, []);

  const exportFile = useCallback(() => {
    if (track.current) void exportIgc(track.current.segments);
  }, []);

  return { recording, lengthM, start, stop, clear, exportFile };
}

// Zwischenschritt "wirklich …?" (siehe CONFIRM_MS). Gemerkt wird, welche
// Aktion gerade bestätigt werden soll; nach CONFIRM_MS ist sie vergessen.
function useConfirmStep<T extends string>() {
  const [armed, setArmed] = useState<T | null>(null);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(null), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [armed]);
  return { armed, arm: setArmed, cancel: () => setArmed(null) };
}

// Bestätigung der Track-Taste (starten/stoppen).
function useTrackConfirm(recording: boolean) {
  const { armed, arm, cancel } = useConfirmStep<"start" | "stop">();
  // Passt die gemerkte Aktion nicht mehr zum Zustand (z. B. Track beim Laden
  // schon aufzeichnend), gilt sie nicht.
  const pending = armed === (recording ? "stop" : "start") ? armed : null;
  return { pending, arm, cancel };
}

// --- Kabel (Luftfahrthindernisse, Okt. 2026, Wunsch des Projektbesitzers) ---
// Stromleitungen, Materialseilbahnen, Schussdrähte, Seilbahnen und Lifte in
// Südtirol aus der Hinderniskarte des Landes (Abruf und Quelle: /api/kabel).
// Nur im Flugmodus, nicht auf der normalen Karte. Der Server holt sie einmal
// am Tag beim Land; die Statuszeile oben links sagt, von wann sie sind. Das
// Handy merkt sich die letzte Fassung (CABLE_STORAGE_KEY), ohne Netz sind die
// Kabel also trotzdem da.

// Erst ab dieser Zoomstufe (= Flug-Zoomstufe): Herausgezoomt wären die Täler
// nur noch ein Gewirr aus Leitungen, das die Windpfeile zudeckt.
const CABLE_MIN_ZOOM = FLIGHT_ZOOM;
// Darstellung vom Projektbesitzer am Probebild gewählt (Okt. 2026): eine
// einheitliche magentarote Linie mit weißem Saum, alle Kabel gleich breit.
// Die Farbe kommt in der Windskala nicht vor; vom violetten Track
// (TRACK_COLOR) und vom blauen eigenen Standort unterscheidet sie sich
// deutlich. Eine erste Fassung (dunkle Linie, hohe Kabel dicker) wurde
// dafür ersetzt.
const CABLE_COLOR = "#c2255c";
const CABLE_WEIGHT = 2;
// Weißer Saum unter der Linie, damit sie sich von Straßen und Höhenlinien
// der Karte abhebt.
const CABLE_HALO_COLOR = "#ffffff";
const CABLE_HALO_WEIGHT = 4.5;
const CABLE_HALO_OPACITY = 0.9;
// Eigene Ebene über den Kartenkacheln (200) und unter Track und
// Standort-Kreis (overlayPane, 400) — die Windpfeile liegen ohnehin darüber.
const CABLE_PANE = "kabel";
const CABLE_PANE_Z = 390;

// Höhen-Schilder ("60–100 m") an Kabeln über 25 m über Grund (Klassen in
// src/lib/kabel.ts). Erst auf der höchsten Zoomstufe (Wunsch des
// Projektbesitzers, Okt. 2026 — Vorschauen mit Schildern ab Zoom 11/12/13 waren
// zu unruhig). Lange Kabel bekommen mehrere Schilder im festen
// Bildschirmabstand, wie Straßennamen auf einer Karte; ein fester Abstand in
// Metern ginge nicht (herausgezoomt lägen die Schilder übereinander).
const CABLE_LABEL_MIN_ZOOM = 15;
const CABLE_LABEL_SPACING_PX = 400;
// Ungefähre Maße eines Schilds (px) für das Ausdünnen: Überdecken sich zwei,
// bleibt das des höheren Kabels.
const CABLE_LABEL_CHAR_PX = 7;
const CABLE_LABEL_PAD_PX = 14;
const CABLE_LABEL_HEIGHT_PX = 18;
// Über den Kabel-Linien, unter Track/Standort und Windpfeilen.
const CABLE_LABEL_PANE = "kabelschild";
const CABLE_LABEL_PANE_Z = 395;
// Ohne "max" davor (Wunsch des Projektbesitzers, Okt. 2026), obwohl die
// Klasse die höchste Stelle des Kabels meint (siehe src/lib/kabel.ts).
const CABLE_LABEL_TEXT = new Map(CABLE_HEIGHT_CLASSES.map((c) => [c.code, c.label]));

// Kann der Server die Kabel einmal nicht aktualisieren (Landesserver gestört)
// oder ist kein Netz da, bleiben die zuletzt erfolgreich geladenen Kabel auf
// der Karte (Wunsch des Projektbesitzers). Dafür merkt sich das Handy die
// letzte erfolgreich geladene Fassung im Browser-Speicher (localStorage, wie
// der Track) — das gilt für die Web-App UND die Website im Browser. Das Feld
// "Kabel …" in der Statuszeile wird dann gelb und zeigt weiter das Datum dieser
// Fassung.
// v2: seit den Höhen-Schildern steht vorne in jeder Zeile die Höhenklasse
// (vorher nur 0/1) — eine gespeicherte v1-Fassung würde falsch beschriftet.
const CABLE_STORAGE_KEY = "sisosig-kabel-v2";
// Normal sind die Kabel höchstens einen Tag alt (der Server holt sie einmal am
// Tag, siehe /api/kabel). Älter = die tägliche Aktualisierung hat nicht
// geklappt → gelb. Etwas Luft über 24 h, damit es nicht am Stichtag flackert.
const CABLE_OUTDATED_MS = 30 * 60 * 60 * 1000;
// Kommt vom Server eine alte Fassung, ist das meist nur der Zwischenspeicher,
// der gerade im Hintergrund frische Kabel holt (dauert ein paar Sekunden).
// Deshalb nach dieser Wartezeit einmal nachfragen, bevor gelb angezeigt wird.
const CABLE_RECHECK_DELAY_MS = 20_000;

type CableState = {
  /** Stand der Kabel auf der Karte (Abruf beim Land); null = keine Kabel. */
  stand: Date | null;
  /** Der letzte Versuch, frische Kabel zu holen, ist gescheitert. */
  updateFailed: boolean;
  /** Abruf läuft noch (dann noch nicht gelb anzeigen). */
  checking: boolean;
};

function loadStoredCables(): { text: string; data: CablePayload } | null {
  try {
    const text = window.localStorage.getItem(CABLE_STORAGE_KEY);
    if (!text) return null;
    const data = JSON.parse(text) as CablePayload;
    if (typeof data.stand !== "string" || !Array.isArray(data.kabel)) return null;
    return { text, data };
  } catch {
    // Privater Modus, gesperrter Speicher, kaputter Inhalt: wie nie geladen.
    return null;
  }
}

function storeCables(text: string) {
  try {
    window.localStorage.setItem(CABLE_STORAGE_KEY, text);
  } catch {
    // Speicher voll oder gesperrt: Die Kabel sind trotzdem auf der Karte, nur
    // beim nächsten Mal ohne Netz nicht.
  }
}

function useCables(map: L.Map | null): CableState {
  const [state, setState] = useState<CableState>({
    stand: null,
    updateFailed: false,
    checking: true,
  });

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let recheckTimer: ReturnType<typeof setTimeout> | undefined;
    if (!map.getPane(CABLE_PANE)) {
      map.createPane(CABLE_PANE).style.zIndex = String(CABLE_PANE_Z);
    }
    if (!map.getPane(CABLE_LABEL_PANE)) {
      map.createPane(CABLE_LABEL_PANE).style.zIndex = String(CABLE_LABEL_PANE_Z);
    }
    // Alle Kabel in zwei Linien-Ebenen (Saum und Linie) statt je Kabel einer
    // eigenen — bei über 4000 Kabeln spart das viel Arbeit. Auf
    // einer Zeichenfläche (canvas) statt als einzelne SVG-Elemente aus
    // demselben Grund.
    const renderer = L.canvas({ pane: CABLE_PANE, padding: 0.5 });
    const group = L.layerGroup();
    // Stand der gerade gezeichneten Kabel (ms), null = noch keine.
    let shownStand: number | null = null;
    // Kabel mit Schild (über 25 m), das höchste zuerst — so gewinnt es beim
    // Ausdünnen.
    let labeled: { latLngs: L.LatLng[]; bounds: L.LatLngBounds; code: number; text: string }[] = [];
    const labelGroup = L.layerGroup().addTo(map);
    // Ein Icon je Schildtext (nur sechs verschiedene), nicht je Schild.
    const labelIcons = new Map<string, L.DivIcon>();
    const labelIcon = (text: string) => {
      let icon = labelIcons.get(text);
      if (!icon) {
        icon = L.divIcon({
          className: "kabel-schild",
          html: `<span>${text}</span>`,
          iconSize: [0, 0],
        });
        labelIcons.set(text, icon);
      }
      return icon;
    };

    // Schilder neu setzen — nach jedem Verschieben/Zoomen, nur ab
    // CABLE_LABEL_MIN_ZOOM und nur für Kabel im Kartenausschnitt (bei Zoom 15
    // sind das wenige). Die Stellen hängen nur am Kabel und an der Zoomstufe,
    // nicht am Ausschnitt: Beim Mitführen der Karte springen sie also nicht.
    const placeLabels = () => {
      labelGroup.clearLayers();
      if (map.getZoom() < CABLE_LABEL_MIN_ZOOM) return;
      const view = map.getBounds().pad(0.2);
      const placed: { x: number; y: number; w: number }[] = [];
      for (const cable of labeled) {
        if (!view.intersects(cable.bounds)) continue;
        const points = cable.latLngs.map((ll) => map.latLngToLayerPoint(ll));
        const segments: number[] = [];
        let total = 0;
        for (let i = 1; i < points.length; i++) {
          const d = points[i].distanceTo(points[i - 1]);
          segments.push(d);
          total += d;
        }
        const count = Math.max(1, Math.floor(total / CABLE_LABEL_SPACING_PX));
        const step = total / count;
        const width = cable.text.length * CABLE_LABEL_CHAR_PX + CABLE_LABEL_PAD_PX;
        for (let k = 0; k < count; k++) {
          // Stelle auf dem Kabel: jeweils in der Mitte eines Abschnitts.
          let rest = step * (k + 0.5);
          let i = 0;
          while (i < segments.length - 1 && rest > segments[i]) {
            rest -= segments[i];
            i++;
          }
          const a = points[i];
          const b = points[i + 1] ?? a;
          const t = segments[i] ? Math.min(1, rest / segments[i]) : 0;
          const point = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          const latLng = map.layerPointToLatLng(point);
          if (!view.contains(latLng)) continue;
          const overlaps = placed.some(
            (q) =>
              Math.abs(q.x - point.x) < (q.w + width) / 2 + 4 &&
              Math.abs(q.y - point.y) < CABLE_LABEL_HEIGHT_PX + 4,
          );
          if (overlaps) continue;
          placed.push({ x: point.x, y: point.y, w: width });
          L.marker(latLng, {
            icon: labelIcon(cable.text),
            pane: CABLE_LABEL_PANE,
            interactive: false,
            keyboard: false,
          }).addTo(labelGroup);
        }
      }
    };
    map.on("moveend", placeLabels);

    // Nur ab CABLE_MIN_ZOOM auf der Karte; darunter ganz weg (dann wird auch
    // nichts gezeichnet).
    const updateVisibility = () => {
      if (map.getZoom() >= CABLE_MIN_ZOOM) group.addTo(map);
      else group.remove();
    };
    map.on("zoomend", updateVisibility);

    const draw = (data: CablePayload) => {
      const lines: L.LatLng[][] = [];
      labeled = [];
      for (const row of data.kabel) {
        // row[0] ist die Höhenklasse (src/lib/kabel.ts), 0 = kein Schild.
        const line: L.LatLng[] = [];
        for (let i = 1; i + 1 < row.length; i += 2) line.push(L.latLng(row[i], row[i + 1]));
        lines.push(line);
        const text = CABLE_LABEL_TEXT.get(row[0]);
        if (text && line.length > 1) {
          labeled.push({ latLngs: line, bounds: L.latLngBounds(line), code: row[0], text });
        }
      }
      // Höchste Klasse zuerst (Ausdünnen, siehe CABLE_HEIGHT_CLASSES).
      labeled.sort((x, y) => y.code - x.code);
      group.clearLayers();
      const common = { renderer, interactive: false, lineCap: "round", lineJoin: "round" } as const;
      L.polyline(lines, { ...common, color: CABLE_HALO_COLOR, weight: CABLE_HALO_WEIGHT, opacity: CABLE_HALO_OPACITY }).addTo(group);
      L.polyline(lines, { ...common, color: CABLE_COLOR, weight: CABLE_WEIGHT, opacity: 1 }).addTo(group);
      shownStand = Date.parse(data.stand);
      updateVisibility();
      placeLabels();
    };

    // Zuerst sofort die gespeicherte Fassung zeigen (auch ohne Netz), dann
    // frisch nachladen. setState im nächsten Bild, wie beim Track.
    const stored = loadStoredCables();
    if (stored) draw(stored.data);
    const frame = requestAnimationFrame(() => {
      if (shownStand !== null) {
        setState({ stand: new Date(shownStand), updateFailed: false, checking: true });
      }
    });

    const load = async (isRecheck: boolean) => {
      let text: string;
      let data: CablePayload;
      try {
        const res = await fetch("/api/kabel");
        if (!res.ok) throw new Error(String(res.status));
        text = await res.text();
        data = JSON.parse(text) as CablePayload;
      } catch {
        // Keine frischen Kabel: Die bisherigen bleiben stehen, das Feld wird
        // gelb (bzw. "Keine Kabel", wenn es nie welche gab).
        if (cancelled) return;
        setState({
          stand: shownStand === null ? null : new Date(shownStand),
          updateFailed: true,
          checking: false,
        });
        return;
      }
      if (cancelled) return;
      const stand = Date.parse(data.stand);
      // Nur eine NEUERE Fassung ersetzt die gezeichnete (ohne Netz kann der
      // Hintergrund-Helfer der Web-App auch eine ältere liefern).
      if (shownStand === null || stand > shownStand) {
        draw(data);
        storeCables(text);
      }
      const shown = shownStand ?? stand;
      if (!isRecheck && Date.now() - shown > CABLE_OUTDATED_MS) {
        // Alte Fassung vom Server: einmal nachfragen (siehe
        // CABLE_RECHECK_DELAY_MS), erst dann gelb.
        setState({ stand: new Date(shown), updateFailed: false, checking: true });
        recheckTimer = setTimeout(() => void load(true), CABLE_RECHECK_DELAY_MS);
        return;
      }
      setState({ stand: new Date(shown), updateFailed: false, checking: false });
    };
    void load(false);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(recheckTimer);
      map.off("zoomend", updateVisibility);
      map.off("moveend", placeLabels);
      group.remove();
      labelGroup.remove();
      // Die Zeichenfläche hängt Leaflet selbst an die Karte; ohne das hier
      // bliebe bei jedem Beenden des Flugmodus eine leere zurück.
      renderer.remove();
    };
  }, [map]);

  return state;
}

// Icon des eigenen Standorts: blauer Punkt, davor eine Spitze in Flugrichtung.
// Bewusst ein Kreis und kein Pfeil, damit er nicht mit den Windpfeilen
// verwechselt wird. Ohne bekannte Richtung nur der Punkt.
// Aufbau wie bei den Windpfeilen von außen nach innen: dunkler Umriss → weißer
// Rand → blaue Fläche, als dieselbe Form dreimal übereinander. Ein weißer Rand
// allein verschwand auf der sehr hellen Karte.
function createOwnPositionIcon(heading: number | null): L.DivIcon {
  const size = 48;
  const shape = (attrs: string) =>
    `<circle cx="24" cy="24" r="10" ${attrs} />` +
    (heading === null ? "" : `<path d="M24 2 L33 15 L15 15 Z" ${attrs} />`);
  const html = `
    <svg width="${size}" height="${size}" viewBox="0 0 48 48" style="transform: rotate(${heading ?? 0}deg); overflow: visible;" xmlns="http://www.w3.org/2000/svg">
      ${shape('fill="none" stroke="#1f2937" stroke-width="7" stroke-linejoin="round"')}
      ${shape('fill="white" stroke="white" stroke-width="4" stroke-linejoin="round"')}
      ${shape(`fill="${OWN_POSITION_COLOR}"`)}
    </svg>
  `;
  return L.divIcon({
    html,
    className: "eigener-standort",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function FlightMode({
  map,
  defaultCenter,
  defaultZoom,
  lastUpdated,
  onExit,
}: {
  /** Die Leaflet-Karte (aus WindMap); null, solange sie noch aufgebaut wird. */
  map: L.Map | null;
  /** Ansicht der Rücksetztaste, solange es noch keinen GPS-Standort gibt. */
  defaultCenter: [number, number];
  defaultZoom: number;
  /** Letzter erfolgreicher Abruf der Windwerte (für die Statuszeile). */
  lastUpdated: Date | null;
  onExit: () => void;
}) {
  const { position, status } = useOwnPosition();
  const wakeLockActive = useWakeLock();
  const track = useTrack(map, position);
  const trackConfirm = useTrackConfirm(track.recording);
  const exitConfirm = useConfirmStep<"exit">();
  const cables = useCables(map);
  const online = useOnline();
  const now = useNow(30_000);

  // Mitführen: Die Karte folgt dem eigenen Standort, bis man sie selbst
  // verschiebt. Die Rücksetztaste schaltet es wieder ein. Als ref, weil der
  // dragstart-Zuhörer und der GPS-Effekt denselben aktuellen Wert brauchen.
  const following = useRef(true);
  const [followingShown, setFollowingShown] = useState(true);
  const setFollowing = useCallback((value: boolean) => {
    following.current = value;
    setFollowingShown(value);
  }, []);
  // Beim ersten GPS-Wert einmal auf die Flug-Zoomstufe springen.
  const hadFirstFix = useRef(false);

  useEffect(() => {
    if (!map) return;
    const stopFollowing = () => setFollowing(false);
    map.on("dragstart", stopFollowing);
    return () => {
      map.off("dragstart", stopFollowing);
    };
  }, [map, setFollowing]);

  // Zoomen im Flugmodus NUR über die +/−-Tasten (Wunsch des Projektbesitzers,
  // Okt. 2026): Doppeltippen, Zwei-Finger-Zoom, Mausrad und Rahmen-Zoom sind
  // aus — im Flug zoomt sonst jede unruhige Berührung mit. Verschieben geht
  // weiter. Beim Verlassen ist auf der normalen Karte alles wieder an.
  useEffect(() => {
    if (!map) return;
    const handlers = [map.doubleClickZoom, map.touchZoom, map.scrollWheelZoom, map.boxZoom];
    for (const handler of handlers) handler.disable();
    return () => {
      for (const handler of handlers) handler.enable();
    };
  }, [map]);

  // Marker des eigenen Standorts (direkt über Leaflet, nicht über
  // react-leaflet: FlightMode liegt außerhalb von <MapContainer>, damit die
  // Tasten keine Karten-Gesten auslösen). Ein eigener Marker für die ganze
  // Dauer des Flugmodus; bei neuen GPS-Werten werden nur Position und Icon
  // nachgeführt. Das Icon wird nur bei geänderter (auf 5° gerundeter)
  // Richtung neu gebaut.
  const markerRef = useRef<L.Marker | null>(null);
  const accuracyRef = useRef<L.Circle | null>(null);
  const iconHeading = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (!map) return;
    return () => {
      markerRef.current?.remove();
      accuracyRef.current?.remove();
      markerRef.current = null;
      accuracyRef.current = null;
      iconHeading.current = undefined;
    };
  }, [map]);

  useEffect(() => {
    if (!map || !position) return;
    const latLng = L.latLng(position.lat, position.lng);
    const heading = position.heading === null ? null : Math.round(position.heading / 5) * 5;

    if (!accuracyRef.current) {
      // Ungenauigkeits-Kreis: nur ein Hauch, damit er nichts verdeckt.
      accuracyRef.current = L.circle(latLng, {
        radius: position.accuracyM,
        color: OWN_POSITION_COLOR,
        weight: 1,
        opacity: 0.4,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
    } else {
      accuracyRef.current.setLatLng(latLng).setRadius(position.accuracyM);
    }

    if (!markerRef.current) {
      markerRef.current = L.marker(latLng, {
        icon: createOwnPositionIcon(heading),
        interactive: false,
        keyboard: false,
        // Über allen Windpfeilen.
        zIndexOffset: 10_000,
      }).addTo(map);
      iconHeading.current = heading;
    } else {
      markerRef.current.setLatLng(latLng);
      if (iconHeading.current !== heading) {
        markerRef.current.setIcon(createOwnPositionIcon(heading));
        iconHeading.current = heading;
      }
    }

    if (!hadFirstFix.current) {
      hadFirstFix.current = true;
      if (following.current) map.setView(latLng, FLIGHT_ZOOM, { animate: false });
      return;
    }
    if (following.current) {
      const offset = map.latLngToContainerPoint(latLng).distanceTo(
        map.latLngToContainerPoint(map.getCenter()),
      );
      if (offset > FOLLOW_TOLERANCE_PX) map.panTo(latLng, { animate: false });
    }
  }, [map, position]);

  // Rücksetz- und Übersichtstaste: eigener Standort auf der jeweiligen
  // Zoomstufe, Karte folgt wieder.
  const handleReset = (zoom: number) => {
    if (!map) return;
    if (position) {
      setFollowing(true);
      map.setView([position.lat, position.lng], zoom, { animate: false });
    } else {
      // Noch kein Standort: zurück auf die Startansicht der Karte. Mitführen
      // bleibt an, damit der erste GPS-Wert die Karte dorthin holt.
      setFollowing(true);
      map.setView(defaultCenter, defaultZoom, { animate: false });
    }
  };

  // Ohne Animation: spart Akku, und die Karte steht sofort.
  const handleZoomIn = () => map?.zoomIn(1, { animate: false });
  const handleZoomOut = () => map?.zoomOut(1, { animate: false });

  const gpsText =
    status === "ok" && position
      ? `GPS ±${Math.round(position.accuracyM)} m`
      : status === "denied"
        ? "Standort nicht erlaubt"
        : status === "unavailable"
          ? "Kein GPS"
          : "GPS sucht…";
  // Mit Datum, wenn die Werte nicht von heute sind (ohne Netz können die
  // gespeicherten auch vom Vortag stammen).
  const updatedText = lastUpdated
    ? `Wind ${
        lastUpdated.toDateString() === new Date(now).toDateString()
          ? ""
          : `${lastUpdated.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} `
      }${lastUpdated.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
    : "Wind lädt…";
  // Stand der Kabel: Datum und Uhrzeit, wann der Server sie zuletzt beim Land
  // abgeholt hat (einmal am Tag, siehe /api/kabel). Gelb, wenn die
  // Aktualisierung nicht geklappt hat — die Karte zeigt dann weiter die Kabel
  // dieses Datums — oder wenn es gar keine Kabel gibt.
  const cableText = cables.stand
    ? `Kabel ${cables.stand.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} ${cables.stand.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
    : cables.checking
      ? "Kabel lädt…"
      : "Keine Kabel";
  const cableWarning =
    !cables.checking &&
    (cables.stand === null ||
      cables.updateFailed ||
      now - cables.stand.getTime() > CABLE_OUTDATED_MS);
  const windOutdated =
    lastUpdated !== null && now - lastUpdated.getTime() > WIND_OUTDATED_MS;
  const trackText =
    track.recording || track.lengthM > 0
      ? `Track ${(track.lengthM / 1000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`
      : null;

  // Gemeinsamer Stil der großen Tasten: schwarz/weiß und eckig wie der
  // Menü-Knopf im Titel, 72 px groß (mit Handschuhen gut zu treffen).
  const bigButton =
    "pointer-events-auto flex h-[72px] w-[72px] items-center justify-center border-2 border-black shadow-lg select-none";
  const bigButtonLight = `${bigButton} bg-white text-zinc-900 active:bg-zinc-200`;
  // Zoomtasten (+/−, Rücksetzen, Übersicht) mit halb durchsichtigem
  // Hintergrund, damit man die Karte darunter sieht (Wunsch des
  // Projektbesitzers, Okt. 2026). Nur der Hintergrund: Zeichen und Rand
  // bleiben voll deckend und gut lesbar.
  const zoomButtonLight = `${bigButton} bg-white/50 text-zinc-900 active:bg-zinc-200/50`;
  const zoomButtonDark = `${bigButton} bg-zinc-900/50 text-white active:bg-zinc-700/50`;

  return (
    <>
      {/* Anordnung der Tasten vom Projektbesitzer in einer Layout-Vorschau
          festgelegt (Okt. 2026): oben links Beenden und darunter die
          Statuszeile, oben rechts Plus/Minus, unten links die Track-Taste,
          unten rechts Rücksetz- über Übersichtstaste. Abstände 12 px, unten
          28 px (Abstand zur Wischleiste des iPhones). */}

      {/* Oben links: Flugmodus beenden, darunter die Statuszeile. Die
          Beenden-Taste ist etwas kleiner als die Bedientasten, damit man sie
          im Flug nicht aus Versehen trifft, und hat wie die Track-Taste einen
          zweiten Tipper (CONFIRM_MS): Der erste macht daraus das gelbe
          "WIRKLICH BEENDEN?", darunter ✕ zum Abbrechen (nicht daneben: dort
          steht oben mittig das Filter-Schild). Alles in EINER Spalte, damit
          die Statuszeile für das ✕ nach unten rückt statt überdeckt zu werden. */}
      <div className="pointer-events-none absolute top-3 left-3 z-[1000] flex flex-col items-start gap-3">
        {exitConfirm.armed ? (
          <>
            <button
              type="button"
              onClick={onExit}
              aria-label="Flugmodus wirklich beenden"
              className="pointer-events-auto flex h-12 flex-col items-center justify-center border-2 border-black bg-amber-300 px-2 text-zinc-900 shadow-lg select-none active:bg-amber-500"
            >
              <span className="text-[11px] font-bold leading-tight">WIRKLICH</span>
              <span className="text-[11px] font-bold leading-tight">BEENDEN?</span>
            </button>
            <button
              type="button"
              onClick={exitConfirm.cancel}
              aria-label="Abbrechen"
              title="Abbrechen"
              className="pointer-events-auto flex h-12 w-12 items-center justify-center border-2 border-black bg-white shadow-lg active:bg-zinc-200"
            >
              <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" strokeWidth="2.5" />
              </svg>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => exitConfirm.arm("exit")}
            aria-label="Flugmodus beenden"
            title="Flugmodus beenden"
            className="pointer-events-auto flex h-12 w-12 items-center justify-center border-2 border-black bg-white shadow-lg active:bg-zinc-200"
          >
            <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" strokeWidth="2.5" />
            </svg>
          </button>
        )}
        {/* Statuszeile (GPS-Genauigkeit, Stand der Windwerte und Kabel,
            Track-Länge, ob der Bildschirm wach gehalten wird). */}
        <div className="flex flex-col items-start gap-1 text-left text-xs font-bold text-zinc-900">
          <span className="bg-white/90 px-1.5 py-0.5 shadow">{gpsText}</span>
          {!online && <span className="bg-amber-300 px-1.5 py-0.5 shadow">Offline</span>}
          {/* Gelb, wenn die Windwerte alt sind (z. B. ohne Netz die zuletzt
              gespeicherten): Die Uhrzeit sagt dann, von wann sie stammen. */}
          <span className={`px-1.5 py-0.5 shadow ${windOutdated ? "bg-amber-300" : "bg-white/90"}`}>
            {updatedText}
          </span>
          {/* Gelb, wenn die Kabel nicht aktuell sind (siehe cableWarning). */}
          <span className={`px-1.5 py-0.5 shadow ${cableWarning ? "bg-amber-300" : "bg-white/90"}`}>
            {cableText}
          </span>
          {trackText && (
            <span className="bg-white/90 px-1.5 py-0.5 shadow" style={{ color: TRACK_COLOR }}>
              {trackText}
            </span>
          )}
          {wakeLockActive === false && (
            <span className="bg-amber-300 px-1.5 py-0.5 shadow">Bildschirm kann sich sperren</span>
          )}
        </div>
      </div>

      {/* Oben rechts: Plus über Minus, mit Abstand, damit man mit
          Handschuhen nicht beide zugleich trifft. */}
      <div className="pointer-events-none absolute top-9 right-3 z-[1000] flex flex-col gap-3">
        <button
          type="button"
          onClick={handleZoomIn}
          aria-label="Hineinzoomen"
          title="Hineinzoomen"
          className={zoomButtonLight}
        >
          <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
            <path d="M18 4 V32 M4 18 H32" stroke="currentColor" strokeWidth="4.5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          aria-label="Herauszoomen"
          title="Herauszoomen"
          className={zoomButtonLight}
        >
          <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
            <path d="M4 18 H32" stroke="currentColor" strokeWidth="4.5" />
          </svg>
        </button>
      </div>

      {/* Unten links: die Track-Taste (Start/Stop mit Bestätigung, daneben
          bei gestopptem Track die kleineren Tasten IGC-Export und Löschen
          bzw. während der Bestätigung die Abbrechen-Taste). */}
      <div className="pointer-events-none absolute bottom-7 left-3 z-[1000]">
        <div className="flex items-end gap-3">
          {trackConfirm.pending ? (
            <>
              {/* Zweiter Tipper an derselben Stelle bestätigt (CONFIRM_MS). */}
              <button
                type="button"
                onClick={() => {
                  if (trackConfirm.pending === "stop") track.stop();
                  else track.start();
                  trackConfirm.cancel();
                }}
                aria-label={
                  trackConfirm.pending === "stop"
                    ? "Track-Aufzeichnung wirklich stoppen"
                    : "Track-Aufzeichnung wirklich starten"
                }
                className={`${bigButton} flex-col bg-amber-300 text-zinc-900 active:bg-amber-500`}
              >
                <span className="text-[11px] font-bold leading-tight">WIRKLICH</span>
                <span className="text-[11px] font-bold leading-tight">
                  {trackConfirm.pending === "stop" ? "STOPPEN?" : "STARTEN?"}
                </span>
              </button>
              <button
                type="button"
                onClick={trackConfirm.cancel}
                aria-label="Abbrechen"
                title="Abbrechen"
                className={bigButtonLight}
              >
                <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                  <path d="M5 5 L23 23 M23 5 L5 23" stroke="currentColor" strokeWidth="3.5" />
                </svg>
              </button>
            </>
          ) : track.recording ? (
            <button
              type="button"
              onClick={() => trackConfirm.arm("stop")}
              aria-label="Track-Aufzeichnung stoppen"
              title="Track-Aufzeichnung stoppen"
              className={`${bigButton} flex-col gap-1 bg-red-600 text-white active:bg-red-800`}
            >
              <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                <rect x="2" y="2" width="18" height="18" fill="currentColor" />
              </svg>
              <span className="text-xs font-bold">STOP</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => trackConfirm.arm("start")}
              aria-label="Track-Aufzeichnung starten"
              title="Track-Aufzeichnung starten"
              className={`${bigButtonLight} flex-col gap-1`}
            >
              <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                <circle cx="11" cy="11" r="10" fill="#dc2626" />
              </svg>
              <span className="text-xs font-bold">START</span>
            </button>
          )}
          {!track.recording && !trackConfirm.pending && track.lengthM > 0 && (
            <button
              type="button"
              onClick={track.exportFile}
              aria-label="Track als IGC-Datei speichern"
              title="Track als IGC-Datei speichern"
              className="pointer-events-auto flex h-12 w-12 items-center justify-center border-2 border-black bg-white text-xs font-bold shadow-lg active:bg-zinc-200"
            >
              IGC
            </button>
          )}
          {!track.recording && !trackConfirm.pending && track.lengthM > 0 && (
            <button
              type="button"
              onClick={track.clear}
              aria-label="Track löschen"
              title="Track löschen"
              className="pointer-events-auto flex h-12 w-12 items-center justify-center border-2 border-black bg-white shadow-lg active:bg-zinc-200"
            >
              {/* Papierkorb */}
              <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 6 H20 M9 6 V3 H15 V6 M6 6 L7 21 H17 L18 6 M10 10 V17 M14 10 V17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Unten rechts: oben die Rücksetztaste (eigener Standort, Flug-
          Zoomstufe 15; ohne Standort die Startansicht), darunter die
          Übersichtstaste (eigener Standort, Zoom 10). Die Rücksetztaste ist
          gefüllt, solange die Karte dem Standort folgt — so sieht man, ob sie
          gerade mitläuft. */}
      <div className="pointer-events-none absolute right-3 bottom-7 z-[1000] flex flex-col gap-3">
        <button
          type="button"
          onClick={() => handleReset(FLIGHT_ZOOM)}
          aria-label="Ansicht zurücksetzen"
          title="Ansicht zurücksetzen"
          className={followingShown && position ? zoomButtonDark : zoomButtonLight}
        >
          {/* Fadenkreuz */}
          <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="10" fill="none" stroke="currentColor" strokeWidth="3" />
            <circle cx="20" cy="20" r="3.5" fill="currentColor" />
            <path
              d="M20 2 V10 M20 30 V38 M2 20 H10 M30 20 H38"
              stroke="currentColor"
              strokeWidth="3"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => handleReset(OVERVIEW_ZOOM)}
          aria-label="Übersicht"
          title="Übersicht"
          className={zoomButtonLight}
        >
          {/* Vier Ecken mit Pfeilen nach innen: "großes Gebiet" */}
          <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
            <path
              d="M4 13 V4 H13 M27 4 H36 V13 M36 27 V36 H27 M13 36 H4 V27"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
            />
            <path
              d="M11 11 L17 17 M29 11 L23 17 M29 29 L23 23 M11 29 L17 23"
              stroke="currentColor"
              strokeWidth="3"
            />
          </svg>
        </button>
      </div>
    </>
  );
}
