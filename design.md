# Guitar Timing Practice App — Design Document

## Overview

A web application that listens to a guitarist playing along to an external metronome and provides real-time feedback on timing accuracy. After a session, it displays a report showing what was played (as musical notation), which notes were early/late, and by how much. Sessions can be recorded and played back alongside the report.

---

## Core User Flow

1. User opens the app
2. (Optional) Runs the calibration wizard to record spectral profiles of their metronome and guitar
3. Selects grid resolution (8th notes or 16th notes) and timing threshold
4. Clicks "Start"
5. Starts their external metronome and plays guitar
6. App listens, detects the metronome to establish tempo/grid, detects guitar onsets, and provides real-time timing feedback
7. User clicks "Stop"
8. App displays a full session report with notation, timing deviations, statistics, and audio playback

The user should not need to manually enter BPM, tap a tempo, or do anything beyond clicking start and selecting grid resolution.

---

## Technical Architecture

### Stack

- **Frontend:** React 19 (TypeScript), Vite 6, VexFlow 5
- **Backend:** Python, Litestar 2, librosa, NumPy, soundfile
- **Audio I/O:** Web Audio API + AudioWorklet (frontend), streamed to backend via WebSocket
- **ML Framework (planned):** PyTorch (for future custom onset detection and noise filtering models)

### High-Level Architecture

```
[Microphone/Audio Interface]
        |
  [Web Audio API + AudioWorklet] — captures raw PCM audio
        |
  [WebSocket stream — binary framed: 0x00 control, 0x01 audio]
        |
  [Litestar Backend]
        |
  ┌──────────────────────────────────────────┐
  │  Audio Processing Pipeline (current)     │
  │                                          │
  │  1. Onset Detection                      │
  │     (energy-based, adaptive RMS)         │
  │                                          │
  │  2. Metronome Detection                  │
  │     (periodicity analysis on all onsets, │
  │      grid lock after 4+ periodic clicks) │
  │                                          │
  │  3. Onset Classification                 │
  │     (timing proximity + spectral MFCC    │
  │      calibration to separate clicks      │
  │      from guitar notes)                  │
  │                                          │
  │  4. Grid Alignment                       │
  │     → snap guitar onsets to grid         │
  │     → compute signed deviations          │
  │                                          │
  └──────────────────────────────────────────┘
        |
  [WebSocket — real-time JSON events]
        |
  [React Frontend]
  → real-time timing indicators
  → session report & notation (VexFlow)
  → waveform display & audio playback
```

---

## Pipeline Detail — Current Implementation

The current pipeline uses a 4-stage approach that processes all onsets from a mixed audio signal (no source separation). Metronome clicks are identified via periodicity analysis, and guitar notes are classified by exclusion (plus optional spectral calibration).

### 1. Onset Detection (Energy-Based)

**Input:** Raw mixed audio (guitar + metronome) streamed in ~46ms chunks at 44.1kHz.

**Approach — Adaptive RMS energy detection:**

The `RealtimeOnsetDetector` processes audio incrementally with a streaming design:

- Compute RMS energy per frame with asymmetric baseline tracking (fast rise, slow decay) to maintain sensitivity across dynamic range
- Detect onsets when energy exceeds `baseline × threshold` with a hysteresis gate to avoid double-triggers
- Apply a configurable minimum inter-onset interval (default 50ms) to suppress retriggering
- All onsets (both metronome clicks and guitar notes) are detected in a single pass on the mixed signal

This approach works well for clean to moderate-gain guitar. For high-gain distortion where dynamics are heavily compressed, a future ML-based onset detector would improve accuracy (see Planned Pipeline Enhancements below).

### 2. Metronome Detection (Periodicity Analysis)

**Input:** All detected onset times from stage 1.

**Approach — Inter-onset interval periodicity search:**

The `MetronomeDetector` receives every onset and searches for periodic patterns without requiring source separation:

- Maintain a history of all onset times
- For each new onset, compute inter-onset intervals (IOIs) against previous onsets
- Search for a dominant period by finding IOIs that recur consistently (within 25ms tolerance)
- **Grid lock:** After finding 4+ onsets that match a periodic pattern, declare the grid as locked and establish BPM + reference time
- **Linear regression refinement:** Every 4 additional clicks, refit the grid line (`time = reference + index × period`) using all click times to correct for cumulative drift
- **Post-lock click tracking:** New onsets near expected click times (within tolerance) are classified as metronome clicks; the grid is continuously refined

