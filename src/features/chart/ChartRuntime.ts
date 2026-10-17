/**
 * ChartRuntime — per-panel chart lifecycle facade.
 *
 * Each chart panel owns independent rendering/data collaborators. Cohesive mutable
 * state machines live behind capability controllers; ChartRuntime preserves the
 * stable product-facing API and composes those capabilities for one panel.
 */

import { hasChartAutomaticVisibility, type ChartPanelState, type ChartType, type LinkGroupColor, type TpoMode } from "../../core/chartPanelState.js";
import type { AnalysisContext, AutomaticLevelsAsOf } from "../../core/analysisContext.js";
import type { ChartAnalysisSnapshot, AnalysisSnapshotOptions } from "../../core/analysisSnapshot.js";
import type { ChartRuntimeServices } from "./ChartServicePorts.js";
import {
  constrainChartTypeForMarket,
  isFootprintSyncAllowed,
  normalizeMarket,
  persistableChartTypeForMarket,
  subscribeFootprintSupport,
} from "../../core/syncAllowlist.js";
import { ChartDataPipeline, PRICE_STEP_RESOLVE_TIMEOUT_MS } from "./ChartDataPipeline.js";
import { ChartSession } from "./ChartSession.js";
import { requestChartPanelMaximize } from "./chartPanelFocus.js";
import { ChartInputController, isDrawingMagnetEnabled, snapPriceToOhlc, type ChartInputHost } from "./ChartInputController.js";
import { captureRawSource, resolveRawCursor } from "./rawViewContract.js";
import { View } from "../../core/engine/view.js";
import { FootprintRenderer } from "../../core/render/footprintRenderer.js";
import { Overlay } from "../../core/render/overlay.js";
import type { Crosshair } from "../../core/render/overlay.js";
import { ChartChange, ChartSurfaceDirty } from "../../core/render/scene/chartScene.js";
import { TIMEFRAMES } from "../../core/timeframes.js";
import { PERIOD_INTERVAL } from "../../core/analysis/periods.js";
import type { NakedPocLevel } from "../../core/analysis/nakedPoc.js";
import { bucketEnd } from "../../core/time.js";
import type { ReplaySnapshot } from "../replay/replayController.js";
import { chartHost } from "./chartHost.js";
import { drawIndicatorPaneBackground } from "../indicators/IndicatorManager.js";
import { incrementPerformanceCounter, measurePerformance } from "../../core/performanceTelemetry.js";
import { isLoadTraceEnabled } from "../../core/loadTrace.js";
import type { IndicatorInstance } from "../indicators/types.js";
import { footprintVisiblePriceRange } from "../../core/model/footprintAutoscale.js";
import { TimeScaleViewportController } from "../controllers/timeScaleViewportController.js";
import { settings, type ChartViewConfig, type FootprintCellData, type TpoProfilePeriod, type TpoBracketSize } from "../../core/settings.js";
import { TimeScaleModel } from "../../core/model/timeScale.js";
import type { ChartCaptureReadiness } from "./captureReadiness.js";
import { evaluateChartDataState, type ChartDataState } from "./chartDataState.js";
import { getChartWebGl2Context, type NativeChartCapture } from "./nativeCapture.js";
import { ChartReplayCoordinator } from "./ChartReplayCoordinator.js";
import { ChartCaptureCoordinator } from "./ChartCaptureCoordinator.js";
import { ChartAnalysisBridge } from "./ChartAnalysisBridge.js";
import { ChartHistoryController } from "./ChartHistoryController.js";
import { ChartSyncController } from "./ChartSyncController.js";
import { ChartRenderCoordinator } from "./ChartRenderCoordinator.js";
import { ChartIndicatorController } from "./ChartIndicatorController.js";
import { buildChartAnalysisSnapshot } from "./analysisSnapshot.js";
import { decideLiveSameBarAutoFit, type LiveAutoFitSnapshot } from "./liveAutoFit.js";
import { OrderbookHeatmapOverlay } from "../orderbook/heatmapOverlay.js";
import { HeatmapGpuRenderer, type HeatmapGpuCellFrame } from "./heatmap/gpu/heatmapGpuRenderer.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { abortableDelay } from "./abortableDelay.js";
import type { ChartSurfaceModel } from "./chartSurfaceModel.js";

export interface ChartRuntime {
  updateState(next: ChartPanelState): void;
  getState(): ChartPanelState;
  getAnalysisSnapshot(options?: AnalysisSnapshotOptions): ChartAnalysisSnapshot;
  activate(): void;
  deactivate(): void;
  refreshHostLifecycle(): void;
  dispose(): void;
  onStateChange?: (next: ChartPanelState) => void;

  startReplay(): void;
  replayPlay(): void;
  replayPause(): void;
  replayStep(): void;
  replaySetSpeed(speed: number): void;
  replaySeek(time: number): void;
  replaySelectFirst(): void;
  replaySelectRandom(): void;
  exitReplay(): void;
  getReplaySnapshot(): ReplaySnapshot | null;
  onReplayState?: (snap: ReplaySnapshot | null) => void;
  subscribeReplayState(cb: (snap: ReplaySnapshot | null) => void): () => void;
  applyExternalReplay(snapshot: ReplaySnapshot | null): void;
  getDiagnostics(): { disposed: boolean; replayActive: boolean };
  invalidate(changes?: ChartChange): void;
  getNpocLevels(): readonly NakedPocLevel[];
  subscribeNpoc(listener: () => void): () => void;
  getReplayAutomaticLevels(): AutomaticLevelsAsOf | null;

  getPriceStep(): number;
  getCaptureReadiness(): ChartCaptureReadiness;
  /** OHLC correctness, footprint completeness and freshness as separate states (#314). */
  getDataState(now: number, transportOffline: boolean): ChartDataState;
  subscribeCaptureReadiness(cb: (snapshot: ChartCaptureReadiness) => void): () => void;
  captureNativePng(): Promise<NativeChartCapture>;
  setPriceStep(step: number | null): Promise<void>;
  /** `preserveViewport` keeps the user's pan/zoom (background refreshes). */
  refreshHistory(rebuildKlines?: boolean, options?: { preserveViewport?: boolean }): Promise<void>;
  cancelMaintenanceRefresh(): void;
  refreshDay(dayTs: number): void;
  focusTradingDay(dayStart: number): Promise<void>;
  resetPriceScale(): void;
  resetTimeScale(): void;
  resetAllScales(): void;
  goLatest(): void;
  togglePriceAutoScale(): boolean;
  togglePriceScaleMode(): ChartPanelState["scaleMode"];
  isPriceAutoScale(): boolean;
  isLogScale(): boolean;
  refreshAutoScale(): void;
  resetIndicatorPaneScale(paneId: string): boolean;
  toggleIndicatorPaneAutoScale(paneId: string): boolean;
  toggleIndicatorScaleModeFromControl(paneId: string): "linear" | "log" | null;
  toggleIndicatorPanes(): void;
  togglePanelMaximize(): void;

  getVisibleTimeRange(): { from: number; to: number } | null;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  subscribeVisibleRangeChange(cb: (r: { from: number; to: number }) => void): () => void;
  subscribeCrosshairMove(cb: (e: { time: number | null; price: number | null }) => void): () => void;
  subscribeTimeframeChange(cb: (tf: string) => void): () => void;
  subscribeMarketChange(cb: (market: string) => void): () => void;
  showSyncCrosshair(time: number): void;
  hideSyncCrosshair(): void;
  applyExternalTimeframe(timeframe: string): void;
  applyExternalMarket(market: string): void;
  adoptReplayClock(): void;
  setLinkGroup(color: LinkGroupColor | null): void;
  subscribeLinkGroupChange(cb: (previous: LinkGroupColor | undefined) => void): () => void;

  setChartType(type: ChartType): void;
  setCellData(mode: FootprintCellData): void;
  setTpoMode(mode: TpoMode): void;
  setTpoProfilePeriod(period: TpoProfilePeriod): void;
  setTpoBracketSize(size: TpoBracketSize): void;
  mergeTpoProfileLeft(sessionStart: number): boolean;
  undoTpoProfileMerges(sessionStarts: readonly number[]): boolean;
  listIndicators(): IndicatorInstance[];
  setIndicatorVisible(id: string, visible: boolean): void;
  removeIndicator(id: string): void;
  openIndicatorSettings(id: string): void;
}

export interface ChartMountHandle {
  dispose(): void;
  updateState(next: ChartPanelState): void;
}

class ChartRuntimeImpl implements ChartRuntime, ChartInputHost {
  state: ChartPanelState;
  readonly svc: ChartRuntimeServices;
  readonly pipeline: ChartDataPipeline;
  readonly session: ChartSession;
  readonly view: View;
  readonly overlay: Overlay;
  readonly timeViewport: TimeScaleViewportController;
  readonly panelId: string;

  private renderer: FootprintRenderer;
  private readonly indicatorController: ChartIndicatorController;
  private readonly renderCoordinator: ChartRenderCoordinator;
  private readonly panelRoot: HTMLElement;
  private _lastKnownSize: { width: number; height: number } | null = null;
  private readonly surface: ChartSurfaceModel;
  private readonly ownedElements: readonly HTMLElement[];
  private readonly _hook: HTMLElement;
  private readonly interactionCanvas: HTMLCanvasElement;
  private readonly crosshair: Crosshair;
  private disposeInput: () => void = () => undefined;
  private disposeDebugGlobals: (() => void) | null = null;
  private disposed = false;
  /** Aborted on dispose so background waits started for this chart end with it. */
  private readonly disposal = new AbortController();
  private disposeFootprintSupport: (() => void) | null = null;
  /**
   * The chart type the user (or the saved layout) asked for. `state.chartType` is what the
   * market can show right now; before the server has reported footprint support for a
   * market outside the built-in list that is a temporary candlestick, which must neither
   * be saved nor outlive the server saying footprint is allowed.
   */
  private requestedChartType: ChartType;
  private readonly orderbookHeatmap: OrderbookHeatmapOverlay | null;
  /**
   * Private, default-off prototype opt-in for GPU orderbook heatmap density.
   * Deliberately a TS-private instance field (no #, no public surface): the
   * prototype harness flips it on a live runtime instance only. While true, the
   * density cells for the SAME completed successful GPU frame are painted into
   * the Session-owned native GPU canvas and the annotation path skips them.
   */
  private heatmapTexturePrototypeEnabled = false;
  private heatmapTexturePrototypeLastEnabled: boolean | null = null;
  private heatmapGpuRenderer: HeatmapGpuRenderer | null = null;
  private heatmapGpuRendererGl: WebGL2RenderingContext | null = null;
  private heatmapGpuFailureLatched = false;
  private heatmapGpuFrame: {
    dataKey: string;
    threshold: number;
    ceiling: number;
    colWidth: number;
    offsetX: number;
    areaLeft: number;
    areaTop: number;
    areaWidth: number;
    areaHeight: number;
    priceTop: number;
    pricePerPx: number;
    priceScaleMode: string;
    seriesLength: number;
    rangeFrom: number;
    rangeTo: number;
  } | null = null;
  /**
   * Lease covering the prepared frame lists of the current completed GPU
   * claim. Held while the claim (the retained prepared references) lives;
   * dropped before an idempotent release whenever the claim is replaced,
   * fails, is disposed or the runtime goes away.
   */
  private heatmapGpuLease: { release(): void } | null = null;
  private readonly tpoMergeLeftSessionStarts = new Set<number>();
  private lastAutoFitSnapshot: LiveAutoFitSnapshot | null = null;
  private analysisSelectionGeneration = 0;
  private hostActive = true;
  /** Set once construction is done: from then on every non-interaction invalidation refreshes the test hook. */
  private hookFollowsInvalidation = false;
  /** One hook refresh per task: a burst of invalidations (wheel, pan, live tick) collapses into one write. */
  private hookUpdateQueued = false;
  private npocGeneration = 0;
  private npocController: AbortController | null = null;
  private npocMarket: string | null = null;
  private npocPending: NakedPocLevel[] | null = null;
  private npocLevels: NakedPocLevel[] = [];
  private npocHistoryReady = false;
  private readonly npocListeners = new Set<() => void>();

