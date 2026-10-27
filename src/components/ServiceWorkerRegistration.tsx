"use client";

import { useEffect } from "react";

// Meldet den Hintergrund-Helfer (Service Worker, public/sw.js) an — aber NUR,
// wenn die Seite als App läuft (vom Home-Bildschirm bzw. als installierte
// App geöffnet). Wunsch des Projektbesitzers: Die Website im Browser bleibt
// genau wie bisher, die Offline-Zusätze (Start ohne Netz, gespeicherte
// Kartenstücke, letzte Windwerte) gibt es nur in der App.
//
// Hinweis Android: Dort teilen sich Chrome und die installierte App denselben
// Speicher. Ist der Helfer einmal aus der App angemeldet, läuft er auch für
// die Website in Chrome. Deshalb ist er so gebaut, dass er mit Netz nichts
// anders macht als bisher (immer zuerst frisch aus dem Netz, siehe sw.js).
// Am iPhone haben App und Safari ohnehin getrennte Speicher.
function isRunningAsApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    // Ältere iPhones kennen display-mode nicht, nur diese Eigenschaft.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !isRunningAsApp()) return;
    // Erst nach dem Laden der Seite anmelden: Der Helfer soll Karte und
    // Windwerte beim Start nicht ausbremsen.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => navigator.serviceWorker.ready)
        .then((registration) => {
          // Beim ersten Start war der Helfer noch nicht da, als die Seite
          // geladen wurde. Er bekommt deshalb die Liste der schon geladenen
          // Dateien (plus Windwerte und Verlauf) und speichert sie nach (siehe
          // "dateien-merken" in sw.js) — sonst ginge "ohne Netz starten" erst
          // ab dem zweiten Öffnen.
          const urls = [
            "/",
            "/api/wind",
            "/api/timeline",
            ...performance
              .getEntriesByType("resource")
              .map((entry) => entry.name)
              .filter((name) => name.startsWith(`${location.origin}/_next/static/`)),
          ];
          registration.active?.postMessage({ type: "dateien-merken", urls });
        })
        .catch(() => {
          // Ohne Helfer funktioniert die App wie die Website, nur nicht offline.
        });
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
