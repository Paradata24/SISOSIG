# Tendenzkurve (korrigierte Prognose für den Mittelwind)

> Kurzfassung für Eilige: Die **türkise Linie** im Stationsdiagramm nimmt die
> **Windstärke von der echten Messung** und die **Tendenz von der Prognose**.
> Sie zeigt für die nächsten **3 Stunden**, wie der Mittelwind vermutlich
> weiterläuft – **verankert am aktuellen realen Messwert**.
>
> **Wichtig:** Das ist eine **Heuristik**, **nicht kalibriert** und **kein
> validiertes Prognoseprodukt**. Sie ersetzt **nicht** das eigene Urteil des
> Piloten. **Die Sicherheitsentscheidung liegt beim Piloten.**

---

## 1. Warum gibt es diese Kurve?

Im Stationsdiagramm laufen bereits zwei Dinge nebeneinander:

- **Weiße/schwarze Linien** = die **echte Messung** (Mittelwind unten, Böe
  oben). Sie enden bei „jetzt".
- **Rote Linien** = die **rohe Prognose** des Wettermodells ICON‑CH1
  (Mittelwind + Böe). Sie laufen in die Zukunft weiter.

Das Modell rechnet auf einem relativ groben Gitter. An einem konkreten Gipfel
(z. B. Rittner Horn) trifft es die **absolute Windstärke** deshalb oft nicht
genau – mal deutlich zu wenig, mal zu viel. **Gut** ist das Modell dagegen
meist beim **Verlauf/Timing**: Es erkennt, ob der Wind in den nächsten Stunden
eher zu- oder abnimmt.

Die Tendenzkurve macht sich genau das zunutze:

> **Stärke von der Realität, Tendenz von der Prognose.**

Sie schiebt die Prognose am Punkt „jetzt" auf den echten Messwert und blendet
diesen Versatz über 3 Stunden wieder auf null zurück. So beginnt die türkise
Linie **auf der Realität** und endet **genau auf der roten Prognoselinie**.

Das ist eine etablierte Methode und heißt **beobachtungs‑verankertes
Nowcasting**.

---

## 2. Die Rechnung in Worten

1. **Realen Ist‑Wert bilden.** Wir mitteln die **letzten 3 Messungen** des
   Mittelwinds (`REAL_MITTEL_SAMPLES = 3`). Grund: Ein einzelner Wert springt
   durch Böen; der Mittel glättet das.
2. **Versatz (Offset) berechnen.**
   `offset = realJetzt − prognoseJetzt`
   - `offset > 0`: Modell **untertreibt** (Realität stärker als Prognose).
   - `offset < 0`: Modell **übertreibt**.
3. **Offset abklingen lassen.** Für jede Stunde `t` (0, 1, 2, 3):
   - `gewicht(t) = 1 − t / 3` → bei „jetzt" 1, nach 3 h 0.
   - `korrigiert(t) = prognose(t) + offset × gewicht(t)`
   Das heißt: direkt jetzt zählt der Versatz voll, nach 3 h gar nicht mehr –
   dort liegt die Kurve wieder exakt auf der rohen Prognose.
4. **Unsicherheitsband** (türkise, halbtransparente Fläche):
   `bandHalb(t) = 2 + t × 2 + |offset| × 0,15`
   Es **weitet sich nach rechts auf** (weiter weg = unsicherer) und wird bei
   **großem Versatz breiter** (dann liegt das Modell hier generell daneben).

**Kontrolle (muss immer stimmen):**
`korrigiert(0) = realJetzt` und `korrigiert(3) = rohe Prognose`.

---

## 3. Die Formel

```
realJetzt   = Mittel der letzten REAL_MITTEL_SAMPLES realen Mittelwind-Werte
prognJetzt  = rohe Prognose (Mittel) zum Zeitpunkt "jetzt"
offset      = realJetzt − prognJetzt

für t in {0, 1, 2, 3}:
  gewicht(t)    = 1 − t / FENSTER_STUNDEN        // t=0 →1 ; t=3 →0
  korrigiert(t) = prognose(t) + offset × gewicht(t)
  bandHalb(t)   = BAND_BASIS + t × BAND_PRO_STUNDE + |offset| × BAND_PRO_OFFSET
```

