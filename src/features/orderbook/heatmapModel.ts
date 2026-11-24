// Pure helpers for the chart's orderbook heatmap: tier choice, chunking, bar
// lookup, unit conversion, color range, luminance palette, and WS tail projection. No I/O, no DOM.
import {
  DEFAULT_HEATMAP_PALETTE,
  ORDERBOOK_HEATMAP_PALETTES,
  normalizeOrderbookHeatmapSources,
  resolveOrderbookHeatmapPalette,
  type OrderbookHeatmapContrast,
  type OrderbookHeatmapPalette,
  type OrderbookHeatmapScaleMode,
} from "../../core/orderbookHeatmap/settings.js";
import type {
  CanonicalHeatmapTailBar,
  OrderbookHeatmapBar,
  OrderbookHeatmapBucketStep,
  OrderbookHeatmapCell,
  OrderbookHeatmapSource,
  OrderbookResolution,
} from "./heatmapContracts.js";

export type {
  CanonicalHeatmapTailBar,
  CanonicalHeatmapTailCell,
  CanonicalHeatmapTailSourceEntry,
} from "./heatmapContracts.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface HeatmapTier {
  name: Exclude<OrderbookResolution, "auto">;
  periodMs: number;
}

/** Stored backend tiers, finest first. */
export const HEATMAP_TIERS: readonly HeatmapTier[] = [
  { name: "1m", periodMs: MINUTE_MS },
  { name: "5m", periodMs: 5 * MINUTE_MS },
  { name: "15m", periodMs: 15 * MINUTE_MS },
  { name: "30m", periodMs: 30 * MINUTE_MS },
  { name: "1h", periodMs: HOUR_MS },
  { name: "2h", periodMs: 2 * HOUR_MS },
  { name: "4h", periodMs: 4 * HOUR_MS },
  { name: "1d", periodMs: DAY_MS },
];

/** A thresholded backend request returns at most this many tier bars. */
export const HEATMAP_CHUNK_BARS = 1_000;
/** An unthresholded (hover) request returns at most this many tier bars. */
export const HEATMAP_WINDOW_MAX_BARS = 64;
/** Hover table size: rows (price buckets) and columns (chart bars), odd so the cursor sits in the middle. */
export const HEATMAP_HOVER_SPAN = 5;

/**
 * The coarsest stored tier whose bars nest exactly inside one chart bar.
 * Chart bars of a day or longer (3d, 1w, 1M...) read the 1d tier.
 */
export function heatmapTierFor(intervalMs: number): HeatmapTier {
  if (intervalMs >= DAY_MS) return HEATMAP_TIERS[HEATMAP_TIERS.length - 1];
  let best = HEATMAP_TIERS[0];
  for (const tier of HEATMAP_TIERS) {
    if (tier.periodMs <= intervalMs && intervalMs % tier.periodMs === 0) best = tier;
  }
  return best;
}

/** Start of the fixed chunk holding `time`; chunks are aligned so they cache cleanly. */
export function heatmapChunkStart(time: number, tier: HeatmapTier): number {
  const span = HEATMAP_CHUNK_BARS * tier.periodMs;
  return Math.floor(time / span) * span;
}

/** Inclusive end of a chunk: its last tier bar's start. */
export function heatmapChunkEnd(chunkStart: number, tier: HeatmapTier): number {
  return chunkStart + (HEATMAP_CHUNK_BARS - 1) * tier.periodMs;
}

/** Chunk starts covering `[from, to]`, oldest first. */
export function heatmapChunksFor(from: number, to: number, tier: HeatmapTier): number[] {
  const span = HEATMAP_CHUNK_BARS * tier.periodMs;
  const chunks: number[] = [];
  for (let start = heatmapChunkStart(from, tier); start <= to; start += span) chunks.push(start);
  return chunks;
}

