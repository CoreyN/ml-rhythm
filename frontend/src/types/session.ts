export type GridResolution = "8th" | "16th";

export type AppState = "idle" | "active" | "report" | "calibrating";

export interface NoteEvent {
  time: number;
  nearest_grid_time: number;
  deviation_ms: number;
  event_type: "note" | "rest" | "extra";
  pitch: string | null;
  bar: number;
  beat_position: number;
  is_on_time: boolean;
}

export interface SessionStats {
  total_notes: number;
  mean_absolute_deviation_ms: number;
  mean_signed_deviation_ms: number;
  std_deviation_ms: number;
  median_deviation_ms: number;
  worst_deviation_ms: number;
  worst_deviation_position: string;
  accuracy_percent: number;
}

export interface MetronomeStats {
  total_clicks: number;
  expected_interval_ms: number;
  jitter_ms: number;
  mean_error_ms: number;
  max_error_ms: number;
  drift_ms_per_beat: number;
  tight_percent: number;
  ok_percent: number;
  error?: string;
}

export interface SessionReport {
  type: "session_report";
  bpm: number;
  grid_resolution: GridResolution;
  total_bars: number;
  events: NoteEvent[];
  stats: SessionStats;
  metronome_stats?: MetronomeStats;
  click_times?: number[];
  error?: string;
}

export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface SourceProfile {
  mfcc_mean: number[];
  spectral_centroid: number;
  energy_decay: number;
  onset_count: number;
}

export interface CalibrationProfile {
  metronome: SourceProfile;
  guitar: SourceProfile;
  calibrated_at: string;
}
