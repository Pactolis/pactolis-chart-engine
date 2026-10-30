/** Per-panel historical/live chart data facade. */
import { FootprintSeries } from "../../core/model/footprint.js";
import { validateBar } from "../../core/dataContracts.js";
import type { HistoryBatch, HistoryQuery } from "./historyContracts.js";
import { WEEK_MS, bucketEnd, bucketStart } from "../../core/time.js";
import { footprintEnabledAt } from "../../core/footprintPolicy.js";
import { isFootprintSyncAllowed, recordFootprintSupport } from "../../core/syncAllowlist.js";
import type { AggTrade, FootprintBar } from "../../core/types.js";
import type { CandleCoverage, EnvelopeMeta } from "../../core/envelope.js";
import type { ChartDataStateInputs } from "./chartDataState.js";
import {
  incrementPerformanceCounter,
  measurePerformance,
  recordPerformanceDuration,
} from "../../core/performanceTelemetry.js";
import {
  classifyLiveTradeUpdate,
  makeDataUpdateEvent,
  snapshotFromSeries,
  type ChartDataSnapshot,
  type ChartDataUpdateEvent,
} from "../../core/dataUpdateEvent.js";
import { createLoadTrace, logLoadTrace } from "../../core/loadTrace.js";
import type { ChartDataPipelineServices, PipelineIntegrityReporter, TradeMarketReadiness } from "./ChartDataPipelinePorts.js";
import { LiveTradeRepairController, type RepairSnapshotInput } from "./LiveTradeRepairController.js";
import {
  HISTORY_MAX_WINDOW_BARS,
  HISTORY_MAX_WINDOW_CELLS,
  historyCellBudgetError,
  planHistoryWindows,
  planTwoPhaseCellWindows,
  splitHistoryCellBudgetWindow,
  splitOversizedHistoryWindow,
} from "./historyWindowPolicy.js";
import { chartDataSource } from "./chartDataSource.js";
import { abortableDelay } from "./abortableDelay.js";
import {
  DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT,
  DEFAULT_LIVE_TRADE_FLUSH_BUDGET_MS,
  liveTradeFlushBudgetExpired,
  nextLiveTradeFlushBatchSize,
  nextLiveTradeSubBatchSize,
} from "./liveTradeFlushBudget.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const M1_BASE_RETENTION_DAYS = 85;
const FILL_RETRY_COOLDOWN_MS = 5 * 60_000;
const FILL_REFRESH_POLL_MS = 1_500;
const FILL_REFRESH_TIMEOUT_MS = 90_000;
const LIVE_OHLC_REQUEST_TIMEOUT_MS = 20_000;
const RECENT_COVERAGE_REPAIR_BUFFER_CAP = 10_000;
const PENDING_TRADE_BUFFER_CAP = 10_000;
const HIDDEN_FLUSH_DELAY_MS = 250;
/**
 * While the page is hidden the flush timer is the browser's to delay: Chromium wakes a hidden
 * page's timers about once a second, and a chained timer once a minute after 5 minutes hidden.
 * Trades keep arriving meanwhile, so a hidden queue drains on arrival once it holds this many
 * (one visible drain turn), and never depends on when the timer fires (#315).
 */
const THROTTLED_QUEUE_LIMIT = DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT;
/** No frame to protect while hidden, but one drain still yields well inside a long task. */
const THROTTLED_DRAIN_BUDGET_MS = 16;
const RECENT_COVERAGE_SOURCE = "binance-usdm-aggTrade";
const DECIMAL_TRADE_ID = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

export type RecentFootprintRepairOutcome = "complete" | "retry" | "stop";

interface RecentCoverageRepairState {
  controller: AbortController;
  generation: number;
  trades: AggTrade[];
  journal: Set<AggTrade>;
  applied: Set<AggTrade>;
  overflow: boolean;
}

interface ExplicitHistoryReconcileState {
  generation: number;
  requestedFrom: number;
  requestedTo: number;
  bootstrapFrom: number;
  trades: AggTrade[];
  applied: Set<AggTrade>;
  deferred: Set<AggTrade>;
  liveAfterBarrier: Set<AggTrade>;
  watermark: bigint | null;
  candleCoverage: CandleCoverage | null;
  retiredWatermarks: Map<number, bigint>;
}

function decimalTradeId(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 20 || !DECIMAL_TRADE_ID.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_U64 ? parsed : null;
}

function candleSnapshotOwnsBucket(
  coverage: CandleCoverage | null,
  market: string,
  bucket: number,
  interval: number,
): boolean {
  if (!coverage || coverage.schemaVersion !== 1 || coverage.source !== "binance-klines") return false;
  if (coverage.instrument !== market || coverage.ownership !== "snapshot" || coverage.status !== "verified") return false;
  if (!Number.isFinite(coverage.snapshotAt) || !Number.isFinite(coverage.closedThrough)) return false;
  if (!Number.isFinite(coverage.requestedFrom) || !Number.isFinite(coverage.requestedTo)) return false;
  const end = bucketEnd(bucket, interval);
  return bucket >= bucketStart(coverage.requestedFrom, interval)
    && bucket <= bucketStart(coverage.requestedTo, interval)
    && end - 1 <= coverage.closedThrough!;
}

function recentCoverageHardFailure(meta: EnvelopeMeta | undefined): boolean {
  if (meta?.footprint?.available === false) return true;
  const provenanceError = meta?.provenance?.some((entry) => Boolean(entry.error)) ?? false;
  const droppedBars = meta?.footprint?.droppedBars ?? 0;
  if (meta?.degraded === true && (provenanceError || droppedBars <= 0)) return true;
  const status = meta?.footprintCoverage?.status;
  return status === "gap" || status === "degraded" || status === "error";
}

function samePriceStructure(previous: readonly FootprintBar[], next: readonly FootprintBar[]): boolean {
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i++) {
    const a = previous[i];
    const b = next[i];
    if (a.startTime !== b.startTime || a.open !== b.open || a.high !== b.high || a.low !== b.low || a.close !== b.close) return false;
  }
  return true;
}

/**
 * Strip every field the repair barrier owns, leaving the candle. `cells`, `deltaBySize`
 * and the bar-level liquidation volumes all accumulate from live trades only under the
 * barrier's `includeCells` gate (see core/model/footprint.ts), so each of them is the
 * trade-id repair snapshot's to supply — `deltaBySize` included, which otherwise feeds
 * size-bucketed CVD a distribution no repair has proven. Returns the bar untouched when
 * there is nothing to strip.
 */
function candleOnlyBar(bar: FootprintBar): FootprintBar {
  if (
    bar.cells.size === 0
    && bar.deltaBySize === undefined
    && !bar.liquidationBuyVol
    && !bar.liquidationSellVol
  ) return bar;
  return {
    ...bar,
    cells: new Map(),
    deltaBySize: undefined,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
  };
}

/** Adds `from`'s bar and cell liquidation volumes onto `into`, a snapshot bar that has none of its own. */
function carryLiquidations(from: FootprintBar, into: FootprintBar): void {
  if (!from.liquidationBuyVol && !from.liquidationSellVol) return;
  into.liquidationBuyVol = (into.liquidationBuyVol ?? 0) + (from.liquidationBuyVol ?? 0);
  into.liquidationSellVol = (into.liquidationSellVol ?? 0) + (from.liquidationSellVol ?? 0);
  for (const [bin, cell] of from.cells) {
    if (!cell.liquidationBuyVol && !cell.liquidationSellVol) continue;
    let target = into.cells.get(bin);
    if (!target) {
      target = { priceBin: bin, buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 };
      into.cells.set(bin, target);
    }
    target.liquidationBuyVol = (target.liquidationBuyVol ?? 0) + (cell.liquidationBuyVol ?? 0);
    target.liquidationSellVol = (target.liquidationSellVol ?? 0) + (cell.liquidationSellVol ?? 0);
  }
}

function lowerBoundByStartTime(bars: readonly FootprintBar[], target: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bars[mid].startTime < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface TradeFlushScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
  /** True while requested turns may be held back indefinitely (a hidden page's throttled timers). */
  isThrottled?(): boolean;
}

function defaultTradeFlushScheduler(): TradeFlushScheduler {
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
  if (!raf) return { request: (cb) => { cb(); return 0; }, cancel: () => undefined };
  const doc = typeof document !== "undefined" ? document : null;
  let nextHandle = 1;
  const pending = new Map<number, { cb: () => void; rafHandle: number | null; timer: ReturnType<typeof setTimeout> | null; onVisibility: (() => void) | null }>();
  const clearNative = (entry: { rafHandle: number | null; timer: ReturnType<typeof setTimeout> | null }): void => {
    if (entry.rafHandle !== null) caf?.(entry.rafHandle);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.rafHandle = null;
    entry.timer = null;
  };
  const finish = (handle: number): void => {
    const entry = pending.get(handle);
    if (!entry) return;
    pending.delete(handle);
    clearNative(entry);
    if (doc && entry.onVisibility) doc.removeEventListener("visibilitychange", entry.onVisibility);
    entry.cb();
  };
  const schedule = (handle: number): void => {
    const entry = pending.get(handle);
    if (!entry) return;
    clearNative(entry);
    if (doc?.visibilityState === "hidden") entry.timer = setTimeout(() => finish(handle), HIDDEN_FLUSH_DELAY_MS);
    else entry.rafHandle = raf(() => finish(handle));
  };
  return {
    request: (cb) => {
      const handle = nextHandle++;
      const entry = { cb, rafHandle: null, timer: null, onVisibility: null as (() => void) | null };
      if (doc) entry.onVisibility = () => schedule(handle);
      pending.set(handle, entry);
      if (doc && entry.onVisibility) doc.addEventListener("visibilitychange", entry.onVisibility);
      schedule(handle);
      return handle;
    },
    cancel: (handle) => {
      const entry = pending.get(handle);
      if (!entry) return;
      pending.delete(handle);
      clearNative(entry);
      if (doc && entry.onVisibility) doc.removeEventListener("visibilitychange", entry.onVisibility);
    },
    isThrottled: () => doc?.visibilityState === "hidden",
  };
}

async function raceWithFallback<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const PRICE_STEP_RESOLVE_TIMEOUT_MS = 6000;
/**
 * Background retries for a market selection's step lookup that came back unresolved (for
 * example while the Gateway was briefly not online). The mount path retries on its own; a
 * selection has only this chain, so without it the fallback grid would stay for good.
 */
export const SELECTION_PRICE_STEP_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000];

export interface PipelineOptions {
  market: string;
  intervalMs: number;
  priceStep: number;
  pricePrecision?: number;
  services: ChartDataPipelineServices;
  scheduler?: TradeFlushScheduler;
  priceStepResolveTimeoutMs?: number;
  priceStepRetryDelaysMs?: readonly number[];
  onDataDegraded?: (degraded: boolean, detail: string) => void;
  onServerPriceStep?: (step: number) => void | Promise<void>;
}

export interface LoadHistoryOpts {
  from: number;
  to: number;
  targetBars?: number;
  rebuildKlines?: boolean;
  preferCache?: boolean;
  signal?: AbortSignal;
  twoPhase?: boolean;
}

export type PipelineDataStateInputs = Omit<ChartDataStateInputs, "historyStatus" | "footprintSupported" | "transportOffline">;

