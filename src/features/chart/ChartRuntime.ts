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
import { ChartInputController, type ChartInputHost } from "./ChartInputController.js";
import { captureRawSource, resolveRawCursor } from "./rawViewContract.js";
import { View } from "../../core/engine/view.js";
import { FootprintRenderer } from "../../core/render/footprintRenderer.js";
import { Overlay } from "../../core/render/overlay.js";
import type { Crosshair } from "../../core/render/overlay.js";
import { ChartChange, ChartSurfaceDirty } from "../../core/render/scene/chartScene.js";
import { TIMEFRAMES } from "../../core/timeframes.js";
import type { NakedPocLevel } from "../../core/analysis/nakedPoc.js";
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
import { createGpuSurface, createGpuSurfaceAsync } from "../../core/gpu/selectBackend.js";
import { isWebGpuSupported } from "../../core/gpu/webgpu/webgpuDevice.js";
import { onGpuSettingsChange, readGpuSettings } from "../../core/gpu/gpuSettings.js";
import type { GpuSurface } from "../../core/gpu/gpuBackend.js";
import {
  resolveChartDisplayOptions,
  sameChartDisplayOptions,
  type ResolvedChartDisplayOptions,
} from "../../core/model/chartDisplayOptions.js";
import { ChartReplayCoordinator } from "./ChartReplayCoordinator.js";
import { ChartCaptureCoordinator } from "./ChartCaptureCoordinator.js";
import { ChartAnalysisBridge } from "./ChartAnalysisBridge.js";
import { ChartHistoryController } from "./ChartHistoryController.js";
import { ChartSyncController } from "./ChartSyncController.js";
import { ChartRenderCoordinator } from "./ChartRenderCoordinator.js";
import { ChartIndicatorController } from "./ChartIndicatorController.js";
import { ChartMagnetController, type MagnetSnapTarget } from "./ChartMagnetController.js";
import { ChartHeatmapGpuCoordinator, type HeatmapGpuRenderFrame } from "./ChartHeatmapGpuCoordinator.js";
import { ChartLevelContextController } from "./ChartLevelContextController.js";
import { buildChartAnalysisSnapshot, countClosedBars } from "./analysisSnapshot.js";
import { decideLiveSameBarAutoFit, type LiveAutoFitSnapshot } from "./liveAutoFit.js";
import { OrderbookHeatmapOverlay, type LiveHeatmapTailEvent } from "../orderbook/heatmapOverlay.js";
import type { HeatmapGpuCellFrame } from "./heatmap/gpu/heatmapGpuRenderer.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { abortableDelay } from "./abortableDelay.js";
import type { ChartSurfaceModel } from "./chartSurfaceModel.js";

export type { MagnetSnapTarget, HeatmapGpuRenderFrame };

export interface ChartRuntime {
  updateState(next: ChartPanelState): void;
  getState(): ChartPanelState;
  getAnalysisSnapshot(options?: AnalysisSnapshotOptions): ChartAnalysisSnapshot;
  /** Invalidate or push live tail orderbook heatmap data. */
  invalidateOrderbookHeatmapLiveTail?(event?: LiveHeatmapTailEvent): void;
  activate(): void;
  deactivate(): void;
  refreshHostLifecycle(): void;
  /** Re-read `ChartHost.displayOptions()` and re-lay the chart out when the answer changed. */
  refreshDisplayOptions(): void;
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
  /** What `ChartHost.displayOptions()` last answered, resolved; WebGL attributes only apply at mount. */
  private displayOptions: ResolvedChartDisplayOptions;
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
  private readonly tpoMergeLeftSessionStarts = new Set<number>();
  private lastAutoFitSnapshot: LiveAutoFitSnapshot | null = null;
  private analysisSelectionGeneration = 0;
  private hostActive = true;
  /** Set once construction is done: from then on every non-interaction invalidation refreshes the test hook. */
  private hookFollowsInvalidation = false;
  /** One hook refresh per task: a burst of invalidations (wheel, pan, live tick) collapses into one write. */
  private hookUpdateQueued = false;

