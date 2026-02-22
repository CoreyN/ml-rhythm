import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAudioCapture } from "../hooks/useAudioCapture";
import type { CalibrationProfile, SourceProfile, ServerMessage } from "../types/session";

type CalibrationStep = "metronome" | "guitar";

interface Props {
  onComplete: (profile: CalibrationProfile) => void;
  onCancel?: () => void;
}

export function CalibrationWizard({ onComplete, onCancel }: Props) {
  const [step, setStep] = useState<CalibrationStep>("metronome");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metronomeProfile, setMetronomeProfile] = useState<SourceProfile | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      if (msg.type === "calibration_result") {
        setAnalyzing(false);
        if (msg.error) {
          setError(msg.error as string);
          return;
        }
        const profile = msg.profile as SourceProfile;
        if (profile.onset_count === 0) {
          setError("No sounds detected. Make sure your mic can hear the audio.");
          return;
        }

        if (msg.step === "metronome") {
          setMetronomeProfile(profile);
          setStep("guitar");
          setError(null);
        } else if (msg.step === "guitar") {
          const fullProfile: CalibrationProfile = {
            metronome: metronomeProfile!,
            guitar: profile,
            calibrated_at: new Date().toISOString(),
          };
          onComplete(fullProfile);
        }
      }
    },
    [metronomeProfile, onComplete],
  );

  const { connect, sendControl, sendAudio } = useWebSocket(handleMessage);
  const { start: startAudio, stop: stopAudio } = useAudioCapture({ onAudioChunk: sendAudio });

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleRecord = useCallback(async () => {
    setError(null);
    setElapsed(0);

    const sampleRate = await startAudio();
    await connect();
    sendControl({ type: "calibrate", step, sample_rate: sampleRate });
    setRecording(true);

    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  }, [connect, sendControl, startAudio, step]);

  const handleStop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopAudio();
    sendControl({ type: "stop_calibration" });
    setRecording(false);
    setAnalyzing(true);
  }, [stopAudio, sendControl]);

  const stepNumber = step === "metronome" ? 1 : 2;

  return (
    <div className="calibration">
      <div className="calibration-header">
        <h2>Calibration</h2>
        <div className="calibration-steps">
          <span className={`step-indicator ${step === "metronome" ? "active" : metronomeProfile ? "done" : ""}`}>
            {metronomeProfile ? "\u2713" : "1"} Metronome
          </span>
          <span className="step-separator">&rarr;</span>
          <span className={`step-indicator ${step === "guitar" ? "active" : ""}`}>
            2 Guitar
          </span>
        </div>
      </div>

      {step === "metronome" && (
        <div className="calibration-step">
          <p className="calibration-instruction">
            Start your metronome, then press <strong>Record</strong> below.
            Let it click for at least 5 seconds with no other sounds.
          </p>
        </div>
      )}

      {step === "guitar" && (
        <div className="calibration-step">
          <p className="calibration-instruction">
            Play frets 5&ndash;6&ndash;7&ndash;8 from the low E to the high E string,
            one note at a time, at a steady pace. No metronome needed.
          </p>
          {metronomeProfile && (
            <p className="calibration-result-hint">
              Metronome: {metronomeProfile.onset_count} clicks captured
            </p>
          )}
        </div>
      )}

      {error && <div className="calibration-error">{error}</div>}

      <div className="calibration-controls">
        {recording ? (
          <>
            <div className="recording-status">
              <span className="recording-dot" />
              Recording... {elapsed}s
            </div>
            <button className="stop-btn" onClick={handleStop} disabled={elapsed < 2}>
              Stop
            </button>
          </>
        ) : analyzing ? (
          <div className="calibration-analyzing">Analyzing audio...</div>
        ) : (
          <>
            <button className="start-btn" onClick={handleRecord}>
              Record {step === "metronome" ? "Metronome" : "Guitar"}
            </button>
            {onCancel && stepNumber === 1 && !metronomeProfile && (
              <button className="cancel-btn" onClick={onCancel}>
                Cancel
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
