"use client";

import { useEffect, useRef, useState } from "react";
import { useWakeLock } from "@/components/flight/device";

// GPS-Test (Seite /gps-test, Erklärung in src/app/gps-test/page.tsx): zeigt
// live, wie regelmäßig das Handy neue Standorte liefert. Nichts wird
// gespeichert oder verschickt; alles bleibt in diesem Browserfenster.

// Anders als im Flugmodus (maximumAge 2000, src/components/flight/position.ts)
// hier 0: Gemessen werden soll, wie oft das GPS WIRKLICH einen neuen Punkt
// liefert, nicht wie oft der Browser einen alten wiederholt.
const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 30_000,
};

// Abstand bis hierhin gilt als "jede Sekunde" (kleine Schwankungen der Uhr).
const ON_TIME_MAX_S = 1.5;
// Ab diesem Abstand zählt es als Lücke.
const GAP_S = 2;
// Ab diesem Abstand als lange Lücke.
const LONG_GAP_S = 5;
// Erst ab so vielen Abständen gibt es ein Urteil.
const MIN_INTERVALS_FOR_VERDICT = 60;

type Stats = {
  points: number; // neue Standorte (verschiedene Zeitstempel)
  repeats: number; // derselbe Standort nochmal gemeldet
  intervals: number[]; // Abstände in Sekunden (ohne Hintergrund-Pausen)
  backgroundBreaks: number; // Abstände, in denen die Seite im Hintergrund war
  lastAccuracy: number | null;
  accuracySum: number;
  lastSpeedKmh: number | null;
  lastHeading: number | null;
  distanceM: number;
  startedAt: number | null;
  lastTime: number | null; // Zeitstempel des letzten neuen Punkts
};

const EMPTY: Stats = {
  points: 0,
  repeats: 0,
  intervals: [],
  backgroundBreaks: 0,
  lastAccuracy: null,
  accuracySum: 0,
  lastSpeedKmh: null,
  lastHeading: null,
  distanceM: 0,
  startedAt: null,
  lastTime: null,
};

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function fmt(n: number, digits = 1): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function percent(part: number, total: number): string {
  return total === 0 ? "–" : `${Math.round((part / total) * 100)} %`;
}

