import { ChartChange, chartChangeForDataUpdate } from "../../core/render/scene/chartScene.js";
import type { ChartPanelState } from "../../core/chartPanelState.js";
import type { ChartHistoryServices } from "./ChartServicePorts.js";
import { TIMEFRAMES } from "../../core/timeframes.js";
import { bucketStart } from "../../core/time.js";
import { isFootprintSyncAllowed } from "../../core/syncAllowlist.js";
import { retainPendingTimeframeAnchor } from "../../core/historySelection.js";
import { finishLoadTrace, isLoadTraceEnabled, logLoadTrace } from "../../core/loadTrace.js";
import type { ChartDataPipeline } from "./ChartDataPipeline.js";
import type { ChartSession } from "./ChartSession.js";
import type { View } from "../../core/engine/view.js";
import { traceViewport, type TimeScaleViewportController } from "../controllers/timeScaleViewportController.js";
import { chartDataSource } from "./chartDataSource.js";
import {
  incrementPerformanceCounter,
  isPerformanceTelemetryEnabled,
  recordPerformanceDuration,
} from "../../core/performanceTelemetry.js";
import type { ReplaySnapshot } from "../replay/replayController.js";
import {
  liveRepairRetryDelayMs,
  recentCoverageRetryDelayMs,
  RECENT_COVERAGE_RETRY_DELAYS_MS,
  type LiveRepairRetryReason,
} from "./recentCoverageRetryPolicy.js";
import {
  liveBarSeedRetryDelayMs,
  shouldRetryLiveBarSeed,
  type LiveBarSeedRetryReason,
} from "./liveBarSeedRetryPolicy.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_OHLC_REFRESH_MS = 20_000;
/** Recent overlay discovery covers 48h; 36h spans the longest pre-Vision tail with slack. */
const RECENT_FOOTPRINT_RETRY_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const RECENT_FOOTPRINT_RETRY_MAX_WINDOW_MS = 31 * DAY_MS;

/** One pending attempt to seed the open bucket the history snapshot excludes. */
interface LiveBarSeedJob {
  readonly token: number;
  readonly market: string;
  readonly timeframe: string;
  readonly intervalMs: number;
  /** Bucket that was open when the seed was scheduled; the request never starts later. */
  readonly target: number;
  readonly startedAt: number;
  /** Attempts already made, which is also the index of this one's backoff. */
  readonly attempt: number;
  readonly consecutiveEmpty: number;
}

export interface ChartHistoryCapturePort {
  beginHistoryLoad(market: string, timeframe: string): number;
  settleHistoryLoad(generation: number, market: string, timeframe: string, footprintReceived: boolean): boolean;
  failHistoryLoad(generation: number, market: string, timeframe: string): boolean;
}

export interface ChartHistoryReplayPort {
  isActive(): boolean;
  getSnapshot(): ReplaySnapshot | null;
  reconfigureAfterTimeframeChange(intervalMs: number): void;
}

export interface ChartHistoryControllerHost {
  readonly pipeline: ChartDataPipeline;
  readonly session: ChartSession;
  readonly view: View;
  readonly timeViewport: TimeScaleViewportController;
  readonly svc: ChartHistoryServices;
  readonly capture: ChartHistoryCapturePort;
  readonly replay: ChartHistoryReplayPort;
  isDisposed(): boolean;
  getState(): ChartPanelState;
  autoFit(): void;
  shouldAutoFitSameBarLiveUpdate(): boolean;
  setLoading(loading: boolean): void;
  revealCandles(): void;
  /** Report whether the settled load supplied any footprint, for the status badge. */
  setFootprintAvailable(available: boolean): void;
  notifyHistorySettled(market: string, timeframe: string): void;
}

/** Backoff for re-requesting a range whose candle source failed. */
const CANDLE_GAP_RETRY_DELAYS_MS = [5_000, 20_000, 60_000] as const;

/**
 * Owns history selection generations, loading/reload lifecycle, viewport anchors,
 * candle-first reconciliation and the daily authoritative-OHLC maintenance timer.
 */
export class ChartHistoryController {
  private refreshGeneration = 0;
  /** Sequence of the newest load trusted to clear the initial loading cover. */
  private initialCoverSeq = 0;
  private pendingTimeframeCenterTime: number | null = null;
  private pendingHistoryAnchor: { time: number; x: number } | null = null;
  private liveOhlcTimer: ReturnType<typeof setInterval> | null = null;
  private liveOhlcRefreshInFlight = false;
  private liveOhlcSeedTimer: ReturnType<typeof setTimeout> | null = null;
  private liveOhlcSeedToken = 0;
  private liveOhlcSeedInFlightToken: number | null = null;
  private liveOhlcSeedAbort: AbortController | null = null;
  private loadInFlight = 0;
  private viewportLoadToken = 0;
  /** Token of the running load whose history must not move the user's viewport (background refresh). */
  private preserveViewportLoadToken: number | null = null;
  private selectionRefreshInFlight = 0;
  private tracePaintFrame: number | null = null;
  private tracePaintPending: { traceId: string; footprint: boolean; bars: number; cells: number } | null = null;
  private completedLoadTraceId: string | null = null;
  private recentCoverageRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Attempt number of the queued or running recent-coverage retry; null when none is armed. */
  private recentCoverageRetryAttempt: number | null = null;
  private recentCoverageRetryToken = 0;
  private liveRepairRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private liveRepairRetryToken = 0;
  /** What the armed retry timers will run, so a return from a hidden tab can run them now (#315). */
  private liveRepairRetryRun: (() => void) | null = null;
  private recentCoverageRetryRun: (() => void) | null = null;
  private readonly onVisibilityChange = (): void => {
    if (typeof document === "undefined" || document.visibilityState !== "visible" || this.host.isDisposed()) return;
    this.runArmedRetriesNow();
  };
  private candleGapRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private candleGapRetryToken = 0;

