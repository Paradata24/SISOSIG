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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