  private readonly replayCoordinator: ChartReplayCoordinator;
  private replayLevelsCache: {
    key: {
      market: string;
      revision: number;
      asOf: number;
      previousWeek: AnalysisContext["previousWeekStrategySettings"];
      monday: AnalysisContext["mondayRangeSettings"];
    };
    levels: AutomaticLevelsAsOf;
  } | null = null;
  private readonly captureCoordinator: ChartCaptureCoordinator;
  private readonly analysisBridge: ChartAnalysisBridge;
  private readonly historyController: ChartHistoryController;
  private readonly syncController: ChartSyncController;

  onStateChange?: (next: ChartPanelState) => void;

  constructor(
    initialState: ChartPanelState,
    services: ChartRuntimeServices,
    gpuCanvas: HTMLCanvasElement,
    annotationCanvas: HTMLCanvasElement,
    interactionCanvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    annotationCtx2d: CanvasRenderingContext2D,
    interactionCtx2d: CanvasRenderingContext2D,
    panelRoot: HTMLElement,
    surface: ChartSurfaceModel,
    pipeline: ChartDataPipeline,
    panelId: string,
    hook: HTMLElement,
  ) {
    this.requestedChartType = initialState.chartType ?? settings.chartType;
    this.state = {
      ...initialState,
      chartType: constrainChartTypeForMarket(initialState.market, this.requestedChartType),
    };
    this.svc = services;
    this.pipeline = pipeline;
    this.panelRoot = panelRoot;
    this.surface = surface;
    this.panelId = panelId;
    this._hook = hook;
    this.ownedElements = [hook, gpuCanvas, annotationCanvas, interactionCanvas];
    this.disposeFootprintSupport = subscribeFootprintSupport((market, allowed) => {
      if (market !== normalizeMarket(this.state.market)) return;
      this.enforceChartTypePolicy();
      // The server allowlisted a market whose history was read candle-only from Binance
      // (the /markets catalog can land after the first load starts): load its footprint.
      if (allowed && this.pipeline.activeHistoryCandlesOnly && !this.disposed) {
        void this.refreshHistory(false, { preserveViewport: true }).catch(() => undefined);
      }
    });

    const crosshair: Crosshair = { x: 0, y: 0, visible: false };
    this.interactionCanvas = interactionCanvas;
    this.crosshair = crosshair;
    this.view = new View();
    this.view.setScaleMode(initialState.scaleMode);
    this.timeViewport = new TimeScaleViewportController(this.view);
    this.renderer = new FootprintRenderer(gl);
    // Tracked separately from the private FootprintRenderer context so the
    // prototype can detect a context swap without touching ChartSession state.
    this.heatmapGpuRendererGl = gl;

    const series = this.pipeline.series;
    this.indicatorController = new ChartIndicatorController({
      ownerDocument: panelRoot.ownerDocument,
      root: panelRoot,
      initial: this.state.indicators,
      onChange: (instances) => {
        if (this.disposed) return;
        this.state = { ...this.state, indicators: instances };
        this.emitStateChange();
        this.renderCoordinator?.applyConfig(this.chartViewConfig());
        chartHost().indicatorsChanged();
      },
      onLayoutChange: () => this._layoutFromCurrentSize(),
      onInvalidate: (changes) => this.session.invalidate(changes),
      getChartContext: () => ({
        market: this.state.market,
        timeframe: this.state.timeframe,
        intervalMs: this.pipeline.intervalMs,
      }),
      queuePriceLabel: (price, text, color, priority) => this.overlay.queuePriceAxisLabel(price, text, color, priority),
      headers: surface.indicatorHeaders,
    });

    const fetchOrderbookHeatmap = services.fetchOrderbookHeatmap?.bind(services);
    this.orderbookHeatmap = fetchOrderbookHeatmap
      ? new OrderbookHeatmapOverlay({
        fetch: fetchOrderbookHeatmap,
        invalidate: () => {
          if (!this.disposed) this.session?.invalidate();
        },
        getMarket: () => this.state.market,
      })
      : null;

    this.overlay = new Overlay(
      annotationCtx2d,
      (ctx, activeView, activeSeries) => {
        const analysisCtx = this.analysisContextForChart();
        if (!analysisCtx.drawings) return;
        const drawingTime = {
          indexForTime: (time: number) => activeSeries.indexOfTime(time),
          timeForIndex: (index: number) => activeSeries.timeOfIndex(Math.round(index)),
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(activeView.area.left, activeView.area.top, activeView.area.width, activeView.area.height);
        ctx.clip();
        try {
          measurePerformance("chart.annotation.drawings.analysis.ms", () => {
            analysisCtx.drawings.renderAnalysis(
              ctx,
              activeView,
              activeSeries,
              drawingTime,
              (price, text, color) => this.overlay.queueLineObject(price, text, color),
              this.state.market,
            );
          });
          measurePerformance("chart.annotation.drawings.static.ms", () => {
            analysisCtx.drawings.render(
              ctx,
              activeView,
              drawingTime,
              (price, text, color) => this.overlay.queueLineObject(price, text, color),
              (time, text, color) => this.overlay.queueTimeObject(time, text, color),
              this.state.market,
            );
          });
        } finally {
          ctx.restore();
        }
      },
      () => this.analysisContextForChart().profileSettings,
      () => this.analysisContextForChart().previousWeekStrategySettings,
      () => this.analysisContextForChart().previousWeekStrategyLevels,
      () => this.analysisContextForChart().mondayRangeSettings,
      () => this.analysisContextForChart().mondayRangeLevels,
      () => this.analysisContextForChart().nakedPocs,
      () => this.analysisContextForChart().referenceLevels,
      () => this.indicatorController.getPaneRenders(),
      () => this.indicatorController.getPriceOverlayRenders(),
      () => this.syncController?.ghostCrosshairTime ?? null,
      (text) => {
        this._hook.setAttribute("data-hud", text ?? "");
        // HUD text changes on every crosshair move; coalesce the full hook rewrite.
        this._queueHookUpdate();
      },
      drawIndicatorPaneBackground,
      () => this.indicatorController.isPaneMaximized(),
      interactionCtx2d,
      (ctx, activeView, activeSeries) => {
        const drawings = this.analysisContextForChart().drawings;
        if (!drawings) return;
        const drawingTime = {
          indexForTime: (time: number) => activeSeries.indexOfTime(time),
          timeForIndex: (index: number) => activeSeries.timeOfIndex(Math.round(index)),
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(activeView.area.left, activeView.area.top, activeView.area.width, activeView.area.height);
        ctx.clip();
        try {
          drawings.renderSelection(ctx, activeView, drawingTime, this.state.market);
        } finally {
          ctx.restore();
        }
      },
      (ctx, activeView, activeSeries, range) => {
        // The GPU prototype skips canvas density ONLY for the same completed
        // successful GPU frame with identical inputs/geometry/layer key; any
        // mismatch (or legacy mode) keeps the annotation path authoritative.
        if (this.heatmapGpuSuppressedAnnotation(activeView, activeSeries, range)) return;
        this.orderbookHeatmap?.draw(ctx, activeView, activeSeries, range);
      },
      (ctx, activeView, activeSeries, activeCrosshair) =>
        this.orderbookHeatmap?.drawHover(ctx, activeView, activeSeries, activeCrosshair),
    );

    const view = this.view;
    const renderer = {
      render: (v: View, s: typeof series) => {
        if (this.timeViewport.ensurePendingLatestPlacement(s.length)) this._autoFit();
        // Reset the completed-GPU-frame claim BEFORE this attempt; the density
        // decision below owns the whole frame, never a partial GPU+annotation mix.
        this.heatmapGpuFrame = null;
        this.releaseHeatmapGpuLease();
        this.trackHeatmapPrototypeOptIn();
        if (this.indicatorController.isPaneMaximized()) this.renderer.clear();
        else {
          let heatmapFrame: HeatmapGpuCellFrame | null = null;
          try {
            heatmapFrame = this.prepareHeatmapGpuCells(v, s);
            this.renderer.renderLayers(v, s, this.renderCoordinator?.getGpuLayerIds() ?? new Set());
            // Density paints above the flushed candle layers and strictly before
            // this GPU callback returns, so the Session's immediate readPixels
            // already owns it. Hover/axes/errors stay on the annotation canvas.
            this.renderHeatmapGpuCells(heatmapFrame, v, s);
          } catch (error) {
            // The prepared lease is adopted only by a completed GPU claim
            // inside renderHeatmapGpuCells; a candle-layer throw (or any exit
            // before adoption) must drop the unadopted frame references and
            // release the idempotent lease exactly once, preserving the error.
            heatmapFrame?.preparedLease?.release();
            heatmapFrame = null;
            throw error;
          }
        }
      },
      visibleRange: (v: View, total: number) => this.renderer.visibleRange(v, total),
    };

    this.session = new ChartSession({
      container: panelRoot,
      gpuCanvas,
      annotationCanvas,
      interactionCanvas,
      ownerDocument: panelRoot.ownerDocument,
      gl,
      annotationCtx2d,
      interactionCtx2d,
      renderer,
      annotation: {
        render: (v, s, c, r) => {
          this.overlay.setTpoMergeLeftSessionStarts(this.tpoMergeLeftSessionStarts);
          this.overlay.renderAnnotations(v, s, c, r, this.renderCoordinator?.getAnnotationLayerOrder() ?? []);
        },
        requiresInteractionRedraw: () => this.indicatorController.requiresAnnotationInteractionRedraw(),
      },
      interaction: {
        render: (v, s, c, r) => {
          this.overlay.renderInteraction(
            v,
            s,
            c,
            r,
            this.renderCoordinator?.getInteractionLayerOrder() ?? [],
          );
          this.indicatorController.renderInteraction(interactionCtx2d, v, s, r, c);
        },
      },
      view,
      series,
      crosshair,
      onRestoreContext: (restoredGl) => {
        this.renderer.dispose();
        this.renderer = new FootprintRenderer(restoredGl);
        // The prototype's GPU resources belonged to the lost context; drop them
        // and let the next enabled frame rebuild against the restored GL.
        this.disposeHeatmapGpuRenderer();
        this.heatmapGpuRendererGl = restoredGl;
        // New resource epoch: a failure latch from the lost context must not
        // outlive the resources it pointed at; the next enabled frame
        // re-prepares the prototype against the restored GL.
        this.heatmapGpuFailureLatched = false;
        this.renderCoordinator.applyConfig(this.chartViewConfig());
        this.session.invalidate();
      },
      onLostContext: () => {
        // Immediate epoch invalidity: the lost context owned the completed GPU
        // claim's prepared references, its lease and the prototype's GL
        // resources. Drop the claim refs first, release the owned lease
        // exactly once and dispose the old prototype GPU owner now, instead of
        // leaving them charged until restore or dispose.
        this.disposeHeatmapGpuRenderer();
        // Fresh epoch: a failure latch from the lost context must not block the
        // next enabled frame once the context is restored.
        this.heatmapGpuFailureLatched = false;
      },
      onResize: (w, h) => {
        this._lastKnownSize = { width: w, height: h };
        this._applyLayout(w, h);
        this.timeViewport.applyResize(series.length, "resize-observer");
        if (series.length > 0) this._autoFit();
        this._maybeApplyNpoc();
      },
      onInvalidate: (changes) => {
        if (this.hookFollowsInvalidation && changes !== ChartChange.Interaction) this._queueHookUpdate();
      },
      onRendered: (surfaces) => {
        if (surfaces & ChartSurfaceDirty.Annotation) this.analysisBridge?.onAnnotationRendered();
      },
    });

    this.renderCoordinator = new ChartRenderCoordinator({
      session: this.session,
      overlay: this.overlay,
      getRenderer: () => this.renderer,
      listIndicators: () => this.indicatorController.listInstances(),
    });
    this.renderCoordinator.applyConfig(this.chartViewConfig());

    this.captureCoordinator = new ChartCaptureCoordinator({
      pipeline: this.pipeline,
      session: this.session,
      svc: this.svc,
      isDisposed: () => this.disposed,
      getMarket: () => this.state.market,
      getTimeframe: () => this.state.timeframe,
    }, initialState.market, initialState.timeframe);

    this.replayCoordinator = new ChartReplayCoordinator({
      pipeline: this.pipeline,
      session: this.session,
      timeViewport: this.timeViewport,
      svc: this.svc,
      isDisposed: () => this.disposed,
      getMarket: () => this.state.market,
      autoFit: () => this._autoFit(),
      updateHook: () => this._updateHook(),
      loadHistory: () => this.historyController.loadHistory(),
    });

    this.syncController = new ChartSyncController({
      pipeline: this.pipeline,
      session: this.session,
      view: this.view,
      timeViewport: this.timeViewport,
      isDisposed: () => this.disposed,
      getState: () => this.getState(),
      updateState: (next) => this.updateState(next),
      persistState: (next) => {
        if (next.chartType !== undefined && next.chartType !== this.state.chartType) {
          this.requestedChartType = next.chartType;
        }
        this.state = { ...next };
        this.emitStateChange();
      },
      autoFit: () => this._autoFit(),
      applyExternalReplay: (snapshot) => this.applyExternalReplay(snapshot),
      subscribeReplayState: (cb) => this.subscribeReplayState(cb),
      fillVisibleFootprintRange: (range) => {
        if (chartHost().isFootprintAutoFillEnabled()) this.pipeline.fillMissingCells(range.from, range.to);
      },
    });

    this.analysisBridge = new ChartAnalysisBridge({
      svc: this.svc,
      session: this.session,
      isDisposed: () => this.disposed,
      getMarket: () => this.state.market,
      updateHook: () => this._updateHook(),
      noteAnalysisRevision: () => this.captureCoordinator.notify(),
      noteAnalysisPaint: (market, revision) => this.captureCoordinator.noteAnalysisPaint(market, revision),
    });

    this.historyController = new ChartHistoryController({
      pipeline: this.pipeline,
      session: this.session,
      view: this.view,
      timeViewport: this.timeViewport,
      svc: this.svc,
      capture: this.captureCoordinator,
      replay: this.replayCoordinator,
      isDisposed: () => this.disposed,
      getState: () => this.getState(),
      autoFit: () => this._autoFit(),
      shouldAutoFitSameBarLiveUpdate: () => this._shouldAutoFitSameBarLiveUpdate(),
      setLoading: (loading) => this._setHistoryLoading(loading),
      revealCandles: () => this._revealHistoryCandles(),
      setFootprintAvailable: (available) => {
        this._hook.setAttribute("data-footprint-available", String(available));
      },
      notifyHistorySettled: (market, timeframe) => this._notifyNpocHistorySettled(market, timeframe),
    });

    this.hookFollowsInvalidation = true;

    pipeline.onBarClose = (closed) => {
      this.svc.notifyBarClose(this.state.market, closed, series.config.priceStep);
    };
    pipeline.onHistoryCandlesReady = () => {
      if (!this.disposed) this.svc.notifyInteractiveCandlesReady(this.state.market, series.config.priceStep);
    };

    this.bindInputController();
    chartHost().registerRuntime(panelId, this);
    this.session.activate();
    this._updateHook();
    this.historyController.start();
    this._beginNpocRequest(this.state.market);

    if (series.length > 0) {
      requestAnimationFrame(() => {
        if (this.disposed || series.length === 0) return;
        if (view.area.width <= 1 || view.area.height <= 1) return;
        this.timeViewport.placeLatestAfterDataReset(series.length);
        this._autoFit();
        this.session.invalidate(ChartChange.Viewport);
      });
    }
  }

  get onReplayState(): ((snap: ReplaySnapshot | null) => void) | undefined {
    return this.replayCoordinator.onStateChange;
  }

  set onReplayState(callback: ((snap: ReplaySnapshot | null) => void) | undefined) {
    this.replayCoordinator.onStateChange = callback;
  }

  updateState(next: ChartPanelState): void {
    if (this.disposed) return;
    const prev = this.state;
    const pairSwitched = normalizeMarket(next.market) !== normalizeMarket(prev.market);
    // Leaving a pair remembers its chart type; arriving on one restores the type saved for it,
    // unless the caller picked a type along with the pair (e.g. a layout being applied).
    if (pairSwitched) this.rememberPairChartType(prev.market, prev.chartType ?? settings.chartType);
    const carriedType = next.chartType === undefined || next.chartType === prev.chartType;
    const requestedType = (pairSwitched && carriedType ? chartHost().getPairChartType(next.market) : undefined)
      ?? next.chartType
      ?? settings.chartType;
    const constrainedNext: ChartPanelState = {
      ...next,
      chartType: constrainChartTypeForMarket(next.market, requestedType),
    };
    const marketChanged = constrainedNext.market !== prev.market;
    const timeframeChanged = constrainedNext.timeframe !== prev.timeframe;

    this.requestedChartType = requestedType;
    this.state = constrainedNext;
    if (marketChanged || timeframeChanged) {
      this.captureCoordinator.noteSelectionChange();
      this.analysisSelectionGeneration++;
    }
    if (marketChanged) {
      this.replayCoordinator.exitForMarketChange(constrainedNext.market);
      if (!this.hostActive) this.pipeline.setPaused(true);
      this.analysisBridge.resetMarket(constrainedNext.market);
      this._beginNpocRequest(constrainedNext.market);
    }

    if (constrainedNext.indicators !== prev.indicators) this.indicatorController.restore(constrainedNext.indicators);
    this.renderCoordinator.applyConfig(this.chartViewConfig());
    this.session.invalidate();

    const scaleModeChanged = constrainedNext.scaleMode !== prev.scaleMode;
    this.view.setScaleMode(constrainedNext.scaleMode);
    if (scaleModeChanged) {
      this._autoFit();
      this.session.invalidate(ChartChange.Viewport);
    }

    this.historyController.handleSelectionChange(prev, constrainedNext);
    this.emitStateChange();
    this.syncController.emitStateChanges(prev, constrainedNext);
  }

  getState(): ChartPanelState { return { ...this.state }; }

  /** The state as it should be saved: the requested chart type unless the server ruled it out. */
  getPersistableState(): ChartPanelState {
    return {
      ...this.state,
      chartType: persistableChartTypeForMarket(this.state.market, this.requestedChartType),
    };
  }

  private emitStateChange(): void {
    this.onStateChange?.(this.getPersistableState());
  }

  getAnalysisSnapshot(options: AnalysisSnapshotOptions = {}): ChartAnalysisSnapshot {
    if (this.replayCoordinator.isActive()) throw new Error("AI analysis is unavailable during replay");
    const now = options.now ?? Date.now();
    const series = this.pipeline.series;
    let closedCount = 0;
    for (let index = 0; index < series.length; index++) {
      const bar = series.at(index);
      if (!bar || bucketEnd(bar.startTime, this.pipeline.intervalMs) > now) break;
      closedCount = index + 1;
    }

    const runtimeTimeRange = options.visibleTimeRange ?? this.syncController.getVisibleTimeRange() ?? undefined;
    const priceRange = this.view.area.height > 1 ? this.view.priceRange() : null;
    const runtimePriceRange = options.visiblePriceRange ?? (priceRange ? {
      low: priceRange.minValue(),
      high: priceRange.maxValue(),
    } : undefined);

    let analysisRange: [number, number] = [Math.max(0, closedCount - 100), closedCount];
    if (runtimeTimeRange && closedCount > 0) {
      const fromTime = Math.min(runtimeTimeRange.from, runtimeTimeRange.to);
      const toTime = Math.max(runtimeTimeRange.from, runtimeTimeRange.to);
      const fromIndex = Math.max(0, Math.min(closedCount, Math.floor(series.indexOfTime(fromTime))));
      const toIndex = Math.max(fromIndex, Math.min(closedCount, Math.ceil(series.indexOfTime(toTime)) + 1));
      if (toIndex > fromIndex) analysisRange = [fromIndex, toIndex];
    }
    const visibleSampleCount = Math.max(1, analysisRange[1] - analysisRange[0]);
    const indicators = this.indicatorController.getAnalysisSnapshots(
      series,
      analysisRange,
      options.maxIndicatorSamples ?? visibleSampleCount,
    );
    return buildChartAnalysisSnapshot({
      panelId: this.panelId,
      market: this.state.market,
      timeframe: this.state.timeframe,
      intervalMs: this.pipeline.intervalMs,
      selectionGeneration: this.analysisSelectionGeneration,
      series,
      analysis: this.analysisContextForChart(),
      analysisRevision: this.svc.getAnalysisRevisionSnapshot(this.state.market),
      indicators,
      options: {
        ...options,
        now,
        ...(runtimeTimeRange ? { visibleTimeRange: runtimeTimeRange } : {}),
        ...(runtimePriceRange ? { visiblePriceRange: runtimePriceRange } : {}),
      },
    });
  }

  activate(): void {
    this.hostActive = true;
    this.session.activate();
    if (!this.replayCoordinator.isActive() && !this.replayCoordinator.isSelecting()) {
      this.pipeline.setPaused(false);
    }
  }
  deactivate(): void {
    this.hostActive = false;
    this.pipeline.setPaused(true);
    this.session.deactivate();
  }

  getVisibleTimeRange(): { from: number; to: number } | null {
    return this.syncController.getVisibleTimeRange();
  }
  setVisibleTimeRange(range: { from: number; to: number }): void { this.syncController.setVisibleTimeRange(range); }
  subscribeVisibleRangeChange(cb: (r: { from: number; to: number }) => void): () => void {
    return this.syncController.subscribeVisibleRange(cb);
  }
  subscribeCrosshairMove(cb: (e: { time: number | null; price: number | null }) => void): () => void {
    return this.syncController.subscribeCrosshair(cb);
  }
  subscribeTimeframeChange(cb: (tf: string) => void): () => void { return this.syncController.subscribeTimeframe(cb); }
  subscribeMarketChange(cb: (market: string) => void): () => void { return this.syncController.subscribeMarket(cb); }
  subscribeReplayState(cb: (snap: ReplaySnapshot | null) => void): () => void { return this.replayCoordinator.subscribe(cb); }
  applyExternalReplay(snapshot: ReplaySnapshot | null): void {
    this.replayCoordinator.applyExternal(snapshot);
    this.pipeline.setPaused(snapshot !== null || !this.hostActive);
  }
  adoptReplayClock(): void { this.replayCoordinator.adoptClock(); }
  showSyncCrosshair(time: number): void { this.syncController.showCrosshair(time); }
  hideSyncCrosshair(): void { this.syncController.hideCrosshair(); }
  applyExternalTimeframe(timeframe: string): void { this.syncController.applyExternalTimeframe(timeframe); }
  applyExternalMarket(market: string): void { this.syncController.applyExternalMarket(market); }
  setLinkGroup(color: LinkGroupColor | null): void { this.syncController.setLinkGroup(color); }
  subscribeLinkGroupChange(cb: (previous: LinkGroupColor | undefined) => void): () => void {
    return this.syncController.subscribeLinkGroup(cb);
  }

  private _beginNpocRequest(market: string): void {
    const generation = ++this.npocGeneration;
    this.npocController?.abort();
    const controller = new AbortController();
    this.npocController = controller;
    this.npocMarket = market;
    this.npocPending = null;
    this.npocLevels = [];
    this.npocHistoryReady = false;
    this._notifyNpocListeners();
    this.session?.invalidate();

    void this.svc.fetchNpocSnapshot(market, controller.signal).then((response) => {
      if (
        this.disposed
        || controller.signal.aborted
        || generation !== this.npocGeneration
        || market !== this.state.market
      ) return;
      this.npocPending = response.levels.map((level) => ({
        id: `${market}|${level.period}|${level.periodStart}`,
        market,
        period: level.period,
        periodStart: level.periodStart,
        periodEnd: bucketEnd(level.periodStart, PERIOD_INTERVAL[level.period]),
        price: level.pocLower,
        age: level.age,
        complete: true as const,
      }));
      this._updateHook();
      this._maybeApplyNpoc();
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== this.npocGeneration) return;
      console.warn("[chart.npoc] snapshot unavailable", error);
    });
  }

  private _notifyNpocHistorySettled(market: string, timeframe: string): void {
    if (market !== this.state.market || timeframe !== this.state.timeframe) return;
    this.npocHistoryReady = true;
    this._maybeApplyNpoc();
  }

  private _maybeApplyNpoc(): void {
    if (
      this.disposed
      || !this.npocHistoryReady
      || this.npocPending === null
      || this.npocMarket !== this.state.market
      || this.pipeline.series.length === 0
      || this.view.area.width <= 1
      || this.view.area.height <= 1
      || this.view.priceRange() === null
    ) return;
    this.npocLevels = this.npocPending;
    this.npocPending = null;
    this._notifyNpocListeners();
    this.session.invalidate();
  }

  /** nPOC has no historical state, so a replaying chart shows none. */
  getNpocLevels(): readonly NakedPocLevel[] {
    if (this.replayCoordinator.isActive()) return [];
    return this.npocMarket === this.state.market ? this.npocLevels : [];
  }

  subscribeNpoc(listener: () => void): () => void {
    this.npocListeners.add(listener);
    return () => this.npocListeners.delete(listener);
  }

  private _notifyNpocListeners(): void {
    for (const listener of this.npocListeners) listener();
  }

  private automaticLevelsAsOf(market: string, asOf: number, context: AnalysisContext): AutomaticLevelsAsOf {
    // analysisContextForChart runs several times per frame; recompute only when the market,
    // its analysis revision, the level settings or the replay time change.
    const revision = this.svc.getAnalysisRevisionSnapshot(market).revision;
    const key = {
      market,
      revision,
      asOf,
      previousWeek: context.previousWeekStrategySettings,
      monday: context.mondayRangeSettings,
    };
    const cached = this.replayLevelsCache;
    if (cached && (Object.keys(key) as (keyof typeof key)[]).every((name) => cached.key[name] === key[name])) {
      return cached.levels;
    }
    const levels = this.svc.getAutomaticLevelsAsOf?.(market, asOf)
      ?? { previousWeekStrategyLevels: [], mondayRangeLevels: [], referenceLevels: [] };
    this.replayLevelsCache = { key, levels };
    return levels;
  }

  /** The automatic levels this chart draws while it replays, as of its replay time; null when live. */
  getReplayAutomaticLevels(): AutomaticLevelsAsOf | null {
    return this.replayAutomaticLevels(this.svc.getAnalysisContext(this.state.market, true));
  }

  private replayAutomaticLevels(context: AnalysisContext): AutomaticLevelsAsOf | null {
    const replayTime = this.replayCoordinator.isActive() ? this.replayCoordinator.getSnapshot()?.virtualTime : undefined;
    return replayTime === undefined ? null : this.automaticLevelsAsOf(this.state.market, replayTime, context);
  }

  private analysisContextForChart(): AnalysisContext {
    const serviceRaw = this.svc.getAnalysisContext(this.state.market, true);
    // The market context is computed up to now and shared with live charts, so a replaying
    // chart takes its own levels as of the replay time. nPOC has no historical state: hidden.
    const replayLevels = this.replayAutomaticLevels(serviceRaw);
    const raw: AnalysisContext = replayLevels === null
      ? { ...serviceRaw, nakedPocs: this.npocMarket === this.state.market ? this.npocLevels : [] }
      : { ...serviceRaw, ...replayLevels, nakedPocs: [] };
    if (!hasChartAutomaticVisibility(this.state)) {
      return raw;
    }
    const previousWeekStrategySettings = {
      ...raw.previousWeekStrategySettings,
      visible: {
        ...raw.previousWeekStrategySettings.visible,
        ...(this.state.previousWeekStrategyVisibility ?? {}),
      },
    };
    const mondayRangeSettings = {
      ...raw.mondayRangeSettings,
      visible: {
        ...raw.mondayRangeSettings.visible,
        ...(this.state.mondayRangeVisibility ?? {}),
      },
    };
    const hiddenNakedPocIds = new Set(this.state.hiddenNakedPocIds ?? []);
    const hiddenReferenceLevelIds = new Set(this.state.hiddenReferenceLevelIds ?? []);

    return {
      ...raw,
      previousWeekStrategySettings,
      previousWeekStrategyLevels: raw.previousWeekStrategyLevels.filter(
        (level) => previousWeekStrategySettings.visible[level.id] !== false,
      ),
      mondayRangeSettings,
      mondayRangeLevels: raw.mondayRangeLevels.filter(
        (level) => mondayRangeSettings.visible[level.id] !== false,
      ),
      nakedPocs: raw.nakedPocs.filter(
        (level) => (this.state.nakedPocVisibility?.[level.period] ?? false) !== false
          && !hiddenNakedPocIds.has(level.id),
      ),
      referenceLevels: raw.referenceLevels.filter(
        (level) => (this.state.referenceVisibility?.[level.family]?.[level.period] ?? true) !== false
          && !hiddenReferenceLevelIds.has(level.id),
      ),
    };
  }

  private chartViewConfig(): ChartViewConfig {
    const s = this.state;
    return {
      chartType: constrainChartTypeForMarket(s.market, s.chartType ?? settings.chartType),
      tpoMode: s.tpoMode ?? settings.tpoMode,
      tpoProfilePeriod: s.tpoProfilePeriod ?? settings.tpoProfilePeriod,
      tpoBracketSize: s.tpoBracketSize ?? settings.tpoBracketSize,
      clusterCellData: s.clusterCellData ?? settings.clusterCellData,
      profileCellData: s.profileCellData ?? settings.profileCellData,
      candles: s.candles ?? settings.candles,
      heat: s.heat ?? settings.heat,
      cellNumbers: s.cellNumbers ?? settings.cellNumbers,
      poc: s.poc ?? settings.poc,
      stackedImbalance: s.stackedImbalance ?? settings.stackedImbalance,
    };
  }

  private applyViewState(patch: Partial<ChartPanelState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch } as ChartPanelState;
    this.renderCoordinator.applyConfig(this.chartViewConfig());
    this.emitStateChange();
    this.session.invalidate(ChartChange.Style);
  }

