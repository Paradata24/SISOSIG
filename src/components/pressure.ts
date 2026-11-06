import { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import {
  FOEHN_PAIR,
  FOEHN_STALE_COLOR,
  foehnColor,
  formatPressureDiff,
  pairPressureSeries,
  pressureDiffAt,
  PRESSURE_STATIONS,
  type PressureDiffPoint,
  type PressurePayload,
} from "@/lib/pressure";

// Föhn-Anzeige auf der Karte der Hauptseite (Nov. 2026, Wunsch des
// Projektbesitzers): eine Linie vom Flughafen Innsbruck zum Flughafen Bozen in
// der Farbe der Druckdifferenz (Farbstufen in src/lib/pressure.ts), in der
// Mitte ein Schild mit der Differenz und einem Pfeil in die Richtung, in die
// sich der Druck ausgleicht (vom hohen zum tiefen Druck). Antippen von Linie
// oder Schild öffnet den Druck-Verlaufsbalken (PressurePanel).
// Steht der Zeitbalken auf einem früheren Zeitpunkt, zeigt die Linie die
// Differenz von damals — wie die Windpfeile.
// Ein-/ausschaltbar im Ebenen-Menü ("Föhn (Druck IBK–BZ)"), nur Hauptseite.

// Abruf-Takt: Die Flughäfen melden nur alle 30–60 min, der Sammler speichert
// alle 5 min. 10 min wie beim Zeitbalken genügen; beim Zurückkehren zur Seite
// wird sofort nachgeladen (wie bei den Windwerten).
const PRESSURE_POLL_MS = 10 * 60 * 1000;

// Eigene Ebene über den Kartenkacheln, unter den Windpfeilen (markerPane 600)
// und über den Kabeln (390/395) — die Linie läuft quer über das Wipptal.
const LINE_PANE = "foehnlinie";
const LINE_PANE_Z = 410;
// Das Schild liegt ÜBER den Windpfeilen, sonst verdecken die Stationen am
// Brenner die Zahl.
const LABEL_PANE = "foehnschild";
const LABEL_PANE_Z = 650;

// Dicke der Föhn-Linie in Pixeln (Nov. 2026 um etwa ein Drittel dünner
// gemacht, Wunsch des Projektbesitzers; vorher 5 und 8).
const LINE_WEIGHT = 3.5;
const OUTLINE_WEIGHT = 5.5;
const OUTLINE_COLOR = "#18181b";

/**
 * Daten von /api/pressure, solange `enabled`; data null = (noch) keine.
 * `failed` = der letzte Abruf ist gescheitert (der Druck-Verlaufsbalken zeigt
 * dann nicht endlos "wird geladen").
 */
export function usePressureData(enabled: boolean): {
  data: PressurePayload | null;
  failed: boolean;
} {
  const [data, setData] = useState<PressurePayload | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      fetch("/api/pressure")
        .then(async (res) => {
          if (!res.ok) throw new Error(`Status ${res.status}`);
          const payload = (await res.json()) as PressurePayload;
          if (cancelled) return;
          setData(payload);
          setFailed(false);
        })
        // Netzaussetzer: die bisherigen Werte bleiben stehen.
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const interval = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, PRESSURE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  return { data, failed };
}

/**
 * Differenz-Reihen Bozen − Innsbruck: `measured` = 10-Minuten-Werte der
 * Stationen (Hauptkurve), `metar` = Flugwetter-Meldungen (Vergleich),
 * `forecast` = ICON-CH1, `ecmwf` = ECMWF.
 */
export function usePressureSeries(data: PressurePayload | null): {
  measured: PressureDiffPoint[];
  metar: PressureDiffPoint[];
  forecast: PressureDiffPoint[];
  ecmwf: PressureDiffPoint[];
  /** Temperatur-Differenz Innsbruck − Bozen (°C); negativ = Innsbruck kälter. */
  tempDiff: PressureDiffPoint[];
  /** Dasselbe aus der ICON-CH1-Prognose (stündlich). */
  tempDiffForecast: PressureDiffPoint[];
  /** Gemessene Temperaturen je Seite (°C), aufsteigend. */
  tempNorth: Array<[number, number]>;
  tempSouth: Array<[number, number]>;
  /** ICON-CH1-Temperatur je Seite (°C). */
  tempNorthForecast: Array<[number, number]>;
  tempSouthForecast: Array<[number, number]>;
} {
  return useMemo(
    () => ({
      measured: data
        ? pairPressureSeries(data.stations[FOEHN_PAIR.north], data.stations[FOEHN_PAIR.south])
        : [],
      metar: data
        ? pairPressureSeries(data.metar[FOEHN_PAIR.north], data.metar[FOEHN_PAIR.south])
        : [],
      forecast: data
        ? pairPressureSeries(data.forecast[FOEHN_PAIR.north], data.forecast[FOEHN_PAIR.south])
        : [],
      // Intern ΔT = Innsbruck − Bozen. pairPressureSeries rechnet "zweites
      // minus erstes" — deshalb hier Bozen zuerst. Angezeigt wird seit Nov.
      // 2026 Bozen − Innsbruck (wie beim Druck): PressurePanel dreht das
      // Vorzeichen und die Farben. Ältere Antworten haben das Feld nicht.
      tempDiff: data?.temperature
        ? pairPressureSeries(data.temperature[FOEHN_PAIR.south], data.temperature[FOEHN_PAIR.north])
        : [],
      tempDiffForecast: data?.forecastTemperature
        ? pairPressureSeries(
            data.forecastTemperature[FOEHN_PAIR.south],
            data.forecastTemperature[FOEHN_PAIR.north],
          )
        : [],
      tempNorth: data?.temperature?.[FOEHN_PAIR.north] ?? [],
      tempSouth: data?.temperature?.[FOEHN_PAIR.south] ?? [],
      tempNorthForecast: data?.forecastTemperature?.[FOEHN_PAIR.north] ?? [],
      tempSouthForecast: data?.forecastTemperature?.[FOEHN_PAIR.south] ?? [],
      // Ältere Antworten (vor ECMWF) haben das Feld nicht.
      ecmwf: data?.ecmwf
        ? pairPressureSeries(data.ecmwf[FOEHN_PAIR.north], data.ecmwf[FOEHN_PAIR.south])
        : [],
    }),
    [data],
  );
}

// Pfeil, der nach oben zeigt; gedreht wird er per CSS.
const ARROW_SVG =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
  '<path d="M6 0 L11.5 7 H8 V12 H4 V7 H0.5 Z" fill="currentColor"/></svg>';

// Kompassrichtung (Grad, 0 = Nord) von a nach b — für den Pfeil im Schild.
function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
  const x =
    Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

function labelHtml(point: PressureDiffPoint | null): string {
  if (!point) {
    return (
      `<div class="foehn-schild" style="background:${FOEHN_STALE_COLOR};color:#18181b">` +
      `Föhn – hPa</div>`
    );
  }
  const { color, text } = foehnColor(point.diff);
  const north = PRESSURE_STATIONS[FOEHN_PAIR.north];
  const south = PRESSURE_STATIONS[FOEHN_PAIR.south];
  // Ausgleich vom hohen zum tiefen Druck: Süden höher → Pfeil nach Norden.
  const arrow =
    Math.abs(point.diff) >= 1
      ? `<span style="display:inline-flex;transform:rotate(${Math.round(
          point.diff > 0 ? bearingDeg(south, north) : bearingDeg(north, south),
        )}deg)">${ARROW_SVG}</span>`
      : "";
  return (
    `<div class="foehn-schild" style="background:${color};color:${text}">` +
    `${arrow}<span>${formatPressureDiff(point.diff)}</span></div>`
  );
}

/**
 * Zeichnet Linie und Schild, solange `enabled`. `time` = Zeitpunkt des
 * Zeitbalkens (null = aktuell). `onOpen` öffnet den Druck-Verlaufsbalken
 * (feste Referenz).
 */
export function usePressureLine(
  map: L.Map | null,
  enabled: boolean,
  measured: PressureDiffPoint[],
  metar: PressureDiffPoint[],
  time: number | null,
  onOpen: () => void,
): void {
  // Ebenen einmal anlegen, danach nur Farbe und Schild ändern.
  const [layers, setLayers] = useState<{
    outline: L.Polyline;
    line: L.Polyline;
    label: L.Marker;
  } | null>(null);

  useEffect(() => {
    if (!map || !enabled) return;
    for (const [name, z] of [
      [LINE_PANE, LINE_PANE_Z],
      [LABEL_PANE, LABEL_PANE_Z],
    ] as const) {
      if (!map.getPane(name)) map.createPane(name).style.zIndex = String(z);
    }
    const north = PRESSURE_STATIONS[FOEHN_PAIR.north];
    const south = PRESSURE_STATIONS[FOEHN_PAIR.south];
    const path: L.LatLngExpression[] = [
      [north.lat, north.lng],
      [south.lat, south.lng],
    ];
    const outline = L.polyline(path, {
      pane: LINE_PANE,
      color: OUTLINE_COLOR,
      weight: OUTLINE_WEIGHT,
      opacity: 0.85,
      lineCap: "round",
    });
    const line = L.polyline(path, {
      pane: LINE_PANE,
      color: FOEHN_STALE_COLOR,
      weight: LINE_WEIGHT,
      opacity: 1,
      lineCap: "round",
    });
    const label = L.marker([(north.lat + south.lat) / 2, (north.lng + south.lng) / 2], {
      pane: LABEL_PANE,
      icon: L.divIcon({ className: "foehn-marker", html: labelHtml(null), iconSize: [96, 24], iconAnchor: [48, 12] }),
      title: "Föhn: Druckdifferenz Bozen − Innsbruck (antippen für den Verlauf)",
      keyboard: true,
    });
    for (const layer of [outline, line, label]) {
      layer.on("click", onOpen);
      layer.addTo(map);
    }
    // Bewusst im Effekt: Die Ebenen gehören zur Karte und werden beim
    // Ausschalten wieder entfernt.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLayers({ outline, line, label });
    return () => {
      for (const layer of [outline, line, label]) layer.remove();
      setLayers(null);
    };
  }, [map, enabled, onOpen]);

  // Farbe und Zahl nach dem gewählten Zeitpunkt.
  useEffect(() => {
    if (!layers) return;
    // Die 10-Minuten-Werte; fehlen sie (Station ausgefallen), die METAR.
    const at = time ?? Date.now();
    const point = pressureDiffAt(measured, at) ?? pressureDiffAt(metar, at);
    layers.line.setStyle({ color: point ? foehnColor(point.diff).color : FOEHN_STALE_COLOR });
    layers.label.setIcon(
      L.divIcon({ className: "foehn-marker", html: labelHtml(point), iconSize: [96, 24], iconAnchor: [48, 12] }),
    );
  }, [layers, measured, metar, time]);
}
