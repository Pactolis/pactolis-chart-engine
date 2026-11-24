import { ChartChange } from "./scene/chartScene.js";
import {
  alignDirtyRectToDevicePixels,
  annotationPass,
  AnnotationPassCache,
  shouldFallbackToFullRedraw,
  unionDirtyRects,
  type AnnotationDirtyRect,
} from "./overlay/annotationPassCache.js";
// Canvas2D layer: cell volume numbers, price/time axes, crosshair, HUD.
import type { View } from "../engine/view.js";
import type { FootprintBar } from "../types.js";
import type { FootprintSeries } from "../model/footprint.js";
import { settings, type ChartViewConfig } from "../settings.js";
import type { IndicatorPaneRender } from "../indicatorTypes.js";
import {
  type IndicatorScaleControlRect,
  type PriceScaleControlId,
  type PriceScaleControlRect,
} from "./axisControlsRenderer.js";
import {
  pointInTouchControl,
  type TouchMenuButtonRect,
} from "./touchControlsRenderer.js";
import { AxisLayerCache } from "./axisLayerCache.js";
import { drawPriceMarkers, type PriceMarker } from "./priceAxisRenderer.js";
import { type TimeMarker } from "./timeAxisRenderer.js";
import type { VolumeProfileSettings } from "../analysis/volumeProfile.js";
import type { NakedPocLevel } from "../analysis/nakedPoc.js";
import type { ReferenceLevel } from "../analysis/referenceLevels.js";
import type { PreviousWeekStrategyLevel, PreviousWeekStrategySettings } from "../analysis/previousWeekStrategy.js";
import type { MondayRangeLevel, MondayRangeSettings } from "../analysis/mondayRange.js";
import { incrementPerformanceCounter, isPerformanceTelemetryEnabled, recordPerformanceDuration } from "../performanceTelemetry.js";
import type { InteractionQualityController } from "./interactionQuality.js";
import { resolveChartDisplayOptions, type ResolvedChartDisplayOptions } from "../model/chartDisplayOptions.js";
import { drawHud, type HudRendererDeps } from "./overlay/hudRenderer.js";
import {
  drawTpo,
  type TpoCacheState,
  type TpoProfileHit,
  type TpoProfileHitZone,
  type TpoRenderHost,
} from "./overlay/tpoPaintHelpers.js";
import {
  renderInteractionPass,
  type Crosshair,
  type InteractionOverlayHost,
} from "./overlay/interactionOverlayRenderer.js";
import {
  drawCells,
  drawIndicatorPriceOverlays,
  drawLastPrice,
  drawLineLabels,
  drawMondayRange,
  drawNakedPocs,
  drawPreviousWeekStrategy,
  drawReferenceLevels,
  drawSubPanes,
  drawVolumeProfile,
  lineLabelPriority,
  priceAxisKeepOut,
  type AnnotationRendererHost,
  type BarCellTextCacheEntry,
  type IndicatorAxisRect,
  type LineLabelEntry,
  type VolumeProfileCacheState,
} from "./overlay/annotationRenderer.js";

export type { Crosshair } from "./overlay/interactionOverlayRenderer.js";
export type { TpoProfileHit } from "./overlay/tpoPaintHelpers.js";

