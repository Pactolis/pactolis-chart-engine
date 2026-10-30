// Pure helpers for the chart's orderbook heatmap: tier choice, chunking, bar
// lookup, unit conversion and formatting. No I/O, no DOM.
import type { OrderbookHeatmapBar, OrderbookHeatmapCell, OrderbookResolution } from "./heatmapContracts.js";

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

/**
 * 0..1 color strength on a log scale: the threshold maps to 0 and `ceiling`
 * to 1. The ceiling defaults to ten times the threshold; the chart passes the
 * largest visible value so the biggest wall on screen is always the deepest.
 */
export function heatmapIntensity(value: number, threshold: number, ceiling = threshold * 10): number {
  if (!(value > 0)) return 0;
  if (!(threshold > 0)) return 1;
  const span = Math.log10(Math.max(ceiling, threshold * HEATMAP_MIN_CEILING_RATIO) / threshold);
  const ratio = Math.log10(value / threshold) / span;
  return Math.min(1, Math.max(0, ratio));
}

/** The intensity ceiling never drops below this multiple of the threshold, so a screen of near-threshold walls stays light. */
export const HEATMAP_MIN_CEILING_RATIO = 2;

/** Cell colors from a wall just over the threshold (light, faint) to the largest wall (deep, opaque). */
const HEATMAP_LIGHT_RGB: readonly [number, number, number] = [125, 211, 252];
const HEATMAP_DEEP_RGB: readonly [number, number, number] = [29, 78, 216];
const HEATMAP_LIGHT_ALPHA = 0.28;
const HEATMAP_DEEP_ALPHA = 0.95;

function computeHeatmapCellColor(k: number, alphaScale: number): string {
  const channel = (i: number) => Math.round(HEATMAP_LIGHT_RGB[i] + (HEATMAP_DEEP_RGB[i] - HEATMAP_LIGHT_RGB[i]) * k);
  const alpha = (HEATMAP_LIGHT_ALPHA + (HEATMAP_DEEP_ALPHA - HEATMAP_LIGHT_ALPHA) * k) * alphaScale;
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha.toFixed(3)})`;
}

const HEATMAP_COLOR_LUT_FULL: readonly string[] = Array.from({ length: 1001 }, (_, q) => computeHeatmapCellColor(q / 1000, 1));
const HEATMAP_COLOR_LUT_LIVE: readonly string[] = Array.from({ length: 1001 }, (_, q) => computeHeatmapCellColor(q / 1000, 0.45));

/** Fill color for a cell of the given intensity; `alphaScale` fades it (the live bar's extension). */
export function heatmapCellColor(intensity: number, alphaScale = 1): string {
  const k = Math.min(1, Math.max(0, intensity));
  const q = Math.round(k * 1000);
  if (alphaScale === 1) {
    return HEATMAP_COLOR_LUT_FULL[q];
  }
  if (alphaScale === 0.45) {
    return HEATMAP_COLOR_LUT_LIVE[q];
  }
  return computeHeatmapCellColor(k, alphaScale);
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
