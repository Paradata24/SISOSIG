// Winddaten schon beim Öffnen der Seite anfordern (Punkt 8 der
// Code-Durchsicht, Nov. 2026).
//
// Vorher fragte erst die Karte selbst (WindMap) nach /api/wind — und die wird
// ohne Server-Rendering nachgeladen (WindMapLoader), also erst, wenn das
// JavaScript der Seite UND danach das Kartenprogramm (Leaflet) angekommen
// sind. Am Handy im Mobilfunknetz vergeht bis dahin gut eine Sekunde, in der
// die Winddaten noch gar nicht unterwegs waren.
//
// Jetzt startet eine winzige Zeile im <head> der Seite (src/app/layout.tsx)
// die Anfrage, sobald der Browser die Seite liest. Sie läuft also parallel zu
// allem anderen; WindMap übernimmt beim ersten Laden die schon laufende (oft
// schon fertige) Antwort, statt eine zweite Anfrage zu stellen.
//
// Bewusst ein einfaches <script> statt next/script: Dessen "beforeInteractive"
// wartet im App Router trotzdem auf das JavaScript von Next.js (nachgeprüft
// in node_modules/next/dist/client/app-bootstrap.js) — das wäre kaum früher
// als vorher.

/** Platz am window-Objekt, an dem die vorab gestartete Anfrage wartet. */
const EARLY_WIND_KEY = "__sisosigWind";

// Älter als das wird die vorab geholte Antwort nicht mehr genommen, sondern
// frisch gefragt. Normal übernimmt die Karte sie nach 1–3 Sekunden; die
// Grenze ist nur eine Absicherung, falls die Karte (warum auch immer) viel
// später startet.
const EARLY_WIND_MAX_AGE_MS = 60_000;

/**
 * Inhalt des <script> im <head>. Gleiche Anfrage wie in WindMap
 * (cache: "no-store"). Das leere catch verhindert nur eine Fehlermeldung in
 * der Konsole, falls niemand die Antwort abholt — WindMap sieht einen Fehler
 * trotzdem und zeigt ihn wie bisher an.
 */
export const EARLY_WIND_SCRIPT =
  `try{var w={t:Date.now(),p:fetch("/api/wind",{cache:"no-store"})};` +
  `w.p.catch(function(){});window.${EARLY_WIND_KEY}=w}catch(e){}`;

/**
 * Die vorab gestartete Anfrage abholen (nur einmal möglich), oder null, wenn
 * es keine gibt oder sie zu alt ist — dann fragt WindMap selbst.
 */
export function takeEarlyWindRequest(): Promise<Response> | null {
  const slot = window as unknown as Record<string, { t: number; p: Promise<Response> } | undefined>;
  const early = slot[EARLY_WIND_KEY];
  delete slot[EARLY_WIND_KEY];
  if (!early || Date.now() - early.t > EARLY_WIND_MAX_AGE_MS) return null;
  return early.p;
}
