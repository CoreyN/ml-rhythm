import { useState, useCallback, useRef } from "react";
import type {
  SessionReport as Report,
  NoteEvent,
  MetronomeStats,
} from "../types/session";
import { deviationColor } from "../utils/timing";
import { saveSession } from "../utils/saveSession";
import { AudioPlayback } from "./AudioPlayback";
import { NotationDisplay } from "./NotationDisplay";
import { WaveformDisplay } from "./WaveformDisplay";

interface Props {
  report: Report;
  onNewSession: () => void;
  recordedAudio: Float32Array | null;
  sampleRate: number;
}

export function SessionReport({ report, onNewSession, recordedAudio, sampleRate }: Props) {
  const { stats, events } = report;
  const [playbackTime, setPlaybackTime] = useState(0);
  const [viewTab, setViewTab] = useState<"notation" | "waveform">("notation");
  const scrubFnRef = useRef<((t: number) => void) | null>(null);
  const handleTimeUpdate = useCallback((t: number) => setPlaybackTime(t), []);
  const handleScrubReady = useCallback((scrub: (t: number) => void) => {
    scrubFnRef.current = scrub;
  }, []);
  const handleWaveformSeek = useCallback((t: number) => {
    scrubFnRef.current?.(t);
  }, []);

  if (report.error) {
    return (
      <div className="report">
        <h2>Session Report</h2>
        <p className="status">{report.error}</p>
        <button className="start-btn" onClick={onNewSession}>
          New Session
        </button>
      </div>
    );
  }

  return (
    <div className="report">
      <h2>Session Report</h2>

      <div className="report-summary">
        <span>BPM: {report.bpm}</span>
        <span>Grid: {report.grid_resolution} notes</span>
        <span>Bars: {report.total_bars}</span>
        <span>Accuracy: {stats.accuracy_percent}%</span>
      </div>

      <div className="report-stats">
        <div>Notes played: {stats.total_notes}</div>
        <div>
          Mean deviation: {stats.mean_absolute_deviation_ms}ms
          {stats.mean_signed_deviation_ms > 2
            ? ` (tends ${stats.mean_signed_deviation_ms}ms late)`
            : stats.mean_signed_deviation_ms < -2
              ? ` (tends ${Math.abs(stats.mean_signed_deviation_ms)}ms early)`
              : ""}
        </div>
        <div>Std deviation: {stats.std_deviation_ms}ms</div>
        <div>Median: {stats.median_deviation_ms}ms</div>
        <div>
          Worst: {stats.worst_deviation_ms > 0 ? "+" : ""}
          {stats.worst_deviation_ms}ms at {stats.worst_deviation_position}
        </div>
      </div>

      {recordedAudio && (
        <AudioPlayback
          audioData={recordedAudio}
          sampleRate={sampleRate}
          onTimeUpdate={handleTimeUpdate}
          onScrubReady={handleScrubReady}
        />
      )}

      {report.bpm && (
        <>
          <div className="view-tabs">
            <button
              className={`view-tab${viewTab === "notation" ? " active" : ""}`}
              onClick={() => setViewTab("notation")}
            >
              Notation
            </button>
            <button
              className={`view-tab${viewTab === "waveform" ? " active" : ""}`}
              onClick={() => setViewTab("waveform")}
            >
              Waveform
            </button>
          </div>

          {viewTab === "notation" ? (
            <NotationDisplay
              events={events}
              bpm={report.bpm}
              gridResolution={report.grid_resolution}
              timingThreshold={30}
              currentTime={playbackTime}
            />
          ) : recordedAudio ? (
            <WaveformDisplay
              audioData={recordedAudio}
              sampleRate={sampleRate}
              events={events}
              clickTimes={report.click_times ?? []}
              currentTime={playbackTime}
              onSeek={handleWaveformSeek}
            />
          ) : null}
        </>
      )}

      {report.metronome_stats && !report.metronome_stats.error && (
        <MetronomeQuality stats={report.metronome_stats} />
      )}

      <details className="timeline-details">
        <summary>Note Timeline</summary>
        <div className="note-timeline">
          <div className="notes">
            {events.map((event: NoteEvent, i: number) => (
              <div key={i} className="note-entry">
                <span className="note-position">
                  Bar {event.bar}, beat {event.beat_position}
                </span>
                <span
                  className="note-deviation"
                  style={{ color: deviationColor(event.deviation_ms) }}
                >
                  {event.deviation_ms > 0 ? "+" : ""}
                  {event.deviation_ms}ms
                </span>
              </div>
            ))}
          </div>
        </div>
      </details>

      <div className="report-actions">
        <button
          className="save-btn"
          onClick={() => saveSession(report, recordedAudio, sampleRate)}
        >
          Save Recording + Log
        </button>
        <button className="start-btn" onClick={onNewSession}>
          New Session
        </button>
      </div>
    </div>
  );
}

function metronomeGrade(jitter: number): { label: string; color: string } {
  if (jitter <= 1) return { label: "Excellent", color: "var(--green)" };
  if (jitter <= 3) return { label: "Good", color: "var(--green)" };
  if (jitter <= 6) return { label: "Fair", color: "var(--yellow)" };
  if (jitter <= 12) return { label: "Inconsistent", color: "var(--red)" };
  return { label: "Poor", color: "var(--red)" };
}

function MetronomeQuality({ stats }: { stats: MetronomeStats }) {
  const grade = metronomeGrade(stats.jitter_ms);
  const driftDir =
    stats.drift_ms_per_beat > 0.5
      ? "slowing down"
      : stats.drift_ms_per_beat < -0.5
        ? "speeding up"
        : "steady";

  return (
    <details className="metronome-details" open>
      <summary>Metronome Quality</summary>
      <div className="metronome-stats">
        <div className="metronome-grade" style={{ color: grade.color }}>
          {grade.label}
        </div>
        <div>Clicks detected: {stats.total_clicks}</div>
        <div>Jitter: {stats.jitter_ms}ms (std dev of intervals)</div>
        <div>Avg error per click: {stats.mean_error_ms}ms</div>
        <div>Worst click: {stats.max_error_ms}ms off</div>
        <div>
          Drift: {Math.abs(stats.drift_ms_per_beat)}ms/beat ({driftDir})
        </div>
        <div>Intervals within 2ms: {stats.tight_percent}%</div>
        <div>Intervals within 5ms: {stats.ok_percent}%</div>
      </div>
    </details>
  );
}
