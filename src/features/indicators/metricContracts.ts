// Series shapes for the derivatives and liquidation indicators. The engine reads
// them through IndicatorDataSource; the app's metric clients produce and re-export them.

export type CoinalyzeInterval =
  | "1min"
  | "5min"
  | "15min"
  | "30min"
  | "1hour"
  | "2hour"
  | "4hour"
  | "6hour"
  | "12hour"
  | "daily";

export interface LiquidationComponent {
  exchange: string;
  exchangeKey: string | null;
  symbol: string;
  symbolOnExchange: string;
  longLiquidationsUsd: number;
  shortLiquidationsUsd: number;
}

export interface LiquidationPoint {
  time: number;
  longLiquidationsUsd: number;
  shortLiquidationsUsd: number;
  totalLiquidationsUsd: number;
  liquidationDeltaUsd: number;
  components: LiquidationComponent[];
}

export interface LiquidationMetricSeries {
  source: "coinalyze";
  base: string;
  interval: CoinalyzeInterval;
  from: number;
  to: number;
  selectedExchanges: string[];
  selectedMarketTypes: string[];
  symbols: string[];
  points: LiquidationPoint[];
  truncated?: boolean;
  cacheHit?: boolean;
}

export type LiquidationSeriesState =
  | { status: "idle" }
  | { status: "unsupported"; message: string }
  | { status: "loading" }
  | { status: "ready"; data: LiquidationMetricSeries }
  | { status: "error"; message: string };

export interface LiquidationRequestInput {
  market: string;
  timeframe: string;
  intervalMs: number;
  exchanges: Record<string, boolean>;
  marketTypes: {
    spot?: boolean;
    futuresUsdPerp?: boolean;
    futuresCoinPerp?: boolean;
  };
  onUpdate?: () => void;
}

export type CoinalyzeDerivativeMetric = "openInterest" | "fundingRate" | "predictedFundingRate";

export interface CoinalyzeDerivativeComponent {
  exchange: string;
  exchangeKey: string | null;
  symbol: string;
  symbolOnExchange: string;
  value: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CoinalyzeDerivativePoint {
  time: number;
  value: number;
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
  symbolCount: number;
  components: CoinalyzeDerivativeComponent[];
}

export interface CoinalyzeDerivativeSeries {
  source: "coinalyze";
  metric: CoinalyzeDerivativeMetric;
  base: string;
  interval: CoinalyzeInterval;
  from: number;
  to: number;
  selectedExchanges: string[];
  selectedMarketTypes: string[];
  symbols: string[];
  points: CoinalyzeDerivativePoint[];
  truncated?: boolean;
  cacheHit?: boolean;
}

export type CoinalyzeDerivativeSeriesState =
  | { status: "idle" }
  | { status: "unsupported"; message: string }
  | { status: "loading" }
  | { status: "ready"; data: CoinalyzeDerivativeSeries }
  | { status: "error"; message: string };

export interface CoinalyzeDerivativeRequestInput {
  metric: CoinalyzeDerivativeMetric;
  market: string;
  timeframe: string;
  intervalMs: number;
  exchanges: Record<string, boolean>;
  marketTypes: {
    spot?: boolean;
    futuresUsdPerp?: boolean;
    futuresCoinPerp?: boolean;
  };
  onUpdate?: () => void;
}

export type FuturesPositioningMode =
  | "openInterestUsd"
  | "openInterestDeltaUsd"
  | "globalLongShortRatio"
  | "topTraderLongShortRatio"
  | "takerLongShortVolumeRatio";

export interface FuturesPositioningPoint {
  time: number;
  symbol: string;
  openInterest: number;
  openInterestUsd: number;
  topTraderAccountLongShortRatio: number;
  topTraderPositionLongShortRatio: number;
  globalLongShortRatio: number;
  takerLongShortVolumeRatio: number;
}

export interface FuturesPositioningSeries {
  source: "binance-vision";
  market: string;
  symbol: string;
  interval: "5m";
  intervalMs: number;
  from: number;
  to: number;
  points: FuturesPositioningPoint[];
  count: number;
  missingDays: string[];
  truncated?: boolean;
  cacheHit?: boolean;
}

export type FuturesPositioningSeriesState =
  | { status: "idle" }
  | { status: "unsupported"; message: string }
  | { status: "loading" }
  | { status: "ready"; data: FuturesPositioningSeries }
  | { status: "error"; message: string };

export interface FuturesPositioningRequestInput {
  market: string;
  from: number;
  to: number;
  onUpdate?: () => void;
}

export type FundingVenue = "binancef" | "bybitf" | "okxf" | "hyperliquid";

export interface VenueFundingSettledPoint {
  t: number;
  rate: number;
  intervalHours: number;
  rate8h: number;
}

export interface VenueFundingCurrentPoint {
  t: number;
  rate: number;
  rate8h: number;
  nextFundingTime?: number;
}

export interface VenueFundingSeries {
  venue: FundingVenue;
  symbol?: string;
  intervalHours?: number;
  settled: VenueFundingSettledPoint[];
  current?: VenueFundingCurrentPoint | null;
}

export interface VenueFundingAggregatePoint {
  t: number;
  rate8h: number;
  venues?: FundingVenue[];
  estimated?: boolean;
}

export interface VenueFundingAggregateSeries {
  points: VenueFundingAggregatePoint[];
  current?: {
    t: number;
    rate8h: number;
    venues?: FundingVenue[];
  } | null;
  excludedVenues?: FundingVenue[];
  source?: string;
}

export interface VenueFundingResponse {
  market: string;
  base?: string;
  from: number;
  to: number;
  venues: FundingVenue[];
  series: VenueFundingSeries[];
  aggregate?: VenueFundingAggregateSeries | null;
  excludedVenues?: FundingVenue[];
  source?: string;
  truncated?: boolean;
  cacheHit?: boolean;
}

export type VenueFundingSeriesState =
  | { status: "idle" }
  | { status: "unsupported"; message: string }
  | { status: "loading" }
  | { status: "ready"; data: VenueFundingResponse }
  | { status: "error"; message: string };

export interface VenueFundingRequestInput {
  market: string;
  from: number;
  to: number;
  venues: FundingVenue[];
  onUpdate?: () => void;
}

export type WhaleCrowdVenue = "binance" | "okx" | "hyperliquid";

export interface WhaleCrowdPoint {
  t: number;
  whaleRatio: number | null;
  crowdRatio: number | null;
  spread?: number | null;
  resolution?: string;
  source?: string;
}

export interface WhaleCrowdVenueSeries {
  venue: WhaleCrowdVenue;
  status?: "ready" | "warming" | "unsupported" | "unavailable" | "disabled";
  definition?: string;
  thresholdUsd?: number;
  historyStartedAt?: number | null;
  gaps?: Array<{ from: number; to: number }>;
  points: WhaleCrowdPoint[];
}

export interface WhaleCrowdResponse {
  status: "ready" | "unsupported" | "unavailable" | "disabled";
  venues: WhaleCrowdVenueSeries[];
  source?: "backend" | "browser";
}

export type WhaleCrowdSeriesState =
  | { status: "idle" }
  | { status: "unsupported"; message: string }
  | { status: "loading" }
  | { status: "ready"; data: WhaleCrowdResponse }
  | { status: "error"; message: string };

export interface WhaleCrowdRequestInput {
  market: string;
  from: number;
  to: number;
  venues: WhaleCrowdVenue[];
  onUpdate?: () => void;
}
