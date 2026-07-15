// =====================================================================
//  Tendenzkurve ("korrigierte Prognose") für den Mittelwind
// =====================================================================
//
// Diese Datei enthält NUR die reine Berechnung (keine Anzeige). Dadurch
// lässt sie sich unabhängig testen (siehe tendenz.test.ts) und getrennt
// von der Zeichenlogik in WindHistoryPanel.tsx warten.
//
// GRUNDIDEE (in einfachen Worten):
//   Das Wettermodell (ICON-CH1) trifft an einem konkreten Gipfel die
//   absolute Windstärke oft nicht genau (Geländeeffekte, Modellauflösung),
//   liegt aber beim zeitlichen Verlauf/Trend meist richtig. Deshalb nehmen
//   wir die STÄRKE vom realen Messwert ("jetzt") und die TENDENZ von der
//   Prognose: Wir schieben die Prognose am "Jetzt" auf den gemessenen Wert
//   (Versatz = offset) und blenden diesen Versatz über 3 Stunden wieder
//   auf 0 zurück. So beginnt die Kurve auf der Realität und endet exakt auf
//   der rohen Prognose.
//
// WICHTIG (Einordnung, gilt auch für die Doku docs/TENDENZKURVE.md):
//   Das ist beobachtungs-verankertes Nowcasting — eine HEURISTIK, NICHT
//   kalibriert und KEIN validiertes Prognoseprodukt. Sie ersetzt nicht das
//   eigene Urteil des Piloten. Die Sicherheitsentscheidung liegt beim
//   Piloten.

// ---------------------------------------------------------------------
//  Justierbare Konstanten
// ---------------------------------------------------------------------
//  Alle "Stellschrauben" der Berechnung stehen hier zentral und benannt,
//  nicht verstreut im Code. Jede darf man vorsichtig anpassen — die
//  Kommentare erklären, was der Wert bewirkt.

/**
 * Vorlauf der Tendenzkurve in Stunden.
 * Grund: Der Offset (Versatz Modell↔Realität) ist nur kurzfristig
 * verlässlich (0–2 h stark, danach fällt das Vertrauen deutlich). Über 6 h
 * wäre die Annahme "gleicher Versatz" praktisch wertlos; wir nutzen bewusst
 * konservative 3 h. Wirkung: bestimmt, wie weit die türkise Linie in die
 * Zukunft reicht und wie schnell der Offset auf 0 zurückgeblendet wird.
 * (Laut Auftrag NICHT ohne Rückfrage ändern.)
 */
export const FENSTER_STUNDEN = 3;

/**
 * Anzahl der letzten realen Mittelwind-Messungen, aus denen der
 * "Real-Ø jetzt" gebildet wird.
 * Grund: Ein einzelner Messwert springt durch Böen stark; der Mittel über
 * die letzten paar Werte glättet das, ohne träge zu werden.
 * Wirkung: größer = ruhiger/träger, kleiner = zappeliger/aktueller.
 */
export const REAL_MITTEL_SAMPLES = 3;

/**
 * Ab welchem |Offset| (km/h) der Versatz als "groß" gilt.
 * Grund: Bei sehr großem Versatz ist der ABSOLUTwert unsicher (das Modell
 * liegt weit daneben) — der Wert ist dann eher als Richtung/Tendenz zu
 * lesen. Wirkung: löst vertrauen = "niedrig" aus und verbreitert das Band.
 */
export const OFFSET_GROSS = 15;

/**
 * Schwelle (Grad) für den Richtungs-Wächter.
 * Grund: Weichen reale und prognostizierte Windrichtung stark ab, herrschen
 * womöglich zwei verschiedene Windsysteme (Regimewechsel, z. B. thermischer
 * Aufwind vs. Gradientwind). Dann ist der Offset KEIN sauberer
 * Korrekturwert. Wirkung: oberhalb dieser Differenz wird die Linie NICHT
 * gezeichnet, nur ein Warnhinweis gezeigt.
 */
export const RICHTUNG_SCHWELLE = 60;

/**
 * Grundbreite des Unsicherheitsbands (km/h, halbe Breite) bei t=0.
 * Grund: Selbst "jetzt" ist die Messung nicht exakt (Böigkeit, Sensorlage).
 * Wirkung: Mindestdicke des Bands direkt an der "jetzt"-Linie.
 */
