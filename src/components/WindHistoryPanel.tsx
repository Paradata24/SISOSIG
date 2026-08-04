"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  FUTURE_MARGIN_HOURS,
  getWindColor,
  HISTORY_HOURS,
  snapDirectionTo8,
  SOURCE_INFO,
  WIND_COLOR_SCALE,
  type WindStation,
} from "@/lib/wind";
import type { HistoryEntry } from "@/app/api/history/route";
import type { ForecastEntry } from "@/app/api/forecast/route";

// Verlaufspanel am unteren Bildschirmrand (Vorbild: Meteoparapente).
// Zeigt für die angeklickte Station die letzten 12 Stunden (HISTORY_HOURS):
//  - Zeitachse (Lokalzeit) oben
//  - Liniendiagramm: Mittelwind (unten) und Böen (oben), beide gleich dick,
//    ohne Füllfläche dazwischen, vor horizontalen Farbbändern der
//    Windstärke-Skala
//  - darunter eine Reihe Windrichtungs-Pfeile, die Messwerte in eingefärbten
//    Rechtecken (Farbe = Windskala) und noch einmal die Uhrzeiten
// Farben und Pfeil-Drehung nutzen exakt dieselbe Logik wie die Karten-
// Pfeile (getWindColor bzw. auf 8 Himmelsrichtungen eingerastete Richtung
// + 180°), damit nichts auseinanderläuft. Der exakte Grad-Wert bleibt in
// den Tooltips (title) der Pfeile erhalten.

// Geometrie des SVG (alle Angaben in px). Gegenüber der ursprünglichen
// Version bewusst ca. 10% größer und mit mehr Abstand zwischen den Zeilen,
// damit das Panel nicht mehr gedrängt wirkt.
const TIME_LABEL_H = 20; // Zeile mit den Uhrzeiten oben
const CHART_H = 154; // Höhe des Kurvenbereichs
// FESTE Obergrenze der y-Achse (km/h). Bewusst nicht mehr datenabhängig:
// eine mitwachsende Achse lässt einen ruhigen und einen stürmischen Tag
// gleich hoch aussehen. Mit fester Skala hat dieselbe Kurvenhöhe immer
// dieselbe Bedeutung und man kann Stationen/Tage direkt vergleichen.
// Werte über dieser Grenze werden gekappt (siehe y()), die echten Zahlen
// stehen weiterhin in den Werte-Zeilen unter den Pfeilen.
const Y_MAX_KMH = 45;
// Waagrechte Orientierungslinien im Kurvenbereich (km/h). Damit sieht man auf
// einen Blick, wann Mittelwind bzw. Böen diese Schwellen überschreiten, ohne
// die Kurve mit der Achsenbeschriftung links abgleichen zu müssen.
const THRESHOLD_LINES_KMH = [5, 15, 25];
const ARROW_GAP = 14; // Abstand Kurvenbereich → Pfeilreihe
const ARROW_ROW_H = 26; // Höhe der Messwert-Pfeilreihe (Pfeil ist ~15 px hoch, Rest ist Luft)
// Abstand Pfeilreihe → Wert-Quadrate. Bewusst klein, damit die Zahlen dicht
// unter "ihrem" Pfeil sitzen und das Panel insgesamt flacher bleibt (Wunsch
// des Projektbesitzers: mehr Karte sichtbar).
const VALUES_GAP = 4;
// Messwerte UND Prognosewerte stehen in eingefärbten Quadraten (Farbe =
// Windskala des jeweiligen Werts), damit man die Windstärke schon an der
// Zahlenreihe ablesen kann. Bewusst quadratisch und ohne abgerundete Ecken
// (Wunsch des Projektbesitzers): Breite = Höhe, deshalb EINE gemeinsame
// Kantenlänge. Auf Wunsch um ca. 10% vergrößert (15 → 16.5), die Schrift
// darin entsprechend von 10 auf 11 px.
const MEAS_BOX_H = 16.5; // Kantenlänge eines Wert-Quadrats (Höhe = Breite)
const MEAS_BOX_W = MEAS_BOX_H;
const MEAS_BOX_GAP = 2; // senkrechter Abstand Mittelwind-Quadrat → Böen-Quadrat
const MEAS_VALUES_ROW_H = MEAS_BOX_H * 2 + MEAS_BOX_GAP;
const MEAS_TIME_GAP = 4; // Abstand Böen-Quadrat → wiederholte Uhrzeit-Zeile
const MEAS_TIME_ROW_H = 13; // Höhe der wiederholten Uhrzeit-Zeile
// Trennung zwischen Messwert-Block (schwarz) und Prognose-Vergleichsblock.
const FORECAST_ROW_GAP = 10;
const BOTTOM_PAD = 6; // zusätzlicher Freiraum unterhalb der Werte-Zeilen
// Höhe des SVG: Zeitachse + Kurvenbereich + Messwert-Block (Pfeile + 2 Zeilen
// eingefärbte Werte + wiederholte Uhrzeiten) + Prognose-Vergleichsblock
// (2 Zeilen eingefärbte Werte, ICON-CH1 links / AROME rechts nebeneinander,
// je mit dem Richtungspfeil außen neben dem eigenen Quadrat-Paar statt einer
// eigenen Pfeilreihe darüber — deshalb braucht der Block hier keine eigene
// ARROW_ROW_H mehr) + unterer Rand.
const SVG_H =
  TIME_LABEL_H + CHART_H +
  ARROW_GAP + ARROW_ROW_H + VALUES_GAP + MEAS_VALUES_ROW_H +
  MEAS_TIME_GAP + MEAS_TIME_ROW_H +
  FORECAST_ROW_GAP + MEAS_VALUES_ROW_H +
  BOTTOM_PAD;
const PAD_X = 11; // Innenabstand der Farbbänder (Kurvenbereich) vom SVG-Rand
// Horizontaler Abstand vom Stundenpunkt für den Prognose-Vergleichsblock:
// rotes ICON-CH1 links, gelbes AROME rechts nebeneinander unter derselben
// Stunde.
const FORECAST_PAIR_HALF_GAP = 11;
// Waagrechter Abstand zwischen Quadrat-Kante und Pfeil im Prognose-Block.
const FORECAST_ARROW_GAP_X = 3;

