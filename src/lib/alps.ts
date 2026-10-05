// Gemeinsame Regel "liegt die Station in den Alpen?" für ALLE Quellen
// (Wunsch des Projektbesitzers, Okt. 2026): Gleitschirmflieger brauchen die
// Stationen nur dort, wo Berge sind — also im Alpenraum. Entscheidend ist der
// ORT, nicht die Meereshöhe: Talstationen in den Alpen (Innsbruck, Chur, Sion,
// Bozen, Klagenfurt …) bleiben, Stationen im Flachland oder Mittelgebirge
// außerhalb der Alpen (Wien, Burgenland, Schweizer Mittelland mit Bern/Zürich/
// Basel/Genf, Jura, Mühl-/Waldviertel) fallen weg — auch wenn sie höher liegen
// als manche Alpen-Talstation.
//
// Genutzt von src/lib/geosphere.ts, src/lib/meteoswiss.ts und src/lib/slf.ts.
// Die Bozner Stationen, OpenWindMap (Südtirol-Box + Gardasee-Startplätze),
// LWD Tirol, die Zugspitze und Holfuy (Gardasee) liegen ohnehin komplett in
// den Alpen und brauchen den Test nicht.
//
// ACHTUNG: Die Edge Function fetch-wind-forecasts hat eine Kopie dieses
// Vielecks (Deno kann nicht aus src/ importieren) — bei Änderungen beide
// anfassen, sonst gibt es Prognosen für Stationen, die gar nicht angezeigt
// werden (oder umgekehrt).
//
// Der Umriss ist grob (Alpenhauptkamm samt Voralpen und Talböden), am
// 04.10.2026 gegen alle Stationen von GeoSphere (286), MeteoSchweiz (151) und
// SLF (208) geprüft. Punkte als [Länge, Breite], gegen den Uhrzeigersinn ab
// dem Südwesten. Westen und Süden sind bewusst großzügig/gerade, weil dort
// (Frankreich, Italien) keine Stationen vorkommen — nur der Südrand bei
// 45,85/45,9° schneidet die Poebene (Stabio) weg.
const ALPS_POLYGON: Array<[number, number]> = [
  // Westrand und Nordrand der Schweizer Alpen: Genfersee (Vevey, Aigle drin;
  // Genf, Nyon, Lausanne draußen) → Freiburger Voralpen → Thun → Entlebuch
  // (Napf) → Luzern/Zug/Einsiedeln → Toggenburg → Rheintal.
  [6.7, 45.85],
  [6.7, 46.5],
  [7.0, 46.6],
  [7.1, 46.7],
  [7.4, 46.82],
  [7.65, 46.88],
  [7.85, 47.0],
  [8.05, 47.05],
  [8.3, 47.1],
  [8.62, 47.15],
  [9.1, 47.3],
  [9.6, 47.4],
  // Nordrand Österreichs: Vorarlberg/Bodensee → Tirol → Salzburg → Traunsee →
  // Ybbstal → Hohe Wand. Das Alpenvorland (Linz, Wels, St. Pölten) und alles
  // nördlich davon liegt draußen.
  [9.6, 47.75],
  [12.0, 47.75],
  [13.2, 48.0],
  [13.8, 48.0],
  [14.2, 47.95],
  [14.9, 48.0],
  [15.6, 48.05],
  [15.9, 48.0],
  // Ostrand: Wiener Neustadt/Wechsel → Grazer Bergland → Koralpe. Wien,
  // Burgenland und das Südost-Hügelland der Steiermark liegen draußen.
  [16.06, 47.9],
  [16.06, 47.45],
  [15.75, 47.3],
  [15.55, 47.0],
  [15.35, 46.6],
  [15.3, 46.3],
  // Südrand (siehe oben).
  [15.3, 45.9],
  [8.8, 45.9],
  [8.8, 45.85],
];

/**
 * Punkt-im-Vieleck-Test (Strahlverfahren): zählt, wie oft ein Strahl nach
 * Osten die Vieleck-Kanten kreuzt — ungerade Anzahl heißt "drin".
 */
export function isInAlps(lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = ALPS_POLYGON.length - 1; i < ALPS_POLYGON.length; j = i++) {
    const [xi, yi] = ALPS_POLYGON[i];
    const [xj, yj] = ALPS_POLYGON[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
