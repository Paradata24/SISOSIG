import { useEffect, useState } from "react";
import L from "leaflet";
import { CABLE_HEIGHT_CLASSES, type CablePayload } from "@/lib/kabel";

// --- Kabel (Luftfahrthindernisse, Okt. 2026, Wunsch des Projektbesitzers) ---
// Stromleitungen, Materialseilbahnen, Schussdrähte, Seilbahnen und Lifte in
// Südtirol aus der Hinderniskarte des Landes (Abruf und Quelle: /api/kabel).
// Nur im Flugmodus, nicht auf der normalen Karte. Der Server holt sie einmal
// am Tag beim Land; die Statuszeile oben links sagt, von wann sie sind. Das
// Handy merkt sich die letzte Fassung (CABLE_STORAGE_KEY), ohne Netz sind die
// Kabel also trotzdem da.

// Erst ab dieser Zoomstufe (= Übersichtstaste, OVERVIEW_ZOOM in
// FlightMode.tsx): Herausgezoomt wären die Täler nur noch ein Gewirr aus
// Leitungen, das die Windpfeile zudeckt. Bis Okt. 2026 stand hier die
// Flug-Zoomstufe (FLIGHT_ZOOM); als die von 11 auf 15 stieg, erschienen die
// Kabel ungewollt erst ab 15 statt wie festgelegt ab 11.
const CABLE_MIN_ZOOM = 11;
// Darstellung vom Projektbesitzer am Probebild gewählt (Okt. 2026): eine
// einheitliche magentarote Linie mit weißem Saum, alle Kabel gleich breit.
// Die Farbe kommt in der Windskala nicht vor; vom violetten Track
// (TRACK_COLOR) und vom blauen eigenen Standort unterscheidet sie sich
// deutlich. Eine erste Fassung (dunkle Linie, hohe Kabel dicker) wurde
// dafür ersetzt.
const CABLE_COLOR = "#c2255c";
const CABLE_WEIGHT = 2;
// Weißer Saum unter der Linie, damit sie sich von Straßen und Höhenlinien
// der Karte abhebt.
const CABLE_HALO_COLOR = "#ffffff";
const CABLE_HALO_WEIGHT = 4.5;
const CABLE_HALO_OPACITY = 0.9;
// Eigene Ebene über den Kartenkacheln (200) und unter Track und
// Standort-Kreis (overlayPane, 400) — die Windpfeile liegen ohnehin darüber.
const CABLE_PANE = "kabel";
const CABLE_PANE_Z = 390;

// Höhen-Schilder ("60–100 m") an Kabeln über 25 m über Grund (Klassen in
// src/lib/kabel.ts). Erst auf der höchsten Zoomstufe (Wunsch des
// Projektbesitzers, Okt. 2026 — Vorschauen mit Schildern ab Zoom 11/12/13 waren
// zu unruhig). Lange Kabel bekommen mehrere Schilder im festen
// Bildschirmabstand, wie Straßennamen auf einer Karte; ein fester Abstand in
// Metern ginge nicht (herausgezoomt lägen die Schilder übereinander).
const CABLE_LABEL_MIN_ZOOM = 15;
const CABLE_LABEL_SPACING_PX = 400;
// Ungefähre Maße eines Schilds (px) für das Ausdünnen: Überdecken sich zwei,
// bleibt das des höheren Kabels.
const CABLE_LABEL_CHAR_PX = 7;
const CABLE_LABEL_PAD_PX = 14;
const CABLE_LABEL_HEIGHT_PX = 18;
// Über den Kabel-Linien, unter Track/Standort und Windpfeilen.
const CABLE_LABEL_PANE = "kabelschild";
const CABLE_LABEL_PANE_Z = 395;
// Ohne "max" davor (Wunsch des Projektbesitzers, Okt. 2026), obwohl die
// Klasse die höchste Stelle des Kabels meint (siehe src/lib/kabel.ts).
const CABLE_LABEL_TEXT = new Map(CABLE_HEIGHT_CLASSES.map((c) => [c.code, c.label]));

// Kann der Server die Kabel einmal nicht aktualisieren (Landesserver gestört)
// oder ist kein Netz da, bleiben die zuletzt erfolgreich geladenen Kabel auf
// der Karte (Wunsch des Projektbesitzers). Dafür merkt sich das Handy die
// letzte erfolgreich geladene Fassung im Browser-Speicher (localStorage, wie
// der Track) — das gilt für die Web-App UND die Website im Browser. Das Feld
// "Kabel …" in der Statuszeile wird dann gelb und zeigt weiter das Datum dieser
// Fassung.
// v2: seit den Höhen-Schildern steht vorne in jeder Zeile die Höhenklasse
// (vorher nur 0/1) — eine gespeicherte v1-Fassung würde falsch beschriftet.
const CABLE_STORAGE_KEY = "sisosig-kabel-v2";
// Normal sind die Kabel höchstens einen Tag alt (der Server holt sie einmal am
// Tag, siehe /api/kabel). Älter = die tägliche Aktualisierung hat nicht
// geklappt → gelb. Etwas Luft über 24 h, damit es nicht am Stichtag flackert.
export const CABLE_OUTDATED_MS = 30 * 60 * 60 * 1000;
// Kommt vom Server eine alte Fassung, ist das meist nur der Zwischenspeicher,
// der gerade im Hintergrund frische Kabel holt (dauert ein paar Sekunden).
// Deshalb nach dieser Wartezeit einmal nachfragen, bevor gelb angezeigt wird.
const CABLE_RECHECK_DELAY_MS = 20_000;

