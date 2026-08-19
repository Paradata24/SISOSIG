"use client";

import { useEffect, useRef } from "react";
import {
  checklistItemKey,
  type Checklist,
} from "@/lib/checklists";

// Das Fenster, das über der Karte aufgeht, wenn oben rechts einer der drei
// Buttons (breakfast / lunch / dinner) gedrückt wird.
//
// Bewusst ein einfaches Overlay und kein <dialog>: Safari auf älteren iPhones
// kann <dialog> nur eingeschränkt, und wir brauchen ohnehin nur "dunkler
// Hintergrund + Kasten in der Mitte".
//
// Die gesetzten Haken liegen NICHT hier, sondern in WindApp. Grund: das
// Fenster wird beim Schließen abgebaut — lägen die Haken hier, wären sie
// jedes Mal weg. So bleiben sie erhalten, solange die Seite offen ist.
//
// z-[1200] liegt über dem Menü (z-[1100]) und über der Leaflet-Karte, damit
// nichts durchscheint oder daneben anklickbar bleibt.

type Props = {
  checklist: Checklist;
  /** Alle Haken der ganzen Seite, Schlüssel siehe checklistItemKey(). */
  checked: Record<string, boolean>;
  onToggle: (key: string) => void;
  onResetList: (listId: string) => void;
  onClose: () => void;
};

export default function ChecklistPanel({
  checklist,
  checked,
  onToggle,
  onResetList,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape schließt das Fenster, und beim Öffnen wandert die Tastatur-Marke
  // auf den Schließen-Button — sonst bliebe sie unsichtbar irgendwo hinter
  // dem Overlay stehen.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const total = checklist.items.length;
  const done = checklist.items.filter(
    (item) => checked[checklistItemKey(checklist.id, item.id)],
  ).length;
  const allDone = total > 0 && done === total;

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-start justify-center bg-black/40 p-3 pt-16 sm:pt-24"
      // Klick auf den dunklen Hintergrund schließt. Die Abfrage auf
      // event.target verhindert, dass auch ein Klick INNERHALB des Kastens
      // (der ja nach oben durchgereicht wird) schließt.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={checklist.title}
        className="flex max-h-full w-full max-w-md flex-col border border-black bg-white shadow-xl dark:border-zinc-100 dark:bg-zinc-900"
      >
        {/* Kopfzeile: Titel links, Schließen rechts. Bleibt beim Scrollen
            der Liste stehen (shrink-0). */}
        <div className="flex shrink-0 items-start gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              {checklist.title}
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {checklist.subtitle}
            </p>
          </div>
          {total > 0 && (
            <span
              className={`shrink-0 border px-2 py-1 text-xs font-semibold tabular-nums ${
                allDone
                  ? "border-emerald-700 bg-emerald-600 text-white dark:border-emerald-500"
                  : "border-black/10 text-zinc-600 dark:border-white/10 dark:text-zinc-300"
              }`}
            >
              {done}/{total}
            </span>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="flex h-8 w-8 shrink-0 items-center justify-center border border-black bg-white text-zinc-900 dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-50"
          >
            {/* Kreuz aus zwei gedrehten Strichen — gleiche eckige Machart wie
                der Menü-Button daneben. */}
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect
                x="1"
                y="7"
                width="14"
                height="2"
                fill="currentColor"
                transform="rotate(45 8 8)"
              />
              <rect
                x="1"
                y="7"
                width="14"
                height="2"
                fill="currentColor"
                transform="rotate(-45 8 8)"
              />
            </svg>
          </button>
        </div>

        {/* Die Punkte. Eigener Scrollbereich, damit die Kopf- und Fußzeile
            auch bei einer langen Liste auf dem Handy sichtbar bleiben. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {total === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
              Für diese Checkliste sind noch keine Punkte hinterlegt.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {checklist.items.map((item) => {
                const key = checklistItemKey(checklist.id, item.id);
                const isChecked = Boolean(checked[key]);
                return (
                  <li key={item.id}>
                    {/* Die ganze Zeile ist der Schalter (nicht nur das
                        Kästchen) — mit Handschuhen am Startplatz trifft man
                        ein 20-px-Kästchen sonst kaum. */}
                    <button
                      type="button"
                      onClick={() => onToggle(key)}
                      aria-pressed={isChecked}
                      className={`flex w-full items-start gap-2.5 border px-2.5 py-2 text-left transition-colors ${
                        isChecked
                          ? "border-emerald-700 bg-emerald-50 dark:border-emerald-500 dark:bg-emerald-900/30"
                          : "border-black/10 bg-white hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border ${
                          isChecked
                            ? "border-emerald-700 bg-emerald-600 text-white dark:border-emerald-500"
                            : "border-zinc-400 bg-white dark:border-zinc-500 dark:bg-zinc-900"
                        }`}
                      >
                        {isChecked && (
                          <svg width="12" height="12" viewBox="0 0 12 12">
                            <path
                              d="M1.5 6.5 L4.5 9.5 L10.5 2.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            />
                          </svg>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block text-sm ${
                            isChecked
                              ? "text-zinc-500 line-through dark:text-zinc-400"
                              : "text-zinc-900 dark:text-zinc-50"
                          }`}
                        >
                          {item.text}
                        </span>
                        {item.hint && (
                          <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                            {item.hint}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Fußzeile nur, wenn es überhaupt etwas zurückzusetzen gibt. */}
        {total > 0 && (
          <div className="shrink-0 border-t border-black/10 px-3 py-2 dark:border-white/10">
            <button
              type="button"
              onClick={() => onResetList(checklist.id)}
              disabled={done === 0}
              className="w-full border border-black/10 bg-white px-2 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-white dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:disabled:hover:bg-zinc-800"
            >
              Alle Haken zurücksetzen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