export class Overlay {
  /** When true, cell/HUD volumes are shown as USDT notional (qty * price). */
  private _showNotional = true;
  get showNotional(): boolean {
    return this._showNotional;
  }
  set showNotional(value: boolean) {
    if (this._showNotional === value) return;
    this._showNotional = value;
    this.onShowNotionalChange?.(value);
  }
  private profileCache: VolumeProfileCacheState | null = null;
  private tpoCache: TpoCacheState | null = null;
  private priceMarkers: PriceMarker[] = [];
  private timeMarkers: TimeMarker[] = [];
  private lineLabels: LineLabelEntry[] = [];
  private priceScaleControlRects: PriceScaleControlRect[] = [];
  private indicatorScaleControlRects: IndicatorScaleControlRect[] = [];
  private touchMenuButton: TouchMenuButtonRect | null = null;
  private indicatorAxisRects: IndicatorAxisRect[] = [];
  private tpoMergeLeftSessionStarts: ReadonlySet<number> = new Set();
  private tpoProfileHitZones: TpoProfileHitZone[] = [];
  private interactionHudWasActive = false;
  private interactionHudSyncTime: number | null = null;
  private partialTailRedrawEnabled = false;
  private interactionQualityController: InteractionQualityController | null = null;
  /** Per-chart görünüm config'i (runtime set eder); null ise global settings. */
  private chartConfig: ChartViewConfig | null = null;
  private readonly axisCache = new AxisLayerCache();
  private readonly annotationPassCache = new AnnotationPassCache<{
    price: PriceMarker[]; time: TimeMarker[]; labels: LineLabelEntry[]; tpoHits: TpoProfileHitZone[];
  }>();
  private readonly cellTextCache = new WeakMap<FootprintBar, BarCellTextCacheEntry>();
  private readonly hudDeps: HudRendererDeps;
  private readonly tpoHost: TpoRenderHost;
  private readonly interactionHost: InteractionOverlayHost;
  private readonly annotationHost: AnnotationRendererHost;

  getPriceScaleControlAt(x: number, y: number): PriceScaleControlId | null {
    const hit = this.priceScaleControlRects.find((rect) =>
      x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
    );
    return hit?.id ?? null;
  }

  /** True over the touch corner menu button drawn by the last interaction frame. */
  getMenuButtonAt(x: number, y: number): boolean {
    return this.touchMenuButton !== null && pointInTouchControl(this.touchMenuButton, x, y);
  }

  /** Screen rect of that button, for anchoring the menu it opens. */
  getMenuButtonRect(): Readonly<TouchMenuButtonRect> | null {
    return this.touchMenuButton;
  }

  getIndicatorScaleControlAt(x: number, y: number): { paneId: string; id: PriceScaleControlId } | null {
    const hit = this.indicatorScaleControlRects.find((rect) =>
      x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
    );
    return hit ? { paneId: hit.paneId, id: hit.id } : null;
  }

  getActiveVolumeProfileLevels(): { poc: number | null; vah: number | null; val: number | null } | null {
    if (!this.profileCache?.result) return null;
    return {
      poc: this.profileCache.result.poc ?? null,
      vah: this.profileCache.result.vah ?? null,
      val: this.profileCache.result.val ?? null,
    };
  }

  getIndicatorAxisPaneAt(x: number, y: number): string | null {
    const hit = this.indicatorAxisRects.find((rect) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h);
    return hit?.paneId ?? null;
  }

  getIndicatorPaneAt(x: number, y: number): string | null {
    const hit = this.indicatorAxisRects.find((rect) =>
      x >= rect.plotX && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
    );
    return hit?.paneId ?? null;
  }

  toggleIndicatorScaleMode(paneId: string): "linear" | "log" | null {
    const pane = (this.getIndicatorPanes?.() ?? []).find((item) => item.id === paneId);
    return pane?.toggleScaleMode() ?? null;
  }

  setTpoMergeLeftSessionStarts(starts: ReadonlySet<number>): void {
    this.tpoMergeLeftSessionStarts = starts;
  }

  getTpoProfileAt(x: number, y: number): TpoProfileHit | null {
    const hit = this.tpoProfileHitZones.find((zone) =>
      x >= zone.left && x <= zone.right && Number.isFinite(y)
    );
    if (!hit) return null;
    return {
      sessionStart: hit.sessionStart,
      groupSessionStarts: [...hit.groupSessionStarts],
      canMergeLeft: hit.canMergeLeft,
      canUndoMerges: hit.canUndoMerges,
    };
  }

