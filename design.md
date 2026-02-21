# Guitar Timing Practice App — Design Document

## Overview

A web application that listens to a guitarist playing along to an external metronome and provides real-time feedback on timing accuracy. After a session, it displays a report showing what was played (as musical notation), which notes were early/late, and by how much. Sessions can be recorded and played back alongside the report.

---

## Core User Flow

1. User opens the app
2. Selects grid resolution (8th notes or 16th notes)
3. Clicks "Start"
4. Starts their external metronome and plays guitar
5. App listens, detects the metronome to establish tempo/grid, detects guitar onsets, and provides real-time timing feedback
6. User clicks "Stop"
7. App displays a full session report with notation, timing deviations, and audio playback

The user should not need to manually enter BPM, tap a tempo, or do anything beyond clicking start and selecting grid resolution.

---

## Technical Architecture

### Stack

- **Frontend:** React (TypeScript)
- **Backend:** Python, Litestar
- **ML Framework:** PyTorch
- **Audio I/O:** Web Audio API (frontend), streamed to backend via WebSocket

### High-Level Architecture

```
[Microphone/Audio Interface]
        |
  [Web Audio API] — captures raw audio
        |
  [WebSocket stream]
        |
  [Litestar Backend]
        |
  ┌─────┴──────────────────────┐
  │  Audio Processing Pipeline │
  │                            │
  │  1. Source Separation       │
  │     (metronome vs guitar)  │
  │                            │
  │  2. Metronome Analysis     │
  │     → tempo & grid         │
  │                            │
  │  3. Onset Detection        │
  │     (guitar signal)        │
  │                            │
  │  4. Pitch Detection        │
  │     (single notes, power   │
  │      chords, double stops) │
  │                            │
  │  5. Grid Alignment         │
  │     → snap onsets to grid  │
  │     → compute deviations   │
  │                            │
  └────────────────────────────┘
        |
  [WebSocket — real-time results]
        |
  [React Frontend]
  → real-time timing indicators
  → session report & notation
  → audio playback
```

---

## Pipeline Detail

### 1. Source Separation

**Problem:** The app receives a mixed signal containing both the metronome click and the guitar. These must be separated to independently analyze tempo (from the click) and note timing (from the guitar).

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

### 2. Metronome Analysis

**Input:** Isolated or filtered metronome signal.

**Approach:**

- Detect click onsets (standard energy-based onset detection is fine here since clicks are clean transients)
- Compute inter-onset intervals (IOI)
- Derive tempo (BPM) from median IOI
- Establish the beat grid: a series of expected beat times, subdivided to the user-selected resolution (8th or 16th notes)
- The grid should stabilize after 2–4 beats and then track any minor tempo drift in the metronome (most will be rock-solid, but cheap metronomes can drift)

**Latency consideration:** The app cannot provide timing feedback until the grid is established (minimum ~2 beats). The UI should indicate "listening for tempo..." during this phase.

### 3. Onset Detection (Guitar)

**Input:** Isolated or filtered guitar signal.

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

### 4. Pitch Detection

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

### 5. Grid Alignment & Deviation Calculation

**Input:** Detected onset times + established beat grid.

**Process:**

- For each detected onset, find the nearest grid position (8th or 16th note subdivision)
- Calculate signed deviation: `onset_time - nearest_grid_time`
  - Negative = early
  - Positive = late
  - Magnitude in milliseconds
- For rests: identify grid positions with no onset within a threshold window and mark as rests
- Flag "extra" onsets that don't correspond to any expected grid position (ghost notes, accidental string hits)

**Thresholds (configurable):**

- "In time": within ±10ms (tight) to ±30ms (loose) — make this user-configurable
- "Rest": no onset within ±threshold of a grid position

---

## Real-Time Considerations

### Latency Budget

For real-time feedback, the full pipeline (audio capture → processing → display) should target <100ms total latency.

- Audio capture buffer: ~10–20ms (512–1024 samples at 44.1kHz)
- Processing: must be fast enough to keep up with the audio stream
- WebSocket round-trip: ~1–5ms (localhost-like, since backend is local or low-latency)
- Display update: next animation frame (~16ms)

### Streaming Architecture

- Frontend captures audio in chunks via Web Audio API (ScriptProcessorNode or AudioWorklet)
- Chunks are streamed to backend over WebSocket as raw PCM or compressed audio
- Backend processes each chunk incrementally (maintains rolling state)
- Results are streamed back over the same WebSocket
- Frontend updates display in real-time

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