  private enforceChartTypePolicy(): void {
    if (this.disposed) return;
    const current = this.state.chartType ?? settings.chartType;
    // Constrain the requested type, not the current one: a candlestick forced while support
    // was unknown has to turn back into the requested footprint once the server allows it.
    const constrained = constrainChartTypeForMarket(this.state.market, this.requestedChartType);
    if (constrained !== current) this.applyViewState({ chartType: constrained });
  }

  /** Only a type the pair can actually show is saved; a forced candlestick is not a choice. */
  private rememberPairChartType(market: string, type: ChartType): void {
    if (isFootprintSyncAllowed(market)) chartHost().setPairChartType(market, type);
  }

  setChartType(type: ChartType): void {
    const constrained = constrainChartTypeForMarket(this.state.market, type);
    this.rememberPairChartType(this.state.market, constrained);
    const requestChanged = this.requestedChartType !== constrained;
    this.requestedChartType = constrained;
    if ((this.state.chartType ?? settings.chartType) !== constrained) {
      this.applyViewState({ chartType: constrained });
    } else if (requestChanged) {
      this.emitStateChange();
    }
  }
  setCellData(mode: FootprintCellData): void {
    const isProfile = (this.state.chartType ?? settings.chartType) === "footprintProfile";
    this.applyViewState(isProfile ? { profileCellData: mode } : { clusterCellData: mode });
  }
  setTpoMode(mode: TpoMode): void {
    if ((this.state.tpoMode ?? settings.tpoMode) !== mode) this.applyViewState({ tpoMode: mode });
  }
  setTpoProfilePeriod(period: TpoProfilePeriod): void {
    if ((this.state.tpoProfilePeriod ?? settings.tpoProfilePeriod) !== period) this.applyViewState({ tpoProfilePeriod: period });
  }
  setTpoBracketSize(size: TpoBracketSize): void {
    if ((this.state.tpoBracketSize ?? settings.tpoBracketSize) !== size) this.applyViewState({ tpoBracketSize: size });
  }
  mergeTpoProfileLeft(sessionStart: number): boolean {
    if (this.disposed || !Number.isFinite(sessionStart)) return false;
    const before = this.tpoMergeLeftSessionStarts.size;
    this.tpoMergeLeftSessionStarts.add(sessionStart);
    if (this.tpoMergeLeftSessionStarts.size === before) return false;
    this.session.invalidate();
    return true;
  }
  undoTpoProfileMerges(sessionStarts: readonly number[]): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (const sessionStart of sessionStarts) if (this.tpoMergeLeftSessionStarts.delete(sessionStart)) changed = true;
    if (changed) this.session.invalidate();
    return changed;
  }

  get applyingExternal(): boolean { return this.syncController.isApplyingExternal; }
  autoFit(): void { this._autoFit(); }
  emitVisibleRange(): void { this.syncController.emitVisibleRange(); }
  indexToTime(index: number): number | null { return this._indexToTime(index); }
  screenToDrawingPoint(cx: number, cy: number, temporaryMagnet = false): { time: number; price: number } {
    return this._screenToDrawingPoint(cx, cy, temporaryMagnet);
  }
  setPriceAutoScaleFromControl(autoScale: boolean): void { this._setPriceAutoScaleFromControl(autoScale); }
  togglePriceScaleModeFromControl(): ChartPanelState["scaleMode"] { return this._togglePriceScaleModeFromControl(); }
  toggleIndicatorScaleModeFromControl(paneId: string): "linear" | "log" | null {
    const mode = this.overlay.toggleIndicatorScaleMode(paneId);
    this.session.invalidate(ChartChange.Viewport);
    return mode;
  }
  scaleIndicatorPane(paneId: string, factorMultiplier: number): boolean {
    return this.indicatorController.scalePane(paneId, factorMultiplier);
  }
  resetIndicatorPaneScale(paneId: string): boolean { return this.indicatorController.resetPaneScale(paneId); }
  toggleIndicatorPaneAutoScale(paneId: string): boolean { return this.indicatorController.togglePaneAutoScale(paneId); }
  notifyCrosshair(e: { time: number | null; price: number | null }): void { this.syncController.notifyCrosshair(e); }
  /** Internal ChartInputHost seam: raw cursor mapping owned by this runtime instance. */
  resolveScreenCrosshair(cx: number, cy: number): { time: number | null; price: number | null } {
    const source = captureRawSource(this, this.pipeline.series, {
      market: this.state.market,
      timeframe: this.state.timeframe,
      intervalMs: this.pipeline.intervalMs,
    });
    const resolution = resolveRawCursor(source, this.view.indexOfX(cx), this.view.priceOfY(cy), "raw");
    return {
      time: resolution.time.status === "known" ? resolution.time.time : null,
      price: resolution.price.status === "known" ? resolution.price.price : null,
    };
  }
  isReplaySelecting(): boolean { return this.replayCoordinator.isSelecting(); }
  previewReplayStart(time: number | null): void {
    if (time == null) this.syncController.hideCrosshair();
    else this.syncController.showCrosshair(time);
  }
  selectReplayStart(time: number): void {
    if (!this.replayCoordinator.isSelecting()) return;
    this.syncController.hideCrosshair();
    this.replayCoordinator.seek(time);
  }

  private _indexToTime(index: number): number | null {
    const series = this.pipeline.series;
    return series.length === 0 ? null : series.timeOfIndex(index);
  }
  private _screenToDrawingPoint(cx: number, cy: number, temporaryMagnet = false): { time: number; price: number } {
    const idx = this.view.indexOfX(cx);
    const magnetEnabled = isDrawingMagnetEnabled(settings.magnet, temporaryMagnet);
    let time: number;
    if (!magnetEnabled && this.analysisContextForChart().drawings?.activeTool === "brush") {
      // Brush drafts keep fractional sub-bar x; raw logical x sits on a column edge, so recenter by half a column.
      time = this._indexToTime(idx - 0.5) ?? Date.now();
    } else {
      time = this._indexToTime(Math.round(idx)) ?? Date.now();
    }
    let price = this.view.priceOfY(cy);
    if (magnetEnabled) {
      price = this._magnetSnapPrice(idx, cy, price, temporaryMagnet);
    }
    return { time, price };
  }
  private _magnetSnapPrice(idx: number, cy: number, rawPrice: number, forceNearest: boolean): number {
    const bar = this.pipeline.series.at(Math.round(idx));
    if (!bar) return rawPrice;
    return snapPriceToOhlc(
      rawPrice,
      cy,
      [bar.open, bar.high, bar.low, bar.close],
      (value) => this.view.yOfPrice(value),
      forceNearest,
    );
  }

  private bindInputController(): void {
    const inputController = new ChartInputController(this.interactionCanvas, this.crosshair, this);
    this.disposeInput = () => inputController.dispose();
  }

  refreshHostLifecycle(): void {
    if (this.disposed) return;
    this.disposeInput();
    this.session.updateContainer(this.panelRoot);
    this.indicatorController.updateOwnerDocument(this.panelRoot.ownerDocument);
    this.bindInputController();
    this.session.invalidate();
  }

  /** Tracks opt-in transitions so a re-enable retries the GPU prototype after a one-shot legacy fallback. */
  private trackHeatmapPrototypeOptIn(): void {
    if (this.heatmapTexturePrototypeLastEnabled !== this.heatmapTexturePrototypeEnabled) {
      this.heatmapTexturePrototypeLastEnabled = this.heatmapTexturePrototypeEnabled;
      this.heatmapGpuFailureLatched = false;
    }
  }

  /** CPU prepare for the GPU density prototype, inside the GPU render callback. */
  private prepareHeatmapGpuCells(v: View, s: FootprintSeries): HeatmapGpuCellFrame | null {
    if (!this.heatmapTexturePrototypeEnabled || this.heatmapGpuFailureLatched) return null;
    if (!this.orderbookHeatmap) return null;
    // Respect the actual annotation layer membership and main-pane visibility
    // exactly as Overlay.renderAnnotations would: no layer, no density.
    if (!(this.renderCoordinator?.getAnnotationLayerOrder() ?? []).includes("orderbook-heatmap")) return null;
    if (v.area.width <= 1 || v.area.height <= 1 || s.length === 0) return null;
    // Production prepare always reserves through the real renderer ledger:
    // a missing renderer or a denied reservation yields no prepared frame,
    // so the legacy annotation path stays authoritative (no unbudgeted
    // production fallback).
    if (!this.heatmapGpuRenderer) this.heatmapGpuRenderer = new HeatmapGpuRenderer();
    const gpuRenderer = this.heatmapGpuRenderer;
    return this.orderbookHeatmap.prepareGpuCells(
      v,
      s,
      this.renderer.visibleRange(v, s.length),
      (logicalBytes: number) => gpuRenderer.reservePreparedPayload(logicalBytes),
    );
  }

  /** Paints the prepared density frame after the candle flush; latches a one-frame legacy fallback on failure. */
  private renderHeatmapGpuCells(frame: HeatmapGpuCellFrame | null, v: View, s: FootprintSeries): void {
    if (!frame) return;
    const gl = this.heatmapGpuRendererGl;
    if (!gl) {
      frame.preparedLease?.release();
      this.disposeHeatmapGpuRenderer();
      this.heatmapGpuFailureLatched = true;
      return;
    }
    if (!this.heatmapGpuRenderer) this.heatmapGpuRenderer = new HeatmapGpuRenderer();
    const range = this.renderer.visibleRange(v, s.length);
    let ok: boolean;
    try {
      ok = this.heatmapGpuRenderer.renderFrame(gl, frame, {
        left: v.area.left,
        top: v.area.top,
        width: v.area.width,
        height: v.area.height,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
        // Transient real-budget denial: nothing was allocated and the GL
        // resources stay intact, so drop the unadopted lease, keep the failure
        // latch off and let the very next frame retry prepare/render once the
        // external pressure is freed (no toggle or context restore needed).
        frame.preparedLease?.release();
        return;
      }
      throw error;
    }
    if (!ok) {
      // Hidden pane, no GL resources or budget: fall back to the legacy
      // annotation path for this frame and until the opt-in is toggled again.
      frame.preparedLease?.release();
      this.disposeHeatmapGpuRenderer();
      this.heatmapGpuRendererGl = gl; // the context itself stays valid
      this.heatmapGpuFailureLatched = true;
      return;
    }
    this.heatmapGpuFrame = {
      dataKey: frame.dataKey,
      threshold: frame.threshold,
      ceiling: frame.ceiling,
      colWidth: v.colWidth,
      offsetX: v.offsetX,
      areaLeft: v.area.left,
      areaTop: v.area.top,
      areaWidth: v.area.width,
      areaHeight: v.area.height,
      priceTop: v.priceTop,
      pricePerPx: v.pricePerPx,
      priceScaleMode: v.priceScaleMode,
      seriesLength: s.length,
      rangeFrom: range[0],
      rangeTo: range[1],
    };
    // The completed claim owns the prepared lists; hold their lease until
    // the claim is replaced, fails or is disposed (release is idempotent).
    this.heatmapGpuLease = frame.preparedLease ?? null;
  }

  /** True when the completed GPU frame owns the density for exactly these inputs. */
  private heatmapGpuSuppressedAnnotation(v: View, s: FootprintSeries, range: [number, number]): boolean {
    const claim = this.heatmapGpuFrame;
    if (!claim) return false;
    return claim.dataKey === this.orderbookHeatmap?.currentDataKey()
      && claim.colWidth === v.colWidth
      && claim.offsetX === v.offsetX
      && claim.areaLeft === v.area.left
      && claim.areaTop === v.area.top
      && claim.areaWidth === v.area.width
      && claim.areaHeight === v.area.height
      && claim.priceTop === v.priceTop
      && claim.pricePerPx === v.pricePerPx
      && claim.priceScaleMode === v.priceScaleMode
      && claim.seriesLength === s.length
      && claim.rangeFrom === range[0]
      && claim.rangeTo === range[1];
  }

  private disposeHeatmapGpuRenderer(): void {
    // Drop the owned prepared references first, then release the lease.
    this.heatmapGpuFrame = null;
    this.releaseHeatmapGpuLease();
    this.heatmapGpuRenderer?.dispose();
    this.heatmapGpuRenderer = null;
    this.heatmapGpuRendererGl = null;
  }

  /** Drops the lease reference, then releases it exactly once; safe to call repeatedly. */
  private releaseHeatmapGpuLease(): void {
    const lease = this.heatmapGpuLease;
    this.heatmapGpuLease = null;
    lease?.release();
  }

  dispose(): void {
    this.npocController?.abort();
    this.npocController = null;
    this.npocGeneration++;
    this.npocListeners.clear();
    if (this.disposed) return;
    this.disposed = true;
    this.disposal.abort();
    this.disposeDebugGlobals?.();
    this.disposeDebugGlobals = null;
    this.disposeFootprintSupport?.();
    this.disposeFootprintSupport = null;
    this.orderbookHeatmap?.dispose();
    chartHost().unregisterRuntime(this.panelId, this);
    this.analysisBridge.dispose();
    this.historyController.dispose();
    this.replayCoordinator.dispose();
    this.syncController.dispose();
    this.captureCoordinator.dispose();
    this.disposeInput();
    this.session.destroy();
    this.renderCoordinator.dispose();
    this.renderer.dispose();
    this.disposeHeatmapGpuRenderer();
    this.pipeline.dispose();
    this.indicatorController.dispose();
    for (const element of this.ownedElements) element.remove();
    this.surface.historyOverlay = false;
    this.surface.historyBackground = false;
  }

  startReplay(): void {
    this.pipeline.setPaused(true);
    this.replayCoordinator.start();
  }
  replayPlay(): void { this.replayCoordinator.play(); }
  replayPause(): void { this.replayCoordinator.pause(); }
  replayStep(): void { this.replayCoordinator.step(); }
  replaySetSpeed(speed: number): void { this.replayCoordinator.setSpeed(speed); }
  replaySeek(time: number): void { this.replayCoordinator.seek(time); }
  replaySelectFirst(): void { this.replayCoordinator.selectFirst(); }
  replaySelectRandom(): void { this.replayCoordinator.selectRandom(); }
  exitReplay(): void {
    this.replayCoordinator.exit();
    if (this.hostActive) this.pipeline.setPaused(false);
  }
  getReplaySnapshot(): ReplaySnapshot | null { return this.replayCoordinator.getSnapshot(); }
  get disposalSignal(): AbortSignal {
    return this.disposal.signal;
  }

  getDiagnostics(): { disposed: boolean; replayActive: boolean } {
    return { disposed: this.disposed, replayActive: this.replayCoordinator.isActive() };
  }

  installDebugGlobals(): void {
    if (!chartHost().exposeDebugGlobals() && !isLoadTraceEnabled()) return;
    const rt = this as unknown as {
      view: { colWidth: number; offsetX: number; area: { left: number; width: number }; indexOfX(x: number): number };
      pipeline: { series: { length: number; at(i: number): { startTime: number } | undefined } };
      timeViewport: { followsLatest(): boolean };
      getState(): { market: string; timeframe: string };
    };
    const g = globalThis as unknown as {
      __vp?: () => unknown;
      __vpTrace?: boolean;
      __vpTraceOn?: () => void;
      __vpTraceOff?: () => void;
    };
    const vp = () => {
      const v = rt.view;
      const s = rt.pipeline.series;
      const clamp = (i: number) => Math.max(0, Math.min(s.length - 1, i));
      const firstIdx = clamp(Math.floor(v.indexOfX(v.area.left)));
      const lastIdx = clamp(Math.ceil(v.indexOfX(v.area.left + v.area.width)));
      const iso = (time?: number) => (time ? new Date(time).toISOString().slice(0, 16) : null);
      return {
        market: rt.getState().market,
        tf: rt.getState().timeframe,
        colWidth: +v.colWidth.toFixed(3),
        offsetX: Math.round(v.offsetX),
        followLatest: rt.timeViewport.followsLatest(),
        seriesLen: s.length,
        firstVisible: iso(s.at(firstIdx)?.startTime),
        lastVisible: iso(s.at(lastIdx)?.startTime),
        visibleBars: lastIdx - firstIdx + 1,
        areaW: Math.round(v.area.width),
      };
    };
    const traceOn = () => { g.__vpTrace = true; console.log("[vp] trace ON"); };
    const traceOff = () => { g.__vpTrace = false; console.log("[vp] trace OFF"); };
    g.__vp = vp;
    g.__vpTraceOn = traceOn;
    g.__vpTraceOff = traceOff;
    this.disposeDebugGlobals = () => {
      if (g.__vp === vp) delete g.__vp;
      if (g.__vpTraceOn === traceOn) delete g.__vpTraceOn;
      if (g.__vpTraceOff === traceOff) delete g.__vpTraceOff;
    };
  }

  invalidate(changes: ChartChange = ChartChange.All): void { this.session.invalidate(changes); }
  listIndicators(): IndicatorInstance[] { return this.indicatorController.listInstances(); }
  setIndicatorVisible(id: string, visible: boolean): void { this.indicatorController.setVisible(id, visible); }
  removeIndicator(id: string): void { this.indicatorController.remove(id); }
  openIndicatorSettings(id: string): void { this.indicatorController.openSettings(id); }
  togglePaneMaximizeAt(y: number): boolean { return this.indicatorController.togglePaneMaximizeAt(y); }
  isChartPaneMaximized(): boolean { return this.indicatorController.isChartPaneMaximized(); }
  hasIndicatorPanes(): boolean { return this.indicatorController.hasSeparatePanes(); }
  toggleIndicatorPanes(): void { this.indicatorController.toggleChartPaneMaximized(); }
  togglePanelMaximize(): void {
    const panel = requestChartPanelMaximize(this.interactionCanvas, "query");
    requestChartPanelMaximize(this.interactionCanvas, panel.maximized ? "exit" : "enter");
  }
  getPriceStep(): number { return this.pipeline.series.config.priceStep; }

  getCaptureReadiness(): ChartCaptureReadiness { return this.captureCoordinator.getReadiness(); }
  getDataState(now: number, transportOffline: boolean): ChartDataState {
    const pipeline = this.pipeline.dataStateInputs();
    return evaluateChartDataState({
      ...pipeline,
      recentFootprintRepairActive: pipeline.recentFootprintRepairActive || this.historyController.recentCoverageRetryPending,
      historyStatus: this.captureCoordinator.getHistoryStatus(),
      footprintSupported: isFootprintSyncAllowed(this.state.market),
      transportOffline,
    }, now);
  }
  subscribeCaptureReadiness(cb: (snapshot: ChartCaptureReadiness) => void): () => void {
    return this.captureCoordinator.subscribe(cb);
  }
  captureNativePng(): Promise<NativeChartCapture> { return this.captureCoordinator.captureNativePng(); }

  async setPriceStep(step: number | null): Promise<void> {
    if (this.disposed) return;
    const next = step ?? await this.svc.fetchPriceStep(this.state.market);
    if (this.disposed) return;
    if (!Number.isFinite(next) || next <= 0) return;
    // Idempotent: the step the pipeline already runs (server-corrected or explicit)
    // must not reset the series, reload history, or disturb the live viewport.
    if (next === this.getPriceStep()) return;
    this.pipeline.setPriceStep(next);
    // The reset cleared the series: the replacement reload must take over the
    // loading cover so a stale initial-load settlement cannot uncover it.
    const replacementLoad = this.historyController.loadHistory(undefined, { twoPhase: true });
    this.historyController.trackInitialHistoryLoad(replacementLoad);
    await replacementLoad;
  }
  refreshHistory(rebuildKlines = true, options: { preserveViewport?: boolean } = {}): Promise<void> {
    return this.historyController.refreshHistory(rebuildKlines, options);
  }
  trackInitialHistoryLoad(load: Promise<void>): void { this.historyController.trackInitialHistoryLoad(load); }
  cancelMaintenanceRefresh(): void { this.historyController.cancelMaintenanceRefresh(); }

  resetPriceScale(): void {
    if (this.disposed) return;
    this.view.resetPriceScale();
    this._autoFit();
    this.session.invalidate(ChartChange.Viewport);
  }
  resetTimeScale(): void {
    if (this.disposed) return;
    this.historyController.clearPendingTimeframeAnchor();
    this.timeViewport.resetToDefault(this.pipeline.series.length);
    this._autoFit();
    this.session.invalidate(ChartChange.Viewport);
    this.syncController.emitVisibleRange();
  }
  resetAllScales(): void {
    if (this.disposed) return;
    this.historyController.clearPendingTimeframeAnchor();
    this.timeViewport.resetToDefault(this.pipeline.series.length);
    this.view.resetPriceScale();
    this._autoFit();
    this.session.invalidate(ChartChange.Viewport);
    this.syncController.emitVisibleRange();
  }
  goLatest(): void {
    if (this.disposed) return;
    this.historyController.clearPendingTimeframeAnchor();
    this.timeViewport.goLatest(this.pipeline.series.length);
    this._autoFit();
    this.session.invalidate(ChartChange.Viewport);
    this.syncController.emitVisibleRange();
  }
  togglePriceAutoScale(): boolean {
    const next = !this.view.isPriceAutoScale();
    this._setPriceAutoScaleFromControl(next);
    return next;
  }
  togglePriceScaleMode(): ChartPanelState["scaleMode"] { return this._togglePriceScaleModeFromControl(); }
  isPriceAutoScale(): boolean { return this.view.isPriceAutoScale(); }
  isLogScale(): boolean { return this.view.isLogScale(); }
  refreshAutoScale(): void {
    if (!this.disposed && this.view.isPriceAutoScale()) {
      this._fitToData();
      this.session.invalidate(ChartChange.Viewport);
    }
  }
  refreshDay(dayTs: number): void { this.historyController.refreshDay(dayTs); }
  focusTradingDay(dayStart: number): Promise<void> { return this.historyController.focusTradingDay(dayStart); }

  private _queueHookUpdate(): void {
    if (this.hookUpdateQueued) return;
    this.hookUpdateQueued = true;
    queueMicrotask(() => {
      this.hookUpdateQueued = false;
      if (!this.disposed) this._updateHook();
    });
  }

  private _updateHook(): void {
    const hook = this._hook;
    const analysis = this.analysisContextForChart();
    const drawings = analysis.drawings;
    const drawingSummary = drawings.marketSummary(this.state.market);
    const range = this.syncController?.getVisibleTimeRange() ?? null;
    const replay = this.replayCoordinator?.getSnapshot() ?? null;

    hook.setAttribute("data-series-len", String(this.pipeline.series.length));
    hook.setAttribute("data-series-first", String(this.pipeline.series.at(0)?.startTime ?? ""));
    hook.setAttribute("data-series-last", String(this.pipeline.series.at(this.pipeline.series.length - 1)?.startTime ?? ""));
    hook.setAttribute("data-series-interval", String(this.pipeline.series.config.intervalMs));
    if (isLoadTraceEnabled()) {
      let seriesCellCount = 0;
      let barsWithCells = 0;
      for (let index = 0; index < this.pipeline.series.length; index++) {
        const cells = this.pipeline.series.at(index)?.cells.size ?? 0;
        seriesCellCount += cells;
        if (cells > 0) barsWithCells++;
      }
      hook.setAttribute("data-series-cells", String(seriesCellCount));
      hook.setAttribute("data-bars-with-cells", String(barsWithCells));
      const timeMarks = TimeScaleModel.fromSeries(this.pipeline.series).marks(this.view);
      hook.setAttribute("data-time-mark-count", String(timeMarks.length));
      hook.setAttribute("data-time-mark-coords", JSON.stringify(timeMarks.map((mark) => ({
        x: Math.round(mark.coord * 10) / 10,
        label: mark.label,
        weight: mark.weight,
      }))));
      hook.setAttribute("data-col-width", String(this.view.colWidth));
      hook.setAttribute("data-plot-width", String(this.view.area.width));
      const traceMidPrice = this.view.priceOfY(this.view.area.top + this.view.area.height / 2);
      hook.setAttribute("data-price-step", String(this.pipeline.series.config.priceStep));
      hook.setAttribute("data-cell-height", String(Math.abs(
        this.view.yOfPrice(traceMidPrice)
          - this.view.yOfPrice(traceMidPrice + this.pipeline.series.config.priceStep),
      )));
    }

    hook.setAttribute("data-series-tail", JSON.stringify(
      Array.from({ length: Math.min(5, this.pipeline.series.length) }, (_, offset) => {
        const bar = this.pipeline.series.at(this.pipeline.series.length - 1 - offset);
        return bar ? {
          time: bar.startTime,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          count: bar.count,
        } : null;
      }),
    ));

    const automaticLevels = [
      ...analysis.previousWeekStrategyLevels,
      ...analysis.mondayRangeLevels,
      ...analysis.nakedPocs,
      ...analysis.referenceLevels,
    ];
    let automaticPriceCount = 0;
    let automaticPriceMin = Infinity;
    let automaticPriceMax = -Infinity;
    for (const level of automaticLevels) {
      const price = level.price;
      if (price === undefined || !Number.isFinite(price)) continue;
      automaticPriceCount++;
      if (price < automaticPriceMin) automaticPriceMin = price;
      if (price > automaticPriceMax) automaticPriceMax = price;
    }
    const analysisRevision = this.svc.getAnalysisRevisionSnapshot(this.state.market).revision;

    hook.setAttribute("data-market", this.state.market);
    hook.setAttribute("data-analysis-market", analysis.market);
    hook.setAttribute("data-analysis-revision", String(analysisRevision));
    hook.setAttribute("data-npoc-count", String(this.npocLevels.length));
    hook.setAttribute("data-npoc-visible-count", String(analysis.nakedPocs.length));
    hook.setAttribute("data-npoc-pending", String(this.npocPending?.length ?? 0));
    hook.setAttribute("data-npoc-history-ready", String(this.npocHistoryReady));
    hook.setAttribute("data-automatic-level-count", String(automaticPriceCount));
    hook.setAttribute("data-automatic-price-min", automaticPriceCount ? String(automaticPriceMin) : "");
    hook.setAttribute("data-automatic-price-max", automaticPriceCount ? String(automaticPriceMax) : "");
    hook.setAttribute("data-price-auto-scale", String(this.view.isPriceAutoScale()));
    hook.setAttribute("data-active-tool", drawings.activeTool ?? "");
    hook.setAttribute("data-selected", drawingSummary.selectedId ?? "");
    hook.setAttribute("data-selected-count", String(drawingSummary.selectedCount));
    hook.setAttribute("data-drawing-count", String(drawingSummary.types.length));
    hook.setAttribute("data-drawing-types", drawingSummary.types.join(","));
    hook.setAttribute("data-sync-time", this.syncController?.ghostCrosshairTime != null ? String(this.syncController.ghostCrosshairTime) : "");
    hook.setAttribute("data-visible-range", range ? `${Math.round(range.from)}:${Math.round(range.to)}` : "");
    hook.setAttribute("data-follow-latest", String(this.timeViewport.followsLatest()));
    hook.setAttribute("data-timeframe", this.state.timeframe);
    hook.setAttribute("data-link-group", this.state.linkGroup ?? "");
    hook.setAttribute("data-replay-state", replay?.state ?? "");
    hook.setAttribute("data-replay-visible", replay ? String(replay.visibleBars) : "");
    hook.setAttribute("data-replay-total", replay ? String(replay.totalBars) : "");
  }

  private _setPriceAutoScaleFromControl(autoScale: boolean): void {
    this.view.setPriceAutoScale(autoScale);
    if (autoScale) this._autoFit();
    this.session.invalidate(ChartChange.Viewport);
  }

  private _togglePriceScaleModeFromControl(): ChartPanelState["scaleMode"] {
    const nextMode = this.view.isLogScale() ? "linear" : "log";
    this.view.setScaleMode(nextMode);
    this.state = { ...this.state, scaleMode: nextMode };
    this.emitStateChange();
    this._autoFit();
    this.session.invalidate(ChartChange.Viewport);
    return nextMode;
  }

  private _fitToData(): void {
    this.view.setScaleMargins(settings.scaleMarginTop, settings.scaleMarginBottom);
    const series = this.pipeline.series;
    if (series.length === 0) {
      this.lastAutoFitSnapshot = null;
      return;
    }
    const [from, to] = this.renderer.autoscaleRange(this.view, series.length);
    const dataRange = footprintVisiblePriceRange(series, { from, to });
    const range = this.view.priceScale.autoscaleRange(
      { from, to },
      [
        {
          // Reuse the single raw visible-range scan above; recomputing the same
          // visible OHLC high/low through footprintAutoscaleSource doubles the work.
          visible: () => series.length > 0,
          autoscaleInfo: () => (dataRange ? { priceRange: dataRange } : null),
        },
      ],
      { minMove: series.config.priceStep },
    );
    if (range !== null && dataRange !== null) {
      this.view.setScaleRange(range);
      this.lastAutoFitSnapshot = {
        from,
        to,
        min: dataRange.minValue(),
        max: dataRange.maxValue(),
      };
    } else {
      this.lastAutoFitSnapshot = null;
    }
  }

  private _shouldAutoFitSameBarLiveUpdate(): boolean {
    if (!this.view.isPriceAutoScale()) {
      incrementPerformanceCounter("chart.liveUpdate.autoFit.skip.manual-scale");
      return false;
    }
    const series = this.pipeline.series;
    if (series.length === 0) {
      incrementPerformanceCounter("chart.liveUpdate.autoFit.skip.empty");
      return false;
    }
    const [from, to] = this.renderer.autoscaleRange(this.view, series.length);
    const tailIndex = series.length - 1;
    const tail = series.at(tailIndex);
    if (!tail) return true;
    const decision = decideLiveSameBarAutoFit(this.lastAutoFitSnapshot, { from, to }, tailIndex, tail.low, tail.high);
    incrementPerformanceCounter(`chart.liveUpdate.autoFit.${decision.shouldAutoFit ? "fit" : "skip"}.${decision.reason}`);
    return decision.shouldAutoFit;
  }

  private _autoFit(): void {
    if (!this.view.isPriceAutoScale()) return;
    incrementPerformanceCounter("chart.autoFit.count");
    measurePerformance("chart.autoFit", () => this._fitToData());
  }

  private _applyLayout(width: number, height: number): void {
    const layoutOptions = this.view.chartLayoutOptions;
    const availableHeight = Math.max(1, height - layoutOptions.timeAxisHeight - 1);
    const paneH = this.indicatorController.totalPaneHeight(availableHeight);
    this.view.subPanesH = paneH;
    this.view.priceAxisW = layoutOptions.priceAxisWidth;
    this.view.area = {
      left: 0,
      top: 0,
      width: Math.max(1, width - layoutOptions.priceAxisWidth),
      height: Math.max(1, height - layoutOptions.timeAxisHeight - paneH),
    };
    this.indicatorController.layout(this.view);
  }

  private _layoutFromCurrentSize(): void {
    const cached = this._lastKnownSize;
    const size = cached ?? this.panelRoot.getBoundingClientRect();
    if (size.width <= 0 || size.height <= 0) return;
    this._applyLayout(size.width, size.height);
    this.timeViewport.applyResize(this.pipeline.series.length, "layout-change");
    if (this.pipeline.series.length > 0) this._autoFit();
    this.session.invalidate(ChartChange.Layout | ChartChange.Viewport);
    this._maybeApplyNpoc();
  }

  private _setHistoryLoading(loading: boolean): void {
    this.surface.historyOverlay = loading;
    this.surface.historyBackground = false;
    this._hook.setAttribute("data-history-loading", String(loading));
    this._hook.setAttribute("data-history-overlay", String(loading));
    this._hook.setAttribute("data-history-background", "false");
    if (!loading) this.session.invalidate();
  }

  private _revealHistoryCandles(): void {
    if (this._hook.getAttribute("data-history-loading") !== "true") return;
    // Candles are on screen; older history may still be streaming in. Swap the
    // blocking cover for the corner badge until _setHistoryLoading(false).
    this.surface.historyOverlay = false;
    this.surface.historyBackground = true;
    this._hook.setAttribute("data-history-overlay", "false");
    this._hook.setAttribute("data-history-background", "true");
  }

  loadHistory(
    intervalMs?: number,
    opts: { rebuildKlines?: boolean; preferCache?: boolean; twoPhase?: boolean } = {},
  ): Promise<void> {
    return this.historyController.loadHistory(intervalMs, opts);
  }
}