**Latency:** The grid cannot be established until ~4 beats have been heard. The UI shows "listening for tempo..." during this phase.

### 3. Onset Classification (Timing + Spectral)

**Input:** Onset times + established beat grid + optional calibration profiles.

**Approach — Hybrid timing/spectral classification:**

After the grid is locked, each new onset is classified as either a metronome click or a guitar note:

- **Timing-based:** If the onset falls near an expected click time (based on the periodic grid), it's initially classified as a click
- **Spectral override (requires calibration):** If calibration profiles exist, extract MFCC features from the audio around the onset and compare via cosine similarity to the stored metronome and guitar profiles. If timing says "click" but the spectrum says "guitar" (e.g., a guitar note played right on the beat), the spectral classification wins
- **Without calibration:** Classification relies solely on timing proximity, which works well when the guitarist doesn't play exactly on every beat

**Calibration profiles** are built via the CalibrationWizard in the frontend:
1. User records a few seconds of metronome clicks alone → backend extracts MFCC mean, spectral centroid, and energy decay
2. User records a few seconds of guitar playing alone → same feature extraction
3. Profiles are stored in localStorage and sent with each session start

### 4. Grid Alignment & Deviation Calculation

**Input:** Guitar onset times (clicks excluded) + beat grid.

**Process:**

- For each guitar onset, find the nearest grid position (8th or 16th note subdivision)
- Grid positions computed from: `time = reference_time + index × grid_interval`
- Calculate signed deviation: `onset_time - nearest_grid_time`
  - Negative = early, Positive = late
  - Magnitude in milliseconds
- Assign bar number and beat position within the bar
- Handle coincident onsets: when a guitar note and metronome click merge into a single onset (playing right on the beat), emit both a click event and a note event

**Thresholds (configurable):**

- "In time": within ±threshold (user-configurable, 5–50ms, default 30ms)
- On-time percentage calculated as notes within threshold / total notes

---

## Planned Pipeline Enhancements

The following stages are designed but not yet implemented. They would be inserted before the current pipeline stages to improve accuracy in noisy or difficult conditions.

### Environmental Noise Filtering (Planned)

**Problem:** The app is used in real-world environments where the microphone picks up more than just the guitar and metronome. Background noise from household appliances, street noise, and other environmental sources can confuse downstream stages — causing false onset detections, corrupting metronome click detection, and degrading pitch estimation. This stage removes or suppresses environmental noise before the signal reaches source separation.

**Noise categories and characteristics:**

| Category | Examples | Spectral Profile | Temporal Profile |
|---|---|---|---|
| **Appliance hum/rumble** | Refrigerator, dishwasher, dryer, HVAC, furnace | Low-frequency dominant (50/60 Hz hum + harmonics, broadband rumble) | Continuous/stationary — consistent spectral shape over long durations |
| **Motor/engine noise** | Cars revving, motorcycles, lawnmowers | Broadband with strong low-mid harmonics, varies with RPM | Semi-stationary — slowly varying fundamental with harmonic overtones |
| **Sirens and horns** | Emergency sirens, car horns, truck air horns | Tonal, sweeping mid-high frequency (500 Hz–3 kHz for sirens) | Non-stationary — frequency sweeps or short bursts |
| **Impact/transient noise** | Doors slamming, construction, dogs barking | Broadband impulses or irregular bursts | Impulsive/intermittent |
| **Ambient broadband** | Wind noise, rain, traffic wash, crowd noise | Broadband, often shaped like pink/brown noise | Continuous, slowly varying |

**Approach — Hybrid filtering pipeline:**

The noise filtering stage uses a layered approach, combining fast classical methods with a lightweight ML denoiser:

**Layer 1 — Spectral gating (stationary noise removal):**

- During a brief calibration window before the user starts playing (or during detected silence gaps), estimate the background noise spectral profile
- Apply spectral gating: for each frequency bin, if energy is below `noise_floor + threshold`, suppress it
- This handles continuous appliance noise (refrigerator hum, HVAC, dryer rumble) effectively and cheaply
- Minimal latency cost — operates per-frame on the STFT

