import { bucketEnd, bucketStart, DAY_MS } from "../time.js";
import type { FootprintBar } from "../types.js";

/**
 * Returns true only when `bars` provide gap-free footprint coverage for the
 * requested closed range. Kline and trade cells can assign volume to different
 * neighboring minutes, so conservation is checked over the whole period.
 * Backend completeness remains authoritative for individual missing bars.
 */
export function hasCompleteFootprintCoverage(
  bars: readonly FootprintBar[],
  start: number,
  end: number,
  sourceIntervalMs?: number,
): boolean {
  if (!bars.length || !bars.every(hasCompleteFootprint)) return false;
  const expected = bars.reduce((sum, bar) => sum + bar.volume, 0);
  const actual = bars.reduce((sum, bar) => sum + cellVolume(bar), 0);
  const conserved = Number.isFinite(expected) && Number.isFinite(actual)
    && Math.abs(actual - expected) <= Math.max(1e-12, expected * 1e-6);
  if (!conserved) return false;
  if (sourceIntervalMs && sourceIntervalMs > 0) {
    let cursor = start;
    for (const bar of [...bars].sort((a, b) => a.startTime - b.startTime)) {
      const barStart = bucketStart(bar.startTime, sourceIntervalMs);
      const barEnd = bucketEnd(barStart, sourceIntervalMs);
      if (barEnd <= cursor) continue;
      if (barStart > cursor + 1) return false;
      cursor = Math.max(cursor, Math.min(barEnd, end));
      if (cursor >= end) return true;
    }
    return cursor >= end;
  }

  const days = Math.round((end - start) / DAY_MS);
  if (bars.length < days) return false;
  const starts = new Set(bars.map((bar) => bucketStart(bar.startTime, DAY_MS)));
  if (starts.size < days) return false;
  return bars.every(hasCompleteFootprint);
}

/** Structural per-bar gate; cross-source volume equality belongs to the period. */
export function hasCompleteFootprint(bar: FootprintBar): boolean {
  return bar.completeness === "complete"
    && bar.cells.size > 0
    && Number.isFinite(bar.volume)
    && bar.volume >= 0
    && [...bar.cells.values()].every((cell) => Number.isFinite(cell.priceBin)
      && Number.isFinite(cell.buyVol) && cell.buyVol >= 0
      && Number.isFinite(cell.sellVol) && cell.sellVol >= 0)
    && Number.isFinite(cellVolume(bar));
}

/** Value-area profiles additionally require finite, positive volume input. */
export function hasValidPositiveFootprintVolume(bars: readonly FootprintBar[]): boolean {
  let total = 0;
  if (!bars.length) return false;
  for (const bar of bars) {
    if (!Number.isFinite(bar.volume) || bar.volume <= 0) return false;
    for (const cell of bar.cells.values()) {
      if (!Number.isFinite(cell.priceBin)
        || !Number.isFinite(cell.buyVol)
        || !Number.isFinite(cell.sellVol)
        || cell.buyVol < 0
        || cell.sellVol < 0) return false;
      total += cell.buyVol + cell.sellVol;
    }
  }
  return Number.isFinite(total) && total > 0;
}

function cellVolume(bar: FootprintBar): number {
  let total = 0;
  for (const cell of bar.cells.values()) total += cell.buyVol + cell.sellVol;
  return total;
}
