/** History window loading, explicit reconcile barrier, day patching, cell refill, and live OHLC seed coordinator. */
import type { FootprintSeries } from "../../../core/model/footprint.js";
import { WEEK_MS, bucketEnd, bucketStart } from "../../../core/time.js";
import { footprintEnabledAt } from "../../../core/footprintPolicy.js";
import { isFootprintSyncAllowed, recordFootprintSupport } from "../../../core/syncAllowlist.js";
import type { AggTrade, FootprintBar } from "../../../core/types.js";
import type { CandleCoverage, EnvelopeMeta } from "../../../core/envelope.js";
import { incrementPerformanceCounter } from "../../../core/performanceTelemetry.js";
import { snapshotFromSeries, type ChartDataSnapshot, type ChartDataUpdateEvent } from "../../../core/dataUpdateEvent.js";
import { createLoadTrace, logLoadTrace } from "../../../core/loadTrace.js";
import type { PipelineIntegrityReporter } from "../ChartDataPipelinePorts.js";
import type { RepairSnapshotInput } from "../LiveTradeRepairController.js";
import type { HistoryBatch, HistoryQuery } from "../historyContracts.js";
import {
  HISTORY_MAX_WINDOW_BARS,
  HISTORY_MAX_WINDOW_CELLS,
  historyCellBudgetError,
  planHistoryWindows,
  planTwoPhaseCellWindows,
  splitHistoryCellBudgetWindow,
  splitOversizedHistoryWindow,
} from "../historyWindowPolicy.js";
import { chartDataSource } from "../chartDataSource.js";
import { abortableDelay } from "../abortableDelay.js";
import { decimalTradeId } from "./recentCoverageRepair.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const M1_BASE_RETENTION_DAYS = 85;
const FILL_RETRY_COOLDOWN_MS = 5 * 60_000;
const FILL_REFRESH_POLL_MS = 1_500;
const FILL_REFRESH_TIMEOUT_MS = 90_000;
const LIVE_OHLC_REQUEST_TIMEOUT_MS = 20_000;

export interface LoadHistoryOpts {
  from: number;
  to: number;
  targetBars?: number;
  rebuildKlines?: boolean;
  preferCache?: boolean;
  signal?: AbortSignal;
  twoPhase?: boolean;
}

