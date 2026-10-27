import { NextResponse } from "next/server";

// Kabel (Luftfahrthindernisse) für den Flugmodus (Okt. 2026, Wunsch des
// Projektbesitzers): Stromleitungen, Materialseilbahnen, Schussdrähte,
// Seilbahnen und Lifte in Südtirol. Gezeichnet werden sie in
// src/components/FlightMode.tsx — nur dort, nicht auf der normalen Karte.
//
// Quelle: Landesabteilung Forstdienst der Autonomen Provinz Bozen. Betreiber
// müssen jedes Hindernis nach Landesgesetz 1/2006 melden; das Land führt
// daraus eine täglich nachgeführte Karte für Piloten
// (https://forstdienst.provinz.bz.it/de/wald-holz/erfassung-luftfahrthindernissen).
// Abgefragt wird derselbe Kartendienst, den der GeoBrowser des Landes für
// diese Karte benutzt (Ebene "LinearObstacles"). Die rund 33.000 Masten und
// Stützen (Ebene "VerticalObstacles") bleiben bewusst weg: Gefährlich sind im
// Flug die Kabel dazwischen.
//
// Die Daten kommen als Linien MIT Eigenschaften (WFS), nicht als fertiges
// Bild: So zeichnen wir sie selbst — dünner und in einer eigenen Farbe statt
// im dicken Rot des Landes (das sähe aus wie "zu stark" bei den Windpfeilen)
// —, und sie lassen sich in der Web-App für den Flug ohne Netz speichern.
const WFS_URL =
  "https://geoservices6.civis.bz.it/geoserver/p_bz-FlightObstacles/ows" +
  "?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeNames=p_bz-FlightObstacles:LinearObstacles" +
  "&outputFormat=application/json" +
  // Web-Mercator statt Längen-/Breitengrad: Der Dienst rundet Grad-Angaben
  // auf 4 Nachkommastellen (bis ~10 m daneben), Meter dagegen nicht.
  "&srsName=EPSG:3857" +
  // Nur die Felder, die wir brauchen (Linie und Höhe über Grund) — spart gut
  // die Hälfte der Datenmenge.
  "&propertyName=SHAPE,BAS_BEZ_DE";

// --- Tägliche Aktualisierung ---
// Die Kabel ändern sich selten (Meldungen beim Land), ein Abruf pro Tag
// genügt. Das CDN von Vercel hält die fertige Antwort 24 h (s-maxage); danach
// bekommt der nächste Aufruf noch sofort die alte Antwort, und im Hintergrund
// holt die Route frische Daten beim Land (stale-while-revalidate). So fragt
// nicht jedes Handy den Landesserver ab, und niemand wartet auf ihn.
// Ist das Land gestört, gibt das CDN bis zu 30 Tage lang die letzte gute
// Fassung weiter (stale-if-error) — mit ihrem alten Stand, den FlightMode
// dann gelb anzeigt. Zusätzlich merkt sich jedes Handy die letzte Fassung
// selbst (CABLE_STORAGE_KEY in FlightMode.tsx).
// Fehlerantworten bekommen bewusst KEINEN solchen Header, damit sich eine
// Störung beim Land nicht einen Tag lang festsetzt.
const RESPONSE_CACHE_CONTROL =
  "public, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=2592000";

// Kabel, die so hoch über Grund hängen, sind meist quer über Täler gespannt
// — die gefährlichsten für Gleitschirme. Die Werte sind die Höhenklassen des
// Landes (Feld BAS_BEZ_DE). FlightMode zeichnet derzeit alle Kabel gleich
// (Wunsch des Projektbesitzers); das Kennzeichen bleibt für später.
const HIGH_CLASSES = new Set([
  "> 60 bis < 100 m",
  ">= 100 bis 150 m",
  "> 150 m",
]);

export interface CablePayload {
  /** Wann die Kabel zuletzt beim Land abgeholt wurden (ISO-Zeit). */
  stand: string;
  /**
   * Je Kabel: [hoch (1 = über 60 m über Grund, sonst 0), Breite, Länge,
   * Breite, Länge, …]. Flache Zahlenreihen statt GeoJSON — halb so groß.
   */
  kabel: number[][];
}

// Web-Mercator-Meter → Grad (gleiche Formel, die Leaflet intern benutzt).
const EARTH_RADIUS_M = 6378137;
function toLatLng(x: number, y: number): [number, number] {
  const lng = (x / EARTH_RADIUS_M) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI);
  return [lat, lng];
}

// 5 Nachkommastellen ≈ 1 m — genauer als die Meldungen selbst.
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

interface WfsFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: { BAS_BEZ_DE?: string | null } | null;
}

// Rund 2 MB vom Landesserver. Bricht die Übertragung ab (in Tests kam das
// vor), wird es einmal neu versucht — ein Fehlschlag hieße sonst: bis zum
// nächsten Aufruf keine Kabel.
const FETCH_ATTEMPTS = 2;

async function fetchFeatures(): Promise<WfsFeature[] | string> {
  let problem = "Kartendienst des Landes ist nicht erreichbar";
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(WFS_URL, { cache: "no-store" });
      if (!res.ok) {
        problem = `Kartendienst des Landes antwortet mit ${res.status}`;
        continue;
      }
      const data = (await res.json()) as { features?: WfsFeature[] };
      return data.features ?? [];
    } catch {
      problem = "Antwort des Kartendienstes ist abgebrochen oder unlesbar";
    }
  }
  return problem;
}

export async function GET() {
  const features = await fetchFeatures();
  if (typeof features === "string") {
    return NextResponse.json({ error: features }, { status: 502 });
  }

  const kabel: number[][] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    // Fast alle Kabel sind einfache Linien; falls das Land einmal mehrteilige
    // liefert, wird jedes Teilstück ein eigenes Kabel.
    const parts =
      geometry.type === "LineString"
        ? [geometry.coordinates as number[][]]
        : geometry.type === "MultiLineString"
          ? (geometry.coordinates as number[][][])
          : [];
    const high = HIGH_CLASSES.has(feature.properties?.BAS_BEZ_DE ?? "") ? 1 : 0;
    for (const part of parts) {
      if (part.length < 2) continue;
      const row = [high];
      for (const [x, y] of part) {
        const [lat, lng] = toLatLng(x, y);
        row.push(round5(lat), round5(lng));
      }
      kabel.push(row);
    }
  }

  // Leere Antwort = Störung beim Land, nicht "keine Kabel": nicht für einen
  // Tag festschreiben.
  if (kabel.length === 0) {
    return NextResponse.json(
      { error: "Kartendienst des Landes lieferte keine Kabel" },
      { status: 502 },
    );
  }

  const payload: CablePayload = { stand: new Date().toISOString(), kabel };
  return NextResponse.json(payload, {
    headers: { "Cache-Control": RESPONSE_CACHE_CONTROL },
  });
}
