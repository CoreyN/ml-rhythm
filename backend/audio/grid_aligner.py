"""Grid alignment and timing deviation calculation."""

import numpy as np


class GridConfig:
    """Beat grid based on BPM, resolution, and a reference time anchor."""

    def __init__(self, bpm: float, grid_resolution: str, reference_time: float):
        self.bpm = bpm
        self.grid_resolution = grid_resolution  # "8th" or "16th"
        self.reference_time = reference_time  # time of first beat (seconds)

    @property
    def beat_duration(self) -> float:
        return 60.0 / self.bpm

    @property
    def grid_interval(self) -> float:
        if self.grid_resolution == "16th":
            return self.beat_duration / 4
        return self.beat_duration / 2  # 8th notes

    def compute_deviation(self, onset_time: float) -> tuple[float, float, int, float]:
        """
        Snap an onset to the nearest grid position and compute deviation.

        Returns (deviation_ms, nearest_grid_time, bar, beat_position).
        """
        relative = onset_time - self.reference_time
        grid_index = round(relative / self.grid_interval)
        nearest_grid_time = self.reference_time + grid_index * self.grid_interval
        deviation_ms = (onset_time - nearest_grid_time) * 1000.0

        # Bar and beat position (4/4 time)
        subdivisions_per_beat = 4 if self.grid_resolution == "16th" else 2
        subdivisions_per_bar = 4 * subdivisions_per_beat
        bar = int(grid_index // subdivisions_per_bar) + 1
        position_in_bar = grid_index % subdivisions_per_bar
        beat_position = 1.0 + position_in_bar / subdivisions_per_beat

        return round(deviation_ms, 1), nearest_grid_time, bar, round(beat_position, 2)
