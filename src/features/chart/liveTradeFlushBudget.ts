export const DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT = 1_000;
export const DEFAULT_LIVE_TRADE_PENDING_BUFFER_CAP = 10_000;
export const DEFAULT_LIVE_TRADE_OVERFLOW_HEADROOM = DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT;
export const DEFAULT_LIVE_TRADE_FLUSH_BUDGET_MS = 4;
export const DEFAULT_LIVE_TRADE_SUB_BATCH_LIMIT = 100;

/** Returns the ordered trade ceiling for one scheduler turn. */
export function nextLiveTradeFlushBatchSize(
  pendingCount: number,
  maxTradesPerTurn = DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT,
): number {
  if (!Number.isFinite(pendingCount) || pendingCount <= 0) return 0;
  if (!Number.isFinite(maxTradesPerTurn) || maxTradesPerTurn < 1) return 0;
  const pending = Math.floor(pendingCount);
  const limit = Math.floor(maxTradesPerTurn);
  return Math.min(pending, limit);
}

/** Small indivisible chunk between cooperative wall-clock budget checks. */
export function nextLiveTradeSubBatchSize(
  remainingCount: number,
  maxTradesPerSubBatch = DEFAULT_LIVE_TRADE_SUB_BATCH_LIMIT,
): number {
  if (!Number.isFinite(remainingCount) || remainingCount <= 0) return 0;
  if (!Number.isFinite(maxTradesPerSubBatch) || maxTradesPerSubBatch < 1) return 0;
  return Math.min(Math.floor(remainingCount), Math.floor(maxTradesPerSubBatch));
}

/**
 * Cooperative target only: a single indivisible series operation may itself exceed the
 * budget, but no additional sub-batch starts after the target has elapsed.
 */
export function liveTradeFlushBudgetExpired(
  startedAt: number,
  now: number,
  processedTrades: number,
  budgetMs = DEFAULT_LIVE_TRADE_FLUSH_BUDGET_MS,
): boolean {
  if (processedTrades <= 0) return false;
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return false;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return true;
  return now - startedAt >= budgetMs;
}

/**
 * Legacy headroom calculation kept for telemetry/tests that reason about the safety
 * threshold. Runtime overflow recovery no longer performs this prefix synchronously.
 */
export function overflowRecoveryBatchSize(
  pendingCount: number,
  bufferCap = DEFAULT_LIVE_TRADE_PENDING_BUFFER_CAP,
  targetHeadroom = DEFAULT_LIVE_TRADE_OVERFLOW_HEADROOM,
): number {
  if (!Number.isFinite(pendingCount) || pendingCount <= 0) return 0;
  if (!Number.isFinite(bufferCap) || bufferCap < 1) return 0;
  if (!Number.isFinite(targetHeadroom) || targetHeadroom < 1) return 0;

  const pending = Math.floor(pendingCount);
  const cap = Math.floor(bufferCap);
  const headroom = Math.min(Math.floor(targetHeadroom), cap);
  const targetPending = cap - headroom;
  if (pending <= targetPending) return 0;
  return Math.min(pending, pending - targetPending);
}
