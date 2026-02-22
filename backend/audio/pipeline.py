"""Main audio processing pipeline — orchestrates onset detection, classification, and grid alignment."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import time

import numpy as np
import soundfile as sf

from .onset_detector import RealtimeOnsetDetector
from .metronome_detector import MetronomeDetector
from .grid_aligner import GridConfig
from .calibration import classify_onset

SESSIONS_DIR = Path(__file__).resolve().parent.parent / "sessions"


@dataclass
class NoteEvent:
    time_seconds: float
    nearest_grid_time: float
    deviation_ms: float
    event_type: str  # "note" | "rest" | "extra"
    pitch: str | None
    bar: int
    beat_position: float


class AudioPipeline:
    """Processes streaming audio: detects onsets, finds metronome by periodicity, scores guitar."""

    def __init__(
        self,
        grid_resolution: str = "8th",
        sample_rate: int = 44100,
        timing_threshold_ms: float = 30.0,
        calibration: dict | None = None,
    ):
        self.grid_resolution = grid_resolution
        self.sample_rate = sample_rate
        self.timing_threshold_ms = timing_threshold_ms
        self.calibration = calibration

        self.audio_buffer = np.array([], dtype=np.float32)
        self.grid_config: GridConfig | None = None
        self.note_events: list[NoteEvent] = []

        self.metronome_detector = MetronomeDetector()

        # Use a conservative min interval for onset detection
        self.onset_detector = RealtimeOnsetDetector(
            sample_rate=sample_rate, min_interval_seconds=0.05
        )

        self._total_onset_count = 0

    @property
    def is_grid_established(self) -> bool:
        return self.metronome_detector.locked

    @property
    def bpm(self) -> float | None:
        return self.metronome_detector.bpm

    def _sync_grid(self) -> None:
        """Update GridConfig if the metronome detector refined its period/reference."""
        md = self.metronome_detector
        if self.grid_config is None or md.period is None or md.reference_time is None:
            return
        if (self.grid_config.bpm != md.bpm
                or self.grid_config.reference_time != md.reference_time):
            self.grid_config = GridConfig(
                bpm=md.bpm,
                grid_resolution=self.grid_resolution,
                reference_time=md.reference_time,
            )

    def _classify_onset_spectral(self, onset_time: float) -> str:
        """Use calibration profiles to classify an onset as 'click' or 'guitar'."""
        if not self.calibration:
            return "unknown"
        onset_sample = int(onset_time * self.sample_rate)
        return classify_onset(
            self.audio_buffer, onset_sample, self.sample_rate, self.calibration
        )

    def process_audio(self, chunk: np.ndarray) -> list[dict]:
        """Process an incoming audio chunk. Returns event dicts for the frontend."""
        self.audio_buffer = np.concatenate([self.audio_buffer, chunk])
        onsets = self.onset_detector.process_chunk(chunk)
        events: list[dict] = []

        for onset_time in onsets:
            self._total_onset_count += 1
            print(f"[Pipeline] onset #{self._total_onset_count} at t={onset_time:.3f}s (grid_locked={self.is_grid_established})")

            if not self.is_grid_established:
                # Pre-lock: feed ALL onsets to periodicity detector
                just_locked = self.metronome_detector.add_onset(onset_time)
                events.append({
                    "type": "click_detected",
                    "time": onset_time,
                    "click_count": self.metronome_detector.click_count,
                    "total_onsets": self.metronome_detector.total_onsets,
                })
                if just_locked:
                    self.grid_config = GridConfig(
                        bpm=self.metronome_detector.bpm,
                        grid_resolution=self.grid_resolution,
                        reference_time=self.metronome_detector.reference_time,
                    )
                    events.append({
                        "type": "grid_established",
                        "bpm": round(self.metronome_detector.bpm, 1),
                        "reference_time": self.metronome_detector.reference_time,
                    })
            else:
                # Post-lock: classify using both timing and spectral analysis
                timing_is_click = self.metronome_detector.track_onset(onset_time)

                # If we have calibration data, also check spectral similarity
                if self.calibration:
                    spectral_class = self._classify_onset_spectral(onset_time)

                    if timing_is_click and spectral_class == "guitar":
                        # Timing says click but spectrum says guitar — trust spectrum,
                        # undo the click tracking
                        self.metronome_detector.click_times.pop()
                        self.metronome_detector._click_indices.pop()
                        self.metronome_detector._clicks_since_refit = max(
                            0, self.metronome_detector._clicks_since_refit - 1
                        )
                        is_click = False
                        print(f"[Pipeline] spectral override: timing=click, spectral=guitar → guitar")
                    elif not timing_is_click and spectral_class == "click":
                        # Spectrum says click but timing doesn't match — trust timing
                        # (this prevents misclassifying guitar notes near grid lines)
                        is_click = False
                    else:
                        is_click = timing_is_click
                else:
                    is_click = timing_is_click

                # Update grid config if the detector refined period/reference
                self._sync_grid()

                if is_click:
                    # When a click is detected, also check if a guitar note is
                    # coinciding with it. When playing on the beat, the guitar
                    # and metronome merge into a single onset — we should emit
                    # both a click and a note event so neither gets lost.
                    events.append({
                        "type": "click_detected",
                        "time": onset_time,
                        "click_count": self.metronome_detector.click_count,
                        "total_onsets": self._total_onset_count,
                    })
                    if self._is_note_expected_near(onset_time):
                        deviation_ms, grid_time, bar, beat_pos = (
                            self.grid_config.compute_deviation(onset_time)
                        )
                        note = NoteEvent(
                            time_seconds=onset_time,
                            nearest_grid_time=grid_time,
                            deviation_ms=deviation_ms,
                            event_type="note",
                            pitch=None,
                            bar=bar,
                            beat_position=beat_pos,
                        )
                        self.note_events.append(note)
                        events.append({
                            "type": "note_event",
                            "time": onset_time,
                            "deviation_ms": deviation_ms,
                            "bar": bar,
                            "beat_position": beat_pos,
                            "is_on_time": abs(deviation_ms) <= self.timing_threshold_ms,
                        })
                        print(f"[Pipeline] coincidence: click+note at t={onset_time:.3f}s")
                else:
                    # Guitar onset — score against grid
                    deviation_ms, grid_time, bar, beat_pos = (
                        self.grid_config.compute_deviation(onset_time)
                    )
                    note = NoteEvent(
                        time_seconds=onset_time,
                        nearest_grid_time=grid_time,
                        deviation_ms=deviation_ms,
                        event_type="note",
                        pitch=None,
                        bar=bar,
                        beat_position=beat_pos,
                    )
                    self.note_events.append(note)
                    events.append({
                        "type": "note_event",
                        "time": onset_time,
                        "deviation_ms": deviation_ms,
                        "bar": bar,
                        "beat_position": beat_pos,
                        "is_on_time": abs(deviation_ms) <= self.timing_threshold_ms,
                    })

        return events

    def _is_note_expected_near(self, onset_time: float) -> bool:
        """Heuristic: should we also emit a note event for this click-classified onset?

        After the initial metronome-only phase, if the player has been playing notes
        then a click-classified onset likely has a guitar note merged into it.
        We check that note events have started arriving (the player is actively
        playing) and that the click didn't arrive during a gap between notes.
        """
        if not self.note_events:
            # No notes yet — player hasn't started; this is a pure click
            return False

        last_note_time = self.note_events[-1].time_seconds
        md = self.metronome_detector
        # If we've heard a note recently (within 2 beat periods), the player
        # is active and this click likely coincides with a played note
        return (onset_time - last_note_time) < md.period * 2.0

    def save_session(self) -> str | None:
        """Save raw audio buffer to a WAV file for offline analysis. Returns the file path."""
        if len(self.audio_buffer) == 0:
            return None
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        path = SESSIONS_DIR / f"session-{ts}.wav"
        sf.write(str(path), self.audio_buffer, self.sample_rate)
        print(f"[Pipeline] Session audio saved: {path} ({len(self.audio_buffer)} samples, {len(self.audio_buffer)/self.sample_rate:.1f}s)")
        return str(path)

    def generate_report(self) -> dict:
        """Produce session report from real-time classified events."""
        self.save_session()

        if len(self.audio_buffer) == 0:
            return {"type": "session_report", "error": "No audio recorded"}

        if not self.is_grid_established:
            return {
                "type": "session_report",
                "error": (
                    f"No metronome detected — could not establish grid. "
                    f"Heard {self._total_onset_count} onsets total, "
                    f"best periodic match: {self.metronome_detector.click_count}/4 needed."
                ),
            }

        # Use the already-classified real-time note events (guitar only).
        # Re-running detection offline with librosa produces different onset
        # times that don't match the real-time grid, causing misclassification.
        if len(self.note_events) == 0:
            return {"type": "session_report", "error": "No guitar notes detected"}

        events: list[dict] = []
        deviations: list[float] = []

        for note in self.note_events:
            deviations.append(note.deviation_ms)
            events.append({
                "time": note.time_seconds,
                "nearest_grid_time": note.nearest_grid_time,
                "deviation_ms": note.deviation_ms,
                "event_type": note.event_type,
                "pitch": note.pitch,
                "bar": note.bar,
                "beat_position": note.beat_position,
            })

        abs_devs = [abs(d) for d in deviations]
        worst_idx = int(np.argmax(abs_devs))
        on_time = sum(1 for d in abs_devs if d <= self.timing_threshold_ms)

        return {
            "type": "session_report",
            "bpm": round(self.metronome_detector.bpm, 1),
            "grid_resolution": self.grid_resolution,
            "total_bars": events[-1]["bar"] if events else 0,
            "events": events,
            "click_times": self.metronome_detector.click_times,
            "stats": {
                "total_notes": len(events),
                "mean_absolute_deviation_ms": round(float(np.mean(np.abs(deviations))), 1),
                "mean_signed_deviation_ms": round(float(np.mean(deviations)), 1),
                "std_deviation_ms": round(float(np.std(deviations)), 1),
                "median_deviation_ms": round(float(np.median(deviations)), 1),
                "worst_deviation_ms": deviations[worst_idx],
                "worst_deviation_position": (
                    f"bar {events[worst_idx]['bar']}, "
                    f"beat {events[worst_idx]['beat_position']}"
                ),
                "accuracy_percent": round(on_time / len(events) * 100, 1),
            },
            "metronome_stats": self._compute_metronome_stats(),
        }

    def _compute_metronome_stats(self) -> dict:
        """Analyze metronome click consistency: jitter, drift, and overall quality.

        Computes per-click deviation from the fitted grid line
        (reference + index * period) rather than raw inter-click intervals,
        which is more robust to any misclassified onsets.
        """
        md = self.metronome_detector
        click_times = md.click_times
        click_indices = md._click_indices
        if len(click_times) < 3 or md.period is None or md.reference_time is None:
            return {"total_clicks": len(click_times), "error": "Too few clicks for analysis"}

        times = np.array(click_times)
        indices = np.array(click_indices, dtype=float)
        expected_ms = md.period * 1000.0

        # Per-click deviation from fitted grid: actual - (reference + index * period)
        expected_times = md.reference_time + indices * md.period
        errors_ms = (times - expected_times) * 1000.0
        abs_errors = np.abs(errors_ms)

        # Drift: refit with slope to see if clicks are progressively early/late
        # A positive slope means the metronome is running slower than the fitted period
        drift_ms_per_beat = 0.0
        if len(times) >= 4:
            coeffs = np.polyfit(indices, errors_ms, 1)
            drift_ms_per_beat = round(float(coeffs[0]), 2)

        # Consistency: percentage of clicks within thresholds of their expected position
        tight_count = int(np.sum(abs_errors <= 2.0))
        ok_count = int(np.sum(abs_errors <= 5.0))

        return {
            "total_clicks": len(click_times),
            "expected_interval_ms": round(expected_ms, 1),
            "jitter_ms": round(float(np.std(errors_ms)), 2),
            "mean_error_ms": round(float(np.mean(abs_errors)), 2),
            "max_error_ms": round(float(np.max(abs_errors)), 1),
            "drift_ms_per_beat": drift_ms_per_beat,
            "tight_percent": round(tight_count / len(click_times) * 100, 1),
            "ok_percent": round(ok_count / len(click_times) * 100, 1),
        }
