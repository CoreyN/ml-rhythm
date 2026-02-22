"""Onset classification utilities.

The primary classification method is grid-proximity (in MetronomeDetector.is_click).
This module provides supplementary spectral feature extraction if needed in the future.
"""

from __future__ import annotations

import numpy as np


def spectral_centroid(window: np.ndarray, sample_rate: int) -> float:
    """Compute spectral centroid in Hz for an audio window."""
    spectrum = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(len(window), d=1.0 / sample_rate)
    total = np.sum(spectrum)
    if total < 1e-10:
        return 0.0
    return float(np.sum(freqs * spectrum) / total)


def energy_decay_ratio(window: np.ndarray) -> float:
    """Ratio of energy in second half vs first half. Low = fast decay (click-like)."""
    mid = len(window) // 2
    first_half = np.sum(window[:mid] ** 2)
    second_half = np.sum(window[mid:] ** 2)
    if first_half < 1e-10:
        return 1.0
    return float(second_half / first_half)
