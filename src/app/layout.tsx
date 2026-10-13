import type { Metadata, Viewport } from "next";
import { Barlow_Semi_Condensed, Libre_Baskerville } from "next/font/google";
import "./globals.css";
import "./stil-erklaerfilm.css";

// SCHALTER für den Stil "Erklärfilm" (tiefblaue Balken, orange Rahmen,
// cremefarbene Karte, Serifenschrift; Okt. 2026, Wunsch des Projektbesitzers).
// true = neuer Stil, false = wieder der frühere helle Stil (Weiß/Grau).
// Mehr ist zum Zurückschalten nicht nötig; alle Regeln stehen in
// src/app/stil-erklaerfilm.css und greifen nur bei true.
const STIL_ERKLAERFILM = true;

const barlowSemiCondensed = Barlow_Semi_Condensed({
  variable: "--font-barlow-semi-condensed",
  subsets: ["latin"],
  weight: ["400", "700"],
});

// Serifenschrift für Titel, Stationsname und Uhrzeit im Stil "Erklärfilm".
// Wird nur benutzt, wenn der Schalter oben an ist.
const libreBaskerville = Libre_Baskerville({
  variable: "--font-libre-baskerville",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Should I stay or should I go",
  description: "Live-Windwerte Südtiroler Wetterstationen auf einer Karte",
};

// Färbt die Browserleiste am Handy passend zum Titelbalken ein
// (Dunkelblau im Stil "Erklärfilm", sonst Weiß).
export const viewport: Viewport = {
  themeColor: STIL_ERKLAERFILM ? "#083a6e" : "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Die Seite läuft dauerhaft im HELLEN Modus. Dafür wird hier bewusst KEINE
  // Klasse "dark" gesetzt — die `dark:`-Klassen im Code hängen an genau dieser
  // Klasse (siehe @custom-variant in src/app/globals.css) und greifen deshalb
  // nirgends mehr. Wer den Dunkelmodus zurückholen will, schreibt hier wieder
  // `dark ` vor ${barlowSemiCondensed.variable} und dreht in globals.css
  // color-scheme/--background/--foreground zurück; sonst ändert sich nichts.
  return (
    <html
      lang="de"
      className={`${barlowSemiCondensed.variable} ${libreBaskerville.variable} ${STIL_ERKLAERFILM ? "stil-erklaerfilm " : ""}h-full antialiased`}
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
          Reihenfolge = OpenTopoMap (Standardansicht) zuerst.
        */}
        <link rel="preconnect" href="https://tile.opentopomap.org" />
        <link rel="dns-prefetch" href="https://server.arcgisonline.com" />
        <link rel="dns-prefetch" href="https://basemaps.cartocdn.com" />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
