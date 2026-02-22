import { useState } from "react";
import type { GridResolution } from "../types/session";

interface Props {
  onStart: (grid: GridResolution, threshold: number) => void;
  onStop: () => void;
  isActive: boolean;
  onRecalibrate?: () => void;
  calibratedAt?: string;
}

export function SessionControls({ onStart, onStop, isActive, onRecalibrate, calibratedAt }: Props) {
  const [grid, setGrid] = useState<GridResolution>("8th");
  const [threshold, setThreshold] = useState(30);

  if (isActive) {
    return (
      <div className="controls">
        <button className="stop-btn" onClick={onStop}>
          Stop Session
        </button>
      </div>
    );
  }

  return (
    <div className="controls">
      <div className="control-group">
        <label>Grid</label>
        <select
          value={grid}
          onChange={(e) => setGrid(e.target.value as GridResolution)}
        >
          <option value="8th">8th Notes</option>
          <option value="16th">16th Notes</option>
        </select>
      </div>
      <div className="control-group">
        <label>Threshold: &plusmn;{threshold}ms</label>
        <input
          type="range"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          min={5}
          max={50}
          step={5}
        />
      </div>
      <button
        className="start-btn"
        onClick={() => onStart(grid, threshold)}
      >
        Start Session
      </button>
      {onRecalibrate && (
        <div className="recalibrate-row">
          <button className="recalibrate-btn" onClick={onRecalibrate}>
            Recalibrate
          </button>
          {calibratedAt && (
            <span className="calibration-date">
              Last calibrated {new Date(calibratedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
