export interface LiveAutoFitSnapshot {
  readonly from: number;
  readonly to: number;
  readonly min: number;
  readonly max: number;
}

export type LiveAutoFitDecisionReason =
  | "no-snapshot"
  | "viewport-changed"
  | "invalid-extrema"
  | "tail-offscreen"
  | "contained"
  | "new-extrema";

export interface LiveAutoFitDecision {
  readonly shouldAutoFit: boolean;
  readonly reason: LiveAutoFitDecisionReason;
}

/**
 * Decide whether a same-bar live mutation can reuse the current auto-scaled Y range.
 * Live trades can only expand a candle's high/low; they cannot contract historical
 * extrema. Therefore a visible tail that remains inside the raw extrema captured by
 * the previous full auto-fit cannot change the exact autoscale result.
 */
export function decideLiveSameBarAutoFit(
  snapshot: LiveAutoFitSnapshot | null,
  current: { readonly from: number; readonly to: number },
  tailIndex: number,
  low: number,
  high: number,
): LiveAutoFitDecision {
  if (!snapshot) return { shouldAutoFit: true, reason: "no-snapshot" };
  if (snapshot.from !== current.from || snapshot.to !== current.to) {
    return { shouldAutoFit: true, reason: "viewport-changed" };
  }
  if (![snapshot.min, snapshot.max, low, high].every(Number.isFinite) || low > high) {
    return { shouldAutoFit: true, reason: "invalid-extrema" };
  }
  if (tailIndex < current.from || tailIndex >= current.to) {
    return { shouldAutoFit: false, reason: "tail-offscreen" };
  }
  if (low < snapshot.min || high > snapshot.max) {
    return { shouldAutoFit: true, reason: "new-extrema" };
  }
  return { shouldAutoFit: false, reason: "contained" };
}