// Waagrechte Lücke zwischen zwei benachbarten Wert-Quadraten. Seit die
// Kästchen quadratisch sind (16.5 statt vorher 27 px breit), blieb dazwischen
// viel Leerraum; auf Wunsch des Projektbesitzers ist die Lücke um 25%
// verkleinert (18 → 13.5 px) und beim späteren Vergrößern der Quadrate um
// deren Zuwachs nachgezogen (13.5 → 12), damit der Spaltenabstand — und damit
// die Gesamtbreite des Verlaufsbalkens — exakt gleich bleibt. Weil daraus der
// Spaltenabstand und damit die ganze Achsenbreite abgeleitet wird, rückt der
// komplette Verlaufsbalken entsprechend enger zusammen — hier ist der einzige
// Stellknopf dafür.
const MEAS_BOX_GAP_X = 12;
// Abstand von Spaltenmitte zu Spaltenmitte = Kästchenbreite + Lücke.
const COLUMN_SPACING = MEAS_BOX_W + MEAS_BOX_GAP_X;
// Mindestabstand (px) zwischen zwei Pfeil-/Werte-Spalten, damit sich die
// (bis zu 3-stelligen) Zahlen nicht überlappen — Sicherheitsnetz für die
// Ausdünnung weiter unten. Etwas kleiner als der Spaltenabstand, damit genau
// 10 min auseinanderliegende Werte sicher darüber liegen.
const MIN_LABEL_SPACING = COLUMN_SPACING - 2;
// Gewünschte Anzeige-Dichte: zu jeder vollen Stunde eine Messung, dazwischen
// alle 10 Minuten eine — also 6 Werte pro Stunde.
const LABEL_INTERVAL_MIN = 10;
// Breite pro Stunde für den Geschichts-Teil (jetzt − 12h bis jetzt). FEST (nicht
// datenabhängig) so gewählt, dass die 6 Messungen pro Stunde (alle 10 min) mit
// genau dem Spaltenabstand nebeneinander Platz haben.
// Dadurch ist die Achse zugleich breiter als der Bildschirm → das Diagramm
// bleibt horizontal scrollbar.
const HISTORY_PX_PER_HOUR = Math.ceil((60 / LABEL_INTERVAL_MIN) * COLUMN_SPACING);
// Die Prognose-Reserve rechts von der "jetzt"-Linie enthält keine echten
// Messwerte mehr und darf daher 50% enger gepackt sein als der Geschichts-Teil.
const FUTURE_PX_PER_HOUR = HISTORY_PX_PER_HOUR / 2;
const ARROW_SIZE = 17; // Kantenlänge eines Richtungspfeils
// Größter waagrechter Abstand, den ein Prognose-Pfeil vom Stundenpunkt haben
// kann (Paar-Abstand + halbes Quadrat + Pfeil-Abstand + Pfeil selbst, der
// Pfeil steht ja außen neben dem Quadrat-Paar). Sowohl der linke als auch der
// rechte Innenabstand des SVG müssen mindestens so groß sein, sonst wird der
// äußerste CH1- bzw. AROME-Pfeil am Rand angeschnitten.
const AXIS_PAD = Math.max(
  PAD_X,
  FORECAST_PAIR_HALF_GAP + MEAS_BOX_W / 2 + FORECAST_ARROW_GAP_X + ARROW_SIZE,
);
// Waagrechter Abstand der Pfeil-MITTE (nicht der Außenkante wie AXIS_PAD) vom
// Stundenpunkt: CH1-Pfeil bei tx − diesem Wert, AROME-Pfeil bei tx + diesem
// Wert, jeweils außen neben dem eigenen Quadrat-Paar.
const FORECAST_ARROW_CX_OFFSET =
  FORECAST_PAIR_HALF_GAP + MEAS_BOX_W / 2 + FORECAST_ARROW_GAP_X + ARROW_SIZE / 2;
// Wie weit die Historie zurückreicht (HISTORY_HOURS) bzw. wie viel Platz rechts
// nach "jetzt" bleibt (FUTURE_MARGIN_HOURS) — beides zentral in src/lib/wind.ts,
// weil /api/history und /api/forecast dieselben Werte brauchen. Die Zeitachse
// läuft fest von (jetzt − 12h) bis (jetzt + 4h), sodass die aktuelle Uhrzeit
// immer nahe dem rechten Rand steht.
// Zwei aufeinanderfolgende Messpunkte werden nur dann zu einer Linie
// verbunden, wenn sie höchstens so weit auseinanderliegen. Gesammelt wird alle
// 10 Minuten (/api/collect, per Supabase Cron); 1 Stunde ist also das Sechsfache
// des Normalabstands und übersteht einzelne verpasste Läufe, verdeckt aber auf
// der 12h-Achse keine echten Datenlücken mehr. Größere Lücken bleiben als
// Unterbrechung sichtbar (die Messpunkte selbst werden ohnehin als Punkte
// gezeichnet).
const LINE_GAP_MS = 60 * 60 * 1000;

// Farbe der AROME-Prognose (GeoSphere Austria). Fester Hex-Wert (vom
// Projektbesitzer vorgegeben) statt einer Tailwind-Klasse, damit der Ton in
// Kurve, Punkten, Pfeilen und Zahlen exakt derselbe ist.
const AROME_COLOR = "#FFD400";
// Farbe der ICON-CH1-Prognose als fester Hex-Wert. Kurve, Punkte und der
// Vergleichs-Pfeil im Prognose-Block benutzen dafür die Tailwind-Klassen
// stroke-red-600/dark:stroke-red-500 bzw. fill-red-600/dark:fill-red-500; für
// die Textfarbe des "–" bei fehlendem Wert brauchen wir einen konkreten
// Farbwert, und weil die Seite dauerhaft im Dunkelmodus läuft, ist das genau
// red-500.
const CH1_COLOR = "#ef4444";

interface Point {
  t: number; // Zeitstempel (ms) — bei Messwerten der Raster-Zeitpunkt (s.u.)
  speed: number | null;
  gust: number | null;
  direction: number | null;
  // Nur bei Messwerten gesetzt: der echte Mess-Zeitstempel der Station, bevor
  // er auf das 10-Minuten-Raster eingerastet wurde. Wird im Tooltip gezeigt,
  // damit die tatsächliche Messzeit nicht verloren geht.
  tActual?: number;
}

// --- Messwerte auf ein festes 10-Minuten-Raster einrasten ---
// Die Bozner Stationen messen bereits zur vollen Stunde und alle 10 Minuten
// (:00, :10, :20 …). Die OpenWindMap-/Pioupiou-Stationen dagegen senden zu
// beliebigen Zeitpunkten (z. B. :03, :17, :26), wodurch ihre Pfeile und
// Wert-Quadrate im Verlaufsbalken ungleichmäßig standen und die Ausdünnung
// mal die eine, mal die andere Spalte verschluckte.
// Deshalb werden alle Messpunkte hier auf dasselbe Anzeige-Raster gelegt:
// pro 10-Minuten-Fenster genau ein Punkt, nämlich die zeitlich am nächsten
// am Rasterpunkt liegende echte Messung (also höchstens 5 Minuten Versatz).
// Ergebnis: gleiche, gleichmäßige Spalten für beide Quellen. Fehlt in einem
// Fenster eine Messung, bleibt die Lücke sichtbar — es wird nichts erfunden.
// Rasterweite = die ohnehin gewünschte Anzeige-Dichte (LABEL_INTERVAL_MIN,
// 10 min), damit Raster und Spaltenbreite nicht auseinanderlaufen können.
const GRID_MS = LABEL_INTERVAL_MIN * 60 * 1000;

