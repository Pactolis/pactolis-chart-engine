import {
  MarketStructureEngine,
  type BreakConfirmationMode,
  type MarketStructureOptions,
  type MarketStructureSnapshot,
  type StructureBar,
} from "./structuralSwings.js";

export * from "./structuralSwings.js";

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

export interface MarketStructureResult extends MarketStructureSnapshot {
  rawPivots: readonly SwingPivot[];
  evaluatedWindows: number;
}

const EMPTY_PIVOTS: readonly SwingPivot[] = [];

function collectPivotsAtConfirmation(
  pivots: readonly SwingPivot[],
  cursor: number,
  confirmedAtIndex: number,
): { group: readonly SwingPivot[]; nextCursor: number } {
  let i = cursor;
  while (i < pivots.length && pivots[i].confirmedAtIndex < confirmedAtIndex) i++;
  if (i >= pivots.length || pivots[i].confirmedAtIndex !== confirmedAtIndex) {
    return { group: EMPTY_PIVOTS, nextCursor: i };
  }
  const start = i;
  while (i < pivots.length && pivots[i].confirmedAtIndex === confirmedAtIndex) i++;
  return { group: pivots.slice(start, i), nextCursor: i };
}

/**
 * Stateful incremental structural swing + BOS/CHoCH + protected-level analyzer.
 * Append updates run in O(1) amortized structure steps and evaluate only newly closed windows;
 * live open-bar ticks outside `closedLength` perform zero window evaluations.
 */
export class IncrementalMarketStructure {
  private readonly rawDetector = new IncrementalSwingDetector();
  private engine = new MarketStructureEngine();
  private processedLength = 0;
  private pivotCursor = 0;
  private configKey = "";
  private rawPivots: readonly SwingPivot[] = [];

  get evaluatedWindows(): number {
    return this.rawDetector.evaluatedWindows;
  }

  getRawPivots(): readonly SwingPivot[] {
    return this.rawPivots;
  }

  update(
    bars: readonly StructureBar[],
    options: MarketStructureOptions,
    change: "reset" | "tail" | "append" = "reset",
    closedLength = bars.length,
  ): MarketStructureResult {
    const l = windowSize(options.left);
    const r = windowSize(options.right);
    const tolerance = typeof options.equalityTolerance === "number" && Number.isFinite(options.equalityTolerance) && options.equalityTolerance >= 0
      ? options.equalityTolerance
      : 0;
    const confirmation: BreakConfirmationMode = options.breakConfirmation === "wick" ? "wick" : "close";
    const length = Math.max(0, Math.min(bars.length, Math.floor(closedLength)));
    const nextConfigKey = `${l}|${r}|${tolerance}|${confirmation}`;

    // Live open-bar mutation outside closedLength cannot affect closed structure.
    if (
      change === "tail"
      && nextConfigKey === this.configKey
      && length === this.processedLength
      && length < bars.length
    ) {
      return {
        ...this.engine.snapshot(),
        rawPivots: this.rawPivots,
        evaluatedWindows: this.rawDetector.evaluatedWindows,
      };
    }

    const rawPivots = this.rawDetector.update(bars, l, r, change, length);
    this.rawPivots = rawPivots;

    const resetEngine = change === "reset"
      || nextConfigKey !== this.configKey
      || length < this.processedLength
      || (change === "tail" && length === bars.length);

    if (resetEngine) {
      this.engine = new MarketStructureEngine(tolerance, confirmation);
      this.processedLength = 0;
      this.pivotCursor = 0;
      this.configKey = nextConfigKey;
    }

    for (let barIndex = this.processedLength; barIndex < length; barIndex++) {
      const { group, nextCursor } = collectPivotsAtConfirmation(rawPivots, this.pivotCursor, barIndex);
      this.pivotCursor = nextCursor;
      this.engine.stepBar(bars[barIndex], barIndex, group);
    }
    this.processedLength = length;

    return {
      ...this.engine.snapshot(),
      rawPivots: this.rawPivots,
      evaluatedWindows: this.rawDetector.evaluatedWindows,
    };
  }
}

/** Pure one-shot market structure scan matching incremental updates identically. */
export function analyzeMarketStructure(
  bars: readonly StructureBar[],
  options: MarketStructureOptions,
  closedLength = bars.length,
): MarketStructureResult {
  return new IncrementalMarketStructure().update(bars, options, "reset", closedLength);
}
