"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import {
  getStationFilterLabel,
  listSourceLabels,
  STATION_FILTER_ORDER,
  type StationFilter,
  type WindStation,
} from "@/lib/wind";
import { CABLE_OUTDATED_MS, useCables } from "@/components/flight/cables";
import { useNow, useOnline, useWakeLock } from "@/components/flight/device";
import { useKk7Layer } from "@/components/flight/kk7";
import {
  ACCURACY_CIRCLE_MIN_M,
  createOwnPositionIcon,
  OWN_POSITION_COLOR,
  useOwnPosition,
  type OwnPosition,
} from "@/components/flight/position";
import { TRACK_COLOR, useTrack } from "@/components/flight/track";

// Flugmodus ("Flightcomputer", Okt. 2026, Wunsch des Projektbesitzers):
// Angetippt über "GO" im Titel (WindApp). Die Karte füllt dann den ganzen
// Bildschirm, Titel- und Zeitbalken sind weg, und diese Datei legt darüber:
//   - den eigenen Standort mit Flugrichtung (blauer Navigationspfeil)
//   - große Plus-/Minus-Tasten und eine Rücksetztaste (handschuhtauglich)
//   - eine Sperre gegen das automatische Abschalten des Bildschirms
// Die Windpfeile kommen unverändert von WindMap und werden dort weiter alle
// 3 min aufgefrischt.
//
// Hier stehen die Tasten, die Statuszeile und das Menü. Die Teile dahinter
// liegen seit Okt. 2026 (Punkt 19 der Code-Durchsicht; vorher eine Datei mit
// 1.700 Zeilen) in src/components/flight/:
//   position.ts  GPS mit Flugrichtung, Icon des eigenen Standorts
//   device.ts    Bildschirm wach halten, Netz da oder nicht, Uhrzeit
//   track.ts     Track-Aufzeichnung (Speicher und Linie auf der Karte)
//   igc.ts       IGC-Datei des Tracks
//   cables.ts    Kabel (Luftfahrthindernisse)
//   kk7.ts       KK7-Thermikkarte
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
// Zoomstufe der Übersichtstaste (Wunsch des Projektbesitzers, Okt. 2026;
// zuerst 10, dann 11): eigener Standort mit rund 20 km Kartenbreite am
// Handy, Zahlen der Windpfeile (ab 10) und Kabel (ab 11) sind sichtbar.
const OVERVIEW_ZOOM = 11;

// Beim Mitführen wird die Karte erst verschoben, wenn der Standort so weit
// (Bildschirmpixel) von der Mitte abgewandert ist. Spart Akku: Sonst würde die
// Karte bei jedem GPS-Wert (ca. 1× pro Sekunde) neu gezeichnet.
const FOLLOW_TOLERANCE_PX = 12;

// Hat man die Karte verschoben, springt sie nach dieser Zeit von selbst
// wieder auf den eigenen Standort (Wunsch des Projektbesitzers, Okt. 2026,
// nach dem Vorbild von burnair Go). Die Zoomstufe bleibt dabei, wie sie ist.
// Erneutes Verschieben startet die Zeit neu.
const RECENTER_AFTER_MS = 10_000;

// Ab diesem Alter gelten die angezeigten Windwerte als veraltet und die
// Uhrzeit in der Statuszeile wird gelb hinterlegt. Normal sind sie höchstens
// 3 min alt (Abruf-Takt); 15 min heißt: mehrere Abrufe sind gescheitert.
const WIND_OUTDATED_MS = 15 * 60 * 1000;

// Start, Stop und das Beenden des Flugmodus brauchen zwei Tipper (Wunsch des
// Projektbesitzers, Okt. 2026): Nach dem ersten steht an derselben Stelle ✕
// zum Abbrechen, darunter die gelbe Bestätigung ("STARTEN?", "STOPPEN?" bzw.
// "BEENDEN?", ohne "WIRKLICH" — Wunsch des Projektbesitzers); erst die löst aus.
// Bewusst kein window.confirm: dessen kleine OK-/Abbrechen-Knöpfe trifft man
// mit Handschuhen im Flug schlecht. Ohne zweiten Tipper springt die Taste nach
// dieser Zeit von selbst zurück, damit sie nicht "scharf" stehen bleibt.
const CONFIRM_MS = 5000;

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

