import { useState, useRef, useCallback, useEffect } from "react";

interface Props {
  audioData: Float32Array;
  sampleRate: number;
  onTimeUpdate?: (currentTime: number) => void;
  onScrubReady?: (scrub: (t: number) => void) => void;
}

const SPEEDS = [1, 0.5, 0.25] as const;
const DEFAULT_GAIN = 3.16; // +10 dB

function createWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function AudioPlayback({ audioData, sampleRate, onTimeUpdate, onScrubReady }: Props) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(DEFAULT_GAIN);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number>(0);
  const volumeRef = useRef(DEFAULT_GAIN);

  const duration = audioData.length / sampleRate;

  // Encode Float32 → WAV blob, create <audio> element, and route through GainNode
  useEffect(() => {
    const blob = createWavBlob(audioData, sampleRate);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preservesPitch = true;
    audioRef.current = audio;

    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = volumeRef.current;
    source.connect(gain);
    gain.connect(ctx.destination);
    ctxRef.current = ctx;
    gainRef.current = gain;

    return () => {
      cancelAnimationFrame(rafRef.current);
      audio.pause();
      audioRef.current = null;
      gainRef.current = null;
      ctx.close();
      ctxRef.current = null;
      URL.revokeObjectURL(url);
    };
  }, [audioData, sampleRate]);

  const updateTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    setCurrentTime(t);
    onTimeUpdate?.(t);

    if (audio.ended || t >= duration) {
      setIsPlaying(false);
      setCurrentTime(0);
      onTimeUpdate?.(0);
      return;
    }
    rafRef.current = requestAnimationFrame(updateTime);
  }, [duration, onTimeUpdate]);

  // Reset state when playback ends naturally
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => {
      cancelAnimationFrame(rafRef.current);
      setIsPlaying(false);
      audio.currentTime = 0;
      setCurrentTime(0);
      onTimeUpdate?.(0);
    };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [audioData, sampleRate, onTimeUpdate]);

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    ctxRef.current?.resume();
    audio.playbackRate = playbackRate;
    audio.play().catch(() => setIsPlaying(false));
    setIsPlaying(true);
    rafRef.current = requestAnimationFrame(updateTime);
  }, [playbackRate, updateTime]);

  const pause = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const scrub = useCallback(
    (value: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = value;
      setCurrentTime(value);
      onTimeUpdate?.(value);
    },
    [onTimeUpdate],
  );

  useEffect(() => {
    onScrubReady?.(scrub);
  }, [scrub, onScrubReady]);

  const changeSpeed = useCallback((newRate: number) => {
    setPlaybackRate(newRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = newRate;
    }
  }, []);

  const changeVolume = useCallback((v: number) => {
    volumeRef.current = v;
    setVolume(v);
    if (gainRef.current) {
      gainRef.current.gain.value = v;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      audioRef.current?.pause();
      ctxRef.current?.close();
    };
  }, []);

  const formatTime = (t: number) => {
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    const ms = Math.floor((t % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, "0")}.${ms}`;
  };

  return (
    <div className="audio-playback">
      <button
        className="playback-btn"
        onClick={isPlaying ? pause : play}
      >
        {isPlaying ? "\u23F8" : "\u25B6"}
      </button>
      <span className="playback-time">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <input
        type="range"
        className="playback-scrub"
        min={0}
        max={duration}
        step={0.01}
        value={currentTime}
        onChange={(e) => scrub(Number(e.target.value))}
      />
      <div className="speed-controls">
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            className={`speed-btn${playbackRate === speed ? " active" : ""}`}
            onClick={() => changeSpeed(speed)}
          >
            {speed === 1 ? "1x" : speed === 0.5 ? "\u00BDx" : "\u00BCx"}
          </button>
        ))}
      </div>
      <div className="volume-control">
        <span className="volume-icon">{volume === 0 ? "\uD83D\uDD07" : "\uD83D\uDD0A"}</span>
        <input
          type="range"
          className="volume-slider"
          min={0}
          max={4}
          step={0.01}
          value={volume}
          onChange={(e) => changeVolume(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