  constructor(
    private ctx: CanvasRenderingContext2D,
    private readonly drawForeground?: (
      ctx: CanvasRenderingContext2D,
      view: View,
      series: FootprintSeries
    ) => void,
    private readonly getProfileSettings?: () => VolumeProfileSettings,
    private readonly getPreviousWeekStrategySettings?: () => PreviousWeekStrategySettings,
    private readonly getPreviousWeekStrategyLevels?: () => PreviousWeekStrategyLevel[],
    private readonly getMondayRangeSettings?: () => MondayRangeSettings,
    private readonly getMondayRangeLevels?: () => MondayRangeLevel[],
    private readonly getNakedPocs?: () => NakedPocLevel[],
    private readonly getReferenceLevels?: () => ReferenceLevel[],
    private readonly getIndicatorPanes?: () => IndicatorPaneRender[],
    private readonly getIndicatorPriceOverlays?: () => IndicatorPaneRender[],
    /** Optional callback to fetch the sync crosshair time for ghost crosshair. */
    private readonly getSyncCrosshairTime?: () => number | null,
    /** Optional test/diagnostic callback exposing the canonical HUD text. */
    private readonly onHudText?: (text: string | null) => void,
    /**
     * Draws an indicator sub-pane's background band. Injected by the caller
     * (features/indicators owns the implementation) so core/render never
     * imports features at runtime.
     */
    private readonly drawIndicatorPaneBackgroundFn?: (
      ctx: CanvasRenderingContext2D,
      view: View,
      rect: { top: number; height: number }
    ) => void,
    private readonly isMainChartSuppressed?: () => boolean,
    private interactionCtx?: CanvasRenderingContext2D,
    private readonly drawInteractionForeground?: (ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries) => void,
    /** Orderbook heatmap cells, drawn under every other annotation. */
    private readonly drawOrderbookHeatmap?: (
      ctx: CanvasRenderingContext2D,
      view: View,
      series: FootprintSeries,
      range: [number, number],
    ) => boolean | void,
    /** Orderbook hover table, drawn with the HUD. */
    private readonly drawOrderbookHover?: (
      ctx: CanvasRenderingContext2D,
      view: View,
      series: FootprintSeries,
      crosshair: Crosshair,
    ) => void,
    private readonly getDisplayOptions?: () => ResolvedChartDisplayOptions,
    private readonly hasLiveSeriesDrawings?: () => boolean,
    private readonly isOpenBarLiveOnly?: (bar: FootprintBar) => boolean,
    private readonly shouldSkipFootprintText?: () => boolean,
    private readonly onShowNotionalChange?: (show: boolean) => void,
  ) {
    const self = this;
    this.hudDeps = {
      get showNotional() { return self.showNotional; },
      get displayOptions() { return self.displayOptions; },
      get getSyncCrosshairTime() { return self.getSyncCrosshairTime; },
      get onHudText() { return self.onHudText; },
      get isOpenBarLiveOnly() { return self.isOpenBarLiveOnly; },
    };
    this.tpoHost = {
      get ctx() { return self.ctx; },
      get chartConfig() { return self.chartConfig; },
      get tpoCache() { return self.tpoCache; },
      set tpoCache(value) { self.tpoCache = value; },
      get tpoMergeLeftSessionStarts() { return self.tpoMergeLeftSessionStarts; },
      get getProfileSettings() { return self.getProfileSettings; },
      pushTpoProfileHitZone(zone) { self.tpoProfileHitZones.push(zone); },
    };
    this.interactionHost = {
      get ctx() { return self.ctx; },
      get interactionCtx() { return self.interactionCtx; },
      get showNotional() { return self.showNotional; },
      get displayOptions() { return self.displayOptions; },
      get getSyncCrosshairTime() { return self.getSyncCrosshairTime; },
      get onHudText() { return self.onHudText; },
      get isOpenBarLiveOnly() { return self.isOpenBarLiveOnly; },
      get isMainChartSuppressed() { return self.isMainChartSuppressed; },
      get getIndicatorPanes() { return self.getIndicatorPanes; },
      get drawInteractionForeground() { return self.drawInteractionForeground; },
      get drawOrderbookHover() { return self.drawOrderbookHover; },
      resetInteractionHitRects() {
        self.priceScaleControlRects = [];
        self.indicatorScaleControlRects = [];
        self.touchMenuButton = null;
      },
      setPriceScaleControlRects(rects) { self.priceScaleControlRects = rects; },
      pushIndicatorScaleControlRects(rects) { self.indicatorScaleControlRects.push(...rects); },
      setTouchMenuButton(rect) { self.touchMenuButton = rect; },
    };
    this.annotationHost = {
      get ctx() { return self.ctx; },
      get showNotional() { return self.showNotional; },
      get chartConfig() { return self.chartConfig; },
      get profileCache() { return self.profileCache; },
      set profileCache(value) { self.profileCache = value; },
      get cellTextCache() { return self.cellTextCache; },
      get lineLabels() { return self.lineLabels; },
      get getProfileSettings() { return self.getProfileSettings; },
      get getPreviousWeekStrategySettings() { return self.getPreviousWeekStrategySettings; },
      get getPreviousWeekStrategyLevels() { return self.getPreviousWeekStrategyLevels; },
      get getMondayRangeSettings() { return self.getMondayRangeSettings; },
      get getMondayRangeLevels() { return self.getMondayRangeLevels; },
      get getNakedPocs() { return self.getNakedPocs; },
      get getReferenceLevels() { return self.getReferenceLevels; },
      get getIndicatorPanes() { return self.getIndicatorPanes; },
      get getIndicatorPriceOverlays() { return self.getIndicatorPriceOverlays; },
      get drawIndicatorPaneBackgroundFn() { return self.drawIndicatorPaneBackgroundFn; },
      pushIndicatorAxisRect(rect) { self.indicatorAxisRects.push(rect); },
      pushIndicatorScaleControlRects(rects) { self.indicatorScaleControlRects.push(...rects); },
      queueLineObject(price, text, color, priority) { self.queueLineObject(price, text, color, priority); },
      queuePriceMarker(price, color, priority) { self.queuePriceMarker(price, color, priority); },
    };
  }