function upperBoundTime(sortedTimes: readonly number[], target: number): number {
  let lo = 0;
  let hi = sortedTimes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * The newest tier bar inside the chart bar `[start, end)`: its values are the
 * book at the chart bar's close (or now, for the live bar).
 */
export function lastHeatmapSubBar(
  bars: ReadonlyMap<number, OrderbookHeatmapBar>,
  start: number,
  end: number,
  tier: HeatmapTier,
  sortedTimes?: readonly number[],
): OrderbookHeatmapBar | undefined {
  if (!(end > start) || bars.size === 0) return undefined;
  const latestSlot = Math.floor((end - 1) / tier.periodMs) * tier.periodMs;
  if (latestSlot < start) return undefined;
  const direct = bars.get(latestSlot);
  if (direct) return direct;
  const prevSlot = latestSlot - tier.periodMs;
  if (prevSlot < start) return undefined;
  if (sortedTimes !== undefined) {
    for (let i = upperBoundTime(sortedTimes, prevSlot); i >= 0; i--) {
      const t = sortedTimes[i];
      if (t < start) break;
      if ((latestSlot - t) % tier.periodMs === 0) {
        const bar = bars.get(t);
        if (bar) return bar;
      }
    }
    return undefined;
  }
  const remainingSteps = Math.floor((prevSlot - start) / tier.periodMs) + 1;
  if (bars.size < remainingSteps) {
    let bestTime = Number.NEGATIVE_INFINITY;
    for (const t of bars.keys()) {
      if (t >= start && t <= prevSlot && t > bestTime && (latestSlot - t) % tier.periodMs === 0) {
        bestTime = t;
      }
    }
    return bestTime > Number.NEGATIVE_INFINITY ? bars.get(bestTime) : undefined;
  }
  for (let t = prevSlot; t >= start; t -= tier.periodMs) {
    const bar = bars.get(t);
    if (bar) return bar;
  }
  return undefined;
}

/**
 * The heatmap bar for the chart bar in progress. Until the newest refresh
 * reaches it, the previous chart bar's close stands in, so the current candle
 * shows the last known book instead of nothing.
 */
export function liveHeatmapSubBar(
  bars: ReadonlyMap<number, OrderbookHeatmapBar>,
  start: number,
  end: number,
  tier: HeatmapTier,
  sortedTimes?: readonly number[],
): OrderbookHeatmapBar | undefined {
  return (
    lastHeatmapSubBar(bars, start, end, tier, sortedTimes)
    ?? lastHeatmapSubBar(bars, start - (end - start), start, tier, sortedTimes)
  );
}

const sortedCellsCache = new WeakMap<readonly OrderbookHeatmapCell[], boolean>();

/**
 * Returns true if `cells` are non-decreasing by `priceStart` (`cell[0]`),
 * memoized per array identity so repeated viewport queries skip O(K) checks.
 */
export function areHeatmapCellsSortedByPrice(cells: readonly OrderbookHeatmapCell[]): boolean {
  const cached = sortedCellsCache.get(cells);
  if (cached !== undefined) return cached;
  let sorted = true;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i][0] < cells[i - 1][0]) {
      sorted = false;
      break;
    }
  }
  sortedCellsCache.set(cells, sorted);
  return sorted;
}

/**
 * Returns the `[start, end)` slice of `cells` overlapping `[minVisPrice, maxVisPrice]`
 * using O(log K) binary search when `cells` are ascending by `priceStart`.
 */
export function visibleHeatmapCellBounds(
  cells: readonly OrderbookHeatmapCell[],
  minVisPrice: number,
  maxVisPrice: number,
  step: number,
): { start: number; end: number } {
  const len = cells.length;
  if (len === 0) return { start: 0, end: 0 };
  if (!Number.isFinite(minVisPrice) || !Number.isFinite(maxVisPrice) || !areHeatmapCellsSortedByPrice(cells)) {
    return { start: 0, end: len };
  }
  const minStart = minVisPrice - step;
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cells[mid][0] < minStart) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  lo = start;
  hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cells[mid][0] <= maxVisPrice) lo = mid + 1;
    else hi = mid;
  }
  return { start, end: lo };
}

export function heatmapCellUsd(cell: OrderbookHeatmapCell): number {
  return cell[1] + cell[2];
}

/** A bucket's bid+ask in the chosen unit; BTC uses the bucket's middle price. */
export function heatmapValueInUnit(usd: number, priceStart: number, bucketStep: number, unit: "usd" | "btc"): number {
  if (unit === "usd") return usd;
  const middle = priceStart + bucketStep / 2;
  return middle > 0 ? usd / middle : 0;
}

/** The intensity ceiling never drops below this multiple of the floor, so a screen of near-floor walls stays faint. */
export const HEATMAP_MIN_CEILING_RATIO = 2;

export const HEATMAP_SINGLE_CANONICAL_SOURCE = "binance:usd_perp";
export const HEATMAP_MAX_CELLS_PER_BAR = 200;

/**
 * Percentile bounds `[floorQuantile, ceilingQuantile]` per contrast level.
 * Default `"medium"` uses P15–P96 so extreme single outliers do not crush mid-band walls.
 */
export const HEATMAP_AUTO_PERCENTILES: Readonly<Record<OrderbookHeatmapContrast, readonly [number, number]>> = {
  low: [0.05, 0.99],
  medium: [0.15, 0.96],
  high: [0.25, 0.92],
};

