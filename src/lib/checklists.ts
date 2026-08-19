// Die drei Checklisten hinter den Buttons "breakfast", "lunch" und "dinner"
// oben rechts im Titelbalken.
//
// HIER werden die Checklisten gepflegt — sonst nirgends. Wer einen Punkt
// hinzufügen, ändern oder löschen will, ändert nur diese Datei; die Buttons
// und das Fenster passen sich automatisch an (auch die Anzahl der Punkte und
// die Fortschrittsanzeige "3/8").
//
// Ein Punkt darf zwei Teile haben:
//   text  = die kurze Zeile, die man abhakt (Pflicht)
//   hint  = eine kleine Erläuterung darunter (freiwillig, kann weggelassen
//           werden)
//
// Beispiel für einen ausgefüllten Punkt:
//   { id: "gurtzeug", text: "Gurtzeug geschlossen", hint: "Bein- und Brustgurt" },
//
// WICHTIG: Die "id" eines Punktes ist sein interner Name. Sie darf innerhalb
// einer Liste nur einmal vorkommen und sollte später nicht mehr geändert
// werden — an ihr hängen die gesetzten Haken.

export type ChecklistItem = {
  id: string;
  text: string;
  hint?: string;
};

export type Checklist = {
  /** Interner Name der Liste (wird für die Haken gebraucht). */
  id: string;
  /** Beschriftung des Buttons im Titelbalken. */
  buttonLabel: string;
  /** Überschrift im geöffneten Fenster. */
  title: string;
  /** Halbsatz unter der Überschrift, erklärt wann die Liste dran ist. */
  subtitle: string;
  items: ChecklistItem[];
};

// Reihenfolge = Reihenfolge der Buttons von links nach rechts.
// Die Inhalte der drei Listen folgen noch (Stand: noch keine Punkte
// hinterlegt) — das Fenster zeigt so lange einen Hinweis an.
export const CHECKLISTS: Checklist[] = [
  {
    id: "breakfast",
    buttonLabel: "breakfast",
    title: "Vorflugcheck",
    subtitle: "Vor dem Aufbruch bzw. beim Auslegen",
    items: [],
  },
  {
    id: "lunch",
    buttonLabel: "lunch",
    title: "Startcheck",
    subtitle: "Direkt vor dem Start",
    items: [],
  },
  {
    id: "dinner",
    buttonLabel: "dinner",
    title: "Check in der Luft",
    subtitle: "Nach dem Abheben, im Flug",
    items: [],
  },
];

/**
 * Schlüssel, unter dem der Haken eines einzelnen Punktes gemerkt wird.
 * Liste und Punkt zusammen, damit gleichnamige Punkte in zwei Listen sich
 * nicht gegenseitig abhaken.
 */
export function checklistItemKey(listId: string, itemId: string): string {
  return `${listId}:${itemId}`;
}
