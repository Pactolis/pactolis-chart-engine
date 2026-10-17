import type { FootprintBar } from "../../core/types.js";
import type { EnvelopeMeta } from "../../core/envelope.js";
import { bucketStart } from "../../core/time.js";
import type { HistoryQuery } from "./historyContracts.js";

/** Client-side upper bounds for one history request/application window. */
export const HISTORY_MAX_WINDOW_BARS = 20_000;
export const HISTORY_MAX_WINDOW_CELLS = 800_000;

function previousBucketStart(bucket: number, interval: number): number {
  if (!Number.isFinite(bucket) || !Number.isFinite(interval) || interval <= 0) {
    throw new RangeError("history bucket planner requires finite inputs");
  }
  const previous = bucketStart(bucket - 1, interval);
  if (!Number.isFinite(previous) || previous >= bucket) {
    throw new RangeError("history bucket planner made no progress");
  }
  return previous;
}

/**
 * Split a history range into non-overlapping, newest-first requests. The wire
 * query shape is unchanged; only the `from`/`to` range is narrowed. Window
 * boundaries are derived from eligible bucket starts, not raw millisecond
 * subtraction, so fixed, weekly and calendar-month intervals partition exactly.
 */
export function planHistoryWindows(q: HistoryQuery, maxBars = HISTORY_MAX_WINDOW_BARS): HistoryQuery[] {
  if (!Number.isFinite(q.from) || !Number.isFinite(q.to) || !Number.isFinite(q.interval) || q.interval <= 0) {
    throw new RangeError("history window endpoints and interval must be finite");
  }
  if (!Number.isFinite(maxBars) || maxBars < 1) {
    throw new RangeError("history window maxBars must be finite and positive");
  }
  if (q.to < q.from) {
    return [{ ...q }];
  }
  const limit = Math.max(1, Math.floor(maxBars));
  const oldestBucket = bucketStart(q.from, q.interval);
  let newestBucket = bucketStart(q.to, q.interval);
  if (!Number.isFinite(oldestBucket) || !Number.isFinite(newestBucket)) {
    throw new RangeError("history bucket planner could not derive finite buckets");
  }
  let nextTo = q.to;
  const windows: HistoryQuery[] = [];

  for (;;) {
    let windowFromBucket = newestBucket;
    let bucketCount = 1;
    while (bucketCount < limit && windowFromBucket > oldestBucket) {
      const previous = previousBucketStart(windowFromBucket, q.interval);
      windowFromBucket = previous;
      bucketCount++;
    }
    const reachesOldest = windowFromBucket <= oldestBucket;
    windows.push({
      ...q,
      from: reachesOldest ? q.from : windowFromBucket,
      to: nextTo,
    });
    if (reachesOldest) break;
    const previousTo = windowFromBucket - 1;
    if (!Number.isFinite(previousTo) || previousTo >= nextTo) {
      throw new RangeError("history window planner made no progress");
    }
    nextTo = previousTo;
    newestBucket = previousBucketStart(windowFromBucket, q.interval);
  }
  return windows;
}

export const CELL_CHUNK_BARS = 400;
export const FIRST_CELL_CHUNK_BARS = 25;

export interface HistoryWindowSplit {
  newest: HistoryQuery;
  older: HistoryQuery | null;
}

/** Keep complete bars while shrinking an oversized response, retaining newest data first. */
export function splitOversizedHistoryWindow(
  query: HistoryQuery,
  bars: readonly FootprintBar[],
  barCellCounts: readonly number[],
  totalCells: number,
): HistoryWindowSplit {
  let suffixStart = bars.length;
  let suffixCells = 0;
  for (let index = bars.length - 1; index >= 0; index--) {
    const cells = barCellCounts[index] ?? bars[index].cells.size;
    if (cells > HISTORY_MAX_WINDOW_CELLS) {
      throw new Error(`history bar exceeds ${HISTORY_MAX_WINDOW_CELLS} cells`);
    }
    if (suffixCells + cells > HISTORY_MAX_WINDOW_CELLS || bars.length - index > HISTORY_MAX_WINDOW_BARS) break;
    suffixCells += cells;
    suffixStart = index;
  }
  if (suffixStart >= bars.length) {
    throw new Error(`history window exceeds ${HISTORY_MAX_WINDOW_CELLS} cells`);
  }
  const suffixFrom = bars[suffixStart].startTime;
  if (!(suffixFrom > query.from && suffixFrom <= query.to)) {
    throw new Error(`history window cannot be shrunk (attempted ${totalCells} cells)`);
  }
  return {
    newest: { ...query, from: suffixFrom },
    older: suffixFrom - 1 >= query.from ? { ...query, to: suffixFrom - 1 } : null,
  };
}

/** Build newest-first phase-2 footprint windows without inclusive boundary overlap. */
export function planTwoPhaseCellWindows(base: HistoryQuery): HistoryQuery[] {
  const newest = planHistoryWindows(base, FIRST_CELL_CHUNK_BARS)[0];
  const windows: HistoryQuery[] = [newest];
  if (newest.from > base.from) {
    windows.push(...planHistoryWindows({ ...base, to: newest.from - 1 }, CELL_CHUNK_BARS));
  }
  return windows;
}

/** The server returns cell-budget failures as degraded envelopes with no footprint cells. */
export function historyCellBudgetError(meta: EnvelopeMeta | undefined): string | undefined {
  return meta?.provenance?.find((entry) => /^(?:BASE_)?CELL_BUDGET:/.test(entry.error ?? ""))?.error;
}

/** Split at a real bucket boundary; one oversized candle is an irreducible error. */
export function splitHistoryCellBudgetWindow(query: HistoryQuery): HistoryWindowSplit | null {
  const oldest = bucketStart(query.from, query.interval);
  const newest = bucketStart(query.to, query.interval);
  if (newest <= oldest) return null;
  const middle = bucketStart(query.from + Math.floor((query.to - query.from) / 2), query.interval);
  const split = middle > query.from ? middle : newest;
  return {
    newest: { ...query, from: split },
    older: { ...query, to: split - 1 },
  };
}