export interface HeatmapColorRangeInput {
  values: ArrayLike<number>;
  threshold: number;
  scaleMode?: OrderbookHeatmapScaleMode;
  fixedCeiling?: number;
  contrast?: OrderbookHeatmapContrast;
  inPlace?: boolean;
}

export interface HeatmapColorRange {
  floor: number;
  ceiling: number;
}

let colorRangeScratch = new Float64Array(1024);

/**
 * Deterministic median-of-3 + 3-way Dutch National Flag Quickselect (`< pivot`, `== pivot`, `> pivot`).
 * Guarantees O(N) performance even on all-equal or heavily quantized distributions.
 */
function selectKthInPlace(buf: Float64Array, leftStart: number, rightEnd: number, k: number): number {
  let left = leftStart;
  let right = rightEnd;
  while (left < right) {
    const mid = left + ((right - left) >> 1);
    let a = buf[left];
    let b = buf[mid];
    let c = buf[right];
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      const t = b;
      b = c;
      c = t;
    }
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    const pivot = b;

    let lt = left;
    let i = left;
    let gt = right;
    while (i <= gt) {
      const val = buf[i];
      if (val < pivot) {
        buf[i] = buf[lt];
        buf[lt] = val;
        lt++;
        i++;
      } else if (val > pivot) {
        buf[i] = buf[gt];
        buf[gt] = val;
        gt--;
      } else {
        i++;
      }
    }

    if (k < lt) {
      right = lt - 1;
    } else if (k > gt) {
      left = gt + 1;
    } else {
      return pivot;
    }
  }
  return buf[k];
}

function percentileFromBuffer(buf: Float64Array, n: number, quantile: number, loBound: number): number {
  if (n === 0) return 0;
  if (n === 1) return buf[0];
  const idx = (n - 1) * quantile;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const vLo = selectKthInPlace(buf, loBound, n - 1, lo);
  if (hi === lo) return vLo;
  let vHi = buf[lo + 1];
  for (let i = lo + 2; i < n; i++) {
    const v = buf[i];
    if (v < vHi) vHi = v;
  }
  return vLo + (vHi - vLo) * (idx - lo);
}

function compactPositiveValues(values: ArrayLike<number>, inPlace: boolean): { buf: Float64Array; count: number } {
  if (inPlace && values instanceof Float64Array) {
    let n = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (Number.isFinite(v) && v > 0) {
        values[n++] = v;
      }
    }
    return { buf: values, count: n };
  }

  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v) && v > 0) {
      if (n === colorRangeScratch.length) {
        const next = new Float64Array(colorRangeScratch.length * 2);
        next.set(colorRangeScratch);
        colorRangeScratch = next;
      }
      colorRangeScratch[n++] = v;
    }
  }
  return { buf: colorRangeScratch, count: n };
}

/**
 * Resolves the `[floor, ceiling]` logarithmic color scale shared by Canvas2D and WebGL2.
 * When `threshold === 0`, `floor` is derived from the positive distribution's lower percentile.
 */
export function resolveHeatmapColorRange(input: HeatmapColorRangeInput): HeatmapColorRange {
  const scaleMode = input.scaleMode ?? "auto";
  const hasThreshold = Number.isFinite(input.threshold) && input.threshold > 0;
  const threshold = hasThreshold ? input.threshold : 0;
  const hasFixedCeiling =
    scaleMode === "fixed" &&
    input.fixedCeiling !== undefined &&
    Number.isFinite(input.fixedCeiling) &&
    input.fixedCeiling > 0;

  if (hasFixedCeiling && threshold > 0) {
    return {
      floor: threshold,
      ceiling: Math.max(input.fixedCeiling!, threshold * HEATMAP_MIN_CEILING_RATIO),
    };
  }

  const contrast = input.contrast ?? "medium";
  const [floorQ, ceilingQ] = HEATMAP_AUTO_PERCENTILES[contrast] ?? HEATMAP_AUTO_PERCENTILES.medium;
  const { buf, count } = compactPositiveValues(input.values, input.inPlace === true);

  if (hasFixedCeiling) {
    const floor = count > 0
      ? Math.min(percentileFromBuffer(buf, count, floorQ, 0), input.fixedCeiling! / HEATMAP_MIN_CEILING_RATIO)
      : 0;
    const ceiling = floor > 0
      ? Math.max(input.fixedCeiling!, floor * HEATMAP_MIN_CEILING_RATIO)
      : input.fixedCeiling!;
    return { floor, ceiling };
  }

  if (count === 0) {
    return {
      floor: threshold,
      ceiling: threshold > 0 ? threshold * 10 : 0,
    };
  }

  if (threshold > 0) {
    const pCeiling = percentileFromBuffer(buf, count, ceilingQ, 0);
    return {
      floor: threshold,
      ceiling: Math.max(pCeiling, threshold * HEATMAP_MIN_CEILING_RATIO),
    };
  }

  const loFloor = Math.floor((count - 1) * floorQ);
  const pFloor = percentileFromBuffer(buf, count, floorQ, 0);
  const pCeiling = percentileFromBuffer(buf, count, ceilingQ, loFloor);
  return {
    floor: pFloor,
    ceiling: Math.max(pCeiling, pFloor * HEATMAP_MIN_CEILING_RATIO),
  };
}