**Layer 2 — Adaptive notch filtering (tonal interference):**

- Detect persistent tonal components that don't match expected guitar or metronome frequencies (e.g., 50/60 Hz mains hum, appliance motor tones)
- Apply narrow adaptive notch filters to suppress these specific frequencies
- Track slowly drifting tonal noise (engine RPM changes, siren sweeps) by updating filter center frequencies over time

**Layer 3 — ML denoiser (non-stationary noise):**

- A small neural network (RNNoise-style architecture or lightweight Conv-TasNet) trained to separate "guitar + metronome" from "everything else"
- This handles the hard cases: engine revving, sirens, barking, transient impacts — noise sources whose spectral and temporal profiles overlap with guitar
- The model should be small enough for real-time inference (<5ms per chunk)

**Architecture considerations for ML denoiser:**

- Input: raw audio frames or STFT magnitude
- Output: denoised audio (or a multiplicative mask applied to the STFT)
- RNNoise-style GRU network (~60K parameters) is proven for real-time denoising at minimal CPU cost
- Alternatively, a small U-Net operating on mel spectrogram patches if GPU is available
- The denoiser does not need to be perfect — it just needs to clean the signal enough that downstream source separation and onset detection aren't confused

**Noise profile estimation:**

- On session start, before the user plays, capture 1–2 seconds of "room tone" to build an initial noise profile for spectral gating
- The UI already has a "listening for tempo..." phase — the noise profile can be estimated during this same window
- Continuously update the noise profile during detected rest periods (no guitar or metronome activity)

**Graceful degradation:**

- If the environment is too noisy for reliable filtering (SNR too low), surface a warning to the user: "High background noise detected — results may be less accurate"
- SNR estimation: compare energy in guitar-frequency bands vs estimated noise floor
- The ML denoiser should be trained with a wide range of SNR conditions (clean through severely noisy) so it degrades gracefully rather than failing abruptly

**Training data generation (ML denoiser):**

- Clean signals: guitar + metronome mixes (reuse source separation training data)
- Noise sources for augmentation:
  - **Appliances:** Record or source samples of refrigerators, dishwashers, dryers, washing machines, HVAC systems, microwave hum
  - **Vehicles:** Engine idling, revving at various RPMs (cars, motorcycles, trucks), engine pass-bys, exhaust rumble
  - **Street noise:** Sirens (police, ambulance, fire), car horns, truck air brakes, traffic wash
  - **Household:** TV/radio bleed, conversations in adjacent rooms, dogs barking, doors/cabinets closing
  - **Weather/ambient:** Wind against microphone, rain on windows, thunder
  - **Construction/yard:** Lawnmowers, leaf blowers, hammering, power tools at distance
- Mix clean signals with noise at various SNR levels (-5 dB to +30 dB)
- Apply random noise onset/offset within the clip (noise may start or stop mid-session)
- Labels: the clean guitar + metronome signal (the denoiser learns to output this)
- Dataset: 10,000+ clips with diverse noise combinations

### Source Separation (Planned)

**Input:** Audio that has been cleaned by the noise filtering stage (environmental noise removed/suppressed).

> **Current approach:** Instead of explicit source separation, the current implementation uses a combined timing + spectral classification approach (see stage 3 above) to distinguish metronome clicks from guitar notes in the mixed signal.

**Problem:** The cleaned signal still contains both the metronome click and the guitar. These must be separated to independently analyze tempo (from the click) and note timing (from the guitar).

**Approach — ML model (recommended):**

Train a small source separation model to isolate the metronome click track from the guitar signal. This is a constrained version of the general source separation problem:

- Metronome clicks are short, percussive, spectrally consistent, and periodic
- Guitar signal is harmonically rich and varied

A lightweight U-Net or Conv-TasNet variant operating on short audio chunks should work. The constrained nature of the problem (only 2 sources, one of which is highly predictable) means this doesn't need to be a large model.

**Training data generation:**

