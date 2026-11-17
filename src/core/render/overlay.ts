import { ChartChange } from "./scene/chartScene.js";
import { annotationPass, AnnotationPassCache } from "./overlay/annotationPassCache.js";
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
  type FormattedCellText,
  type IndicatorAxisRect,
  type LineLabelEntry,
  type VolumeProfileCacheState,
} from "./overlay/annotationRenderer.js";

export type { Crosshair } from "./overlay/interactionOverlayRenderer.js";
export type { TpoProfileHit } from "./overlay/tpoPaintHelpers.js";

export class Overlay {
  /** When true, cell/HUD volumes are shown as USDT notional (qty * price). */
  showNotional = true;
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
  /** Per-chart görünüm config'i (runtime set eder); null ise global settings. */
  private chartConfig: ChartViewConfig | null = null;
  private readonly axisCache = new AxisLayerCache();
  private readonly annotationPassCache = new AnnotationPassCache<{ price: PriceMarker[]; time: TimeMarker[]; labels: LineLabelEntry[] }>();
  private readonly cellTextCache = new WeakMap<FootprintBar, { key: string; cellRevision: number; entries: Map<number, FormattedCellText> }>();
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
    private readonly interactionCtx?: CanvasRenderingContext2D,
    private readonly drawInteractionForeground?: (ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries) => void,
    /** Orderbook heatmap cells, drawn under every other annotation. */
    private readonly drawOrderbookHeatmap?: (
      ctx: CanvasRenderingContext2D,
      view: View,
      series: FootprintSeries,
      range: [number, number],
    ) => void,
    /** Orderbook hover table, drawn with the HUD. */
    private readonly drawOrderbookHover?: (
      ctx: CanvasRenderingContext2D,
      view: View,
      series: FootprintSeries,
      crosshair: Crosshair,
    ) => void,
    private readonly getDisplayOptions?: () => ResolvedChartDisplayOptions,
    private readonly hasLiveSeriesDrawings?: () => boolean,
  ) {
    const self = this;
    this.hudDeps = {
      get showNotional() { return self.showNotional; },
      get displayOptions() { return self.displayOptions; },
      get getSyncCrosshairTime() { return self.getSyncCrosshairTime; },
      get onHudText() { return self.onHudText; },
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

  /** Clear cached axis offscreen bitmaps so the next render rebuilds them from fresh state. */
  invalidateAxisCache(): void {
    this.axisCache.invalidate();
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
    this.annotationPassCache.begin(changes, JSON.stringify([ctx.canvas.width, ctx.canvas.height, transform?.a, transform?.d, view.area, view.offsetX, view.colWidth, view.priceTop, view.pricePerPx, range, series.length, series.at(series.length - 1)?.startTime, series.config.priceStep, series.nonTailRevision, orderedLayers, asOfTime]));
    const telemetryEnabled = isPerformanceTelemetryEnabled();
    const setupStartedAt = telemetryEnabled ? performance.now() : null;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.save();
    this.priceMarkers = [];
    this.timeMarkers = [];
    this.lineLabels = [];
    this.indicatorAxisRects = [];
    this.tpoProfileHitZones = [];
    if (setupStartedAt !== null) recordPerformanceDuration("chart.annotation.setup.ms", performance.now() - setupStartedAt);

    const empty = series.length === 0;
    const mainSuppressed = this.isMainChartSuppressed?.() === true;
    let indicatorBatchDrawn = false;

    for (const layerId of orderedLayers) {
      const isIndicatorLayer = layerId === "indicators" || layerId.startsWith("indicator:");
      if (isIndicatorLayer && (indicatorBatchDrawn || empty)) continue;
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
              this.drawOrderbookHeatmap?.(ctx, view, series, range);
              break;
            case "footprint-text":
              this.paintRetainedAnnotationPass("closed-footprint-text", "", changes, () => {
                drawCells(this.annotationHost, view, series, [range[0], Math.min(range[1], series.length - 1)]);
              });
              if (range[1] > series.length - 1) drawCells(this.annotationHost, view, series, [Math.max(range[0], series.length - 1), range[1]]);
              break;
            case "volume-profile":
              drawVolumeProfile(this.annotationHost, view, series, range);
              break;
            case "tpo":
              drawTpo(this.tpoHost, view, series, range);
              break;
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
      }, livePass);
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

  private layerCacheKey(layerId: string, crosshair: Crosshair): string {
    switch (layerId) {
      case "axis":
        return JSON.stringify([this.lineLabels, this.timeMarkers, crosshair.touch]);
      case "naked-poc":
        return JSON.stringify(this.getNakedPocs?.() ?? null);
      case "strategy-levels":
        return JSON.stringify([
          this.getPreviousWeekStrategySettings?.() ?? null,
          this.getPreviousWeekStrategyLevels?.() ?? null,
          this.getMondayRangeSettings?.() ?? null,
          this.getMondayRangeLevels?.() ?? null,
        ]);
      case "reference-levels":
        return JSON.stringify(this.getReferenceLevels?.() ?? null);
      default:
        return "";
    }
  }

  private paintRetainedAnnotationPass(
    id: string,
    key: string,
    changes: ChartChange,
    draw: () => void,
    live = false,
  ): boolean {
    const main = this.ctx;
    const handled = this.annotationPassCache.render(main, annotationPass(id, live), key, changes, (target) => {
      const priceStart = this.priceMarkers.length;
      const timeStart = this.timeMarkers.length;
      const labelStart = this.lineLabels.length;
      this.ctx = target;
      try { draw(); } finally { this.ctx = main; }
      return { price: this.priceMarkers.slice(priceStart), time: this.timeMarkers.slice(timeStart), labels: this.lineLabels.slice(labelStart) };
    }, (effects) => {
      this.priceMarkers.push(...effects.price);
      this.timeMarkers.push(...effects.time);
      this.lineLabels.push(...effects.labels);
    });
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