function snapToGrid(t: number): number {
  // Bezugspunkt ist die volle LOKALE Stunde (nicht die Epoche), damit das
  // Raster auch in Zeitzonen mit halbstündigem Versatz exakt auf :00/:10/:20
  // fällt.
  const hourStart = new Date(t);
  hourStart.setMinutes(0, 0, 0);
  const base = hourStart.getTime();
  return base + Math.round((t - base) / GRID_MS) * GRID_MS;
}

function snapPointsToGrid(points: Point[]): Point[] {
  const bySlot = new Map<number, { point: Point; dist: number; hasData: boolean }>();
  for (const p of points) {
    const slot = snapToGrid(p.t);
    const dist = Math.abs(p.t - slot);
    const hasData = p.speed !== null || p.gust !== null;
    const cur = bySlot.get(slot);
    // Punkte mit Werten haben Vorrang vor leeren; danach entscheidet die
    // geringere Entfernung zum Rasterpunkt.
    const better =
      !cur ||
      (hasData && !cur.hasData) ||
      (hasData === cur.hasData && dist < cur.dist);
    if (better) {
      bySlot.set(slot, { point: { ...p, t: slot, tActual: p.t }, dist, hasData });
    }
  }
  return Array.from(bySlot.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v.point);
}

function formatHourLabel(date: Date): string {
  // Um Mitternacht das Datum statt "00:00" zeigen, damit der Tageswechsel
  // in der Zeitachse erkennbar ist.
  if (date.getHours() === 0) {
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  }
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

function formatTime(t: number): string {
  return new Date(t).toLocaleString("de-DE", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "unbekannt";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

// Baut den SVG-Pfad einer Kurve. Bei fehlenden Werten oder größeren
// Messlücken wird der Pfad unterbrochen (neues "M"-Segment).
function buildLinePath(
  points: Point[],
  getValue: (p: Point) => number | null,
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  let prevT: number | null = null;
  for (const p of points) {
    const v = getValue(p);
    if (v === null) {
      prevT = null;
      continue;
    }
    const cmd = prevT !== null && p.t - prevT <= LINE_GAP_MS ? "L" : "M";
    d += `${cmd}${x(p.t).toFixed(1)} ${y(v).toFixed(1)} `;
    prevT = p.t;
  }
  return d.trim();
}

// Baut den SVG-Pfad der Fläche zwischen zwei Kurven (oben Böe, unten
// Mittelwind). Wie buildLinePath wird die Fläche unterbrochen, sobald ein
// Wert fehlt oder die Messlücke zu groß ist — sonst würde über eine Lücke
// hinweg eine Fläche gemalt, die es gar nicht gibt.
function buildBandPath(
  points: Point[],
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  let d = "";
  let run: Point[] = [];

  const flush = () => {
    // Eine Fläche braucht mindestens zwei Punkte
    if (run.length < 2) {
      run = [];
      return;
    }
    const top = run
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.gust!).toFixed(1)}`)
      .join(" ");
    const bottom = [...run]
      .reverse()
      .map((p) => `L${x(p.t).toFixed(1)} ${y(p.speed!).toFixed(1)}`)
      .join(" ");
    d += `${top} ${bottom} Z `;
    run = [];
  };

  for (const p of points) {
    if (p.speed === null || p.gust === null) {
      flush();
      continue;
    }
    const prev = run[run.length - 1];
    if (prev && p.t - prev.t > LINE_GAP_MS) flush();
    run.push(p);
  }
  flush();

  return d.trim();
}

// Passende Textfarbe für ein eingefärbtes Wert-Rechteck: auf den dunklen
// Stufen der Windskala (dunkelrot, schwarz) weiß, sonst dunkelgrau — sonst
// wäre die Zahl im Rechteck nicht mehr lesbar.
function contrastTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // wahrgenommene Helligkeit (0–255)
  const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
  return brightness > 140 ? "#18181b" : "#ffffff";
}

// Ein einzelnes Wert-Quadrat: die gerundete Zahl mittig in einem Quadrat, das
// nach der Windskala des Werts eingefärbt ist. Wird sowohl für die Messwerte
// (schwarzer Block) als auch für die beiden Prognosen benutzt, damit beide
// Zeilen garantiert identisch aussehen — ohne Rahmen, denn welches Modell
// gemeint ist, zeigt inzwischen der Richtungspfeil daneben (CH1 links, AROME
// rechts vom jeweiligen Quadrat-Paar).
// - `bold`: stündliche Messwerte werden fett gesetzt (Vergleich mit der
//   ebenfalls stündlichen Prognose).
// - `accent`: Textfarbe des "–" bei fehlendem Prognosewert (rot = ICON-CH1,
//   gelb = AROME), damit auch eine leere Zelle noch ihrer Spalte zuzuordnen
//   ist; Messwert-Quadrate lassen `accent` weg und bleiben neutral grau.
function ValueBox({
  cx,
  boxY,
  value,
  bold = false,
  accent,
}: {
  cx: number;
  boxY: number;
  value: number | null;
  bold?: boolean;
  accent?: string;
}) {
  // Ohne Wert kein Quadrat, nur ein "–" in der jeweiligen Zeilenfarbe.
  if (value === null) {
    return (
      <text
        x={cx.toFixed(1)}
        y={boxY + MEAS_BOX_H / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={accent}
        className={
          accent
            ? "text-[11px] tabular-nums"
            : "fill-zinc-400 text-[11px] tabular-nums dark:fill-zinc-500"
        }
      >
        –
      </text>
    );
  }
  const color = getWindColor(value);
  return (
    <g>
      <rect
        x={(cx - MEAS_BOX_W / 2).toFixed(1)}
        y={boxY}
        width={MEAS_BOX_W}
        height={MEAS_BOX_H}
        fill={color}
      />
      <text
        x={cx.toFixed(1)}
        y={boxY + MEAS_BOX_H / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={contrastTextColor(color)}
        className={`text-[11px] tabular-nums ${bold ? "font-bold" : ""}`}
      >
        {Math.round(value)}
      </text>
    </g>
  );
}

export default function WindHistoryPanel({
  station,
  onClose,
}: {
  station: WindStation;
  onClose: () => void;
}) {
  // Ergebnis des letzten Ladevorgangs, inklusive Stationscode. Solange der
  // Code nicht zur aktuell gewählten Station passt, gilt das Panel als
  // "lädt" — so braucht es beim Stationswechsel kein separates Zurücksetzen.
  const [result, setResult] = useState<{
    code: string;
    entries?: HistoryEntry[];
    // Prognose ist optional/additiv: schlägt sie fehl oder ist leer, bleibt
    // dieses Feld leer, ohne die Messwert-Anzeige zu blockieren.
    forecast?: ForecastEntry[];
    // AROME-Bodenwind (zweite Prognose zum Vergleich), ebenfalls additiv:
    // Stationen ohne AROME-Abdeckung liefern hier einfach nichts.
    forecastArome?: ForecastEntry[];
    error?: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  // Bezugszeitpunkt "jetzt" für die feste Zeitachse. Wird beim Laden gesetzt,
  // damit der Render selbst rein bleibt (kein Date.now() während des Renderns).
  const [now, setNow] = useState(() => Date.now());
  // Eindeutige id für das <linearGradient> der Farbskala (SVG-ids dürfen im
  // Dokument nicht kollidieren).
  const gradientId = useId();

  const loading = result?.code !== station.stationCode;
  const entries = loading ? null : (result?.entries ?? null);
  const forecast = loading ? null : (result?.forecast ?? null);
  const forecastArome = loading ? null : (result?.forecastArome ?? null);
  const error = loading ? null : (result?.error ?? null);

  // Historie der angeklickten Station laden.
  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      const code = station.stationCode;
      try {
        // Messwerte und Prognose parallel laden. Die Prognose ist additiv:
        // scheitert sie (Netzfehler, 502, oder Station ohne Prognose), zeigen
        // wir einfach keine Prognose-Kurven, ohne die Messwerte zu blockieren.
        const [res, forecastJson] = await Promise.all([
          fetch(`/api/history?station=${encodeURIComponent(code)}`),
          fetch(`/api/forecast?station=${encodeURIComponent(code)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        const forecastEntries =
          (forecastJson?.entries as ForecastEntry[] | undefined) ?? [];
        const forecastAromeEntries =
          (forecastJson?.entriesArome as ForecastEntry[] | undefined) ?? [];
        const data = await res.json();
        if (cancelled) return;
        setNow(Date.now());
        if (!res.ok) {
          setResult({
            code,
            error: data.error ?? "Verlauf konnte nicht geladen werden",
          });
        } else {
          setResult({
            code,
            entries: data.entries as HistoryEntry[],
            forecast: forecastEntries,
            forecastArome: forecastAromeEntries,
          });
        }
      } catch {
        if (!cancelled) {
          setResult({ code, error: "Verlauf konnte nicht geladen werden" });
        }
      }
    }

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [station.stationCode]);

  // Escape schließt das Panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Breite des Scrollbereichs beobachten, damit das SVG auf großen
  // Bildschirmen die volle Breite füllt.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Nach dem Laden ans rechte Ende scrollen (neueste Werte zuerst sichtbar).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && entries && entries.length > 0) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [entries]);

  // Messpunkte, eingerastet auf das 10-Minuten-Anzeige-Raster (siehe
  // snapPointsToGrid): dadurch stehen die Pfeile und Wert-Quadrate bei ALLEN
  // Stationen zur vollen Stunde und alle 10 Minuten — auch bei den
  // OpenWindMap-Stationen, die zu krummen Zeiten senden.
  const points: Point[] = snapPointsToGrid(
    (entries ?? [])
      .map((e) => ({
        t: Date.parse(e.measured_at),
        speed: e.speed_kmh,
        gust: e.gust_kmh,
        direction: e.direction,
      }))
      .filter((p) => !Number.isNaN(p.t)),
  );

  // Prognose-Punkte genau wie die Messpunkte aufbereiten (nur andere Quelle).
  const forecastPoints: Point[] = (forecast ?? [])
    .map((e) => ({
      t: Date.parse(e.forecast_time),
      speed: e.speed_kmh,
      gust: e.gust_kmh,
      direction: e.direction,
    }))
    .filter((p) => !Number.isNaN(p.t));

  // AROME-Bodenwind-Punkte (zweite Prognose, gelb) — gleiche Aufbereitung
  // wie die roten ICON-CH1-Punkte. Liegt eine Station außerhalb des
  // AROME-Gebiets (z.B. westlicher Vinschgau), bleibt diese Liste leer und
  // es wird schlicht keine gelbe Kurve gezeichnet.
  const forecastAromePoints: Point[] = (forecastArome ?? [])
    .map((e) => ({
      t: Date.parse(e.forecast_time),
      speed: e.speed_kmh,
      gust: e.gust_kmh,
      direction: e.direction,
    }))
    .filter((p) => !Number.isNaN(p.t));

  // Auch eine Station mit Prognose, aber (noch) ohne Messwerte soll angezeigt
  // werden — nicht fälschlich "Keine Daten verfügbar".
  const hasData =
    points.some((p) => p.speed !== null || p.gust !== null) ||
    forecastPoints.some((p) => p.speed !== null || p.gust !== null) ||
    forecastAromePoints.some((p) => p.speed !== null || p.gust !== null);

  // --- Skalen ---
  // Feste Zeitachse von (jetzt − 12h) bis (jetzt + 4h), unabhängig davon,
  // welche Messpunkte tatsächlich vorliegen. So sitzen die Werte immer an der
  // richtigen Stelle der Achse, fehlende Zeiträume bleiben als Lücke sichtbar
  // (statt die wenigen Punkte über die ganze Breite zu strecken), und die
  // aktuelle Uhrzeit steht dank der Prognose-Reserve stets nahe dem rechten Rand.
  const minT = now - HISTORY_HOURS * 3_600_000;
  const maxT = now + FUTURE_MARGIN_HOURS * 3_600_000;

  // Nominale Breite der beiden Achsen-Abschnitte (Geschichte / Prognose-Reserve).
  // Die Reserve ist bewusst nur halb so breit pro Stunde wie die Geschichte.
  const historyWidth0 = HISTORY_HOURS * HISTORY_PX_PER_HOUR;
  const futureWidth0 = FUTURE_MARGIN_HOURS * FUTURE_PX_PER_HOUR;
  const contentWidth0 = historyWidth0 + futureWidth0;

  const svgWidth = Math.max(
    containerW,
    Math.ceil(contentWidth0) + 2 * AXIS_PAD,
  );
  // Zeichenbreite der Zeitachse (endet vor dem beidseitigen Zuschlag für die
  // äußersten Prognose-Pfeile) …
  const innerW = svgWidth - 2 * AXIS_PAD;
  // … die Farbbänder reichen dagegen bis zum kleineren PAD_X-Innenrand, damit
  // links/rechts kein unbemalter Streifen im Kurvenbereich entsteht (der
  // größere AXIS_PAD ist nur für den Prognose-Block unten nötig).
  const bandWidth = svgWidth - 2 * PAD_X;
  // Auf breiten Bildschirmen füllt das Diagramm die volle Breite; beide
  // Abschnitte werden dabei im gleichen Verhältnis gestreckt.
  const stretch = innerW / contentWidth0;
  const historyWidth = historyWidth0 * stretch;
  const futureWidth = futureWidth0 * stretch;

  // Die y-Achse ist fest (Y_MAX_KMH) und hängt nicht mehr von den Daten ab.
  const yMax = Y_MAX_KMH;

  const x = (t: number) =>
    t <= now
      ? AXIS_PAD + ((t - minT) / (now - minT)) * historyWidth
      : AXIS_PAD + historyWidth + ((t - now) / (maxT - now)) * futureWidth;
  const chartTop = TIME_LABEL_H;
  const chartBottom = TIME_LABEL_H + CHART_H;
  // Werte über der festen Obergrenze werden gekappt: die Kurve läuft dann
  // am oberen Rand entlang, statt aus dem Diagramm heraus in die Uhrzeiten-
  // Zeile zu ragen. So bleibt sichtbar, DASS es dort sehr windig war; der
  // genaue Wert steht in den Zahlen-Zeilen unter den Pfeilen.
  const y = (v: number) => chartBottom - (Math.min(v, yMax) / yMax) * CHART_H;
  const arrowCy = chartBottom + ARROW_GAP + ARROW_ROW_H / 2;
  const arrowRowBottom = chartBottom + ARROW_GAP + ARROW_ROW_H;
  // Obere Kante der beiden Messwert-Reihen (Rechtecke): oben Mittelwind,
  // darunter Böe. Die Zahl sitzt jeweils mittig im Rechteck.
  const speedBoxY = arrowRowBottom + VALUES_GAP;
  const gustBoxY = speedBoxY + MEAS_BOX_H + MEAS_BOX_GAP;
  const measValuesBottom = gustBoxY + MEAS_BOX_H;
  // Uhrzeiten unter dem Messwert-Block noch einmal wiederholen, damit man die
  // Zahlenreihen ohne Blick nach ganz oben zeitlich einordnen kann.
  const measTimeLabelY = measValuesBottom + MEAS_TIME_GAP + 11;
  const measBlockBottom = measValuesBottom + MEAS_TIME_GAP + MEAS_TIME_ROW_H;

  // Prognose-Block (AROME gelb neben ICON-CH1 rot), direkt unter dem
  // Messwert-Block: zwei Zahlenzeilen (Mittelwind, Böe) je Modell, mit dem
  // Richtungspfeil außen daneben statt in einer eigenen Reihe darüber — der
  // Pfeil steht auf Höhe der Quadrat-Mitte. Auch die Prognosezahlen sitzen in
  // Quadraten mit der Farbe ihres Werts.
  const forecastSpeedBoxY = measBlockBottom + FORECAST_ROW_GAP;
  const forecastGustBoxY = forecastSpeedBoxY + MEAS_BOX_H + MEAS_BOX_GAP;
  const forecastArrowCy = forecastSpeedBoxY + MEAS_VALUES_ROW_H / 2;

  // --- Farbverlauf aus der Windskala (bis yMax gekappt) ---
  // Ein <linearGradient>-Stop pro Stützpunkt aus WIND_COLOR_SCALE, statt
  // getrennter Farbbänder — dieselben Stützpunkte, aber dazwischen wird
  // gemischt statt hart geschnitten. offset 0 = 0 km/h (unten im Diagramm),
  // offset 1 = yMax (oben).
  const gradientStops: { offset: number; color: string; opacity: number }[] = [];
  for (const stop of WIND_COLOR_SCALE) {
    if (stop.at > yMax) break;
    gradientStops.push({
      offset: stop.at / yMax,
      color: stop.color,
      // Standard-Deckkraft 0.55; der oberste Stützpunkt "zu stark" (Schwarz)
      // bekommt über bandOpacity einen kleineren Wert, sonst verschwindet
      // die schwarze Messkurve im fast schwarzen Bandbereich.
      opacity: stop.bandOpacity ?? 0.55,
    });
  }
  if (gradientStops.length === 0 || gradientStops[gradientStops.length - 1].offset < 1) {
    const last = WIND_COLOR_SCALE[WIND_COLOR_SCALE.length - 1];
    gradientStops.push({ offset: 1, color: last.color, opacity: last.bandOpacity ?? 0.55 });
  }

  // --- Stunden-Raster ---
  const hourTicks: Date[] = [];
  {
    const first = new Date(minT);
    first.setMinutes(0, 0, 0);
    if (first.getTime() < minT) first.setHours(first.getHours() + 1);
    for (let d = first; d.getTime() <= maxT; d = new Date(d.getTime() + 3_600_000)) {
      hourTicks.push(d);
    }
  }
  // Kleinster Wert der beiden Abschnitte, damit auch die enger gepackte
  // Prognose-Reserve keine überlappenden Beschriftungen bekommt.
  const pxPerHour = Math.min(HISTORY_PX_PER_HOUR, FUTURE_PX_PER_HOUR) * stretch;
  // Uhrzeiten nur so dicht beschriften, dass sie sich nicht überlappen.
  const labelEveryHours = pxPerHour >= 44 ? 1 : pxPerHour >= 22 ? 2 : 4;

  // --- "Stündliche" Messpunkte bestimmen ---
  // Die ICON-CH1-Prognose (oben, rot) liefert stündliche Werte. Damit man sie
  // gut mit den Messwerten vergleichen kann, heben wir unten die "stündlichen"
  // Messwerte hervor: je voller Stunde den zeitlich nächstgelegenen Messpunkt
  // (höchstens 30 min von der vollen Stunde entfernt). Diese Punkte werden
  // immer angezeigt und ihre Werte fett dargestellt.
  const hourlyPointIndices = new Set<number>();
  {
    const bestByHour = new Map<number, { idx: number; dist: number }>();
    points.forEach((p, idx) => {
      if (p.speed === null && p.gust === null) return;
      const hourStart = new Date(p.t);
      hourStart.setMinutes(0, 0, 0);
      const lower = hourStart.getTime();
      const upper = lower + 3_600_000;
      // Auf die näher gelegene volle Stunde runden.
      const hourKey = p.t - lower <= upper - p.t ? lower : upper;
      const dist = Math.abs(p.t - hourKey);
      const cur = bestByHour.get(hourKey);
      if (!cur || dist < cur.dist) bestByHour.set(hourKey, { idx, dist });
    });
    for (const { idx, dist } of bestByHour.values()) {
      if (dist <= 30 * 60 * 1000) hourlyPointIndices.add(idx);
    }
  }

  // --- Pfeile + Werte ggf. ausdünnen, damit sie sich nicht überlappen ---
  // Die Achse ist fest so breit, dass 6 Messungen/Stunde (alle 10 min) passen.
  // Bei genau dieser Dichte wird nichts ausgedünnt; nur wenn eine Station noch
  // dichter misst, dünnt der Mindestabstand (MIN_LABEL_SPACING) auf ~10 min aus.
  // Auswahl: zuerst die stündlichen Punkte (Pflicht, damit der Vergleich mit
  // der Prognose immer sichtbar ist), danach weitere Punkte als Lückenfüller —
  // aber nur, solange sie den Mindestabstand zu allen bereits gewählten Punkten
  // einhalten. Die stündlichen Punkte liegen mindestens eine Stunde (also klar
  // mehr als MIN_LABEL_SPACING) auseinander und passen daher immer alle rein.
  const arrowIndices: number[] = [];
  const selectedX: number[] = [];
  const tryAdd = (i: number) => {
    const px = x(points[i].t);
    if (selectedX.some((sx) => Math.abs(px - sx) < MIN_LABEL_SPACING)) return;
    selectedX.push(px);
    arrowIndices.push(i);
  };
  for (let i = points.length - 1; i >= 0; i--) {
    if (hourlyPointIndices.has(i)) tryAdd(i);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    if (!hourlyPointIndices.has(i)) tryAdd(i);
  }

  // Gemeinsame Ausdünnung für den Prognose-Vergleichsblock (CH1 links rot,
  // AROME rechts gelb): Vereinigung aller Zeitpunkte aus beiden Prognosen
  // (ein Modell kann für einzelne Stunden oder ganz fehlen), damit an jeder
  // gezeigten Stunde zumindest ein Wert erscheint. Der Platzbedarf ist größer
  // als bei einer einzelnen Spalte, da rot+gelb nebeneinander stehen.
  const forecastByT = new Map(forecastPoints.map((p) => [p.t, p]));
  const forecastAromeByT = new Map(forecastAromePoints.map((p) => [p.t, p]));
  const combinedForecastTimes = Array.from(
    new Set([...forecastPoints.map((p) => p.t), ...forecastAromePoints.map((p) => p.t)]),
  ).sort((a, b) => a - b);
  const combinedPxPerPoint =
    combinedForecastTimes.length > 1
      ? (x(combinedForecastTimes[combinedForecastTimes.length - 1]) -
          x(combinedForecastTimes[0])) /
        (combinedForecastTimes.length - 1)
      : historyWidth;
  // Platzbedarf einer Prognose-Spalte: von der äußeren Kante des linken
  // CH1-Pfeils bis zur äußeren Kante des rechten AROME-Pfeils (2× AXIS_PAD,
  // das genau für diesen Zweck bemessen ist).
  const combinedForecastStep = Math.max(
    1,
    Math.ceil(Math.max(2 * AXIS_PAD, MIN_LABEL_SPACING) / combinedPxPerPoint),
  );
  const combinedForecastTimeSelection: number[] = [];
  for (let i = combinedForecastTimes.length - 1; i >= 0; i -= combinedForecastStep) {
    combinedForecastTimeSelection.push(combinedForecastTimes[i]);
  }

  // Beschriftung der km/h-Achse: NICHT in runden 10er-Schritten, sondern
  // exakt an den Stützpunkten der Windskala (0 / 7 / 15 / 20 / 25 / 30 / 35,
  // aus WIND_COLOR_SCALE.label), damit man Verlauf und Zahl direkt
  // zusammenlesen kann. Sie folgen der Skala automatisch, falls sie jemals
  // bearbeitet wird. Ganz oben steht zusätzlich die feste Obergrenze der
  // Achse, bei der die Kurve gekappt wird.
  const yTicks: { at: number; label: string }[] = [];
  for (const stop of WIND_COLOR_SCALE) {
    if (stop.at > yMax) break;
    yTicks.push({ at: stop.at, label: stop.label });
  }
  if (yTicks.length === 0 || yTicks[yTicks.length - 1].at !== yMax) {
    yTicks.push({ at: yMax, label: String(yMax) });
  }

  const speedPath = buildLinePath(points, (p) => p.speed, x, y);
  const gustPath = buildLinePath(points, (p) => p.gust, x, y);
  const forecastSpeedPath = buildLinePath(forecastPoints, (p) => p.speed, x, y);
  const forecastGustPath = buildLinePath(forecastPoints, (p) => p.gust, x, y);
  // AROME-Bodenwind (gelb, durchgezogen) — gleiche Kurven wie ICON-CH1
  // (Mittelwind und Böen). Fehlt AROME an dieser Station, sind die Pfade
  // leer und es wird nichts gezeichnet.
  const forecastAromeSpeedPath = buildLinePath(forecastAromePoints, (p) => p.speed, x, y);
  const forecastAromeGustPath = buildLinePath(forecastAromePoints, (p) => p.gust, x, y);
  // Fläche zwischen den beiden Messkurven (Böe oben, Mittelwind unten)
  const measurementBandPath = buildBandPath(points, x, y);
  // Grundstärke der Kurven; die jeweils obere Kurve (Böen) wird rund 15 %
  // dicker gezeichnet, damit sie sich von der Mittelwind-Kurve abhebt.
  const LINE_WIDTH = 1.8;
  const GUST_LINE_WIDTH = LINE_WIDTH * 1.15;

  return (
    <section
      aria-label={`Windverlauf ${station.stationName}`}
      className="fixed inset-x-0 bottom-0 z-[1100] border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(0,0,0,0.5)] dark:border-zinc-700 dark:bg-zinc-900"
    >
      <header className="flex items-center gap-3 px-3 pt-2 pb-1">
        <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {station.stationName}
          {station.altitude !== null && (
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              {" "}
              ({station.altitude} m)
            </span>
          )}
          <span className="font-normal text-zinc-500 dark:text-zinc-400">
            {" "}
            · Stand: {formatTimestamp(station.timestamp)}
          </span>
        </h2>
        <span className="hidden text-xs text-zinc-500 sm:inline dark:text-zinc-400">
          letzte 12 Stunden{" "}
          <span className="text-zinc-400 dark:text-zinc-500">
            — <span className="text-zinc-700 dark:text-zinc-200">weiss</span>:
            Messung ·{" "}
            <span className="text-red-600 dark:text-red-500">rot</span>: Prognose
            (ICON-CH1) ·{" "}
            <span style={{ color: AROME_COLOR }}>gelb</span>: Prognose (AROME)
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Verlauf schließen"
          className="ml-auto shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 3 L13 13 M13 3 L3 13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <div className="flex px-1 pb-4">
        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-x-auto"
          style={{ height: SVG_H }}
        >
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Verlauf wird geladen…
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : !hasData ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Keine Daten verfügbar
            </div>
          ) : (
            <svg
              width={svgWidth}
              height={SVG_H}
              viewBox={`0 0 ${svgWidth} ${SVG_H}`}
              role="img"
              aria-label="Windverlauf: Mittelwind und Böen der letzten 12 Stunden"
            >
              {/* Farbverlauf der Windstärke-Skala (gleiche Stützpunkte wie
                  die Kartenpfeile, siehe WIND_COLOR_SCALE), leicht
                  transparent, damit die Kurven gut lesbar bleiben */}
              <defs>
                <linearGradient
                  id={gradientId}
                  gradientUnits="userSpaceOnUse"
                  x1={0}
                  y1={chartBottom}
                  x2={0}
                  y2={chartTop}
                >
                  {gradientStops.map((stop) => (
                    <stop
                      key={stop.offset}
                      offset={stop.offset}
                      stopColor={stop.color}
                      stopOpacity={stop.opacity}
                    />
                  ))}
                </linearGradient>
              </defs>
              <rect
                x={PAD_X}
                y={chartTop}
                width={bandWidth}
                height={chartBottom - chartTop}
                fill={`url(#${gradientId})`}
              />

              {/* Stunden-Raster + Uhrzeiten */}
              {hourTicks.map((d) => {
                const tx = x(d.getTime());
                const isMidnight = d.getHours() === 0;
                const showLabel = d.getHours() % labelEveryHours === 0;
                return (
                  <g key={d.getTime()}>
                    <line
                      x1={tx}
                      y1={chartTop}
                      x2={tx}
                      y2={chartBottom}
                      className={
                        isMidnight
                          ? "stroke-zinc-500/70 dark:stroke-zinc-400/70"
                          : "stroke-zinc-400/40 dark:stroke-zinc-500/40"
                      }
                      strokeWidth={isMidnight ? 1.5 : 1}
                    />
                    {showLabel && (
                      <text
                        x={tx}
                        y={TIME_LABEL_H - 6}
                        textAnchor="middle"
                        className="fill-zinc-500 text-[11px] tabular-nums dark:fill-zinc-400"
                      >
                        {formatHourLabel(d)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Waagrechte Schwellenlinien (siehe THRESHOLD_LINES_KMH):
                  gestrichelt und halbtransparent, damit sie die Kurven nicht
                  überdecken. Sie liegen über dem Farbverlauf, aber unter den
                  Mess- und Prognosekurven. Die zugehörige Zahl steht bereits
                  links an der km/h-Achse, deshalb hier ohne eigene Beschriftung. */}
              {THRESHOLD_LINES_KMH.filter((v) => v <= yMax).map((v) => (
                <line
                  key={`threshold-${v}`}
                  x1={PAD_X}
                  y1={y(v)}
                  x2={PAD_X + bandWidth}
                  y2={y(v)}
                  className="stroke-zinc-900/55 dark:stroke-zinc-100/55"
                  strokeWidth={1}
                  strokeDasharray="6 4"
                />
              ))}

              {/* "Jetzt"-Markierung: senkrechte Linie an der aktuellen Uhrzeit,
                  rechts davon die 4h-Prognose-Reserve */}
              <line
                x1={x(now)}
                y1={chartTop}
                x2={x(now)}
                y2={chartBottom}
                className="stroke-zinc-900/70 dark:stroke-zinc-100/70"
                strokeWidth={1.6}
                strokeDasharray="3 3"
              />
              <text
                x={x(now)}
                y={chartTop + 11}
                textAnchor="middle"
                className="fill-zinc-700 text-[10px] font-semibold dark:fill-zinc-200"
              >
                jetzt
              </text>

              {/* Messkurven: dazwischen eine weiße Fläche (50 % Deckkraft),
                  die obere Kurve (Böen) etwas dicker als die untere
                  (Mittelwind). */}
              <path
                d={measurementBandPath}
                stroke="none"
                className="fill-zinc-900/50 dark:fill-zinc-100/50"
              />
              <path
                d={gustPath}
                fill="none"
                strokeWidth={GUST_LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-zinc-900 dark:stroke-zinc-100"
              />
              <path
                d={speedPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-zinc-900 dark:stroke-zinc-100"
              />

              {/* Messpunkte als kleine Punkte — dadurch bleiben auch einzelne
                  Werte sichtbar, wenn wegen einer größeren Messlücke keine
                  Linie zum Nachbarpunkt gezogen wird */}
              {points.map((p) => (
                <g key={`dot-${p.t}`}>
                  {p.gust !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.gust)}
                      r={2}
                      className="fill-zinc-900 dark:fill-zinc-100"
                    />
                  )}
                  {p.speed !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.speed)}
                      r={1.7}
                      className="fill-zinc-900 dark:fill-zinc-100"
                    />
                  )}
                </g>
              ))}

              {/* Prognose (ICON-CH1) in Rot, NACH den Messwert-Kurven
                  gezeichnet: im Überlappungsbereich liegen die Prognosen so
                  optisch oben (Wunsch des Projektbesitzers). Die obere Kurve
                  (Böen) ist etwas dicker, keine Füllfläche dazwischen. */}
              <path
                d={forecastGustPath}
                fill="none"
                strokeWidth={GUST_LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-red-600 dark:stroke-red-500"
              />
              <path
                d={forecastSpeedPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-red-600 dark:stroke-red-500"
              />

              {/* Prognose-Punkte je Zeitpunkt (analog zu den schwarzen
                  Messpunkten) */}
              {forecastPoints.map((p) => (
                <g key={`fdot-${p.t}`}>
                  {p.gust !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.gust)}
                      r={2}
                      className="fill-red-600 dark:fill-red-500"
                    />
                  )}
                  {p.speed !== null && (
                    <circle
                      cx={x(p.t)}
                      cy={y(p.speed)}
                      r={1.7}
                      className="fill-red-600 dark:fill-red-500"
                    />
                  )}
                </g>
              ))}

              {/* Prognose (AROME) in Gelb, durchgezogen — gleiche Darstellung
                  wie die rote ICON-CH1-Prognose (Böen + Mittelwind). Ohne
                  AROME-Daten sind die Pfade leer, es fehlt dann einfach die
                  gelbe Linie. */}
              <path
                d={forecastAromeGustPath}
                fill="none"
                strokeWidth={GUST_LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                stroke={AROME_COLOR}
              />
              <path
                d={forecastAromeSpeedPath}
                fill="none"
                strokeWidth={LINE_WIDTH}
                strokeLinejoin="round"
                strokeLinecap="round"
                stroke={AROME_COLOR}
              />
              {forecastAromePoints.map((p) => (
                <g key={`aromedot-${p.t}`}>
                  {p.gust !== null && (
                    <circle cx={x(p.t)} cy={y(p.gust)} r={2} fill={AROME_COLOR} />
                  )}
                  {p.speed !== null && (
                    <circle cx={x(p.t)} cy={y(p.speed)} r={1.7} fill={AROME_COLOR} />
                  )}
                </g>
              ))}

              {/* Windrichtungs-Pfeile: gleiche Form, Drehung (auf 8
                  Himmelsrichtungen eingerastete Richtung + 180°, Pfeil zeigt
                  wohin der Wind weht) und Farben wie auf der Karte (Füllung =
                  Mittelwind, Rand = Böe) */}
              {arrowIndices.map((i) => {
                const p = points[i];
                if (p.direction === null) return null;
                const rotation = (snapDirectionTo8(p.direction) + 180) % 360;
                return (
                  <g
                    key={p.t}
                    transform={`translate(${x(p.t).toFixed(1)} ${arrowCy}) rotate(${rotation.toFixed(0)}) scale(${(ARROW_SIZE / 40).toFixed(3)})`}
                  >
                    <title>
                      {`${formatTime(p.tActual ?? p.t)} Uhr — Wind ${p.speed ?? "–"} km/h, Böen ${p.gust ?? "–"} km/h, Richtung ${Math.round(p.direction)}°`}
                    </title>
                    <path
                      d="M20 2 L34 34 L20 26 L6 34 Z"
                      transform="translate(-20 -20)"
                      fill={getWindColor(p.speed)}
                      stroke={getWindColor(p.gust)}
                      strokeWidth={3}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </g>
                );
              })}

              {/* Messwerte unter jedem Pfeil: oben Mittelwind, darunter Böe,
                  jede Zahl in einem Quadrat, das nach der Windskala des
                  jeweiligen Werts eingefärbt ist (gleiche Farben wie die
                  Farbbänder und die Kartenpfeile). Gleiche Auswahl an Punkten
                  wie die Pfeile, damit nichts überlappt. */}
              {arrowIndices.map((i) => {
                const p = points[i];
                if (p.direction === null) return null;
                const tx = x(p.t);
                // Stündliche Messwerte fett, damit sie sich zum Vergleich mit
                // der (ebenfalls stündlichen) Prognose von den Zwischenwerten
                // abheben.
                const isHourly = hourlyPointIndices.has(i);
                return (
                  <g key={`values-${p.t}`}>
                    <ValueBox cx={tx} boxY={speedBoxY} value={p.speed} bold={isHourly} />
                    <ValueBox cx={tx} boxY={gustBoxY} value={p.gust} bold={isHourly} />
                  </g>
                );
              })}

              {/* Uhrzeiten unter dem Messwert-Block noch einmal (gleiche
                  Stunden-Auswahl wie die Zeitachse oben) */}
              {hourTicks.map((d) =>
                d.getHours() % labelEveryHours === 0 ? (
                  <text
                    key={`meas-time-${d.getTime()}`}
                    x={x(d.getTime()).toFixed(1)}
                    y={measTimeLabelY}
                    textAnchor="middle"
                    className="fill-zinc-500 text-[11px] tabular-nums dark:fill-zinc-400"
                  >
                    {formatHourLabel(d)}
                  </text>
                ) : null,
              )}

              {/* Prognose-Vergleichsblock UNTER dem Messwert-Block: für jede
                  Stunde links das rote ICON-CH1-Ergebnis, rechts direkt
                  daneben das gelbe AROME-Ergebnis — je Mittelwind- und
                  Böen-Zahl übereinander, mit dem Richtungspfeil außen neben
                  dem eigenen Quadrat-Paar (CH1-Pfeil links vom CH1-Paar,
                  AROME-Pfeil rechts vom AROME-Paar). Fehlt eines der beiden
                  Modelle für eine Stunde, erscheint nur die andere Seite. */}
              {combinedForecastTimeSelection.map((t) => {
                const chP = forecastByT.get(t);
                const aromeP = forecastAromeByT.get(t);
                const tx = x(t);
                return (
                  <g key={`fcarrow-${t}`}>
                    {chP && chP.direction !== null && (
                      <g
                        transform={`translate(${(tx - FORECAST_ARROW_CX_OFFSET).toFixed(1)} ${forecastArrowCy}) rotate(${((snapDirectionTo8(chP.direction) + 180) % 360).toFixed(0)}) scale(${(ARROW_SIZE / 40).toFixed(3)})`}
                      >
                        <title>
                          {`Prognose ICON-CH1 ${formatTime(t)} Uhr — Wind ${chP.speed ?? "–"} km/h, Böen ${chP.gust ?? "–"} km/h, Richtung ${Math.round(chP.direction)}°`}
                        </title>
                        <path
                          d="M20 2 L34 34 L20 26 L6 34 Z"
                          transform="translate(-20 -20)"
                          className="fill-red-600 dark:fill-red-500"
                        />
                      </g>
                    )}
                    {aromeP && aromeP.direction !== null && (
                      <g
                        transform={`translate(${(tx + FORECAST_ARROW_CX_OFFSET).toFixed(1)} ${forecastArrowCy}) rotate(${((snapDirectionTo8(aromeP.direction) + 180) % 360).toFixed(0)}) scale(${(ARROW_SIZE / 40).toFixed(3)})`}
                      >
                        <title>
                          {`Prognose AROME ${formatTime(t)} Uhr — Wind ${aromeP.speed ?? "–"} km/h, Böen ${aromeP.gust ?? "–"} km/h, Richtung ${Math.round(aromeP.direction)}°`}
                        </title>
                        <path
                          d="M20 2 L34 34 L20 26 L6 34 Z"
                          transform="translate(-20 -20)"
                          fill={AROME_COLOR}
                        />
                      </g>
                    )}
                  </g>
                );
              })}
              {combinedForecastTimeSelection.map((t) => {
                const chP = forecastByT.get(t);
                const aromeP = forecastAromeByT.get(t);
                const tx = x(t);
                return (
                  <g key={`fcvalues-${t}`}>
                    {chP && (
                      <>
                        <ValueBox
                          cx={tx - FORECAST_PAIR_HALF_GAP}
                          boxY={forecastSpeedBoxY}
                          value={chP.speed}
                          accent={CH1_COLOR}
                        />
                        <ValueBox
                          cx={tx - FORECAST_PAIR_HALF_GAP}
                          boxY={forecastGustBoxY}
                          value={chP.gust}
                          accent={CH1_COLOR}
                        />
                      </>
                    )}
                    {aromeP && (
                      <>
                        <ValueBox
                          cx={tx + FORECAST_PAIR_HALF_GAP}
                          boxY={forecastSpeedBoxY}
                          value={aromeP.speed}
                          accent={AROME_COLOR}
                        />
                        <ValueBox
                          cx={tx + FORECAST_PAIR_HALF_GAP}
                          boxY={forecastGustBoxY}
                          value={aromeP.gust}
                          accent={AROME_COLOR}
                        />
                      </>
                    )}
                  </g>
                );
              })}

            </svg>
          )}
        </div>

        {/* km/h-Achse rechts, außerhalb des Scrollbereichs, damit sie beim
            Scrollen sichtbar bleibt */}
        {!loading && !error && hasData && (
          <div
            className="relative w-10 shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400"
            style={{ height: SVG_H }}
          >
            {yTicks.map((tick) => (
              <span
                key={tick.at}
                className="absolute left-1.5 -translate-y-1/2 tabular-nums"
                style={{ top: y(tick.at) }}
              >
                {tick.label}
              </span>
            ))}
            <span className="absolute left-1.5" style={{ top: chartBottom + 8 }}>
              km/h
            </span>
          </div>
        )}
      </div>

      <p className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Quelle:{" "}
        <a
          href={SOURCE_INFO[station.source].url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {SOURCE_INFO[station.source].label}
        </a>
      </p>
    </section>
  );
}