export const BAND_BASIS = 2;

/**
 * Zusätzliche Bandbreite (km/h, halbe Breite) je Stunde Vorlauf.
 * Grund: Je weiter in der Zukunft, desto unsicherer — das Band weitet sich
 * nach rechts trichterförmig auf. Wirkung: Steilheit dieser Aufweitung.
 */
export const BAND_PRO_STUNDE = 2;

/**
 * Anteil von |offset|, der die Bandbreite zusätzlich erhöht.
 * Grund: Ein großer Versatz heißt "Modell liegt hier weit daneben" → auch
 * die Korrektur ist unsicherer, das Band soll breiter werden.
 * Wirkung: 0.15 = 15% des Versatzes fließen in die halbe Bandbreite ein.
 */
export const BAND_PRO_OFFSET = 0.15;

/**
 * Schwelle (km/h) für die Trend-Einstufung steigend/fallend.
 * Grund: Kleine Schwankungen sollen nicht als Trend gelten; erst ab dieser
 * Differenz über das Fenster sprechen wir von "steigend"/"fallend".
 */
export const TENDENZ_SCHWELLE = 2;

// ---------------------------------------------------------------------
//  Typen
// ---------------------------------------------------------------------

/** Ein Auswertepunkt der Tendenzkurve (t=0 … t=FENSTER_STUNDEN). */
export interface TendenzPunkt {
  /** Stunde ab jetzt (0 = jetzt, … , FENSTER_STUNDEN = Ende). */
  stunde: number;
  /** Korrigierter Mittelwind-Wert an dieser Stunde [km/h]. */
  wert: number;
  /** Untere Grenze des Unsicherheitsbands [km/h]. */
  unten: number;
  /** Obere Grenze des Unsicherheitsbands [km/h]. */
  oben: number;
}

export type Tendenz = "steigend" | "fallend" | "gleichbleibend";
export type Vertrauen = "gut" | "niedrig";

/**
 * Ergebnis von berechneTendenz(). Diskriminierte Union über `zeichnen`:
 *  - zeichnen = false: entweder Daten fehlen (grund = "daten_fehlen") oder
 *    Richtungskonflikt (richtungUnsicher = true) → nur Warnhinweis anzeigen.
 *  - zeichnen = true: Linie + Band zeichnen, plus Metadaten für die Kopfzeile.
 */
export type TendenzErgebnis =
  | { zeichnen: false; grund: "daten_fehlen" }
  | {
      zeichnen: false;
      grund: "richtung_konflikt";
      offset: number;
      richtungUnsicher: true;
    }
  | {
      zeichnen: true;
      punkte: TendenzPunkt[];
      offset: number;
      tendenz: Tendenz;
      vertrauen: Vertrauen;
      richtungUnsicher: boolean;
      offsetGross: boolean;
    };

// ---------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------

/**
 * Kleinste Winkeldifferenz zweier Kompassrichtungen.
 * @param a Richtung A in Grad (0 = Nord, im Uhrzeigersinn)
 * @param b Richtung B in Grad
 * @returns Differenz in Grad, immer 0..180 (z. B. 350° vs. 10° → 20°, nicht 340°)
 *
 * WARUM: Windrichtungen sind zyklisch — 359° und 1° sind nur 2° auseinander,
 * nicht 358°. Ohne diese Umrechnung würde der Richtungs-Wächter bei einem
 * Nord-Übergang fälschlich Alarm schlagen.
 */