export class ChartDataPipeline {
  readonly series: FootprintSeries;
  readonly services: ChartDataPipelineServices;
  readonly integrityReporter?: PipelineIntegrityReporter;

  private unsubscribe: (() => void) | null = null;
  private subscribedMarket: string | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private readinessUnsubscribe: (() => void) | null = null;
  private latestMarketReadiness: TradeMarketReadiness | null = null;
  private disposed = false;
  private _market: string;
  private _intervalMs: number;
  private paused = false;
  private lastBarStart = -1;
  private lastAppliedTradeTime = -Infinity;
  private historyController: AbortController | null = null;
  private liveOhlcController: AbortController | null = null;
  private liveOhlcPromise: Promise<void> | null = null;
  private patchDayController: AbortController | null = null;
  private patchDayChain: Promise<void> = Promise.resolve();
  private readonly patchDayQueued = new Set<number>();
  private generation = 0;
  private fillCellsInFlightKey: string | null = null;
  private readonly fillCellsAttempted = new Map<number, number>();
  private lastPublishedDay: number | null = null;
  private fillCellsController: AbortController | null = null;
  private fillCellsPending: { from: number; to: number } | null = null;
  private readonly scheduler: TradeFlushScheduler;
  private readonly stepResolveTimeoutMs: number;
  private readonly stepRetryDelaysMs: readonly number[];
  /** Aborted on dispose so a pending step-lookup retry leaves no timer behind. */
  private readonly disposal = new AbortController();
  private pendingTrades: AggTrade[] = [];
  private flushScheduled = false;
  private flushHandle: number | null = null;
  private pendingTradeOverloaded = false;
  private pendingTradeDataLoss = false;
  private readonly onDataDegraded?: (degraded: boolean, detail: string) => void;
  /** Held trade identity conflict, valid until the series is next reset (see `conflictHeld`). */
  private identityConflict: { detail: string; seriesEpoch: number } | null = null;
  private readonly onServerPriceStep?: (step: number) => void | Promise<void>;
  private readonly repair: LiveTradeRepairController;
  private recentCoverageRepair: RecentCoverageRepairState | null = null;
  private explicitHistoryReconcile: ExplicitHistoryReconcileState | null = null;

  onUpdate: ((event: ChartDataUpdateEvent) => void) | null = null;
  onBeforeUpdate: ((kind: ChartDataUpdateEvent["kind"]) => void) | null = null;
  onHistoryCandlesReady: (() => void) | null = null;
  onBarClose: ((closed: FootprintBar) => void) | null = null;
  activeHistoryTraceId: string | undefined;
  activeHistoryFootprintReceived = false;
  activeHistoryFootprintAvailable = true;
  activeHistoryFootprintCoverageComplete = false;
  /**
   * Range of the active history load whose candle source failed (`candleCoverage.status` "error").
   * Bars already on the chart are kept there; the history controller asks for the range again.
   */
  activeHistoryCandleSourceGap: { from: number; to: number } | null = null;
  private activeHistoryCoverageSeen = false;
  private activeHistoryCoverageAllComplete = true;
  /** Earliest time an incomplete coverage report left uncovered; -Infinity when it could not be placed. */
  private activeHistoryFootprintUncoveredFrom = Infinity;
  /** The active history load had a degraded window that was not a candle-source gap. */
  private activeHistoryFootprintDegraded = false;
  private activeHistoryFootprintDetail = "";
  private activeHistoryErrorDetail = "";
  /** The latest history load read candles from Binance directly and asked for no footprint. */
  activeHistoryCandlesOnly = false;
  /** Last state this pipeline reported to its integrity gate. */
  private integrityState: { state: "pending" | "healthy" | "error"; detail: string } = { state: "healthy", detail: "" };
  pendingStepCorrection: Promise<number | null> = Promise.resolve(null);
  /** Price step/precision lookup of the latest market switch; a timeframe change made meanwhile waits for it. */
  private pendingMarketMetadata: Promise<void> | null = null;

  /**
   * Fold a response envelope's meta into pipeline state. `reportDegraded` is how a
   * caller says its meta does not speak for the panel's own data: the bookkeeping
   * below (footprint support, published day, server price step) still runs,
   * but the status-bar degraded badge is left alone.
   */
  private readonly handleMeta = (meta: EnvelopeMeta | undefined, reportDegraded = true): void => {
    if (meta?.footprint?.available === false) this.activeHistoryFootprintAvailable = false;
    recordFootprintSupport(this._market, meta?.footprint?.allowed);
    const publishedThrough = meta?.footprint?.lastPublishedDay;
    if (typeof publishedThrough === "number" && publishedThrough >= 0) this.lastPublishedDay = publishedThrough;
    this.reportServerPriceStep(meta);
    if (!reportDegraded) return;
    if (meta?.degraded) {
      const errorEntries = (meta.provenance ?? []).filter((p): p is typeof p & { error: string } => Boolean(p.error));
      const droppedBars = meta.footprint?.droppedBars ?? 0;
      const reasonCode = meta.footprintCoverage?.reasonCode;
      const footprintParts = errorEntries.map((p) => (p.source && !p.error.includes(p.source) ? `${p.source}: ${p.error}` : p.error));
      if (droppedBars > 0) footprintParts.push(`Footprint dropped ${droppedBars} bars`);
      if (reasonCode && !footprintParts.some((part) => part.includes(reasonCode))) footprintParts.push(`Reason: ${reasonCode}`);
      this.activeHistoryFootprintDetail = footprintParts.join(" · ");
      if (this.onDataDegraded) {
        const provenanceDetail = errorEntries.length > 1
          ? errorEntries.map((p) => (p.source && !p.error.includes(p.source) ? `${p.source}: ${p.error}` : p.error)).join(" · ")
          : errorEntries[0]?.error;
        const detail = provenanceDetail ?? (droppedBars > 0 ? `Footprint dropped ${droppedBars} bars` : (reasonCode ?? ""));
        this.onDataDegraded(true, detail);
      }
    } else {
      this.onDataDegraded?.(false, "");
    }
  };

  private reportServerPriceStep(meta: EnvelopeMeta | undefined): void {
    // Fire-and-forget consumer of the notifier: keep the optional adoption return
    // handled so history metadata can never leak an unhandled rejection.
    void Promise.resolve(this.reportServerStepValue(meta?.footprint?.priceStep))
      .catch(() => { /* history failures surface through the load error state */ });
  }

  /**
   * Guarded pure notifier for a server-served price step: a history envelope's
   * footprint grid or a resolved selection-metadata correction. It only reports;
   * adoption belongs to the consumer's managed setter. The call stays synchronous;
   * it may return the consumer's owned adoption promise for awaiting callers,
   * while fire-and-forget callers keep their own error handling.
   */
  private reportServerStepValue(serverStep: number | undefined): Promise<void> | void {
    if (!this.onServerPriceStep || serverStep === undefined || !Number.isFinite(serverStep) || !(serverStep > 0)) return;
    if (Math.abs(serverStep - this.series.config.priceStep) <= serverStep * 1e-9) return;
    // Pure optional notifier: the pipeline only reports the served grid. Adopting it
    // here (series.setPriceStep) would clear every bar, dedup floor and repair fence
    // and bump the reset epoch while bypassing the managed setPriceStep contract
    // (generation/cancel/queue reset). Adoption belongs to the consumer: the runtime
    // callback re-enters through its managed setter (reset + reload); callers
    // re-verify load ownership after it before touching load state.
    return this.onServerPriceStep(serverStep);
  }

  constructor(opts: PipelineOptions) {
    this._market = opts.market;
    this._intervalMs = opts.intervalMs;
    this.services = opts.services;
    const integrityReporter = this.services.acquirePipelineIntegrityReporter?.();
    // A trade identity conflict stays reported until the series is reset: unrelated
    // history or repair successes do not re-derive the contradicted trade.
    // Always wrapped, so the chart's own data state knows its gate even without a shared reporter.
    this.integrityReporter = {
      report: (state, detail) => {
        if (this.conflictHeld() && state !== "error") return;
        this.integrityState = { state, detail: detail ?? "" };
        integrityReporter?.report(state, detail);
      },
      dispose: () => integrityReporter?.dispose(),
    };
    this.integrityReporter?.report("healthy");
    const onDataDegraded = opts.onDataDegraded;
    this.onDataDegraded = onDataDegraded && ((degraded, detail) => {
      if (!degraded && this.conflictHeld()) return;
      onDataDegraded(degraded, detail);
    });
    this.onServerPriceStep = opts.onServerPriceStep;
    this.scheduler = opts.scheduler ?? defaultTradeFlushScheduler();
    this.stepResolveTimeoutMs = opts.priceStepResolveTimeoutMs ?? PRICE_STEP_RESOLVE_TIMEOUT_MS;
    this.stepRetryDelaysMs = opts.priceStepRetryDelaysMs ?? SELECTION_PRICE_STEP_RETRY_DELAYS_MS;
    this.series = new FootprintSeries({ intervalMs: opts.intervalMs, priceStep: opts.priceStep, referenceMarket: opts.market });
    if (opts.pricePrecision !== undefined) this.series.setPricePrecision(opts.pricePrecision);

    this.repair = new LiveTradeRepairController({
      services: this.services,
      series: this.series,
      integrityReporter: this.integrityReporter,
      isDisposed: () => this.disposed,
      getGeneration: () => this.generation,
      getMarket: () => this._market,
      getIntervalMs: () => this._intervalMs,
      getLastAppliedTradeTime: () => this.lastAppliedTradeTime,
      onBeforeHistoryPatch: () => this.onBeforeUpdate?.("history-patched"),
      emitHistoryPatch: (previous) => this._emitUpdate("history-patched", "history", previous),
      reconcileHistorySnapshot: (input) => this._reconcileRepairSnapshot(input),
      handleMeta: (meta) => this.handleLiveBootstrapMeta(meta),
      setDataDegraded: (degraded, detail) => this.onDataDegraded?.(degraded, detail),
      reportIdentityConflicts: (count) => this.reportIdentityConflicts(count),
      onReconciled: () => {
        this.pendingTradeDataLoss = false;
        this.pendingTradeOverloaded = false;
      },
      trace: (stage, fields) => logLoadTrace(this.activeHistoryTraceId, stage, fields),
    });

    this._subscribe();
    const readinessSupported = typeof this.services.subscribeToTradeMarketReadiness === "function";
    this.sessionUnsubscribe = this.services.subscribeToTradeSessions?.((session) => {
      this.cancelRecentFootprintCoverageRepair();
      this.repair.onSession(session, !readinessSupported);
    }) ?? null;
    this.readinessUnsubscribe = this.services.subscribeToTradeMarketReadiness?.((readiness) => {
      if (this.disposed) return;
      if (readiness.market !== this._market) return;
      // A venue-recovery gap is repaired once; a later timeframe change replays only the boundary.
      const { repairFrom: _repairFrom, ...boundary } = readiness;
      this.latestMarketReadiness = boundary;
      logLoadTrace(this.activeHistoryTraceId, "stream.market.acknowledged", { market: readiness.market, generation: readiness.generation });
      this.repair.onMarketReady(readiness);
    }) ?? null;
  }

  get market(): string { return this._market; }
  get intervalMs(): number { return this._intervalMs; }
  get liveBootstrapReconciled(): boolean { return this.repair.isReconciled; }