// Eine Zeile im Menü, eingeschaltet gelb. 40 px hoch (zuerst 56 px; auf
// Wunsch des Projektbesitzers flacher, damit später weitere Einträge Platz
// haben) — mit Handschuhen noch gut zu treffen.
function menuOption(active: boolean): string {
  return `flex h-10 w-full items-center border-2 border-black px-3 text-left text-sm font-bold select-none ${
    active ? "bg-amber-300 active:bg-amber-400" : "bg-white active:bg-zinc-200"
  }`;
}

export default function FlightMode({
  map,
  defaultCenter,
  defaultZoom,
  lastUpdated,
  onExit,
  stationFilter,
  onStationFilterChange,
  missingSources,
}: {
  /** Die Leaflet-Karte (aus WindMap); null, solange sie noch aufgebaut wird. */
  map: L.Map | null;
  /** Ansicht der Rücksetztaste, solange es noch keinen GPS-Standort gibt. */
  defaultCenter: [number, number];
  defaultZoom: number;
  /** Letzter erfolgreicher Abruf der Windwerte (für die Statuszeile). */
  lastUpdated: Date | null;
  onExit: () => void;
  /** Stationsfilter (Zustand in WindApp), umschaltbar im Menü unten links. */
  stationFilter: StationFilter;
  onStationFilterChange: (filter: StationFilter) => void;
  /** Quellen ohne Daten beim letzten Abruf (siehe WindMap), als gelbe Statuszeile. */
  missingSources: WindStation["source"][];
}) {
  const { position, status } = useOwnPosition();
  const wakeLockActive = useWakeLock();
  const track = useTrack(map, position);
  const trackConfirm = useTrackConfirm(track.recording);
  const exitConfirm = useConfirmStep<"exit">();
  const cables = useCables(map);
  const kk7 = useKk7Layer(map, position, defaultCenter);
  // Menü unten links (Taste mit drei Strichen): KK7 und Stationsfilter.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);
  const online = useOnline();
  const now = useNow(30_000);

  // Mitführen: Die Karte folgt dem eigenen Standort, bis man sie selbst
  // verschiebt. RECENTER_AFTER_MS nach dem Loslassen (oder sofort über die
  // Rücksetztaste) folgt sie wieder. Als ref, weil die Zuhörer der Karte und
  // der GPS-Effekt denselben aktuellen Wert brauchen.
  const following = useRef(true);
  const [followingShown, setFollowingShown] = useState(true);
  const setFollowing = useCallback((value: boolean) => {
    following.current = value;
    setFollowingShown(value);
  }, []);
  // Beim ersten GPS-Wert einmal auf die Flug-Zoomstufe springen.
  const hadFirstFix = useRef(false);

  // Letzter Standort für das Zurückspringen (der Zeitgeber unten läuft
  // außerhalb des Renderns und braucht den jeweils neuesten Wert).
  const positionRef = useRef<OwnPosition | null>(null);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    if (!map) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopFollowing = () => {
      clearTimeout(timer);
      setFollowing(false);
    };
    // Zeit läuft ab dem Loslassen, nicht ab dem ersten Antippen: Wer länger
    // schiebt, um etwas anzusehen, hat danach trotzdem die vollen 10 s.
    const scheduleRecenter = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setFollowing(true);
        const current = positionRef.current;
        // panTo statt setView: Die gewählte Zoomstufe bleibt. Ohne Standort
        // holt der nächste GPS-Wert die Karte (Mitführen ist wieder an).
        if (current) map.panTo([current.lat, current.lng], { animate: false });
      }, RECENTER_AFTER_MS);
    };
    map.on("dragstart", stopFollowing);
    map.on("dragend", scheduleRecenter);
    return () => {
      clearTimeout(timer);
      map.off("dragstart", stopFollowing);
      map.off("dragend", scheduleRecenter);
    };
  }, [map, setFollowing]);

  // Zoomen im Flugmodus über die +/−-Tasten und mit zwei Fingern. Den
  // Zwei-Finger-Zoom hatte der Projektbesitzer zuerst auch abgeschaltet und im
  // Okt. 2026 ausdrücklich zurückgewünscht. Doppeltippen, Mausrad und
  // Rahmen-Zoom bleiben aus — im Flug zoomt sonst jede unruhige Berührung mit.
  // Verschieben geht weiter. Beim Verlassen ist auf der normalen Karte alles
  // wieder wie vorher.
  //
  // Zwei-Finger-Zoom um die Kartenmitte ("center") statt um die Stelle
  // zwischen den Fingern: Folgt die Karte dem Standort, bleibt er so beim
  // Zoomen in der Mitte, statt seitlich wegzurutschen.
  useEffect(() => {
    if (!map) return;
    const handlers = [map.doubleClickZoom, map.scrollWheelZoom, map.boxZoom];
    for (const handler of handlers) handler.disable();
    const previousTouchZoom = map.options.touchZoom;
    L.Util.setOptions(map, { touchZoom: "center" });
    map.touchZoom.enable();
    return () => {
      for (const handler of handlers) handler.enable();
      L.Util.setOptions(map, { touchZoom: previousTouchZoom });
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

    // Ungenauigkeits-Kreis (ACCURACY_CIRCLE_MIN_M): sichtbar, aber durchsichtig
    // genug, dass Windpfeile und Gelände darunter lesbar bleiben.
    if (position.accuracyM > ACCURACY_CIRCLE_MIN_M) {
      if (!accuracyRef.current) {
        accuracyRef.current = L.circle(latLng, {
          radius: position.accuracyM,
          color: OWN_POSITION_COLOR,
          weight: 1.5,
          opacity: 0.6,
          fillColor: OWN_POSITION_COLOR,
          fillOpacity: 0.18,
          interactive: false,
        }).addTo(map);
      } else {
        accuracyRef.current.setLatLng(latLng).setRadius(position.accuracyM);
      }
    } else {
      accuracyRef.current?.remove();
      accuracyRef.current = null;
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

  // Mit GPS-Standort steht hier nichts — die Genauigkeit zeigt der Kreis um
  // den Standort (ACCURACY_CIRCLE_MIN_M). Nur Probleme werden gemeldet.
  const gpsText =
    status === "ok" && position
      ? null
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
  // Stand der Kabel: Datum, wann der Server sie zuletzt beim Land
  // abgeholt hat (einmal am Tag, siehe /api/kabel). Gelb, wenn die
  // Aktualisierung nicht geklappt hat — die Karte zeigt dann weiter die Kabel
  // dieses Datums — oder wenn es gar keine Kabel gibt.
  // Nur das Datum, ohne Uhrzeit (Wunsch des Projektbesitzers, Okt. 2026): Die
  // Kabel ändern sich höchstens einmal am Tag.
  const cableText = cables.stand
    ? `Kabel ${cables.stand.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}`
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
  // Zoomtasten (+/−, Rücksetzen, Übersicht) mit halb durchsichtigem
  // Hintergrund, damit man die Karte darunter sieht (Wunsch des
  // Projektbesitzers, Okt. 2026). Nur der Hintergrund: Zeichen und Rand
  // bleiben voll deckend und gut lesbar.
  const zoomButtonLight = `${bigButton} bg-white/50 text-zinc-900 active:bg-zinc-200/50`;
  const zoomButtonDark = `${bigButton} bg-zinc-900/50 text-white active:bg-zinc-700/50`;
  // Kleinere Tasten oben links (Beenden, START/STOP und deren Nachfragen):
  // 48 px, Farbe kommt je Taste dazu.
  const smallButton =
    "pointer-events-auto flex h-12 w-12 items-center justify-center border-2 border-black shadow-lg select-none";

  return (
    <>
      {/* Anordnung der Tasten vom Projektbesitzer in einer Layout-Vorschau
          festgelegt (Okt. 2026) und danach nachgeschärft: oben links Beenden
          und rechts daneben START/STOP (beide 48 px), darunter die
          Statuszeile; oben rechts Plus/Minus; unten links IGC und
          Papierkorb, darüber die Taste der KK7-Thermikkarte; unten rechts Rücksetz- über Übersichtstaste. Abstände
          12 px, unten 28 px (Abstand zur Wischleiste des iPhones). */}

      {/* Oben links: Beenden und START/STOP nebeneinander, darunter die
          Statuszeile. Beide Tasten sind kleiner als die Zoomtasten, damit man
          sie im Flug nicht aus Versehen trifft, und brauchen einen zweiten
          Tipper (CONFIRM_MS): Nach dem ersten steht an derselben Stelle ✕ zum
          Abbrechen und darunter die gelbe Bestätigung ("BEENDEN?"
          usw.; Reihenfolge Wunsch des Projektbesitzers — zweimal Tippen an
          derselben Stelle bricht also ab, statt auszulösen). Nicht daneben:
          dort steht oben mittig das Filter-Schild. Die gelben Tasten sind so
          breit wie die normalen, damit nichts seitlich verrutscht; die
          Statuszeile rückt für das ✕ nach unten statt überdeckt zu werden.
          ✕ und START/STOP haben wie die Zoomtasten einen halb durchsichtigen
          Hintergrund (Wunsch des Projektbesitzers, Okt. 2026); die gelben
          Nachfragen und ihr ✕ bleiben voll deckend, sie sollen auffallen. */}
      <div className="pointer-events-none absolute top-[calc(0.75rem+env(safe-area-inset-top))] left-3 z-[1000] flex flex-col items-start gap-3">
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-3">
            {exitConfirm.armed ? (
              <>
                <button
                  type="button"
                  onClick={exitConfirm.cancel}
                  aria-label="Abbrechen"
                  title="Abbrechen"
                  className={`${smallButton} bg-white active:bg-zinc-200`}
                >
                  <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" strokeWidth="2.5" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={onExit}
                  aria-label="Flugmodus wirklich beenden"
                  className={`${smallButton} flex-col bg-amber-300 text-zinc-900 active:bg-amber-500`}
                >
                  <span className="text-[10px] leading-tight font-bold tracking-tight">BEENDEN?</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => exitConfirm.arm("exit")}
                aria-label="Flugmodus beenden"
                title="Flugmodus beenden"
                className={`${smallButton} bg-white/50 active:bg-zinc-200/50`}
              >
                <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" strokeWidth="2.5" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex flex-col gap-3">
            {trackConfirm.pending ? (
              <>
                {/* An der alten Stelle ✕ zum Abbrechen, darunter die gelbe Bestätigung (CONFIRM_MS). */}
                <button
                  type="button"
                  onClick={trackConfirm.cancel}
                  aria-label="Abbrechen"
                  title="Abbrechen"
                  className={`${smallButton} bg-white active:bg-zinc-200`}
                >
                  <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" strokeWidth="2.5" />
                  </svg>
                </button>
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
                  className={`${smallButton} flex-col bg-amber-300 text-zinc-900 active:bg-amber-500`}
                >
                  <span className="text-[10px] leading-tight font-bold tracking-tight">
                    {trackConfirm.pending === "stop" ? "STOPPEN?" : "STARTEN?"}
                  </span>
                </button>
              </>
            ) : track.recording ? (
              <button
                type="button"
                onClick={() => trackConfirm.arm("stop")}
                aria-label="Track-Aufzeichnung stoppen"
                title="Track-Aufzeichnung stoppen"
                className={`${smallButton} flex-col gap-0.5 bg-red-600/50 text-white active:bg-red-800/50`}
              >
                <svg width="14" height="14" viewBox="0 0 22 22" aria-hidden="true">
                  <rect x="2" y="2" width="18" height="18" fill="currentColor" />
                </svg>
                <span className="text-[10px] leading-none font-bold">STOP</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => trackConfirm.arm("start")}
                aria-label="Track-Aufzeichnung starten"
                title="Track-Aufzeichnung starten"
                className={`${smallButton} flex-col gap-0.5 bg-white/50 text-zinc-900 active:bg-zinc-200/50`}
              >
                <svg width="14" height="14" viewBox="0 0 22 22" aria-hidden="true">
                  <circle cx="11" cy="11" r="10" fill="#dc2626" />
                </svg>
                <span className="text-[10px] leading-none font-bold">START</span>
              </button>
            )}
          </div>
        </div>
        {/* Statuszeile (GPS-Genauigkeit, Stand der Windwerte und Kabel,
            Track-Länge, ob der Bildschirm wach gehalten wird). */}
        <div className="flex flex-col items-start gap-1 text-left text-xs font-bold text-zinc-900">
          {gpsText && <span className="bg-white/90 px-1.5 py-0.5 shadow">{gpsText}</span>}
          {!online && <span className="bg-amber-300 px-1.5 py-0.5 shadow">Offline</span>}
          {/* Gelb, wenn die Windwerte alt sind (z. B. ohne Netz die zuletzt
              gespeicherten): Die Uhrzeit sagt dann, von wann sie stammen. */}
          <span className={`px-1.5 py-0.5 shadow ${windOutdated ? "bg-amber-300" : "bg-white/90"}`}>
            {updatedText}
          </span>
          {/* Quelle(n), die gerade keine Daten liefern — ihre Stationen stehen
              mit dem letzten gespeicherten Wert auf der Karte, nach der
              Grau-Grenze grau (siehe MISSING_SOURCES_HEADER in wind.ts).
              Höchstens so breit, dass sie nicht unter die +/−-Tasten rechts
              läuft (umbricht stattdessen). */}
          {missingSources.length > 0 && (
            <span className="max-w-[calc(100vw-7.5rem)] bg-amber-300 px-1.5 py-0.5 shadow">
              Keine Daten: {listSourceLabels(missingSources)}
            </span>
          )}
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
      <div className="pointer-events-none absolute top-[calc(0.75rem+env(safe-area-inset-top))] right-3 z-[1000] flex flex-col gap-3">
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

      {/* Unten links: die Menü-Taste (drei Striche), darunter bei gestopptem
          Track die Tasten IGC-Export und Löschen (die START/STOP-Taste steht
          oben neben Beenden). */}
      <div className="pointer-events-none absolute bottom-7 left-3 z-[1000] flex flex-col items-start gap-3">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Menü"
          aria-expanded={menuOpen}
          title="Menü"
          className={`${smallButton} bg-white/50 text-zinc-900 active:bg-zinc-200/50`}
        >
          {/* Drei Striche mit geraden Enden wie früher der Menü-Knopf im Titel. */}
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 5 H21 M3 12 H21 M3 19 H21" stroke="currentColor" strokeWidth="2.5" />
          </svg>
        </button>
        <div className="flex items-end gap-3">
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
          Übersichtstaste (eigener Standort, Zoom 11). Die Rücksetztaste ist
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
      {/* Menü (Wunsch des Projektbesitzers, Okt. 2026): öffnet sich über die
          Taste mit den drei Strichen unten links. Groß und mit hohen Zeilen,
          damit man es mit Handschuhen trifft (Zeilen 40 px, siehe menuOption). Eingeschaltete Ebenen und der
          aktive Stationsfilter haben einen GELBEN Hintergrund (wie die
          Nachfragen START/STOP), alles andere ist weiß. Ein Tipp schaltet um,
          das Menü bleibt offen; geschlossen wird es mit ✕ oben rechts. Es
          liegt über den Tasten unten (z-[1001]); oben bleiben Beenden,
          Statuszeile und +/− sichtbar. */}
      {menuOpen && (
        <div
          role="dialog"
          aria-label="Menü"
          className="absolute right-3 bottom-7 left-3 z-[1001] max-h-[calc(100%-120px)] overflow-y-auto border-2 border-black bg-white text-zinc-900 shadow-2xl sm:right-auto sm:w-96"
        >
          <div className="flex items-center justify-between border-b-2 border-black pl-4">
            <span className="text-base font-extrabold tracking-wide">MENÜ</span>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label="Menü schließen"
              title="Menü schließen"
              className="flex h-11 w-11 items-center justify-center border-l-2 border-black active:bg-zinc-200"
            >
              <svg width="24" height="24" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" strokeWidth="2.5" />
              </svg>
            </button>
          </div>
          <div className="flex flex-col gap-3 p-3">
            <section>
              <h2 className="mb-1.5 text-xs font-bold tracking-wide text-zinc-500">EBENEN</h2>
              <button
                type="button"
                onClick={kk7.toggle}
                aria-pressed={kk7.enabled}
                className={`${menuOption(kk7.enabled)} justify-between`}
              >
                <span>KK7-Thermikkarte</span>
                <span className="text-xs">{kk7.enabled ? "AN" : "AUS"}</span>
              </button>
            </section>
            <section>
              <h2 className="mb-1.5 text-xs font-bold tracking-wide text-zinc-500">WINDSTATIONEN</h2>
              <ul aria-label="Stationsfilter" className="flex flex-col gap-1.5">
                {STATION_FILTER_ORDER.map((filter) => (
                  <li key={filter}>
                    <button
                      type="button"
                      onClick={() => onStationFilterChange(filter)}
                      aria-pressed={filter === stationFilter}
                      className={menuOption(filter === stationFilter)}
                    >
                      {getStationFilterLabel(filter)}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