- Synthesize metronome clicks at various tempos (40–240 BPM), with various click sounds (digital clicks, woodblock, rimshot, etc.)
- Layer over guitar samples — clean and distorted single notes, power chords, double stops, rests
- Vary relative volumes, add room noise/reverb
- Ground truth: isolated metronome and guitar tracks

**Fallback approach:** If source separation proves too heavy for real-time use, an alternative is spectral filtering. Metronome clicks tend to occupy a distinct spectral profile from guitar. A bandpass filter tuned to common click frequencies, combined with transient detection, may suffice for many metronome types. This could be a fast first pass before investing in ML separation.

### Metronome Analysis (Planned Enhancement)

> **Current approach:** Metronome analysis is implemented via periodicity detection on the mixed signal (see stage 2 above). The planned enhancement below would operate on an isolated metronome signal from the source separation stage, which would improve accuracy.

**Input:** Isolated or filtered metronome signal.

**Approach:**

- Detect click onsets (standard energy-based onset detection is fine here since clicks are clean transients)
- Compute inter-onset intervals (IOI)
- Derive tempo (BPM) from median IOI
- Establish the beat grid: a series of expected beat times, subdivided to the user-selected resolution (8th or 16th notes)
- The grid should stabilize after 2–4 beats and then track any minor tempo drift in the metronome (most will be rock-solid, but cheap metronomes can drift)

### Neural Onset Detection (Planned)

**Input:** Isolated or filtered guitar signal.

> **Current approach:** The current implementation uses energy-based (RMS) onset detection, which works well for clean to moderate-gain guitar. The neural approach below would improve accuracy for heavily distorted guitar where dynamics are compressed.

**Problem:** Detecting note onsets in distorted guitar is the core ML challenge. Distortion compresses dynamics, smears transients, and adds sustain, making traditional energy-based onset detection unreliable.

**Approach — Neural onset detector:**

Train a CNN or CRNN on mel spectrograms (or CQT) to classify each frame as "onset" or "not onset."

**Architecture considerations:**

- Input: mel spectrogram frames (short context window, ~50–100ms)
- Output: onset probability per frame
- A small CNN (3-5 conv layers) should suffice given the constrained domain
- Post-processing: peak-pick on the onset probability curve, apply a minimum inter-onset interval based on grid resolution to avoid double-triggers

**Training data generation:**

- Synthesize guitar audio with known onset times:
  - Record or source dry guitar samples (single notes, power chords, double stops across fretboard range)
  - Apply amp sim / distortion at various gain levels (clean through high gain)
  - Apply time-stretching and pitch-shifting for variety
  - Place notes at known positions on a timeline
  - Add noise, room ambience, bleed from a metronome click
- Labels: binary onset at known sample positions

**Alternative:** Before training a custom model, benchmark **madmom** and **librosa** onset detection on distorted guitar samples. If accuracy is acceptable (>90% on your test cases), skip custom training and use off-the-shelf.

### Pitch Detection (Planned)

**Input:** Isolated guitar signal, segmented by detected onsets.

**Goal:** Identify what was played at each onset for notation display. Must handle:

- **Single notes** — monophonic pitch detection (well-studied, many good solutions)
- **Power chords** (root + fifth, sometimes octave) — limited polyphony
- **Double stops** (two notes) — limited polyphony
- **Rests** — absence of onset

**Approach:**

For single notes, a standard pitch detection algorithm works well:

- **CREPE** (pretrained CNN-based pitch detector) is robust and handles distortion reasonably
- **pYIN** (librosa) is a solid non-ML alternative

For power chords and double stops:

- Since polyphony is limited to 2–3 simultaneous notes, a harmonic analysis approach on the CQT/spectrum around each onset could work
- Identify the fundamental(s) by looking for harmonic series patterns
- Power chords are heavily constrained (root + fifth + optional octave), so a template-matching approach against known power chord spectra may be effective
- Alternatively, train a small classifier: given a short spectrogram window after an onset, predict the root note and chord type (single, power chord, double stop intervals)

**Training data generation (if ML):**

- Same sample generation pipeline as onset detection
- Labels: MIDI note numbers for each onset event

**Output:** For each onset, emit: `{ time, pitch_or_chord, deviation_from_grid, early_or_late }`

### Grid Alignment & Deviation Calculation

