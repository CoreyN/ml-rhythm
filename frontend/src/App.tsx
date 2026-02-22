import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAudioCapture } from "./hooks/useAudioCapture";
import { SessionControls } from "./components/SessionControls";
import { RealTimeFeedback } from "./components/RealTimeFeedback";
import { SessionReport } from "./components/SessionReport";
import { CalibrationWizard } from "./components/CalibrationWizard";
import type {
  AppState,
  GridResolution,
  NoteEvent,
  SessionReport as Report,
  ServerMessage,
  CalibrationProfile,
} from "./types/session";

const CALIBRATION_KEY = "calibration_profile";

function loadCalibration(): CalibrationProfile | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CalibrationProfile;
  } catch {
    return null;
  }
}

function saveCalibration(profile: CalibrationProfile): void {
  localStorage.setItem(CALIBRATION_KEY, JSON.stringify(profile));
}

export default function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [events, setEvents] = useState<NoteEvent[]>([]);
  const [bpm, setBpm] = useState<number | null>(null);
  const [gridEstablished, setGridEstablished] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const [totalOnsets, setTotalOnsets] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [recordedAudio, setRecordedAudio] = useState<Float32Array | null>(null);
  const [audioSampleRate, setAudioSampleRate] = useState(44100);
  const [calibration, setCalibration] = useState<CalibrationProfile | null>(loadCalibration);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "started":
        setAppState("active");
        break;
      case "click_detected":
        setClickCount(msg.click_count as number);
        setTotalOnsets(msg.total_onsets as number);
        break;
      case "grid_established":
        setGridEstablished(true);
        setBpm(msg.bpm as number);
        break;
      case "pre_grid_note":
        break;
      case "note_event":
        setEvents((prev) => [
          ...prev,
          {
            time: msg.time as number,
            nearest_grid_time: msg.nearest_grid_time as number,
            deviation_ms: msg.deviation_ms as number,
            event_type: "note",
            pitch: null,
            bar: msg.bar as number,
            beat_position: msg.beat_position as number,
            is_on_time: msg.is_on_time as boolean,
          },
        ]);
        break;
      case "session_report":
        // Clear stop timeout — report arrived successfully
        if (stopTimeoutRef.current) {
          clearTimeout(stopTimeoutRef.current);
          stopTimeoutRef.current = null;
        }
        setReport(msg as unknown as Report);
        setAppState("report");
        break;
    }
  }, []);

  const { connect, disconnect, sendControl, sendAudio, connected } =
    useWebSocket(handleMessage);

  const { start: startAudio, stop: stopAudio, getRecordedAudio } = useAudioCapture({
    onAudioChunk: sendAudio,
  });

  const handleStart = useCallback(
    async (grid: GridResolution, threshold: number) => {
      setBpm(null);
      setEvents([]);
      setGridEstablished(false);
      setClickCount(0);
      setTotalOnsets(0);
      setReport(null);
      setRecordedAudio(null);

      const sampleRate = await startAudio();
      setAudioSampleRate(sampleRate);
      await connect();
      sendControl({
        type: "start",
        grid,
        threshold,
        sample_rate: sampleRate,
        calibration: calibration,
      });
    },
    [connect, sendControl, startAudio, calibration],
  );

  const handleStop = useCallback(() => {
    const audio = getRecordedAudio();
    setRecordedAudio(audio);
    stopAudio();
    sendControl({ type: "stop" });

    // Timeout: if no report arrives within 5 seconds, force transition
    stopTimeoutRef.current = setTimeout(() => {
      stopTimeoutRef.current = null;
      setReport({
        type: "session_report",
        error: "Session ended — no report received from server.",
      } as Report);
      setAppState("report");
      disconnect();
    }, 5000);
  }, [stopAudio, sendControl, getRecordedAudio, disconnect]);

  // If WebSocket disconnects unexpectedly during an active session, recover
  useEffect(() => {
    if (appState === "active" && !connected) {
      // Give a brief grace period for reconnection
      const timeout = setTimeout(() => {
        if (appState === "active") {
          const audio = getRecordedAudio();
          setRecordedAudio(audio);
          stopAudio();
          setReport({
            type: "session_report",
            error: "Connection lost during session.",
          } as Report);
          setAppState("report");
        }
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [appState, connected, getRecordedAudio, stopAudio]);

  const handleNewSession = useCallback(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
    disconnect();
    setAppState("idle");
    setEvents([]);
    setGridEstablished(false);
    setClickCount(0);
    setTotalOnsets(0);
    setReport(null);
    setRecordedAudio(null);
  }, [disconnect]);

  const handleCalibrationComplete = useCallback((profile: CalibrationProfile) => {
    saveCalibration(profile);
    setCalibration(profile);
    setAppState("idle");
  }, []);

  const handleRecalibrate = useCallback(() => {
    setAppState("calibrating");
  }, []);

  // If no calibration exists, force calibration
  const needsCalibration = !calibration && appState === "idle";

  return (
    <div className="app">
      <h1>Rhythm Trainer</h1>

      {(needsCalibration || appState === "calibrating") && (
        <CalibrationWizard
          onComplete={handleCalibrationComplete}
          onCancel={appState === "calibrating" ? () => setAppState("idle") : undefined}
        />
      )}

      {appState === "idle" && calibration && (
        <SessionControls
          onStart={handleStart}
          onStop={handleStop}
          isActive={false}
          onRecalibrate={handleRecalibrate}
          calibratedAt={calibration.calibrated_at}
        />
      )}

      {appState === "active" && (
        <>
          <SessionControls
            onStart={handleStart}
            onStop={handleStop}
            isActive={true}
          />
          <RealTimeFeedback
            events={events}
            bpm={bpm}
            gridEstablished={gridEstablished}
            clickCount={clickCount}
            totalOnsets={totalOnsets}
          />
        </>
      )}

      {appState === "report" && report && (
        <SessionReport
          report={report}
          onNewSession={handleNewSession}
          recordedAudio={recordedAudio}
          sampleRate={audioSampleRate}
        />
      )}
    </div>
  );
}
