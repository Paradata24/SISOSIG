// Gemeinsame Teile der Kabel (Luftfahrthindernisse) im Flugmodus: das
// Antwortformat von /api/kabel (src/app/api/kabel/route.ts) und die
// Höhenklassen, die FlightMode.tsx ab Zoom 15 als Schild an die Kabel
// schreibt. Eigene Datei statt in der Route, weil FlightMode im Browser läuft
// und nichts aus der Server-Route mitladen soll.

export interface CablePayload {
  /** Wann die Kabel zuletzt beim Land abgeholt wurden (ISO-Zeit). */
  stand: string;
  /**
   * Je Kabel: [Höhenklasse (siehe CABLE_HEIGHT_CLASSES, 0 = bis 25 m über
   * Grund), Breite, Länge, Breite, Länge, …]. Flache Zahlenreihen statt
   * GeoJSON — halb so groß.
   */
  kabel: number[][];
}

/**
 * Höhenklassen des Landes (Feld BAS_BEZ_DE der Hinderniskarte), die ein
 * Schild bekommen: alle über 25 m über Grund (Wunsch des Projektbesitzers).
 * Kabel bis 25 m haben Klasse 0 und kein Schild.
 *
 * Die Klasse gilt für das GANZE Kabel und meint seine höchste Stelle über dem
 * Boden (meist eine Talquerung). Eine Höhe je Abschnitt gibt es in den Daten
 * des Landes nicht. Ein "max" vor der Angabe hat der Projektbesitzer bewusst
 * weggelassen.
 *
 * code = Rangfolge beim Ausdünnen: Überdecken sich zwei Schilder, bleibt das
 * mit dem höheren code. "> 25 bis 60 m" ist eine ältere, gröbere Klasse des
 * Landes (dort mit "NICHT AUSWÄHLEN" markiert), hängt aber noch an rund 800
 * Kabeln.
 */
export const CABLE_HEIGHT_CLASSES: { code: number; land: string; label: string }[] = [
  { code: 1, land: "> 25 bis < 45 m", label: "25–45 m" },
  { code: 2, land: "> 25 bis 60 m *** NICHT AUSWÄHLEN! ***", label: "25–60 m" },
  { code: 3, land: ">= 45 bis 60 m", label: "45–60 m" },
  { code: 4, land: "> 60 bis < 100 m", label: "60–100 m" },
  { code: 5, land: ">= 100 bis 150 m", label: "100–150 m" },
  { code: 6, land: "> 150 m", label: "> 150 m" },
];