> **Status:** Implemented (see stage 4 in current pipeline above). The description below covers additional planned behaviors.

**Planned enhancements:**

- **Rest detection:** Identify grid positions with no onset within a threshold window and mark as rests
- **Extra onset flagging:** Flag onsets that don't correspond to any expected grid position (ghost notes, accidental string hits)

---

## Real-Time Considerations

### Latency Budget

For real-time feedback, the full pipeline (audio capture → processing → display) should target <100ms total latency.

- Audio capture buffer: ~10–20ms (512–1024 samples at 44.1kHz)
- Noise filtering: ~2–5ms (spectral gating is near-instant; ML denoiser must be lightweight)
- Source separation + downstream processing: must fit within remaining budget
- WebSocket round-trip: ~1–5ms (localhost-like, since backend is local or low-latency)
- Display update: next animation frame (~16ms)

### Streaming Architecture

- Frontend captures audio via Web Audio API using an AudioWorklet processor (2048-sample chunks, ~46ms at 44.1kHz)
- Chunks are streamed to backend over WebSocket as binary frames (0x01 prefix + Float32 PCM)
- Control messages (start, stop, calibrate) use 0x00 prefix + JSON
- Backend processes each chunk incrementally via `AudioPipeline` (maintains rolling state: onset detector, metronome detector, audio buffer)
- Events are streamed back as JSON text frames over the same WebSocket
- Frontend updates display in real-time
- Session audio is saved server-side as WAV files in `backend/sessions/`

### Model Performance

- All ML models must be optimized for inference speed. Consider:
  - ONNX Runtime for inference
  - Small model architectures (latency over accuracy where needed)
  - Processing on GPU if available, CPU fallback
  - Quantization if needed
- If backend processing can't keep up in real-time, consider running onset detection on the frontend via ONNX.js / TensorFlow.js as a fallback

---

## Frontend Design

### Main View (During Session)

```
┌─────────────────────────────────────────┐
│  Grid: [8th ▼]     BPM: 120 (detected)  │
│                                          │
│  ● ● ● ○ ● ● ○ ●   ← real-time grid   │
│  (green = on time, red = off, ○ = rest)  │
│                                          │
│  Current: 2ms early ✓                    │
│                                          │
│  [Stop]                                  │
└─────────────────────────────────────────┘
```

- Simple, glanceable real-time feedback
- Color-coded indicators per grid position (green/yellow/red based on deviation thresholds)
- Running display of the current note's timing deviation

### Report View (After Session)

```
┌──────────────────────────────────────────────┐
│  Session Report                               │
│                                               │
│  BPM: 120  |  Grid: 8th notes  |  Bars: 4    │
│  Overall accuracy: 87%                        │
│                                               │
│  ♩ ♩ ♪ 𝄾 ♩ ♩ 𝄾 ♪   ← musical notation      │
│  +3 -1 +12  -2 +1  -8  ← ms deviation       │
│  (with color coding per note)                 │
│                                               │
│  ▶ [  ——●————————————  ] 0:00 / 0:08         │
│  (audio playback with position synced         │
│   to notation highlighting)                   │
│                                               │
│  Timing Distribution:                         │
│  [histogram of deviations]                    │
│                                               │
│  Stats:                                       │
│  - Mean deviation: +2ms (slightly late)       │
│  - Std deviation: 8ms                         │
│  - Worst note: beat 3.5, +12ms late           │
└──────────────────────────────────────────────┘
```

**Notation rendering:** Uses **VexFlow 5** to render rhythmic notation. Currently renders rhythm-only (pitch detection not yet implemented). Notes are color-coded by timing accuracy (green = on time, red = off).

**Audio playback:** Session audio is recorded server-side (WAV files in `backend/sessions/`). The frontend `AudioPlayback` component provides playback with seek capability.

**Waveform display:** The `WaveformDisplay` component renders a canvas-based waveform visualization with onset markers overlaid, allowing visual inspection of detected events.

**Calibration wizard:** The `CalibrationWizard` component guides the user through recording metronome clicks and guitar notes separately to build spectral profiles for improved onset classification.

---

## Data Models

### NoteEvent (Python — `audio/pipeline.py`)

