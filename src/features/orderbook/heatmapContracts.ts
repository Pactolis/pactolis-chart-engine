// Orderbook heatmap request and response shapes read by the heatmap overlay.
// The app's orderbook contracts re-export them.

export type OrderbookResolution = "auto" | "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d";

/** Which book the chart heatmap reads: single venue, every book summed, or explicit custom sources. */
export type OrderbookHeatmapSource = "single" | "aggregated" | "custom";

export type OrderbookHeatmapBucketStep = 25 | 50 | 100 | 250;

export interface OrderbookHeatmapRequest {
  source: OrderbookHeatmapSource;
  sources?: readonly string[];
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
  requestedSources?: readonly string[];
  observedSources?: readonly string[];
  missingSources?: readonly string[];
}

/** `[sourceIndex, bidUsd, askUsd]` contribution into `CanonicalHeatmapTailBar.sources`. */
export type CanonicalHeatmapTailSourceEntry = readonly [number, number, number];

/** `[bucketStartPrice, contributions]` at canonical `$25` resolution. */
export type CanonicalHeatmapTailCell = readonly [number, readonly CanonicalHeatmapTailSourceEntry[]];

/**
 * Canonical per-source `$25`-bucket tail snapshot bar projected on the client.
 * BE WS delta frames (`{ t, closed, sources, upserts, deletes }`) are merged into
 * snapshot `CanonicalHeatmapTailBar` objects in the frontend WS transport layer
 * before being passed to the chart engine.
 */
export interface CanonicalHeatmapTailBar {
  t: number;
  closed?: boolean;
  sources: readonly string[];
  cells: readonly CanonicalHeatmapTailCell[];
}

/** Live-tail invalidation or push event payload from an external transport (e.g. WebSocket). */
export interface LiveHeatmapTailEvent {
  market?: string;
  timestamp?: number;
  bars?: OrderbookHeatmapBar[];
  canonicalBars?: CanonicalHeatmapTailBar[];
}

/** Subscription parameters describing which market and server-side tail filter to stream. */
export interface LiveHeatmapTailRequest {
  market: string;
  base?: string;
  source?: "single" | "aggregated" | "canonical";
  minQuantityUsd?: number;
  priceStepPct?: number;
  bucketStep?: OrderbookHeatmapBucketStep;
}
