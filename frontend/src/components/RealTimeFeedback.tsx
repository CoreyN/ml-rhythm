import type { NoteEvent } from "../types/session";

interface Props {
  events: NoteEvent[];
  bpm: number | null;
  gridEstablished: boolean;
  clickCount: number;
  totalOnsets: number;
}

export function RealTimeFeedback({ events, bpm, gridEstablished, clickCount, totalOnsets }: Props) {
  const recent = events.slice(-16);
  const latest = events[events.length - 1];

  return (
    <div className="feedback">
      {!gridEstablished ? (
        <div className="status">
          Listening for metronome...
          {totalOnsets > 0 && (
            <div className="detection-info">
              {totalOnsets} sound{totalOnsets !== 1 ? "s" : ""} heard
              {clickCount > 0 && `, ${clickCount}/4 periodic`}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="bpm-display">Detected BPM: {bpm}</div>
          <div className="grid-display">
            {recent.map((ev, i) => (
              <span
                key={i}
                className={`grid-dot ${ev.is_on_time ? "on-time" : "off-time"}`}
                title={`${ev.deviation_ms > 0 ? "+" : ""}${ev.deviation_ms}ms`}
              >
                {"\u25CF"}
              </span>
            ))}
          </div>
          {latest && (
            <div
              className={`current-deviation ${latest.is_on_time ? "good" : "bad"}`}
            >
              {latest.deviation_ms > 0 ? "+" : ""}
              {latest.deviation_ms}ms
              {latest.is_on_time ? " \u2713" : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}