function createChartTestHook(doc: Document, panelId: string): HTMLElement {
  const hook = doc.createElement("div");
  hook.setAttribute("data-testid", "chart-hook");
  hook.setAttribute("data-panel-id", panelId);
  hook.setAttribute("data-hud", "");
  hook.setAttribute("data-series-len", "0");
  hook.setAttribute("data-series-first", "");
  hook.setAttribute("data-series-last", "");
  hook.setAttribute("data-series-interval", "");
  hook.setAttribute("data-series-cells", "0");
  hook.setAttribute("data-bars-with-cells", "0");
  hook.setAttribute("data-series-tail", "[]");
  hook.setAttribute("data-active-tool", "");
  hook.setAttribute("data-selected", "");
  hook.setAttribute("data-selected-count", "0");
  hook.setAttribute("data-drawing-count", "0");
  hook.setAttribute("data-drawing-types", "");
  hook.setAttribute("data-sync-time", "");
  hook.setAttribute("data-visible-range", "");
  hook.setAttribute("data-follow-latest", "true");
  hook.setAttribute("data-history-loading", "false");
  hook.setAttribute("data-history-overlay", "false");
  hook.setAttribute("data-history-background", "false");
  hook.setAttribute("data-timeframe", "");
  hook.setAttribute("data-link-group", "");
  hook.setAttribute("data-replay-state", "");
  hook.setAttribute("data-replay-visible", "");
  hook.setAttribute("data-replay-total", "");
  hook.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
  return hook;
}

