import { bucketEnd, bucketStart, DAY_MS } from "../time.js";
import type { FootprintBar } from "../types.js";

const BOUNDARY_SHIFT_MAX_BARS = 4;
const BOUNDARY_SHIFT_MAX_PERIOD_RATIO = 0.01;

/**
 * Returns true only when `bars` provide gap-free footprint coverage for the
 * requested closed range. Kline and trade cells can assign volume to different
 * neighboring minutes, so conservation is checked over the whole period,
 * allowing up to `BOUNDARY_SHIFT_MAX_BARS` edge bars to absorb cross-boundary shifts.
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
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  const tolerance = Math.max(1e-12, expected * 1e-6);
  let conserved = Math.abs(actual - expected) <= tolerance;
  if (sourceIntervalMs && sourceIntervalMs > 0) {
    const ordered = [...bars].sort((a, b) => a.startTime - b.startTime);
    if (!conserved) {
      conserved = hasConservedBoundaryShift(ordered, expected, actual, tolerance);
    }
    if (!conserved) return false;
    let cursor = start;
    for (const bar of ordered) {
      const barStart = bucketStart(bar.startTime, sourceIntervalMs);
      const barEnd = bucketEnd(barStart, sourceIntervalMs);
      if (barEnd <= cursor) continue;
      if (barStart > cursor + 1) return false;
      cursor = Math.max(cursor, Math.min(barEnd, end));
      if (cursor >= end) return true;
    }
    return cursor >= end;
  }
  if (!conserved) return false;

  const days = Math.round((end - start) / DAY_MS);
  if (bars.length < days) return false;
  const starts = new Set(bars.map((bar) => bucketStart(bar.startTime, DAY_MS)));
  if (starts.size < days) return false;
  return bars.every(hasCompleteFootprint);
}

function hasConservedBoundaryShift(
  ordered: readonly FootprintBar[],
  expected: number,
  actual: number,
  tolerance: number,
): boolean {
  if (ordered.length <= BOUNDARY_SHIFT_MAX_BARS * 2) return false;
  const maxPeriodSlack = Math.max(tolerance, expected * BOUNDARY_SHIFT_MAX_PERIOD_RATIO);
  if (Math.abs(actual - expected) > maxPeriodSlack) return false;

  const volumes = ordered.map((bar) => bar.volume);
  const cells = ordered.map((bar) => cellVolume(bar));
  const coreStart = BOUNDARY_SHIFT_MAX_BARS;
  const coreEnd = ordered.length - BOUNDARY_SHIFT_MAX_BARS;

  let coreExpected = 0;
  let coreActual = 0;
  for (let i = coreStart; i < coreEnd; i++) {
    coreExpected += volumes[i];
    coreActual += cells[i];
  }

  for (let leftCut = 0; leftCut <= BOUNDARY_SHIFT_MAX_BARS; leftCut++) {
    let leftExpected = 0;
    let leftActual = 0;
    for (let i = 0; i < leftCut; i++) {
      leftExpected += volumes[i];
      leftActual += cells[i];
    }
    let leftInteriorExpected = 0;
    let leftInteriorActual = 0;
    for (let i = leftCut; i < coreStart; i++) {
      leftInteriorExpected += volumes[i];
      leftInteriorActual += cells[i];
    }

    for (let rightCut = coreEnd; rightCut <= ordered.length; rightCut++) {
      if (leftCut === 0 && rightCut === ordered.length) continue;
      let rightInteriorExpected = 0;
      let rightInteriorActual = 0;
      for (let i = coreEnd; i < rightCut; i++) {
        rightInteriorExpected += volumes[i];
        rightInteriorActual += cells[i];
      }
      let rightExpected = 0;
      let rightActual = 0;
      for (let i = rightCut; i < ordered.length; i++) {
        rightExpected += volumes[i];
        rightActual += cells[i];
      }

      const interiorExpected = leftInteriorExpected + coreExpected + rightInteriorExpected;
      const interiorActual = leftInteriorActual + coreActual + rightInteriorActual;
      if (Math.abs(interiorActual - interiorExpected) > tolerance) continue;

      const edgeBudget = Math.max(
        tolerance,
        Math.min(maxPeriodSlack, leftExpected + leftActual + rightExpected + rightActual),
      );
      if (Math.abs(actual - expected) <= edgeBudget) return true;
    }
  }
  return false;
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
