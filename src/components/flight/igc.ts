import type { TrackPoint } from "./track";

// --- IGC-Export ---
// IGC ist das übliche Dateiformat für Flüge (XContest, DHV-XC, Flugbuch-
// Programme). Aufbau: Kopfzeilen (A, H) und je GPS-Punkt eine B-Zeile mit
// Uhrzeit (UTC), Position, Druckhöhe und GPS-Höhe.
// Einschränkungen, bewusst so:
//   - Keine Druckhöhe: Browser kommen nicht an den Luftdruck-Sensor des
//     Handys. Das Feld steht deshalb auf 00000, die Höhe kommt nur aus dem GPS.
//   - Keine Signatur (G-Zeile): Nur zugelassene Flugrechner dürfen signieren.
//     Für Wettbewerbe, die eine gültige Signatur verlangen, reicht die Datei
//     nicht.
//   - Punkte ohne Zeit (Tracks von vor dem IGC-Export) fehlen in der Datei.
//   - Bezug der GPS-Höhe: Laut Browser-Norm über dem WGS84-Ellipsoid (in den
//     Alpen rund 50 m mehr als über dem Meer), das iPhone liefert aber
//     Meereshöhe. Die Kopfzeile HFALGALTGPS sagt deshalb, welche es ist.

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// Grad → IGC-Schreibweise GGMMmmm (Grad, Minuten mit drei Nachkommastellen).
function igcCoord(value: number, degWidth: number, pos: string, neg: string): string {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let milliMin = Math.round((abs - deg) * 60_000);
  if (milliMin === 60_000) {
    deg += 1;
    milliMin = 0;
  }
  return pad(deg, degWidth) + pad(milliMin, 5) + (value >= 0 ? pos : neg);
}

function igcAltitude(m: number): string {
  const r = Math.round(m);
  return r < 0 ? "-" + pad(-r, 4) : pad(Math.min(r, 99_999), 5);
}

// Fertige IGC-Datei, oder null, wenn kein Punkt eine Zeit hat.
export function buildIgc(segments: TrackPoint[][]): { text: string; firstTime: Date } | null {
  const fixes = segments.flat().filter((p) => p.length === 4) as [
    number,
    number,
    number,
    number | null,
  ][];
  if (fixes.length === 0) return null;
  const first = new Date(fixes[0][2] * 1000);
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  const lines = [
    "AXSGSISOSIG",
    `HFDTEDATE:${pad(first.getUTCDate(), 2)}${pad(first.getUTCMonth() + 1, 2)}${pad(first.getUTCFullYear() % 100, 2)},01`,
    "HFPLTPILOTINCHARGE:",
    "HFGTYGLIDERTYPE:",
    "HFGIDGLIDERID:",
    "HFDTMGPSDATUM:WGS84",
    "HFFTYFRTYPE:SISOSIG,Web-App",
    "HFGPSRECEIVER:Smartphone",
    "HFPRSPRESSALTSENSOR:NIL",
    `HFALGALTGPS:${isApple ? "GEO" : "ELL"}`,
    "HFALPALTPRESSURE:ISA",
  ];
  for (const [lat, lng, t, alt] of fixes) {
    const d = new Date(t * 1000);
    lines.push(
      "B" +
        pad(d.getUTCHours(), 2) +
        pad(d.getUTCMinutes(), 2) +
        pad(d.getUTCSeconds(), 2) +
        igcCoord(lat, 2, "N", "S") +
        igcCoord(lng, 3, "E", "W") +
        (alt === null ? "V" : "A") +
        "00000" +
        igcAltitude(alt ?? 0),
    );
  }
  return { text: lines.join("\r\n") + "\r\n", firstTime: first };
}

// IGC-Datei weitergeben: Am Handy über das Teilen-Menü (dort lässt sie sich
// in "Dateien" sichern, per Mail/Messenger schicken oder direkt an eine
// Flugbuch-App geben), sonst als normaler Download. Android-Chrome teilt nur
// bekannte Dateitypen, .igc gehört nicht dazu — dort greift der Download.
export async function exportIgc(segments: TrackPoint[][]) {
  const igc = buildIgc(segments);
  if (!igc) {
    window.alert(
      "Dieser Track wurde vor dem IGC-Export aufgezeichnet und hat keine Zeiten. " +
        "IGC geht erst für neue Aufzeichnungen.",
    );
    return;
  }
  const f = igc.firstTime;
  const name = `SISOSIG-${f.getFullYear()}-${pad(f.getMonth() + 1, 2)}-${pad(f.getDate(), 2)}-${pad(f.getHours(), 2)}${pad(f.getMinutes(), 2)}.igc`;
  const file = new File([igc.text], name, { type: "application/octet-stream" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    // Teilen-Menü abgebrochen: nichts weiter tun. Andere Fehler: Download.
    if (err instanceof DOMException && err.name === "AbortError") return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
