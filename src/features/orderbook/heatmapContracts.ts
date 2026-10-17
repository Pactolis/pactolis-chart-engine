// Orderbook heatmap request and response shapes read by the heatmap overlay.
// The app's orderbook contracts re-export them.

export type OrderbookResolution = "auto" | "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d";

/** Which book the chart heatmap reads: Binance USD-M BTCUSDT alone, or every spot and perp book summed. */
export type OrderbookHeatmapSource = "single" | "aggregated";

export type OrderbookHeatmapBucketStep = 25 | 50 | 100 | 250;

export interface OrderbookHeatmapRequest {
  source: OrderbookHeatmapSource;
  resolution: Exclude<OrderbookResolution, "auto">;
  from: number;
  to: number;
  bucketStep: OrderbookHeatmapBucketStep;
  /** Exactly one threshold, or neither with a price window of at most 64 buckets. */
  minUsd?: number;
  minBtc?: number;
  priceFrom?: number;
  priceTo?: number;
}

/** `[bucket start price, bid USD, ask USD]`. */
export type OrderbookHeatmapCell = [number, number, number];

export interface OrderbookHeatmapBar {
  t: number;
  cells: OrderbookHeatmapCell[];
}

export interface OrderbookHeatmapResponse {
  schemaVersion: number;
  generatedAt: number;
  base: "BTC";
  source: OrderbookHeatmapSource;
  resolution: Exclude<OrderbookResolution, "auto">;
  bucketStep: number;
  from: number;
  to: number;
  bars: OrderbookHeatmapBar[];
}
