"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  buildTimelineFrame,
  buildTimelineSlots,
  getStationFilterLabel,
  GRID_MS,
  MAP_SOURCES,
  STATION_FILTER_ORDER,
  type BaseLayer,
  type StationFilter,
  type TimelinePayload,
} from "@/lib/wind";
import WindMapLoader from "@/components/WindMapLoader";
import TimeSlider, { type TimelineStatus } from "@/components/TimeSlider";

// Titel-Balken + Karte + Zeitbalken. Oben links im Titel-Balken steht der
// Refresh-Button, ganz rechts der Menü-Button (3 Linien), der ein Popup mit
// Kartenhintergrund und Stationsfilter öffnet. Der Zustand lebt hier (und nicht in
// WindMap), weil Balken und Karte getrennte Bereiche der Seite sind.
// Dasselbe gilt für den Zeitbalken unten: er steht außerhalb der Karte, also
// gehört sein Zustand hierher.
export default function WindApp() {
  const [baseLayer, setBaseLayer] = useState<BaseLayer>("relief");
  const [stationFilter, setStationFilter] = useState<StationFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // --- Refresh-Button ---
  // Zähler statt Ja/Nein: jede Erhöhung ist ein neuer Auftrag an Karte und
  // Verlaufsbalken, sofort frisch zu laden (siehe refreshToken in WindMap).
  const [refreshToken, setRefreshToken] = useState(0);
  // Nur für die Dreh-Animation des Symbols, damit man sieht, dass der Klick
  // angekommen ist.
  const [refreshSpinning, setRefreshSpinning] = useState(false);

  // --- Zeitbalken ---
  // Die Rasterzeitpunkte kommen allein aus der Uhr des Browsers, damit der
  // Balken schon beim ersten Bildaufbau steht.
  const [slots, setSlots] = useState<number[]>(() => buildTimelineSlots(Date.now()));
  // Gespeichert wird der ZEITPUNKT, nicht die Position im Balken: die Slot-
  // Liste wandert alle 10 Minuten weiter, über die Position würde ein einmal
  // gewählter Zeitpunkt also stillschweigend verrutschen. null = live.
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<TimelinePayload | null>(null);
  const [timelineStatus, setTimelineStatus] = useState<TimelineStatus>("idle");
  // Beide bewusst als ref und nicht als state: ensureTimeline wird beim
  // schnellen Ziehen sehr oft hintereinander aufgerufen, teils noch bevor React
  // ein Neuzeichnen hinter sich hat. Ein state-Wert wäre in diesen Aufrufen
  // noch der alte — die Daten würden mehrfach geladen.
  const timelineLoading = useRef(false);
  const timelineFetchedAt = useRef(0);

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

  // Die Verlaufsdaten werden BEWUSST erst beim ersten Anfassen des Balkens
  // geholt, nicht schon beim Seitenaufruf: die meisten Besucher wollen nur die
  // Live-Karte, und die rund 20 KB sollen sie nicht kosten. Danach wird nur
  // nachgeladen, wenn der Datenstand älter als ein Rasterschritt ist.
  const ensureTimeline = useCallback(async () => {
    if (timelineLoading.current) return;
    // Bereits geholt und noch keinen Rasterschritt alt: nichts zu tun.
    if (timelineFetchedAt.current && Date.now() - timelineFetchedAt.current <= GRID_MS) {
      return;
    }
    timelineLoading.current = true;
    setTimelineStatus("loading");
    try {
      const res = await fetch("/api/timeline");
      const data = await res.json();
      if (!res.ok) {
        setTimelineStatus("error");
        return;
      }
      setTimeline(data as TimelinePayload);
      setTimelineStatus("ready");
      timelineFetchedAt.current = Date.now();
    } catch {
      setTimelineStatus("error");
    } finally {
      // Auch nach einem Fehlschlag wieder freigeben, damit ein zweites
      // Anfassen des Balkens es erneut versucht (timelineFetchedAt bleibt in
      // dem Fall auf 0, die Sperre oben greift also nicht).
      timelineLoading.current = false;
    }
  }, []);

  // Refresh: zurück auf "live", neue Live-Werte holen und den Zeitbalken-
  // Datenstand verwerfen, damit er beim nächsten Anfassen frisch lädt. Wird
  // gerade (noch) geladen, bleibt der laufende Abruf einfach bestehen.
  // Hinweis: "frischer" als der Wetterdienst selbst geht es nicht — die
  // Stationen messen nur alle 5–10 min und /api/wind wird bis zu 60 s
  // zwischengespeichert (Caching bewusst beibehalten, siehe CLAUDE.md).
  const handleRefresh = useCallback(() => {
    setSelectedTime(null);
    timelineFetchedAt.current = 0;
    setRefreshToken((n) => n + 1);
    setRefreshSpinning(true);
    window.setTimeout(() => setRefreshSpinning(false), 700);
  }, []);

  // Beim schnellen Ziehen feuert der Regler viele Male pro Sekunde. Mit
  // useDeferredValue bleibt die Uhrzeit im Balken sofort flüssig, während die
  // Karte (bis zu ~130 Pfeile neu zeichnen) in ihrem eigenen Tempo nachzieht.
  const deferredTime = useDeferredValue(clampedTime);
  const historyFrame = useMemo(
    () => buildTimelineFrame(timeline, deferredTime),
    [timeline, deferredTime],
  );

  // Popup schließen, sobald außerhalb von Button/Popup geklickt (oder auf dem
  // Handy getippt) wird. "pointerdown" deckt Maus und Touch gemeinsam ab.
  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  function optionClass(active: boolean) {
    return `w-full border px-2 py-1.5 text-left text-xs font-medium transition-colors ${
      active
        ? "border-emerald-700 bg-emerald-600 text-white dark:border-emerald-500"
        : "border-black/10 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
    }`;
  }

  return (
    <>
      {/* Der Balken ist eine Flex-Reihe: links der Refresh-Button, in der
          Mitte der Titel (nimmt den freien Platz und bricht bei Bedarf um),
          rechts der Menü-Button. Beide Buttons sind gleich breit, dadurch
          steht der Titel optisch genau in der Mitte. Bewusst NICHT mit
          absolut gesetzten Buttons über einem mittigen Titel — auf schmalen
          Handys würden sich Titel und Buttons sonst überlappen. */}
      <header className="relative flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <button
          type="button"
          onClick={handleRefresh}
          aria-label="Aktualisieren"
          title="Aktualisieren"
          className="z-[1100] flex h-9 w-9 shrink-0 items-center justify-center border border-black bg-white hover:bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          {/* Kreispfeil, gleiche Strichstärke und Farbe wie das Menü-Symbol. */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            aria-hidden="true"
            className={`text-zinc-900 dark:text-zinc-50 ${refreshSpinning ? "animate-spin" : ""}`}
          >
            <path
              d="M16 10a6 6 0 1 1-1.76-4.24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path d="M17 2v5h-5z" fill="currentColor" />
          </svg>
        </button>
        <h1 className="min-w-0 flex-1 text-center text-base font-semibold text-zinc-900 sm:text-lg dark:text-zinc-50">
          Should I stay or should I go
        </h1>
        <div ref={menuRef} className="relative z-[1100] shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menü"
            aria-expanded={menuOpen}
            className="flex h-9 w-9 items-center justify-center border border-black bg-white dark:border-zinc-100 dark:bg-zinc-900"
          >
            {/* 3 horizontale Linien, bewusst mit geraden Enden (nicht abgerundet).
                fill="currentColor" -> im Hellmodus schwarz, im Dunkelmodus weiß. */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              aria-hidden="true"
              className="text-zinc-900 dark:text-zinc-50"
            >
              <rect x="2" y="4" width="16" height="2" fill="currentColor" />
              <rect x="2" y="9" width="16" height="2" fill="currentColor" />
              <rect x="2" y="14" width="16" height="2" fill="currentColor" />
            </svg>
          </button>
          {/* -right-3 gleicht den right-3-Abstand des Buttons aus, damit das
              Popup bündig am rechten Bildschirmrand anliegt. Bewusst ohne
              abgerundete Ecken, passend zum eckigen Menü-Button. */}
          {menuOpen && (
            <div className="absolute top-full -right-3 mt-2 w-52 border border-black/10 bg-white p-3 text-left shadow-lg dark:border-white/10 dark:bg-zinc-800">
              <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                Karte
              </p>
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => setBaseLayer("relief")}
                  aria-pressed={baseLayer === "relief"}
                  className={optionClass(baseLayer === "relief")}
                >
                  Relief (Grau)
                </button>
                <button
                  type="button"
                  onClick={() => setBaseLayer("standard")}
                  aria-pressed={baseLayer === "standard"}
                  className={optionClass(baseLayer === "standard")}
                >
                  Standard
                </button>
              </div>
              <p className="mt-3 mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                Stationen
              </p>
              {/* Die Schaltflächen werden aus der Filterliste in wind.ts
                  erzeugt statt einzeln hingeschrieben: So bleiben Reihenfolge,
                  Beschriftung ("Stationen <1.000m") und Filterlogik der Karte
                  automatisch beisammen, wenn eine Höhenstufe dazukommt. */}
              <div className="flex flex-col gap-1.5">
                {STATION_FILTER_ORDER.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setStationFilter(filter)}
                    aria-pressed={stationFilter === filter}
                    className={optionClass(stationFilter === filter)}
                  >
                    {getStationFilterLabel(filter)}
                  </button>
                ))}
              </div>
              {/* Quellenangaben der Karte — früher als Leaflet-Zeile unten
                  rechts auf der Karte, jetzt hier ganz unten im Popup
                  (MAP_SOURCES in wind.ts, richtet sich nach dem gewählten
                  Hintergrund). Die Quellen der Winddaten stehen bewusst NICHT
                  hier, sondern stationsweise unten im Verlaufsbalken
                  ("Quelle: …") — Wunsch des Projektbesitzers, keine
                  Doppelung. Bewusst klein und grau: Pflichtangabe, aber keine
                  Bedienung. */}
              <p className="mt-3 mb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                Quellen
              </p>
              <ul className="space-y-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                {MAP_SOURCES[baseLayer].map((source) => (
                  <li key={source.label}>
                    <SourceLink url={source.url}>{source.label}</SourceLink>
                    {source.note ? ` (${source.note})` : null}
                  </li>
                ))}
                <li>
                  <SourceLink url="https://leafletjs.com">Leaflet</SourceLink>
                </li>
              </ul>
            </div>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <WindMapLoader
          baseLayer={baseLayer}
          stationFilter={stationFilter}
          historyFrame={historyFrame}
          refreshToken={refreshToken}
        />
      </main>
      {/* Eigene Zeile UNTER der Karte und ÜBER der Fußzeile — die Fußzeile mit
          dem OpenWindMap-Hinweis muss sichtbar bleiben (Lizenzbedingung). */}
      <TimeSlider
        slots={slots}
        selectedTime={clampedTime}
        onChange={setSelectedTime}
        onEngage={ensureTimeline}
        status={timelineStatus}
      />
    </>
  );
}

// Ein Link in der Quellenliste des Menü-Popups (öffnet in neuem Tab).
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