  private lastAnalysisSnapshotCache: {
    readonly snapshot: ChartAnalysisSnapshot;
    readonly market: string;
    readonly timeframe: string;
    readonly intervalMs: number;
    readonly seriesRevision: number;
    readonly seriesResetEpoch: number;
    readonly closedCount: number;
    readonly selectionGeneration: number;
    readonly canonicalRevision: number | null;
    readonly canonicalStatus: string;
    readonly drawingsSignature: string;
    readonly indicatorsSignature: string;
    readonly timeRangeFrom: number | undefined;
    readonly timeRangeTo: number | undefined;
    readonly priceRangeLow: number | undefined;
    readonly priceRangeHigh: number | undefined;
    readonly optionsSignature: string;
  } | null = null;
  private readonly replayCoordinator: ChartReplayCoordinator;
  private readonly captureCoordinator: ChartCaptureCoordinator;
  private readonly analysisBridge: ChartAnalysisBridge;
  private readonly historyController: ChartHistoryController;
  private readonly syncController: ChartSyncController;
  private readonly magnetController: ChartMagnetController;
  private readonly heatmapGpuCoordinator: ChartHeatmapGpuCoordinator;
  private readonly levelContextController: ChartLevelContextController;
  private readonly hookAttrCache = new Map<string, string>();
  private lastSeriesTailSig: string | null = null;
  private lastSeriesTailJson: string = "[]";

  get activeMagnetSnap(): MagnetSnapTarget | null {
    return this.magnetController.activeMagnetSnap;
  }

  private setHookAttr(name: string, value: string): void {
    if (this.hookAttrCache.get(name) === value) return;
    this.hookAttrCache.set(name, value);
    this._hook.setAttribute(name, value);
  }

  onStateChange?: (next: ChartPanelState) => void;

