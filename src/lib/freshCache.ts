// Kleiner Zwischenspeicher für Live-Messwerte, der nach Ablauf FRISCH holt.
//
// Warum nicht der Next.js-Daten-Cache (`fetch(..., { next: { revalidate } })`)?
// Der arbeitet nach dem Muster "stale-while-revalidate": Ist ein Eintrag
// abgelaufen, bekommt die Anfrage ZUERST noch den alten Stand, neu geholt wird
// erst danach im Hintergrund. Bei wenigen Besuchern ist der alte Stand dann
// so alt wie der vorige Abruf — bei /api/collect (alle 5 min) also 5 min.
// Nachgewiesen im Okt. 2026 an MeteoSchweiz: Die Datei mit den Werten von
// 15:00 erscheint um 15:10:10, gespeichert wurde sie aber erst um 15:20 statt
// um 15:15. Dasselbe galt für die Live-Werte der Karte.
//
// Dieser Speicher hält das Ergebnis wie bisher eine feste Zeit (die Zahl der
// Anfragen an die Dienste bleibt also gleich, wichtig für GeoSphere mit 240
// Anfragen pro Stunde), holt nach Ablauf aber sofort neu und wartet darauf.
// Laufen mehrere Anfragen gleichzeitig an, teilen sie sich denselben Abruf
// (es wird das Promise gespeichert). Vorbild ist der SLF-Speicher in slf.ts.
//
// Der Speicher liegt im Arbeitsspeicher der jeweiligen Server-Instanz; jede
// Instanz (z. B. /api/wind und /api/collect) hat ihren eigenen.

const entries = new Map<string, { at: number; promise: Promise<unknown> }>();

/**
 * Liefert das Ergebnis von `load` aus dem Speicher, solange es jünger als
 * `ttlMs` ist, sonst wird neu geladen. `key` ist üblicherweise die Adresse.
 * Ein Fehlschlag wird nicht gespeichert: der nächste Aufruf versucht es neu.
 */
export function cachedFresh<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = entries.get(key);
  if (cached && now - cached.at < ttlMs) return cached.promise as Promise<T>;

  const promise = load();
  entries.set(key, { at: now, promise });
  promise.catch(() => {
    if (entries.get(key)?.promise === promise) entries.delete(key);
  });
  return promise;
}
