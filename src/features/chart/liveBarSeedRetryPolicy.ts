/**
 * Retry policy for the REST seed of the still-open bucket.
 *
 * History snapshots stop at `startTime < liveBucket`, so the open candle has no REST
 * seed at all and starts from whatever price the first post-load websocket trade
 * happened to print. The seed that repairs it must survive a slow or briefly failing
 * backend, but it must also stop: a market whose open bucket has genuinely not traded
 * would otherwise poll forever, once per chart panel.
 */

/** Backoff before the retry with the matching index; later attempts hold at steady state. */
export const LIVE_BAR_SEED_RETRY_DELAYS_MS = [
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  20_000,
] as const;

export const LIVE_BAR_SEED_RETRY_STEADY_MS = 20_000;

/**
 * Give up this long after the load settled. Long enough to ride out a backend
 * restart or a short offline stretch, short enough that a bucket which simply has
 * no trades stops costing a request every 20s for the rest of the session.
 */
export const LIVE_BAR_SEED_DEADLINE_MS = 5 * 60_000;

/**
 * An empty response only proves the bucket has not traded once it repeats. A single
 * empty answer is just as likely to be a backend that has not yet built the open
 * bucket, and that is precisely the case the seed exists to repair.
 */
export const LIVE_BAR_SEED_EMPTY_CONFIRMATIONS = 2;

/** Why an attempt did not seed the open bucket. */
export type LiveBarSeedRetryReason = "empty" | "failed";

export interface LiveBarSeedRetryInput {
  reason: LiveBarSeedRetryReason;
  /** Milliseconds since the seed was scheduled. */
  elapsedMs: number;
  /** Consecutive attempts that returned no bar for the open bucket, including this one. */
  consecutiveEmpty: number;
  /** The series already carries a websocket bar for the bucket REST reported empty. */
  hasLiveBar: boolean;
}

/** Backoff before attempt `attempt` (0 is the first retry after the initial request). */
export function liveBarSeedRetryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return LIVE_BAR_SEED_RETRY_DELAYS_MS[0];
  const index = Math.floor(attempt);
  return index < LIVE_BAR_SEED_RETRY_DELAYS_MS.length
    ? LIVE_BAR_SEED_RETRY_DELAYS_MS[index]
    : LIVE_BAR_SEED_RETRY_STEADY_MS;
}

export function shouldRetryLiveBarSeed(input: LiveBarSeedRetryInput): boolean {
  if (!(input.elapsedMs < LIVE_BAR_SEED_DEADLINE_MS)) return false;
  if (input.reason === "failed") return true;
  // Both sources agree the bucket is untraded, so the first websocket trade to arrive
  // is genuinely its open and there is nothing left to seed.
  if (!input.hasLiveBar && input.consecutiveEmpty >= LIVE_BAR_SEED_EMPTY_CONFIRMATIONS) return false;
  return true;
}
