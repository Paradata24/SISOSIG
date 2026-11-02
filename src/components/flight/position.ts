import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";

// Eigener Standort im Flugmodus (Okt. 2026 aus FlightMode.tsx ausgelagert):
// GPS mit Flugrichtung und das Icon auf der Karte. Wie die Karte damit umgeht
// (Mitführen, Ungenauigkeits-Kreis), steht in src/components/FlightMode.tsx.

// Unterhalb dieser Geschwindigkeit ist die GPS-Flugrichtung nur Rauschen
// (rund 4 km/h). Dann bleibt die zuletzt gültige Richtung stehen.
const MIN_HEADING_SPEED_MS = 1.2;
// Liefert der Browser keine Richtung (manche Android-Browser), wird sie aus
// zwei Positionen errechnet — aber erst ab diesem Abstand, sonst springt sie
// durch die GPS-Ungenauigkeit hin und her.
const MIN_HEADING_DISTANCE_M = 25;

// GPS-Einstellungen. enableHighAccuracy ist nötig: Ohne echtes GPS gibt es
// keine Flugrichtung. maximumAge: ein höchstens 2 s alter Wert darf
// wiederverwendet werden.
const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 30_000,
};

export const OWN_POSITION_COLOR = "#2563eb";
// GPS-Ungenauigkeit als leicht durchsichtiger blauer Kreis um den Standort
// (wie beim Standort-Senden in WhatsApp; Wunsch des Projektbesitzers,
// Okt. 2026, statt "GPS ±… m" in der Statuszeile). Erst ab dieser
// Ungenauigkeit — darunter ist der Kreis ohnehin kaum größer als der Pfeil.
export const ACCURACY_CIRCLE_MIN_M = 10;

export type OwnPosition = {
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

export type GpsStatus = "searching" | "ok" | "denied" | "unavailable";

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
//
// retry (Nov. 2026, Wunsch des Projektbesitzers): Ist der Standort noch nicht
// freigegeben (abgelehnt oder kein GPS), startet ein Tipp auf die
// Rücksetz-/Übersichtstaste die Standortabfrage neu — der Browser fragt dann
// wieder "Standort erlauben?". Bewusst direkt im Tipp aufgerufen (nicht erst
// in einem Effekt danach): Manche Browser zeigen die Frage nur als Folge
// eines Tipps. Ist der Standort schon freigegeben, passiert nichts.
// Grenze: Hat man im Browser bzw. in den Handy-Einstellungen "nie erlauben"
// gewählt, fragt der Browser von sich aus nicht mehr — dann meldet die
// Statuszeile "Standort gesperrt" (blocked), freigeben geht nur dort.
export function useOwnPosition(): {
  position: OwnPosition | null;
  status: GpsStatus;
  blocked: boolean;
  retry: () => void;
} {
  const [position, setPosition] = useState<OwnPosition | null>(null);
  const [status, setStatus] = useState<GpsStatus>(() =>
    typeof navigator !== "undefined" && "geolocation" in navigator ? "searching" : "unavailable",
  );
  // Letzte gültige Richtung und der Punkt, an dem sie zuletzt errechnet wurde
  // (für den Ersatz aus zwei Positionen, siehe MIN_HEADING_DISTANCE_M).
  const lastHeading = useRef<number | null>(null);
  const headingAnchor = useRef<L.LatLng | null>(null);
  // Laufende Standortabfrage (watchPosition), damit retry sie ersetzen kann.
  const watchId = useRef<number | null>(null);
  // Abgelehnt, obwohl gerade neu gefragt wurde = im Browser dauerhaft gesperrt.
  const [blocked, setBlocked] = useState(false);
  const retried = useRef(false);

  const start = useCallback(() => {
    if (!("geolocation" in navigator)) return;
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = navigator.geolocation.watchPosition(
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
        setBlocked(false);
      },
      (err) => {
        // Nach einem Zeitüberschreitungs-Fehler sucht der Browser weiter; der
        // Status bleibt dann "searching", bis wieder ein Wert kommt.
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
          if (retried.current) setBlocked(true);
        } else if (err.code === err.POSITION_UNAVAILABLE) setStatus("unavailable");
      },
      GEO_OPTIONS,
    );
  }, []);

  useEffect(() => {
    start();
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [start]);

  // Nur wenn der Standort (noch) nicht freigegeben ist bzw. kein GPS kam.
  const retry = useCallback(() => {
    if (status !== "denied" && status !== "unavailable") return;
    retried.current = true;
    setStatus("searching");
    start();
  }, [status, start]);

  return { position, status, blocked, retry };
}

// Icon des eigenen Standorts: blauer Navigationspfeil in Flugrichtung, ohne
// bekannte Richtung ein blauer Punkt. Früher bewusst ein Punkt mit Spitze, um
// Verwechslung mit den Windpfeilen zu vermeiden; der Projektbesitzer hat sich
// trotzdem für den Pfeil entschieden — er ist größer (bis 36 px), kräftig
// blau und hat eine Kerbe, die Windpfeile nicht haben.
// Aufbau wie bei den Windpfeilen von außen nach innen: dunkler Umriss → weißer
// Rand → blaue Fläche, als dieselbe Form dreimal übereinander. Ein weißer Rand
// allein verschwand auf der sehr hellen Karte.
export function createOwnPositionIcon(heading: number | null): L.DivIcon {
  const size = 48;
  // Mit Flugrichtung ein Navigationspfeil mit Kerbe hinten (vom
  // Projektbesitzer im Okt. 2026 aus mehreren Entwürfen gewählt, vorher Punkt
  // mit abgesetzter Spitze), ohne Richtung ein Punkt.
  const shape = (attrs: string) =>
    heading === null
      ? `<circle cx="24" cy="24" r="10" ${attrs} />`
      : `<path d="M24 4 L38 40 L24 31 L10 40 Z" ${attrs} />`;
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
