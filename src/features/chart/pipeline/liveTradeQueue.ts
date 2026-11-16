/** Live trade subscription, pending queue, hidden-tab drain budget, and identity conflict coordinator. */
import type { FootprintSeries } from "../../../core/model/footprint.js";
import { bucketStart } from "../../../core/time.js";
import type { AggTrade, FootprintBar } from "../../../core/types.js";
import {
  incrementPerformanceCounter,
  measurePerformance,
  recordPerformanceDuration,
} from "../../../core/performanceTelemetry.js";
import {
  classifyLiveTradeUpdate,
  makeDataUpdateEvent,
  snapshotFromSeries,
  type ChartDataUpdateEvent,
} from "../../../core/dataUpdateEvent.js";
import type { ChartDataPipelineServices, PipelineIntegrityReporter } from "../ChartDataPipelinePorts.js";
import {
  DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT,
  DEFAULT_LIVE_TRADE_FLUSH_BUDGET_MS,
  liveTradeFlushBudgetExpired,
  nextLiveTradeFlushBatchSize,
  nextLiveTradeSubBatchSize,
} from "../liveTradeFlushBudget.js";
import type { ExplicitHistoryReconcileState } from "./historyLoad.js";

export const PENDING_TRADE_BUFFER_CAP = 10_000;
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

export interface TradeFlushScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
  /** True while requested turns may be held back indefinitely (a hidden page's throttled timers). */
  isThrottled?(): boolean;
}

