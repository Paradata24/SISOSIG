import { useEffect, useState, useSyncExternalStore } from "react";

// Gerät im Flugmodus (Okt. 2026 aus FlightMode.tsx ausgelagert): Bildschirm
// wach halten, Netz da oder nicht, aktuelle Uhrzeit.

// Bildschirm wach halten, solange der Flugmodus an ist ("Screen Wake Lock",
// am iPhone ab iOS 16.4). Der Browser gibt die Sperre von selbst frei, sobald
// die Seite in den Hintergrund geht — beim Zurückkommen wird sie deshalb neu
// angefordert. Ergebnis: true = aktiv, false = vom Browser nicht unterstützt
// oder abgelehnt, null = wird gerade angefordert.
export function useWakeLock(): boolean | null {
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
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

// Aktuelle Uhrzeit, alle `intervalMs` aufgefrischt — für die Alters-Prüfungen
// der Statuszeile (FlightMode.tsx, alle 30 s) und die Wahl der KK7-Karte.
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
