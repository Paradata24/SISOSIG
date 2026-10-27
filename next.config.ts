import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Der Hintergrund-Helfer der Web-App (public/sw.js) darf nie
        // zwischengespeichert werden — sonst bliebe ein Handy womöglich auf
        // einer alten Fassung hängen und bekäme neue Versionen der Seite
        // nicht mit.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