  private readonly defaultDisplayOptions = resolveChartDisplayOptions(undefined);

  private get displayOptions(): ResolvedChartDisplayOptions {
    return this.getDisplayOptions?.() ?? this.defaultDisplayOptions;
  }

  /** Enable or disable opt-in dirty-region partial tail redraw on DataTail frames (default: false). */
  setPartialTailRedrawEnabled(enabled: boolean): void {
    this.partialTailRedrawEnabled = Boolean(enabled);
  }

  /** Whether opt-in dirty-region partial tail redraw is enabled. */
  isPartialTailRedrawEnabled(): boolean {
    return this.partialTailRedrawEnabled;
  }

  /** Attach or detach the optional adaptive pan/zoom interaction quality controller. */
  setInteractionQualityController(controller: InteractionQualityController | null): void {
    this.interactionQualityController = controller;
  }

  /** Whether opt-in adaptive reduced quality is currently active for non-critical dense text. */
  isAdaptiveReducedQualityActive(): boolean {
    const snapshot = this.interactionQualityController?.getSnapshot();
    return snapshot?.qualityLevel === "reduced" && snapshot.suppressDenseFootprintText;
  }

  /** Clear cached axis offscreen bitmaps so the next render rebuilds them from fresh state. */
  invalidateAxisCache(): void {
    this.axisCache.invalidate();
  }

  /** Invalidate all warm retained annotation/profile/TPO/axis caches after context restoration. */
  invalidateWarmCaches(): void {
    this.axisCache.invalidate();
    this.annotationPassCache.clear();
    this.profileCache = null;
    this.tpoCache = null;
  }

  /** Replace the annotation 2D context after context restoration and drop warm caches. */
  updateContext(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
    this.invalidateWarmCaches();
  }

  /** Replace the interaction 2D context after context restoration. */
  updateInteractionContext(ctx: CanvasRenderingContext2D): void {
    this.interactionCtx = ctx;
  }

  /** Release offscreen axis canvases and transient overlay buffers. */
  dispose(): void {
    this.axisCache.dispose();
    this.annotationPassCache.clear();
    this.profileCache = null;
    this.tpoCache = null;
    this.priceMarkers = [];
    this.timeMarkers = [];
    this.lineLabels = [];
    this.priceScaleControlRects = [];
    this.indicatorScaleControlRects = [];
    this.touchMenuButton = null;
    this.indicatorAxisRects = [];
    this.tpoProfileHitZones = [];
  }