  /** The pipeline-owned part of the chart's data state (#314); see chartDataState.ts. */
  dataStateInputs(): PipelineDataStateInputs {
    const gap = this.activeHistoryCandleSourceGap;
    const candleSourceGapDetail = gap
      ? `Gap ${new Date(gap.from).toISOString()} .. ${new Date(gap.to).toISOString()}`
      : "";
    let footprintDetail = this.activeHistoryFootprintDetail;
    if (!footprintDetail) {
      if (this.pendingTradeDataLoss && this.integrityState.detail) {
        footprintDetail = this.integrityState.detail;
      } else if (this.recentCoverageRepair !== null) {
        footprintDetail = "Recent footprint coverage repair in progress";
      } else if (
        this.activeHistoryCoverageSeen
        && !this.activeHistoryFootprintCoverageComplete
        && Number.isFinite(this.activeHistoryFootprintUncoveredFrom)
      ) {
        footprintDetail = `Uncovered from ${new Date(this.activeHistoryFootprintUncoveredFrom).toISOString()}`;
      }
    }
    return {
      historyErrorDetail: this.activeHistoryErrorDetail,
      candleSourceGap: gap !== null,
      candleSourceGapDetail,
      integrity: this.integrityState.state,
      integrityDetail: this.integrityState.detail,
      liveTradesDropped: this.pendingTradeDataLoss,
      liveBacklogOverloaded: this.pendingTradeOverloaded,
      footprintReceived: this.activeHistoryFootprintReceived,
      footprintCoverageReported: this.activeHistoryCoverageSeen,
      footprintCoverageComplete: this.activeHistoryFootprintCoverageComplete,
      footprintHistoryDegraded: this.activeHistoryFootprintDegraded,
      footprintDetail,
      recentFootprintRepairActive: this.recentCoverageRepair !== null,
      lastTradeTime: Number.isFinite(this.lastAppliedTradeTime) ? this.lastAppliedTradeTime : null,
    };
  }

  cancelHistoryLoad(): void {
    this.historyController?.abort();
    this.historyController = null;
  }

