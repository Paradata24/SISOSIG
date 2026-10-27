import type { MetadataRoute } from "next";

// App-Beschreibung ("Manifest") für die Web-App (Okt. 2026, Wunsch des
// Projektbesitzers): Wer die Seite zum Home-Bildschirm hinzufügt bzw. bei
// Android "App installieren" wählt, bekommt eine App namens SISOSIG mit dem
// Stern-Symbol (gelber Stern mit rotem Schatten auf Schwarz, Vorlage vom
// Projektbesitzer). Für Besucher im Browser ändert diese Datei nichts.
//
// Die Symbole liegen in public/icons/; das iPhone-Symbol ist
// src/app/apple-icon.png (Next.js bindet es selbst ein, siehe metadata in
// layout.tsx). Die "maskable"-Fassung hat mehr schwarzen Rand: Android
// schneidet Symbole je nach Handy rund oder eckig zu, der Stern muss dabei
// ganz bleiben.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SISOSIG – Should I stay or should I go",
    short_name: "SISOSIG",
    description: "Live-Windwerte der Alpen-Wetterstationen auf einer Karte",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Startbild (Android): Stern auf Schwarz wie das Symbol. Die Leiste oben
    // bleibt weiß wie der helle Titelbalken der Seite.
    background_color: "#000000",
    theme_color: "#ffffff",
    lang: "de",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Langes Drücken auf das App-Symbol (nur Android): direkt in den
    // Flugmodus. WindApp erkennt "?flug" in der Adresse.
    shortcuts: [
      {
        name: "Flugmodus",
        short_name: "GO",
        url: "/?flug",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
