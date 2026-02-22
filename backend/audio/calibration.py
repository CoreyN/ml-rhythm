"""Calibration — extract spectral profiles from metronome clicks and guitar notes.

Used in two contexts:
1. Offline: after a calibration recording, extract an averaged profile from all onsets.
2. Real-time: classify a single onset window against stored profiles.
"""

from __future__ import annotations

import numpy as np
import librosa


# Window size in samples for feature extraction (~46ms at 44100Hz)
WINDOW_SAMPLES = 2048


def extract_profile(audio: np.ndarray, sample_rate: int) -> dict:
    """Analyze a calibration recording and return an averaged spectral profile.

    Runs offline onset detection, extracts a feature window around each onset,
    and averages the features across all detected onsets.

    Returns dict with: mfcc_mean (13 floats), spectral_centroid, energy_decay, onset_count.
    """
    onset_times = librosa.onset.onset_detect(
        y=audio, sr=sample_rate, hop_length=512, backtrack=False, units="time"
    )

    if len(onset_times) == 0:
        return {
            "mfcc_mean": [0.0] * 13,
            "spectral_centroid": 0.0,
            "energy_decay": 0.0,
            "onset_count": 0,
        }

    all_mfcc = []
    all_centroid = []
    all_decay = []

    for t in onset_times:
        start = int(t * sample_rate)
        end = start + WINDOW_SAMPLES
        if end > len(audio):
            continue

        window = audio[start:end]
        features = _extract_window_features(window, sample_rate)
        if features is not None:
            all_mfcc.append(features["mfcc"])
            all_centroid.append(features["spectral_centroid"])
            all_decay.append(features["energy_decay"])

    if len(all_mfcc) == 0:
        return {
            "mfcc_mean": [0.0] * 13,
            "spectral_centroid": 0.0,
            "energy_decay": 0.0,
            "onset_count": 0,
        }

    return {
        "mfcc_mean": np.mean(all_mfcc, axis=0).tolist(),
        "spectral_centroid": float(np.mean(all_centroid)),
        "energy_decay": float(np.mean(all_decay)),
        "onset_count": len(all_mfcc),
    }


def classify_onset(
    audio_buffer: np.ndarray,
    onset_sample: int,
    sample_rate: int,
    calibration: dict,
) -> str:
    """Classify a single onset as 'click' or 'guitar' using stored calibration profiles.

    Extracts features from the audio window at onset_sample and compares against
    the metronome and guitar profiles via cosine similarity on MFCCs.

    Returns 'click' or 'guitar'.
    """
    end = onset_sample + WINDOW_SAMPLES
    if end > len(audio_buffer) or onset_sample < 0:
        return "guitar"  # can't extract window, default to guitar

    window = audio_buffer[onset_sample:end]
    features = _extract_window_features(window, sample_rate)
    if features is None:
        return "guitar"

    met_profile = calibration.get("metronome")
    gtr_profile = calibration.get("guitar")
    if not met_profile or not gtr_profile:
        return "guitar"

    onset_mfcc = np.array(features["mfcc"])
    met_mfcc = np.array(met_profile["mfcc_mean"])
    gtr_mfcc = np.array(gtr_profile["mfcc_mean"])

    sim_met = _cosine_similarity(onset_mfcc, met_mfcc)
    sim_gtr = _cosine_similarity(onset_mfcc, gtr_mfcc)

    # Also factor in energy decay — clicks decay much faster than guitar
    met_decay = met_profile.get("energy_decay", 0.5)
    gtr_decay = gtr_profile.get("energy_decay", 0.5)
    onset_decay = features["energy_decay"]

    decay_dist_met = abs(onset_decay - met_decay)
    decay_dist_gtr = abs(onset_decay - gtr_decay)

    # Combined score: MFCC similarity (higher = more similar) minus decay distance
    score_met = sim_met - 0.3 * decay_dist_met
    score_gtr = sim_gtr - 0.3 * decay_dist_gtr

    return "click" if score_met > score_gtr else "guitar"


def _extract_window_features(window: np.ndarray, sample_rate: int) -> dict | None:
    """Extract spectral features from a single audio window."""
    if np.max(np.abs(window)) < 1e-6:
        return None  # silence

    # MFCCs — 13 coefficients, averaged across time frames in the window
    mfcc = librosa.feature.mfcc(y=window, sr=sample_rate, n_mfcc=13, n_fft=min(len(window), 2048))
    mfcc_mean = np.mean(mfcc, axis=1)

    # Spectral centroid
    centroid = librosa.feature.spectral_centroid(y=window, sr=sample_rate, n_fft=min(len(window), 2048))
    centroid_mean = float(np.mean(centroid))

    # Energy decay ratio (second half energy / first half energy)
    mid = len(window) // 2
    first_energy = np.sum(window[:mid] ** 2)
    second_energy = np.sum(window[mid:] ** 2)
    decay = float(second_energy / first_energy) if first_energy > 1e-10 else 1.0

    return {
        "mfcc": mfcc_mean.tolist(),
        "spectral_centroid": centroid_mean,
        "energy_decay": decay,
    }


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a < 1e-10 or norm_b < 1e-10:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))
