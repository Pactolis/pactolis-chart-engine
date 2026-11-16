/** Per-panel historical/live chart data facade. */
import { FootprintSeries } from "../../core/model/footprint.js";
import type { AggTrade, FootprintBar } from "../../core/types.js";
import type { ChartDataStateInputs } from "./chartDataState.js";
import { incrementPerformanceCounter, measurePerformance } from "../../core/performanceTelemetry.js";
import {
  makeDataUpdateEvent,
  snapshotFromSeries,
  type ChartDataUpdateEvent,
} from "../../core/dataUpdateEvent.js";
import { logLoadTrace } from "../../core/loadTrace.js";
import type { ChartDataPipelineServices, PipelineIntegrityReporter, TradeMarketReadiness } from "./ChartDataPipelinePorts.js";
import { LiveTradeRepairController } from "./LiveTradeRepairController.js";
import type { LiveRepairRetryReason } from "./recentCoverageRetryPolicy.js";
import {
  HistoryLoadCoordinator,
  type ExplicitHistoryReconcileState,
  type LoadHistoryOpts,
} from "./pipeline/historyLoad.js";
import {
  LiveTradeQueueCoordinator,
  defaultTradeFlushScheduler,
  type TradeFlushScheduler,
} from "./pipeline/liveTradeQueue.js";
import {
  PriceStepResolutionCoordinator,
  PRICE_STEP_RESOLVE_TIMEOUT_MS,
  SELECTION_PRICE_STEP_RETRY_DELAYS_MS,
} from "./pipeline/priceStepResolution.js";
import {
  RecentCoverageRepairCoordinator,
  type RecentCoverageRepairState,
  type RecentFootprintRepairOutcome,
} from "./pipeline/recentCoverageRepair.js";

export { PRICE_STEP_RESOLVE_TIMEOUT_MS, SELECTION_PRICE_STEP_RETRY_DELAYS_MS };
export type { RecentFootprintRepairOutcome, TradeFlushScheduler, LoadHistoryOpts };

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

export type PipelineDataStateInputs = Omit<ChartDataStateInputs, "historyStatus" | "footprintSupported" | "transportOffline">;

export class ChartDataPipeline {
  readonly series: FootprintSeries;
  readonly services: ChartDataPipelineServices;
  readonly integrityReporter?: PipelineIntegrityReporter;

  private sessionUnsubscribe: (() => void) | null = null;
  private readinessUnsubscribe: (() => void) | null = null;
  private latestMarketReadiness: TradeMarketReadiness | null = null;
  private disposed = false;
  private _market: string;
  private _intervalMs: number;
  private lastAppliedTradeTime = -Infinity;
  private generation = 0;
  /** Aborted on dispose so a pending step-lookup retry leaves no timer behind. */
  private readonly disposal = new AbortController();
  private readonly onDataDegraded?: (degraded: boolean, detail: string) => void;
  private readonly repair: LiveTradeRepairController;
  private readonly priceStepCoordinator: PriceStepResolutionCoordinator;
  private readonly tradeQueueCoordinator: LiveTradeQueueCoordinator;
  private readonly historyCoordinator: HistoryLoadCoordinator;
  private readonly recentRepairCoordinator: RecentCoverageRepairCoordinator;

  onUpdate: ((event: ChartDataUpdateEvent) => void) | null = null;
  onBeforeUpdate: ((kind: ChartDataUpdateEvent["kind"]) => void) | null = null;
  onHistoryCandlesReady: (() => void) | null = null;
  onBarClose: ((closed: FootprintBar) => void) | null = null;

  /** Last state this pipeline reported to its integrity gate. */
  private integrityState: { state: "pending" | "healthy" | "error"; detail: string } = { state: "healthy", detail: "" };

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
    const onDataDegraded = opts.onDataDegraded;
    this.onDataDegraded = onDataDegraded && ((degraded, detail) => {
      if (!degraded && this.conflictHeld()) return;
      onDataDegraded(degraded, detail);
    });
    this.series = new FootprintSeries({ intervalMs: opts.intervalMs, priceStep: opts.priceStep, referenceMarket: opts.market });
    if (opts.pricePrecision !== undefined) this.series.setPricePrecision(opts.pricePrecision);

