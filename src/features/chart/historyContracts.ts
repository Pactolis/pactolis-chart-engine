// Shapes of the history, live-trade and nPOC data the chart engine reads through
// its data ports. The app's data clients re-export them, so the engine does not
// depend on any particular transport.
import type { EnvelopeMeta } from "../../core/envelope.js";
import type { FootprintBar } from "../../core/types.js";

export interface HistoryQuery {
  markets: string[];
  from: number;
  to: number;
  interval: number;
  priceStep: number;
  reference?: string;
  /** Force a fresh full kline re-aggregate (replaces cache); footprint untouched. */
  rebuild?: boolean;
  /** Skip footprint cells for a high-priority candle-only response. */
  includeFootprint?: boolean;
  /** Serve an existing candle cache immediately and revalidate its tail in background. */
  preferCache?: boolean;
  /** Require a source-fresh, bucket-scoped candle ownership fence from /history. */
  candleCoverage?: "required";
  /**
   * Marks this request as background analysis work (e.g. canonical analysis
   * panels) rather than an interactive chart/HUD read, so the bridge's Rust
   * query engine schedules it behind interactive traffic instead of
   * competing with it for the same queue.
   */
  purpose?: "analysis" | "maintenance";
  /** Client-side NDJSON records coalesced into one model/pipeline update (bounded). */
  consumeBatchRecords?: number;
  /** Correlates browser load stages with bridge history timings. */
  traceId?: string;
  signal?: AbortSignal;
  /**
   * Optional callback receiving the response envelope's `meta` (e.g.
   * `meta.degraded`, `meta.provenance[].error`). Lets callers (ChartDataPipeline)
   * surface degraded-data signals into connectionStore without aggr.ts itself
   * depending on any Svelte store (this module is also imported from Node tests).
   */
  onMeta?: (meta: EnvelopeMeta | undefined) => void;
}

export interface HistoryBatch {
  bars: FootprintBar[];
  sequence: number;
  meta?: EnvelopeMeta;
  /** Applied cell count before WireBar â†’ FootprintBar map coalescing. */
  cellCount?: number;
  /** Raw per-bar cell counts, aligned with `bars`; internal client metadata. */
  barCellCounts?: number[];
}

export interface HistoryStreamSummary {
  count: number;
  cellCount: number;
}

export interface RefreshStatus {
  state: "idle" | "running";
  total: number;
  done: number;
  frac: number;
  currentDate?: string;
  message?: string;
  lastDoneAt: number;
}

export interface TradeStreamSession {
  readonly generation: number;
  readonly epoch: number;
  readonly session: string;
  readonly boundaryAt: number;
}

export type NpocPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "half-yearly" | "yearly";

export interface NpocLevel {
  period: NpocPeriod;
  periodStart: number;
  referenceClose: number;
  referenceTradeId: string | null;
  priceStep: number;
  pocLower: number;
  age: number;
  sourceStatus: string;
}

/** 70% value area of the latest closed period of one kind. */
export interface NpocValueArea {
  period: NpocPeriod;
  periodStart: number;
  priceStep: number;
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
}

export interface NpocResponse {
  schemaVersion: 3;
  market: string;
  levels: NpocLevel[];
  /** Absent on backends that predate value areas. */
  valueAreas?: NpocValueArea[];
}
