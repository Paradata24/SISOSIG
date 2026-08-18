"use client";

// Zeitbalken unter der Karte ("Windhistorie der Karte").
//
// Zum Schieben nach links: die Karte zeigt dann nicht mehr die Live-Werte,
// sondern die aufgezeichneten Messwerte aller Stationen zu diesem Zeitpunkt.
// Schrittweite = 10 Minuten, also genau der Takt, in dem die Stationen messen
// (siehe TIMELINE_STEP_MINUTES in src/lib/wind.ts).
//
// Bewusst ein ganz normaler <input type="range">: der lässt sich am Handy
// zuverlässig mit dem Finger ziehen, funktioniert mit den Pfeiltasten
// (ein Druck = 10 Minuten) und braucht keine eigene Zeiger-Rechnerei, die
// erfahrungsgemäß auf irgendeinem Gerät klemmt.
//
// Der Balken hängt NUR an der Slot-Liste (aus der Uhr des Browsers berechnet)
// und ist deshalb sofort da — auch bevor irgendwelche Verlaufsdaten geladen
// sind. Die Daten holt WindApp erst beim ersten Anfassen nach (onEngage).

export type TimelineStatus = "idle" | "loading" | "ready" | "error";

// Breite des Schiebe-Griffs (siehe .time-slider in globals.css). Die
// Stundenmarken darunter werden um einen halben Griff eingerückt, weil der
// Griff an den Enden genau um dieses Maß nach innen wandert — sonst stehen
// die Striche nicht über "ihrem" Zeitpunkt.
const THUMB_PX = 22;
// Alle 2 Stunden eine Stundenzahl unter dem Balken, dazwischen nur ein Punkt.
// Alle 12 zu beschriften würde selbst über die volle Breite eines Handys noch
// ineinanderlaufen.
const LABEL_EVERY_HOURS = 2;

/** "jetzt" bzw. "14:40 Uhr"; über Mitternacht hinweg zusätzlich der Wochentag. */
function formatSlotLabel(time: number | null, now: number): string {
  if (time === null) return "jetzt";
  const date = new Date(time);
  const hhmm = date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
  // Ein 12-Stunden-Fenster reicht regelmäßig über Mitternacht. "23:50 Uhr"
  // allein wäre dann zweideutig, deshalb der Wochentag davor.
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return `${hhmm} Uhr`;
  const weekday = date.toLocaleDateString("de-DE", { weekday: "short" });
  return `${weekday} ${hhmm} Uhr`;
}

/** "vor 3 h 20 min" — wie weit der gewählte Zeitpunkt zurückliegt. */
function formatAgo(time: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `vor ${rest} min`;
  if (rest === 0) return `vor ${hours} h`;
  return `vor ${hours} h ${rest} min`;
}

