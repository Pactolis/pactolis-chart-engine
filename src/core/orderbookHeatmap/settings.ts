// Orderbook heatmap settings shape and the rules the chart applies to them.
// The app keeps the user's settings in core/state/orderbookHeatmapSettings.ts.

export type OrderbookHeatmapMode = "off" | "single" | "aggregated" | "custom";
export type OrderbookHeatmapUnit = "usd" | "btc";
export type OrderbookHeatmapStep = number;
export type OrderbookHeatmapBucketStepMultiplier = 1 | 2 | 4 | 10;
export type OrderbookHeatmapScaleMode = "auto" | "fixed";
export type OrderbookHeatmapContrast = "low" | "medium" | "high";
export type OrderbookHeatmapPalette = "pactolis" | "viridis" | "cividis" | "inferno";

export const ORDERBOOK_HEATMAP_STEPS: readonly OrderbookHeatmapStep[] = [25, 50, 100, 250];
export const ORDERBOOK_HEATMAP_STEP_MULTIPLIERS: readonly OrderbookHeatmapBucketStepMultiplier[] = [1, 2, 4, 10];
export const DEFAULT_HEATMAP_BUCKET_STEP_MULTIPLIER: OrderbookHeatmapBucketStepMultiplier = 1;
export const DEFAULT_HEATMAP_RELATIVE_PCT = 0.0002;
export const ORDERBOOK_HEATMAP_PALETTES: readonly OrderbookHeatmapPalette[] = [
  "pactolis",
  "viridis",
  "cividis",
  "inferno",
];
export const DEFAULT_HEATMAP_OPACITY = 0.85;
export const DEFAULT_HEATMAP_SCALE_MODE: OrderbookHeatmapScaleMode = "auto";
export const DEFAULT_HEATMAP_CONTRAST: OrderbookHeatmapContrast = "medium";
export const DEFAULT_HEATMAP_PALETTE: OrderbookHeatmapPalette = "pactolis";

export function resolveOrderbookHeatmapPalette(palette: unknown): OrderbookHeatmapPalette {
  return palette === "viridis" || palette === "cividis" || palette === "inferno"
    ? palette
    : DEFAULT_HEATMAP_PALETTE;
}

export interface OrderbookHeatmapThresholds {
  /** Minimum bid+ask per bucket in USD. */
  usd: number;
  /** Minimum bid+ask per bucket in BTC. */
  btc: number;
}

export interface OrderbookHeatmapSettings {
  mode: OrderbookHeatmapMode;
  unit: OrderbookHeatmapUnit;
  bucketStep: OrderbookHeatmapStep;
  bucketStepMultiplier?: OrderbookHeatmapBucketStepMultiplier;
  single: OrderbookHeatmapThresholds;
  aggregated: OrderbookHeatmapThresholds;
  custom?: OrderbookHeatmapThresholds;
  customSources?: readonly string[];
  opacity?: number;
  scaleMode?: OrderbookHeatmapScaleMode;
  fixedCeiling?: OrderbookHeatmapThresholds;
  contrast?: OrderbookHeatmapContrast;
  palette?: OrderbookHeatmapPalette;
}

/** Normalizes source identifiers: trim, lowercase, deduplicate, and sort lexicographically. */
export function normalizeOrderbookHeatmapSources(sources: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const source of sources) {
    const normalized = source.trim().toLowerCase();
    if (normalized.length > 0) unique.add(normalized);
  }
  return Array.from(unique).sort();
}

/** Resolves effective heatmap opacity in `[0, 1]`, defaulting to `0.85`. */
export function resolveOrderbookHeatmapOpacity(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) return DEFAULT_HEATMAP_OPACITY;
  return Math.min(1, Math.max(0, opacity));
}

/** Agreed defaults: 20M$ single, 50M$ aggregated; BTC figures at ~84k BTC. */
export const DEFAULT_ORDERBOOK_HEATMAP_SETTINGS: OrderbookHeatmapSettings = {
  mode: "off",
  unit: "usd",
  bucketStep: 25,
  bucketStepMultiplier: DEFAULT_HEATMAP_BUCKET_STEP_MULTIPLIER,
  single: { usd: 20_000_000, btc: 240 },
  aggregated: { usd: 50_000_000, btc: 600 },
  custom: { usd: 20_000_000, btc: 240 },
  customSources: [],
  opacity: DEFAULT_HEATMAP_OPACITY,
  scaleMode: DEFAULT_HEATMAP_SCALE_MODE,
  fixedCeiling: { usd: 100_000_000, btc: 1_200 },
  contrast: DEFAULT_HEATMAP_CONTRAST,
  palette: DEFAULT_HEATMAP_PALETTE,
};

