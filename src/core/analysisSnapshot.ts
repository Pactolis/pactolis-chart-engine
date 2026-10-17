import type { CanonicalAnalysisStatus } from "./analysisRevision.js";

export type AnalysisDataStatus = "ok" | "loading" | "no-data" | "error" | "hidden" | "unsupported";
export type AnalysisScope = "closed-bars" | "visible-range" | "source-period" | "drawing";

export interface AnalysisViewportSnapshot {
  timeFrom: number;
  timeTo: number;
  priceLow: number;
  priceHigh: number;
}

export interface AnalysisFootprintCellSnapshot {
  price: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  delta: number;
  tradeCount?: number;
  buyTradeCount?: number;
  sellTradeCount?: number;
  liquidationBuyVolume?: number;
  liquidationSellVolume?: number;
}

export interface AnalysisCandleSnapshot {
  time: number;
  endTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta?: number;
  count?: number;
  deltaBySize?: number[];
  liquidationBuyVolume?: number;
  liquidationSellVolume?: number;
  footprint?: AnalysisFootprintCellSnapshot[];
}

export interface AnalysisLevelSnapshot {
  id: string;
  source: "previous-week" | "monday-range" | "naked-poc" | "reference-level";
  kind: "line" | "zone";
  label: string;
  status: AnalysisDataStatus;
  price?: number;
  low?: number;
  high?: number;
  sourceStart?: number;
  sourceEnd?: number;
  family?: "eq" | "open" | "level" | "valueArea";
  period?: string;
  valueAreaKind?: "val" | "vah";
  age?: number;
  complete?: boolean;
}

export interface AnalysisDrawingLevelSnapshot {
  key: string;
  label: string;
  price: number;
  ratio?: number;
}

export interface AnalysisOrderFlowProfileLevelSnapshot {
  price: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  value?: number;
  magnitude?: number;
  tradeCount?: number;
  buyTradeCount?: number;
  sellTradeCount?: number;
}

export interface AnalysisOrderFlowProfileSnapshot {
  metric: string;
  side: string;
  valueAreaPercent: number;
  requestedFrom: number;
  requestedTo: number;
  coverage: number;
  complete: boolean;
  dataComplete: boolean;
  poc: number | null;
  vah: number | null;
  val: number | null;
  totalVolume: number;
  totalTradeCount?: number;
  bins: AnalysisOrderFlowProfileLevelSnapshot[];
}

export interface AnalysisDrawingSnapshot {
  id: string;
  type: string;
  label?: string;
  status: AnalysisDataStatus;
  points: Array<{ time: number; price: number }>;
  price?: number;
  low?: number;
  high?: number;
  entry?: number;
  stop?: number;
  target?: number;
  levels?: AnalysisDrawingLevelSnapshot[];
  series?: AnalysisIndicatorSeries[];
  profile?: AnalysisOrderFlowProfileSnapshot;
  summary?: Record<string, number | string | boolean | null>;
  warnings?: string[];
  numericallySupported: boolean;
}

export interface AnalysisIndicatorSample {
  time: number;
  value: number;
  sourceTime?: number;
}

export interface AnalysisIndicatorSeries {
  key: string;
  label: string;
  unit: string;
  samples: AnalysisIndicatorSample[];
}

export interface AnalysisIndicatorSnapshot {
  instanceId: string;
  type: string;
  name: string;
  parameters: Record<string, unknown>;
  status: AnalysisDataStatus;
  scope: AnalysisScope;
  series: AnalysisIndicatorSeries[];
  summary: Record<string, number | string | boolean | null>;
  warnings: string[];
}

export interface AnalysisOrderBookLevelSnapshot {
  price: number;
  size: number;
  notionalUsd: number;
}

export interface AnalysisOrderBookVenueSnapshot {
  instrumentId: string;
  venue: string;
  group: string;
  symbol: string;
  status: string;
  lastUpdateAt: number;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  spreadBps: number | null;
  bidNotionalUsd: number;
  askNotionalUsd: number;
  imbalance: number | null;
  bids: AnalysisOrderBookLevelSnapshot[];
  asks: AnalysisOrderBookLevelSnapshot[];
}

export interface AnalysisOrderBookSnapshot {
  base: "BTC";
  capturedAt: number;
  depthPercent: number;
  priceStep: number;
  requestedLevelsPerSide: number;
  bookLimit: number;
  bookCount: number;
  venueCount: number;
  books: AnalysisOrderBookVenueSnapshot[];
  warnings: string[];
}

export interface ChartAnalysisSnapshot {
  schemaVersion: 1;
  panelId: string;
  market: string;
  timeframe: string;
  intervalMs: number;
  selectionGeneration: number;
  capturedAt: number;
  lastClosedBarEnd: number | null;
  historyStatus: "ready" | "empty";
  automaticAnalysisStatus: CanonicalAnalysisStatus;
  viewport?: AnalysisViewportSnapshot;
  candles: AnalysisCandleSnapshot[];
  levels: AnalysisLevelSnapshot[];
  drawings: AnalysisDrawingSnapshot[];
  indicators: AnalysisIndicatorSnapshot[];
  orderBook?: AnalysisOrderBookSnapshot;
  warnings: string[];
}

export interface AnalysisSnapshotOptions {
  excludedSourceIds?: ReadonlySet<string>;
  /** UI-only scope inspection may request hidden sources; provider input leaves this false. */
  includeHiddenSources?: boolean;
  maxCandles?: number;
  maxLevelsAndDrawings?: number;
  maxIndicatorSamples?: number;
  maxBytes?: number;
  /** Runtime-provided visible time axis bounds. */
  visibleTimeRange?: { from: number; to: number };
  /** Runtime-provided visible price axis bounds. */
  visiblePriceRange?: { low: number; high: number };
  now?: number;
}

/** IDs the model can actually see in the serialized snapshot. */
export function analysisEvidenceIds(snapshot: ChartAnalysisSnapshot): Set<string> {
  return new Set([
    ...snapshot.levels.filter((item) => item.status === "ok").map((item) => item.id),
    ...snapshot.drawings.filter((item) => item.status === "ok").map((item) => item.id),
    ...snapshot.indicators.filter((item) => item.status === "ok").map((item) => item.instanceId),
  ]);
}