export default function TimeSlider({
  slots,
  selectedTime,
  onChange,
  onEngage,
  status,
}: {
  /** Rasterzeitpunkte (Epoch-ms), aufsteigend; der letzte ist "jetzt". */
  slots: number[];
  /** Gewählter Zeitpunkt, null = live. */
  selectedTime: number | null;
  onChange: (time: number | null) => void;
  /** Erster Kontakt mit dem Balken — löst das Nachladen der Daten aus. */
  onEngage: () => void;
  status: TimelineStatus;
}) {
  const lastIndex = slots.length - 1;
  const now = slots[lastIndex];
  // Gespeichert wird der ZEITPUNKT, nicht die Position — die Slot-Liste wandert
  // ja alle 10 Minuten weiter. Die Position wird daraus zurückgerechnet.
  const index =
    selectedTime === null
      ? lastIndex
      : Math.min(
          lastIndex,
          Math.max(0, Math.round((selectedTime - slots[0]) / (slots[1] - slots[0]))),
        );
  const live = selectedTime === null;

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    onEngage();
    const next = Number(event.target.value);
    // Ganz rechts IST "jetzt" — zurückziehen an den rechten Rand schaltet also
    // ohne Extra-Tipp wieder auf die Live-Werte um.
    onChange(next === lastIndex ? null : slots[next]);
  }

  const ticks = slots
    .map((time, i) => ({ time, i }))
    .filter(({ time }) => new Date(time).getMinutes() === 0)
    .map(({ time, i }) => ({
      time,
      percent: lastIndex === 0 ? 0 : (i / lastIndex) * 100,
      labelled: new Date(time).getHours() % LABEL_EVERY_HOURS === 0,
    }));

  return (
    // px-2 statt eines breiten Innenabstands: der Regler soll auf dem Handy
    // praktisch die ganze Bildschirmbreite ausnutzen. Die 8 px links/rechts
    // bleiben, damit der runde Griff an den Enden nicht am Bildschirmrand
    // klebt.
    // Reihenfolge von oben nach unten (Wunsch des Projektbesitzers):
    // Regler → Stundenzahlen → Uhrzeit/Knopf. Der Regler sitzt also direkt
    // unter der Karte, die Beschriftung darunter.
    // Der Balken ist seit dem Entfernen der Fußzeile das unterste Element der
    // Seite. Der zusätzliche untere Innenabstand hält die Uhrzeit-Zeile und den
    // "Jetzt"-Knopf über dem Bedienbalken, den iPhones unten einblenden. Auf
    // Geräten ohne so einen Balken ist env(...) gleich 0, dort ändert sich also
    // nichts.
    <div className="shrink-0 border-t border-zinc-200 bg-white px-2 pt-1.5 pb-[calc(0.125rem+env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900">
      <input
        type="range"
        className="time-slider block w-full"
        min={0}
        max={lastIndex}
        step={1}
        value={index}
        onChange={handleChange}
        onPointerDown={onEngage}
        onFocus={onEngage}
        aria-label="Zeitpunkt"
        aria-valuetext={formatSlotLabel(selectedTime, now)}
      />

      {/* Um einen halben Griff eingerückt: der Griff wandert an den Enden
          genau um dieses Maß nach innen, sonst stünden die Striche nicht
          unter "ihrem" Zeitpunkt. */}
      <div
        className="relative h-3.5"
        style={{ marginLeft: THUMB_PX / 2, marginRight: THUMB_PX / 2 }}
      >
        {ticks.map(({ time, percent, labelled }) => (
          <span
            key={time}
            className="absolute top-0 -translate-x-1/2 text-[10px] leading-none text-zinc-400 dark:text-zinc-500"
            style={{ left: `${percent}%` }}
          >
            {/* Bewusst nur die nackte Stundenzahl: toLocaleTimeString
                würde in Deutsch "08 Uhr" liefern, das ist für den schmalen
                Abstand auf dem Handy viel zu breit. */}
            {labelled ? String(new Date(time).getHours()).padStart(2, "0") : "·"}
          </span>
        ))}
      </div>

      {/* Fußzeile: Uhrzeit MITTIG unter dem Regler. Sie ist absolut zentriert
          (nicht per flex), damit sie exakt in der Mitte steht und nicht davon
          abhängt, wie breit der Hinweis links oder der Knopf rechts gerade
          sind. Feste Höhe, damit beim Schieben nichts springt. */}
      <div className="relative flex h-7 items-center">
        <div className="min-w-0 flex-1 truncate pr-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          {status === "loading"
            ? "Verlauf wird geladen…"
            : status === "error"
              ? <span className="text-red-600 dark:text-red-400">Verlauf nicht verfügbar</span>
              : live
                ? null
                : formatAgo(selectedTime, now)}
        </div>

        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-base leading-tight font-semibold text-zinc-900 tabular-nums dark:text-zinc-50">
          {formatSlotLabel(selectedTime, now)}
        </div>

        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={live}
          className="shrink-0 border border-black/10 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-white/10 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
        >
          Jetzt
        </button>
      </div>
    </div>
  );
}
