import type { Metadata, Viewport } from "next";
import { Barlow_Semi_Condensed } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";

const barlowSemiCondensed = Barlow_Semi_Condensed({
  variable: "--font-barlow-semi-condensed",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Should I stay or should I go",
  description: "Live-Windwerte der Alpen-Wetterstationen auf einer Karte",
  // Für die Web-App am iPhone (Home-Bildschirm): Name unter dem Symbol und
  // ohne Safari-Leisten öffnen. Die Uhrzeit-Leiste oben bleibt hell
  // ("default"), die Seite beginnt darunter — so verdeckt nichts den
  // Titelbalken. Rest der App-Beschreibung in manifest.ts.
  appleWebApp: {
    capable: true,
    title: "SISOSIG",
    // Die Seite reicht in der App bis unter die Statusleiste (Uhrzeit, Akku),
    // dort liegt wie im Titel-Balken der halb durchsichtige Hintergrund
    // (Wunsch des Projektbesitzers, Okt. 2026; vorher ein weißer Streifen).
    // Folge von "black-translucent": iOS schreibt Uhrzeit und Akku WEISS.
    // Wirkt erst, wenn die App neu zum Home-Bildschirm hinzugefügt wird.
    statusBarStyle: "black-translucent",
  },
  // iPhone-Symbol unter der festen Standard-Adresse /apple-touch-icon.png
  // (Datei in public/, dazu eine gleiche "-precomposed"-Kopie für ältere
  // iPhones). Bewusst NICHT mehr über die Next.js-Datei src/app/apple-icon.png:
  // Die hängt eine Kennung an die Adresse an ("?apple-icon.…"), und am
  // iPhone des Projektbesitzers erschien damit beim Hinzufügen kein Symbol.
  // Die Standard-Adresse sucht das iPhone zur Not auch von selbst.
  icons: {
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// Färbt die Browserleiste am Handy passend zum hellen Modus ein.
export const viewport: Viewport = {
  themeColor: "#ffffff",
  // Inhalt bis unter Statusleiste und Home-Leiste des iPhones; Abstände
  // dafür über env(safe-area-inset-*) (Titel-Balken, Zeitbalken, Flugmodus).
  viewportFit: "cover",
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
      className={`${barlowSemiCondensed.variable} h-full antialiased`}
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
        */}
        <link rel="preconnect" href="https://tile.opentopomap.org" />
      </head>
      <body className="min-h-full flex flex-col">
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
