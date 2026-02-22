import { useEffect, useRef } from "react";
import { Renderer, Stave, StaveNote, Voice, Formatter, Annotation, type RenderContext } from "vexflow";
import type { NoteEvent, GridResolution } from "../types/session";
import { deviationHex } from "../utils/timing";

interface Props {
  events: NoteEvent[];
  bpm: number;
  gridResolution: GridResolution;
  timingThreshold: number;
  currentTime: number;
}

interface BarData {
  barNumber: number;
  positions: Map<number, NoteEvent>; // beat_position → event
}

function groupByBar(events: NoteEvent[]): BarData[] {
  const barMap = new Map<number, Map<number, NoteEvent>>();
  for (const ev of events) {
    if (!barMap.has(ev.bar)) {
      barMap.set(ev.bar, new Map());
    }
    barMap.get(ev.bar)!.set(ev.beat_position, ev);
  }

  const bars: BarData[] = [];
  for (const [barNumber, positions] of barMap) {
    bars.push({ barNumber, positions });
  }
  bars.sort((a, b) => a.barNumber - b.barNumber);
  return bars;
}

function getGridPositions(gridResolution: GridResolution): number[] {
  const subdivisions = gridResolution === "16th" ? 4 : 2;
  const positions: number[] = [];
  for (let beat = 0; beat < 4; beat++) {
    for (let sub = 0; sub < subdivisions; sub++) {
      positions.push(1 + beat + sub / subdivisions);
    }
  }
  return positions;
}

function getNoteDuration(gridResolution: GridResolution): string {
  return gridResolution === "16th" ? "16" : "8";
}

export function NotationDisplay({
  events,
  bpm,
  gridResolution,
  timingThreshold,
  currentTime,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";

    const bars = groupByBar(events);
    if (bars.length === 0) return;

    const gridPositions = getGridPositions(gridResolution);
    const noteDuration = getNoteDuration(gridResolution);
    // Layout: 2 bars per line
    const barsPerLine = 2;
    const staveWidth = 280;
    const lineHeight = 120;
    const leftMargin = 10;
    const topMargin = 10;

    const totalLines = Math.ceil(bars.length / barsPerLine);
    const totalWidth = leftMargin + staveWidth * barsPerLine + 20;
    const totalHeight = topMargin + lineHeight * totalLines + 20;

    const renderer = new Renderer(container, Renderer.Backends.SVG);
    renderer.resize(totalWidth, totalHeight);
    const context = renderer.getContext() as RenderContext;

    // Find current event for highlight
    let currentEventTime = -1;
    if (currentTime > 0) {
      let closest: NoteEvent | null = null;
      let closestDist = Infinity;
      for (const ev of events) {
        const dist = Math.abs(ev.time - currentTime);
        if (dist < closestDist) {
          closestDist = dist;
          closest = ev;
        }
      }
      if (closest && closestDist < 0.5) {
        currentEventTime = closest.time;
      }
    }

    bars.forEach((bar, barIdx) => {
      const lineIdx = Math.floor(barIdx / barsPerLine);
      const posInLine = barIdx % barsPerLine;
      const x = leftMargin + posInLine * staveWidth;
      const y = topMargin + lineIdx * lineHeight;

      const stave = new Stave(x, y, staveWidth);
      if (posInLine === 0) {
        stave.addClef("percussion");
      }
      stave.setContext(context).draw();

      const staveNotes: StaveNote[] = [];

      for (const beatPos of gridPositions) {
        const event = bar.positions.get(beatPos);
        if (event) {
          const note = new StaveNote({
            keys: ["b/4"],
            duration: noteDuration,
          });

          // Color-code by deviation
          const color = deviationHex(event.deviation_ms, timingThreshold);
          const isCurrentNote =
            currentEventTime > 0 &&
            Math.abs(event.time - currentEventTime) < 0.01;
          const displayColor = isCurrentNote ? "#00e5ff" : color;

          note.setStyle({ fillStyle: displayColor, strokeStyle: displayColor });

          // Show deviation in ms above note
          const sign = event.deviation_ms >= 0 ? "+" : "";
          const label = `${sign}${Math.round(event.deviation_ms)}`;
          const annotation = new Annotation(label)
            .setVerticalJustification(Annotation.VerticalJustify.TOP)
            .setFont("Arial", isCurrentNote ? 11 : 9, isCurrentNote ? "bold" : "normal");
          annotation.setStyle({ fillStyle: displayColor });
          note.addModifier(annotation);

          staveNotes.push(note);
        } else {
          // Rest
          const rest = new StaveNote({
            keys: ["b/4"],
            duration: `${noteDuration}r`,
          });
          rest.setStyle({ fillStyle: "#64748b", strokeStyle: "#64748b" });
          staveNotes.push(rest);
        }
      }

      try {
        const voice = new Voice({
          numBeats: 4,
          beatValue: 4,
        }).setStrict(false);

        voice.addTickables(staveNotes);
        new Formatter().joinVoices([voice]).format([voice], staveWidth - 50);
        voice.draw(context, stave);
      } catch {
        // VexFlow can throw on edge cases; skip bar
      }
    });
    // Add glow effect to highlighted note elements
    if (currentEventTime > 0) {
      const svg = container.querySelector("svg");
      if (svg) {
        const highlighted = new Set<Element>();
        svg
          .querySelectorAll('[fill="#00e5ff"], [stroke="#00e5ff"]')
          .forEach((el) => {
            const g = el.parentElement;
            if (g && g.tagName.toLowerCase() === "g" && !highlighted.has(g)) {
              highlighted.add(g);
              (g as unknown as SVGElement).style.filter =
                "drop-shadow(0 0 3px #00e5ff) drop-shadow(0 0 7px rgba(0, 229, 255, 0.6))";
            }
          });
      }
    }
  }, [events, bpm, gridResolution, timingThreshold, currentTime]);

  return (
    <div className="notation-display">
      <h3>Notation</h3>
      <div className="notation-scroll" ref={containerRef} />
    </div>
  );
}