  async loadHistory(opts: LoadHistoryOpts): Promise<void> {
    this.cancelRecentFootprintCoverageRepair();
    const requestedFrom = bucketStart(opts.from, this._intervalMs);
    const bootstrapFrom = bucketStart(Date.now(), this._intervalMs);
    const token = this.repair.beginExplicitHistory({ from: requestedFrom, toExclusive: bootstrapFrom });
    const historyReconcile: ExplicitHistoryReconcileState = {
      generation: this.generation,
      requestedFrom,
      requestedTo: bucketStart(opts.to, this._intervalMs),
      bootstrapFrom,
      trades: this.pendingTrades.filter((trade) => {
        const bucket = bucketStart(trade.time, this._intervalMs);
        return bucket >= requestedFrom && bucket < bootstrapFrom;
      }),
      applied: new Set(),
      deferred: new Set(),
      liveAfterBarrier: new Set(),
      watermark: null,
      candleCoverage: null,
      retiredWatermarks: new Map(),
    };
    for (const trade of historyReconcile.trades) {
      if (this._shouldDeferExplicitHistoryTrade(historyReconcile, trade)) historyReconcile.deferred.add(trade);
    }
    if (historyReconcile.deferred.size > 0) {
      this.pendingTrades = this.pendingTrades.filter((trade) => !historyReconcile.deferred.has(trade));
      if (this.pendingTrades.length === 0) this._cancelFlush();
    }
    this.explicitHistoryReconcile = historyReconcile;
    try {
      await this._loadHistory(opts);
    } catch (error) {
      if (!this.disposed && historyReconcile.generation === this.generation) {
        this.activeHistoryErrorDetail = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (this.explicitHistoryReconcile === historyReconcile) this.explicitHistoryReconcile = null;
      if (historyReconcile.deferred.size > 0 && !this.disposed && historyReconcile.generation === this.generation) {
        const deferred = [...historyReconcile.deferred];
        historyReconcile.deferred.clear();
        this._enqueuePendingTrades(deferred);
        if (this.pendingTrades.length > 0) this._scheduleFlush();
      }
      if (this.repair.finishExplicitHistory(token)) this.historyController = null;
    }
  }

  private _shouldDeferExplicitHistoryTrade(state: ExplicitHistoryReconcileState, trade: AggTrade): boolean {
    const bucket = bucketStart(trade.time, this._intervalMs);
    return bucket >= state.requestedFrom
      && bucket <= state.requestedTo
      && bucket < state.bootstrapFrom
      && this.series.get(bucket) === undefined;
  }

  private handleLiveBootstrapMeta(meta: EnvelopeMeta | undefined): void {
    recordFootprintSupport(this._market, meta?.footprint?.allowed);
    const publishedThrough = meta?.footprint?.lastPublishedDay;
    if (typeof publishedThrough === "number" && publishedThrough >= 0) this.lastPublishedDay = publishedThrough;
    this.reportServerPriceStep(meta);
  }

  cancelRecentFootprintCoverageRepair(): void {
    const state = this.recentCoverageRepair;
    if (!state) return;
    state.controller.abort();
    this._releaseRecentCoverageRepair(state);
  }

  async repairRecentFootprintCoverage(from: number, to: number): Promise<RecentFootprintRepairOutcome> {
    if (this.disposed || this.paused || !(to >= from)) return "stop";
    if (
      this.recentCoverageRepair
      || this.repair.isBlockingMaintenance()
      || this.patchDayController !== null
      || this.fillCellsInFlightKey !== null
    ) return "retry";
    if (this.pendingTrades.length > 0) {
      this._scheduleFlush();
      return "retry";
    }
    const controller = new AbortController();
    const generation = this.generation;
    const state: RecentCoverageRepairState = { controller, generation, trades: [], journal: new Set(), applied: new Set(), overflow: false };
    this.recentCoverageRepair = state;
    let latestMeta: EnvelopeMeta | undefined;
    let bars: FootprintBar[];
    try {
      const fetcher = this.services.fetchHistory ?? ((query: HistoryQuery) => chartDataSource().collectHistory(query));
      bars = await fetcher({
        markets: [this._market], from, to, interval: this._intervalMs,
        priceStep: this.series.config.priceStep, reference: this._market,
        signal: controller.signal, consumeBatchRecords: 8,
        onMeta: (meta) => {
          latestMeta = meta;
          const soft = meta?.degraded === true && !recentCoverageHardFailure(meta);
          this.handleMeta(meta, !soft);
        },
      });
    } catch {
      if (this.recentCoverageRepair !== state) return "stop";
      const retry = state.overflow || (!this.disposed && generation === this.generation && !controller.signal.aborted);
      this._releaseRecentCoverageRepair(state);
      return retry ? "retry" : "stop";
    }
    if (this.recentCoverageRepair !== state) return "stop";
    if (state.overflow || this.disposed || generation !== this.generation || controller.signal.aborted) {
      this._releaseRecentCoverageRepair(state);
      return state.overflow ? "retry" : "stop";
    }
    if (recentCoverageHardFailure(latestMeta)) {
      this._releaseRecentCoverageRepair(state);
      return "stop";
    }
    const coverage = latestMeta?.footprintCoverage;
    const usable = coverage !== undefined
      && coverage.schemaVersion === 1
      && coverage.source === RECENT_COVERAGE_SOURCE
      && coverage.instrument === this._market
      && (coverage.authority === "provisional" || coverage.authority === "mixed")
      && (coverage.status === "pending" || coverage.status === "complete" || coverage.status === "verified")
      && coverage.requestedFrom === from
      && coverage.requestedTo === to
      && coverage.reasonCode === null
      && typeof coverage.authorityToken === "string"
      && coverage.authorityToken.trim().length > 0;
    const watermark = decimalTradeId(coverage?.projectionThroughId);
    const safeToExclusive = bucketStart(to, this._intervalMs);
    const safeBars = bars.filter((bar) => bar.startTime >= from && bar.startTime < safeToExclusive);
    const hasRepairCells = safeBars.some((bar) => bar.cells.size > 0);
    if (!usable || watermark === null || safeToExclusive <= from || !hasRepairCells) {
      this._releaseRecentCoverageRepair(state);
      return "retry";
    }
    const coverageCoversClosedRange = safeToExclusive > from
      && typeof coverage?.coveredFrom === "number"
      && typeof coverage?.coveredThrough === "number"
      && coverage.coveredFrom <= from
      && coverage.coveredThrough >= safeToExclusive - 1;
    const authoritativeClosedSnapshot = coverageCoversClosedRange
      && (coverage?.status === "complete" || coverage?.status === "verified");
    // Plan every change before touching the series or the queue: a trade without an exact ID in
    // a snapshot bucket means retry, and a retry must leave both exactly as they were.
    const plannedBars: FootprintBar[] = [];
    for (const bar of safeBars) {
      if (bar.cells.size === 0) continue;
      const existing = this.series.get(bar.startTime);
      if (existing?.cells.size && !authoritativeClosedSnapshot) continue;
      // `upsertBar` ignores repair ownership, so an unproven snapshot must not reach an owned bucket.
      if (!authoritativeClosedSnapshot && this.series.isRepairOwned(bar.startTime)) continue;
      plannedBars.push(bar);
    }
    const snapshotBuckets = new Set(plannedBars.map((bar) => bar.startTime));
    const replay: AggTrade[] = [];
    for (const trade of state.trades) {
      const tradeBucket = bucketStart(trade.time, this._intervalMs);
      if (snapshotBuckets.has(tradeBucket)) {
        if (trade.liquidation === true) {
          // An applied liquidation is already in the volumes carried over from the replaced bar.
          if (!state.applied.has(trade)) replay.push(trade);
          continue;
        }
        const id = decimalTradeId(trade.id);
        if (id === null) {
          this._releaseRecentCoverageRepair(state);
          return "retry";
        }
        if (id > watermark) replay.push(trade);
      } else if (!state.applied.has(trade)) {
        replay.push(trade);
      }
    }
    const appliedCells = plannedBars.length > 0;
    try {
      for (const bar of plannedBars) validateBar(bar, this._intervalMs);
    } catch {
      // Applying a prefix of the snapshot would leave the series half-repaired; try again later.
      incrementPerformanceCounter("pipeline.recent_coverage.invalid_snapshot");
      this._releaseRecentCoverageRepair(state);
      return "retry";
    }
    const previous = snapshotFromSeries(this.series);
    const plannedTrades = state.trades.length;
    const plannedApplied = state.applied.size;
    // A trade delivered (or flushed) from inside the callback is not in this plan, so it voids the plan too.
    if (appliedCells && !this._beforeUpdateKeepsPlan("history-patched", generation, () => this.recentCoverageRepair === state
      && !controller.signal.aborted && !state.overflow && state.trades.length === plannedTrades
      && state.applied.size === plannedApplied)) {
      const stillCurrent = this.recentCoverageRepair === state && !this.disposed && generation === this.generation && !controller.signal.aborted;
      this._releaseRecentCoverageRepair(state);
      return stillCurrent ? "retry" : "stop";
    }
    this._cancelFlush();
    if (state.journal.size > 0) this.pendingTrades = this.pendingTrades.filter((trade) => !state.journal.has(trade));
    for (const bar of plannedBars) {
      const existing = this.series.get(bar.startTime);
      // The recent snapshot carries no liquidations; keep the ones the bar already holds.
      if (existing) carryLiquidations(existing, bar);
      if (authoritativeClosedSnapshot) this.series.replaceRange(bar.startTime, bucketEnd(bar.startTime, this._intervalMs), [bar]);
      else this.series.upsertBar(bar);
    }
    if (replay.length) this.series.addTrades(replay, { dedupe: false });
    for (const trade of state.trades) if (Number.isFinite(trade.time)) this.lastAppliedTradeTime = Math.max(this.lastAppliedTradeTime, trade.time);
    this.recentCoverageRepair = null;
    if (this.pendingTrades.length > 0) this._scheduleFlush();
    if (appliedCells) this.activeHistoryFootprintReceived = true;
    if (appliedCells || replay.length) this._emitUpdate("history-patched", "history", previous);
    const complete = authoritativeClosedSnapshot && !this._hasUnsyncedBars(from, safeToExclusive);
    if (complete) {
      // The repaired window reaches back over everything the history load left uncovered.
      if (from <= this.activeHistoryFootprintUncoveredFrom && this.activeHistoryCoverageSeen
        && this.activeHistoryFootprintAvailable && !this.activeHistoryFootprintDegraded) {
        this.activeHistoryFootprintCoverageComplete = true;
        this.activeHistoryFootprintDetail = "";
      }
      this.integrityReporter?.report("healthy");
      this.onDataDegraded?.(false, "");
    }
    return complete ? "complete" : "retry";
  }

  private async _loadHistory(opts: LoadHistoryOpts): Promise<void> {
    if (this.disposed) return;
    this.historyController?.abort();
    const controller = new AbortController();
    this.historyController = controller;
    const generation = this.generation;
    const bootstrapFrom = this.explicitHistoryReconcile?.generation === generation
      ? this.explicitHistoryReconcile.bootstrapFrom
      : bucketStart(Date.now(), this._intervalMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const rebuild = opts.rebuildKlines ?? false;
    const traceId = createLoadTrace(this._market, this._intervalMs);
    this.activeHistoryTraceId = traceId;
    this.activeHistoryFootprintReceived = false;
    this.activeHistoryFootprintAvailable = true;
    this.activeHistoryFootprintCoverageComplete = false;
    this.activeHistoryCandleSourceGap = null;
    this.activeHistoryCoverageSeen = false;
    this.activeHistoryCoverageAllComplete = true;
    this.activeHistoryFootprintUncoveredFrom = Infinity;
    this.activeHistoryFootprintDegraded = false;
    this.activeHistoryFootprintDetail = "";
    this.activeHistoryErrorDetail = "";
    logLoadTrace(traceId, "pipeline.history.begin", { from: opts.from, to: opts.to, twoPhase: !!opts.twoPhase, rebuild });
    let loadHasDegradedMeta = false;
    let loadDegradedMeta: EnvelopeMeta | undefined;
    const onHistoryMeta = (meta: EnvelopeMeta | undefined, trackCoverage = true): void => {
      // Metadata of a superseded or cancelled load belongs to no one; never let it reach the current one.
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
      const state = this.explicitHistoryReconcile;
      if (state && state.generation === generation) {
        state.watermark = decimalTradeId(meta?.footprintCoverage?.projectionThroughId);
        state.candleCoverage = meta?.candleCoverage ?? null;
      }
      const hasError = (value: EnvelopeMeta | undefined): boolean => value?.provenance?.some((entry) => Boolean(entry.error)) ?? false;
      if (meta?.degraded) {
        if (!loadHasDegradedMeta || (!hasError(loadDegradedMeta) && hasError(meta))) loadDegradedMeta = meta;
        loadHasDegradedMeta = true;
      }
      if (trackCoverage) {
        const coverage = meta?.footprintCoverage;
        const coversRequest = coverage !== undefined
          && (coverage.status === "complete" || coverage.status === "verified")
          && coverage.coveredFrom !== null
          && coverage.coveredThrough !== null
          && coverage.coveredFrom <= coverage.requestedFrom
          && coverage.coveredThrough >= coverage.requestedTo;
        this.activeHistoryCoverageSeen = true;
        this.activeHistoryCoverageAllComplete &&= coversRequest;
        if (!coversRequest) {
          const tailOnly = coverage !== undefined && coverage.coveredFrom !== null && coverage.coveredThrough !== null
            && coverage.coveredFrom <= coverage.requestedFrom;
          const uncoveredFrom = tailOnly ? coverage.coveredThrough! + 1 : coverage?.requestedFrom ?? -Infinity;
          this.activeHistoryFootprintUncoveredFrom = Math.min(this.activeHistoryFootprintUncoveredFrom, uncoveredFrom);
        }
      }
      this.handleMeta(loadHasDegradedMeta ? loadDegradedMeta : meta);
    };
    // Direct-candle markets have no footprint to fetch: Phase 1's candles are the whole load.
    const candlesOnly = chartDataSource().isDirectCandleMarket(this._market);
    this.activeHistoryCandlesOnly = candlesOnly;
    if (opts.twoPhase) {
      let fastPhaseComplete = false;
      let fastPhaseError: unknown;
      try {
        let emittedFast = false;
        const fastWindows = planHistoryWindows({
          markets: [this._market], from: opts.from, to: opts.to, interval: this._intervalMs,
          priceStep: this.series.config.priceStep, reference: this._market, rebuild,
          includeFootprint: false, preferCache: opts.preferCache ?? this._intervalMs < WEEK_MS,
          candleCoverage: "required", onMeta: (meta) => onHistoryMeta(meta, false), signal, traceId,
        });
        for (const fastWindow of fastWindows) {
          this._resetExplicitHistoryWatermark(generation);
          const fastBars = await chartDataSource().fetchHistory(fastWindow);
          if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
          this._seedOpenBucketFromHistory(fastBars, bootstrapFrom);
          const replaceTo = Math.min(fastWindow.to, bootstrapFrom);
          if (replaceTo <= fastWindow.from) continue;
          const replaceableBars = fastBars.filter((bar) => bar.startTime < bootstrapFrom);
          if (!this._applyExplicitHistorySnapshot(
            fastWindow.from,
            replaceTo,
            replaceableBars,
            generation,
            emittedFast ? "history-patched" : "history-loaded",
            true,
            false,
          )) return;
          logLoadTrace(traceId, "pipeline.candles.applied", { bars: replaceableBars.length, seriesBars: this.series.length });
          emittedFast = true;
        }
        fastPhaseComplete = true;
      } catch (error) {
        // Phase 2 remains authoritative.
        fastPhaseError = error;
      }
      if (fastPhaseComplete) {
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        this.onHistoryCandlesReady?.();
      }
      if (candlesOnly) {
        if (controller.signal.aborted || this.disposed) return;
        if (!fastPhaseComplete) throw fastPhaseError;
        this.activeHistoryFootprintDegraded = loadHasDegradedMeta && this.activeHistoryCandleSourceGap === null;
        logLoadTrace(traceId, "pipeline.history.complete", { seriesBars: this.series.length });
        return;
      }
    }
    if (opts.twoPhase) {
      const phase2Base: HistoryQuery = {
        markets: [this._market], from: opts.from, to: opts.to, interval: this._intervalMs,
        priceStep: this.series.config.priceStep, reference: this._market,
        rebuild: false, preferCache: opts.preferCache ?? true, candleCoverage: "required", signal, traceId, consumeBatchRecords: 8,
      };
      const chunkWindows = planTwoPhaseCellWindows(phase2Base);
      let chunkIndex = 0;
      while (chunkWindows.length) {
        const chunk = chunkWindows.shift()!;
        let chunkEmitted = false;
        const receivedBars: FootprintBar[] = [];
        const receivedBarCellCounts: number[] = [];
        let receivedCells = 0;
        let windowMeta: EnvelopeMeta | undefined;
        try {
          this._resetExplicitHistoryWatermark(generation);
          await chartDataSource().streamHistory({ ...chunk, onMeta: (meta) => { windowMeta = meta; } }, async ({ bars, cellCount, barCellCounts }: HistoryBatch) => {
            if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
            receivedBars.push(...bars);
            receivedBarCellCounts.push(...(barCellCounts ?? bars.map((bar) => bar.cells.size)));
            receivedCells += cellCount ?? bars.reduce((sum, bar) => sum + bar.cells.size, 0);
          });
        } catch (error) {
          if (controller.signal.aborted || this.disposed) return;
          throw error;
        }
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        const budgetError = historyCellBudgetError(windowMeta);
        if (budgetError) {
          const split = splitHistoryCellBudgetWindow(chunk);
          if (!split) { onHistoryMeta(windowMeta); if (this.disposed || generation !== this.generation || controller.signal.aborted) return; throw new Error(budgetError); }
          if (split.older) chunkWindows.unshift(split.older);
          chunkWindows.unshift(split.newest);
          continue;
        }
        if (receivedCells > HISTORY_MAX_WINDOW_CELLS || receivedBars.length > HISTORY_MAX_WINDOW_BARS) {
          const split = splitOversizedHistoryWindow(chunk, receivedBars, receivedBarCellCounts, receivedCells);
          if (split.older) chunkWindows.unshift(split.older);
          chunkWindows.unshift(split.newest);
          continue;
        }
        onHistoryMeta(windowMeta);
        // The meta callback may re-enter (server step correction -> setPriceStep)
        // and restart this load; a superseded stack must not mutate the new epoch.
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        if (receivedBars.length) {
          const replaceableBars = receivedBars.filter((bar) => bar.startTime < bootstrapFrom);
          if (replaceableBars.length) {
            const batchFrom = replaceableBars[0].startTime;
            const batchTo = bucketEnd(replaceableBars[replaceableBars.length - 1]!.startTime, this._intervalMs);
            if (receivedCells > 0) this.activeHistoryFootprintReceived = true;
            if (!this._applyExplicitHistorySnapshot(batchFrom, batchTo, replaceableBars, generation, "history-patched", false, true)) return;
            logLoadTrace(traceId, "pipeline.footprint.applied", {
              bars: replaceableBars.length, cells: receivedCells, newestChunk: chunkIndex === 0, seriesBars: this.series.length,
            });
          }
          chunkEmitted = true;
        }
        if (!chunkEmitted) {
          const wipeTo = Math.min(chunk.to, bootstrapFrom);
          if (wipeTo > chunk.from) {
            if (!this._applyExplicitHistorySnapshot(chunk.from, wipeTo, [], generation, "history-patched", false, true)) return;
          }
        }
        chunkIndex++;
      }
      this.activeHistoryFootprintCoverageComplete = this.activeHistoryCoverageSeen
        && this.activeHistoryCoverageAllComplete && this.activeHistoryFootprintAvailable && !loadHasDegradedMeta;
      this.activeHistoryFootprintDegraded = loadHasDegradedMeta && this.activeHistoryCandleSourceGap === null;
      logLoadTrace(traceId, "pipeline.history.complete", { seriesBars: this.series.length });
      return;
    }
    let emitted = false;
    const queue = planHistoryWindows({
      markets: [this._market], from: opts.from, to: opts.to, interval: this._intervalMs,
      priceStep: this.series.config.priceStep, reference: this._market,
      rebuild, preferCache: opts.preferCache, candleCoverage: "required", signal, onMeta: onHistoryMeta, traceId, consumeBatchRecords: 8,
    });
    try {
      while (queue.length) {
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        const window = queue.shift()!;
        const receivedBars: FootprintBar[] = [];
        const receivedBarCellCounts: number[] = [];
        let receivedCells = 0;
        let windowMeta: EnvelopeMeta | undefined;
        this._resetExplicitHistoryWatermark(generation);
        await chartDataSource().streamHistory({ ...window, onMeta: (meta) => { windowMeta = meta; } }, async ({ bars, cellCount, barCellCounts }: HistoryBatch) => {
          if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
          receivedBars.push(...bars);
          receivedBarCellCounts.push(...(barCellCounts ?? bars.map((bar) => bar.cells.size)));
          receivedCells += cellCount ?? bars.reduce((sum, bar) => sum + bar.cells.size, 0);
        });
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        const budgetError = historyCellBudgetError(windowMeta);
        if (budgetError) {
          const split = splitHistoryCellBudgetWindow(window);
          if (!split) { onHistoryMeta(windowMeta); if (this.disposed || generation !== this.generation || controller.signal.aborted) return; throw new Error(budgetError); }
          if (split.older) queue.unshift(split.older);
          queue.unshift(split.newest);
          continue;
        }
        if (receivedCells > HISTORY_MAX_WINDOW_CELLS || receivedBars.length > HISTORY_MAX_WINDOW_BARS) {
          const split = splitOversizedHistoryWindow(window, receivedBars, receivedBarCellCounts, receivedCells);
          if (split.older) queue.unshift(split.older);
          queue.unshift(split.newest);
          continue;
        }
        onHistoryMeta(windowMeta);
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        this._seedOpenBucketFromHistory(receivedBars, bootstrapFrom);
        if (!receivedBars.length) continue;
        const replaceableBars = receivedBars.filter((bar) => bar.startTime < bootstrapFrom);
        if (!replaceableBars.length) continue;
        const batchFrom = replaceableBars[0].startTime;
        const batchTo = bucketEnd(replaceableBars[replaceableBars.length - 1]!.startTime, this._intervalMs);
        if (!this._applyExplicitHistorySnapshot(
          batchFrom,
          batchTo,
          replaceableBars,
          generation,
          emitted ? "history-patched" : "history-loaded",
          false,
          emitted,
        )) return;
        if (receivedCells > 0) this.activeHistoryFootprintReceived = true;
        logLoadTrace(traceId, "pipeline.footprint.applied", { bars: replaceableBars.length, cells: receivedCells, seriesBars: this.series.length });
        emitted = true;
      }
    } catch (error) {
      if (controller.signal.aborted || this.disposed) return;
      throw error;
    }
    if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
    if (!emitted) {
      const wipeTo = Math.min(opts.to, bootstrapFrom);
      if (wipeTo > opts.from) {
        if (!this._applyExplicitHistorySnapshot(opts.from, wipeTo, [], generation, "history-loaded", false, false)) return;
      }
    }
    this.activeHistoryFootprintCoverageComplete = this.activeHistoryCoverageSeen
      && this.activeHistoryCoverageAllComplete && this.activeHistoryFootprintAvailable && !loadHasDegradedMeta;
    this.activeHistoryFootprintDegraded = loadHasDegradedMeta && this.activeHistoryCandleSourceGap === null;
    logLoadTrace(traceId, "pipeline.history.complete", { seriesBars: this.series.length });
  }

  /**
   * History requests run to `Date.now()`, so their response already contains the bucket
   * that is still open — and every snapshot application then drops it, because the live
   * trade path owns that bucket. The dedicated `rebuild=1` seed re-fetches it, which
   * leaves the newest candle missing from the first paint whenever that second request
   * is the slower of the two. Reuse what the bootstrap response already paid for, but
   * only to fill a hole: an existing bucket keeps its live OHLC.
   *
   * Candle fields only. Everything the open bucket's repair barrier fences live trades
   * out of belongs to a proven trade-id repair snapshot, and `upsertBar` writes straight
   * past that barrier — so any of it carried here would be unverified data on screen.
   * The single-phase path asks for footprint and its bars do carry it, so it is stripped
   * here rather than assumed from the caller's query.
   */
  private _seedOpenBucketFromHistory(bars: readonly FootprintBar[], bootstrapFrom: number): void {
    const openBars = bars.filter((bar) => bar.startTime >= bootstrapFrom).map(candleOnlyBar);
    if (openBars.length === 0) return;
    const applied = this.applyLiveBarSeed(openBars, {
      market: this._market,
      intervalMs: this._intervalMs,
      from: bootstrapFrom,
      observedAt: Date.now(),
      fillMissingOnly: true,
    });
    if (applied.length > 0) {
      logLoadTrace(this.activeHistoryTraceId, "pipeline.open_bucket.seeded", { buckets: applied.length, source: "history" });
    }
  }

  async refreshLiveBarOHLC(): Promise<void> {
    if (this.disposed || this.repair.isBlockingCandleMaintenance()) return;
    if (this.liveOhlcPromise) return this.liveOhlcPromise;
    const controller = new AbortController();
    this.liveOhlcController = controller;
    const generation = this.generation;
    const run = async (): Promise<void> => {
      const to = Date.now();
      const from = to - this._intervalMs * 2;
      try {
        const bars = await chartDataSource().fetchSharedLiveOhlc({
          markets: [this._market], from, to, interval: this._intervalMs,
          priceStep: this.series.config.priceStep, reference: this._market,
          rebuild: true, includeFootprint: false, purpose: "maintenance",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(LIVE_OHLC_REQUEST_TIMEOUT_MS)]),
        });
        if (this.disposed || controller.signal.aborted || generation !== this.generation) return;
        const previous = snapshotFromSeries(this.series);
        const liveStart = bucketStart(Date.now(), this._intervalMs);
        for (const bar of bars) {
          if (bar.startTime === liveStart && this.series.get(bar.startTime) === undefined) {
            this.series.upsertBar(bar);
            continue;
          }
          this.series.reassertOHLC(bar.startTime, bar.open, bar.high, bar.low);
        }
        this._emitUpdate("history-patched", "history", previous);
      } catch {
        // Best effort.
      }
    };
    const promise = run().finally(() => {
      if (this.liveOhlcController === controller) this.liveOhlcController = null;
      if (this.liveOhlcPromise === promise) this.liveOhlcPromise = null;
    });
    this.liveOhlcPromise = promise;
    return promise;
  }