function kthOfTwoSorted(
  a: Float64Array,
  lenA: number,
  b: Float64Array,
  lenB: number,
  k: number,
): number {
  if (lenA > lenB) return kthOfTwoSorted(b, lenB, a, lenA, k);
  let lo = Math.max(0, k - lenB);
  let hi = Math.min(lenA, k);
  while (lo <= hi) {
    const cutA = (lo + hi) >> 1;
    const cutB = k - cutA;
    const aLeft = cutA > 0 ? a[cutA - 1] : Number.NEGATIVE_INFINITY;
    const aRight = cutA < lenA ? a[cutA] : Number.POSITIVE_INFINITY;
    const bLeft = cutB > 0 ? b[cutB - 1] : Number.NEGATIVE_INFINITY;
    const bRight = cutB < lenB ? b[cutB] : Number.POSITIVE_INFINITY;
    if (aLeft <= bRight && bLeft <= aRight) {
      return aRight <= bRight ? aRight : bRight;
    }
    if (aLeft > bRight) {
      hi = cutA - 1;
    } else {
      lo = cutA + 1;
    }
  }
  return 0;
}

function percentileFromTwoSorted(
  a: Float64Array,
  lenA: number,
  b: Float64Array,
  lenB: number,
  quantile: number,
): number {
  const n = lenA + lenB;
  if (n === 0) return 0;
  if (n === 1) return lenA === 1 ? a[0] : b[0];
  const idx = (n - 1) * quantile;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const vLo = kthOfTwoSorted(a, lenA, b, lenB, lo);
  if (hi === lo) return vLo;
  const vHi = kthOfTwoSorted(a, lenA, b, lenB, hi);
  return vLo + (vHi - vLo) * (idx - lo);
}

/**
 * Exact O(log N) equivalent of `resolveHeatmapColorRange` when positive visible values
 * are split into a cached sorted historical array and a sorted live-bar array.
 */
export function resolveHeatmapColorRangeFromTwoSorted(input: {
  histSorted: Float64Array;
  histCount: number;
  liveSorted: Float64Array;
  liveCount: number;
  threshold: number;
  scaleMode?: OrderbookHeatmapScaleMode;
  fixedCeiling?: number;
  contrast?: OrderbookHeatmapContrast;
}): HeatmapColorRange {
  const scaleMode = input.scaleMode ?? "auto";
  const hasThreshold = Number.isFinite(input.threshold) && input.threshold > 0;
  const threshold = hasThreshold ? input.threshold : 0;
  const hasFixedCeiling =
    scaleMode === "fixed" &&
    input.fixedCeiling !== undefined &&
    Number.isFinite(input.fixedCeiling) &&
    input.fixedCeiling > 0;

  if (hasFixedCeiling && threshold > 0) {
    return {
      floor: threshold,
      ceiling: Math.max(input.fixedCeiling!, threshold * HEATMAP_MIN_CEILING_RATIO),
    };
  }

  const contrast = input.contrast ?? "medium";
  const [floorQ, ceilingQ] = HEATMAP_AUTO_PERCENTILES[contrast] ?? HEATMAP_AUTO_PERCENTILES.medium;
  const count = input.histCount + input.liveCount;

  if (hasFixedCeiling) {
    const floor = count > 0
      ? Math.min(
          percentileFromTwoSorted(input.histSorted, input.histCount, input.liveSorted, input.liveCount, floorQ),
          input.fixedCeiling! / HEATMAP_MIN_CEILING_RATIO,
        )
      : 0;
    const ceiling = floor > 0
      ? Math.max(input.fixedCeiling!, floor * HEATMAP_MIN_CEILING_RATIO)
      : input.fixedCeiling!;
    return { floor, ceiling };
  }

  if (count === 0) {
    return {
      floor: threshold,
      ceiling: threshold > 0 ? threshold * 10 : 0,
    };
  }

  if (threshold > 0) {
    const pCeiling = percentileFromTwoSorted(
      input.histSorted,
      input.histCount,
      input.liveSorted,
      input.liveCount,
      ceilingQ,
    );
    return {
      floor: threshold,
      ceiling: Math.max(pCeiling, threshold * HEATMAP_MIN_CEILING_RATIO),
    };
  }

  const pFloor = percentileFromTwoSorted(input.histSorted, input.histCount, input.liveSorted, input.liveCount, floorQ);
  const pCeiling = percentileFromTwoSorted(input.histSorted, input.histCount, input.liveSorted, input.liveCount, ceilingQ);
  return {
    floor: pFloor,
    ceiling: Math.max(pCeiling, pFloor * HEATMAP_MIN_CEILING_RATIO),
  };
}

