export const RECENT_COVERAGE_RETRY_DELAYS_MS = [
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
  60_000,
  60_000,
  60_000,
] as const;

export const RECENT_COVERAGE_RETRY_STEADY_MS = 60_000;
export const RECENT_COVERAGE_PROGRESS_RETRY_MAX_MS = 60_000;

export type RecentCoverageRetryReason = "transient" | "progress";
export type LiveRepairRetryReason = "snapshot_pending" | "transport" | "continuity";
const LIVE_REPAIR_FAST_RETRY_MS = [250, 500, 1_000] as const;

export function recentCoverageRetryDelayMs(
  attempt: number,
  reason: RecentCoverageRetryReason = "transient",
): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return RECENT_COVERAGE_RETRY_DELAYS_MS[0];
  const index = Math.floor(attempt);
  const baseDelay = index < RECENT_COVERAGE_RETRY_DELAYS_MS.length
    ? RECENT_COVERAGE_RETRY_DELAYS_MS[index]
    : RECENT_COVERAGE_RETRY_STEADY_MS;
  return reason === "progress" ? Math.min(baseDelay, RECENT_COVERAGE_PROGRESS_RETRY_MAX_MS) : baseDelay;
}

export function liveRepairRetryDelayMs(attempt: number, reason: LiveRepairRetryReason): number {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const fast = reason === "snapshot_pending" || reason === "continuity";
  if (fast && index < LIVE_REPAIR_FAST_RETRY_MS.length) return LIVE_REPAIR_FAST_RETRY_MS[index];
  return recentCoverageRetryDelayMs(fast ? Math.max(0, index - LIVE_REPAIR_FAST_RETRY_MS.length) : index);
}

/**
 * How long a validated repair snapshot may wait for the trade stream to prove itself
 * before the ladder takes over. The snapshot is already correct as of its watermark and
 * every trade since is buffered, so holding it costs nothing but staleness; re-fetching
 * instead returns a byte-identical body and burns a ladder step.
 */
export const LIVE_REPAIR_EVIDENCE_WAIT_MS = 8_000;

/**
 * How long a live repair may keep failing before the chart stops calling it "repairing" (#315).
 * About the transport ladder's fast part (1+2+4+8+15+30+60+60+60 s); retries then continue
 * at the ladder's steady 60 s, but the chart reads as failed until one succeeds.
 */
export const LIVE_REPAIR_UNRESOLVED_AFTER_MS = 4 * 60_000;