  cancelLiveBarOHLCRefresh(): void { this.liveOhlcController?.abort(); }

  applyLiveBarSeed(
    bars: readonly FootprintBar[],
    opts: {
      market: string;
      intervalMs: number;
      from: number;
      observedAt: number;
      /**
       * Only create buckets the series does not have yet; never reassert OHLC on one it
       * already holds. Used by the bootstrap history response, whose open bucket is a
       * by-product rather than the authoritative `rebuild=1` seed, so it may fill a hole
       * but must not overwrite live data.
       */
      fillMissingOnly?: boolean;
    },
  ): number[] {
    if (this.disposed || opts.market !== this._market || opts.intervalMs !== this._intervalMs) return [];
    const liveStart = bucketStart(Date.now(), this._intervalMs);
    const applicable = bars.filter((bar) => bar.startTime >= opts.from
      && bar.startTime <= liveStart
      && bucketStart(bar.startTime, this._intervalMs) === bar.startTime
      && !(opts.fillMissingOnly && this.series.get(bar.startTime) !== undefined));
    if (applicable.length === 0) return [];

    const previous = snapshotFromSeries(this.series);
    if (!this._beforeUpdateKeepsPlan("history-patched", this.generation)) return [];
    const applied: number[] = [];
    // Price-only diff basis: the accepted OHLC each applied bucket held before the seed,
    // not the incoming values (a stale close or a fenced bucket may apply nothing).
    const ohlcBefore = new Map<number, [number, number, number, number]>();
    for (const bar of applicable) {
      const existing = this.series.get(bar.startTime);
      if (existing && !ohlcBefore.has(bar.startTime)) {
        ohlcBefore.set(bar.startTime, [existing.open, existing.high, existing.low, existing.close]);
      }
      if (!existing) {
        // A bucket a proven repair snapshot owns or fences takes no unproven candle.
        if (!this.series.upsertBar(bar)) continue;
      } else {
        this.series.reassertOHLC(bar.startTime, bar.open, bar.high, bar.low, {
          close: bar.close,
          preferIncomingClose: opts.observedAt >= (existing.updatedAt ?? 0),
          observedAt: opts.observedAt,
        });
      }
      applied.push(bar.startTime);
    }
    let priceChanged = false;
    for (const startTime of applied) {
      const before = ohlcBefore.get(startTime);
      const after = this.series.get(startTime);
      if (before === undefined || after === undefined
        || after.open !== before[0] || after.high !== before[1]
        || after.low !== before[2] || after.close !== before[3]) {
        priceChanged = true;
        break;
      }
    }
    this._emitUpdate("history-patched", "history", previous, { priceChanged });
    return applied;
  }

  /**
   * Resolves and applies the price step/precision of `market`. Guarded by the market rather than
   * the generation: a timeframe change during the lookup must not discard the new market's step.
   */
  private async resolveMarketMetadata(market: string): Promise<void> {
    const fallbackStep = this.series.config.priceStep;
    this.series.resetPricePrecision();
    this.series.setReferenceMarket(market);
    const stepResultPromise = this.services.fetchPriceStepResult
      ? this.services.fetchPriceStepResult(market)
      : this.services.fetchPriceStep(market).then((step) => ({ step, resolved: true }));
    const pricePrecisionPromise = this.services.fetchPricePrecision(market);
    const [stepResult, pricePrecision] = await Promise.all([
      raceWithFallback(stepResultPromise, { step: fallbackStep, resolved: false }, this.stepResolveTimeoutMs),
      raceWithFallback(pricePrecisionPromise, undefined, 1500),
    ]);
    if (this.disposed || this._market !== market) return;
    const priceStep = stepResult.step;
    this.series.setPriceStep(priceStep);
    if (pricePrecision !== undefined) {
      this.series.setPricePrecision(pricePrecision);
      this._emitUpdate("metadata-updated", "metadata");
    }
    this.pendingStepCorrection = stepResult.resolved
      ? Promise.resolve(null)
      : stepResultPromise.then(async (first) => {
          // An unresolved lookup (e.g. made while the Gateway was briefly not online) is
          // asked again in the background; nothing else retries a selection's step.
          let real = first;
          for (const delay of this.stepRetryDelaysMs) {
            if (real.resolved || !this.services.fetchPriceStepResult) break;
            if (!(await abortableDelay(delay, this.disposal.signal))) return null;
            if (this.disposed || this._market !== market) return null;
            real = await this.services.fetchPriceStepResult(market).catch(() => real);
          }
          if (this.disposed || this._market !== market) return null;
          if (!real.resolved || !Number.isFinite(real.step) || real.step <= 0) return null;
          // Compare against the step the series runs now, not the fallback captured above:
          // a managed adoption since then already owns an equal served grid.
          if (Math.abs(real.step - this.series.config.priceStep) <= real.step * 1e-9) return null;
          // A different step must not raw-clear the series here (that drops every bar,
          // dedup floor and repair fence outside the managed contract); report it so the
          // host adopts it through its managed setPriceStep (reset + covered reload).
          // Without a runtime subscriber nobody re-enters that contract, so a standalone
          // pipeline adopts the resolved selection step itself through the same managed
          // setter; reportServerStepValue stays a pure notifier for the hosted path.
          // Awaiting the returned owned adoption keeps this correction pending until
          // the covered replacement load commits, so consumers restore against the
          // real replacement bars instead of an empty mid-reset grid.
          if (this.onServerPriceStep) await this.reportServerStepValue(real.step);
          else this.setPriceStep(real.step);
          return real.step;
        }).catch(() => null);
  }