export function winkelDifferenz(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------
//  Kernberechnung
// ---------------------------------------------------------------------

/**
 * Berechnet die Tendenzkurve ("korrigierte Prognose") für den Mittelwind.
 *
 * Vorgehen (jede Formelzeile mit meteorologischem "Warum"):
 *  1. Real-Ø jetzt = Mittel der letzten REAL_MITTEL_SAMPLES Messungen
 *     (Böen dämpfen, siehe REAL_MITTEL_SAMPLES).
 *  2. offset = realJetzt − prognJetzt  (+ = Modell untertreibt, − = übertreibt).
 *  3. Für jede Stunde t den Offset gewichtet auf die rohe Prognose addieren;
 *     das Gewicht fällt linear von 1 (jetzt) auf 0 (Fensterende), weil das
 *     Vertrauen in den konstanten Versatz mit der Vorlaufzeit sinkt.
 *  4. Unsicherheitsband: wächst mit der Vorlaufzeit und mit |offset|.
 *  5. Zwei Wächter: Richtungskonflikt (Linie aussetzen) und großer Offset
 *     (Absolutwert unsicher).
 *
 * @param realMittelLetzte   letzte reale Mittelwind-Messungen [km/h], neueste zuletzt
 * @param realRichtungJetzt  aktuelle reale Windrichtung [Grad, 0=N, im Uhrzeigersinn]
 * @param prognMittel        rohe Prognose-Mittelwind je Stunde ab jetzt:
 *                           [t0(jetzt), t1(+1h), t2(+2h), t3(+3h)] — Länge FENSTER_STUNDEN+1
 * @param prognRichtungJetzt prognostizierte Windrichtung "jetzt" [Grad]
 * @returns TendenzErgebnis (siehe Typ)
 */
export function berechneTendenz(
  realMittelLetzte: number[],
  realRichtungJetzt: number,
  prognMittel: number[],
  prognRichtungJetzt: number,
): TendenzErgebnis {
  // --- Datencheck: fehlt etwas, zeichnen wir keine Tendenz (§5.4) ---
  // Wir brauchen mindestens einen Realwert, eine vollständige Prognose
  // (genau FENSTER_STUNDEN+1 endliche Zahlen) und beide Richtungen als
  // endliche Zahlen. Sonst KEIN Absturz, nur "Daten fehlen".
  const vollstaendig =
    realMittelLetzte.length > 0 &&
    realMittelLetzte.every((v) => Number.isFinite(v)) &&
    prognMittel.length === FENSTER_STUNDEN + 1 &&
    prognMittel.every((v) => Number.isFinite(v)) &&
    Number.isFinite(realRichtungJetzt) &&
    Number.isFinite(prognRichtungJetzt);
  if (!vollstaendig) return { zeichnen: false, grund: "daten_fehlen" };

  // --- Schritt 1: Real-Ø glätten (Böen dämpfen), nur die letzten N Werte ---
  // WARUM: Ein Einzelwert springt durch Böen; der Mittel über die letzten
  // paar Messungen gibt den "getragenen" aktuellen Mittelwind wieder.
  const n = Math.min(REAL_MITTEL_SAMPLES, realMittelLetzte.length);
  const realJetzt = realMittelLetzte.slice(-n).reduce((a, b) => a + b, 0) / n;

  // --- Schritt 2: Kernrechnung ---
  const prognJetzt = prognMittel[0];
  // offset = wie stark liegt das Modell "jetzt" daneben.
  // + = Modell untertreibt (real > Prognose), − = Modell übertreibt.
  const offset = realJetzt - prognJetzt;

  // --- Schritt 3: korrigierte Punkte + Band je Stunde ---
  const punkte: TendenzPunkt[] = prognMittel.map((prog, t) => {
    // gewicht(t): linear von 1 (jetzt) auf 0 (Fensterende).
    // WARUM linear & auf 0: Wir vertrauen dem Versatz kurzfristig voll und
    // geben ihn zum Fensterende ganz auf — dort soll die Kurve wieder exakt
    // auf der rohen Prognose liegen (die das Modell-Timing trägt).
    const gewicht = 1 - t / FENSTER_STUNDEN; // t=0 →1 ; t=FENSTER →0
    // korrigiert(t): rohe Prognose plus der (abklingende) reale Versatz.
    const wert = prog + offset * gewicht;
    // bandHalb(t): Grundunsicherheit + wächst mit Vorlaufzeit + mit |offset|.
    // WARUM: weiter in der Zukunft = unsicherer; großer Versatz = Modell hier
    // generell unzuverlässig → breiteres Band.
    const bandHalb =
      BAND_BASIS + t * BAND_PRO_STUNDE + Math.abs(offset) * BAND_PRO_OFFSET;
    return { stunde: t, wert, unten: wert - bandHalb, oben: wert + bandHalb };
  });

  // Kontrolle (laut Auftrag): korrigiert(0) == realJetzt und
  // korrigiert(FENSTER) == rohe Prognose. Ergibt sich aus gewicht(0)=1 und
  // gewicht(FENSTER)=0 automatisch — hier nur als Erinnerung dokumentiert.

  // --- Wächter 1: Richtung weicht ab → Offset unsicher (§5.1) ---
  // WARUM: Unterschiedliche Windrichtungen deuten auf verschiedene
  // Windsysteme hin; dann ist der reine Stärke-Offset nicht übertragbar.
  const richtungsDiff = winkelDifferenz(realRichtungJetzt, prognRichtungJetzt);
  const richtungUnsicher = richtungsDiff > RICHTUNG_SCHWELLE;

  // --- Wächter 2: Offset groß → Absolutwert unsicher (§5.2) ---
  const offsetGross = Math.abs(offset) > OFFSET_GROSS;

  // --- Wächter 3 (TODO v1, §5.3): Offset instabil ---
  // TODO: Schwanken die letzten Real-Werte stark (großer Spread), könnte das
  // ebenfalls vertrauen = "niedrig" auslösen. Bewusst noch nicht umgesetzt,
  // damit die erste Version einfach bleibt; hier klar als offener Punkt
  // vermerkt.

  // --- Tendenz (steigend/fallend/gleichbleibend) über das Fenster ---
  // Vergleich Endwert ↔ Startwert der korrigierten Kurve.
  const delta = punkte[punkte.length - 1].wert - punkte[0].wert;
  const tendenz: Tendenz =
    delta > TENDENZ_SCHWELLE
      ? "steigend"
      : delta < -TENDENZ_SCHWELLE
        ? "fallend"
        : "gleichbleibend";

  // Bei Richtungskonflikt zeichnen wir KEINE Linie (nur Hinweis). Wir geben
  // trotzdem offset zurück, damit die Kopfzeile den Konflikt einordnen kann.
  if (richtungUnsicher) {
    return {
      zeichnen: false,
      grund: "richtung_konflikt",
      offset,
      richtungUnsicher: true,
    };
  }

  return {
    zeichnen: true,
    punkte,
    offset,
    tendenz,
    // "niedrig", wenn der Absolutwert unsicher ist (großer Offset).
    vertrauen: offsetGross ? "niedrig" : "gut",
    richtungUnsicher,
    offsetGross,
  };
}

// ---------------------------------------------------------------------
//  Kopfzeile (Textausgabe über dem Diagramm)
// ---------------------------------------------------------------------

/**
 * Baut aus dem Tendenz-Ergebnis einen kurzen, laienverständlichen Satz für
 * die Kopfzeile über dem Diagramm (§10).
 *
 * Beispiele:
 *  - "Modell trifft aktuell gut (Offset +2) · Tendenz gleichbleibend."
 *  - "Modell untertreibt Mittel +21 · Tendenz fallend · Absolutwert unsicher."
 *  - "Richtung real ≠ Prognose – Korrektur ausgesetzt."
 *  - "Keine Tendenz verfügbar (Daten fehlen)."
 */
export function tendenzKopfzeile(e: TendenzErgebnis): string {
  if (!e.zeichnen) {
    if (e.grund === "daten_fehlen") {
      return "Keine Tendenz verfügbar (Daten fehlen).";
    }
    // Richtungskonflikt
    return "Richtung real ≠ Prognose – Korrektur ausgesetzt.";
  }

  // Vorzeichenbehaftete Offset-Anzeige, auf ganze km/h gerundet.
  const o = Math.round(e.offset);
  const offsetStr = `${o >= 0 ? "+" : ""}${o}`;

  // Erster Teil: trifft das Modell gut, oder unter-/übertreibt es?
  let kopf: string;
  if (!e.offsetGross) {
    kopf = `Modell trifft aktuell gut (Offset ${offsetStr})`;
  } else if (e.offset > 0) {
    kopf = `Modell untertreibt Mittel ${offsetStr}`;
  } else {
    kopf = `Modell übertreibt Mittel ${offsetStr}`;
  }

  const teile = [kopf, `Tendenz ${e.tendenz}`];
  if (e.offsetGross) teile.push("Absolutwert unsicher");
  return teile.join(" · ") + ".";
}