```python
@dataclass
class NoteEvent:
    time_seconds: float            # actual onset time in session
    nearest_grid_time: float       # snapped grid position
    deviation_ms: float            # signed: negative=early, positive=late
    event_type: str                # "note" | "rest" | "extra"
    pitch: str | None              # reserved for future pitch detection
    bar: int                       # which bar (1-indexed)
    beat_position: float           # position within bar (e.g. 1.0, 1.5, 2.25)
```

### GridConfig (Python — `audio/grid_aligner.py`)

```python
@dataclass
class GridConfig:
    bpm: float
    grid_resolution: str           # "8th" or "16th"
    reference_time: float          # time of the first click (seconds)
    # Computed: beat_duration, grid_interval
```

### TypeScript Types (`types/session.ts`)

- `GridResolution` = `"8th" | "16th"`
- `AppState` = `"idle" | "active" | "report" | "calibrating"`
- `NoteEvent` — time, deviation_ms, bar, beat_position, is_on_time
- `SessionReport` — bpm, grid_resolution, total_bars, events[], stats, metronome_stats, click_times
- `SessionStats` — total_notes, mean/std/median deviation, accuracy_percent, worst deviation
- `MetronomeStats` — jitter, drift, consistency percentages
- `CalibrationProfile` — metronome + guitar `SourceProfile` (MFCC mean, spectral centroid, energy decay)

### Session (Planned)

A persistent `Session` dataclass for session history tracking is planned but not yet implemented. Currently, sessions are ephemeral — the `AudioPipeline` instance holds session state in memory and generates a one-time report on stop.

---

## Training Data Generation

### Strategy

All training data is generated programmatically. No manual labeling is required.

### Guitar Samples Source

- Record a bank of dry (unprocessed) guitar samples:
  - Single notes across the fretboard (every fret, every string, various picking dynamics)
  - Power chords (common voicings)
  - Double stops (common intervals: 3rds, 4ths, 5ths, octaves)
- Alternatively, source from royalty-free sample libraries or synthesize using physical modeling (e.g., Karplus-Strong)

### Augmentation Pipeline

For each training example:

1. Select sample(s) from the bank
2. Apply random amp sim / distortion (vary gain from clean to high-gain)
3. Apply random EQ, compression, reverb
4. Apply slight pitch shift (±50 cents) and time stretch
5. Place on a timeline at known positions
6. Optionally layer with metronome clicks at known tempo
7. Add background noise:
   - Guitar-inherent: amp hiss, string noise, pickup buzz, fret rattle
   - Room tone: ambient room noise at various levels
   - Environmental: appliance hum (fridge, HVAC, dishwasher), vehicle noise (engines, motorcycles), street noise (sirens, horns, traffic), household sounds (TV bleed, conversations, dogs barking)
   - This ensures onset detection and pitch models are robust to the same noise the denoiser may not fully remove

### Labels

- **Noise filtering model:** clean guitar + metronome signal as target (model learns to remove environmental noise)
- **Onset detection model:** binary onset labels at known sample placement times
- **Pitch detection model:** MIDI note number(s) at each onset
- **Source separation model:** clean metronome track and clean guitar track as targets

### Dataset Size

- 10,000+ synthetic clips for noise filtering (clean guitar+metronome mixed with diverse environmental noise)
- 10,000+ synthetic clips for onset detection
- 5,000+ for pitch detection
- 5,000+ for source separation
- Validate on real recorded guitar (record yourself playing known riffs with known timing)
- For noise filtering validation: record real sessions with intentional background noise (appliances running, window open to street noise) to test robustness

---

## V2 Features (Future)

### Bend Detection

- Detect pitch modulation after an onset
- Classify as bend (half step, full step, etc.) vs vibrato vs stable pitch
- Display in notation with bend arrows
- Requires continuous pitch tracking (CREPE is good for this) rather than just onset-time pitch

### Swing Rhythm

- Add swing grid option: instead of even subdivisions, the grid alternates long-short
- User selects swing amount (e.g., 50% = straight, 67% = triplet swing)
- Grid alignment math adjusts accordingly
- Deviation calculation remains the same, just against the swung grid

### Additional V2 Considerations