  async changeConfig(opts: { market?: string; intervalMs?: number }): Promise<void> {
    if (this.disposed) return;
    const marketChanged = opts.market !== undefined && opts.market !== this._market;
    const tfChanged = opts.intervalMs !== undefined && opts.intervalMs !== this._intervalMs;
    if (marketChanged || tfChanged) this.repair.cancel();
    if (marketChanged) this.latestMarketReadiness = null;
    if (marketChanged) this._market = opts.market!;
    if (tfChanged) this._intervalMs = opts.intervalMs!;
    if (marketChanged || tfChanged) {
      this.cancelRecentFootprintCoverageRepair();
      this.generation++;
      this.historyController?.abort();
      this.historyController = null;
      this.explicitHistoryReconcile = null;
      this.liveOhlcController?.abort();
      this.patchDayController?.abort();
      this.patchDayController = null;
      this.resetPatchDayQueue();
    }
    if (marketChanged) {
      const generation = this.generation;
      const metadata = this.resolveMarketMetadata(this._market);
      this.pendingMarketMetadata = metadata;
      const settle = () => {
        if (this.pendingMarketMetadata === metadata) this.pendingMarketMetadata = null;
      };
      metadata.then(settle, settle);
      await metadata;
      if (this.disposed || generation !== this.generation) {
        this._ensureDesiredSubscription();
        return;
      }
    } else if (tfChanged && this.pendingMarketMetadata) {
      // Market -> timeframe race: the timeframe change supersedes the market switch's generation,
      // so it must wait for that market's step itself instead of loading history on the old one.
      const generation = this.generation;
      // The market switch's own call reports a failed lookup; here it only has to settle.
      await this.pendingMarketMetadata.catch(() => undefined);
      if (this.disposed || generation !== this.generation) {
        this._ensureDesiredSubscription();
        return;
      }
    }
    if (tfChanged || marketChanged) {
      this._cancelFlush();
      this.pendingTrades = [];
      this.pendingTradeOverloaded = false;
      this.pendingTradeDataLoss = false;
      this.lastBarStart = -1;
      this.lastAppliedTradeTime = -Infinity;
      this.identityConflict = null;
      this.activeHistoryFootprintDetail = "";
      this.activeHistoryErrorDetail = "";
      this.integrityReporter?.report("healthy");
      this.onDataDegraded?.(false, "");
      this.resetCellFillState();
    }
    if (tfChanged) this.series.setInterval(this._intervalMs);
    else if (marketChanged) this.series.clear();
    this._ensureDesiredSubscription();
    if (tfChanged && !marketChanged && this.latestMarketReadiness?.market === this._market) {
      // The acknowledged boundary can be hours old. Repairing from it would let the live tail stretch
      // the replaced range over the history just loaded for the new timeframe, so start from now.
      const readiness = this.latestMarketReadiness;
      this.repair.onMarketReady({ ...readiness, boundaryAt: Math.max(readiness.boundaryAt, Date.now()) });
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this._cancelFlush();
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.subscribedMarket = null;
      return;
    }
    this._ensureDesiredSubscription();
    if (this.pendingTrades.length > 0) this._scheduleFlush();
  }

  async patchDay(dayTs: number): Promise<void> {
    if (this.disposed) return;
    const iv = this._intervalMs;
    const dayStart = bucketStart(dayTs, DAY_MS);
    const from = iv < DAY_MS ? dayStart : bucketStart(dayTs, iv);
    const toExclusive = iv < DAY_MS ? dayStart + DAY_MS : bucketEnd(from, iv);
    if (this.patchDayQueued.has(from)) return this.patchDayChain;
    this.patchDayQueued.add(from);
    const generation = this.generation;
    const run = this.patchDayChain
      .then(() => this._patchDayNow(from, toExclusive, generation))
      .finally(() => { this.patchDayQueued.delete(from); });
    // The caller sees this day's failure; the queue does not, or every later patch would be skipped.
    this.patchDayChain = run.catch(() => undefined);
    return run;
  }

  private async _patchDayNow(from: number, toExclusive: number, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const iv = this._intervalMs;
    const controller = new AbortController();
    this.patchDayController = controller;
    let bars: FootprintBar[];
    let degraded = false;
    let coverage: CandleCoverage | null = null;
    try {
      bars = await chartDataSource().collectHistory({
        markets: [this._market], from, to: Math.max(from, toExclusive - 1), interval: iv,
        priceStep: this.series.config.priceStep, reference: this._market,
        rebuild: iv >= DAY_MS, signal: controller.signal,
        onMeta: (meta) => {
          if (meta?.degraded || meta?.candleCoverage?.status === "error") degraded = true;
          if (meta?.candleCoverage) coverage = meta.candleCoverage;
          this.handleMeta(meta);
        },
      });
    } catch {
      if (this.patchDayController === controller) this.patchDayController = null;
      return;
    }
    if (this.patchDayController !== controller) return;
    this.patchDayController = null;
    if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
    const ordered = this.series.listReadonly();
    const firstInDay = lowerBoundByStartTime(ordered, from);
    const lastInDay = lowerBoundByStartTime(ordered, toExclusive);
    const previousBars = firstInDay < lastInDay ? ordered.slice(firstInDay, lastInDay) : [];
    // A degraded response (kline source or footprint store failed) says nothing
    // about the day already on the chart; replacing with it would wipe the day.
    // Keep it: its cells are still missing, so fillMissingCells tries again later.
    // A non-degraded empty response is not a blanket wipe either: only buckets a
    // verified closed candle snapshot verifiably owns may be deleted, which the
    // per-bucket ownership merge below already decides; everything else is kept.
    if (degraded) return;
    // A bucket the response actually returned replaces its bar; one the response
    // left out is only "no candle" when its candle snapshot verifiably owns that
    // bucket (candleSnapshotOwnsBucket). An unowned omission says nothing about the
    // bar already on the chart, so that bar keeps its values and identity instead of
    // being wiped by a sparse (e.g. footprint-pending) day.
    const providedStarts = new Set<number>();
    for (const bar of bars) {
      providedStarts.add(bar.startTime);
    }
    // A built day already contains every trade of its closed buckets; one still queued for them
    // would be counted twice once the day is replaced.
    const closedTo = Math.min(toExclusive, bucketStart(Date.now(), iv));
    // An empty, non-degraded response with existing bars stays the original
    // no-op unless it verifiably deletes a snapshot-owned existing bucket or
    // still holds a queued closed trade for a snapshot-owned bucket; only then
    // may the day be rebuilt. Otherwise return without snapshot, callbacks,
    // replacement or emission so bar identity and listeners stay untouched.
    if (bars.length === 0 && previousBars.length > 0
      && !previousBars.some((bar) => candleSnapshotOwnsBucket(coverage, this._market, bar.startTime, iv))
      && !(closedTo > from && this.pendingTrades.some((trade) => {
        const bucket = bucketStart(trade.time, iv);
        return bucket >= from && bucket < closedTo
          && candleSnapshotOwnsBucket(coverage, this._market, bucket, iv);
      }))) {
      return;
    }
    const previous = snapshotFromSeries(this.series);
    if (!this._beforeUpdateKeepsPlan("history-patched", generation)) return;
    // The public onBeforeUpdate callback above may have applied live trades to
    // the series. Rebuild the per-bucket merge from the CURRENT bars so an
    // unowned bar the callback just created (or kept) survives replaceRange
    // with its stored reference and fields; bars the callback removed are not
    // resurrected from any pre-callback map.
    const orderedNow = this.series.listReadonly();
    const firstInDayNow = lowerBoundByStartTime(orderedNow, from);
    const lastInDayNow = lowerBoundByStartTime(orderedNow, toExclusive);
    const currentBars = firstInDayNow < lastInDayNow ? orderedNow.slice(firstInDayNow, lastInDayNow) : [];
    const replacementByStart = new Map<number, FootprintBar>();
    for (const bar of bars) {
      replacementByStart.set(bar.startTime, bar);
    }
    for (const existing of currentBars) {
      if (replacementByStart.has(existing.startTime)) continue;
      if (candleSnapshotOwnsBucket(coverage, this._market, existing.startTime, iv)) continue;
      replacementByStart.set(existing.startTime, existing);
    }
    const merged = [...replacementByStart.values()].sort((a, b) => a.startTime - b.startTime);
    const priceChanged = !samePriceStructure(currentBars, merged);
    if (closedTo > from && this.pendingTrades.length > 0) {
      this.pendingTrades = this.pendingTrades.filter((trade) => {
        const bucket = bucketStart(trade.time, iv);
        // Only a bucket this response rebuilt (a returned bar) or verifiably owns
        // (verified snapshot, omitted because empty) may drop still-queued closed
        // trades; one queued for an unowned omitted bucket stays pending against
        // the bar that was kept.
        if (bucket >= from && bucket < closedTo && !providedStarts.has(bucket)
          && !candleSnapshotOwnsBucket(coverage, this._market, bucket, iv)) return true;
        return bucket < from || bucket >= closedTo;
      });
    }
    this.series.replaceRange(from, toExclusive, merged);
    this._emitUpdate("history-patched", "history", previous, { priceChanged });
  }

  fillMissingCells(from: number, to: number): void {
    if (this.disposed || !(to > from)) return;
    if (this.fillCellsInFlightKey !== null) {
      this.fillCellsPending = { from, to };
      return;
    }
    const dayFrom = bucketStart(from, DAY_MS);
    const todayStart = bucketStart(Date.now(), DAY_MS);
    const publishedThrough = this.lastPublishedDay ?? todayStart - DAY_MS;
    const dayToExclusive = Math.min(bucketEnd(Math.max(from, to - 1), DAY_MS), publishedThrough + DAY_MS);
    if (dayToExclusive <= dayFrom) return;
    let effectiveFrom = dayFrom;
    if (this._intervalMs < HOUR_MS) {
      const m1RetentionStart = todayStart - M1_BASE_RETENTION_DAYS * DAY_MS;
      effectiveFrom = Math.max(effectiveFrom, m1RetentionStart);
      if (dayToExclusive <= effectiveFrom) return;
    }
    if (!footprintEnabledAt(effectiveFrom) || !isFootprintSyncAllowed(this._market)) return;
    let reqFrom = effectiveFrom;
    while (reqFrom < dayToExclusive && (!this._fillRetryDue(reqFrom) || !this._hasUnsyncedBars(reqFrom, reqFrom + DAY_MS))) reqFrom += DAY_MS;
    if (reqFrom >= dayToExclusive) return;
    const reqTo = Math.min(reqFrom + DAY_MS, dayToExclusive);
    const key = `${reqFrom}-${reqTo}`;
    if (this.fillCellsInFlightKey === key) return;
    this.fillCellsAttempted.set(reqFrom, Date.now());
    this.fillCellsInFlightKey = key;
    const controller = new AbortController();
    this.fillCellsController = controller;
    const generation = this.generation;
    void (async () => {
      await chartDataSource().startRefresh([this._market], this._intervalMs, this.series.config.priceStep, this._market, reqFrom, reqTo, controller.signal);
      await this._awaitRefreshIdle(controller.signal);
      for (let day = reqFrom; day < reqTo; day += DAY_MS) {
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        await this.patchDay(day);
      }
    })().catch(() => undefined).finally(() => {
      if (this.fillCellsInFlightKey === key) this.fillCellsInFlightKey = null;
      if (this.fillCellsController === controller) this.fillCellsController = null;
      const pending = this.fillCellsPending ?? { from, to };
      this.fillCellsPending = null;
      if (!this.disposed && !controller.signal.aborted) this.fillMissingCells(pending.from, pending.to);
    });
  }

