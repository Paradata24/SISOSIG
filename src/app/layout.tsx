import type { Metadata, Viewport } from "next";
import { Barlow_Semi_Condensed } from "next/font/google";
import "./globals.css";

const barlowSemiCondensed = Barlow_Semi_Condensed({
  variable: "--font-barlow-semi-condensed",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Should I stay or should I go",
  description: "Live-Windwerte Südtiroler Wetterstationen auf einer Karte",
};

// Färbt die Browserleiste am Handy passend zum Dunkelmodus ein.
export const viewport: Viewport = {
  themeColor: "#18181b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Die Klasse "dark" schaltet die ganze Seite dauerhaft in den Dunkelmodus
  // (siehe @custom-variant in src/app/globals.css).
  return (
    <html
      lang="de"
      className={`dark ${barlowSemiCondensed.variable} h-full antialiased`}
    >
      <head>
        {/*
          Die Kartenkacheln sind der mit Abstand größte Teil dessen, was beim
          Öffnen der Seite geladen wird — sie starten aber erst, wenn die
          Karten-Bibliothek fertig geladen ist. Mit diesen Zeilen baut der
          Browser die Verbindung zu den Kachel-Servern schon VORHER auf
          (DNS-Auflösung + Verschlüsselungs-Handschlag), parallel zum Laden
          des JavaScripts. Die ersten Kacheln erscheinen dadurch spürbar
          früher, vor allem im Mobilfunknetz.
          Reihenfolge = Reliefkarte (Standardansicht) zuerst.
        */}
        <link rel="preconnect" href="https://server.arcgisonline.com" />
        <link rel="preconnect" href="https://basemaps.cartocdn.com" />
        <link rel="dns-prefetch" href="https://tile.openstreetmap.org" />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