- Built-in metronome (eliminates source separation requirement)
- Session history and progress tracking over time
- Practice suggestions based on common timing errors
- Support for other time signatures (3/4, 6/8)
- More complex chord detection

---

## Project Structure

```
ml-rhythm/
├── backend/
│   ├── app.py                      # Litestar application entry point
│   ├── requirements.txt
│   ├── api/
│   │   └── routes.py               # WebSocket & HTTP route handlers
│   ├── audio/
│   │   ├── pipeline.py             # Main audio processing orchestration & NoteEvent dataclass
│   │   ├── onset_detector.py       # RealtimeOnsetDetector (energy-based, adaptive RMS)
│   │   ├── metronome_detector.py   # MetronomeDetector (periodicity analysis, grid refinement)
│   │   ├── grid_aligner.py         # GridConfig (beat grid math, deviation calculation)
│   │   ├── calibration.py          # Spectral feature extraction (MFCC, centroid, decay) & classification
│   │   └── onset_classifier.py     # Supplementary spectral utilities
│   └── sessions/                   # Recorded session WAV files (generated at runtime)
├── frontend/
│   ├── index.html
│   ├── vite.config.ts              # Vite config with WebSocket proxy to backend
│   ├── tsconfig.json
│   ├── package.json
│   ├── public/
│   │   └── audio-worklet-processor.js  # AudioWorklet for real-time audio capture
│   └── src/
│       ├── main.tsx                # React entry point
│       ├── App.tsx                 # Root component & state machine (idle/active/report/calibrating)
│       ├── App.css
│       ├── components/
│       │   ├── SessionControls.tsx     # Start/stop, grid selector, threshold slider
│       │   ├── RealTimeFeedback.tsx    # Live BPM, grid dots, current deviation
│       │   ├── SessionReport.tsx       # Post-session stats & tabbed report view
│       │   ├── NotationDisplay.tsx     # VexFlow notation with timing coloring
│       │   ├── AudioPlayback.tsx       # HTML5 audio player
│       │   ├── WaveformDisplay.tsx     # Canvas waveform with onset markers
│       │   └── CalibrationWizard.tsx   # Guided metronome & guitar profile recording
│       ├── hooks/
│       │   ├── useWebSocket.ts         # WebSocket connection management
│       │   └── useAudioCapture.ts      # Web Audio API & AudioWorklet capture
│       ├── types/
│       │   └── session.ts              # TypeScript interfaces
│       └── utils/
│           ├── timing.ts               # Timing utility functions
│           └── saveSession.ts          # Session export functionality
├── design.md                       # This design document
└── README.md
```

### Planned directories (not yet created)

```
├── backend/
│   ├── models/                     # PyTorch model definitions (noise, onset, separation, pitch)
│   └── training/                   # Training scripts, data generation, augmentation utilities
```

---

## Implementation Status

### Completed

- Audio capture via Web Audio API + AudioWorklet → WebSocket → backend
- Energy-based real-time onset detection (adaptive RMS with hysteresis)
- Metronome detection via periodicity analysis (auto BPM, no manual input needed)
- Beat grid establishment and continuous refinement via linear regression
- Spectral calibration for click vs guitar classification (MFCC-based)
- Grid alignment and signed timing deviation calculation
- Real-time WebSocket event streaming (click_detected, grid_established, note_event)
- Session report generation with timing statistics
- Metronome quality analysis (jitter, drift, consistency)
- React frontend with real-time timing feedback display
- Post-session report with stats visualization
- Notation rendering with VexFlow (rhythm-only, color-coded by timing)
- Audio recording (server-side WAV) and playback
- Waveform display with onset markers
- Calibration wizard for spectral profile building
- Configurable timing thresholds (5–50ms)

### Not Yet Implemented

- Environmental noise filtering (spectral gating + ML denoiser)
- ML source separation (metronome vs guitar isolation)
- Neural onset detection model (for distorted guitar)
- Pitch detection (CREPE, pYIN, or custom model)
- Timing deviation histogram
- Session history and progress tracking
- Noise level indicator / warning UI

### Future (V2)

- Bend detection
- Swing rhythm support
- Built-in metronome option (eliminates source separation requirement)
- Other time signatures (3/4, 6/8)
- Practice suggestions based on common timing errors