const PRICE_STEP_MOUNT_FALLBACK = 10;
const PRICE_STEP_BACKGROUND_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

async function withMetadataFallback<T>(promise: Promise<T>, fallback: T, timeoutMs = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const FALLBACK_TIMEFRAME = TIMEFRAMES[2];

async function buildChartRuntime(
  panelRoot: HTMLElement,
  initialState: ChartPanelState,
  services: ChartRuntimeServices,
  panelId: string,
  surface: ChartSurfaceModel,
  onStateChange?: (next: ChartPanelState) => void,
): Promise<ChartRuntimeImpl> {
  const doc = panelRoot.ownerDocument;
  const tf = TIMEFRAMES.find((item) => item.label === initialState.timeframe);
  if (!tf) {
    // An unknown saved timeframe opens on the fallback, and the state says so too; otherwise
    // the panel would show and persist a timeframe its data does not use.
    console.warn("[ChartRuntime] unknown timeframe, using fallback", {
      requested: initialState.timeframe,
      fallback: FALLBACK_TIMEFRAME.label,
    });
    initialState = { ...initialState, timeframe: FALLBACK_TIMEFRAME.label };
  }
  const timeframe = tf ?? FALLBACK_TIMEFRAME;

  const hook = createChartTestHook(doc, panelId);
  panelRoot.appendChild(hook);

  const gpuCanvas = doc.createElement("canvas");
  const annotationCanvas = doc.createElement("canvas");
  const interactionCanvas = doc.createElement("canvas");
  gpuCanvas.dataset.chartSurface = "gpu-scene";
  annotationCanvas.dataset.chartSurface = "annotation";
  interactionCanvas.dataset.chartSurface = "interaction";
  interactionCanvas.className = "chart-interaction-canvas";
  interactionCanvas.tabIndex = 0;
  interactionCanvas.setAttribute("role", "application");
  interactionCanvas.setAttribute("aria-label", `${initialState.market} ${initialState.timeframe}`);
  interactionCanvas.setAttribute("aria-keyshortcuts", "? ContextMenu Shift+F10");
  gpuCanvas.style.cssText = "position:absolute;inset:0;z-index:1;width:100%;height:100%;pointer-events:none;";
  annotationCanvas.style.cssText = "position:absolute;inset:0;z-index:2;width:100%;height:100%;pointer-events:none;";
  interactionCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:auto;";
  interactionCanvas.style.zIndex = String(Number(annotationCanvas.style.zIndex) + 1);
  panelRoot.append(gpuCanvas, annotationCanvas, interactionCanvas);

  const gl = getChartWebGl2Context(gpuCanvas);
  const annotationCtx2d = annotationCanvas.getContext("2d");
  const interactionCtx2d = interactionCanvas.getContext("2d");
  if (!gl || !annotationCtx2d || !interactionCtx2d) {
    hook.remove();
    gpuCanvas.remove();
    annotationCanvas.remove();
    interactionCanvas.remove();
    throw new Error("ChartRuntime: canvas contexts unavailable");
  }

  const priceStepPromise = services.fetchPriceStepResult
    ? services.fetchPriceStepResult(initialState.market)
    : services.fetchPriceStep(initialState.market).then((step) => ({ step, resolved: true }));
  const pricePrecisionPromise = services.fetchPricePrecision(initialState.market);
  const [stepResult, pricePrecision] = await Promise.all([
    withMetadataFallback(
      priceStepPromise,
      { step: PRICE_STEP_MOUNT_FALLBACK, resolved: false },
      PRICE_STEP_RESOLVE_TIMEOUT_MS,
    ),
    withMetadataFallback(pricePrecisionPromise, undefined),
  ]);
  const priceStep = stepResult.step;
  const usedFallbackStep = !stepResult.resolved;

  // The server-step handoff stays inert until the runtime exists and actual history
  // begins below, so construction-time metadata can never re-enter a half-built runtime.
  let onServerPriceStep: ((step: number) => void | Promise<void>) | null = null;
  const pipeline = new ChartDataPipeline({
    market: initialState.market,
    intervalMs: timeframe.ms,
    priceStep,
    pricePrecision,
    services,
    onDataDegraded: (degraded, detail) => chartHost().setDataDegraded(panelId, degraded, detail),
    onServerPriceStep: (step) => onServerPriceStep?.(step),
  });

  const runtime = new ChartRuntimeImpl(
    initialState, services,
    gpuCanvas, annotationCanvas, interactionCanvas, gl, annotationCtx2d, interactionCtx2d,
    panelRoot, surface, pipeline, panelId, hook,
  );
  runtime.installDebugGlobals();
  if (onStateChange) {
    runtime.onStateChange = onStateChange;
    const persistableInitial = runtime.getPersistableState();
    if (persistableInitial.chartType !== initialState.chartType || !tf) onStateChange(persistableInitial);
  }

  onServerPriceStep = (step) => {
    if (runtime.getDiagnostics().disposed) return;
    // The pipeline only reports the served grid; adoption goes through the managed
    // public setter (pipeline generation/cancel/reset + covered reload) so the
    // mismatched snapshot cannot commit under the fallback grid. The late compare
    // keeps an already-adopted equal step free of epoch/reset/reload. The owned
    // adoption promise is returned so the pipeline's selection correction can
    // await the covered replacement commit; the side catch keeps ignored
    // invocations free of unhandled rejections.
    if (step === runtime.getPriceStep()) return;
    const adoption = runtime.setPriceStep(step);
    adoption.catch(() => { /* history failures surface through the load error state */ });
    return adoption;
  };
  const initialHistoryLoad = runtime.loadHistory(undefined, { twoPhase: true });
  void initialHistoryLoad.catch(() => undefined);
  runtime.trackInitialHistoryLoad(initialHistoryLoad);

  if (usedFallbackStep) {
    const requestedMarket = initialState.market;
    const applyResolvedStep = async (result: { step: number; resolved: boolean }) => {
      if (!result.resolved) return false;
      if (runtime.getDiagnostics().disposed) return true;
      if (runtime.getState().market !== requestedMarket) return true;
      if (!Number.isFinite(result.step) || result.step <= 0) return true;
      await initialHistoryLoad;
      if (runtime.getDiagnostics().disposed) return true;
      if (runtime.getState().market !== requestedMarket) return true;
      // Compare against the step the runtime runs now: a server-corrected grid
      // (history metadata adoption) must not be reset or reloaded again.
      if (result.step !== runtime.getPriceStep()) await runtime.setPriceStep(result.step);
      return true;
    };
    void (async () => {
      if (await applyResolvedStep(await priceStepPromise)) return;
      if (!services.fetchPriceStepResult) return;
      for (const delay of PRICE_STEP_BACKGROUND_RETRY_DELAYS_MS) {
        if (!(await abortableDelay(delay, runtime.disposalSignal))) return;
        if (runtime.getState().market !== requestedMarket) return;
        if (await applyResolvedStep(await services.fetchPriceStepResult(requestedMarket))) return;
      }
    })().catch(() => { /* keep fallback step on metadata failure */ });
  }

  void pricePrecisionPromise.then((realPrecision) => {
    if (runtime.getDiagnostics().disposed) return;
    if (runtime.getState().market !== initialState.market) return;
    if (realPrecision === undefined || realPrecision === pricePrecision) return;
    pipeline.series.setPricePrecision(realPrecision);
    runtime.invalidate();
  }).catch(() => { /* keep fallback precision on metadata failure */ });

  return runtime;
}

/**
 * Mount a chart runtime into `panelRoot`, the root element of the Svelte
 * ChartSurface. The runtime appends its canvases and test hook there and
 * reports visible UI state through `surface`.
 */
export function mountChartRuntime(
  panelRoot: HTMLElement,
  initialState: ChartPanelState,
  services: ChartRuntimeServices,
  panelId: string,
  surface: ChartSurfaceModel,
  onStateChange?: (next: ChartPanelState) => void,
): ChartMountHandle {
  let runtime: ChartRuntimeImpl | null = null;
  let disposed = false;
  let pendingState: ChartPanelState | null = null;
  surface.status = "loading";

  void buildChartRuntime(panelRoot, initialState, services, panelId, surface, onStateChange).then((built) => {
    if (disposed) {
      built.dispose();
      return;
    }
    surface.status = "ready";
    runtime = built;
    if (pendingState) {
      const toApply = pendingState;
      pendingState = null;
      runtime.updateState(toApply);
    }
  }).catch((error) => {
    console.error("[ChartRuntime] mount failed:", error);
    if (!disposed) surface.status = "failed";
  });

  return {
    dispose: () => {
      disposed = true;
      pendingState = null;
      runtime?.dispose();
      runtime = null;
    },
    updateState: (next: ChartPanelState) => {
      if (runtime) runtime.updateState(next);
      else pendingState = next;
    },
  };
}