  constructor(
    initialState: ChartPanelState,
    services: ChartRuntimeServices,
    gpuCanvas: HTMLCanvasElement,
    annotationCanvas: HTMLCanvasElement,
    interactionCanvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext | null,
    annotationCtx2d: CanvasRenderingContext2D,
    interactionCtx2d: CanvasRenderingContext2D,
    panelRoot: HTMLElement,
    surface: ChartSurfaceModel,
    pipeline: ChartDataPipeline,
    panelId: string,
    hook: HTMLElement,
    display: ResolvedChartDisplayOptions,
    gpuSurface?: GpuSurface,
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
    this.displayOptions = display;
    this.view = new View(display.timeScale, display.layout);
    this.view.setScaleMode(initialState.scaleMode);
    this.timeViewport = new TimeScaleViewportController(this.view);
    this.renderer = new FootprintRenderer(gpuSurface ?? (gl as WebGL2RenderingContext));

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
    const subscribeHeatmapLiveTail = services.subscribeOrderbookHeatmapLiveTail?.bind(services);
    this.orderbookHeatmap = fetchOrderbookHeatmap
      ? new OrderbookHeatmapOverlay({
        fetch: fetchOrderbookHeatmap,
        invalidate: () => {
          if (!this.disposed) this.session?.invalidate();
        },
        getMarket: () => this.state.market,
        subscribeLiveTail: subscribeHeatmapLiveTail,
      })
      : null;

    this.heatmapGpuCoordinator = new ChartHeatmapGpuCoordinator(this);
    this.heatmapGpuCoordinator.setGl(gl);
    this.magnetController = new ChartMagnetController(this);

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
        this.setHookAttr("data-hud", text ?? "");
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
          if (this.activeMagnetSnap) {
            this.drawMagnetSnapRing(ctx, activeView, this.activeMagnetSnap);
          }
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
        this.heatmapGpuCoordinator.beginFrameAttempt();
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
            heatmapFrame?.preparedLease?.release();
            heatmapFrame = null;
            throw error;
          }
        }
      },
      visibleRange: (v: View, total: number) => this.renderer.visibleRange(v, total),
      setSurface: (nextSurface: GpuSurface) => {
        this.renderer.setSurface(nextSurface);
        this.heatmapGpuCoordinator.setGl(
          nextSurface.kind === "webgl2"
            ? nextSurface.getGlContext?.() ?? null
            : null,
        );
      },
    };

    this.session = new ChartSession({
      container: panelRoot,
      gpuCanvas,
      gpuSurface,
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
        this.renderer = new FootprintRenderer(this.session.getSurface());
        this.heatmapGpuCoordinator.onRestoreContext(restoredGl);
        this.renderCoordinator.applyConfig(this.chartViewConfig());
        this.session.invalidate();
      },
      onLostContext: () => {
        this.heatmapGpuCoordinator.onLostContext();
      },
      maxDevicePixelRatio: display.maxDevicePixelRatio,
      onResize: (w, h, dpr) => {
        this.view.pixelRatio = dpr;
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

    this.levelContextController = new ChartLevelContextController(this);

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

  isDisposed(): boolean {
    return this.disposed;
  }

  invalidateSession(): void {
    if (!this.disposed) this.session?.invalidate();
  }

  updateHook(): void {
    this._updateHook();
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

  invalidateOrderbookHeatmapLiveTail(event?: LiveHeatmapTailEvent): void {
    this.orderbookHeatmap?.invalidateLiveTail(event);
  }

  getAnalysisSnapshot(options: AnalysisSnapshotOptions = {}): ChartAnalysisSnapshot {
    if (this.replayCoordinator.isActive()) throw new Error("AI analysis is unavailable during replay");
    const now = options.now ?? Date.now();
    const series = this.pipeline.series;
    const closedCount = countClosedBars(series.listReadonly(), this.pipeline.intervalMs, now);

    const runtimeTimeRange = options.visibleTimeRange ?? this.syncController.getVisibleTimeRange() ?? undefined;
    const priceRange = this.view.area.height > 1 ? this.view.priceRange() : null;
    const runtimePriceRange = options.visiblePriceRange ?? (priceRange ? {
      low: priceRange.minValue(),
      high: priceRange.maxValue(),
    } : undefined);

    const analysisCtx = this.analysisContextForChart();
    const analysisRevision = this.svc.getAnalysisRevisionSnapshot(this.state.market);

    const excludedIdsKey = options.excludedSourceIds ? Array.from(options.excludedSourceIds).sort().join(",") : "";
    const optionsSignature = `${options.maxCandles ?? ""}:${options.maxLevelsAndDrawings ?? ""}:${options.maxIndicatorSamples ?? ""}:${options.maxBytes ?? ""}:${options.includeHiddenSources ?? false}:${excludedIdsKey}`;

    const rawDrawings = analysisCtx.drawings?.listForMarket ? analysisCtx.drawings.listForMarket(this.state.market) : [];
    const drawingsSignature = rawDrawings.length === 0
      ? "0"
      : rawDrawings.map((d) => `${d.id}:${d.type}:${d.visible ?? true}:${d.points?.map((p) => `${p.time},${p.price}`).join(",") ?? ""}`).join(";");

    const indicatorInstances = this.indicatorController.listInstances();
    const indicatorsSignature = indicatorInstances.length === 0
      ? "0"
      : indicatorInstances.map((inst) => `${inst.id}:${inst.type}:${inst.visible ?? true}`).join(";");

    const cached = this.lastAnalysisSnapshotCache;
    if (
      cached
      && cached.market === this.state.market
      && cached.timeframe === this.state.timeframe
      && cached.intervalMs === this.pipeline.intervalMs
      && cached.seriesRevision === series.revision
      && cached.seriesResetEpoch === series.resetEpoch
      && cached.closedCount === closedCount
      && cached.selectionGeneration === this.analysisSelectionGeneration
      && cached.canonicalRevision === analysisRevision.canonical.revision
      && cached.canonicalStatus === analysisRevision.canonical.status
      && cached.timeRangeFrom === runtimeTimeRange?.from
      && cached.timeRangeTo === runtimeTimeRange?.to
      && cached.priceRangeLow === runtimePriceRange?.low
      && cached.priceRangeHigh === runtimePriceRange?.high
      && cached.optionsSignature === optionsSignature
      && cached.drawingsSignature === drawingsSignature
      && cached.indicatorsSignature === indicatorsSignature
    ) {
      return {
        ...cached.snapshot,
        capturedAt: now,
        candles: cached.snapshot.candles.slice(),
        levels: cached.snapshot.levels.slice(),
        drawings: cached.snapshot.drawings.slice(),
        indicators: cached.snapshot.indicators.slice(),
        warnings: cached.snapshot.warnings.slice(),
      };
    }

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
    const snapshot = buildChartAnalysisSnapshot({
      panelId: this.panelId,
      market: this.state.market,
      timeframe: this.state.timeframe,
      intervalMs: this.pipeline.intervalMs,
      selectionGeneration: this.analysisSelectionGeneration,
      series,
      analysis: analysisCtx,
      analysisRevision,
      indicators,
      options: {
        ...options,
        now,
        ...(runtimeTimeRange ? { visibleTimeRange: runtimeTimeRange } : {}),
        ...(runtimePriceRange ? { visiblePriceRange: runtimePriceRange } : {}),
      },
    });

    this.lastAnalysisSnapshotCache = {
      snapshot,
      market: this.state.market,
      timeframe: this.state.timeframe,
      intervalMs: this.pipeline.intervalMs,
      seriesRevision: series.revision,
      seriesResetEpoch: series.resetEpoch,
      closedCount,
      selectionGeneration: this.analysisSelectionGeneration,
      canonicalRevision: analysisRevision.canonical.revision,
      canonicalStatus: analysisRevision.canonical.status,
      drawingsSignature,
      indicatorsSignature,
      timeRangeFrom: runtimeTimeRange?.from,
      timeRangeTo: runtimeTimeRange?.to,
      priceRangeLow: runtimePriceRange?.low,
      priceRangeHigh: runtimePriceRange?.high,
      optionsSignature,
    };

    return snapshot;
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
    this.levelContextController.beginNpocRequest(market);
  }

  private _notifyNpocHistorySettled(market: string, timeframe: string): void {
    this.levelContextController.notifyNpocHistorySettled(market, timeframe);
  }

  private _maybeApplyNpoc(): void {
    this.levelContextController.maybeApplyNpoc();
  }

  getNpocLevels(): readonly NakedPocLevel[] {
    return this.levelContextController.getNpocLevels();
  }

  subscribeNpoc(listener: () => void): () => void {
    return this.levelContextController.subscribeNpoc(listener);
  }

  getReplayAutomaticLevels(): AutomaticLevelsAsOf | null {
    return this.levelContextController.getReplayAutomaticLevels();
  }

  private analysisContextForChart(): AnalysisContext {
    return this.levelContextController.analysisContextForChart();
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
  clearMagnetSnap(): void {
    this.magnetController.clearMagnetSnap();
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
    return this.magnetController.indexToTime(index);
  }

  private _screenToDrawingPoint(cx: number, cy: number, temporaryMagnet = false): { time: number; price: number } {
    const controller = this.magnetController ?? new ChartMagnetController(this as any);
    return controller.screenToDrawingPoint(cx, cy, temporaryMagnet);
  }

  private _magnetSnapPrice(idx: number, cy: number, rawPrice: number, forceNearest: boolean): number {
    const controller = this.magnetController ?? new ChartMagnetController(this as any);
    return controller.magnetSnapPrice(idx, cy, rawPrice, forceNearest);
  }

  private _resolveMagnetSnap(
    cx: number,
    cy: number,
    rawPrice: number,
    defaultTime: number,
    idx: number,
    temporaryMagnet: boolean,
  ): { time: number; price: number } {
    const controller = this.magnetController ?? new ChartMagnetController(this as any);
    return controller.resolveMagnetSnap(cx, cy, rawPrice, defaultTime, idx, temporaryMagnet);
  }

  private drawMagnetSnapRing(
    ctx: CanvasRenderingContext2D,
    view: View,
    snap: { x: number; y: number; label: string },
  ): void {
    this.magnetController.drawMagnetSnapRing(ctx, view, snap);
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

  refreshDisplayOptions(): void {
    if (this.disposed) return;
    const next = resolveChartDisplayOptions(chartHost().displayOptions?.());
    if (sameChartDisplayOptions(next, this.displayOptions)) return;
    this.displayOptions = next;
    // antialias and powerPreference belong to the WebGL context, which exists already; they apply to charts mounted later.
    this.session.setMaxDevicePixelRatio(next.maxDevicePixelRatio);
    if (this.view.setDisplayOptions(next.timeScale, next.layout)) this._layoutFromCurrentSize();
  }

  private prepareHeatmapGpuCells(v: View, s: FootprintSeries): HeatmapGpuCellFrame | null {
    return this.heatmapGpuCoordinator.prepareHeatmapGpuCells(v, s);
  }

  private renderHeatmapGpuCells(frame: HeatmapGpuCellFrame | null, v: View, s: FootprintSeries): void {
    this.heatmapGpuCoordinator.renderHeatmapGpuCells(frame, v, s);
  }

  private heatmapGpuSuppressedAnnotation(v: View, s: FootprintSeries, range: [number, number]): boolean {
    return this.heatmapGpuCoordinator.heatmapGpuSuppressedAnnotation(v, s, range);
  }

  private disposeHeatmapGpuRenderer(): void {
    this.heatmapGpuCoordinator.dispose();
  }

  dispose(): void {
    this.levelContextController.dispose();
    this.heatmapGpuCoordinator.dispose();
    this.magnetController.clearMagnetSnap();
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
    this.pipeline.dispose();
    this.indicatorController.dispose();
    for (const element of this.ownedElements) element.remove();
    this.surface.historyOverlay = false;
    this.surface.historyBackground = false;
    // The host-wide drawing manager remembers the last chart that drew; let go of this one.
    this.svc.getAnalysisContext(this.state.market, true)?.drawings?.releaseHitTestContext(this.view);
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
    const analysis = this.analysisContextForChart();
    const drawings = analysis.drawings;
    const drawingSummary = drawings.marketSummary(this.state.market);
    const range = this.syncController?.getVisibleTimeRange() ?? null;
    const replay = this.replayCoordinator?.getSnapshot() ?? null;

    this.setHookAttr("data-series-len", String(this.pipeline.series.length));
    this.setHookAttr("data-series-first", String(this.pipeline.series.at(0)?.startTime ?? ""));
    this.setHookAttr("data-series-last", String(this.pipeline.series.at(this.pipeline.series.length - 1)?.startTime ?? ""));
    this.setHookAttr("data-series-interval", String(this.pipeline.series.config.intervalMs));
    if (isLoadTraceEnabled()) {
      let seriesCellCount = 0;
      let barsWithCells = 0;
      for (let index = 0; index < this.pipeline.series.length; index++) {
        const cells = this.pipeline.series.at(index)?.cells.size ?? 0;
        seriesCellCount += cells;
        if (cells > 0) barsWithCells++;
      }
      this.setHookAttr("data-series-cells", String(seriesCellCount));
      this.setHookAttr("data-bars-with-cells", String(barsWithCells));
      const timeMarks = TimeScaleModel.fromSeries(this.pipeline.series).marks(this.view);
      this.setHookAttr("data-time-mark-count", String(timeMarks.length));
      this.setHookAttr("data-time-mark-coords", JSON.stringify(timeMarks.map((mark) => ({
        x: Math.round(mark.coord * 10) / 10,
        label: mark.label,
        weight: mark.weight,
      }))));
      this.setHookAttr("data-col-width", String(this.view.colWidth));
      this.setHookAttr("data-plot-width", String(this.view.area.width));
      const traceMidPrice = this.view.priceOfY(this.view.area.top + this.view.area.height / 2);
      this.setHookAttr("data-price-step", String(this.pipeline.series.config.priceStep));
      this.setHookAttr("data-cell-height", String(Math.abs(
        this.view.yOfPrice(traceMidPrice)
          - this.view.yOfPrice(traceMidPrice + this.pipeline.series.config.priceStep),
      )));
    }

    const seriesLen = this.pipeline.series.length;
    let tailSig = String(seriesLen);
    const tailCount = Math.min(5, seriesLen);
    for (let i = 0; i < tailCount; i++) {
      const b = this.pipeline.series.at(seriesLen - 1 - i);
      if (b) {
        tailSig += "|" + b.startTime + ":" + b.open + ":" + b.high + ":" + b.low + ":" + b.close + ":" + b.volume + ":" + b.count;
      }
    }
    if (tailSig !== this.lastSeriesTailSig) {
      this.lastSeriesTailSig = tailSig;
      this.lastSeriesTailJson = JSON.stringify(
        Array.from({ length: tailCount }, (_, offset) => {
          const bar = this.pipeline.series.at(seriesLen - 1 - offset);
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
      );
    }
    this.setHookAttr("data-series-tail", this.lastSeriesTailJson);

    let automaticPriceCount = 0;
    let automaticPriceMin = Infinity;
    let automaticPriceMax = -Infinity;
    for (const group of [
      analysis.previousWeekStrategyLevels,
      analysis.mondayRangeLevels,
      analysis.nakedPocs,
      analysis.referenceLevels,
    ]) {
      for (const level of group) {
        const price = (level as any).price;
        if (price === undefined || !Number.isFinite(price)) continue;
        automaticPriceCount++;
        if (price < automaticPriceMin) automaticPriceMin = price;
        if (price > automaticPriceMax) automaticPriceMax = price;
      }
    }
    const analysisRevision = this.svc.getAnalysisRevisionSnapshot(this.state.market).revision;

    this.setHookAttr("data-market", this.state.market);
    this.setHookAttr("data-analysis-market", analysis.market);
    this.setHookAttr("data-analysis-revision", String(analysisRevision));
    this.setHookAttr("data-npoc-count", String(this.levelContextController.getNpocLevelsRaw().length));
    this.setHookAttr("data-npoc-visible-count", String(analysis.nakedPocs.length));
    this.setHookAttr("data-npoc-pending", String(this.levelContextController.getPendingNpocCount()));
    this.setHookAttr("data-npoc-history-ready", String(this.levelContextController.isNpocHistoryReady()));
    this.setHookAttr("data-automatic-level-count", String(automaticPriceCount));
    this.setHookAttr("data-automatic-price-min", automaticPriceCount ? String(automaticPriceMin) : "");
    this.setHookAttr("data-automatic-price-max", automaticPriceCount ? String(automaticPriceMax) : "");
    this.setHookAttr("data-price-auto-scale", String(this.view.isPriceAutoScale()));
    this.setHookAttr("data-active-tool", drawings.activeTool ?? "");
    this.setHookAttr("data-selected", drawingSummary.selectedId ?? "");
    this.setHookAttr("data-selected-count", String(drawingSummary.selectedCount));
    this.setHookAttr("data-drawing-count", String(drawingSummary.types.length));
    this.setHookAttr("data-drawing-types", drawingSummary.types.join(","));
    this.setHookAttr("data-sync-time", this.syncController?.ghostCrosshairTime != null ? String(this.syncController.ghostCrosshairTime) : "");
    this.setHookAttr("data-visible-range", range ? Math.round(range.from) + ":" + Math.round(range.to) : "");
    this.setHookAttr("data-follow-latest", String(this.timeViewport.followsLatest()));
    this.setHookAttr("data-timeframe", this.state.timeframe);
    this.setHookAttr("data-link-group", this.state.linkGroup ?? "");
    this.setHookAttr("data-replay-state", replay?.state ?? "");
    this.setHookAttr("data-replay-visible", replay ? String(replay.visibleBars) : "");
    this.setHookAttr("data-replay-total", replay ? String(replay.totalBars) : "");
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

  setResidentHeatmapEnabled(enabled: boolean): void {
    this.heatmapGpuCoordinator.setResidentHeatmapEnabled(enabled);
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
  hook.setAttribute("data-gpu-backend", "webgl2");
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
  // touch-action:none hands every touch to the pointer handlers (pan, pinch, long press); without it
  // the browser claims the gesture and cancels it, or zooms the whole page on a pinch.
  interactionCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:auto;"
    + "touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;"
    + "-webkit-tap-highlight-color:transparent;";
  interactionCanvas.style.zIndex = String(Number(annotationCanvas.style.zIndex) + 1);
  panelRoot.append(gpuCanvas, annotationCanvas, interactionCanvas);

  const display = resolveChartDisplayOptions(chartHost().displayOptions?.());
  const gpuSettings = readGpuSettings(doc.defaultView);
  const annotationCtx2d = annotationCanvas.getContext("2d");
  const interactionCtx2d = interactionCanvas.getContext("2d");

  let gpuSurface: GpuSurface;
  let gl: WebGL2RenderingContext | null = null;

  if (gpuSettings.backend === "canvas2d") {
    if (!annotationCtx2d || !interactionCtx2d) {
      hook.remove();
      gpuCanvas.remove();
      annotationCanvas.remove();
      interactionCanvas.remove();
      throw new Error("ChartRuntime: canvas contexts unavailable");
    }
    gpuSurface = createGpuSurface(gpuCanvas, "canvas2d");
  } else if (gpuSettings.backend === "webgl2" || (gpuSettings.backend === "auto" && !isWebGpuSupported())) {
    gl = getChartWebGl2Context(gpuCanvas, display.webgl);
    if (!gl || !annotationCtx2d || !interactionCtx2d) {
      if (!gl) incrementPerformanceCounter("chart.gpu.contextCreateFailed");
      hook.remove();
      gpuCanvas.remove();
      annotationCanvas.remove();
      interactionCanvas.remove();
      throw new Error("ChartRuntime: canvas contexts unavailable");
    }
    gpuSurface = createGpuSurface(gpuCanvas, "webgl2", gl);
  } else {
    gpuSurface = await createGpuSurfaceAsync(
      gpuCanvas,
      gpuSettings.backend,
      undefined,
      (c) => getChartWebGl2Context(c, display.webgl),
    );
    if (gpuSurface.kind === "webgl2") {
      gl = gpuSurface.getGlContext?.() ?? null;
    }
    if (!annotationCtx2d || !interactionCtx2d || (!gl && gpuSurface.kind === "webgl2")) {
      if (!gl && gpuSurface.kind === "webgl2") incrementPerformanceCounter("chart.gpu.contextCreateFailed");
      hook.remove();
      gpuCanvas.remove();
      annotationCanvas.remove();
      interactionCanvas.remove();
      throw new Error("ChartRuntime: canvas contexts unavailable");
    }
  }
  hook.setAttribute("data-gpu-backend", gpuSurface.kind);

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
    panelRoot, surface, pipeline, panelId, hook, display,
    gpuSurface,
  );
  runtime.setResidentHeatmapEnabled(gpuSettings.residentHeatmap);

  let currentBackendPref = gpuSettings.backend;
  const unbindGpuSettings = onGpuSettingsChange(async () => {
    if (runtime.getDiagnostics().disposed) return;
    const nextSettings = readGpuSettings(doc.defaultView);
    runtime.setResidentHeatmapEnabled(nextSettings.residentHeatmap);

    if (nextSettings.backend === currentBackendPref) {
      runtime.session.invalidateSurface(ChartSurfaceDirty.All);
      return;
    }

    currentBackendPref = nextSettings.backend;
    try {
      const nextCanvas = doc.createElement("canvas");
      const nextSurface = await createGpuSurfaceAsync(
        nextCanvas,
        nextSettings.backend,
        undefined,
        (c) => getChartWebGl2Context(c, display.webgl),
      );
      runtime.session.replaceSurface(nextSurface, (canvasNext: HTMLCanvasElement, canvasPrev: HTMLCanvasElement) => {
        canvasPrev.replaceWith(canvasNext);
        hook.setAttribute("data-gpu-backend", nextSurface.kind);
      });
    } catch (err) {
      console.error("[ChartRuntime] onGpuSettingsChange failed to replace surface", err);
    }
  });
  runtime.disposalSignal.addEventListener("abort", unbindGpuSettings, { once: true });
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
