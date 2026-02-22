"""Onset detection — real-time (energy-based) and offline (librosa)."""

from __future__ import annotations

import numpy as np
import librosa


class RealtimeOnsetDetector:
    """Adaptive energy-based onset detection for streaming audio."""

    def __init__(self, sample_rate: int = 44100, min_interval_seconds: float = 0.05):
        self.sample_rate = sample_rate
        self.min_interval_seconds = min_interval_seconds
        self.last_onset_time: float | None = None
        self.total_samples = 0

        # Adaptive threshold state
        self.smoothed_rms = 0.0
        self.mean_rms = 0.0
        self.alpha_smooth = 0.3
        self.alpha_mean_rise = 0.01   # baseline rises slowly during loud signals
        self.alpha_mean_fall = 0.05   # baseline drops 5x faster after energy fades
        self.threshold_ratio = 1.5
        self.min_threshold = 0.001

        # Gate: only trigger on the rising edge (energy crosses threshold),
        # not on every frame that stays above threshold.
        # Hysteresis prevents re-triggering on minor energy dips during
        # guitar sustain (e.g., attack transient → brief dip → sustain).
        self._above_threshold = False
        self.hysteresis_ratio = 0.4  # must drop to 40% of threshold to re-arm

        # Diagnostics
        self._peak_rms = 0.0
        self._frame_count = 0
        self._log_interval = 200  # log every N frames

    def process_chunk(self, audio_chunk: np.ndarray) -> list[float]:
        """Process a chunk and return detected onset times (seconds)."""
        onsets: list[float] = []
        frame_size = 512
        hop_size = 256

        for i in range(0, len(audio_chunk) - frame_size + 1, hop_size):
            frame = audio_chunk[i : i + frame_size]
            rms = float(np.sqrt(np.mean(frame**2)))

            self.smoothed_rms = (
                self.alpha_smooth * rms + (1 - self.alpha_smooth) * self.smoothed_rms
            )

            threshold = max(self.min_threshold, self.mean_rms * self.threshold_ratio)

            # Track peak for diagnostics
            if rms > self._peak_rms:
                self._peak_rms = rms

            if self.smoothed_rms > threshold:
                if not self._above_threshold:
                    # Rising edge: energy just crossed threshold — this is an onset
                    self._above_threshold = True
                    onset_time = (self.total_samples + i) / self.sample_rate
                    if (
                        self.last_onset_time is None
                        or onset_time - self.last_onset_time >= self.min_interval_seconds
                    ):
                        onsets.append(onset_time)
                        self.last_onset_time = onset_time
            else:
                # Hysteresis: only re-arm when energy drops well below threshold.
                # This prevents double-triggering on guitar notes where energy
                # briefly dips during the attack→sustain transition.
                if self.smoothed_rms < threshold * self.hysteresis_ratio:
                    self._above_threshold = False

            # Asymmetric baseline: rises slowly during loud signals,
            # falls faster after energy fades — keeps detector sensitive
            # to quieter events (metronome clicks) after loud guitar notes
            alpha = self.alpha_mean_rise if rms > self.mean_rms else self.alpha_mean_fall
            self.mean_rms = alpha * rms + (1 - alpha) * self.mean_rms

            # Periodic diagnostic logging
            self._frame_count += 1
            if self._frame_count % self._log_interval == 0:
                t = (self.total_samples + i) / self.sample_rate
                print(
                    f"[OnsetDetector] t={t:.1f}s  rms={rms:.5f}  "
                    f"smoothed={self.smoothed_rms:.5f}  mean={self.mean_rms:.5f}  "
                    f"threshold={threshold:.5f}  peak={self._peak_rms:.5f}"
                )

        self.total_samples += len(audio_chunk)
        return onsets

    def reset(self) -> None:
        self.last_onset_time = None
        self.total_samples = 0
        self.smoothed_rms = 0.0
        self.mean_rms = 0.0
        self._above_threshold = False
        self._peak_rms = 0.0
        self._frame_count = 0


def detect_onsets_offline(audio: np.ndarray, sample_rate: int = 44100) -> np.ndarray:
    """Run librosa onset detection on a complete audio buffer. Returns times in seconds."""
    try:
        return librosa.onset.onset_detect(
            y=audio, sr=sample_rate, hop_length=512, backtrack=False, units="time"
        )
    except Exception:
        return np.array([])
