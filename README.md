# ml-rhythm

A web application that listens to a guitarist playing along to an external metronome and provides real-time feedback on timing accuracy. After a session, it generates a report showing timing deviations, musical notation, and statistics to help guitarists improve their rhythmic precision.

## How It Works

1. Open the app and optionally run the calibration wizard (records metronome clicks and guitar notes to build spectral profiles)
2. Select grid resolution (8th or 16th notes) and timing threshold
3. Click "Start" and begin playing along to your external metronome
4. The app detects the metronome via periodicity analysis and establishes a beat grid automatically — no need to enter BPM
5. As you play, real-time timing feedback shows how early or late each note is
6. Click "Stop" to view a full session report with notation, statistics, and audio playback

## Tech Stack

**Frontend:**
- React 19 (TypeScript)
- Vite 6
- VexFlow 5 (music notation rendering)
- Web Audio API + AudioWorklet (microphone capture and streaming)

**Backend:**
- Python / Litestar 2 (async ASGI framework)
- Uvicorn (ASGI server)
- librosa (audio analysis)
- NumPy / SciPy (numerical processing)
- soundfile (WAV I/O)

**Communication:** WebSocket with binary framing (control messages + raw PCM audio)

## Prerequisites

- Python 3.10+
- Node.js 18+
- npm

## Setup

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
```

### Frontend

```bash
cd frontend
npm install
```

## Running

Start both the backend and frontend dev servers:

```bash
# Terminal 1 — backend (runs on http://localhost:8000)
cd backend
python app.py

# Terminal 2 — frontend (runs on http://localhost:5173)
cd frontend
npm run dev
```

The Vite dev server proxies WebSocket connections (`/ws/*`) and the health endpoint to the backend automatically.

## Project Structure

```
ml-rhythm/
├── backend/
│   ├── app.py                      # Litestar app entry point
│   ├── requirements.txt
│   ├── api/
│   │   └── routes.py               # WebSocket & HTTP route handlers
│   ├── audio/
│   │   ├── pipeline.py             # Main audio processing orchestration
│   │   ├── onset_detector.py       # Energy-based real-time onset detection
│   │   ├── metronome_detector.py   # Periodicity analysis & beat grid detection
│   │   ├── grid_aligner.py         # Beat grid math & deviation calculation
│   │   ├── calibration.py          # Spectral feature extraction (MFCC) & classification
│   │   └── onset_classifier.py     # Supplementary spectral utilities
│   └── sessions/                   # Recorded session WAV files
├── frontend/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   ├── public/
│   │   └── audio-worklet-processor.js  # AudioWorklet for real-time capture
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                  # Root component & state management
│       ├── App.css
│       ├── components/
│       │   ├── SessionControls.tsx      # Start/stop, grid & threshold controls
│       │   ├── RealTimeFeedback.tsx     # Live BPM & timing display
│       │   ├── SessionReport.tsx        # Post-session report view
│       │   ├── NotationDisplay.tsx      # VexFlow notation rendering
│       │   ├── AudioPlayback.tsx        # Audio player
│       │   ├── WaveformDisplay.tsx      # Waveform visualization with onset markers
│       │   └── CalibrationWizard.tsx    # Guided metronome/guitar calibration
│       ├── hooks/
│       │   ├── useWebSocket.ts          # WebSocket connection management
│       │   └── useAudioCapture.ts       # Web Audio API & AudioWorklet
│       ├── types/
│       │   └── session.ts               # TypeScript interfaces
│       └── utils/
│           ├── timing.ts                # Timing utility functions
│           └── saveSession.ts           # Session export
├── design.md                       # Technical design document
└── README.md
```

## Audio Processing Pipeline

```
Raw Microphone Audio (via WebSocket)
    │
    ▼
[Onset Detector] — adaptive RMS-based energy detection with hysteresis
    │
    ▼
[Metronome Detector] — periodicity analysis on inter-onset intervals
    │                   locks after finding 4+ periodic onsets
    │                   refines grid via linear regression every 4 clicks
    │
    ▼
[Onset Classifier] — timing proximity + spectral features (MFCC)
    │                  distinguishes metronome clicks from guitar notes
    │                  (spectral classification requires calibration)
    │
    ▼
[Grid Aligner] — snaps guitar onsets to nearest grid position
    │              computes signed deviation in milliseconds
    │
    ▼
Real-time WebSocket events + final session report
```

## WebSocket Protocol

The app uses a binary-framed WebSocket protocol:

- **Client → Server:** Binary frames with 1-byte prefix
  - `0x00` + JSON: control messages (`start`, `stop`, `calibrate`, `stop_calibration`)
  - `0x01` + Float32 PCM: audio samples
- **Server → Client:** JSON text frames
  - `click_detected`, `grid_established`, `note_event`, `session_report`, `calibration_result`