export function defaultTradeFlushScheduler(): TradeFlushScheduler {
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

export interface LiveTradeQueueHost {
  readonly services: Pick<ChartDataPipelineServices, "subscribeToTrades">;
  readonly integrityReporter?: PipelineIntegrityReporter;
  readonly onDataDegraded?: (degraded: boolean, detail: string) => void;
  isDisposed(): boolean;
  getMarket(): string;
  getIntervalMs(): number;
  getGeneration(): number;
  isBlockingMaintenance(): boolean;
  recordRecentRepairTrade(trade: AggTrade): boolean;
  handleRepairTrade(trade: AggTrade): void;
  getExplicitHistoryReconcile(): ExplicitHistoryReconcileState | null;
  shouldDeferExplicitHistoryTrade(state: ExplicitHistoryReconcileState, trade: AggTrade): boolean;
  abortExplicitHistoryOverflow(): void;
  cancelRecentFootprintCoverageRepair(): void;
  recoverDataLoss(dropped: AggTrade[]): void;
  markTradeAppliedForRepairs(trade: AggTrade): void;
  recordLastAppliedTradeTime(time: number): void;
  emitBarClose(closed: FootprintBar): void;
  emitUpdateEvent(event: ChartDataUpdateEvent): void;
}

export class LiveTradeQueueCoordinator {
  private readonly series: FootprintSeries;
  private readonly scheduler: TradeFlushScheduler;
  private unsubscribe: (() => void) | null = null;
  private subscribedMarket: string | null = null;
  paused = false;
  private lastBarStart = -1;
  pendingTrades: AggTrade[] = [];
  private flushScheduled = false;
  private flushHandle: number | null = null;
  pendingTradeOverloaded = false;
  pendingTradeDataLoss = false;
  /** Held trade identity conflict, valid until the series is next reset (see `conflictHeld`). */
  private identityConflict: { detail: string; seriesEpoch: number } | null = null;

  constructor(
    private readonly host: LiveTradeQueueHost,
    series: FootprintSeries,
    scheduler: TradeFlushScheduler,
  ) {
    this.series = series;
    this.scheduler = scheduler;
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
    this.ensureDesiredSubscription();
    if (this.pendingTrades.length > 0) this._scheduleFlush();
  }

  resetOnConfigOrStepChange(): void {
    this._cancelFlush();
    this.pendingTrades = [];
    this.pendingTradeOverloaded = false;
    this.pendingTradeDataLoss = false;
    this.lastBarStart = -1;
    this.identityConflict = null;
  }

  markReconciled(): void {
    this.pendingTradeDataLoss = false;
    this.pendingTradeOverloaded = false;
  }

  dispose(): void {
    this._cancelFlush();
    this.pendingTrades = [];
    this.pendingTradeOverloaded = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribedMarket = null;
  }

  ensureDesiredSubscription(): void {
    if (this.host.isDisposed() || this.subscribedMarket === this.host.getMarket()) return;
    this._resubscribe();
  }

  private _resubscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribedMarket = null;
    this.subscribe();
  }

  subscribe(): void {
    this.unsubscribe?.();
    const market = this.host.getMarket();
    this.unsubscribe = this.host.services.subscribeToTrades(market, (trade: AggTrade) => {
      if (this.host.isDisposed() || this.paused) return;
      if (trade.market !== undefined && trade.market !== market) return;
      if (this.host.recordRecentRepairTrade(trade)) {
        if (!this._enqueuePendingTrade(trade)) this._scheduleFlush();
        return;
      }
      this.host.handleRepairTrade(trade);
      const explicit = this.host.getExplicitHistoryReconcile();
      const bucket = bucketStart(trade.time, this.host.getIntervalMs());
      const historyOwnsTrade = explicit && explicit.generation === this.host.getGeneration()
        && bucket >= explicit.requestedFrom && bucket < explicit.bootstrapFrom;
      if (historyOwnsTrade) {
        if (explicit.trades.length >= PENDING_TRADE_BUFFER_CAP) {
          this.host.abortExplicitHistoryOverflow();
        } else {
          explicit.trades.push(trade);
          explicit.liveAfterBarrier.add(trade);
          if (this.host.shouldDeferExplicitHistoryTrade(explicit, trade)) {
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

  _enqueuePendingTrade(trade: AggTrade): boolean {
    if (!this.scheduler.isThrottled?.() && this.pendingTrades.length < PENDING_TRADE_BUFFER_CAP - 1) {
      this.pendingTrades.push(trade);
      return false;
    }
    return this._enqueuePendingTrades([trade]);
  }

  _enqueuePendingTrades(trades: readonly AggTrade[]): boolean {
    if (trades.length === 0) return false;
    if (this.scheduler.isThrottled?.()) this._drainThrottledQueue(trades.length);
    const available = Math.max(0, PENDING_TRADE_BUFFER_CAP - this.pendingTrades.length);
    const accepted = Math.min(available, trades.length);
    if (accepted > 0) this.pendingTrades.push(...trades.slice(0, accepted));
    const dropped = trades.length - accepted;
    if (this.pendingTrades.length < PENDING_TRADE_BUFFER_CAP && dropped === 0) return false;
    incrementPerformanceCounter("pipeline.flush.overflow");
    this.pendingTradeOverloaded = true;
    this.host.integrityReporter?.report("pending", "PENDING_TRADE_BUFFER_OVERFLOW");
    if (dropped > 0) {
      this.pendingTradeDataLoss = true;
      incrementPerformanceCounter("pipeline.flush.overflow_dropped");
      this.host.onDataDegraded?.(true, "PENDING_TRADE_BUFFER_OVERFLOW: " + dropped + " live trade(s) require resync");
      this.host.cancelRecentFootprintCoverageRepair();
      this.host.recoverDataLoss(trades.slice(accepted));
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

  _scheduleFlush(): void {
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

  _cancelFlush(): void {
    if (this.flushHandle !== null) this.scheduler.cancel(this.flushHandle);
    this.flushHandle = null;
    this.flushScheduled = false;
  }

  _flushTrades(
    limit = nextLiveTradeFlushBatchSize(this.pendingTrades.length),
    budgetMs = DEFAULT_LIVE_TRADE_FLUSH_BUDGET_MS,
  ): void {
    if (this.host.isDisposed() || this.paused || this.pendingTrades.length === 0) return;
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
      for (const trade of batch) {
        this.host.markTradeAppliedForRepairs(trade);
        this.host.recordLastAppliedTradeTime(trade.time);
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
              if (closed) this.host.emitBarClose(closed);
            }
          }
          this.lastBarStart = newest.startTime;
        }
      }
      const next = measurePerformance("pipeline.snapshot", () => snapshotFromSeries(this.series));
      measurePerformance("pipeline.dispatch", () => {
        this.host.emitUpdateEvent(makeDataUpdateEvent(classifyLiveTradeUpdate(previous, next), "live", previous, next));
      });
    }
    recordPerformanceDuration("pipeline.flush", performance.now() - flushStartedAt);
    if (this.pendingTradeOverloaded && this.pendingTrades.length < PENDING_TRADE_BUFFER_CAP && !this.pendingTradeDataLoss) {
      this.pendingTradeOverloaded = false;
      incrementPerformanceCounter("pipeline.flush.overflow_recovered");
      if (!this.host.isBlockingMaintenance()) this.host.integrityReporter?.report("healthy");
    }
    this.reportIdentityConflicts(this.series.identityConflictCount - previousIdentityConflicts);
  }

  /** A held conflict is released by any series reset, including an asynchronous price-step correction. */
  conflictHeld(): boolean {
    return this.identityConflict !== null && this.identityConflict.seriesEpoch === this.series.resetEpoch;
  }

  /** The first delivery stays applied; the stream contradicted itself, so stop calling it healthy. */
  reportIdentityConflicts(count: number): void {
    if (count <= 0 || this.host.isDisposed()) return;
    const detail = "TRADE_IDENTITY_CONFLICT: " + count + " live trade(s) reused an applied ID with a different payload";
    this.identityConflict = { detail, seriesEpoch: this.series.resetEpoch };
    this.host.integrityReporter?.report("error", detail);
    this.host.onDataDegraded?.(true, detail);
  }
}
