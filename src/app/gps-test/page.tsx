import type { Metadata } from "next";
import GpsTest from "@/components/GpsTest";

// Versteckte Test-Seite (Nov. 2026, Wunsch des Projektbesitzers): misst, wie
// oft das Handy im Browser bzw. in der App einen neuen GPS-Standort liefert.
// Grund: Eine Windberechnung aus dem eigenen Kreisen (Idee für den
// Flugmodus) braucht etwa jede Sekunde einen Punkt. Nirgends verlinkt, nur
// über die Adresse /gps-test erreichbar; speichert nichts. Kann wieder
// entfernt werden, sobald die Frage geklärt ist (diese Datei und
// src/components/GpsTest.tsx).
export const metadata: Metadata = {
  title: "GPS-Test",
  robots: { index: false, follow: false },
};

export default function GpsTestPage() {
  return <GpsTest />;
}