  /** Static/semi-static Canvas2D surface. Scene layer order is the render authority. */
  renderAnnotations(
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    range: [number, number],
    layerOrder?: readonly string[],
    changes: ChartChange = ChartChange.None,
    asOfTime?: number,
  ): void {
    let ctx = this.ctx;
    const orderedLayers = layerOrder ?? [
      "orderbook-heatmap",
      "footprint-text",
      "volume-profile",
      "tpo",
      "strategy-levels",
      "naked-poc",
      "reference-levels",
      "drawings",
      "indicators",
      "last-price",
      "axis",
    ];
    const transform = ctx.getTransform?.();
    const skipFootprintText =
      this.shouldSkipFootprintText?.() === true || this.isAdaptiveReducedQualityActive();
    this.annotationPassCache.begin(changes, JSON.stringify([ctx.canvas.width, ctx.canvas.height, transform?.a, transform?.d, view.area, view.offsetX, view.colWidth, view.priceTop, view.pricePerPx, range, series.length, series.at(series.length - 1)?.startTime, series.config.priceStep, series.nonTailRevision, orderedLayers, asOfTime, skipFootprintText]));
    const telemetryEnabled = isPerformanceTelemetryEnabled();
    const setupStartedAt = telemetryEnabled ? performance.now() : null;
    const empty = series.length === 0;
    const mainSuppressed = this.isMainChartSuppressed?.() === true;
    const partialDirtyRect = this.resolvePartialTailDirtyRect(
      ctx,
      transform,
      view,
      series,
      crosshair,
      orderedLayers,
      changes,
      empty,
      mainSuppressed,
      skipFootprintText,
    );
    if (this.partialTailRedrawEnabled) {
      incrementPerformanceCounter(
        partialDirtyRect ? "chart.annotation.partial.hit" : "chart.annotation.partial.fallback",
      );
    }
    if (partialDirtyRect) {
      ctx.save();
      ctx.setTransform?.(1, 0, 0, 1, 0, 0);
      ctx.beginPath?.();
      ctx.rect?.(partialDirtyRect.x, partialDirtyRect.y, partialDirtyRect.width, partialDirtyRect.height);
      ctx.clip?.();
      ctx.clearRect(partialDirtyRect.x, partialDirtyRect.y, partialDirtyRect.width, partialDirtyRect.height);
      if (transform) {
        ctx.setTransform?.(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
      }
    } else {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.save();
    }
    this.priceMarkers = [];
    this.timeMarkers = [];
    this.lineLabels = [];
    this.indicatorAxisRects = [];
    this.tpoProfileHitZones = [];
    if (setupStartedAt !== null) recordPerformanceDuration("chart.annotation.setup.ms", performance.now() - setupStartedAt);

    let indicatorBatchDrawn = false;
    let canRetainTpo = changes === ChartChange.DataTail;

    for (const layerId of orderedLayers) {
      const isIndicatorLayer = layerId === "indicators" || layerId.startsWith("indicator:");
      if (isIndicatorLayer && (indicatorBatchDrawn || empty)) continue;
      if (layerId !== "orderbook-heatmap" && layerId !== "volume-profile" &&
        layerId !== "footprint-text" && layerId !== "tpo") canRetainTpo = false;
      const metricLayer = isIndicatorLayer ? "indicators" : layerId;
      const layerStartedAt = telemetryEnabled ? performance.now() : null;
      const paint = () => {
        try {
          if (isIndicatorLayer) {
            indicatorBatchDrawn = true;
            drawSubPanes(this.annotationHost, view, series, range, crosshair, false);
            if (!mainSuppressed) drawIndicatorPriceOverlays(this.annotationHost, view, series, range, crosshair);
            return;
          }

          if (layerId === "axis") {
            if (!mainSuppressed && !empty) {
              drawLineLabels(this.annotationHost, view);
              this.axisCache.renderPriceAxis(
                ctx,
                view,
                series,
                priceAxisKeepOut(view, crosshair),
                this.displayOptions,
              );

            }
            this.axisCache.renderTimeAxis(ctx, view, series, this.timeMarkers);
            return;
          }

          if (empty || mainSuppressed) return;
          switch (layerId) {
            case "orderbook-heatmap":
              if (this.drawOrderbookHeatmap && this.drawOrderbookHeatmap(ctx, view, series, range) !== false) {
                canRetainTpo = false;
              }
              break;
            case "footprint-text":
              if (skipFootprintText) break;
              if ((this.chartConfig ?? settings).chartType !== "tpo") canRetainTpo = false;
              this.paintRetainedAnnotationPass("closed-footprint-text", "", changes, () => {
                drawCells(this.annotationHost, view, series, [range[0], Math.min(range[1], series.length - 1)]);
              }, false, partialDirtyRect ?? undefined);
              if (range[1] > series.length - 1) drawCells(this.annotationHost, view, series, [Math.max(range[0], series.length - 1), range[1]]);
              break;
            case "volume-profile":
              if (settings.volumeProfile) canRetainTpo = false;
              drawVolumeProfile(this.annotationHost, view, series, range);
              break;
            case "tpo": {
              // Compositing the closed prefix is exact on a cleared surface.
              // With an underlay, paint directly to preserve blending order.
              const retain = canRetainTpo ? (key: string, draw: () => void) => {
                const transformKey = transform ? [transform.b, transform.c, transform.e, transform.f].join("|") : "";
                if (this.paintRetainedAnnotationPass("closed-tpo", transformKey + key, changes, draw, false, partialDirtyRect ?? undefined)) {
                  incrementPerformanceCounter("chart.annotation.pass.closed-tpo.reuse");
                }
              } : undefined;
              drawTpo(this.tpoHost, view, series, range, retain);
              canRetainTpo = false;
              break;
            }
            case "strategy-levels":
              drawPreviousWeekStrategy(this.annotationHost, view, series);
              drawMondayRange(this.annotationHost, view, series);
              break;
            case "naked-poc":
              drawNakedPocs(this.annotationHost, view, series);
              break;
            case "reference-levels":
              drawReferenceLevels(this.annotationHost, view, series);
              break;
            case "drawings":
              this.drawForeground?.(ctx, view, series);
              break;
            case "last-price":
              if (settings.lastPrice) drawLastPrice(this.annotationHost, view, series);
              break;
          }
        } finally {
          if (layerStartedAt !== null) {
            recordPerformanceDuration(`chart.annotation.layer.${metricLayer}.ms`, performance.now() - layerStartedAt);
          }
        }
      };
      const key = this.layerCacheKey(layerId, crosshair);
      const livePass = layerId === "drawings" && (this.hasLiveSeriesDrawings?.() ?? false);
      const retained = this.paintRetainedAnnotationPass(layerId, key, changes, () => {
        const main = ctx;
        ctx = this.ctx;
        try { paint(); } finally { ctx = main; }
      }, livePass, partialDirtyRect ?? undefined);
      if (retained) incrementPerformanceCounter(`chart.annotation.pass.${metricLayer}.reuse`);
      if (layerId === "axis" && !mainSuppressed && !empty) {
        drawPriceMarkers(ctx, view, this.priceMarkers, series.config.priceStep, series.config.pricePrecision, this.displayOptions);
      }
    }

    if (empty || mainSuppressed) this.onHudText?.(null);
    else if (!crosshair.visible) {
      // The default latest-bar HUD depends on tail data, so keep it on Annotation.
      drawHud(ctx, view, series, crosshair, range, this.hudDeps);
    }
    ctx.restore();
  }

  private cachedNakedPocRef: unknown = undefined;
  private cachedNakedPocKey = "";
  private cachedStrategyKeyRefs: readonly [unknown, unknown, unknown, unknown] | null = null;
  private cachedStrategyKey = "";
  private cachedReferenceLevelsRef: unknown = undefined;
  private cachedReferenceLevelsKey = "";

  private layerCacheKey(layerId: string, crosshair: Crosshair): string {
    switch (layerId) {
      case "axis": {
        let key = crosshair.touch ? "1|" : "0|";
        for (let i = 0; i < this.lineLabels.length; i++) {
          const l = this.lineLabels[i];
          key += `${l.price},${l.text},${l.color};`;
        }
        key += "|";
        for (let i = 0; i < this.timeMarkers.length; i++) {
          const m = this.timeMarkers[i];
          key += `${m.time},${m.text},${m.color},${m.priority};`;
        }
        return key;
      }
      case "naked-poc": {
        const val = this.getNakedPocs?.() ?? null;
        if (val === this.cachedNakedPocRef && this.cachedNakedPocKey !== "") {
          return this.cachedNakedPocKey;
        }
        this.cachedNakedPocRef = val;
        this.cachedNakedPocKey = JSON.stringify(val);
        return this.cachedNakedPocKey;
      }
      case "strategy-levels": {
        const s1 = this.getPreviousWeekStrategySettings?.() ?? null;
        const l1 = this.getPreviousWeekStrategyLevels?.() ?? null;
        const s2 = this.getMondayRangeSettings?.() ?? null;
        const l2 = this.getMondayRangeLevels?.() ?? null;
        const prev = this.cachedStrategyKeyRefs;
        if (prev && prev[0] === s1 && prev[1] === l1 && prev[2] === s2 && prev[3] === l2 && this.cachedStrategyKey !== "") {
          return this.cachedStrategyKey;
        }
        this.cachedStrategyKeyRefs = [s1, l1, s2, l2];
        this.cachedStrategyKey = JSON.stringify([s1, l1, s2, l2]);
        return this.cachedStrategyKey;
      }
      case "reference-levels": {
        const val = this.getReferenceLevels?.() ?? null;
        if (val === this.cachedReferenceLevelsRef && this.cachedReferenceLevelsKey !== "") {
          return this.cachedReferenceLevelsKey;
        }
        this.cachedReferenceLevelsRef = val;
        this.cachedReferenceLevelsKey = JSON.stringify(val);
        return this.cachedReferenceLevelsKey;
      }
      default:
        return "";
    }
  }

  private resolvePartialTailDirtyRect(
    ctx: CanvasRenderingContext2D,
    transform: DOMMatrix | undefined,
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    orderedLayers: readonly string[],
    changes: ChartChange,
    empty: boolean,
    mainSuppressed: boolean,
    skipFootprintText: boolean,
  ): AnnotationDirtyRect | null {
    if (!this.partialTailRedrawEnabled) return null;
    if (changes !== ChartChange.DataTail || empty || mainSuppressed) return null;
    if (!this.annotationPassCache.isSameGeometry()) return null;
    if (ctx.canvas.width <= 0 || ctx.canvas.height <= 0) return null;
    if (
      transform &&
      (transform.b !== 0 || transform.c !== 0 ||
        !Number.isFinite(transform.a) || !Number.isFinite(transform.d) ||
        transform.a <= 0 || transform.d <= 0)
    ) {
      return null;
    }
    const dpr = transform?.a ?? view.pixelRatio ?? 1;
    if (!Number.isFinite(dpr) || dpr <= 0) return null;
    const totalHeight = Math.max(0, view.area.height + (view.subPanesH ?? 0));
    const lastBarX = view.xOfIndex(series.length - 1);
    const lastBarRect = alignDirtyRectToDevicePixels(
      { x: lastBarX, y: view.area.top, width: view.colWidth, height: totalHeight },
      dpr,
      ctx.canvas.width,
      ctx.canvas.height,
    );
    const priceAxisRect = alignDirtyRectToDevicePixels(
      { x: view.area.left + view.area.width, y: view.area.top, width: view.priceAxisW, height: totalHeight },
      dpr,
      ctx.canvas.width,
      ctx.canvas.height,
    );
    const dirty = unionDirtyRects(lastBarRect, priceAxisRect);
    if (dirty.width <= 0 || dirty.height <= 0) return null;
    if (shouldFallbackToFullRedraw(dirty, ctx.canvas.width, ctx.canvas.height)) return null;
    for (const layerId of orderedLayers) {
      if (layerId === "footprint-text") {
        if (!skipFootprintText && !this.annotationPassCache.canHit(annotationPass("closed-footprint-text"), "", changes)) {
          return null;
        }
        continue;
      }
      const livePass = layerId === "drawings" && (this.hasLiveSeriesDrawings?.() ?? false);
      const pass = annotationPass(layerId, livePass);
      if ((pass.interests & ChartChange.DataTail) === 0) {
        if (!this.annotationPassCache.canHit(pass, this.layerCacheKey(layerId, crosshair), changes)) {
          return null;
        }
      }
    }
    return dirty;
  }

  private paintRetainedAnnotationPass(
    id: string,
    key: string,
    changes: ChartChange,
    draw: () => void,
    live = false,
    dirtyRect?: AnnotationDirtyRect,
  ): boolean {
    const main = this.ctx;
    const handled = this.annotationPassCache.render(main, annotationPass(id, live), key, changes, (target) => {
      const priceStart = this.priceMarkers.length;
      const timeStart = this.timeMarkers.length;
      const labelStart = this.lineLabels.length;
      const tpoHitStart = this.tpoProfileHitZones.length;
      this.ctx = target;
      try { draw(); } finally { this.ctx = main; }
      return {
        price: this.priceMarkers.slice(priceStart), time: this.timeMarkers.slice(timeStart),
        labels: this.lineLabels.slice(labelStart), tpoHits: this.tpoProfileHitZones.slice(tpoHitStart),
      };
    }, (effects) => {
      this.priceMarkers.push(...effects.price);
      this.timeMarkers.push(...effects.time);
      this.lineLabels.push(...effects.labels);
      this.tpoProfileHitZones.push(...effects.tpoHits);
    }, dirtyRect);
    if (!handled) draw();
    return handled === "hit";
  }

  /** High-frequency pointer/selection surface. Scene layer order is the render authority. */
  renderInteraction(
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    range: [number, number],
    layerOrder?: readonly string[],
  ): void {
    renderInteractionPass(this.interactionHost, view, series, crosshair, range, layerOrder);
  }

  /** Whether an interaction changed Annotation-owned HUD visibility or synchronized selection. */
  hasInteractionDependentHudContent(crosshair: Crosshair): boolean {
    const syncTime = this.getSyncCrosshairTime?.() ?? null;
    const redraw = crosshair.visible !== this.interactionHudWasActive || syncTime !== this.interactionHudSyncTime;
    this.interactionHudWasActive = crosshair.visible;
    this.interactionHudSyncTime = syncTime;
    return redraw;
  }

  /** Whether an active crosshair selects the changing tail bar and needs a refreshed label. */
  hasTailDependentInteractionContent(
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    range: [number, number],
    layerOrder?: readonly string[],
  ): boolean {
    void range;
    if (series.length === 0 || !crosshair.visible) return false;
    const orderedLayers = layerOrder ?? ["crosshair", "hud", "interaction-controls"];
    if (!orderedLayers.includes("crosshair")) return false;
    return Math.floor(view.indexOfX(crosshair.x)) === series.length - 1;
  }

  /** Temporary bounded coupling: indicator legend/readouts still receive crosshair in their draw contract. */
  requiresInteractionRedraw(): boolean {
    return (this.getIndicatorPanes?.().length ?? 0) > 0 || (this.getIndicatorPriceOverlays?.().length ?? 0) > 0;
  }

  /** ChartRuntime her state değişiminde effective config'i buraya iter. */
  setChartConfig(config: ChartViewConfig): void {
    this.chartConfig = config;
  }

  queueLineObject(price: number, text: string, color: string, priority = lineLabelPriority(text)): void {
    this.lineLabels.push({ price, text, color, priority });
    this.queuePriceMarker(price, color, Math.max(35, priority - 10));
  }

  queuePriceMarker(price: number, color: string, priority = 50): void {
    this.priceMarkers.push({ price, color, priority });
  }

  queuePriceAxisLabel(price: number, text: string, color: string, priority = lineLabelPriority(text)): void {
    this.priceMarkers.push({ price, text, color, priority });
  }

  queueTimeObject(time: number, text: string, color: string, priority = lineLabelPriority(text)): void {
    this.timeMarkers.push({ time, text, color, priority });
  }
}
