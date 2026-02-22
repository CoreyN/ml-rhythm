import { useRef, useEffect, useCallback } from "react";
import type { NoteEvent } from "../types/session";

interface Props {
  audioData: Float32Array;
  sampleRate: number;
  events: NoteEvent[];
  clickTimes: number[];
  currentTime: number;
  onSeek: (time: number) => void;
}

export function WaveformDisplay({
  audioData,
  sampleRate,
  events,
  clickTimes,
  currentTime,
  onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawDataRef = useRef<{
    duration: number;
    mins: Float32Array;
    maxs: Float32Array;
    width: number;
    height: number;
  } | null>(null);

  const duration = audioData.length / sampleRate;
  const PX_PER_SECOND = 100;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const containerWidth = container.clientWidth;
    const width = Math.max(containerWidth, Math.ceil(duration * PX_PER_SECOND));
    canvas.style.width = `${width}px`;
    const height = container.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Downsample: one min/max pair per pixel column
    const samplesPerPixel = audioData.length / width;
    const mins = new Float32Array(width);
    const maxs = new Float32Array(width);

    for (let px = 0; px < width; px++) {
      const start = Math.floor(px * samplesPerPixel);
      const end = Math.min(Math.floor((px + 1) * samplesPerPixel), audioData.length);
      let min = 1;
      let max = -1;
      for (let i = start; i < end; i++) {
        const v = audioData[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      mins[px] = min;
      maxs[px] = max;
    }

    drawDataRef.current = { duration, mins, maxs, width, height };

    // Find peak amplitude for normalization
    let peak = 0;
    for (let px = 0; px < width; px++) {
      const absMax = Math.max(Math.abs(mins[px]), Math.abs(maxs[px]));
      if (absMax > peak) peak = absMax;
    }
    const scale = peak > 0 ? 1 / peak : 1;

    // Draw waveform envelope
    const midY = height / 2;
    ctx.fillStyle = "#64748b";
    for (let px = 0; px < width; px++) {
      const top = midY - maxs[px] * scale * midY;
      const bottom = midY - mins[px] * scale * midY;
      ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
    }

    // Draw metronome click lines — top half only (solid, bright)
    ctx.strokeStyle = "#818cf8";
    ctx.lineWidth = 2;
    for (const t of clickTimes) {
      const x = (t / duration) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, midY);
      ctx.stroke();
    }

    // Draw note onset lines — bottom half only (solid, color-coded by is_on_time)
    ctx.lineWidth = 1.5;
    for (const ev of events) {
      const x = (ev.time / duration) * width;
      ctx.strokeStyle = ev.is_on_time ? "#4ade80" : "#f87171";
      ctx.beginPath();
      ctx.moveTo(x, midY);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Draw playhead
    if (currentTime > 0) {
      const px = (currentTime / duration) * width;
      ctx.strokeStyle = "#00e5ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
  }, [audioData, sampleRate, duration, events, clickTimes, currentTime]);

  // Redraw on data/time changes
  useEffect(() => {
    draw();
  }, [draw]);

  // Auto-scroll to keep playhead visible
  useEffect(() => {
    const container = containerRef.current;
    if (!container || currentTime <= 0) return;
    const containerWidth = container.clientWidth;
    const totalWidth = Math.max(containerWidth, Math.ceil(duration * PX_PER_SECOND));
    const playheadX = (currentTime / duration) * totalWidth;
    const scrollLeft = container.scrollLeft;
    // Scroll when playhead is outside the visible region (with some margin)
    if (playheadX < scrollLeft + 40 || playheadX > scrollLeft + containerWidth - 40) {
      container.scrollLeft = playheadX - containerWidth / 3;
    }
  }, [currentTime, duration]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      draw();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = (x / rect.width) * duration;
      onSeek(Math.max(0, Math.min(duration, t)));
    },
    [duration, onSeek],
  );

  return (
    <div className="waveform-display" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="waveform-canvas"
        onClick={handleClick}
      />
    </div>
  );
}