  private _fillRetryDue(dayStart: number): boolean {
    const attemptedAt = this.fillCellsAttempted.get(dayStart);
    return attemptedAt === undefined || Date.now() - attemptedAt >= FILL_RETRY_COOLDOWN_MS;
  }

  private async _awaitRefreshIdle(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + FILL_REFRESH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.disposed || signal.aborted) return;
      const status = await chartDataSource().fetchRefreshStatus(signal);
      if (status.state !== "running") return;
      if (!(await abortableDelay(FILL_REFRESH_POLL_MS, signal))) return;
    }
  }

  private _hasUnsyncedBars(from: number, to: number): boolean {
    for (let i = this.series.length - 1; i >= 0; i--) {
      const bar = this.series.at(i);
      if (!bar) continue;
      if (bar.startTime < from) break;
      if (bar.startTime >= to) continue;
      if (bar.cells.size === 0 && (bar.volume > 0 || bar.count > 0)) return true;
    }
    return false;
  }

  setPriceStep(step: number): void {
    if (this.disposed || step <= 0) return;
    this.cancelRecentFootprintCoverageRepair();
    this.repair.cancel();
    this.generation++;
    this.historyController?.abort();
    this.explicitHistoryReconcile = null;
    this.patchDayController?.abort();
    this.patchDayController = null;
    this.resetPatchDayQueue();
    this._cancelFlush();
    this.pendingTrades = [];
    this.pendingTradeOverloaded = false;
    this.pendingTradeDataLoss = false;
    this.lastBarStart = -1;
    this.lastAppliedTradeTime = -Infinity;
    this.identityConflict = null;
    this.activeHistoryFootprintDetail = "";
    this.activeHistoryErrorDetail = "";
    this.integrityReporter?.report("healthy");
    this.onDataDegraded?.(false, "");
    this.resetCellFillState();
    const previous = snapshotFromSeries(this.series);
    this.series.setPriceStep(step);
    this._emitUpdate("price-step-reset", "config", previous);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposal.abort();
    this.cancelRecentFootprintCoverageRepair();
    this.repair.dispose();
    this.generation++;
    this.historyController?.abort();
    this.historyController = null;
    this.explicitHistoryReconcile = null;
    this.liveOhlcController?.abort();
    this.patchDayController?.abort();
    this.patchDayController = null;
    this.resetPatchDayQueue();
    this.fillCellsController?.abort();
    this.fillCellsController = null;
    this._cancelFlush();
    this.pendingTrades = [];
    this.pendingTradeOverloaded = false;
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
    this.readinessUnsubscribe?.();
    this.readinessUnsubscribe = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribedMarket = null;
    this.integrityReporter?.dispose();
    this.onUpdate = null;
    this.onBeforeUpdate = null;
    this.onHistoryCandlesReady = null;
    this.onBarClose = null;
  }

  private resetPatchDayQueue(): void {
    this.patchDayQueued.clear();
    this.patchDayChain = Promise.resolve();
  }

  private resetCellFillState(): void {
    this.fillCellsController?.abort();
    this.fillCellsController = null;
    this.fillCellsInFlightKey = null;
    this.fillCellsPending = null;
    this.fillCellsAttempted.clear();
  }

  private _resetExplicitHistoryWatermark(generation: number): void {
    const state = this.explicitHistoryReconcile;
    if (state && state.generation === generation) {
      state.watermark = null;
      state.candleCoverage = null;
    }
  }

  private _applyExplicitHistorySnapshot(
    from: number,
    to: number,
    bars: readonly FootprintBar[],
    generation: number,
    kind: "history-loaded" | "history-patched",
    preserveCells: boolean,
    notifyBefore: boolean,
  ): boolean {
    const state = this.explicitHistoryReconcile;
    if (!state || state.generation !== generation || generation !== this.generation || this.disposed || !(to > from)) return false;
    // The public callback runs before anything is planned, so trades it causes to arrive are part of the plan.
    if (notifyBefore && !this._beforeUpdateKeepsPlan(kind, generation, () => this.explicitHistoryReconcile === state)) return false;
    const watermark = state.watermark;
    for (const [bucket, retired] of state.retiredWatermarks) {
      if (bucket < from || bucket >= to) continue;
      if (watermark === null || watermark < retired) {
        incrementPerformanceCounter("pipeline.history.snapshot_rejected");
        this.integrityReporter?.report("pending", "HISTORY_SNAPSHOT_WATERMARK_REGRESSION");
        this.historyController?.abort();
        return false;
      }
    }

    const candidates = state.trades.filter((trade) => {
      const bucket = bucketStart(trade.time, this._intervalMs);
      return bucket >= from && bucket < to;
    });
    const incomingStarts = new Set(bars.map((bar) => bar.startTime));
    const blockedBuckets = new Set<number>();
    for (const trade of candidates) {
      const bucket = bucketStart(trade.time, this._intervalMs);
      if (!incomingStarts.has(bucket) || !candleSnapshotOwnsBucket(state.candleCoverage, this._market, bucket, this._intervalMs)) {
        blockedBuckets.add(bucket);
      }
    }
    if (blockedBuckets.size > 0) {
      incrementPerformanceCounter("pipeline.history.candle_coverage_unknown", blockedBuckets.size);
      this.integrityReporter?.report("pending", "CANDLE_COVERAGE_UNKNOWN");
      this.onDataDegraded?.(true, "CANDLE_COVERAGE_UNKNOWN: overlapping live candle kept until source ownership is verified");
      // Both reach code outside the pipeline, which may reset it or start another load.
      if (this.explicitHistoryReconcile !== state || generation !== this.generation || this.disposed) return false;
    }

    const reconciledCandidates = candidates.filter((trade) => !blockedBuckets.has(bucketStart(trade.time, this._intervalMs)));
    const candidateSet = new Set(reconciledCandidates);
    const replacementByStart = new Map<number, FootprintBar>();
    for (const bar of bars) {
      if (!blockedBuckets.has(bar.startTime)) replacementByStart.set(bar.startTime, bar);
    }
    for (const bucket of blockedBuckets) {
      const existing = this.series.get(bucket);
      if (existing) replacementByStart.set(bucket, existing);
    }
    // A bucket the response left out is only "no candle" when the candle snapshot verifiably owns
    // it. A degraded response (kline source failed, HTTP 200 with fewer or no bars) says nothing
    // about the bars already on the chart, so they stay instead of being wiped.
    const ordered = this.series.listReadonly();
    let keptUnverified = 0;
    for (let index = lowerBoundByStartTime(ordered, from); index < ordered.length; index++) {
      const existing = ordered[index]!;
      if (existing.startTime >= to) break;
      if (replacementByStart.has(existing.startTime)) continue;
      if (candleSnapshotOwnsBucket(state.candleCoverage, this._market, existing.startTime, this._intervalMs)) continue;
      replacementByStart.set(existing.startTime, existing);
      keptUnverified++;
    }
    if (keptUnverified > 0) incrementPerformanceCounter("pipeline.history.unverified_candles_kept", keptUnverified);
    if (state.candleCoverage?.status === "error") {
      const gap = this.activeHistoryCandleSourceGap;
      this.activeHistoryCandleSourceGap = gap
        ? { from: Math.min(gap.from, from), to: Math.max(gap.to, to) }
        : { from, to };
    }
    const replacementBars = [...replacementByStart.values()].sort((a, b) => a.startTime - b.startTime);
    const preservedCellBuckets = new Set<number>();
    if (preserveCells) {
      for (const bar of replacementBars) {
        if (blockedBuckets.has(bar.startTime) || bar.startTime < from || bar.startTime >= to || bar.cells.size > 0) continue;
        if ((this.series.get(bar.startTime)?.cells.size ?? 0) > 0) preservedCellBuckets.add(bar.startTime);
      }
    }

    const previous = snapshotFromSeries(this.series);
    // replaceRange validates every bar before it mutates anything; dequeue the reconciled live
    // trades only once it has succeeded, so an invalid snapshot leaves them to the normal flush.
    this.series.replaceRange(from, to, replacementBars, preserveCells ? { preserveCells: true } : undefined);
    this._cancelFlush();
    if (candidateSet.size > 0) this.pendingTrades = this.pendingTrades.filter((trade) => !candidateSet.has(trade));

    for (const trade of reconciledCandidates) state.deferred.delete(trade);
    const replayFootprint: AggTrade[] = [];
    const retained = new Set<AggTrade>();
    for (const trade of reconciledCandidates) {
      const bucket = bucketStart(trade.time, this._intervalMs);
      const cellsPreservedForAppliedTrade = preservedCellBuckets.has(bucket) && state.applied.has(trade);
      if (cellsPreservedForAppliedTrade) {
        retained.add(trade);
        continue;
      }
      if (trade.liquidation === true) {
        replayFootprint.push(trade);
        retained.add(trade);
        continue;
      }
      const id = decimalTradeId(trade.id);
      const footprintSnapshotCoversTrade = watermark !== null && id !== null && id <= watermark;
      if (footprintSnapshotCoversTrade) {
        const retired = state.retiredWatermarks.get(bucket);
        if (retired === undefined || id > retired) state.retiredWatermarks.set(bucket, id);
        continue;
      }
      replayFootprint.push(trade);
      retained.add(trade);
    }
    if (replayFootprint.length) {
      this.series.addFootprintTrades(replayFootprint);
      for (const trade of replayFootprint) state.applied.add(trade);
    }
    if (reconciledCandidates.length) {
      state.trades = state.trades.filter((trade) => !candidateSet.has(trade) || retained.has(trade));
      for (const trade of reconciledCandidates) {
        if (Number.isFinite(trade.time)) this.lastAppliedTradeTime = Math.max(this.lastAppliedTradeTime, trade.time);
      }
    }
    this._emitUpdate(kind, "history", previous);
    if (this.pendingTrades.length > 0) this._scheduleFlush();
    return true;
  }

  private _reconcileRepairSnapshot(input: RepairSnapshotInput): ChartDataSnapshot | null {
    if (this.disposed || input.generation !== this.generation || !(input.to > input.from)) return null;
    const candidates = input.trades.filter((trade) => {
      const bucket = bucketStart(trade.time, this._intervalMs);
      return bucket >= input.from && bucket < input.to;
    });
    const replay: AggTrade[] = [];
    const seen = new Set<bigint>();
    for (const trade of candidates) {
      const id = decimalTradeId(trade.id);
      if (trade.liquidation === true || id === null || id <= input.watermark) return null;
      if (!seen.has(id)) {
        replay.push(trade);
        seen.add(id);
      }
    }
    const candidateSet = new Set(candidates);
    this._cancelFlush();
    if (candidateSet.size > 0) this.pendingTrades = this.pendingTrades.filter((trade) => !candidateSet.has(trade));
    const previous = snapshotFromSeries(this.series);
    this.series.replaceRange(input.from, input.to, [...input.bars]);
    if (replay.length) this.series.addTrades(replay, { dedupe: false });
    for (const trade of candidates) {
      if (Number.isFinite(trade.time)) this.lastAppliedTradeTime = Math.max(this.lastAppliedTradeTime, trade.time);
    }
    if (this.pendingTrades.length > 0) this._scheduleFlush();
    return previous;
  }

  private _releaseRecentCoverageRepair(state: RecentCoverageRepairState): void {
    if (this.recentCoverageRepair !== state) return;
    this.recentCoverageRepair = null;
    if (!this.disposed && state.generation === this.generation && this.pendingTrades.length > 0) this._scheduleFlush();
  }

  private _cancelFlush(): void {
    if (this.flushHandle !== null) this.scheduler.cancel(this.flushHandle);
    this.flushHandle = null;
    this.flushScheduled = false;
  }

  private _emitUpdate(
    kind: ChartDataUpdateEvent["kind"],
    source: ChartDataUpdateEvent["source"],
    previous = snapshotFromSeries(this.series),
    metadata?: { priceChanged?: boolean },
  ): void {
    const next = measurePerformance("pipeline.snapshot", () => snapshotFromSeries(this.series));
    measurePerformance("pipeline.dispatch", () => this.onUpdate?.(makeDataUpdateEvent(kind, source, previous, next, metadata)));
    incrementPerformanceCounter(`pipeline.update.${kind}`);
  }

  /**
   * Run the public before-update callback ahead of a series change. The callback may dispose the
   * pipeline, reset its config or start another load; any of those voids the change, so the caller
   * applies nothing when this returns false. Live trades it causes to arrive (and, with a synchronous
   * scheduler, to flush) are ordinary live input that each caller reconciles itself.
   */
  private _beforeUpdateKeepsPlan(kind: ChartDataUpdateEvent["kind"], generation: number, owned: () => boolean = () => true): boolean {
    this.onBeforeUpdate?.(kind);
    return !this.disposed && generation === this.generation && owned();
  }

  private _subscribe(): void {
    this.unsubscribe?.();
    const market = this._market;
    this.unsubscribe = this.services.subscribeToTrades(market, (trade: AggTrade) => {
      if (this.disposed || this.paused) return;
      if (trade.market !== undefined && trade.market !== market) return;
      const recent = this.recentCoverageRepair;
      if (recent) {
        if (!recent.overflow) {
          if (recent.trades.length >= RECENT_COVERAGE_REPAIR_BUFFER_CAP) {
            recent.overflow = true;
            recent.controller.abort();
          } else {
            recent.trades.push(trade);
            recent.journal.add(trade);
          }
        }
        if (!this._enqueuePendingTrade(trade)) this._scheduleFlush();
        return;
      }
      this.repair.handleTrade(trade);
      const explicit = this.explicitHistoryReconcile;
      const bucket = bucketStart(trade.time, this._intervalMs);
      const historyOwnsTrade = explicit && explicit.generation === this.generation
        && bucket >= explicit.requestedFrom && bucket < explicit.bootstrapFrom;
      if (historyOwnsTrade) {
        if (explicit.trades.length >= PENDING_TRADE_BUFFER_CAP) {
          this.historyController?.abort();
          this.explicitHistoryReconcile = null;
          this.integrityReporter?.report("pending", "EXPLICIT_HISTORY_RECONCILE_OVERFLOW");
        } else {
          explicit.trades.push(trade);
          explicit.liveAfterBarrier.add(trade);
          if (this._shouldDeferExplicitHistoryTrade(explicit, trade)) {
            explicit.deferred.add(trade);
            return;
          }
        }
        if (!this._enqueuePendingTrade(trade)) this._scheduleFlush();
        return;
      }
      if (!this._enqueuePendingTrade(trade)) this._scheduleFlush();
    });
    this.subscribedMarket = market;
  }

  private _enqueuePendingTrade(trade: AggTrade): boolean {
    if (!this.scheduler.isThrottled?.() && this.pendingTrades.length < PENDING_TRADE_BUFFER_CAP - 1) {
      this.pendingTrades.push(trade);
      return false;
    }
    return this._enqueuePendingTrades([trade]);
  }

  private _enqueuePendingTrades(trades: readonly AggTrade[]): boolean {
    if (trades.length === 0) return false;
    if (this.scheduler.isThrottled?.()) this._drainThrottledQueue(trades.length);
    const available = Math.max(0, PENDING_TRADE_BUFFER_CAP - this.pendingTrades.length);
    const accepted = Math.min(available, trades.length);
    if (accepted > 0) this.pendingTrades.push(...trades.slice(0, accepted));
    const dropped = trades.length - accepted;
    if (this.pendingTrades.length < PENDING_TRADE_BUFFER_CAP && dropped === 0) return false;
    incrementPerformanceCounter("pipeline.flush.overflow");
    this.pendingTradeOverloaded = true;
    this.integrityReporter?.report("pending", "PENDING_TRADE_BUFFER_OVERFLOW");
    if (dropped > 0) {
      this.pendingTradeDataLoss = true;
      incrementPerformanceCounter("pipeline.flush.overflow_dropped");
      this.onDataDegraded?.(true, "PENDING_TRADE_BUFFER_OVERFLOW: " + dropped + " live trade(s) require resync");
      this.cancelRecentFootprintCoverageRepair();
      this.repair.recoverDataLoss(trades.slice(accepted));
    }
    this._scheduleFlush();
    return true;
  }

  /** Apply queued trades now, so a hidden page's queue plus the incoming trades stays within one drain turn. */
  private _drainThrottledQueue(incoming: number): void {
    while (this.pendingTrades.length > 0 && this.pendingTrades.length + incoming > THROTTLED_QUEUE_LIMIT) {
      const before = this.pendingTrades.length;
      this._flushTrades(before, THROTTLED_DRAIN_BUDGET_MS);
      if (this.pendingTrades.length >= before) return;
      incrementPerformanceCounter("pipeline.flush.throttled_drain");
    }
  }

  private _scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    let firedSynchronously = false;
    const handle = this.scheduler.request(() => {
      firedSynchronously = true;
      this.flushScheduled = false;
      this.flushHandle = null;
      this._flushTrades(nextLiveTradeFlushBatchSize(this.pendingTrades.length));
      if (this.pendingTrades.length > 0) this._scheduleFlush();
    });
    this.flushHandle = firedSynchronously ? null : handle;
  }

  private _flushTrades(
    limit = nextLiveTradeFlushBatchSize(this.pendingTrades.length),
    budgetMs = DEFAULT_LIVE_TRADE_FLUSH_BUDGET_MS,
  ): void {
    if (this.disposed || this.paused || this.pendingTrades.length === 0) return;
    const flushStartedAt = performance.now();
    const count = Math.max(0, Math.min(this.pendingTrades.length, Math.floor(limit)));
    if (count === 0) return;
    const previousRevision = this.series.revision;
    const previousStructureRevision = this.series.structureRevision;
    const previousIdentityConflicts = this.series.identityConflictCount;
    const previous = measurePerformance("pipeline.snapshot", () => snapshotFromSeries(this.series));
    let processed = 0;
    while (processed < count) {
      if (liveTradeFlushBudgetExpired(flushStartedAt, performance.now(), processed, budgetMs)) break;
      const subBatchSize = nextLiveTradeSubBatchSize(count - processed);
      if (subBatchSize === 0) break;
      const batch = this.pendingTrades.slice(processed, processed + subBatchSize);
      measurePerformance("pipeline.addTrades", () => {
        for (const trade of batch) {
          if (typeof trade.id === "string" && trade.id.length > 0 && trade.liquidation !== true) {
            this.series.addTrade(trade);
          } else {
            this.series.addTrades([trade], { dedupe: false });
          }
        }
      });
      const recent = this.recentCoverageRepair;
      const explicit = this.explicitHistoryReconcile;
      for (const trade of batch) {
        if (recent?.journal.has(trade)) recent.applied.add(trade);
        if (explicit?.generation === this.generation) {
          const bucket = bucketStart(trade.time, this._intervalMs);
          if (bucket >= explicit.requestedFrom && bucket < explicit.bootstrapFrom) explicit.applied.add(trade);
        }
        if (Number.isFinite(trade.time)) this.lastAppliedTradeTime = Math.max(this.lastAppliedTradeTime, trade.time);
      }
      processed += batch.length;
    }
    if (processed === 0) return;
    this.pendingTrades = this.pendingTrades.slice(processed);
    incrementPerformanceCounter("pipeline.flush.count");
    incrementPerformanceCounter("pipeline.flush.trades", processed);
    const seriesChanged = this.series.revision !== previousRevision
      || this.series.structureRevision !== previousStructureRevision;
    if (seriesChanged) {
      const len = this.series.length;
      if (len > 0) {
        const newest = this.series.at(len - 1);
        if (newest && newest.startTime !== this.lastBarStart) {
          if (this.lastBarStart >= 0) {
            let firstClosedIdx = len - 1;
            while (firstClosedIdx > 0) {
              const bar = this.series.at(firstClosedIdx - 1);
              if (!bar || bar.startTime < this.lastBarStart) break;
              firstClosedIdx--;
            }
            for (let i = firstClosedIdx; i < len - 1; i++) {
              const closed = this.series.at(i);
              if (closed) this.onBarClose?.(closed);
            }
          }
          this.lastBarStart = newest.startTime;
        }
      }
      const next = measurePerformance("pipeline.snapshot", () => snapshotFromSeries(this.series));
      measurePerformance("pipeline.dispatch", () => {
        this.onUpdate?.(makeDataUpdateEvent(classifyLiveTradeUpdate(previous, next), "live", previous, next));
      });
    }
    recordPerformanceDuration("pipeline.flush", performance.now() - flushStartedAt);
    if (this.pendingTradeOverloaded && this.pendingTrades.length < PENDING_TRADE_BUFFER_CAP && !this.pendingTradeDataLoss) {
      this.pendingTradeOverloaded = false;
      incrementPerformanceCounter("pipeline.flush.overflow_recovered");
      if (!this.repair.isBlockingMaintenance()) this.integrityReporter?.report("healthy");
    }
    this.reportIdentityConflicts(this.series.identityConflictCount - previousIdentityConflicts);
  }

  /** A held conflict is released by any series reset, including an asynchronous price-step correction. */
  private conflictHeld(): boolean {
    return this.identityConflict !== null && this.identityConflict.seriesEpoch === this.series.resetEpoch;
  }

  /** The first delivery stays applied; the stream contradicted itself, so stop calling it healthy. */
  private reportIdentityConflicts(count: number): void {
    if (count <= 0 || this.disposed) return;
    const detail = "TRADE_IDENTITY_CONFLICT: " + count + " live trade(s) reused an applied ID with a different payload";
    this.identityConflict = { detail, seriesEpoch: this.series.resetEpoch };
    this.integrityReporter?.report("error", detail);
    this.onDataDegraded?.(true, detail);
  }

  private _ensureDesiredSubscription(): void {
    if (this.disposed || this.subscribedMarket === this._market) return;
    this._resubscribe();
  }

  private _resubscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribedMarket = null;
    this._subscribe();
  }
}
