"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";

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

// Zoomstufe der Rücksetztaste (und beim ersten GPS-Fix). 11 = Zahlen-Plakette
// sichtbar (ab 10), aber noch ohne Stationsnamen (ab 12); am Handy sind das
// rund 20 km Kartenbreite — genug Überblick für die nächsten Stationen.
const FLIGHT_ZOOM = 11;

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
        const { latitude, longitude, accuracy, heading, speed } = pos.coords;
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

  const handleReset = () => {
    if (!map) return;
    if (position) {
      setFollowing(true);
      map.setView([position.lat, position.lng], FLIGHT_ZOOM, { animate: false });
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
  const updatedText = lastUpdated
    ? `Wind ${lastUpdated.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
    : "Wind lädt…";

  // Gemeinsamer Stil der großen Tasten: schwarz/weiß und eckig wie der
  // Menü-Knopf im Titel, 72 px groß (mit Handschuhen gut zu treffen).
  const bigButton =
    "pointer-events-auto flex h-[72px] w-[72px] items-center justify-center border-2 border-black shadow-lg select-none";
  const bigButtonLight = `${bigButton} bg-white text-zinc-900 active:bg-zinc-200`;
  const bigButtonDark = `${bigButton} bg-zinc-900 text-white active:bg-zinc-700`;

  return (
    <>
      {/* Oben links: Flugmodus beenden. Etwas kleiner als die Bedientasten,
          damit man ihn im Flug nicht aus Versehen trifft. */}
      <div className="pointer-events-none absolute top-3 left-3 z-[1000]">
        <button
          type="button"
          onClick={onExit}
          aria-label="Flugmodus beenden"
          title="Flugmodus beenden"
          className="pointer-events-auto flex h-12 w-12 items-center justify-center border-2 border-black bg-white shadow-lg active:bg-zinc-200"
        >
          <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" strokeWidth="2.5" />
          </svg>
        </button>
      </div>

      {/* Oben rechts: Statuszeile (GPS-Genauigkeit, Stand der Windwerte und ob
          der Bildschirm wach gehalten wird). */}
      <div className="pointer-events-none absolute top-3 right-3 z-[1000] flex flex-col items-end gap-1 text-right text-xs font-bold text-zinc-900">
        <span className="bg-white/90 px-1.5 py-0.5 shadow">{gpsText}</span>
        <span className="bg-white/90 px-1.5 py-0.5 shadow">{updatedText}</span>
        {wakeLockActive === false && (
          <span className="bg-amber-300 px-1.5 py-0.5 shadow">Bildschirm kann sich sperren</span>
        )}
      </div>

      {/* Unten links: Rücksetztaste (auf den eigenen Standort, Flug-Zoomstufe;
          ohne Standort auf die Startansicht). Gefüllt, solange die Karte dem
          Standort folgt — so sieht man, ob sie gerade mitläuft. */}
      <div className="pointer-events-none absolute bottom-6 left-3 z-[1000]">
        <button
          type="button"
          onClick={handleReset}
          aria-label="Ansicht zurücksetzen"
          title="Ansicht zurücksetzen"
          className={followingShown && position ? bigButtonDark : bigButtonLight}
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
      </div>

      {/* Unten rechts: Plus über Minus, mit Abstand, damit man mit
          Handschuhen nicht beide zugleich trifft. */}
      <div className="pointer-events-none absolute right-3 bottom-6 z-[1000] flex flex-col gap-4">
        <button
          type="button"
          onClick={handleZoomIn}
          aria-label="Hineinzoomen"
          title="Hineinzoomen"
          className={bigButtonLight}
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
          className={bigButtonLight}
        >
          <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
            <path d="M4 18 H32" stroke="currentColor" strokeWidth="4.5" />
          </svg>
        </button>
      </div>
    </>
  );
}