type CableState = {
  /** Stand der Kabel auf der Karte (Abruf beim Land); null = keine Kabel. */
  stand: Date | null;
  /** Der letzte Versuch, frische Kabel zu holen, ist gescheitert. */
  updateFailed: boolean;
  /** Abruf läuft noch (dann noch nicht gelb anzeigen). */
  checking: boolean;
};

function loadStoredCables(): { text: string; data: CablePayload } | null {
  try {
    const text = window.localStorage.getItem(CABLE_STORAGE_KEY);
    if (!text) return null;
    const data = JSON.parse(text) as CablePayload;
    if (typeof data.stand !== "string" || !Array.isArray(data.kabel)) return null;
    return { text, data };
  } catch {
    // Privater Modus, gesperrter Speicher, kaputter Inhalt: wie nie geladen.
    return null;
  }
}

function storeCables(text: string) {
  try {
    window.localStorage.setItem(CABLE_STORAGE_KEY, text);
  } catch {
    // Speicher voll oder gesperrt: Die Kabel sind trotzdem auf der Karte, nur
    // beim nächsten Mal ohne Netz nicht.
  }
}

export function useCables(map: L.Map | null): CableState {
  const [state, setState] = useState<CableState>({
    stand: null,
    updateFailed: false,
    checking: true,
  });

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let recheckTimer: ReturnType<typeof setTimeout> | undefined;
    if (!map.getPane(CABLE_PANE)) {
      map.createPane(CABLE_PANE).style.zIndex = String(CABLE_PANE_Z);
    }
    if (!map.getPane(CABLE_LABEL_PANE)) {
      map.createPane(CABLE_LABEL_PANE).style.zIndex = String(CABLE_LABEL_PANE_Z);
    }
    // Alle Kabel in zwei Linien-Ebenen (Saum und Linie) statt je Kabel einer
    // eigenen — bei über 4000 Kabeln spart das viel Arbeit. Auf
    // einer Zeichenfläche (canvas) statt als einzelne SVG-Elemente aus
    // demselben Grund.
    const renderer = L.canvas({ pane: CABLE_PANE, padding: 0.5 });
    const group = L.layerGroup();
    // Stand der gerade gezeichneten Kabel (ms), null = noch keine.
    let shownStand: number | null = null;
    // Kabel mit Schild (über 25 m), das höchste zuerst — so gewinnt es beim
    // Ausdünnen.
    let labeled: { latLngs: L.LatLng[]; bounds: L.LatLngBounds; code: number; text: string }[] = [];
    const labelGroup = L.layerGroup().addTo(map);
    // Ein Icon je Schildtext (nur sechs verschiedene), nicht je Schild.
    const labelIcons = new Map<string, L.DivIcon>();
    const labelIcon = (text: string) => {
      let icon = labelIcons.get(text);
      if (!icon) {
        icon = L.divIcon({
          className: "kabel-schild",
          html: `<span>${text}</span>`,
          iconSize: [0, 0],
        });
        labelIcons.set(text, icon);
      }
      return icon;
    };

    // Schilder neu setzen — nach jedem Verschieben/Zoomen, nur ab
    // CABLE_LABEL_MIN_ZOOM und nur für Kabel im Kartenausschnitt (bei Zoom 15
    // sind das wenige). Die Stellen hängen nur am Kabel und an der Zoomstufe,
    // nicht am Ausschnitt: Beim Mitführen der Karte springen sie also nicht.
    const placeLabels = () => {
      labelGroup.clearLayers();
      if (map.getZoom() < CABLE_LABEL_MIN_ZOOM) return;
      const view = map.getBounds().pad(0.2);
      const placed: { x: number; y: number; w: number }[] = [];
      for (const cable of labeled) {
        if (!view.intersects(cable.bounds)) continue;
        const points = cable.latLngs.map((ll) => map.latLngToLayerPoint(ll));
        const segments: number[] = [];
        let total = 0;
        for (let i = 1; i < points.length; i++) {
          const d = points[i].distanceTo(points[i - 1]);
          segments.push(d);
          total += d;
        }
        const count = Math.max(1, Math.floor(total / CABLE_LABEL_SPACING_PX));
        const step = total / count;
        const width = cable.text.length * CABLE_LABEL_CHAR_PX + CABLE_LABEL_PAD_PX;
        for (let k = 0; k < count; k++) {
          // Stelle auf dem Kabel: jeweils in der Mitte eines Abschnitts.
          let rest = step * (k + 0.5);
          let i = 0;
          while (i < segments.length - 1 && rest > segments[i]) {
            rest -= segments[i];
            i++;
          }
          const a = points[i];
          const b = points[i + 1] ?? a;
          const t = segments[i] ? Math.min(1, rest / segments[i]) : 0;
          const point = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          const latLng = map.layerPointToLatLng(point);
          if (!view.contains(latLng)) continue;
          const overlaps = placed.some(
            (q) =>
              Math.abs(q.x - point.x) < (q.w + width) / 2 + 4 &&
              Math.abs(q.y - point.y) < CABLE_LABEL_HEIGHT_PX + 4,
          );
          if (overlaps) continue;
          placed.push({ x: point.x, y: point.y, w: width });
          L.marker(latLng, {
            icon: labelIcon(cable.text),
            pane: CABLE_LABEL_PANE,
            interactive: false,
            keyboard: false,
          }).addTo(labelGroup);
        }
      }
    };
    map.on("moveend", placeLabels);

    // Nur ab CABLE_MIN_ZOOM auf der Karte; darunter ganz weg (dann wird auch
    // nichts gezeichnet).
    const updateVisibility = () => {
      if (map.getZoom() >= CABLE_MIN_ZOOM) group.addTo(map);
      else group.remove();
    };
    map.on("zoomend", updateVisibility);

    const draw = (data: CablePayload) => {
      const lines: L.LatLng[][] = [];
      labeled = [];
      for (const row of data.kabel) {
        // row[0] ist die Höhenklasse (src/lib/kabel.ts), 0 = kein Schild.
        const line: L.LatLng[] = [];
        for (let i = 1; i + 1 < row.length; i += 2) line.push(L.latLng(row[i], row[i + 1]));
        lines.push(line);
        const text = CABLE_LABEL_TEXT.get(row[0]);
        if (text && line.length > 1) {
          labeled.push({ latLngs: line, bounds: L.latLngBounds(line), code: row[0], text });
        }
      }
      // Höchste Klasse zuerst (Ausdünnen, siehe CABLE_HEIGHT_CLASSES).
      labeled.sort((x, y) => y.code - x.code);
      group.clearLayers();
      const common = { renderer, interactive: false, lineCap: "round", lineJoin: "round" } as const;
      L.polyline(lines, { ...common, color: CABLE_HALO_COLOR, weight: CABLE_HALO_WEIGHT, opacity: CABLE_HALO_OPACITY }).addTo(group);
      L.polyline(lines, { ...common, color: CABLE_COLOR, weight: CABLE_WEIGHT, opacity: 1 }).addTo(group);
      shownStand = Date.parse(data.stand);
      updateVisibility();
      placeLabels();
    };

    // Zuerst sofort die gespeicherte Fassung zeigen (auch ohne Netz), dann
    // frisch nachladen. setState im nächsten Bild, wie beim Track.
    const stored = loadStoredCables();
    if (stored) draw(stored.data);
    const frame = requestAnimationFrame(() => {
      if (shownStand !== null) {
        setState({ stand: new Date(shownStand), updateFailed: false, checking: true });
      }
    });

    const load = async (isRecheck: boolean) => {
      let text: string;
      let data: CablePayload;
      try {
        const res = await fetch("/api/kabel");
        if (!res.ok) throw new Error(String(res.status));
        text = await res.text();
        data = JSON.parse(text) as CablePayload;
      } catch {
        // Keine frischen Kabel: Die bisherigen bleiben stehen, das Feld wird
        // gelb (bzw. "Keine Kabel", wenn es nie welche gab).
        if (cancelled) return;
        setState({
          stand: shownStand === null ? null : new Date(shownStand),
          updateFailed: true,
          checking: false,
        });
        return;
      }
      if (cancelled) return;
      const stand = Date.parse(data.stand);
      // Nur eine NEUERE Fassung ersetzt die gezeichnete (ohne Netz kann der
      // Hintergrund-Helfer der Web-App auch eine ältere liefern).
      if (shownStand === null || stand > shownStand) {
        draw(data);
        storeCables(text);
      }
      const shown = shownStand ?? stand;
      if (!isRecheck && Date.now() - shown > CABLE_OUTDATED_MS) {
        // Alte Fassung vom Server: einmal nachfragen (siehe
        // CABLE_RECHECK_DELAY_MS), erst dann gelb.
        setState({ stand: new Date(shown), updateFailed: false, checking: true });
        recheckTimer = setTimeout(() => void load(true), CABLE_RECHECK_DELAY_MS);
        return;
      }
      setState({ stand: new Date(shown), updateFailed: false, checking: false });
    };
    void load(false);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(recheckTimer);
      map.off("zoomend", updateVisibility);
      map.off("moveend", placeLabels);
      group.remove();
      labelGroup.remove();
      // Die Zeichenfläche hängt Leaflet selbst an die Karte; ohne das hier
      // bliebe bei jedem Beenden des Flugmodus eine leere zurück.
      renderer.remove();
    };
  }, [map]);

  return state;
}