  constructor(private readonly host: ChartHistoryControllerHost) {
    this.host.pipeline?.setRecentCoverageRetryScheduler?.((attempt, retry, reason) => this.queueLiveRepairRetry(attempt, retry, reason));
    this.bindPipelineUpdates();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  start(): void {
    this.syncLiveOhlcRefresh();
  }

  handleSelectionChange(previous: ChartPanelState, next: ChartPanelState): void {
    const marketChanged = next.market !== previous.market;
    const timeframeChanged = next.timeframe !== previous.timeframe;

    if (marketChanged) {
      this.pendingTimeframeCenterTime = null;
    } else if (timeframeChanged && !this.host.timeViewport.followsLatest()) {
      this.pendingTimeframeCenterTime = retainPendingTimeframeAnchor(
        this.pendingTimeframeCenterTime,
        this.visibleCenterTime(),
      );
    }

    if (!marketChanged && !timeframeChanged) return;

    this.cancelRecentCoverageRetry();
    this.cancelLiveRepairRetry();
    this.cancelCandleGapRetry();
    this.cancelLiveBarOHLCSeed();
    const generation = ++this.refreshGeneration;
    // Claim the loading cover before any async work can: a tracked replacement load
    // (initial history or step reset) started meanwhile owns the cover instead, so
    // this selection's settlements must stay cover-stale, not just generation-stale.
    const coverSeq = ++this.initialCoverSeq;
    this.host.pipeline.cancelHistoryLoad();
    // Do not pause live delivery while the replacement history request is in flight.
    // ChartDataPipeline already reconciles concurrent live trades against explicit
    // history snapshots. Pausing here used to discard every trade at _subscribe()
    // and made the chart/footprint freeze while the browser title kept moving.
    this.host.setLoading(true);

    if (marketChanged) {
      this.host.view.resetPriceScale();
      this.host.session.invalidate();
    }

    const timeframe = TIMEFRAMES.find((item) => item.label === next.timeframe);
    const config = {
      market: marketChanged ? next.market : undefined,
      intervalMs: timeframe && timeframe.ms !== this.host.pipeline.intervalMs ? timeframe.ms : undefined,
    };
    const targetIntervalMs = timeframe?.ms ?? this.host.pipeline.intervalMs;

    void this.refreshData(generation, coverSeq, config, targetIntervalMs).catch((error: unknown) => {
      if (coverSeq === this.initialCoverSeq && !this.host.isDisposed() && generation === this.refreshGeneration) {
        this.host.setLoading(false);
      }
      console.error("[chart.refresh] Refresh failed", error);
    });
  }

  /**
   * Cover the chart while the very first history load runs, like a market or
   * timeframe change does, so the live open bucket is not shown alone before the
   * history arrives. A selection change made meanwhile owns the cover instead.
   */
  trackInitialHistoryLoad(load: Promise<void>): void {
    const generation = this.refreshGeneration;
    const coverSeq = ++this.initialCoverSeq;
    this.host.setLoading(true);
    const settle = (): void => {
      // A same-selection step-reset replacement load does not bump refreshGeneration;
      // only the newest tracked cover load may clear the loading flag, so a stale
      // initial settlement cannot uncover the replacement load still in flight.
      if (coverSeq !== this.initialCoverSeq) return;
      if (!this.host.isDisposed() && generation === this.refreshGeneration) this.host.setLoading(false);
    };
    void load.then(settle, settle);
  }

  async loadHistory(
    intervalMs?: number,
    options: { rebuildKlines?: boolean; preferCache?: boolean; twoPhase?: boolean; preserveViewport?: boolean } = {},
  ): Promise<void> {
    this.cancelRecentCoverageRetry();
    this.cancelCandleGapRetry();
    this.loadInFlight++;
    const viewportLoadToken = ++this.viewportLoadToken;
    this.preserveViewportLoadToken = options.preserveViewport ? viewportLoadToken : null;
    const viewportRevision = this.host.timeViewport.userViewportRevision();
    const state = this.host.getState();
    const requestedMarket = state.market;
    const requestedTimeframe = state.timeframe;
    const historyGeneration = this.host.capture.beginHistoryLoad(requestedMarket, requestedTimeframe);
    let settledForNpoc = false;

    try {
      const to = Date.now();
      const resolvedIntervalMs = intervalMs
        ?? TIMEFRAMES.find((item) => item.label === this.host.getState().timeframe)?.ms
        ?? this.host.pipeline.intervalMs;
      const from = Math.max(
        0,
        bucketStart(
          Math.max(0, to - resolvedIntervalMs * chartDataSource().initialHistoryBars),
          resolvedIntervalMs,
        ),
      );

      this.host.svc.notifyActiveMarket(this.host.getState().market, this.host.pipeline.series.config.priceStep);
      const historyPromise = this.host.pipeline.loadHistory({
        from,
        to,
        rebuildKlines: options.rebuildKlines ?? false,
        preferCache: options.preferCache,
        twoPhase: options.twoPhase,
      });
      this.scheduleLiveBarOHLCSeed(requestedMarket, requestedTimeframe, resolvedIntervalMs);
      logLoadTrace(this.host.pipeline.activeHistoryTraceId, "live_ohlc_seed.started", { market: requestedMarket, intervalMs: resolvedIntervalMs });
      await historyPromise;

      if (this.host.isDisposed()) return;
      if (!this.host.capture.settleHistoryLoad(
        historyGeneration,
        requestedMarket,
        requestedTimeframe,
        this.host.pipeline.activeHistoryFootprintReceived,
      )) return;

      const footprintReceived = this.host.pipeline.activeHistoryFootprintReceived;
      const footprintSupported = isFootprintSyncAllowed(requestedMarket);
      this.host.setFootprintAvailable(footprintReceived);
      if (footprintSupported && this.host.pipeline.activeHistoryFootprintAvailable && !this.host.pipeline.activeHistoryFootprintCoverageComplete) {
        this.host.svc.triggerAutoSync(requestedMarket, this.host.pipeline.series.config.priceStep);
        this.scheduleRecentCoverageRetry(requestedMarket, requestedTimeframe, resolvedIntervalMs);
      }
      this.scheduleCandleGapRetry(requestedMarket, requestedTimeframe, resolvedIntervalMs, 0);
      this.host.svc.notifyInteractiveHistorySettled(
        requestedMarket,
        this.host.pipeline.series.config.priceStep,
        footprintReceived,
      );
      this.host.svc.updateAnalysisFromSeries(
        this.host.getState().market,
        this.host.pipeline.series,
        this.host.pipeline.series.config.priceStep,
      );

      const series = this.host.pipeline.series;
      if (series.length > 0) {
        // A background refresh, or a load the user panned/zoomed during, keeps their
        // viewport; only an untouched load re-places the latest bar.
        if (options.preserveViewport || this.host.timeViewport.userViewportRevision() !== viewportRevision) {
          this.host.timeViewport.keepViewportAfterHistoryLoad(series.length);
        } else {
          this.host.timeViewport.placeLatestAfterDataReset(series.length);
        }
        // Guarded history-completion readiness (Settings/250): a settled history
        // shorter than the 250-column target still fits its actual N once. The
        // settle guard above already pinned this load's generation/selection, so
        // a stale or disposed load cannot fit a newer chart generation.
        this.host.timeViewport.completeInitialHistoryFit(series.length);
        if (this.host.view.area.width > 1) {
          this.host.autoFit();
          this.host.session.invalidate(ChartChange.Viewport);
        }
      }
      settledForNpoc = true;
    } catch (error) {
      if (!this.host.isDisposed()) {
        this.host.capture.failHistoryLoad(historyGeneration, requestedMarket, requestedTimeframe);
      }
      throw error;
    } finally {
      if (this.preserveViewportLoadToken === viewportLoadToken) this.preserveViewportLoadToken = null;
      this.loadInFlight = Math.max(0, this.loadInFlight - 1);
      if (settledForNpoc && this.loadInFlight === 0 && this.selectionRefreshInFlight === 0) {
        this.host.notifyHistorySettled(requestedMarket, requestedTimeframe);
      }
    }
  }

  refreshHistory(rebuildKlines = true, options: { preserveViewport?: boolean } = {}): Promise<void> {
    return this.loadHistory(undefined, {
      rebuildKlines,
      preferCache: !rebuildKlines,
      preserveViewport: options.preserveViewport,
    });
  }

  cancelMaintenanceRefresh(): void {
    this.host.pipeline.cancelLiveBarOHLCRefresh();
  }

  clearPendingTimeframeAnchor(): void {
    this.pendingTimeframeCenterTime = null;
  }

  async focusTradingDay(dayStart: number): Promise<void> {
    // Replay owns the series; a day focus would overwrite the replayed prefix.
    if (this.host.isDisposed() || this.host.replay.isActive()) return;
    const dayMs = 24 * 60 * 60 * 1000;
    const generation = this.refreshGeneration;
    const { market, timeframe } = this.host.getState();
    // This load supersedes any background refresh; it positions the viewport itself.
    this.preserveViewportLoadToken = null;
    await this.host.pipeline.loadHistory({ from: dayStart, to: dayStart + dayMs - 1 });
    if (this.host.isDisposed() || this.host.replay.isActive() || generation !== this.refreshGeneration) return;
    const state = this.host.getState();
    if (state.market !== market || state.timeframe !== timeframe) return;
    this.host.svc.updateAnalysisFromSeries(
      this.host.getState().market,
      this.host.pipeline.series,
      this.host.pipeline.series.config.priceStep,
    );
    const series = this.host.pipeline.series;
    if (series.length > 0) {
      this.host.timeViewport.placeFocusedRangeEnd(series.length);
      this.host.autoFit();
      this.host.session.invalidate(ChartChange.Viewport);
    }
  }

  refreshDay(dayTs: number): void {
    if (this.host.isDisposed()) return;
    void this.host.pipeline.patchDay(dayTs).then(() => {
      if (this.host.isDisposed()) return;
      this.host.svc.updateAnalysisFromSeries(
        this.host.getState().market,
        this.host.pipeline.series,
        this.host.pipeline.series.config.priceStep,
      );
      this.host.session.invalidate();
    }).catch((error: unknown) => {
      console.warn("[chart.history] day patch failed", error);
    });
  }

  dispose(): void {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.host.pipeline.setRecentCoverageRetryScheduler(null);
    this.cancelRecentCoverageRetry();
    this.cancelLiveRepairRetry();
    this.cancelCandleGapRetry();
    this.cancelLiveBarOHLCSeed();
    if (this.tracePaintFrame !== null) cancelAnimationFrame(this.tracePaintFrame);
    this.tracePaintFrame = null;
    this.tracePaintPending = null;
    if (this.liveOhlcTimer !== null) clearInterval(this.liveOhlcTimer);
    this.liveOhlcTimer = null;
    this.pendingHistoryAnchor = null;
    this.pendingTimeframeCenterTime = null;
  }

  private cancelRecentCoverageRetry(): void {
    this.recentCoverageRetryToken++;
    if (this.recentCoverageRetryTimer !== null) clearTimeout(this.recentCoverageRetryTimer);
    this.recentCoverageRetryTimer = null;
    this.recentCoverageRetryRun = null;
    this.recentCoverageRetryAttempt = null;
    this.host.pipeline.cancelRecentFootprintCoverageRepair();
  }

  private cancelCandleGapRetry(): void {
    this.candleGapRetryToken++;
    if (this.candleGapRetryTimer !== null) clearTimeout(this.candleGapRetryTimer);
    this.candleGapRetryTimer = null;
  }

  /**
   * The last load's candle source failed for part of its range (the chart kept what it had there).
   * Ask for just that range again, a few times with backoff, while the selection stays the same.
   */
  private scheduleCandleGapRetry(market: string, timeframe: string, intervalMs: number, attempt: number): void {
    const gap = this.host.pipeline.activeHistoryCandleSourceGap;
    if (!gap || attempt >= CANDLE_GAP_RETRY_DELAYS_MS.length) return;
    if (this.candleGapRetryTimer !== null) clearTimeout(this.candleGapRetryTimer);
    const token = ++this.candleGapRetryToken;
    this.candleGapRetryTimer = setTimeout(() => {
      this.candleGapRetryTimer = null;
      void this.runCandleGapRetry(token, gap, market, timeframe, intervalMs, attempt).catch((error: unknown) => {
        console.warn("[chart.history] candle gap retry failed", error);
      });
    }, CANDLE_GAP_RETRY_DELAYS_MS[attempt]);
  }

  private async runCandleGapRetry(
    token: number,
    gap: { from: number; to: number },
    market: string,
    timeframe: string,
    intervalMs: number,
    attempt: number,
  ): Promise<void> {
    if (token !== this.candleGapRetryToken || this.host.isDisposed()) return;
    const state = this.host.getState();
    if (state.market !== market || state.timeframe !== timeframe || this.host.pipeline.intervalMs !== intervalMs) return;
    if (this.host.replay.isActive() || this.loadInFlight > 0) {
      this.scheduleCandleGapRetry(market, timeframe, intervalMs, attempt);
      return;
    }
    await this.host.pipeline.loadHistory({ from: gap.from, to: gap.to - 1 });
    if (token !== this.candleGapRetryToken || this.host.isDisposed()) return;
    this.host.svc.updateAnalysisFromSeries(market, this.host.pipeline.series, this.host.pipeline.series.config.priceStep);
    this.host.session.invalidate(ChartChange.DataNonTail);
    this.scheduleCandleGapRetry(market, timeframe, intervalMs, attempt + 1);
  }

  private cancelLiveRepairRetry(): void {
    this.liveRepairRetryToken++;
    if (this.liveRepairRetryTimer !== null) clearTimeout(this.liveRepairRetryTimer);
    this.liveRepairRetryTimer = null;
    this.liveRepairRetryRun = null;
  }

  /**
   * A hidden tab's timers fire late (Chromium: about once a minute after 5 minutes hidden) and
   * the retry ladder grows meanwhile, so a chart shown again could wait up to a minute for a
   * repair that is already due. Run each armed retry now instead, at its current attempt; the
   * runs keep their own token and disposal checks.
   */
  private runArmedRetriesNow(): void {
    const liveRepair = this.liveRepairRetryRun;
    if (liveRepair && this.liveRepairRetryTimer !== null) {
      clearTimeout(this.liveRepairRetryTimer);
      liveRepair();
    }
    const recentCoverage = this.recentCoverageRetryRun;
    if (recentCoverage && this.recentCoverageRetryTimer !== null) {
      clearTimeout(this.recentCoverageRetryTimer);
      recentCoverage();
    }
  }

  private scheduleRecentCoverageRetry(market: string, timeframe: string, intervalMs: number): void {
    this.cancelRecentCoverageRetry();
    const token = this.recentCoverageRetryToken;
    this.queueRecentCoverageRetry(token, market, timeframe, intervalMs, 0);
  }

  private queueLiveRepairRetry(attempt: number, retry: () => boolean, reason: LiveRepairRetryReason): void {
    const token = this.liveRepairRetryToken;
    if (this.liveRepairRetryTimer !== null) clearTimeout(this.liveRepairRetryTimer);
    const delay = liveRepairRetryDelayMs(attempt, reason);
    const run = (): void => {
      this.liveRepairRetryTimer = null;
      if (this.liveRepairRetryRun === run) this.liveRepairRetryRun = null;
      if (token !== this.liveRepairRetryToken || this.host.isDisposed()) return;
      // Replay pauses live data; keep the repair armed so it runs once replay ends.
      if (this.host.replay.isActive()) {
        this.queueLiveRepairRetry(attempt, retry, reason);
        return;
      }
      retry();
    };
    this.liveRepairRetryRun = run;
    this.liveRepairRetryTimer = setTimeout(run, delay);
  }

  /**
   * The recent footprint window is still being completed: a retry is armed within its
   * fast schedule. Past that schedule the retries continue at a steady pace, but the
   * footprint then reads as incomplete rather than "completing" indefinitely.
   */
  get recentCoverageRetryPending(): boolean {
    return this.recentCoverageRetryAttempt !== null && this.recentCoverageRetryAttempt < RECENT_COVERAGE_RETRY_DELAYS_MS.length;
  }

  private queueRecentCoverageRetry(
    token: number,
    market: string,
    timeframe: string,
    intervalMs: number,
    attempt: number,
  ): void {
    if (token !== this.recentCoverageRetryToken) return;
    const delay = recentCoverageRetryDelayMs(attempt);
    this.recentCoverageRetryAttempt = attempt;
    const run = (): void => {
      this.recentCoverageRetryTimer = null;
      if (this.recentCoverageRetryRun === run) this.recentCoverageRetryRun = null;
      void this.runRecentCoverageRetry(token, market, timeframe, intervalMs).then((outcome) => {
        if (token !== this.recentCoverageRetryToken) return;
        if (outcome === "retry") this.queueRecentCoverageRetry(token, market, timeframe, intervalMs, attempt + 1);
        // Hidden: nothing was tried, so the ladder does not advance; the return to visible runs it.
        else if (outcome === "hidden") this.queueRecentCoverageRetry(token, market, timeframe, intervalMs, attempt);
        else this.recentCoverageRetryAttempt = null;
      });
    };
    this.recentCoverageRetryRun = run;
    this.recentCoverageRetryTimer = setTimeout(run, delay);
  }

  private async runRecentCoverageRetry(
    token: number,
    market: string,
    timeframe: string,
    intervalMs: number,
  ): Promise<"complete" | "retry" | "hidden" | "stop"> {
    if (token !== this.recentCoverageRetryToken || this.host.isDisposed() || this.host.replay.isActive()) return "stop";
    const state = this.host.getState();
    if (state.market !== market || state.timeframe !== timeframe || this.host.pipeline.intervalMs !== intervalMs) return "stop";
    if (this.loadInFlight > 0) return "retry";
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return "hidden";

    const cutoff = Date.now();
    const from = Math.max(0, bucketStart(Math.max(0, cutoff - RECENT_FOOTPRINT_RETRY_LOOKBACK_MS), intervalMs));
    if (cutoff - from > RECENT_FOOTPRINT_RETRY_MAX_WINDOW_MS) return "stop";

    const outcome = await this.host.pipeline.repairRecentFootprintCoverage(from, cutoff);
    if (token !== this.recentCoverageRetryToken || this.host.isDisposed()) return "stop";
    const current = this.host.getState();
    if (current.market !== market || current.timeframe !== timeframe || this.host.pipeline.intervalMs !== intervalMs) return "stop";
    if (outcome !== "complete") return outcome;

    this.host.setFootprintAvailable(true);
    this.host.svc.notifyInteractiveHistorySettled(
      market,
      this.host.pipeline.series.config.priceStep,
      this.host.pipeline.activeHistoryFootprintReceived,
    );
    this.host.svc.updateAnalysisFromSeries(
      market,
      this.host.pipeline.series,
      this.host.pipeline.series.config.priceStep,
    );
    return "complete";
  }

  private bindPipelineUpdates(): void {
    const { pipeline, view } = this.host;
    const series = pipeline.series;

    pipeline.onBeforeUpdate = (kind) => {
      const anchored = kind === "history-patched" || (kind === "history-loaded" && this.preserveViewportLoadToken !== null);
      if (!anchored || series.length === 0 || this.host.timeViewport.followsLatest()) {
        this.pendingHistoryAnchor = null;
        return;
      }
      const x = view.area.left + view.area.width / 2;
      const index = Math.max(0, Math.min(series.length - 1, Math.round(view.indexOfX(x))));
      const bar = series.at(index);
      this.pendingHistoryAnchor = bar ? { time: bar.startTime, x: view.xOfIndex(index) } : null;
    };

    pipeline.onUpdate = (event) => {
      const liveTelemetry = event.source === "live" && isPerformanceTelemetryEnabled();
      const liveStartedAt = liveTelemetry ? performance.now() : null;
      if (liveTelemetry) {
        incrementPerformanceCounter("chart.liveUpdate.count");
        incrementPerformanceCounter(`chart.liveUpdate.kind.${event.kind}`);
      }

      const preserveViewport = event.kind === "history-loaded" && this.preserveViewportLoadToken !== null;
      const viewportPlaced = this.host.timeViewport.applyDataUpdate(event, { preserveViewport });

      if (event.kind === "history-loaded" && this.pendingTimeframeCenterTime !== null) {
        const centerTime = this.pendingTimeframeCenterTime;
        this.pendingTimeframeCenterTime = null;
        this.restoreViewToTime(centerTime, this.refreshGeneration);
      }
      const liveStart = bucketStart(Date.now(), pipeline.intervalMs);
      // The open bucket alone (live seed) is not history yet; keep the cover until
      // older candles exist too, so the chart never opens on a single candle.
      const liveReady = event.source === "history" && series.length > 1 && series.get(liveStart) !== undefined;
      if (series.length > 0 && (event.kind === "history-loaded" || liveReady)) this.host.revealCandles();
      let viewportMoved = viewportPlaced;
      if ((event.kind === "history-patched" || preserveViewport) && this.restoreHistoryAnchor()) viewportMoved = true;
      let shouldAutoFit = event.kind !== "history-patched" || event.priceChanged !== false;
      if (shouldAutoFit && event.source === "live" && event.kind === "same-bar-update") {
        shouldAutoFit = this.host.shouldAutoFitSameBarLiveUpdate();
      }
      if (shouldAutoFit) {
        if (liveTelemetry) incrementPerformanceCounter("chart.liveUpdate.autoFit.request");
        this.host.autoFit();
        viewportMoved = true;
      }
      if (liveStartedAt !== null) this.host.session.markLiveUpdate(liveStartedAt);
      if (liveTelemetry) incrementPerformanceCounter("chart.liveUpdate.invalidate.request");
      const dataChange = chartChangeForDataUpdate(event.kind);
      this.host.session.invalidate(viewportMoved ? dataChange | ChartChange.Viewport : dataChange);
      if (liveStartedAt !== null) {
        recordPerformanceDuration("chart.liveUpdate.handle.ms", performance.now() - liveStartedAt);
      }
      this.traceHistoryPaint(event.source, event.kind);
    };
  }

  private async refreshData(
    generation: number,
    coverSeq: number,
    config: { market?: string; intervalMs?: number },
    targetIntervalMs?: number,
  ): Promise<void> {
    this.selectionRefreshInFlight++;
    try {
    if (this.host.isDisposed() || generation !== this.refreshGeneration) return;
    const replaySnapshot = this.host.replay.getSnapshot();
    const previousIntervalMs = this.host.pipeline.intervalMs;
    const preserveCenterTime = config.market === undefined
      && config.intervalMs !== undefined
      && config.intervalMs !== previousIntervalMs
      && !this.host.timeViewport.followsLatest()
        ? (this.pendingTimeframeCenterTime ?? this.visibleCenterTime())
        : null;

    await this.host.pipeline.changeConfig(config);
    if (this.host.isDisposed() || generation !== this.refreshGeneration) return;
    if (config.intervalMs !== undefined && config.intervalMs !== previousIntervalMs) {
      this.host.timeViewport.rescaleForIntervalChange(previousIntervalMs, config.intervalMs);
    }
    this.syncLiveOhlcRefresh();

    await this.loadHistory(targetIntervalMs, { twoPhase: true });
    // Only the newest cover owner may uncover: a tracked replacement load (step reset)
    // does not bump refreshGeneration, and a disposed host must not write cover state.
    if (coverSeq === this.initialCoverSeq && !this.host.isDisposed() && generation === this.refreshGeneration) {
      this.host.setLoading(false);
    }
    if (preserveCenterTime != null) this.restoreViewToTime(preserveCenterTime, generation);
    if (generation === this.refreshGeneration) this.pendingTimeframeCenterTime = null;
    if (replaySnapshot && this.host.replay.isActive() && config.market === undefined) {
      this.host.replay.reconfigureAfterTimeframeChange(targetIntervalMs ?? this.host.pipeline.intervalMs);
    }

    const corrected = await this.host.pipeline.pendingStepCorrection;
    if (corrected == null) return;
    if (this.host.isDisposed() || generation !== this.refreshGeneration) return;
    // The correction was already adopted through the host's managed setPriceStep (reset
    // + tracked covered replacement reload) when the pipeline resolved it; an extra
    // unmanaged reload here would duplicate that load and its HTTP epoch.
    if (preserveCenterTime != null) this.restoreViewToTime(preserveCenterTime, generation);
    if (replaySnapshot && this.host.replay.isActive() && config.market === undefined) {
      this.host.replay.reconfigureAfterTimeframeChange(targetIntervalMs ?? this.host.pipeline.intervalMs);
    }    } finally {
      this.selectionRefreshInFlight = Math.max(0, this.selectionRefreshInFlight - 1);
      if (!this.host.isDisposed() && generation === this.refreshGeneration && this.selectionRefreshInFlight === 0) {
        const state = this.host.getState();
        this.host.notifyHistorySettled(state.market, state.timeframe);
      }
    }
  }
  private visibleCenterTime(): number | null {
    const series = this.host.pipeline.series;
    if (series.length === 0) return null;
    const x = this.host.view.area.left + this.host.view.area.width / 2;
    const index = Math.max(0, Math.min(series.length - 1, this.host.view.indexOfX(x)));
    return series.timeOfIndex(index);
  }

  private restoreViewToTime(time: number, generation: number): void {
    if (this.host.isDisposed() || generation !== this.refreshGeneration) return;
    const series = this.host.pipeline.series;
    if (series.length === 0) return;
    const index = Math.max(0, Math.min(series.length - 1, Math.round(series.indexOfTime(time))));
    const centerX = this.host.view.area.left + this.host.view.area.width / 2;
    this.host.timeViewport.restoreTimeAnchor(centerX, index);
    this.host.timeViewport.markUserViewportChange(series.length);
    this.host.session.invalidate(ChartChange.Viewport);
  }

  /** Returns whether the viewport was moved back onto the pre-patch anchor. */
  private restoreHistoryAnchor(): boolean {
    const anchor = this.pendingHistoryAnchor;
    this.pendingHistoryAnchor = null;
    if (!anchor || this.host.pipeline.series.length === 0) return false;
    const index = this.host.pipeline.series.indexOfTime(anchor.time);
    this.host.timeViewport.restoreTimeAnchor(anchor.x, index);
    return true;
  }

  private cancelLiveBarOHLCSeed(): void {
    this.liveOhlcSeedToken++;
    if (this.liveOhlcSeedTimer !== null) clearTimeout(this.liveOhlcSeedTimer);
    this.liveOhlcSeedTimer = null;
    this.liveOhlcSeedAbort?.abort();
    this.liveOhlcSeedAbort = null;
  }

  private scheduleLiveBarOHLCSeed(market: string, timeframe: string, intervalMs: number): void {
    this.cancelLiveBarOHLCSeed();
    const token = this.liveOhlcSeedToken;
    // The window starts at the bucket that is open right now and the request always
    // runs to `Date.now()`, so a retry that lands after a rollover still repairs the
    // bucket this seed was scheduled for instead of abandoning it half-seeded.
    const target = bucketStart(Date.now(), intervalMs);
    void this.runLiveBarOHLCSeed({
      token, market, timeframe, intervalMs, target,
      startedAt: Date.now(), attempt: 0, consecutiveEmpty: 0,
    });
  }

  private isLiveBarOHLCSeedCurrent(job: LiveBarSeedJob): boolean {
    if (job.token !== this.liveOhlcSeedToken || this.host.isDisposed() || this.host.replay.isActive()) return false;
    const state = this.host.getState();
    return state.market === job.market
      && state.timeframe === job.timeframe
      && this.host.pipeline.intervalMs === job.intervalMs;
  }

  private async runLiveBarOHLCSeed(job: LiveBarSeedJob): Promise<void> {
    if (!this.isLiveBarOHLCSeedCurrent(job)) return;
    if (this.liveOhlcSeedInFlightToken === job.token) {
      this.queueLiveBarOHLCSeedRetry(job);
      return;
    }

    this.liveOhlcSeedInFlightToken = job.token;
    // Abort on dispose, market or timeframe change too; the data source owns the
    // single total timeout shared by direct acquisition and its gateway fallback.
    const abort = new AbortController();
    this.liveOhlcSeedAbort = abort;
    let reason: LiveBarSeedRetryReason = "failed";
    let seeded = false;
    try {
      const requestedAt = Date.now();
      const bars = await chartDataSource().fetchLiveOhlc({
        markets: [job.market],
        from: job.target,
        to: requestedAt,
        interval: job.intervalMs,
        priceStep: this.host.pipeline.series.config.priceStep,
        reference: job.market,
        rebuild: true,
        includeFootprint: false,
        signal: abort.signal,
      });
      if (!this.isLiveBarOHLCSeedCurrent(job)) return;

      const applied = this.host.pipeline.applyLiveBarSeed(bars, {
        market: job.market,
        intervalMs: job.intervalMs,
        from: job.target,
        observedAt: requestedAt,
      });
      // The open bucket is the one the history snapshot skipped; a response that only
      // carries buckets which have since closed has not finished the job.
      seeded = applied.includes(bucketStart(Date.now(), job.intervalMs));
      if (applied.length > 0) logLoadTrace(this.host.pipeline.activeHistoryTraceId, "live_ohlc_seed.applied", { buckets: applied.length });
      if (!seeded) reason = "empty";
    } catch {
      // A failed or timed-out seed stays pending and retries below; unlike the periodic
      // maintenance refresh it is never cancelled by footprint sync.
    } finally {
      if (this.liveOhlcSeedInFlightToken === job.token) this.liveOhlcSeedInFlightToken = null;
      if (this.liveOhlcSeedAbort === abort) this.liveOhlcSeedAbort = null;
      if (!seeded && this.isLiveBarOHLCSeedCurrent(job)) {
        const consecutiveEmpty = reason === "empty" ? job.consecutiveEmpty + 1 : 0;
        const liveStart = bucketStart(Date.now(), job.intervalMs);
        const retry = shouldRetryLiveBarSeed({
          reason,
          elapsedMs: Date.now() - job.startedAt,
          consecutiveEmpty,
          hasLiveBar: this.host.pipeline.series.get(liveStart) !== undefined,
        });
        if (retry) this.queueLiveBarOHLCSeedRetry({ ...job, consecutiveEmpty });
      }
    }
  }

  private queueLiveBarOHLCSeedRetry(job: LiveBarSeedJob): void {
    if (job.token !== this.liveOhlcSeedToken || this.liveOhlcSeedTimer !== null) return;
    this.liveOhlcSeedTimer = setTimeout(() => {
      this.liveOhlcSeedTimer = null;
      void this.runLiveBarOHLCSeed({ ...job, attempt: job.attempt + 1 });
    }, liveBarSeedRetryDelayMs(job.attempt));
  }

  private syncLiveOhlcRefresh(): void {
    if (this.liveOhlcTimer !== null) {
      clearInterval(this.liveOhlcTimer);
      this.liveOhlcTimer = null;
    }
    if (this.host.isDisposed() || this.host.pipeline.intervalMs < DAY_MS) return;
    this.liveOhlcTimer = setInterval(() => {
      if (this.host.isDisposed() || this.host.replay.isActive()) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (this.loadInFlight > 0 || this.host.svc.isFootprintSyncBusy?.() || this.liveOhlcRefreshInFlight) return;
      traceViewport(`tick live-ohlc-refresh tf=${this.host.getState().timeframe}`);
      this.liveOhlcRefreshInFlight = true;
      void this.host.pipeline.refreshLiveBarOHLC().finally(() => { this.liveOhlcRefreshInFlight = false; });
    }, LIVE_OHLC_REFRESH_MS);
  }

  private traceHistoryPaint(source: string, kind: string): void {
    const pipeline = this.host.pipeline;
    const series = pipeline.series;
    const traceId = pipeline.activeHistoryTraceId;
    if (!traceId || !isLoadTraceEnabled() || source !== "history") return;

    let cellCount = 0;
    for (let index = 0; index < series.length; index++) cellCount += series.at(index)?.cells.size ?? 0;
    const footprint = pipeline.activeHistoryFootprintReceived;
    this.tracePaintPending = { traceId, footprint, bars: series.length, cells: cellCount };
    if (this.tracePaintFrame !== null) return;

    logLoadTrace(traceId, footprint ? "render.footprint.scheduled" : "render.candles.scheduled", {
      kind,
      bars: series.length,
      cells: cellCount,
    });
    this.tracePaintFrame = requestAnimationFrame(() => {
      this.tracePaintFrame = null;
      const pending = this.tracePaintPending;
      this.tracePaintPending = null;
      if (this.host.isDisposed() || !pending) return;
      logLoadTrace(pending.traceId, pending.footprint ? "render.footprint.painted" : "render.candles.painted", {
        bars: pending.bars,
        cells: pending.cells,
      });
      const liveStart = bucketStart(Date.now(), pipeline.intervalMs);
      const liveBar = series.get(liveStart);
      const liveReconciled = pipeline.liveBootstrapReconciled && liveBar !== undefined;
      if (liveReconciled) logLoadTrace(pending.traceId, "render.live_reconciled.painted", { cells: liveBar.cells.size, startTime: liveStart });
      if (pending.footprint && liveReconciled && this.completedLoadTraceId !== pending.traceId) {
        this.completedLoadTraceId = pending.traceId;
        finishLoadTrace(pending.traceId, { bars: pending.bars, cells: pending.cells, liveStart });
      }
    });
  }
}