Der Code dazu steht in **`src/lib/tendenz.ts`** (Funktion `berechneTendenz`),
die Anzeige in **`src/components/WindHistoryPanel.tsx`**.

---

## 4. Rechenbeispiel (Fall A – Rittner Horn, Modell untertreibt)

Eingaben:

- letzte reale Mittelwinde: `28, 29, 25 km/h`
- rohe Prognose (jetzt, +1h, +2h, +3h): `6, 5, 3, 4 km/h`
- Windrichtung real ≈ Windrichtung Prognose

Rechnung:

- `realJetzt = (28 + 29 + 25) / 3 ≈ 27,3 km/h`
- `offset = 27,3 − 6 = +21,3 km/h` (Modell untertreibt kräftig)

| Stunde | gewicht | Prognose | korrigiert | Band (halb) |
|:------:|:-------:|:--------:|:----------:|:-----------:|
| 0 (jetzt) | 1,00 | 6 | **27,3** | ±5,2 |
| +1 h | 0,67 | 5 | **19,2** | ±7,2 |
| +2 h | 0,33 | 3 | **10,1** | ±9,2 |
| +3 h | 0,00 | 4 | **4,0** | ±11,2 |

Ergebnis:

- Tendenz: **fallend** (von 27,3 auf 4,0 km/h).
- Vertrauen: **niedrig** (Offset > 15 → Absolutwert unsicher).
- Kopfzeile: **„Modell untertreibt Mittel +21 · Tendenz fallend · Absolutwert unsicher."**

Kontrolle erfüllt: `korrigiert(0) = 27,3 = realJetzt`, `korrigiert(3) = 4 =
rohe Prognose`. ✔

**Weitere geprüfte Fälle** (siehe Unit‑Tests, Abschnitt 8):

- **Fall B** – kleiner Offset (`+2`): Band schmal, Vertrauen **gut**, Kopfzeile
  „Modell trifft aktuell gut (Offset +2) · Tendenz gleichbleibend."
- **Fall C** – Richtungskonflikt (real Ost, Prognose Nord): **keine Linie**,
  Kopfzeile „Richtung real ≠ Prognose – Korrektur ausgesetzt."
- **Fall D** – keine Messwerte: **keine Linie**, Kopfzeile „Keine Tendenz
  verfügbar (Daten fehlen)."

---

## 5. Annahmen (und wann sie nicht gelten)

Die Kurve beruht auf drei Annahmen. Wo sie kippen, greifen die **Wächter**
(Abschnitt 6):

1. **Gleiches Windsystem.** Der Offset ist nur dann übertragbar, wenn real und
   Prognose vom **selben Wetterregime** sprechen. Wehen sie aus deutlich
   verschiedenen Richtungen, herrschen womöglich zwei Systeme (z. B. Thermik
   vs. Gradientwind) – dann ist der Offset kein sinnvoller Korrekturwert.
2. **Vertrauen sinkt mit der Vorlaufzeit.** „Der Versatz bleibt gleich" stimmt
   kurzfristig gut, aber je weiter in der Zukunft, desto weniger. Deshalb
   blenden wir ihn über 3 h auf 0 zurück und weiten das Band auf.
3. **Modell gut bei Trend, schwach bei Absolutstärke.** Wir übernehmen bewusst
   die **Stärke** von der Messung und die **Richtung des Verlaufs** vom Modell.

---

## 6. Wächter (Sonderfälle) – kein stiller Sonderfall

Jeder dieser Fälle ist im Code **und** hier dokumentiert:

