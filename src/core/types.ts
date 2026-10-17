// Shared domain types for the footprint terminal.

/** A single normalized trade, independent of its upstream venue adapter. */
export interface AggTrade {
  /** Trade time (ms epoch). */
  time: number;
  /** Trade price. */
  price: number;
  /** Quantity (base asset, e.g. BTC). */
  qty: number;
  /** Number of raw fills represented by this event. Binance aggTrades may
   * aggregate multiple fills; absent means one raw fill. */
  tradeCount?: number;
  /** True if the aggressor was a BUYER (taker buy); false = taker sell. */
  isBuy: boolean;
  /** True if this trade was a liquidation. */
  liquidation?: boolean;
  /** Source market "EXCHANGE:pair" when known. */
  market?: string;
  /** Stable source identifier when supplied by the upstream venue. */
  id?: string;
  /** Origin of the normalized event. */
  source?: "history" | "live" | "recovery";
  /** Local receipt time, used for freshness and diagnostics. */
  receivedAt?: number;
  /** Upstream normalized-event session identity when available. */
  sourceSession?: string;
  /** Monotonic sequence within sourceSession when available. */
  sourceSequence?: number;
}

export type DataCompleteness = "complete" | "partial" | "provisional";

/** Buy/sell volume accumulated at one price bin within a candle. */
export interface FootprintCell {
  /** Lower edge of the price bin. */
  priceBin: number;
  /** Taker-buy volume at this bin (aggressive buys). */
  buyVol: number;
  /** Taker-sell volume at this bin (aggressive sells). */
  sellVol: number;
  /** Number of trades folded into this price bin. Optional: 0/absent for
   *  historical cells built before count was carried on the wire. */
  count?: number;
  /** Number of taker-buy trades folded into this price bin. Optional for old caches. */
  buyCount?: number;
  /** Number of taker-sell trades folded into this price bin. Optional for old caches. */
  sellCount?: number;
  /** Forced buy liquidation volume at this price. */
  liquidationBuyVol?: number;
  /** Forced sell liquidation volume at this price. */
  liquidationSellVol?: number;
}

/** One time bucket (candle) holding OHLC and its footprint cells. */
export interface FootprintBar {
  /** Bucket start time (ms epoch), aligned to the interval. */
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Total traded volume in the bucket (buy + sell). */
  volume: number;
  /** buyVol - sellVol across the whole bucket. */
  delta: number;
  /** Optional 10-bucket signed delta by USD notional size (SIZE_BUCKETS_V1). */
  deltaBySize?: number[];
  /** Number of trades folded into this bucket. */
  count: number;
  liquidationBuyVol?: number;
  liquidationSellVol?: number;
  /** Price bin -> cell. */
  cells: Map<number, FootprintCell>;
  /** True once a reference-market trade has set this bar's OHLC. */
  hasRef: boolean;
  /** How authoritative the bar currently is. Live/open bars are provisional. */
  completeness?: DataCompleteness;
  /** Data origins folded into this bar. */
  sources?: ("history" | "live" | "recovery")[];
  /** Last local mutation time. */
  updatedAt?: number;
  /**
   * Bumped whenever this bar's cells change. Render caches key on it instead of
   * `updatedAt`, which is a wall clock taken from the trade and so can repeat within
   * a millisecond or go backwards. Per-bar, not global: a cache only ever compares a
   * bar against its own previous value. Never serialized.
   */
  cellRevision?: number;
}
