/** Closed-bar swing analysis. Callers pass only bars closed at their as-of cut. */
export interface SwingBar { high: number; low: number }
export interface SwingPivot { index: number; price: number; kind: "high" | "low"; confirmedAtIndex: number }

function windowSize(value: number): number { return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)); }

function pivotsAt(bars: readonly SwingBar[], index: number, left: number, right: number): SwingPivot[] {
  const pivot = bars[index];
  let high = Number.isFinite(pivot.high);
  let low = Number.isFinite(pivot.low);
  for (let i = index - left; i <= index + right; i++) {
    if (i === index) continue;
    const bar = bars[i];
    // Ties choose the first bar in a plateau: strict to the left, inclusive right.
    if (!Number.isFinite(bar.high) || (i < index ? bar.high >= pivot.high : bar.high > pivot.high)) high = false;
    if (!Number.isFinite(bar.low) || (i < index ? bar.low <= pivot.low : bar.low < pivot.low)) low = false;
  }
  const result: SwingPivot[] = [];
  if (high) result.push({ index, price: pivot.high, kind: "high", confirmedAtIndex: index + right });
  if (low) result.push({ index, price: pivot.low, kind: "low", confirmedAtIndex: index + right });
  return result;
}

/** Pure scan: no pivot is returned until all right-hand closed bars are present. */
export function detectSwings(bars: readonly SwingBar[], left: number, right: number): SwingPivot[] {
  const l = windowSize(left);
  const r = windowSize(right);
  const result: SwingPivot[] = [];
  for (let index = l; index + r < bars.length; index++) result.push(...pivotsAt(bars, index, l, r));
  return result;
}

/**
 * Owns only derived pivots. Append/tail modes require an immutable older prefix;
 * callers must use reset after history corrections, trimming or replay seeking.
 * A tail update evaluates one left+right+1 window, regardless of history length.
 */
export class IncrementalSwingDetector {
  private pivots: SwingPivot[] = [];
  private length = 0;
  private left = 0;
  private right = 0;
  evaluatedWindows = 0;

  update(bars: readonly SwingBar[], left: number, right: number, change: "reset" | "tail" | "append" = "reset", closedLength = bars.length): readonly SwingPivot[] {
    const l = windowSize(left);
    const r = windowSize(right);
    const length = Math.max(0, Math.min(bars.length, Math.floor(closedLength)));
    const reset = change === "reset" || l !== this.left || r !== this.right || length < this.length;
    let first = l;
    if (reset) this.pivots = [];
    else {
      const mutableFrom = change === "tail" ? length - 1 : this.length;
      while (this.pivots.length && this.pivots[this.pivots.length - 1].confirmedAtIndex >= mutableFrom) this.pivots.pop();
      first = Math.max(l, mutableFrom - r);
    }
    for (let index = first; index + r < length; index++) {
      this.evaluatedWindows++;
      this.pivots.push(...pivotsAt(bars, index, l, r));
    }
    this.length = length;
    this.left = l;
    this.right = r;
    return this.pivots;
  }
}