| Wächter | Auslöser | Wirkung |
|---|---|---|
| **Richtung weicht ab** | Winkeldifferenz real ↔ Prognose > `RICHTUNG_SCHWELLE` (60°) | Tendenzlinie wird **nicht gezeichnet**; Kopfzeile: „Richtung real ≠ Prognose – Korrektur ausgesetzt." (möglicher Regimewechsel) |
| **Offset groß** | `\|offset\| > OFFSET_GROSS` (15 km/h) | Linie **wird** gezeichnet, aber `vertrauen = "niedrig"`, Band breiter, Kopfzeile ergänzt „Absolutwert unsicher". |
| **Offset instabil** *(TODO v1)* | Starke Streuung der letzten Real‑Werte | Noch **nicht** umgesetzt; im Code als klar benanntes `TODO` vermerkt. Könnte später ebenfalls `vertrauen = "niedrig"` auslösen. |
| **Daten fehlen** | Keine Realwerte oder unvollständige Prognose (nicht genau 4 Werte) | **Nichts zeichnen**, Kopfzeile: „Keine Tendenz verfügbar (Daten fehlen)." Kein Absturz. |

Die Winkeldifferenz wird **zyklisch** gerechnet (359° und 1° sind 2°
auseinander, nicht 358°), damit der Wächter am Nordübergang nicht fälschlich
auslöst.

---

## 7. Was justierbar ist (die Stellschrauben)

Alle Zahlen stehen als **benannte Konstanten** oben in `src/lib/tendenz.ts` –
nicht im Code verstreut. Vorsichtig anpassen; die Wirkung steht dabei:

| Konstante | Wert | Bedeutung / Wirkung |
|---|---:|---|
| `FENSTER_STUNDEN` | 3 | Vorlauf der Kurve. **Nicht ohne Rücksprache ändern** (Auftrag). |
| `REAL_MITTEL_SAMPLES` | 3 | Wie viele letzte Messungen gemittelt werden. Größer = ruhiger/träger. |
| `OFFSET_GROSS` | 15 | Ab hier gilt der Offset als „groß" → Vertrauen niedrig, Band breiter. |
| `RICHTUNG_SCHWELLE` | 60° | Ab dieser Richtungsabweichung Linie aussetzen. |
| `BAND_BASIS` | 2 | Grundbreite des Bands bei „jetzt" (halbe Breite, km/h). |
| `BAND_PRO_STUNDE` | 2 | Zusätzliche Bandbreite je Stunde Vorlauf. |
| `BAND_PRO_OFFSET` | 0,15 | Anteil von `\|offset\|`, der das Band zusätzlich verbreitert. |
| `TENDENZ_SCHWELLE` | 2 | Ab welcher Änderung über das Fenster „steigend"/„fallend" gilt. |

---

## 8. Tests

Die Berechnung ist mit Unit‑Tests abgesichert (`src/lib/tendenz.test.ts`,
Testfälle A–D aus dem Auftrag plus Zusatzfälle). Ausführen:

```bash
npm test
```

(Node 22+ führt die TypeScript‑Tests direkt aus.)

---

## 9. Bewusst (noch) nicht enthalten

- **Keine** Tendenzlinie für die **Böe**. Grund: Mittel und Böe brauchen
  **getrennte** Offsets (z. B. Mittel‑Offset +19 bei gleichzeitig Böe‑Offset
  ≈ −3). Kommt später als eigene Ausbaustufe (im Code als `TODO` vermerkt).
- **Keine** multiplikative Korrektur (Verhältnis statt Differenz) – erst v2.
- **Keine** Änderung an den bestehenden Layern (weiß = real, rot = Prognose,
  Achsen, Farbbänder, Richtungspfeile, Zahlenreihen).

---

## 10. Grenzen – bitte ernst nehmen

Die Tendenzkurve ist eine **Entscheidungshilfe**, kein Freibrief:

- **Heuristik, nicht kalibriert.** Die Konstanten sind fachlich plausibel
  gewählt, aber nicht gegen Messreihen optimiert.
- **Kein validiertes Prognoseprodukt.** Sie kann daneben liegen, besonders bei
  Wetterumschwung, Föhn, Gewitter oder Regimewechsel.
- **Ersetzt nicht das eigene Urteil.** Örtliche Beobachtung, Erfahrung und
  Vorsicht gehen immer vor.
- **Die Sicherheitsentscheidung liegt beim Piloten.**