const LOG10_101 = Math.log10(101);

/**
 * 0..1 color strength on a log scale: `floor` maps to 0 and `ceiling` maps to 1.
 * When `floor <= 0`, positive values still scale smoothly across `0..ceiling` instead of collapsing to 1.
 */
export function heatmapIntensity(value: number, floor: number, ceiling = floor > 0 ? floor * 10 : 0): number {
  if (!(value > 0)) return 0;
  if (floor > 0) {
    const effectiveCeiling = Math.max(ceiling, floor * HEATMAP_MIN_CEILING_RATIO);
    const span = Math.log10(effectiveCeiling / floor);
    if (!(span > 0)) return 0;
    const ratio = Math.log10(value / floor) / span;
    return Math.min(1, Math.max(0, ratio));
  }
  if (ceiling > 0) {
    const ratio = Math.log10(1 + (value / ceiling) * 100) / LOG10_101;
    return Math.min(1, Math.max(0, ratio));
  }
  return Math.min(1, Math.max(0, Math.log10(1 + value) / 8));
}

export interface HeatmapColorStop {
  readonly k: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Single-source palette stop definitions shared by CPU Canvas2D, WebGL2 GLSL, and WebGPU WGSL. */
export const HEATMAP_PALETTE_STOPS_BY_ID: Record<OrderbookHeatmapPalette, readonly HeatmapColorStop[]> = {
  // Dark-theme luminance ramp: faint deep navy -> cobalt -> vivid turquoise -> warm pale yellow/off-white.
  pactolis: [
    { k: 0.0, r: 18, g: 38, b: 84, a: 0.22 },
    { k: 0.4, r: 24, g: 112, b: 168, a: 0.36 },
    { k: 0.75, r: 34, g: 211, b: 238, a: 0.54 },
    { k: 1.0, r: 254, g: 240, b: 178, a: 0.68 },
  ],
  viridis: [
    { k: 0.0, r: 72, g: 33, b: 115, a: 0.24 },
    { k: 0.25, r: 56, g: 88, b: 140, a: 0.34 },
    { k: 0.5, r: 33, g: 145, b: 140, a: 0.45 },
    { k: 0.75, r: 94, g: 201, b: 98, a: 0.57 },
    { k: 1.0, r: 253, g: 231, b: 37, a: 0.68 },
  ],
  cividis: [
    { k: 0.0, r: 0, g: 46, b: 111, a: 0.24 },
    { k: 0.25, r: 65, g: 77, b: 107, a: 0.34 },
    { k: 0.5, r: 124, g: 123, b: 120, a: 0.45 },
    { k: 0.75, r: 188, g: 175, b: 111, a: 0.57 },
    { k: 1.0, r: 253, g: 234, b: 69, a: 0.68 },
  ],
  inferno: [
    { k: 0.0, r: 40, g: 11, b: 83, a: 0.24 },
    { k: 0.25, r: 120, g: 28, b: 109, a: 0.34 },
    { k: 0.5, r: 207, g: 68, b: 70, a: 0.46 },
    { k: 0.75, r: 251, g: 155, b: 6, a: 0.58 },
    { k: 1.0, r: 252, g: 255, b: 164, a: 0.68 },
  ],
};

export function heatmapPaletteIndex(palette: OrderbookHeatmapPalette | undefined): number {
  const resolved = resolveOrderbookHeatmapPalette(palette);
  const idx = ORDERBOOK_HEATMAP_PALETTES.indexOf(resolved);
  return idx >= 0 ? idx : 0;
}

export interface HeatmapRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Computes exact RGBA channels and quantized alpha matching `HEATMAP_GPU_FRAG_SRC` and WGSL. */
export function heatmapCellRgba(
  intensity: number,
  alphaScale = 1,
  opacity = 1,
  palette: OrderbookHeatmapPalette = DEFAULT_HEATMAP_PALETTE,
): HeatmapRgba {
  const k = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  const clampedOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  const stops = HEATMAP_PALETTE_STOPS_BY_ID[resolveOrderbookHeatmapPalette(palette)];
  let s0 = stops[0];
  let s1 = stops[1];
  for (let i = 1; i < stops.length; i++) {
    if (k <= stops[i].k || i === stops.length - 1) {
      s0 = stops[i - 1];
      s1 = stops[i];
      break;
    }
  }
  const t = (k - s0.k) / (s1.k - s0.k);
  const r = Math.floor(s0.r + (s1.r - s0.r) * t + 0.5);
  const g = Math.floor(s0.g + (s1.g - s0.g) * t + 0.5);
  const b = Math.floor(s0.b + (s1.b - s0.b) * t + 0.5);
  const rawAlpha = (s0.a + (s1.a - s0.a) * t) * alphaScale * clampedOpacity;
  const a = Math.floor(Math.min(1, Math.max(0, rawAlpha)) * 1000 + 0.5) / 1000;
  return { r, g, b, a };
}

function formatShaderFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

function buildPaletteStopBranch(
  stops: readonly HeatmapColorStop[],
  vec3Ctor: "vec3" | "vec3<f32>",
  indent: string,
): string {
  const lines: string[] = [];
  for (let i = 1; i < stops.length; i++) {
    const s0 = stops[i - 1];
    const s1 = stops[i];
    const span = formatShaderFloat(Number((s1.k - s0.k).toFixed(6)));
    const head = i === 1
      ? `${indent}if (k <= ${formatShaderFloat(s1.k)}) {`
      : i === stops.length - 1
        ? `${indent}} else {`
        : `${indent}} else if (k <= ${formatShaderFloat(s1.k)}) {`;
    lines.push(head);
    lines.push(`${indent}  t = (k - ${formatShaderFloat(s0.k)}) / ${span};`);
    lines.push(`${indent}  c0 = ${vec3Ctor}(${formatShaderFloat(s0.r)}, ${formatShaderFloat(s0.g)}, ${formatShaderFloat(s0.b)});`);
    lines.push(`${indent}  c1 = ${vec3Ctor}(${formatShaderFloat(s1.r)}, ${formatShaderFloat(s1.g)}, ${formatShaderFloat(s1.b)});`);
    lines.push(`${indent}  a0 = ${formatShaderFloat(s0.a)};`);
    lines.push(`${indent}  a1 = ${formatShaderFloat(s1.a)};`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

/** Generates deterministic GLSL palette stop selection from `HEATMAP_PALETTE_STOPS_BY_ID`. */
export function buildHeatmapPaletteGlslBranch(): string {
  const blocks: string[] = [];
  for (let p = 0; p < ORDERBOOK_HEATMAP_PALETTES.length; p++) {
    const id = ORDERBOOK_HEATMAP_PALETTES[p];
    const stops = HEATMAP_PALETTE_STOPS_BY_ID[id];
    const header = p === 0
      ? `  if (u_palette == 0) {`
      : p === ORDERBOOK_HEATMAP_PALETTES.length - 1
        ? `  } else {`
        : `  } else if (u_palette == ${p}) {`;
    blocks.push(header);
    blocks.push(buildPaletteStopBranch(stops, "vec3", "    "));
  }
  blocks.push("  }");
  return blocks.join("\n");
}

/** Generates deterministic WGSL palette stop selection from `HEATMAP_PALETTE_STOPS_BY_ID`. */
export function buildHeatmapPaletteWgslBranch(paletteExpr: string): string {
  const blocks: string[] = [];
  for (let p = 0; p < ORDERBOOK_HEATMAP_PALETTES.length; p++) {
    const id = ORDERBOOK_HEATMAP_PALETTES[p];
    const stops = HEATMAP_PALETTE_STOPS_BY_ID[id];
    const header = p === 0
      ? `  if (${paletteExpr} == 0u) {`
      : p === ORDERBOOK_HEATMAP_PALETTES.length - 1
        ? `  } else {`
        : `  } else if (${paletteExpr} == ${p}u) {`;
    blocks.push(header);
    blocks.push(buildPaletteStopBranch(stops, "vec3<f32>", "    "));
  }
  blocks.push("  }");
  return blocks.join("\n");
}

function formatHeatmapRgba(rgba: HeatmapRgba): string {
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a.toFixed(3)})`;
}

const HEATMAP_COLOR_LUT_FULL: readonly string[] = Array.from({ length: 1001 }, (_, q) =>
  formatHeatmapRgba(heatmapCellRgba(q / 1000, 1, 1)),
);
const HEATMAP_COLOR_LUT_LIVE: readonly string[] = Array.from({ length: 1001 }, (_, q) =>
  formatHeatmapRgba(heatmapCellRgba(q / 1000, 0.45, 1)),
);
const HEATMAP_COLOR_LUT_DEFAULT_FULL: readonly string[] = Array.from({ length: 1001 }, (_, q) =>
  formatHeatmapRgba(heatmapCellRgba(q / 1000, 1, 0.85)),
);
const HEATMAP_COLOR_LUT_DEFAULT_LIVE: readonly string[] = Array.from({ length: 1001 }, (_, q) =>
  formatHeatmapRgba(heatmapCellRgba(q / 1000, 0.45, 0.85)),
);

const HEATMAP_COLOR_LUT_CACHE_MAX_ENTRIES = 16;
const heatmapColorLutCache = new Map<string, readonly string[]>();

/**
 * Returns a 1001-entry RGBA string lookup table for `(alphaScale, opacity, palette)`.
 * Default `pactolis` `1.0` and `0.85` at `alphaScale` `1` / `0.45` stay pre-warmed;
 * all other combinations share a bounded 32-entry FIFO cache.
 */
export function getHeatmapColorLut(
  alphaScale = 1,
  opacity = 1,
  palette: OrderbookHeatmapPalette = DEFAULT_HEATMAP_PALETTE,
): readonly string[] {
  const safeAlphaScale = Number.isFinite(alphaScale) ? (alphaScale <= 0 ? 0 : alphaScale) : 1;
  const rawClampedOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  const clampedOpacity = rawClampedOpacity === 0 ? 0 : rawClampedOpacity;
  const resolvedPalette = resolveOrderbookHeatmapPalette(palette);
  if (resolvedPalette === "pactolis") {
    if (clampedOpacity === 1) {
      if (safeAlphaScale === 1) return HEATMAP_COLOR_LUT_FULL;
      if (safeAlphaScale === 0.45) return HEATMAP_COLOR_LUT_LIVE;
    } else if (clampedOpacity === 0.85) {
      if (safeAlphaScale === 1) return HEATMAP_COLOR_LUT_DEFAULT_FULL;
      if (safeAlphaScale === 0.45) return HEATMAP_COLOR_LUT_DEFAULT_LIVE;
    }
  }
  const key = `${resolvedPalette}|${safeAlphaScale}|${clampedOpacity}`;
  const cached = heatmapColorLutCache.get(key);
  if (cached) return cached;
  if (heatmapColorLutCache.size >= HEATMAP_COLOR_LUT_CACHE_MAX_ENTRIES) {
    const oldestKey = heatmapColorLutCache.keys().next().value;
    if (oldestKey !== undefined) heatmapColorLutCache.delete(oldestKey);
  }
  const lut: readonly string[] = Array.from({ length: 1001 }, (_, q) =>
    formatHeatmapRgba(heatmapCellRgba(q / 1000, safeAlphaScale, clampedOpacity, resolvedPalette)),
  );
  heatmapColorLutCache.set(key, lut);
  return lut;
}

/** Fill color for a cell of the given intensity; `alphaScale` fades it and `opacity` applies user opacity. */
export function heatmapCellColor(
  intensity: number,
  alphaScale = 1,
  opacity = 1,
  palette: OrderbookHeatmapPalette = DEFAULT_HEATMAP_PALETTE,
): string {
  const k = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  const q = Math.round(k * 1000);
  return getHeatmapColorLut(alphaScale, opacity, palette)[q];
}

export function formatHeatmapValue(value: number, unit: "usd" | "btc"): string {
  if (!(value > 0)) return "0";
  if (unit === "btc") {
    if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return value.toFixed(2);
  }
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return value.toFixed(0);
}

/** Merges a response's bars into the cache; a later copy of a bar replaces the earlier one. */
export function mergeHeatmapBars(target: Map<number, OrderbookHeatmapBar>, bars: readonly OrderbookHeatmapBar[]): void {
  for (const bar of bars) {
    areHeatmapCellsSortedByPrice(bar.cells);
    target.set(bar.t, bar);
  }
}

/** Returns true when two bars have identical bucket prices and bid/ask amounts. */
export function heatmapBarCellsEqual(a: OrderbookHeatmapBar | undefined, b: OrderbookHeatmapBar): boolean {
  if (!a) return false;
  if (a === b) return true;
  if (a.cells.length !== b.cells.length) return false;
  for (let i = 0; i < a.cells.length; i++) {
    const ca = a.cells[i];
    const cb = b.cells[i];
    if (ca[0] !== cb[0] || ca[1] !== cb[1] || ca[2] !== cb[2]) return false;
  }
  return true;
}

/** Merges bars into `target` and returns only the bars that were newly added or changed. */
export function mergeHeatmapBarsWithDiff(
  target: Map<number, OrderbookHeatmapBar>,
  bars: readonly OrderbookHeatmapBar[],
): OrderbookHeatmapBar[] {
  const changed: OrderbookHeatmapBar[] = [];
  for (const bar of bars) {
    const existing = target.get(bar.t);
    if (!heatmapBarCellsEqual(existing, bar)) {
      areHeatmapCellsSortedByPrice(bar.cells);
      target.set(bar.t, bar);
      changed.push(bar);
    }
  }
  return changed;
}

export interface ProjectCanonicalHeatmapTailOptions {
  source: OrderbookHeatmapSource;
  customSources?: readonly string[];
  bucketStep: OrderbookHeatmapBucketStep;
  minUsd?: number;
  minBtc?: number;
}

/**
 * Pure WS-first client projection matching backend `HeatmapBuilder`:
 * sums selected sources from a canonical `$25` tail bar, re-buckets to `bucketStep`,
 * applies `minUsd`/`minBtc` thresholds, and caps at `HEATMAP_MAX_CELLS_PER_BAR = 200` strongest levels.
 */
export function projectCanonicalHeatmapTailBar(
  bar: CanonicalHeatmapTailBar,
  options: ProjectCanonicalHeatmapTailOptions,
): OrderbookHeatmapBar {
  if (!Array.isArray(bar.sources) || !Array.isArray(bar.cells)) {
    return { t: bar.t, cells: [] };
  }
  const step = options.bucketStep;
  let allowed: Set<string> | null = null;
  if (options.source === "single") {
    allowed = new Set([HEATMAP_SINGLE_CANONICAL_SOURCE]);
  } else if (options.source === "custom") {
    const custom = normalizeOrderbookHeatmapSources(options.customSources ?? []);
    if (custom.length === 0) return { t: bar.t, cells: [] };
    allowed = new Set(custom);
  }

  const selectedIndices = new Set<number>();
  for (let idx = 0; idx < bar.sources.length; idx++) {
    const rawSource = bar.sources[idx];
    if (typeof rawSource !== "string") continue;
    const sourceId = rawSource.trim().toLowerCase();
    if (sourceId.length === 0) continue;
    if (allowed === null || allowed.has(sourceId)) {
      selectedIndices.add(idx);
    }
  }
  if (selectedIndices.size === 0) {
    return { t: bar.t, cells: [] };
  }

  const buckets = new Map<number, [number, number]>();
  for (const cell of bar.cells) {
    if (!Array.isArray(cell)) continue;
    const priceStart = cell[0];
    const contributions = cell[1];
    if (!Number.isFinite(priceStart) || priceStart < 0 || !Array.isArray(contributions)) continue;
    const index = Math.floor(priceStart / step);
    for (const contribution of contributions) {
      if (!Array.isArray(contribution)) continue;
      const sourceIdx = contribution[0];
      const bid = contribution[1];
      const ask = contribution[2];
      if (!Number.isSafeInteger(sourceIdx) || sourceIdx < 0 || sourceIdx >= bar.sources.length) continue;
      if (!selectedIndices.has(sourceIdx)) continue;
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
      const cleanBid = Math.max(0, bid);
      const cleanAsk = Math.max(0, ask);
      if (cleanBid === 0 && cleanAsk === 0) continue;
      const entry = buckets.get(index);
      if (entry) {
        entry[0] += cleanBid;
        entry[1] += cleanAsk;
      } else {
        buckets.set(index, [cleanBid, cleanAsk]);
      }
    }
  }

  const cells: OrderbookHeatmapCell[] = [];
  for (const [index, [bid, ask]] of buckets) {
    const priceStart = index * step;
    const total = bid + ask;
    if (!(total > 0)) continue;
    if (options.minUsd !== undefined && total < options.minUsd) continue;
    if (options.minBtc !== undefined) {
      const middle = priceStart + step / 2;
      if (!(middle > 0) || total / middle < options.minBtc) continue;
    }
    cells.push([priceStart, Math.round(bid), Math.round(ask)]);
  }

  if (cells.length > HEATMAP_MAX_CELLS_PER_BAR) {
    cells.sort((left, right) => {
      const strengthDiff = (right[1] + right[2]) - (left[1] + left[2]);
      return strengthDiff !== 0 ? strengthDiff : left[0] - right[0];
    });
    cells.length = HEATMAP_MAX_CELLS_PER_BAR;
  }
  cells.sort((left, right) => left[0] - right[0]);
  return { t: bar.t, cells };
}
