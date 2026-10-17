// Orderbook heatmap settings shape and the rules the chart applies to them.
// The app keeps the user's settings in core/state/orderbookHeatmapSettings.ts.

export type OrderbookHeatmapMode = "off" | "single" | "aggregated";
export type OrderbookHeatmapUnit = "usd" | "btc";
export type OrderbookHeatmapStep = 25 | 50 | 100 | 250;

export const ORDERBOOK_HEATMAP_STEPS: readonly OrderbookHeatmapStep[] = [25, 50, 100, 250];

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
}

/** Agreed defaults: 20M$ single, 50M$ aggregated; BTC figures at ~84k BTC. */
export const DEFAULT_ORDERBOOK_HEATMAP_SETTINGS: OrderbookHeatmapSettings = {
  mode: "off",
  unit: "usd",
  bucketStep: 25,
  single: { usd: 20_000_000, btc: 240 },
  aggregated: { usd: 50_000_000, btc: 600 },
};

/** The active mode's threshold in the selected unit. */
export function activeOrderbookHeatmapThreshold(settings: OrderbookHeatmapSettings): number {
  if (settings.mode === "off") return 0;
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