    this.priceStepCoordinator = new PriceStepResolutionCoordinator({
      series: this.series,
      services: this.services,
      stepResolveTimeoutMs: opts.priceStepResolveTimeoutMs ?? PRICE_STEP_RESOLVE_TIMEOUT_MS,
      stepRetryDelaysMs: opts.priceStepRetryDelaysMs ?? SELECTION_PRICE_STEP_RETRY_DELAYS_MS,
      disposalSignal: this.disposal.signal,
      onServerPriceStep: opts.onServerPriceStep,
      isDisposed: () => this.disposed,
      getMarket: () => this._market,
      setPriceStep: (step) => this.setPriceStep(step),
      emitMetadataUpdated: () => this._emitUpdate("metadata-updated", "metadata"),
    });

    this.historyCoordinator = new HistoryLoadCoordinator({
      integrityReporter: this.integrityReporter,
      onDataDegraded: this.onDataDegraded,
      onHistoryCandlesReady: () => this.onHistoryCandlesReady?.(),
      isDisposed: () => this.disposed,
      getGeneration: () => this.generation,
      getMarket: () => this._market,
      getIntervalMs: () => this._intervalMs,
      isBlockingCandleMaintenance: () => this.repair.isBlockingCandleMaintenance(),
      beginExplicitHistory: (range) => this.repair.beginExplicitHistory(range),
      finishExplicitHistory: (token) => this.repair.finishExplicitHistory(token),
      cancelRecentFootprintCoverageRepair: () => this.cancelRecentFootprintCoverageRepair(),
      reportServerPriceStep: (meta) => this.priceStepCoordinator.reportServerPriceStep(meta),
      getPendingTrades: () => this.tradeQueueCoordinator.pendingTrades,
      getPendingTradesCount: () => this.tradeQueueCoordinator.pendingTrades.length,
      filterPendingTrades: (predicate) => {
        this.tradeQueueCoordinator.pendingTrades = this.tradeQueueCoordinator.pendingTrades.filter(predicate);
      },
      enqueuePendingTrades: (trades) => this.tradeQueueCoordinator._enqueuePendingTrades(trades),
      scheduleFlush: () => this.tradeQueueCoordinator._scheduleFlush(),
      cancelFlush: () => this.tradeQueueCoordinator._cancelFlush(),
      beforeUpdateKeepsPlan: (kind, generation, owned) => this._beforeUpdateKeepsPlan(kind, generation, owned),
      emitUpdate: (kind, source, previous, metadata) => this._emitUpdate(kind, source, previous, metadata),
      recordLastAppliedTradeTime: (time) => this.recordLastAppliedTradeTime(time),
      runPatchDayNow: (from, toExclusive, generation) => this._patchDayNow(from, toExclusive, generation),
    }, this.series);

    this.recentRepairCoordinator = new RecentCoverageRepairCoordinator({
      series: this.series,
      services: this.services,
      integrityReporter: this.integrityReporter,
      onDataDegraded: this.onDataDegraded,
      isDisposed: () => this.disposed,
      isPaused: () => this.tradeQueueCoordinator.paused,
      getGeneration: () => this.generation,
      getMarket: () => this._market,
      getIntervalMs: () => this._intervalMs,
      isBlockingMaintenance: () => this.repair.isBlockingMaintenance(),
      hasPatchDayInFlight: () => this.historyCoordinator.patchDayController !== null,
      hasFillCellsInFlight: () => this.historyCoordinator.fillCellsInFlightKey !== null,
      getPendingTradesCount: () => this.tradeQueueCoordinator.pendingTrades.length,
      filterPendingTrades: (predicate) => {
        this.tradeQueueCoordinator.pendingTrades = this.tradeQueueCoordinator.pendingTrades.filter(predicate);
      },
      scheduleFlush: () => this.tradeQueueCoordinator._scheduleFlush(),
      cancelFlush: () => this.tradeQueueCoordinator._cancelFlush(),
      handleMeta: (meta, reportDegraded) => this.historyCoordinator.handleMeta(meta, reportDegraded),
      beforeUpdateKeepsPlan: (kind, generation, owned) => this._beforeUpdateKeepsPlan(kind, generation, owned),
      emitHistoryPatched: (previous) => this._emitUpdate("history-patched", "history", previous),
      recordLastAppliedTradeTime: (time) => this.recordLastAppliedTradeTime(time),
      hasUnsyncedBars: (from, to) => this.historyCoordinator.hasUnsyncedBars(from, to),
      markHistoryFootprintReceived: () => { this.historyCoordinator.activeHistoryFootprintReceived = true; },
      markRecentCoverageCompleted: (from) => this.historyCoordinator.markRecentCoverageCompleted(from),
    });