export default function GpsTest() {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<Stats>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wakeLock = useWakeLock();

  // Letzter Punkt und ob die Seite seitdem im Hintergrund war — als Ref, weil
  // sie bei jedem GPS-Punkt gebraucht werden, ohne neu zu zeichnen.
  const lastRef = useRef<{ time: number; lat: number; lon: number } | null>(null);
  const wasHiddenRef = useRef(false);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") wasHiddenRef.current = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Uhr für "Messung läuft seit …" und "letzter Punkt vor … s".
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running || !("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null);
        const { latitude, longitude, accuracy, speed, heading } = pos.coords;
        const last = lastRef.current;
        if (last && pos.timestamp === last.time) {
          setStats((s) => ({ ...s, repeats: s.repeats + 1 }));
          return;
        }
        const wasHidden = wasHiddenRef.current;
        wasHiddenRef.current = false;
        lastRef.current = { time: pos.timestamp, lat: latitude, lon: longitude };
        setStats((s) => {
          const next: Stats = {
            ...s,
            points: s.points + 1,
            lastTime: pos.timestamp,
            lastAccuracy: accuracy,
            accuracySum: s.accuracySum + accuracy,
            lastSpeedKmh: speed === null ? null : speed * 3.6,
            lastHeading: heading === null || Number.isNaN(heading) ? null : heading,
          };
          if (last) {
            const gapS = (pos.timestamp - last.time) / 1000;
            if (wasHidden) {
              next.backgroundBreaks = s.backgroundBreaks + 1;
            } else if (gapS > 0) {
              next.intervals = [...s.intervals, gapS];
            }
            next.distanceM = s.distanceM + distanceM(last.lat, last.lon, latitude, longitude);
          }
          return next;
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setError("Standort nicht freigegeben – bitte in den Einstellungen erlauben.");
        } else if (err.code === err.TIMEOUT) {
          setError("30 s lang kein GPS-Punkt (Zeitüberschreitung).");
        } else {
          setError("GPS gerade nicht verfügbar.");
        }
      },
      GEO_OPTIONS,
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [running]);

  const start = () => {
    if (!("geolocation" in navigator)) {
      setError("Dieses Gerät bzw. dieser Browser bietet kein GPS an.");
      return;
    }
    lastRef.current = null;
    wasHiddenRef.current = false;
    setStats({ ...EMPTY, startedAt: Date.now() });
    setNow(Date.now());
    setError(null);
    setRunning(true);
  };

  const iv = stats.intervals;
  const n = iv.length;
  const sorted = [...iv].sort((a, b) => a - b);
  const avg = n ? iv.reduce((a, b) => a + b, 0) / n : 0;
  const median = n ? sorted[Math.floor(n / 2)] : 0;
  const onTime = iv.filter((x) => x <= ON_TIME_MAX_S).length;
  const mid = iv.filter((x) => x > ON_TIME_MAX_S && x <= GAP_S).length;
  const gaps = iv.filter((x) => x > GAP_S && x <= LONG_GAP_S).length;
  const longGaps = iv.filter((x) => x > LONG_GAP_S).length;
  const durationS = stats.startedAt ? (now - stats.startedAt) / 1000 : 0;
  const sinceLastS = stats.lastTime === null ? null : Math.max(0, (now - stats.lastTime) / 1000);

  let verdict: { text: string; tone: string };
  if (n < MIN_INTERVALS_FOR_VERDICT) {
    verdict = {
      text: `Noch zu wenig Daten (${n} von ${MIN_INTERVALS_FOR_VERDICT}) – weiter bewegen, am besten 5 min.`,
      tone: "bg-zinc-100 text-zinc-700",
    };
  } else if (onTime / n >= 0.9 && (gaps + longGaps) / n <= 0.03) {
    verdict = { text: "GUT – das GPS liefert fast jede Sekunde einen Punkt.", tone: "bg-green-100 text-green-900" };
  } else if (onTime / n >= 0.7 && longGaps / n <= 0.02) {
    verdict = { text: "MITTEL – meist jede Sekunde, aber mit Lücken.", tone: "bg-amber-100 text-amber-900" };
  } else {
    verdict = { text: "SCHLECHT – das GPS liefert zu selten oder mit vielen Lücken.", tone: "bg-red-100 text-red-900" };
  }

  const row = (label: string, value: string) => (
    <div className="flex justify-between gap-4 border-b border-zinc-200 py-1.5">
      <span className="text-zinc-600">{label}</span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  );

  return (
    <main
      className="mx-auto min-h-dvh max-w-md bg-white px-4 pb-10 text-zinc-900"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 16px)" }}
    >
      <h1 className="text-2xl font-bold">GPS-Test</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Misst, wie oft das Handy einen neuen Standort liefert. Display anlassen, Seite offen lassen und
        draußen bewegen (gehen, Rad, Auto als Beifahrer, im Flug). Nichts wird gespeichert.
      </p>

      <div className="mt-4 flex gap-3">
        {running ? (
          <button
            onClick={() => setRunning(false)}
            className="h-12 flex-1 rounded-md border-2 border-zinc-900 bg-white text-lg font-bold"
          >
            STOPP
          </button>
        ) : (
          <button onClick={start} className="h-12 flex-1 rounded-md bg-zinc-900 text-lg font-bold text-white">
            {stats.points > 0 ? "NEU STARTEN" : "MESSUNG STARTEN"}
          </button>
        )}
      </div>

      {error && <p className="mt-3 rounded-md bg-red-100 p-2 text-sm text-red-900">{error}</p>}

      {stats.startedAt !== null && (
        <>
          <p className={`mt-4 rounded-md p-3 text-base font-bold ${verdict.tone}`}>{verdict.text}</p>

          <h2 className="mt-5 text-sm font-bold uppercase text-zinc-500">Abstand zwischen zwei Punkten</h2>
          <div className="mt-1 text-sm">
            {row("Mittel", n ? `${fmt(avg, 2)} s` : "–")}
            {row("Median", n ? `${fmt(median, 2)} s` : "–")}
            {row("Kürzester / längster", n ? `${fmt(sorted[0], 2)} s / ${fmt(sorted[n - 1], 1)} s` : "–")}
            {row(`Bis ${fmt(ON_TIME_MAX_S)} s (jede Sekunde)`, `${onTime} · ${percent(onTime, n)}`)}
            {row(`${fmt(ON_TIME_MAX_S)}–${GAP_S} s`, `${mid} · ${percent(mid, n)}`)}
            {row(`Lücke ${GAP_S}–${LONG_GAP_S} s`, `${gaps} · ${percent(gaps, n)}`)}
            {row(`Lange Lücke über ${LONG_GAP_S} s`, `${longGaps} · ${percent(longGaps, n)}`)}
          </div>

          <h2 className="mt-5 text-sm font-bold uppercase text-zinc-500">Messung</h2>
          <div className="mt-1 text-sm">
            {row("Läuft seit", `${Math.floor(durationS / 60)} min ${Math.floor(durationS % 60)} s`)}
            {row("Neue Punkte", String(stats.points))}
            {row("Punkte pro Sekunde", durationS > 0 ? fmt(stats.points / durationS, 2) : "–")}
            {row("Letzter Punkt vor", sinceLastS === null ? "–" : `${fmt(sinceLastS)} s`)}
            {row("Wiederholte Punkte", String(stats.repeats))}
            {row("Pausen (Seite im Hintergrund)", String(stats.backgroundBreaks))}
            {row("Zurückgelegt", `${fmt(stats.distanceM / 1000, 2)} km`)}
          </div>

          <h2 className="mt-5 text-sm font-bold uppercase text-zinc-500">Aktueller Punkt</h2>
          <div className="mt-1 text-sm">
            {row("Genauigkeit", stats.lastAccuracy === null ? "–" : `± ${Math.round(stats.lastAccuracy)} m`)}
            {row(
              "Genauigkeit im Mittel",
              stats.points ? `± ${Math.round(stats.accuracySum / stats.points)} m` : "–",
            )}
            {row("Tempo", stats.lastSpeedKmh === null ? "kein Wert" : `${fmt(stats.lastSpeedKmh)} km/h`)}
            {row("Richtung", stats.lastHeading === null ? "kein Wert" : `${Math.round(stats.lastHeading)}°`)}
            {row(
              "Bildschirm wach halten",
              wakeLock === true ? "aktiv" : wakeLock === false ? "nicht möglich – Display selbst anlassen" : "…",
            )}
          </div>
        </>
      )}

      <p className="mt-6 text-xs text-zinc-500">
        Zum Auswerten am Ende einen Screenshot machen. Am iPhone in der SISOSIG-App testen, nicht in
        Safari – die beiden können sich unterschiedlich verhalten.
      </p>
    </main>
  );
}
