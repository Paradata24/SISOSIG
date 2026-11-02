"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  buildTimelineFrame,
  buildTimelineSlots,
  GRID_MS,
  HISTORY_HOURS,
  CABLE_SOURCE,
  KK7_SOURCE,
  MAP_SOURCES,
  STATION_FILTER_ORDER,
  TIMELINE_RECENT_PATH,
  type StationFilter,
  type TimelinePayload,
} from "@/lib/wind";
import { mergeRecentTimeline, TIMELINE_MERGE_MAX_GAP_MS } from "@/lib/timelineMerge";
import WindMapLoader from "@/components/WindMapLoader";
import LayerMenu, { type MainLayers } from "@/components/LayerMenu";
import TimeSlider, { buildStripColors, type TimelineStatus } from "@/components/TimeSlider";

// Zuletzt gewählter Stationsfilter, im Browser des Geräts gemerkt (Punkt 20
// der Code-Durchsicht, Okt. 2026): Wer z. B. meist den Windanzeiger nutzt,
// muss ihn nicht bei jedem Öffnen neu wählen. Gilt für Hauptseite und
// Flugmodus gemeinsam. Den Kartenausschnitt merkt sich WindMap.
const FILTER_STORAGE_KEY = "sisosig-filter-v1";

// Ebenen der Hauptseite (KK7, Kabel; Ebenen-Menü oben rechts, Nov. 2026),
// ebenfalls im Browser gemerkt. Getrennt von der KK7-Wahl im Flugmodus: Dort
// ist KK7 von Haus aus an und die Kabel immer, auf der Hauptseite beides von
// Haus aus aus (sonst sähe die Windkarte beim ersten Öffnen ganz anders aus).
const LAYERS_STORAGE_KEY = "sisosig-ebenen-v1";
const DEFAULT_LAYERS: MainLayers = { kk7: false, cables: false };

function readStoredLayers(): MainLayers | null {
  try {
    const text = window.localStorage.getItem(LAYERS_STORAGE_KEY);
    if (!text) return null;
    const data = JSON.parse(text) as Partial<MainLayers>;
    return { kk7: data.kk7 === true, cables: data.cables === true };
  } catch {
    return null;
  }
}

// Für useSyncExternalStore unten: ein "Speicher", der sich nie ändert — es
// geht nur um den Unterschied Server (false) / Browser (true).
function subscribeNothing() {
  return () => {};
}

// Zeitbalken-Daten: die vollen 48 h oder nur die letzten Stunden (Punkt 27,
// siehe ensureTimeline unten und src/lib/timelineMerge.ts).
const TIMELINE_FULL_URL = "/api/timeline";
const TIMELINE_RECENT_URL = TIMELINE_RECENT_PATH;