    this.tradeQueueCoordinator = new LiveTradeQueueCoordinator({
      services: this.services,
      integrityReporter: this.integrityReporter,
      onDataDegraded: this.onDataDegraded,
      isDisposed: () => this.disposed,
      getMarket: () => this._market,
      getIntervalMs: () => this._intervalMs,
      getGeneration: () => this.generation,
      isBlockingMaintenance: () => this.repair.isBlockingMaintenance(),
      recordRecentRepairTrade: (trade) => this.recentRepairCoordinator.recordIncomingTrade(trade),
      handleRepairTrade: (trade) => this.repair.handleTrade(trade),
      getExplicitHistoryReconcile: () => this.historyCoordinator.explicitHistoryReconcile,
      shouldDeferExplicitHistoryTrade: (state, trade) => this.historyCoordinator.shouldDeferExplicitHistoryTrade(state, trade),
      abortExplicitHistoryOverflow: () => this.historyCoordinator.abortExplicitHistoryOverflow(),
      cancelRecentFootprintCoverageRepair: () => this.cancelRecentFootprintCoverageRepair(),
      recoverDataLoss: (dropped) => this.repair.recoverDataLoss(dropped),
      markTradeAppliedForRepairs: (trade) => {
        this.recentRepairCoordinator.markAppliedTrade(trade);
        this.historyCoordinator.markExplicitTradeApplied(trade);
      },
      recordLastAppliedTradeTime: (time) => this.recordLastAppliedTradeTime(time),
      emitBarClose: (closed) => this.onBarClose?.(closed),
      emitUpdateEvent: (event) => this._dispatchUpdateEvent(event),
    }, this.series, opts.scheduler ?? defaultTradeFlushScheduler());

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
      reconcileHistorySnapshot: (input) => this.historyCoordinator.reconcileRepairSnapshot(input),
      handleMeta: (meta) => this.historyCoordinator.handleLiveBootstrapMeta(meta),
      setDataDegraded: (degraded, detail) => this.onDataDegraded?.(degraded, detail),
      reportIdentityConflicts: (count) => this.tradeQueueCoordinator.reportIdentityConflicts(count),
      scheduleRecentCoverageRetry: (attempt, retry, reason) => this.recentRepairCoordinator.scheduleRetry(attempt, retry, reason),
      onReconciled: () => this.tradeQueueCoordinator.markReconciled(),
      trace: (stage, fields) => logLoadTrace(this.historyCoordinator.activeHistoryTraceId, stage, fields),
    });

    this.integrityReporter.report("healthy");
    this.tradeQueueCoordinator.subscribe();
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
      logLoadTrace(this.historyCoordinator.activeHistoryTraceId, "stream.market.acknowledged", { market: readiness.market, generation: readiness.generation });
      this.repair.onMarketReady(readiness);
    }) ?? null;
  }

  get market(): string { return this._market; }
  get intervalMs(): number { return this._intervalMs; }
  get liveBootstrapReconciled(): boolean { return this.repair.isReconciled; }

  get activeHistoryTraceId(): string | undefined { return this.historyCoordinator.activeHistoryTraceId; }
  set activeHistoryTraceId(value: string | undefined) { this.historyCoordinator.activeHistoryTraceId = value; }
  get activeHistoryFootprintReceived(): boolean { return this.historyCoordinator.activeHistoryFootprintReceived; }
  set activeHistoryFootprintReceived(value: boolean) { this.historyCoordinator.activeHistoryFootprintReceived = value; }
  get activeHistoryFootprintAvailable(): boolean { return this.historyCoordinator.activeHistoryFootprintAvailable; }
  set activeHistoryFootprintAvailable(value: boolean) { this.historyCoordinator.activeHistoryFootprintAvailable = value; }
  get activeHistoryFootprintCoverageComplete(): boolean { return this.historyCoordinator.activeHistoryFootprintCoverageComplete; }
  set activeHistoryFootprintCoverageComplete(value: boolean) { this.historyCoordinator.activeHistoryFootprintCoverageComplete = value; }
  get activeHistoryCandleSourceGap(): { from: number; to: number } | null { return this.historyCoordinator.activeHistoryCandleSourceGap; }
  set activeHistoryCandleSourceGap(value: { from: number; to: number } | null) { this.historyCoordinator.activeHistoryCandleSourceGap = value; }
  get activeHistoryCandlesOnly(): boolean { return this.historyCoordinator.activeHistoryCandlesOnly; }
  set activeHistoryCandlesOnly(value: boolean) { this.historyCoordinator.activeHistoryCandlesOnly = value; }
  get pendingStepCorrection(): Promise<number | null> { return this.priceStepCoordinator.pendingStepCorrection; }
  set pendingStepCorrection(value: Promise<number | null>) { this.priceStepCoordinator.pendingStepCorrection = value; }

  /** @internal White-box test compatibility bridge; do not call from production code. */
  get pendingTrades(): AggTrade[] { return this.tradeQueueCoordinator.pendingTrades; }
  set pendingTrades(trades: AggTrade[]) { this.tradeQueueCoordinator.pendingTrades = trades; }
  /** @internal White-box test compatibility bridge. */
  get explicitHistoryReconcile(): ExplicitHistoryReconcileState | null { return this.historyCoordinator.explicitHistoryReconcile; }
  set explicitHistoryReconcile(state: ExplicitHistoryReconcileState | null) { this.historyCoordinator.explicitHistoryReconcile = state; }
  /** @internal White-box test compatibility bridge. */
  get recentCoverageRepair(): RecentCoverageRepairState | null { return this.recentRepairCoordinator.state; }
  set recentCoverageRepair(state: RecentCoverageRepairState | null) { this.recentRepairCoordinator.state = state; }
  /** @internal White-box test compatibility bridge. */
  get historyController(): AbortController | null { return this.historyCoordinator.historyController; }
  set historyController(controller: AbortController | null) { this.historyCoordinator.historyController = controller; }
  /** @internal White-box test compatibility bridge. */
  get fillCellsAttempted(): Map<number, number> { return this.historyCoordinator.fillCellsAttempted; }

  setRecentCoverageRetryScheduler(scheduler: ((attempt: number, retry: () => boolean, reason: LiveRepairRetryReason) => void) | null): void {
    this.recentRepairCoordinator.setRetryScheduler(scheduler);
  }

  /** The pipeline-owned part of the chart's data state (#314); see chartDataState.ts. */
  dataStateInputs(): PipelineDataStateInputs {
    const gap = this.historyCoordinator.activeHistoryCandleSourceGap;
    const candleSourceGapDetail = gap
      ? `Gap ${new Date(gap.from).toISOString()} .. ${new Date(gap.to).toISOString()}`
      : "";
    let footprintDetail = this.historyCoordinator.activeHistoryFootprintDetail;
    if (!footprintDetail) {
      if (this.tradeQueueCoordinator.pendingTradeDataLoss && this.integrityState.detail) {
        footprintDetail = this.integrityState.detail;
      } else if (this.recentRepairCoordinator.state !== null) {
        footprintDetail = "Recent footprint coverage repair in progress";
      } else if (
        this.historyCoordinator.activeHistoryCoverageSeen
        && !this.historyCoordinator.activeHistoryFootprintCoverageComplete
        && Number.isFinite(this.historyCoordinator.activeHistoryFootprintUncoveredFrom)
      ) {
        footprintDetail = `Uncovered from ${new Date(this.historyCoordinator.activeHistoryFootprintUncoveredFrom).toISOString()}`;
      }
    }
    return {
      historyErrorDetail: this.historyCoordinator.activeHistoryErrorDetail,
      candleSourceGap: gap !== null,
      candleSourceGapDetail,
      integrity: this.integrityState.state,
      integrityDetail: this.integrityState.detail,
      liveTradesDropped: this.tradeQueueCoordinator.pendingTradeDataLoss,
      liveBacklogOverloaded: this.tradeQueueCoordinator.pendingTradeOverloaded,
      footprintReceived: this.historyCoordinator.activeHistoryFootprintReceived,
      footprintCoverageReported: this.historyCoordinator.activeHistoryCoverageSeen,
      footprintCoverageComplete: this.historyCoordinator.activeHistoryFootprintCoverageComplete,
      footprintHistoryDegraded: this.historyCoordinator.activeHistoryFootprintDegraded,
      footprintDetail,
      recentFootprintRepairActive: this.recentRepairCoordinator.state !== null,
      lastTradeTime: Number.isFinite(this.lastAppliedTradeTime) ? this.lastAppliedTradeTime : null,
    };
  }

  cancelHistoryLoad(): void { this.historyCoordinator.cancelHistoryLoad(); }
  loadHistory(opts: LoadHistoryOpts): Promise<void> { return this.historyCoordinator.loadHistory(opts); }
  cancelRecentFootprintCoverageRepair(): void { this.recentRepairCoordinator.cancel(); }
  repairRecentFootprintCoverage(from: number, to: number): Promise<RecentFootprintRepairOutcome> {
    return this.recentRepairCoordinator.repair(from, to);
  }
  refreshLiveBarOHLC(): Promise<void> { return this.historyCoordinator.refreshLiveBarOHLC(); }
  cancelLiveBarOHLCRefresh(): void { this.historyCoordinator.cancelLiveBarOHLCRefresh(); }
  applyLiveBarSeed(
    bars: readonly FootprintBar[],
    opts: { market: string; intervalMs: number; from: number; observedAt: number; fillMissingOnly?: boolean },
  ): number[] {
    return this.historyCoordinator.applyLiveBarSeed(bars, opts);
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
      this.historyCoordinator.resetForConfigChange(true);
    }
    if (marketChanged) {
      const generation = this.generation;
      await this.priceStepCoordinator.trackMarketSwitch(this._market);
      if (this.disposed || generation !== this.generation) {
        this.tradeQueueCoordinator.ensureDesiredSubscription();
        return;
      }
    } else if (tfChanged && this.priceStepCoordinator.pendingMarketMetadata) {
      const generation = this.generation;
      await this.priceStepCoordinator.awaitPendingMarketMetadata();
      if (this.disposed || generation !== this.generation) {
        this.tradeQueueCoordinator.ensureDesiredSubscription();
        return;
      }
    }
    if (tfChanged || marketChanged) {
      this.tradeQueueCoordinator.resetOnConfigOrStepChange();
      this.lastAppliedTradeTime = -Infinity;
      this.historyCoordinator.resetForConfigChange(false);
      this.integrityReporter?.report("healthy");
      this.onDataDegraded?.(false, "");
    }
    if (tfChanged) this.series.setInterval(this._intervalMs);
    else if (marketChanged) this.series.clear();
    this.tradeQueueCoordinator.ensureDesiredSubscription();
    if (tfChanged && !marketChanged && this.latestMarketReadiness?.market === this._market) {
      // The acknowledged boundary can be hours old. Repairing from it would let the live tail stretch
      // the replaced range over the history just loaded for the new timeframe, so start from now.
      const readiness = this.latestMarketReadiness;
      this.repair.onMarketReady({ ...readiness, boundaryAt: Math.max(readiness.boundaryAt, Date.now()) });
    }
  }

  setPaused(paused: boolean): void { this.tradeQueueCoordinator.setPaused(paused); }
  patchDay(dayTs: number): Promise<void> { return this.historyCoordinator.patchDay(dayTs); }
  fillMissingCells(from: number, to: number): void { this.historyCoordinator.fillMissingCells(from, to); }

  setPriceStep(step: number): void {
    if (this.disposed || step <= 0) return;
    this.cancelRecentFootprintCoverageRepair();
    this.repair.cancel();
    this.generation++;
    this.historyCoordinator.resetForPriceStep();
    this.tradeQueueCoordinator.resetOnConfigOrStepChange();
    this.lastAppliedTradeTime = -Infinity;
    this.integrityReporter?.report("healthy");
    this.onDataDegraded?.(false, "");
    const previous = snapshotFromSeries(this.series);
    this.series.setPriceStep(step);
    this._emitUpdate("price-step-reset", "config", previous);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposal.abort();
    this.recentRepairCoordinator.dispose();
    this.repair.dispose();
    this.generation++;
    this.historyCoordinator.dispose();
    this.tradeQueueCoordinator.dispose();
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
    this.readinessUnsubscribe?.();
    this.readinessUnsubscribe = null;
    this.integrityReporter?.dispose();
    this.onUpdate = null;
    this.onBeforeUpdate = null;
    this.onHistoryCandlesReady = null;
    this.onBarClose = null;
  }

  // Internal/test-hook delegates
  private _patchDayNow(from: number, toExclusive: number, generation: number): Promise<void> {
    return this.historyCoordinator._patchDayNow(from, toExclusive, generation);
  }

  /** @internal White-box test compatibility delegate. */
  _applyExplicitHistorySnapshot(
    from: number,
    to: number,
    bars: readonly FootprintBar[],
    generation: number,
    kind: "history-loaded" | "history-patched",
    preserveCells: boolean,
    notifyBefore: boolean,
  ): boolean {
    return this.historyCoordinator._applyExplicitHistorySnapshot(from, to, bars, generation, kind, preserveCells, notifyBefore);
  }

  /** @internal White-box test compatibility delegate. */
  _enqueuePendingTrade(trade: AggTrade): boolean { return this.tradeQueueCoordinator._enqueuePendingTrade(trade); }
  /** @internal White-box test compatibility delegate. */
  _enqueuePendingTrades(trades: readonly AggTrade[]): boolean { return this.tradeQueueCoordinator._enqueuePendingTrades(trades); }
  /** @internal White-box test compatibility delegate. */
  _flushTrades(limit?: number, budgetMs?: number): void { this.tradeQueueCoordinator._flushTrades(limit, budgetMs); }

  private recordLastAppliedTradeTime(time: number): void {
    if (Number.isFinite(time)) this.lastAppliedTradeTime = Math.max(this.lastAppliedTradeTime, time);
  }

  private conflictHeld(): boolean {
    return this.tradeQueueCoordinator.conflictHeld();
  }

  private _beforeUpdateKeepsPlan(kind: ChartDataUpdateEvent["kind"], generation: number, owned: () => boolean = () => true): boolean {
    this.onBeforeUpdate?.(kind);
    return !this.disposed && generation === this.generation && owned();
  }

  private _emitUpdate(
    kind: ChartDataUpdateEvent["kind"],
    source: ChartDataUpdateEvent["source"],
    previous = snapshotFromSeries(this.series),
    metadata?: { priceChanged?: boolean },
  ): void {
    const next = measurePerformance("pipeline.snapshot", () => snapshotFromSeries(this.series));
    this._dispatchUpdateEvent(makeDataUpdateEvent(kind, source, previous, next, metadata));
  }

  private _dispatchUpdateEvent(event: ChartDataUpdateEvent): void {
    measurePerformance("pipeline.dispatch", () => this.onUpdate?.(event));
    incrementPerformanceCounter(`pipeline.update.${event.kind}`);
  }
}
