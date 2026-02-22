/**
 * Return a CSS color based on how far a note deviates from the grid.
 * Green = tight, yellow = within threshold, red = over threshold.
 */
export function deviationColor(ms: number, threshold = 30): string {
  const abs = Math.abs(ms);
  if (abs <= threshold * 0.5) return "var(--green)";
  if (abs <= threshold) return "var(--yellow)";
  return "var(--red)";
}

/**
 * Return a hex color (for VexFlow rendering, which doesn't support CSS vars).
 */
export function deviationHex(ms: number, threshold = 30): string {
  const abs = Math.abs(ms);
  if (abs <= threshold * 0.5) return "#4ade80";
  if (abs <= threshold) return "#fbbf24";
  return "#f87171";
}
