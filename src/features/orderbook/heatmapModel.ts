// Pure helpers for the chart's orderbook heatmap: tier choice, chunking, bar
// lookup, unit conversion, color range, luminance palette, and WS tail projection. No I/O, no DOM.
import {
  normalizeOrderbookHeatmapSources,
  type OrderbookHeatmapContrast,
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

/**
 * The newest tier bar inside the chart bar `[start, end)`: its values are the
 * book at the chart bar's close (or now, for the live bar).
 */
export function lastHeatmapSubBar(
  bars: ReadonlyMap<number, OrderbookHeatmapBar>,
  start: number,
  end: number,
  tier: HeatmapTier,
): OrderbookHeatmapBar | undefined {
  if (!(end > start)) return undefined;
  for (let t = Math.floor((end - 1) / tier.periodMs) * tier.periodMs; t >= start; t -= tier.periodMs) {
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
): OrderbookHeatmapBar | undefined {
  return lastHeatmapSubBar(bars, start, end, tier) ?? lastHeatmapSubBar(bars, start - (end - start), start, tier);
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

interface HeatmapColorStop {
  readonly k: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Dark-theme luminance ramp: faint deep navy -> cobalt -> vivid turquoise -> warm pale yellow/off-white. */
const HEATMAP_PALETTE_STOPS: readonly HeatmapColorStop[] = [
  { k: 0.0, r: 18, g: 38, b: 84, a: 0.22 },
  { k: 0.4, r: 24, g: 112, b: 168, a: 0.36 },
  { k: 0.75, r: 34, g: 211, b: 238, a: 0.54 },
  { k: 1.0, r: 254, g: 240, b: 178, a: 0.68 },
];

export interface HeatmapRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Computes exact RGBA channels and quantized alpha matching `HEATMAP_GPU_FRAG_SRC`. */
export function heatmapCellRgba(intensity: number, alphaScale = 1, opacity = 1): HeatmapRgba {
  const k = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  const clampedOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  let s0 = HEATMAP_PALETTE_STOPS[0];
  let s1 = HEATMAP_PALETTE_STOPS[1];
  if (k > 0.75) {
    s0 = HEATMAP_PALETTE_STOPS[2];
    s1 = HEATMAP_PALETTE_STOPS[3];
  } else if (k > 0.4) {
    s0 = HEATMAP_PALETTE_STOPS[1];
    s1 = HEATMAP_PALETTE_STOPS[2];
  }
  const t = (k - s0.k) / (s1.k - s0.k);
  const r = Math.floor(s0.r + (s1.r - s0.r) * t + 0.5);
  const g = Math.floor(s0.g + (s1.g - s0.g) * t + 0.5);
  const b = Math.floor(s0.b + (s1.b - s0.b) * t + 0.5);
  const rawAlpha = (s0.a + (s1.a - s0.a) * t) * alphaScale * clampedOpacity;
  const a = Math.floor(Math.min(1, Math.max(0, rawAlpha)) * 1000 + 0.5) / 1000;
  return { r, g, b, a };
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

/** Fill color for a cell of the given intensity; `alphaScale` fades it (the live bar's extension) and `opacity` applies user opacity. */
export function heatmapCellColor(intensity: number, alphaScale = 1, opacity = 1): string {
  const k = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  const clampedOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  const q = Math.round(k * 1000);
  if (clampedOpacity === 1) {
    if (alphaScale === 1) return HEATMAP_COLOR_LUT_FULL[q];
    if (alphaScale === 0.45) return HEATMAP_COLOR_LUT_LIVE[q];
  } else if (clampedOpacity === 0.85) {
    if (alphaScale === 1) return HEATMAP_COLOR_LUT_DEFAULT_FULL[q];
    if (alphaScale === 0.45) return HEATMAP_COLOR_LUT_DEFAULT_LIVE[q];
  }
  return formatHeatmapRgba(heatmapCellRgba(k, alphaScale, clampedOpacity));
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
  for (const bar of bars) target.set(bar.t, bar);
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