**Notation rendering:** Use **VexFlow** (JavaScript music notation library) to render standard rhythmic notation. If pitch detection is active, display on a staff with correct pitches. Otherwise, render as rhythm-only on a single-line percussion-style staff.

**Audio playback:** The raw audio from the session is recorded on the frontend (MediaRecorder API) and can be played back. Playback position is synced with the notation display so the user can see which note is being heard.

---

## Data Models

### Session

```python
@dataclass
class Session:
    id: str
    started_at: datetime
    ended_at: datetime | None
    grid_resolution: Literal["8th", "16th"]
    detected_bpm: float | None
    timing_threshold_ms: float  # user-configurable tolerance
    events: list[NoteEvent]
    audio_blob_id: str | None  # reference to recorded audio
```

### NoteEvent

```python
@dataclass
class NoteEvent:
    time_seconds: float            # actual onset time in session
    nearest_grid_time: float       # snapped grid position
    deviation_ms: float            # signed: negative=early, positive=late
    event_type: Literal["note", "rest", "extra"]
    pitch: str | None              # e.g. "E2", "A5(power)", None if unknown
    bar: int                       # which bar (1-indexed)
    beat_position: float           # position within bar (e.g. 1.0, 1.5, 2.25)
```

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
7. Add background noise (room tone, amp hiss, string noise)

### Labels

- **Onset detection model:** binary onset labels at known sample placement times
- **Pitch detection model:** MIDI note number(s) at each onset
- **Source separation model:** clean metronome track and clean guitar track as targets

### Dataset Size

- Aim for 10,000+ synthetic clips for onset detection
- 5,000+ for pitch detection
- 5,000+ for source separation
- Validate on real recorded guitar (record yourself playing known riffs with known timing)

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
guitar-timing-app/
├── backend/
│   ├── app.py                    # Litestar application entry point
│   ├── api/
│   │   ├── routes.py             # HTTP & WebSocket routes
│   │   └── schemas.py            # Request/response schemas
│   ├── audio/
│   │   ├── pipeline.py           # Main audio processing pipeline
│   │   ├── source_separation.py  # Metronome/guitar separation
│   │   ├── metronome_detector.py # Tempo & beat grid detection
│   │   ├── onset_detector.py     # Guitar onset detection
│   │   ├── pitch_detector.py     # Pitch/chord identification
│   │   └── grid_aligner.py       # Grid snapping & deviation calc
│   ├── models/
│   │   ├── onset_model.py        # PyTorch onset detection model
│   │   ├── separation_model.py   # PyTorch source separation model
│   │   └── pitch_model.py        # PyTorch pitch model (if needed)
│   ├── training/
│   │   ├── data_generator.py     # Synthetic training data pipeline
│   │   ├── train_onset.py        # Onset model training script
│   │   ├── train_separation.py   # Separation model training script
│   │   └── augmentations.py      # Audio augmentation utilities
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── SessionControls.tsx    # Start/stop, grid selector
│   │   │   ├── RealTimeFeedback.tsx   # Live timing display
│   │   │   ├── SessionReport.tsx      # Post-session report
│   │   │   ├── NotationDisplay.tsx    # VexFlow notation rendering
│   │   │   ├── TimingHistogram.tsx    # Deviation distribution chart
│   │   │   └── AudioPlayback.tsx      # Recorded audio player
│   │   ├── hooks/
│   │   │   ├── useAudioCapture.ts     # Web Audio API mic capture
│   │   │   └── useWebSocket.ts        # WebSocket connection mgmt
│   │   └── types/
│   │       └── session.ts             # TypeScript type definitions
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

---

## Implementation Priority

### Phase 1 — Proof of Concept

1. Audio capture (frontend) → WebSocket → backend
2. Basic onset detection (librosa/madmom, no custom ML yet)
3. Manual BPM input (skip metronome detection initially)
4. Grid alignment and deviation calculation
5. Simple text-based report (no notation yet)

### Phase 2 — Core Features

6. Metronome detection (source separation or spectral filtering)
7. Custom onset detection model (trained on distorted guitar)
8. Real-time feedback display
9. Notation rendering with VexFlow
10. Audio recording and playback

### Phase 3 — Polish

11. Pitch detection integration
12. Session statistics and histograms
13. Configurable timing thresholds
14. UI polish and mobile responsiveness

### Phase 4 — V2

15. Bend detection
16. Swing rhythm support
17. Built-in metronome option
18. Session history / progress tracking