/** The active mode's threshold in the selected unit. */
export function activeOrderbookHeatmapThreshold(settings: OrderbookHeatmapSettings): number {
  if (settings.mode === "off") return 0;
  if (settings.mode === "custom") return settings.custom?.[settings.unit] ?? 0;
  return settings[settings.mode][settings.unit];
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const str = value.toString();
  const eIdx = str.indexOf("e-");
  if (eIdx !== -1) {
    const mantissa = str.slice(0, eIdx);
    const exp = Number(str.slice(eIdx + 2));
    const dotIdx = mantissa.indexOf(".");
    const frac = dotIdx >= 0 ? mantissa.length - dotIdx - 1 : 0;
    return exp + frac;
  }
  const dotIdx = str.indexOf(".");
  return dotIdx >= 0 ? str.length - dotIdx - 1 : 0;
}

export interface ComputeRelativeHeatmapBucketStepInput {
  lastPrice: number;
  priceStep: number;
  pctOfPrice?: number;
  multiplier?: number;
}

/**
 * Computes a relative heatmap bucket step from `lastPrice * pctOfPrice * multiplier`,
 * rounded to an exact multiple of `priceStep` and clamped `>= priceStep` without
 * IEEE-754 floating-point drift on tiny altcoin tick sizes.
 */
export function computeRelativeHeatmapBucketStep(input: ComputeRelativeHeatmapBucketStepInput): number {
  const safePriceStep = Number.isFinite(input.priceStep) && input.priceStep > 0 ? input.priceStep : 1;
  const safeLastPrice = Number.isFinite(input.lastPrice) && input.lastPrice > 0 ? input.lastPrice : 0;
  if (safeLastPrice === 0) return safePriceStep;
  const pct = Number.isFinite(input.pctOfPrice) && (input.pctOfPrice ?? 0) > 0
    ? (input.pctOfPrice as number)
    : DEFAULT_HEATMAP_RELATIVE_PCT;
  const mult = Number.isFinite(input.multiplier) && (input.multiplier ?? 0) > 0
    ? (input.multiplier as number)
    : DEFAULT_HEATMAP_BUCKET_STEP_MULTIPLIER;
  const raw = safeLastPrice * pct * mult;
  const multiple = Math.max(1, Math.round(raw / safePriceStep));
  const decimals = decimalPlaces(safePriceStep);
  const step = decimals > 0 && decimals <= 15
    ? Number((multiple * safePriceStep).toFixed(decimals))
    : multiple * safePriceStep;
  return step >= safePriceStep ? step : safePriceStep;
}

/** Returns true when price moved by at least `thresholdPct` (default 20%) from `anchorPrice`. */
export function shouldRecalculateRelativeBucketStep(
  anchorPrice: number,
  currentPrice: number,
  thresholdPct = 0.2,
): boolean {
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) return true;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  return Math.abs(currentPrice - anchorPrice) / anchorPrice >= thresholdPct;
}

/** Only Binance USD-M BTCUSDT perp has stored backend REST heatmap history. */
export function isOrderbookHeatmapHistoryMarket(market: string | null | undefined): boolean {
  if (!market) return false;
  const trimmed = market.trim();
  const separator = trimmed.indexOf(":");
  if (separator < 0) return false;
  return trimmed.slice(0, separator).toUpperCase() === "BINANCE_FUTURES"
    && trimmed.slice(separator + 1).toLowerCase() === "btcusdt";
}

/**
 * Any valid `EXCHANGE:symbol` market can carry the orderbook heatmap overlay:
 * Binance BTCUSDT perp uses stored REST history + WS tail, while non-BTC markets
 * use browser-collected live tail without REST history requests.
 */
export function isOrderbookHeatmapMarket(market: string | null | undefined): boolean {
  if (!market) return false;
  const trimmed = market.trim();
  const separator = trimmed.indexOf(":");
  return separator > 0 && separator < trimmed.length - 1;
}