export interface ExplicitHistoryReconcileState {
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

export function candleSnapshotOwnsBucket(
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

export function samePriceStructure(previous: readonly FootprintBar[], next: readonly FootprintBar[]): boolean {
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
export function candleOnlyBar(bar: FootprintBar): FootprintBar {
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

export function lowerBoundByStartTime(bars: readonly FootprintBar[], target: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bars[mid].startTime < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface HistoryLoadHost {
  readonly integrityReporter?: PipelineIntegrityReporter;
  notifyDataDegraded(degraded: boolean, detail: string): void;
  readonly onHistoryCandlesReady: () => void;
  isDisposed(): boolean;
  getGeneration(): number;
  getMarket(): string;
  getIntervalMs(): number;
  isBlockingCandleMaintenance(): boolean;
  beginExplicitHistory(range: { from: number; toExclusive: number }): number;
  finishExplicitHistory(token: number): boolean;
  cancelRecentFootprintCoverageRepair(): void;
  reportServerPriceStep(meta: EnvelopeMeta | undefined): void;
  getPendingTrades(): readonly AggTrade[];
  getPendingTradesCount(): number;
  filterPendingTrades(predicate: (trade: AggTrade) => boolean): void;
  enqueuePendingTrades(trades: readonly AggTrade[]): boolean;
  scheduleFlush(): void;
  cancelFlush(): void;
  beforeUpdateKeepsPlan(kind: ChartDataUpdateEvent["kind"], generation: number, owned?: () => boolean): boolean;
  emitUpdate(
    kind: ChartDataUpdateEvent["kind"],
    source: ChartDataUpdateEvent["source"],
    previous?: ChartDataSnapshot,
    metadata?: { priceChanged?: boolean },
  ): void;
  recordLastAppliedTradeTime(time: number): void;
  runPatchDayNow(from: number, toExclusive: number, generation: number): Promise<void>;
}

export class HistoryLoadCoordinator {
  private readonly series: FootprintSeries;
  historyController: AbortController | null = null;
  liveOhlcController: AbortController | null = null;
  liveOhlcPromise: Promise<void> | null = null;
  patchDayController: AbortController | null = null;
  patchDayChain: Promise<void> = Promise.resolve();
  readonly patchDayQueued = new Set<number>();
  fillCellsInFlightKey: string | null = null;
  readonly fillCellsAttempted = new Map<number, number>();
  lastPublishedDay: number | null = null;
  fillCellsController: AbortController | null = null;
  fillCellsPending: { from: number; to: number } | null = null;
  explicitHistoryReconcile: ExplicitHistoryReconcileState | null = null;

  activeHistoryTraceId: string | undefined;
  activeHistoryFootprintReceived = false;
  activeHistoryFootprintAvailable = true;
  activeHistoryFootprintCoverageComplete = false;
  activeHistoryCandleSourceGap: { from: number; to: number } | null = null;
  activeHistoryCoverageSeen = false;
  activeHistoryCoverageAllComplete = true;
  activeHistoryFootprintUncoveredFrom = Infinity;
  activeHistoryFootprintDegraded = false;
  activeHistoryFootprintDetail = "";
  activeHistoryErrorDetail = "";
  activeHistoryCandlesOnly = false;

  constructor(private readonly host: HistoryLoadHost, series: FootprintSeries) {
    this.series = series;
  }

  /**
   * Fold a response envelope's meta into pipeline state. `reportDegraded` is how a
   * caller says its meta does not speak for the panel's own data: the bookkeeping
   * below (footprint support, published day, server price step) still runs,
   * but the status-bar degraded badge is left alone.
   */
  readonly handleMeta = (meta: EnvelopeMeta | undefined, reportDegraded = true): void => {
    if (meta?.footprint?.available === false) this.activeHistoryFootprintAvailable = false;
    recordFootprintSupport(this.host.getMarket(), meta?.footprint?.allowed);
    const publishedThrough = meta?.footprint?.lastPublishedDay;
    if (typeof publishedThrough === "number" && publishedThrough >= 0) this.lastPublishedDay = publishedThrough;
    this.host.reportServerPriceStep(meta);
    if (!reportDegraded) return;
    if (meta?.degraded) {
      const errorEntries = (meta.provenance ?? []).filter((p): p is typeof p & { error: string } => Boolean(p.error));
      const droppedBars = meta.footprint?.droppedBars ?? 0;
      const reasonCode = meta.footprintCoverage?.reasonCode;
      const footprintParts = errorEntries.map((p) => (p.source && !p.error.includes(p.source) ? `${p.source}: ${p.error}` : p.error));
      if (droppedBars > 0) footprintParts.push(`Footprint dropped ${droppedBars} bars`);
      if (reasonCode && !footprintParts.some((part) => part.includes(reasonCode))) footprintParts.push(`Reason: ${reasonCode}`);
      this.activeHistoryFootprintDetail = footprintParts.join(" · ");
      const provenanceDetail = errorEntries.length > 1
        ? errorEntries.map((p) => (p.source && !p.error.includes(p.source) ? `${p.source}: ${p.error}` : p.error)).join(" · ")
        : errorEntries[0]?.error;
      const detail = provenanceDetail ?? (droppedBars > 0 ? `Footprint dropped ${droppedBars} bars` : (reasonCode ?? ""));
      this.host.notifyDataDegraded(true, detail);
    } else {
      this.host.notifyDataDegraded(false, "");
    }
  };

  handleLiveBootstrapMeta(meta: EnvelopeMeta | undefined): void {
    recordFootprintSupport(this.host.getMarket(), meta?.footprint?.allowed);
    const publishedThrough = meta?.footprint?.lastPublishedDay;
    if (typeof publishedThrough === "number" && publishedThrough >= 0) this.lastPublishedDay = publishedThrough;
    this.host.reportServerPriceStep(meta);
  }

  cancelHistoryLoad(): void {
    this.historyController?.abort();
    this.historyController = null;
  }

  cancelPatchDay(): void {
    this.patchDayController?.abort();
    this.patchDayController = null;
    this.resetPatchDayQueue();
  }

  cancelLiveBarOHLCRefresh(): void {
    this.liveOhlcController?.abort();
  }

  abortExplicitHistoryOverflow(): void {
    this.historyController?.abort();
    this.explicitHistoryReconcile = null;
    this.host.integrityReporter?.report("pending", "EXPLICIT_HISTORY_RECONCILE_OVERFLOW");
  }

  markExplicitTradeApplied(trade: AggTrade): void {
    const explicit = this.explicitHistoryReconcile;
    if (explicit?.generation === this.host.getGeneration()) {
      const bucket = bucketStart(trade.time, this.host.getIntervalMs());
      if (bucket >= explicit.requestedFrom && bucket < explicit.bootstrapFrom) explicit.applied.add(trade);
    }
  }

  markRecentCoverageCompleted(from: number): void {
    if (from <= this.activeHistoryFootprintUncoveredFrom && this.activeHistoryCoverageSeen
      && this.activeHistoryFootprintAvailable && !this.activeHistoryFootprintDegraded) {
      this.activeHistoryFootprintCoverageComplete = true;
      this.activeHistoryFootprintDetail = "";
    }
  }

  resetForConfigChange(abortOnly: boolean): void {
    if (abortOnly) {
      this.historyController?.abort();
      this.historyController = null;
      this.explicitHistoryReconcile = null;
      this.liveOhlcController?.abort();
      this.patchDayController?.abort();
      this.patchDayController = null;
      this.resetPatchDayQueue();
      return;
    }
    this.activeHistoryFootprintDetail = "";
    this.activeHistoryErrorDetail = "";
    this.resetCellFillState();
  }

  resetForPriceStep(): void {
    this.historyController?.abort();
    this.explicitHistoryReconcile = null;
    this.patchDayController?.abort();
    this.patchDayController = null;
    this.resetPatchDayQueue();
    this.activeHistoryFootprintDetail = "";
    this.activeHistoryErrorDetail = "";
    this.resetCellFillState();
  }

  dispose(): void {
    this.historyController?.abort();
    this.historyController = null;
    this.explicitHistoryReconcile = null;
    this.liveOhlcController?.abort();
    this.patchDayController?.abort();
    this.patchDayController = null;
    this.resetPatchDayQueue();
    this.fillCellsController?.abort();
    this.fillCellsController = null;
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

  shouldDeferExplicitHistoryTrade(state: ExplicitHistoryReconcileState, trade: AggTrade): boolean {
    const bucket = bucketStart(trade.time, this.host.getIntervalMs());
    return bucket >= state.requestedFrom
      && bucket <= state.requestedTo
      && bucket < state.bootstrapFrom
      && this.series.get(bucket) === undefined;
  }

  async loadHistory(opts: LoadHistoryOpts): Promise<void> {
    this.host.cancelRecentFootprintCoverageRepair();
    const intervalMs = this.host.getIntervalMs();
    const generation = this.host.getGeneration();
    const requestedFrom = bucketStart(opts.from, intervalMs);
    const bootstrapFrom = bucketStart(Date.now(), intervalMs);
    const token = this.host.beginExplicitHistory({ from: requestedFrom, toExclusive: bootstrapFrom });
    const historyReconcile: ExplicitHistoryReconcileState = {
      generation,
      requestedFrom,
      requestedTo: bucketStart(opts.to, intervalMs),
      bootstrapFrom,
      trades: this.host.getPendingTrades().filter((trade) => {
        const bucket = bucketStart(trade.time, intervalMs);
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
      if (this.shouldDeferExplicitHistoryTrade(historyReconcile, trade)) historyReconcile.deferred.add(trade);
    }
    if (historyReconcile.deferred.size > 0) {
      this.host.filterPendingTrades((trade) => !historyReconcile.deferred.has(trade));
      if (this.host.getPendingTradesCount() === 0) this.host.cancelFlush();
    }
    this.explicitHistoryReconcile = historyReconcile;
    try {
      await this._loadHistory(opts);
    } catch (error) {
      if (!this.host.isDisposed() && historyReconcile.generation === this.host.getGeneration()) {
        this.activeHistoryErrorDetail = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (this.explicitHistoryReconcile === historyReconcile) this.explicitHistoryReconcile = null;
      if (historyReconcile.deferred.size > 0 && !this.host.isDisposed() && historyReconcile.generation === this.host.getGeneration()) {
        const deferred = [...historyReconcile.deferred];
        historyReconcile.deferred.clear();
        this.host.enqueuePendingTrades(deferred);
        if (this.host.getPendingTradesCount() > 0) this.host.scheduleFlush();
      }
      if (this.host.finishExplicitHistory(token)) this.historyController = null;
    }
  }

  private async _loadHistory(opts: LoadHistoryOpts): Promise<void> {
    if (this.host.isDisposed()) return;
    this.historyController?.abort();
    const controller = new AbortController();
    this.historyController = controller;
    const generation = this.host.getGeneration();
    const market = this.host.getMarket();
    const intervalMs = this.host.getIntervalMs();
    const bootstrapFrom = this.explicitHistoryReconcile?.generation === generation
      ? this.explicitHistoryReconcile.bootstrapFrom
      : bucketStart(Date.now(), intervalMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const rebuild = opts.rebuildKlines ?? false;
    const traceId = createLoadTrace(market, intervalMs);
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
      if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
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
    const candlesOnly = chartDataSource().isDirectCandleMarket(market);
    this.activeHistoryCandlesOnly = candlesOnly;
    if (opts.twoPhase) {
      let fastPhaseComplete = false;
      let fastPhaseError: unknown;
      try {
        let emittedFast = false;
        const fastWindows = planHistoryWindows({
          markets: [market], from: opts.from, to: opts.to, interval: intervalMs,
          priceStep: this.series.config.priceStep, reference: market, rebuild,
          includeFootprint: false, preferCache: opts.preferCache ?? intervalMs < WEEK_MS,
          candleCoverage: "required", onMeta: (meta) => onHistoryMeta(meta, false), signal, traceId,
        });
        for (const fastWindow of fastWindows) {
          this._resetExplicitHistoryWatermark(generation);
          const fastBars = await chartDataSource().fetchHistory(fastWindow);
          if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
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
        if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        this.host.onHistoryCandlesReady();
      }
      if (candlesOnly) {
        if (controller.signal.aborted || this.host.isDisposed()) return;
        if (!fastPhaseComplete) throw fastPhaseError;
        this.activeHistoryFootprintDegraded = loadHasDegradedMeta && this.activeHistoryCandleSourceGap === null;
        logLoadTrace(traceId, "pipeline.history.complete", { seriesBars: this.series.length });
        return;
      }
    }
    if (opts.twoPhase) {
      const phase2Base: HistoryQuery = {
        markets: [market], from: opts.from, to: opts.to, interval: intervalMs,
        priceStep: this.series.config.priceStep, reference: market,
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
            if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
            receivedBars.push(...bars);
            receivedBarCellCounts.push(...(barCellCounts ?? bars.map((bar) => bar.cells.size)));
            receivedCells += cellCount ?? bars.reduce((sum, bar) => sum + bar.cells.size, 0);
          });
        } catch (error) {
          if (controller.signal.aborted || this.host.isDisposed()) return;
          throw error;
        }
        if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        const budgetError = historyCellBudgetError(windowMeta);
        if (budgetError) {
          const split = splitHistoryCellBudgetWindow(chunk);
          if (!split) { onHistoryMeta(windowMeta); if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return; throw new Error(budgetError); }
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
        if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        if (receivedBars.length) {
          const replaceableBars = receivedBars.filter((bar) => bar.startTime < bootstrapFrom);
          if (replaceableBars.length) {
            const batchFrom = replaceableBars[0].startTime;
            const batchTo = bucketEnd(replaceableBars[replaceableBars.length - 1]!.startTime, intervalMs);
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
      markets: [market], from: opts.from, to: opts.to, interval: intervalMs,
      priceStep: this.series.config.priceStep, reference: market,
      rebuild, preferCache: opts.preferCache, candleCoverage: "required", signal, onMeta: onHistoryMeta, traceId, consumeBatchRecords: 8,
    });
    try {
      while (queue.length) {
        if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        const window = queue.shift()!;
        const receivedBars: FootprintBar[] = [];
        const receivedBarCellCounts: number[] = [];
        let receivedCells = 0;
        let windowMeta: EnvelopeMeta | undefined;
        this._resetExplicitHistoryWatermark(generation);
        await chartDataSource().streamHistory({ ...window, onMeta: (meta) => { windowMeta = meta; } }, async ({ bars, cellCount, barCellCounts }: HistoryBatch) => {
          if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
          receivedBars.push(...bars);
          receivedBarCellCounts.push(...(barCellCounts ?? bars.map((bar) => bar.cells.size)));
          receivedCells += cellCount ?? bars.reduce((sum, bar) => sum + bar.cells.size, 0);
        });
        if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        const budgetError = historyCellBudgetError(windowMeta);
        if (budgetError) {
          const split = splitHistoryCellBudgetWindow(window);
          if (!split) { onHistoryMeta(windowMeta); if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return; throw new Error(budgetError); }
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
        if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        this._seedOpenBucketFromHistory(receivedBars, bootstrapFrom);
        if (!receivedBars.length) continue;
        const replaceableBars = receivedBars.filter((bar) => bar.startTime < bootstrapFrom);
        if (!replaceableBars.length) continue;
        const batchFrom = replaceableBars[0].startTime;
        const batchTo = bucketEnd(replaceableBars[replaceableBars.length - 1]!.startTime, intervalMs);
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
      if (controller.signal.aborted || this.host.isDisposed()) return;
      throw error;
    }
    if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
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

  private _seedOpenBucketFromHistory(bars: readonly FootprintBar[], bootstrapFrom: number): void {
    const openBars = bars.filter((bar) => bar.startTime >= bootstrapFrom).map(candleOnlyBar);
    if (openBars.length === 0) return;
    const applied = this.applyLiveBarSeed(openBars, {
      market: this.host.getMarket(),
      intervalMs: this.host.getIntervalMs(),
      from: bootstrapFrom,
      observedAt: Date.now(),
      fillMissingOnly: true,
    });
    if (applied.length > 0) {
      logLoadTrace(this.activeHistoryTraceId, "pipeline.open_bucket.seeded", { buckets: applied.length, source: "history" });
    }
  }

  async refreshLiveBarOHLC(): Promise<void> {
    if (this.host.isDisposed() || this.host.isBlockingCandleMaintenance()) return;
    if (this.liveOhlcPromise) return this.liveOhlcPromise;
    const controller = new AbortController();
    this.liveOhlcController = controller;
    const generation = this.host.getGeneration();
    const market = this.host.getMarket();
    const intervalMs = this.host.getIntervalMs();
    const run = async (): Promise<void> => {
      const to = Date.now();
      const from = to - intervalMs * 2;
      try {
        const bars = await chartDataSource().fetchSharedLiveOhlc({
          markets: [market], from, to, interval: intervalMs,
          priceStep: this.series.config.priceStep, reference: market,
          rebuild: true, includeFootprint: false, purpose: "maintenance",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(LIVE_OHLC_REQUEST_TIMEOUT_MS)]),
        });
        if (this.host.isDisposed() || controller.signal.aborted || generation !== this.host.getGeneration()) return;
        const previous = snapshotFromSeries(this.series);
        const liveStart = bucketStart(Date.now(), intervalMs);
        for (const bar of bars) {
          if (bar.startTime === liveStart && this.series.get(bar.startTime) === undefined) {
            this.series.upsertBar(bar);
            continue;
          }
          this.series.reassertOHLC(bar.startTime, bar.open, bar.high, bar.low);
        }
        this.host.emitUpdate("history-patched", "history", previous);
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

  applyLiveBarSeed(
    bars: readonly FootprintBar[],
    opts: {
      market: string;
      intervalMs: number;
      from: number;
      observedAt: number;
      fillMissingOnly?: boolean;
    },
  ): number[] {
    const market = this.host.getMarket();
    const intervalMs = this.host.getIntervalMs();
    if (this.host.isDisposed() || opts.market !== market || opts.intervalMs !== intervalMs) return [];
    const liveStart = bucketStart(Date.now(), intervalMs);
    const applicable = bars.filter((bar) => bar.startTime >= opts.from
      && bar.startTime <= liveStart
      && bucketStart(bar.startTime, intervalMs) === bar.startTime
      && !(opts.fillMissingOnly && this.series.get(bar.startTime) !== undefined));
    if (applicable.length === 0) return [];

    const previous = snapshotFromSeries(this.series);
    if (!this.host.beforeUpdateKeepsPlan("history-patched", this.host.getGeneration())) return [];
    const applied: number[] = [];
    const ohlcBefore = new Map<number, [number, number, number, number]>();
    for (const bar of applicable) {
      const existing = this.series.get(bar.startTime);
      if (existing && !ohlcBefore.has(bar.startTime)) {
        ohlcBefore.set(bar.startTime, [existing.open, existing.high, existing.low, existing.close]);
      }
      if (!existing) {
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
    this.host.emitUpdate("history-patched", "history", previous, { priceChanged });
    return applied;
  }

  async patchDay(dayTs: number): Promise<void> {
    if (this.host.isDisposed()) return;
    const iv = this.host.getIntervalMs();
    const dayStart = bucketStart(dayTs, DAY_MS);
    const from = iv < DAY_MS ? dayStart : bucketStart(dayTs, iv);
    const toExclusive = iv < DAY_MS ? dayStart + DAY_MS : bucketEnd(from, iv);
    if (this.patchDayQueued.has(from)) return this.patchDayChain;
    this.patchDayQueued.add(from);
    const generation = this.host.getGeneration();
    const run = this.patchDayChain
      .then(() => this.host.runPatchDayNow(from, toExclusive, generation))
      .finally(() => { this.patchDayQueued.delete(from); });
    // The caller sees this day's failure; the queue does not, or every later patch would be skipped.
    this.patchDayChain = run.catch(() => undefined);
    return run;
  }

  async _patchDayNow(from: number, toExclusive: number, generation: number): Promise<void> {
    if (this.host.isDisposed() || generation !== this.host.getGeneration()) return;
    const iv = this.host.getIntervalMs();
    const market = this.host.getMarket();
    const controller = new AbortController();
    this.patchDayController = controller;
    let bars: FootprintBar[];
    let degraded = false;
    let coverage: CandleCoverage | null = null;
    try {
      bars = await chartDataSource().collectHistory({
        markets: [market], from, to: Math.max(from, toExclusive - 1), interval: iv,
        priceStep: this.series.config.priceStep, reference: market,
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
    if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
    const ordered = this.series.listReadonly();
    const firstInDay = lowerBoundByStartTime(ordered, from);
    const lastInDay = lowerBoundByStartTime(ordered, toExclusive);
    const previousBars = firstInDay < lastInDay ? ordered.slice(firstInDay, lastInDay) : [];
    if (degraded) return;
    const providedStarts = new Set<number>();
    for (const bar of bars) {
      providedStarts.add(bar.startTime);
    }
    const closedTo = Math.min(toExclusive, bucketStart(Date.now(), iv));
    if (bars.length === 0 && previousBars.length > 0
      && !previousBars.some((bar) => candleSnapshotOwnsBucket(coverage, market, bar.startTime, iv))
      && !(closedTo > from && this.host.getPendingTrades().some((trade) => {
        const bucket = bucketStart(trade.time, iv);
        return bucket >= from && bucket < closedTo
          && candleSnapshotOwnsBucket(coverage, market, bucket, iv);
      }))) {
      return;
    }
    const previous = snapshotFromSeries(this.series);
    if (!this.host.beforeUpdateKeepsPlan("history-patched", generation)) return;
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
      if (candleSnapshotOwnsBucket(coverage, market, existing.startTime, iv)) continue;
      replacementByStart.set(existing.startTime, existing);
    }
    const merged = [...replacementByStart.values()].sort((a, b) => a.startTime - b.startTime);
    const priceChanged = !samePriceStructure(currentBars, merged);
    if (closedTo > from && this.host.getPendingTradesCount() > 0) {
      this.host.filterPendingTrades((trade) => {
        const bucket = bucketStart(trade.time, iv);
        if (bucket >= from && bucket < closedTo && !providedStarts.has(bucket)
          && !candleSnapshotOwnsBucket(coverage, market, bucket, iv)) return true;
        return bucket < from || bucket >= closedTo;
      });
    }
    this.series.replaceRange(from, toExclusive, merged);
    this.host.emitUpdate("history-patched", "history", previous, { priceChanged });
  }

  fillMissingCells(from: number, to: number): void {
    if (this.host.isDisposed() || !(to > from)) return;
    if (this.fillCellsInFlightKey !== null) {
      this.fillCellsPending = { from, to };
      return;
    }
    const intervalMs = this.host.getIntervalMs();
    const market = this.host.getMarket();
    const dayFrom = bucketStart(from, DAY_MS);
    const todayStart = bucketStart(Date.now(), DAY_MS);
    const publishedThrough = this.lastPublishedDay ?? todayStart - DAY_MS;
    const dayToExclusive = Math.min(bucketEnd(Math.max(from, to - 1), DAY_MS), publishedThrough + DAY_MS);
    if (dayToExclusive <= dayFrom) return;
    let effectiveFrom = dayFrom;
    if (intervalMs < HOUR_MS) {
      const m1RetentionStart = todayStart - M1_BASE_RETENTION_DAYS * DAY_MS;
      effectiveFrom = Math.max(effectiveFrom, m1RetentionStart);
      if (dayToExclusive <= effectiveFrom) return;
    }
    if (!footprintEnabledAt(effectiveFrom) || !isFootprintSyncAllowed(market)) return;
    let reqFrom = effectiveFrom;
    while (reqFrom < dayToExclusive && (!this._fillRetryDue(reqFrom) || !this.hasUnsyncedBars(reqFrom, reqFrom + DAY_MS))) reqFrom += DAY_MS;
    if (reqFrom >= dayToExclusive) return;
    const reqTo = Math.min(reqFrom + DAY_MS, dayToExclusive);
    const key = `${reqFrom}-${reqTo}`;
    if (this.fillCellsInFlightKey === key) return;
    this.fillCellsAttempted.set(reqFrom, Date.now());
    this.fillCellsInFlightKey = key;
    const controller = new AbortController();
    this.fillCellsController = controller;
    const generation = this.host.getGeneration();
    void (async () => {
      await chartDataSource().startRefresh([market], intervalMs, this.series.config.priceStep, market, reqFrom, reqTo, controller.signal);
      await this._awaitRefreshIdle(controller.signal);
      for (let day = reqFrom; day < reqTo; day += DAY_MS) {
        if (this.host.isDisposed() || generation !== this.host.getGeneration() || controller.signal.aborted) return;
        await this.patchDay(day);
      }
    })().catch(() => undefined).finally(() => {
      if (this.fillCellsInFlightKey === key) this.fillCellsInFlightKey = null;
      if (this.fillCellsController === controller) this.fillCellsController = null;
      const pending = this.fillCellsPending ?? { from, to };
      this.fillCellsPending = null;
      if (!this.host.isDisposed() && !controller.signal.aborted) this.fillMissingCells(pending.from, pending.to);
    });
  }

  private _fillRetryDue(dayStart: number): boolean {
    const attemptedAt = this.fillCellsAttempted.get(dayStart);
    return attemptedAt === undefined || Date.now() - attemptedAt >= FILL_RETRY_COOLDOWN_MS;
  }

  private async _awaitRefreshIdle(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + FILL_REFRESH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.host.isDisposed() || signal.aborted) return;
      const status = await chartDataSource().fetchRefreshStatus(signal);
      if (status.state !== "running") return;
      if (!(await abortableDelay(FILL_REFRESH_POLL_MS, signal))) return;
    }
  }

  hasUnsyncedBars(from: number, to: number): boolean {
    for (let i = this.series.length - 1; i >= 0; i--) {
      const bar = this.series.at(i);
      if (!bar) continue;
      if (bar.startTime < from) break;
      if (bar.startTime >= to) continue;
      if (bar.cells.size === 0 && (bar.volume > 0 || bar.count > 0)) return true;
    }
    return false;
  }

  private _resetExplicitHistoryWatermark(generation: number): void {
    const state = this.explicitHistoryReconcile;
    if (state && state.generation === generation) {
      state.watermark = null;
      state.candleCoverage = null;
    }
  }

  _applyExplicitHistorySnapshot(
    from: number,
    to: number,
    bars: readonly FootprintBar[],
    generation: number,
    kind: "history-loaded" | "history-patched",
    preserveCells: boolean,
    notifyBefore: boolean,
  ): boolean {
    const state = this.explicitHistoryReconcile;
    const intervalMs = this.host.getIntervalMs();
    const market = this.host.getMarket();
    if (!state || state.generation !== generation || generation !== this.host.getGeneration() || this.host.isDisposed() || !(to > from)) return false;
    // The public callback runs before anything is planned, so trades it causes to arrive are part of the plan.
    if (notifyBefore && !this.host.beforeUpdateKeepsPlan(kind, generation, () => this.explicitHistoryReconcile === state)) return false;
    const watermark = state.watermark;
    for (const [bucket, retired] of state.retiredWatermarks) {
      if (bucket < from || bucket >= to) continue;
      if (watermark === null || watermark < retired) {
        incrementPerformanceCounter("pipeline.history.snapshot_rejected");
        this.host.integrityReporter?.report("pending", "HISTORY_SNAPSHOT_WATERMARK_REGRESSION");
        this.historyController?.abort();
        return false;
      }
    }

    const candidates = state.trades.filter((trade) => {
      const bucket = bucketStart(trade.time, intervalMs);
      return bucket >= from && bucket < to;
    });
    const incomingStarts = new Set(bars.map((bar) => bar.startTime));
    const blockedBuckets = new Set<number>();
    for (const trade of candidates) {
      const bucket = bucketStart(trade.time, intervalMs);
      if (!incomingStarts.has(bucket) || !candleSnapshotOwnsBucket(state.candleCoverage, market, bucket, intervalMs)) {
        blockedBuckets.add(bucket);
      }
    }
    if (blockedBuckets.size > 0) {
      incrementPerformanceCounter("pipeline.history.candle_coverage_unknown", blockedBuckets.size);
      this.host.integrityReporter?.report("pending", "CANDLE_COVERAGE_UNKNOWN");
      this.host.notifyDataDegraded(true, "CANDLE_COVERAGE_UNKNOWN: overlapping live candle kept until source ownership is verified");
      // Both reach code outside the pipeline, which may reset it or start another load.
      if (this.explicitHistoryReconcile !== state || generation !== this.host.getGeneration() || this.host.isDisposed()) return false;
    }

    const reconciledCandidates = candidates.filter((trade) => !blockedBuckets.has(bucketStart(trade.time, intervalMs)));
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
      if (candleSnapshotOwnsBucket(state.candleCoverage, market, existing.startTime, intervalMs)) continue;
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
    this.host.cancelFlush();
    if (candidateSet.size > 0) this.host.filterPendingTrades((trade) => !candidateSet.has(trade));

    for (const trade of reconciledCandidates) state.deferred.delete(trade);
    const replayFootprint: AggTrade[] = [];
    const retained = new Set<AggTrade>();
    for (const trade of reconciledCandidates) {
      const bucket = bucketStart(trade.time, intervalMs);
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
        this.host.recordLastAppliedTradeTime(trade.time);
      }
    }
    this.host.emitUpdate(kind, "history", previous);
    if (this.host.getPendingTradesCount() > 0) this.host.scheduleFlush();
    return true;
  }

  reconcileRepairSnapshot(input: RepairSnapshotInput): ChartDataSnapshot | null {
    if (this.host.isDisposed() || input.generation !== this.host.getGeneration() || !(input.to > input.from)) return null;
    const intervalMs = this.host.getIntervalMs();
    const candidates = input.trades.filter((trade) => {
      const bucket = bucketStart(trade.time, intervalMs);
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
    this.host.cancelFlush();
    if (candidateSet.size > 0) this.host.filterPendingTrades((trade) => !candidateSet.has(trade));
    const previous = snapshotFromSeries(this.series);
    this.series.replaceRange(input.from, input.to, [...input.bars]);
    if (replay.length) this.series.addTrades(replay, { dedupe: false });
    for (const trade of candidates) {
      this.host.recordLastAppliedTradeTime(trade.time);
    }
    if (this.host.getPendingTradesCount() > 0) this.host.scheduleFlush();
    return previous;
  }
}
