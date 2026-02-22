"""Detect BPM from onset times using periodicity analysis with continuous refinement.

Accepts ALL onsets (both clicks and guitar notes) and finds the dominant
periodic pattern — the metronome. After locking, continuously refines the
grid via linear regression on accumulated click times to prevent drift.
"""

from __future__ import annotations

import numpy as np


class MetronomeDetector:
    """Find the metronome among all detected onsets via periodicity analysis.

    Locks the grid after finding 4+ onsets that form a consistent periodic
    pattern. After lock, continuously tracks clicks and refines the grid
    period/reference via linear regression to prevent cumulative drift.
    """

    MIN_PERIODIC_ONSETS = 4
    TOLERANCE_S = 0.025  # 25ms tolerance for initial periodicity search
    MIN_PERIOD_S = 0.25  # 240 BPM
    MAX_PERIOD_S = 1.5   # 40 BPM
    WINDOW_S = 6.0       # only look at last 6 seconds of onsets pre-lock
    REFIT_INTERVAL = 4   # refit grid every N new clicks

    def __init__(self):
        self.onset_times: list[float] = []
        self.locked = False
        self.bpm: float | None = None
        self.period: float | None = None
        self.reference_time: float | None = None

        # Click tracking for grid refinement
        self.click_times: list[float] = []
        self._click_indices: list[int] = []
        self._clicks_since_refit = 0

        # Track best periodic count for frontend display
        self._best_periodic_count = 0

    def add_onset(self, time_seconds: float) -> bool:
        """Pre-lock: add any onset time. Returns True if grid just locked."""
        self.onset_times.append(time_seconds)

        if self.locked:
            return False

        if len(self.onset_times) < self.MIN_PERIODIC_ONSETS:
            return False

        return self._try_lock()

    def _try_lock(self) -> bool:
        """Try to find a periodic subset among recent onsets."""
        cutoff = self.onset_times[-1] - self.WINDOW_S
        times = [t for t in self.onset_times if t >= cutoff]

        if len(times) < self.MIN_PERIODIC_ONSETS:
            return False

        best_period = None
        best_aligned: list[float] = []

        for i in range(len(times)):
            for j in range(i + 1, len(times)):
                raw_interval = times[j] - times[i]

                for divisor in (1, 2, 3, 4):
                    period = raw_interval / divisor
                    if period < self.MIN_PERIOD_S or period > self.MAX_PERIOD_S:
                        continue

                    aligned = []
                    for t in times:
                        offset = (t - times[i]) / period
                        nearest_int = round(offset)
                        error_s = abs(offset - nearest_int) * period
                        if error_s <= self.TOLERANCE_S:
                            aligned.append(t)

                    if len(aligned) > len(best_aligned):
                        best_aligned = aligned
                        best_period = period

            if len(best_aligned) >= 6:
                break

        self._best_periodic_count = len(best_aligned)

        if best_period is not None:
            print(
                f"[MetronomeDetector] _try_lock: {len(times)} onsets in window, "
                f"best_periodic={len(best_aligned)}, "
                f"best_period={best_period*1000:.0f}ms "
                f"({60.0/best_period:.0f} BPM), "
                f"need {self.MIN_PERIODIC_ONSETS}"
            )

        if len(best_aligned) >= self.MIN_PERIODIC_ONSETS and best_period is not None:
            self.click_times = sorted(best_aligned)

            # Use linear regression for initial period/reference estimate.
            # This is more accurate than median IOI, especially when one of
            # the aligned onsets is a noise false positive.
            self._compute_click_indices(best_period)
            self._refit()

            self.locked = True
            print(
                f"[MetronomeDetector] LOCKED: bpm={self.bpm:.1f}, "
                f"period={self.period*1000:.2f}ms, "
                f"clicks={len(self.click_times)}, "
                f"ref={self.reference_time:.3f}s"
            )
            return True

        return False

    def _compute_click_indices(self, approx_period: float) -> None:
        """Assign beat indices to click_times based on approximate period."""
        if not self.click_times:
            return
        base = self.click_times[0]
        self._click_indices = [
            round((t - base) / approx_period) for t in self.click_times
        ]

    def _refit(self) -> None:
        """Recompute period and reference from all accumulated click times via linear regression."""
        if len(self.click_times) < 2:
            return

        indices = np.array(self._click_indices, dtype=float)
        times = np.array(self.click_times)

        # Fit: time = reference + index * period
        A = np.vstack([indices, np.ones(len(indices))]).T
        result, _, _, _ = np.linalg.lstsq(A, times, rcond=None)
        new_period, new_reference = result

        if self.MIN_PERIOD_S <= new_period <= self.MAX_PERIOD_S:
            old_period = self.period
            self.period = float(new_period)
            self.reference_time = float(new_reference)
            self.bpm = 60.0 / float(new_period)
            if old_period is not None:
                print(
                    f"[MetronomeDetector] REFIT: period {old_period*1000:.2f}"
                    f"→{new_period*1000:.2f}ms, bpm={self.bpm:.1f}, "
                    f"clicks={len(self.click_times)}"
                )

    def track_onset(self, onset_time: float) -> bool:
        """Post-lock: check if onset is a metronome click and refine grid.

        Uses a generous tolerance to catch clicks even with small drift,
        then refines the grid periodically to prevent drift accumulation.

        Returns True if the onset is classified as a click.
        """
        if not self.locked or self.period is None or self.reference_time is None:
            return False

        offset = (onset_time - self.reference_time) / self.period
        nearest_int = round(offset)
        error_ms = abs(offset - nearest_int) * self.period * 1000.0

        # Generous tolerance for click tracking (25% of grid period, max 50ms)
        track_tolerance_ms = min(self.period * 250, 50.0)

        if error_ms > track_tolerance_ms:
            return False

        # Reject if too close to the last click (prevents guitar notes near
        # grid lines from being double-counted as clicks)
        if self.click_times:
            gap = onset_time - self.click_times[-1]
            if gap < self.period * 0.5:
                return False

        # This onset is a click — record it and refine grid
        self.click_times.append(onset_time)
        self._click_indices.append(int(nearest_int))
        self._clicks_since_refit += 1

        if self._clicks_since_refit >= self.REFIT_INTERVAL:
            self._clicks_since_refit = 0
            self._refit()

        return True

    @property
    def total_onsets(self) -> int:
        return len(self.onset_times)

    @property
    def click_count(self) -> int:
        """Best periodic onset count found so far (even before lock)."""
        if self.locked:
            return len(self.click_times)
        return self._best_periodic_count

    @property
    def grid_updated(self) -> bool:
        """True if the grid was just refined (period/reference changed)."""
        return self._clicks_since_refit == 0 and len(self.click_times) > self.MIN_PERIODIC_ONSETS