async function loadTimeline(url: string): Promise<TimelinePayload> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Status ${res.status}`);
  return data as TimelinePayload;
}

function readStoredFilter(): StationFilter | null {
  try {
    const value = window.localStorage.getItem(FILTER_STORAGE_KEY);
    // Nur bekannte Filter (ein alter oder fremder Wert gilt als "nichts gemerkt").
    return STATION_FILTER_ORDER.find((filter) => filter === value) ?? null;
  } catch {
    return null;
  }
}

// Titel-Balken + Karte + Zeitbalken. Im Titel-Balken steht der Titel mit dem
// "GO" für den Flugmodus, ganz rechts das Ebenen-Menü (LayerMenu, drei
// Striche: KK7, Kabel, darunter die Quellen; Nov. 2026). Das Filter-Schild
// (StationFilterPicker) steht oben mittig auf der Karte (WindMap). Filter- und
// Ebenen-Zustand leben hier, weil Balken und Karte getrennte Bereiche der
// Seite sind und der Filter auch im Flugmodus gilt.
// Dasselbe gilt für den Zeitbalken unten: er steht außerhalb der Karte, also
// gehört sein Zustand hierher.
export default function WindApp() {
  const [stationFilter, setStationFilter] = useState<StationFilter>("all");
  // Den gemerkten Filter erst nach dem ersten Bildaufbau übernehmen (wie bei
  // "?flug" unten): Der Server kennt den Speicher des Geräts nicht, und so
  // bleibt der erste Bildaufbau gleich dem vom Server. Die Karte ist dann noch
  // gar nicht geladen, es springt also nichts sichtbar um.
  useEffect(() => {
    const saved = readStoredFilter();
    if (!saved || saved === "all") return;
    const frame = requestAnimationFrame(() => setStationFilter(saved));
    return () => cancelAnimationFrame(frame);
  }, []);
  // Feste Referenz: Filter-Schild und Flugmodus-Menü bekommen sie als Prop.
  const changeStationFilter = useCallback((filter: StationFilter) => {
    setStationFilter(filter);
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, filter);
    } catch {
      // Ohne Speicher (z. B. privates Fenster) gilt die Wahl bis zum Neuladen.
    }
  }, []);

  // Ebenen der Hauptseite. Wie beim Filter: Gemerktes erst nach dem ersten
  // Bildaufbau übernehmen.
  const [mainLayers, setMainLayers] = useState<MainLayers>(DEFAULT_LAYERS);
  useEffect(() => {
    const saved = readStoredLayers();
    if (!saved || (!saved.kk7 && !saved.cables)) return;
    const frame = requestAnimationFrame(() => setMainLayers(saved));
    return () => cancelAnimationFrame(frame);
  }, []);
  const toggleMainLayer = useCallback((key: keyof MainLayers) => {
    setMainLayers((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ohne Speicher gilt die Wahl bis zum Neuladen.
      }
      return next;
    });
  }, []);

  // Zeitpunkt des letzten erfolgreichen Abrufs der Live-Werte (meldet WindMap);
  // steht als "Zuletzt aktualisiert" mittig unter dem Rad im Zeitbalken.
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Der Zeitbalken erscheint erst im Browser (Okt. 2026): Er zeigt Uhrzeiten
  // aus der Uhr des Browsers, die beim Bauen vorbereitete Seite enthielt aber
  // die Uhrzeit des Bauens (in der Zeitzone des Servers). React meldete
  // deshalb bei jedem Aufruf "Hydration failed" (Fehler #418) und baute die
  // Seite ein zweites Mal auf. Die Karte lädt ohnehin erst im Browser; der
  // Balken kommt also mit ihr, ohne sichtbaren Unterschied.
  const inBrowser = useSyncExternalStore(subscribeNothing, () => true, () => false);

  // --- Zeitbalken ---
  // Die Rasterzeitpunkte kommen allein aus der Uhr des Browsers, damit der
  // Balken schon beim ersten Bildaufbau steht.
  const [slots, setSlots] = useState<number[]>(() => buildTimelineSlots(Date.now()));
  // Gespeichert wird der ZEITPUNKT, nicht die Position im Balken: die Slot-
  // Liste wandert alle 10 Minuten weiter, über die Position würde ein einmal
  // gewählter Zeitpunkt also stillschweigend verrutschen. null = live.
  const [selectedTime, setSelectedTime] = useState<number | null>(null);

  // --- Geöffnete Station ---
  // Der Zustand liegt hier statt in WindMap, weil WindApp bei geöffneter
  // Station den Zeitbalken ausblendet. Beim Öffnen springt der Zeitbalken auf
  // "aktuell" zurück: Die Karte zeigt nur noch die aktuellen Werte, und nach
  // dem Schließen steht der Zeitbalken wieder auf "Aktuell". Feste Referenz
  // (useCallback), weil die Marker-Klick-Handler der Karte daran hängen.
  const [selectedStationCode, setSelectedStationCode] = useState<string | null>(null);
  const handleSelectStation = useCallback((code: string | null) => {
    setSelectedStationCode(code);
    if (code !== null) setSelectedTime(null);
  }, []);

  // --- Flugmodus ("GO" im Titel, siehe FlightMode.tsx) ---
  // Titel- und Zeitbalken verschwinden, die Karte füllt den Bildschirm, und
  // darüber liegen Standort und große Zoom-Tasten. Die Karte zeigt dabei immer
  // die aktuellen Werte, eine geöffnete Station wird geschlossen.
  const [flightMode, setFlightMode] = useState(false);
  const enterFlightMode = useCallback(() => {
    setFlightMode(true);
    setSelectedStationCode(null);
    setSelectedTime(null);
    // Vollbild blendet am Android-Handy auch die Adressleiste aus. iPhones
    // kennen das für Webseiten nicht — dort passiert einfach nichts.
    document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
  }, []);
  const exitFlightMode = useCallback(() => {
    setFlightMode(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);
  // Abkürzung "Flugmodus" der Web-App (langes Drücken aufs App-Symbol bei
  // Android, siehe shortcuts in src/app/manifest.ts): öffnet "/?flug" und
  // startet direkt im Flugmodus. Danach wird "?flug" aus der Adresse
  // entfernt, damit Neuladen wieder die normale Karte zeigt.
  // Im requestAnimationFrame statt direkt im Effekt: Die Adresse gibt es erst
  // im Browser, und so bleibt der erste Bildaufbau gleich dem vom Server.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("flug")) return;
    const frame = requestAnimationFrame(() => {
      setFlightMode(true);
      window.history.replaceState(null, "", window.location.pathname);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const [timeline, setTimeline] = useState<TimelinePayload | null>(null);
  // Startwert "loading": Die Daten werden gleich beim Seitenaufruf geholt
  // (siehe ensureTimeline). Bei späterem Auffrischen bleibt der Status
  // bewusst "ready" — die bisherigen Daten gelten bis dahin weiter.
  const [timelineStatus, setTimelineStatus] = useState<TimelineStatus>("loading");
  // Beide bewusst als ref und nicht als state: ensureTimeline wird beim
  // schnellen Ziehen sehr oft hintereinander aufgerufen, teils noch bevor React
  // ein Neuzeichnen hinter sich hat. Ein state-Wert wäre in diesen Aufrufen
  // noch der alte — die Daten würden mehrfach geladen.
  const timelineLoading = useRef(false);
  const timelineFetchedAt = useRef(0);
  // Der aktuelle Stand noch einmal als ref: ensureTimeline fügt neue Stunden
  // in ihn ein und darf dafür keinen veralteten state-Wert erwischen.
  const timelineRef = useRef<TimelinePayload | null>(null);

  // Die Slot-Liste alle 60 s nachziehen, damit "jetzt" auch bei einem lange
  // offenen Tab wirklich jetzt ist. Neu gesetzt wird nur, wenn sich der
  // jüngste Rasterpunkt geändert hat — sonst würde die Karte im Leerlauf
  // ständig neu zeichnen. Im Hintergrund (Tab nicht sichtbar) passiert nichts,
  // gleiche Regel wie beim Abrufen der Live-Werte in WindMap.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      const next = buildTimelineSlots(Date.now());
      setSlots((prev) =>
        prev[prev.length - 1] === next[next.length - 1] ? prev : next,
      );
    };
    const interval = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // Wandert der älteste Rasterpunkt über den gewählten Zeitpunkt hinweg, rückt
  // die Auswahl mit — sonst stünde der Griff außerhalb des Balkens. Bewusst
  // beim Rendern abgeleitet statt in einem Effekt nachgesetzt: das spart einen
  // zusätzlichen Renderdurchlauf und kann nicht "hinterherhinken".
  const clampedTime =
    selectedTime !== null && selectedTime < slots[0] ? slots[0] : selectedTime;

  // Die Verlaufsdaten werden seit dem Umbau des Zeitbalkens (Sept. 2026)
  // gleich beim Seitenaufruf geholt und alle 10 min (neuer Rasterschritt)
  // aufgefrischt: Der Farbstrich im Zeitbalken braucht sie, um ohne Anfassen
  // zu zeigen, wann es windig war (früher erst beim ersten Anfassen, um die
  // Datenmenge zu sparen). Nachgeladen wird nur, wenn der Datenstand älter
  // als ein Rasterschritt ist; /api/timeline ist außerdem 60 s zwischen-
  // gespeichert.
  //
  // SPARSAM (Punkt 27, Nov. 2026): Die vollen 48 h (~450 KB) holt nur die
  // Hauptseite beim Öffnen. Zum Auffrischen kommen nur die letzten 8 h
  // (~80 KB) und werden eingefügt (mergeRecentTimeline, Ergebnis genau wie
  // beim vollen Laden). Der Flugmodus holt überhaupt nur die 8 h — er zeigt
  // keinen Zeitbalken und braucht den Verlauf nur für die Messfehler-Erkennung
  // der Live-Werte. Volle 48 h gibt es wieder, wenn die Hauptseite sie braucht
  // (nach einem Start im Flugmodus) oder das letzte Laden länger als
  // TIMELINE_MERGE_MAX_GAP_MS her ist (z. B. nach Stunden im Hintergrund).
  //
  // Als Promise-Kette statt async/await geschrieben: So ist auch für die
  // Lint-Regel erkennbar, dass alle setState-Aufrufe erst nach der Antwort
  // passieren (sonst meldet sie den Aufruf im Effekt unten fälschlich).
  const ensureTimeline = useCallback((flight: boolean) => {
    if (timelineLoading.current) return;
    const current = timelineRef.current;
    const age = timelineFetchedAt.current ? Date.now() - timelineFetchedAt.current : Infinity;
    // Die Hauptseite braucht die ganzen 48 h (Farbstrich, Zurückblättern).
    const needFull = !flight && (!current || current.hours < HISTORY_HOURS);
    // Bereits geholt und noch keinen Rasterschritt alt: nichts zu tun.
    if (!needFull && age <= GRID_MS) return;
    const canMerge = current !== null && age <= TIMELINE_MERGE_MAX_GAP_MS;
    const recentOnly = flight || (!needFull && canMerge);

    timelineLoading.current = true;
    loadTimeline(recentOnly ? TIMELINE_RECENT_URL : TIMELINE_FULL_URL)
      .then(async (payload) => {
        let next: TimelinePayload | null = payload;
        if (recentOnly && current && canMerge) {
          next = mergeRecentTimeline(current, payload);
          // Ließ sich nicht einfügen (Lücke zwischen den Ständen): im
          // Flugmodus genügen die 8 h, die Hauptseite holt dann doch alles.
          if (!next) next = flight ? payload : await loadTimeline(TIMELINE_FULL_URL);
        }
        timelineRef.current = next;
        setTimeline(next);
        setTimelineStatus("ready");
        timelineFetchedAt.current = Date.now();
      })
      .catch(() => setTimelineStatus("error"))
      .finally(() => {
        // Auch nach einem Fehlschlag wieder freigeben, damit der nächste
        // Anlauf (neuer Rasterschritt) es erneut versucht
        // (timelineFetchedAt bleibt dann auf 0, die Sperre oben greift nicht).
        timelineLoading.current = false;
      });
  }, []);

  // Beim Start, bei jedem neuen Rasterschritt (Slot-Liste rückt weiter) und
  // beim Wechsel in den bzw. aus dem Flugmodus die Verlaufsdaten holen bzw.
  // auffrischen. Beim allerersten Aufruf steht ein Start über "?flug" noch
  // nicht im Zustand (der wird erst im nächsten Bild gesetzt, siehe oben) —
  // deshalb zusätzlich die Adresse prüfen, sonst kämen dafür einmal unnötig
  // die vollen 48 h.
  useEffect(() => {
    ensureTimeline(flightMode || new URLSearchParams(window.location.search).has("flug"));
  }, [slots, flightMode, ensureTimeline]);

  // Titel- und Zeitbalken liegen auf der Hauptseite halb durchsichtig ÜBER der
  // Karte (Wunsch des Projektbesitzers, Okt. 2026): Die Karte füllt dafür den
  // ganzen Bildschirm, die Balken schweben oben und unten darüber. Die Höhe
  // des Titel-Balkens bekommt WindMap, damit die Fehlermeldung darunter
  // rückt. Gemessen statt fest eingetragen: Unter 360 px Breite bricht der
  // Titel in zwei Zeilen um. Im Flugmodus gibt es den Balken nicht (0).
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    if (!headerEl) return;
    const observer = new ResizeObserver(() => setHeaderHeight(headerEl.offsetHeight));
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [headerEl]);

  // Welche Stationen gerade im Kartenausschnitt sichtbar sind (meldet
  // WindMap nach jedem Verschieben/Zoomen). Daraus entsteht der Farbstrich
  // im Zeitbalken — er zeigt also immer das Gebiet, das man gerade ansieht.
  const [viewportCodes, setViewportCodes] = useState<string[] | null>(null);
  const stripColors = useMemo(
    () => buildStripColors(timeline, slots, viewportCodes),
    [timeline, slots, viewportCodes],
  );

  // Beim schnellen Ziehen feuert der Zeitbalken viele Male pro Sekunde. Mit
  // useDeferredValue bleibt die Uhrzeit im Balken sofort flüssig, während die
  // Karte (bis zu ~130 Pfeile neu zeichnen) in ihrem eigenen Tempo nachzieht.
  const deferredTime = useDeferredValue(clampedTime);
  // Bei geöffneter Station gibt es keinen Verlaufs-Ausschnitt: Karte und
  // Verlaufsbalken zeigen dann nur die aktuellen Werte (Wunsch des
  // Projektbesitzers). Das hier direkt zu erzwingen vermeidet, dass der
  // verzögerte Zeitpunkt (deferredTime) noch einen Moment alte Werte zeigt.
  const historyFrame = useMemo(
    () => (selectedStationCode ? null : buildTimelineFrame(timeline, deferredTime)),
    [timeline, deferredTime, selectedStationCode],
  );

  return (
    <>
      {/* Der Balken ist eine Flex-Reihe: links ein leerer Platzhalter so breit
          wie der Ebenen-Knopf (damit der Titel genau mittig steht), dann der
          Titel (nimmt den freien Platz und bricht bei Bedarf um), rechts das
          Ebenen-Menü. Einen
          Aktualisieren-Knopf links gibt es seit Okt. 2026 nicht mehr (Wunsch
          des Projektbesitzers): Die Seite holt alle 3 min und beim
          Zurückkehren zur Seite von selbst neue Werte. Bewusst NICHT mit
          absolut gesetzten Knöpfen über einem mittigen Titel — auf schmalen
          Handys würden sich Titel und Knöpfe sonst überlappen. */}
      {/* Im Flugmodus ist der Titel-Balken weg (ganzer Bildschirm für die
          Karte); beendet wird er über die ✕-Taste auf der Karte. */}
      {!flightMode && (
        // Halb durchsichtig (bg-white/50) über der Karte, siehe headerHeight.
        <header
          ref={setHeaderEl}
          // pt mit safe-area: Am iPhone (App) reicht der Balken samt halb
          // durchsichtigem Hintergrund bis unter Uhrzeit und Akku (layout.tsx).
          className="absolute inset-x-0 top-0 z-[1100] flex items-center gap-2 border-b border-zinc-200 bg-white/50 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 dark:border-zinc-800 dark:bg-zinc-900/50"
        >
          {/* Der GANZE Titel ist der Knopf für den Flugmodus (Wunsch des
              Projektbesitzers, Okt. 2026). Aussehen vom Projektbesitzer aus
              Entwürfen gewählt ("London Calling", nach dem Plattencover von
              The Clash): Der Satz steht schlicht da, nur "GO" ist ein
              gerades schwarzes Feld mit pinker Schrift. Den grünen Schatten
              und die Schräglage hat der Projektbesitzer danach wieder
              entfernen lassen. Antippbar ist die ganze Zeile; beim Antippen
              wird das Feld kurz blasser (group-active). */}
          <div className="w-9 shrink-0" aria-hidden="true" />
          <h1 className="flex min-w-0 flex-1 justify-center">
            <button
              type="button"
              onClick={enterFlightMode}
              aria-label="Should I stay or should I GO – Flugmodus starten"
              title="Flugmodus starten"
              className="group text-center text-base font-semibold text-zinc-900 sm:text-lg dark:text-zinc-50"
            >
              Should I stay or should I{" "}
              <span className="ml-1 inline-block bg-black px-2 py-0.5 align-middle text-[22px] leading-none font-extrabold tracking-wide text-[#f06ea9] uppercase group-active:opacity-70">
                GO
              </span>
            </button>
          </h1>
          {/* Oben rechts das Ebenen-Menü (drei Striche, Wunsch des
              Projektbesitzers, Nov. 2026): KK7 und Kabel ein/aus, darunter die
              Quellen. Bis dahin stand hier das Filter-Schild; das steht jetzt
              wieder oben mittig auf der Karte (WindMap). z-[1100]: Die
              aufgeklappte Liste liegt über der Karte. */}
          <div className="relative z-[1100] shrink-0">
            <LayerMenu
              layers={mainLayers}
              onToggle={toggleMainLayer}
              footer={
                <>
                  {/* Quellenangaben der Karte (MAP_SOURCES in wind.ts) —
                      früher als Leaflet-Zeile unten rechts auf der Karte, dann
                      im Menü-Popup, im Okt. 2026 unter den Filtern, seit
                      Nov. 2026 im Ebenen-Menü.
                      Die Quellen der Winddaten stehen bewusst NICHT hier,
                      sondern stationsweise unten im Verlaufsbalken
                      ("Quelle: …") — Wunsch des Projektbesitzers, keine
                      Doppelung. Bewusst klein und grau: Pflichtangabe, aber
                      keine Bedienung. NICHT entfernen, die Nennung ist
                      Lizenzpflicht. */}
                  <p className="mt-3 mb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                    Quellen
                  </p>
                  <ul className="space-y-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                    {MAP_SOURCES.map((source) => (
                      <li key={source.label}>
                        <SourceLink url={source.url}>{source.label}</SourceLink>
                        {source.note ? ` (${source.note})` : null}
                      </li>
                    ))}
                    <li>
                      <SourceLink url={CABLE_SOURCE.url}>{CABLE_SOURCE.label}</SourceLink>
                    </li>
                    <li>
                      <SourceLink url={KK7_SOURCE.url}>{KK7_SOURCE.label}</SourceLink>
                      {` (${KK7_SOURCE.note})`}
                    </li>
                    <li>
                      <SourceLink url="https://leafletjs.com">Leaflet</SourceLink>
                    </li>
                  </ul>
                </>
              }
            />
          </div>
        </header>
      )}
      {/* Die Karte füllt den ganzen Bildschirm, auch unter den Balken. z-0
          hält alle Leaflet-Ebenen unter Titel- und Zeitbalken. */}
      <main className="absolute inset-0 z-0">
        <WindMapLoader
          stationFilter={stationFilter}
          onStationFilterChange={changeStationFilter}
          mainLayers={mainLayers}
          historyFrame={historyFrame}
          timeline={timeline}
          onViewportStationsChange={setViewportCodes}
          selectedStationCode={selectedStationCode}
          // Im Flugmodus öffnet ein Antippen der Pfeile nichts: Mit
          // Handschuhen trifft man leicht aus Versehen, und der
          // Verlaufsbalken würde die halbe Karte verdecken.
          onSelectStation={flightMode ? ignoreStationSelect : handleSelectStation}
          onDataLoaded={setLastUpdated}
          flightMode={flightMode}
          lastUpdated={lastUpdated}
          onExitFlightMode={exitFlightMode}
          topInset={flightMode ? 0 : headerHeight}
        />
      </main>
      {/* Unten halb durchsichtig ÜBER der Karte (siehe headerHeight). Bei
          geöffneter Station ist sie weg (Wunsch des Projektbesitzers): Dann
          zeigt die Karte nur die aktuellen Werte, und der Verlaufsbalken
          reicht bis zum Seitenende. */}
      {inBrowser && selectedStationCode === null && !flightMode && (
        <div className="absolute inset-x-0 bottom-0 z-[1000]">
          <TimeSlider
            slots={slots}
            selectedTime={clampedTime}
            onChange={setSelectedTime}
            status={timelineStatus}
            stripColors={stripColors}
            lastUpdated={lastUpdated}
          />
        </div>
      )}
    </>
  );
}

// Feste Referenz (außerhalb der Komponente), damit die Klick-Handler der
// Marker im Flugmodus nicht bei jedem Neuzeichnen neu angemeldet werden.
function ignoreStationSelect() {}

// Ein Link in der Quellenliste im Ebenen-Menü (öffnet in neuem Tab).
function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
    >
      {children}
    </a>
  );
}
