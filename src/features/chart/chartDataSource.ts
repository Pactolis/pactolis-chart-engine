import type { FootprintBar } from "../../core/types.js";
import type { EnvelopeMeta } from "../../core/envelope.js";
import type { HistoryBatch, HistoryQuery, HistoryStreamSummary, RefreshStatus } from "./historyContracts.js";

/** A reconnect-repair read: trade-id-exact footprint for one market and range. */
export interface RepairHistoryQuery {
  market: string;
  from: number;
  to: number;
  interval: number;
  priceStep: number;
  signal?: AbortSignal;
  onMeta?: (meta: EnvelopeMeta | undefined) => void;
}

/**
 * Where the chart reads market data from.
 *
 * The chart never talks to the network itself: history, live OHLC seeds,
 * reconnect repair and backend refresh jobs all go through this port. The host
 * application supplies an implementation once, before the first chart mounts,
 * with `configureChartDataSource`.
 */
export interface ChartDataSource {
  /** Stream history in batches; resolves once the whole range is delivered. */
  streamHistory(query: HistoryQuery, onBatch: (batch: HistoryBatch) => void | Promise<void>): Promise<HistoryStreamSummary>;
  /** Read a whole history range at once. */
  collectHistory(query: HistoryQuery): Promise<FootprintBar[]>;
  /** One-shot history read for small, latency-sensitive windows. */
  fetchHistory(query: HistoryQuery): Promise<FootprintBar[]>;
  /** Latest candles for seeding the open bar. */
  fetchLiveOhlc(query: HistoryQuery): Promise<FootprintBar[]>;
  /** Like `fetchLiveOhlc`, but identical concurrent reads share one request. */
  fetchSharedLiveOhlc(query: HistoryQuery): Promise<FootprintBar[]>;
  /** Footprint snapshot used to repair a live trade gap after reconnect. */
  fetchRepairHistory(query: RepairHistoryQuery): Promise<FootprintBar[]>;
  /** Ask the backend to rebuild a range. */
  startRefresh(
    markets: string[],
    interval: number,
    priceStep: number,
    reference: string | undefined,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Poll the backend refresh job. */
  fetchRefreshStatus(signal?: AbortSignal): Promise<RefreshStatus>;
  /** Markets served as candles only, without footprint or live repair support. */
  isDirectCandleMarket(market: string): boolean;
  /** How many bars of history a chart loads when it opens. */
  readonly initialHistoryBars: number;
}

let configured: ChartDataSource | null = null;

/** Install the data source every chart reads from. Call once at startup. */
export function configureChartDataSource(source: ChartDataSource): void {
  configured = source;
}

export function chartDataSource(): ChartDataSource {
  if (configured === null) {
    throw new Error("chart data source is not configured; call configureChartDataSource() before mounting a chart");
  }
  return configured;
}
