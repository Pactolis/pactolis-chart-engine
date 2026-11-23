// Orderbook heatmap settings shape and the rules the chart applies to them.
// The app keeps the user's settings in core/state/orderbookHeatmapSettings.ts.

export type OrderbookHeatmapMode = "off" | "single" | "aggregated" | "custom";
export type OrderbookHeatmapUnit = "usd" | "btc";
export type OrderbookHeatmapStep = 25 | 50 | 100 | 250;
export type OrderbookHeatmapScaleMode = "auto" | "fixed";
export type OrderbookHeatmapContrast = "low" | "medium" | "high";
export type OrderbookHeatmapPalette = "pactolis" | "viridis" | "cividis" | "inferno";

export const ORDERBOOK_HEATMAP_STEPS: readonly OrderbookHeatmapStep[] = [25, 50, 100, 250];
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

/** Only the Binance USD-M BTCUSDT perp chart carries the overlay. */
export function isOrderbookHeatmapMarket(market: string | null | undefined): boolean {
  if (!market) return false;
  const trimmed = market.trim();
  const separator = trimmed.indexOf(":");
  if (separator < 0) return false;
  return trimmed.slice(0, separator).toUpperCase() === "BINANCE_FUTURES"
    && trimmed.slice(separator + 1).toLowerCase() === "btcusdt";
}
