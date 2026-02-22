import type { SessionReport, NoteEvent } from "../types/session";

/** Encode a Float32Array as a 16-bit mono PCM WAV blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);          // subchunk1 size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Convert Float32 [-1, 1] → Int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Format the session report as a human-readable log string. */
function buildLogText(report: SessionReport, filename: string): string {
  const now = new Date().toLocaleString();
  const lines: string[] = [
    `Rhythm Session Log`,
    `File: ${filename}`,
    `Date: ${now}`,
    ``,
    `=== Session Summary ===`,
    `BPM:            ${report.bpm}`,
    `Grid:           ${report.grid_resolution} notes`,
    `Bars:           ${report.total_bars}`,
    ``,
    `=== Statistics ===`,
    `Notes played:   ${report.stats.total_notes}`,
    `Accuracy:       ${report.stats.accuracy_percent}%`,
    `Mean deviation: ${report.stats.mean_absolute_deviation_ms}ms (absolute)`,
    `Signed mean:    ${report.stats.mean_signed_deviation_ms}ms`,
    `Std deviation:  ${report.stats.std_deviation_ms}ms`,
    `Median:         ${report.stats.median_deviation_ms}ms`,
    `Worst:          ${report.stats.worst_deviation_ms}ms at ${report.stats.worst_deviation_position}`,
    ``,
  ];

  const ms = report.metronome_stats;
  if (ms && !ms.error) {
    lines.push(
      `=== Metronome Quality ===`,
      `Clicks detected: ${ms.total_clicks}`,
      `Expected interval: ${ms.expected_interval_ms}ms`,
      `Jitter (std):   ${ms.jitter_ms}ms`,
      `Avg error:      ${ms.mean_error_ms}ms`,
      `Worst click:    ${ms.max_error_ms}ms off`,
      `Drift:          ${ms.drift_ms_per_beat}ms/beat`,
      `Within 2ms:     ${ms.tight_percent}%`,
      `Within 5ms:     ${ms.ok_percent}%`,
      ``,
    );
  }

  lines.push(
    `=== Note Events ===`,
    `${"Bar".padEnd(6)}${"Beat".padEnd(8)}${"Time(s)".padEnd(10)}${"Grid(s)".padEnd(10)}${"Dev(ms)".padEnd(10)}On Time`,
  );

  for (const e of report.events as NoteEvent[]) {
    const dev = (e.deviation_ms > 0 ? "+" : "") + e.deviation_ms;
    lines.push(
      `${String(e.bar).padEnd(6)}${String(e.beat_position).padEnd(8)}${e.time.toFixed(3).padEnd(10)}${e.nearest_grid_time.toFixed(3).padEnd(10)}${dev.padEnd(10)}${e.is_on_time ? "yes" : "no"}`
    );
  }

  return lines.join("\n");
}

/** Download a blob as a file. */
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Save audio as .wav and session log as .txt with the same base name. */
export function saveSession(
  report: SessionReport,
  audio: Float32Array | null,
  sampleRate: number
): void {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const base = `rhythm_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  const wavName = `${base}.wav`;
  const txtName = `${base}.txt`;

  if (audio) {
    download(encodeWav(audio, sampleRate), wavName);
  }

  const logText = buildLogText(report, wavName);
  download(new Blob([logText], { type: "text/plain" }), txtName);
}
