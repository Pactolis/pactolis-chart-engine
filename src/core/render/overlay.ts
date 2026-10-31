// Canvas2D layer: cell volume numbers, price/time axes, crosshair, HUD.
import type { View } from "../engine/view.js";
import { cellImbalance, type FootprintSeries } from "../model/footprint.js";
import { cellAverageTradeSize, cellAverageTradeSizes, cellDeltaPercent, cellTradeCounts, quoteVolumeForBar } from "../model/footprintCellMetrics.js";
import { settings, type ChartViewConfig } from "../settings.js";
import { cellTextModeFor } from "./chartLod.js";
import type { IndicatorPaneRender } from "../indicatorTypes.js";
import {
  drawIndicatorScaleControls,
  drawPriceScaleControls,
  touchPriceScaleControlSpan,
  type IndicatorScaleControlRect,
  type PriceScaleControlId,
  type PriceScaleControlRect,
} from "./axisControlsRenderer.js";
import {
  drawTouchMenuButton,
  pointInTouchControl,
  touchMenuButtonRect,
  TOUCH_MENU_BUTTON_RESERVE,
  type TouchMenuButtonRect,
} from "./touchControlsRenderer.js";
import { HUD_ROW_HEIGHT, hudMaxRows, layoutHud, type HudPart } from "./hudLayout.js";
import { configDecimals, placeVerticalLabels } from "../axisLabelUtils.js";
import { drawCrosshairPriceLabel, drawPriceAxis, drawPriceMarkers, type PriceAxisKeepOut, type PriceMarker } from "./priceAxisRenderer.js";
import { drawCrosshairTimeLabel, drawTimeAxis, type TimeMarker } from "./timeAxisRenderer.js";
import {
  calculateVolumeProfile,
  sessionBars,
  type VolumeProfileResult,
  type VolumeProfileSettings,
} from "../analysis/volumeProfile.js";
import {
  aggregateTpoBrackets,
  buildTpoBracketSpans,
  calculateTpoProfile,
  effectiveTpoBracketMs,
  mergeTpoSessionSpans,
  tpoBracketLabel,
} from "../analysis/tpoProfile.js";
import type { NakedPocLevel } from "../analysis/nakedPoc.js";
import type { ReferenceLevel } from "../analysis/referenceLevels.js";
import type { PreviousWeekStrategyLevel, PreviousWeekStrategySettings } from "../analysis/previousWeekStrategy.js";
import type { MondayRangeLevel, MondayRangeSettings } from "../analysis/mondayRange.js";
import type { StrategyLevel, StrategyLineStyle } from "../analysis/strategyLevels.js";
import { periodPrefix, periodUnit } from "../analysis/periods.js";
import { uiColor, tpoPalette, cellDimSell, cellDimBuy, nakedPocPalette, lineLabelPillBg, crosshairLineColor, syncCrosshairLineColor } from "../ui/seriesPalette.js";
import { levelStartX } from "./levelAnchor.js";
import { isPerformanceTelemetryEnabled, recordPerformanceDuration } from "../performanceTelemetry.js";

export interface Crosshair {
  x: number;
  y: number;
  visible: boolean;
  /** The user is on a touch screen: the overlay shows finger-sized scale buttons and the corner menu button. */
  touch?: boolean;
}

export interface TpoProfileHit {
  sessionStart: number;
  groupSessionStarts: readonly number[];
  canMergeLeft: boolean;
  canUndoMerges: boolean;
}

interface TpoProfileHitZone extends TpoProfileHit {
  left: number;
  right: number;
}

function fmtVol(v: number): string {
  if (v >= 1000) return (v / 1000).toFixed(1) + "k";
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(3);
}

/** Format a USDT notional value (qty * price) compactly. */
function fmtNotional(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(0);
}

function lineLabelPriority(text: string): number {
  if (/current|last/i.test(text)) return 100;
  if (/PPOC|POC|NPOC/i.test(text)) return 70;
  if (/VAH|VAL|VWAP/i.test(text)) return 60;
  if (/LVW|HVW|D-H|D-L|H-H|H-L/i.test(text)) return 50;
  return 40;
}

const TPO_BLOCK_TONES = [-0.2, -0.1, 0.03, -0.15, 0.07, -0.05];
const TPO_MIN_BLOCK_CELL_HEIGHT = 2;
const TPO_MIN_BLOCK_CELL_WIDTH = 1.5;
const tpoBlockColorCache = new Map<string, string>();

function tpoBlockFillColor(baseColor: string, bracketIndex: number): string {
  const toneIndex = Math.abs(bracketIndex) % TPO_BLOCK_TONES.length;
  const key = `${baseColor}:${toneIndex}`;
  const cached = tpoBlockColorCache.get(key);
  if (cached) return cached;
  const color = mixHexColor(baseColor, TPO_BLOCK_TONES[toneIndex]);
  tpoBlockColorCache.set(key, color);
  return color;
}

function mixHexColor(hex: string, amount: number): string {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  if (raw.length !== 6) return hex;
  const value = Number.parseInt(raw, 16);
  if (!Number.isFinite(value)) return hex;
  const mix = amount < 0 ? 0 : 255;
  const ratio = Math.min(1, Math.abs(amount));
  const r = ((value >> 16) & 255) + (mix - ((value >> 16) & 255)) * ratio;
  const g = ((value >> 8) & 255) + (mix - ((value >> 8) & 255)) * ratio;
  const b = (value & 255) + (mix - (value & 255)) * ratio;
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function toHexByte(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

export class Overlay {
  /** When true, cell/HUD volumes are shown as USDT notional (qty * price). */
  showNotional = true;
  private profileCache: { key: string; result: VolumeProfileResult; maxVolume: number } | null = null;
  private tpoCache: { key: string; groups: { sessionStarts: number[]; firstBracketIndex: number; lastBracketIndex: number; firstIdx: number; lastIdx: number; firstSpanIndex: number; result: ReturnType<typeof calculateTpoProfile> }[] } | null = null;
  private priceMarkers: PriceMarker[] = [];
  private timeMarkers: TimeMarker[] = [];
  private lineLabels: { price: number; text: string; color: string; priority: number }[] = [];
  private priceScaleControlRects: PriceScaleControlRect[] = [];
  private indicatorScaleControlRects: IndicatorScaleControlRect[] = [];
  private touchMenuButton: TouchMenuButtonRect | null = null;
  private indicatorAxisRects: Array<{ paneId: string; plotX: number; x: number; y: number; w: number; h: number }> = [];
  private tpoMergeLeftSessionStarts: ReadonlySet<number> = new Set();
  private tpoProfileHitZones: TpoProfileHitZone[] = [];
  /** Per-chart görünüm config'i (runtime set eder); null ise global settings. */
  private chartConfig: ChartViewConfig | null = null;

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
    private readonly ctx: CanvasRenderingContext2D,
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
  ) {}

  render(
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    range: [number, number]
  ): void {
    if (!this.interactionCtx || this.interactionCtx === this.ctx) {
      this.renderCombined(view, series, crosshair, range);
      return;
    }
    this.renderAnnotations(view, series, crosshair, range);
    this.renderInteraction(view, series, crosshair, range);
  }

  /** Static/semi-static Canvas2D surface. Scene layer order is the render authority. */
  renderAnnotations(
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    range: [number, number],
    layerOrder?: readonly string[],
  ): void {
    const ctx = this.ctx;
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
      try {
        if (isIndicatorLayer) {
          indicatorBatchDrawn = true;
          this.drawSubPanes(view, series, range, crosshair, false);
          if (!mainSuppressed) this.drawIndicatorPriceOverlays(view, series, range, crosshair);
          continue;
        }

        if (layerId === "axis") {
          if (!mainSuppressed && !empty) {
            this.drawLineLabels(view);
            drawPriceAxis(ctx, view, series.config.priceStep, series.config.pricePrecision, this.priceAxisKeepOut(view, crosshair));
            drawPriceMarkers(ctx, view, this.priceMarkers, series.config.priceStep, series.config.pricePrecision);
          }
          drawTimeAxis(ctx, view, series, undefined, this.timeMarkers);
          continue;
        }

        if (empty || mainSuppressed) continue;
        switch (layerId) {
          case "orderbook-heatmap":
            this.drawOrderbookHeatmap?.(ctx, view, series, range);
            break;
          case "footprint-text":
            this.drawCells(view, series, range);
            break;
          case "volume-profile":
            this.drawVolumeProfile(view, series, range);
            break;
          case "tpo":
            this.drawTpo(view, series, range);
            break;
          case "strategy-levels":
            this.drawPreviousWeekStrategy(view, series);
            this.drawMondayRange(view, series);
            break;
          case "naked-poc":
            this.drawNakedPocs(view, series);
            break;
          case "reference-levels":
            this.drawReferenceLevels(view, series);
            break;
          case "drawings":
            this.drawForeground?.(ctx, view, series);
            break;
          case "last-price":
            if (settings.lastPrice) this.drawLastPrice(view, series);
            break;
        }
      } finally {
        if (layerStartedAt !== null) {
          recordPerformanceDuration(`chart.annotation.layer.${metricLayer}.ms`, performance.now() - layerStartedAt);
        }
      }
    }

    ctx.restore();
  }

  /** High-frequency pointer/selection surface. Scene layer order is the render authority. */
  renderInteraction(
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    range: [number, number],
    layerOrder?: readonly string[],
  ): void {
    const ctx = this.interactionCtx ?? this.ctx;
    const orderedLayers = layerOrder ?? ["crosshair", "hud", "interaction-controls"];
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.priceScaleControlRects = [];
    this.indicatorScaleControlRects = [];
    this.touchMenuButton = null;

    if (series.length === 0) {
      this.onHudText?.(null);
      return;
    }

    const mainSuppressed = this.isMainChartSuppressed?.() === true;
    for (const layerId of orderedLayers) {
      switch (layerId) {
        case "crosshair": {
          if (mainSuppressed) {
            if (crosshair.visible) drawCrosshairTimeLabel(ctx, view, series, crosshair);
            break;
          }
          const syncTime = this.getSyncCrosshairTime?.();
          if (syncTime != null) {
            const startTime = series.at(0)?.startTime;
            if (startTime !== undefined) {
              const idx = (syncTime - startTime) / series.config.intervalMs;
              const x = view.xOfIndex(idx) + view.colWidth / 2;
              this.drawSyncCrosshair(ctx, view, x);
            }
          }
          if (crosshair.visible) {
            this.drawCrosshair(ctx, view, crosshair);
            drawCrosshairPriceLabel(ctx, view, series, crosshair);
            drawCrosshairTimeLabel(ctx, view, series, crosshair);
          }
          break;
        }
        case "hud":
          if (mainSuppressed) this.onHudText?.(null);
          else {
            this.drawHud(ctx, view, series, crosshair, range);
            this.drawOrderbookHover?.(ctx, view, series, crosshair);
          }
          break;
        case "interaction-controls":
          if (!mainSuppressed) this.drawInteractionForeground?.(ctx, view, series);
          if (!mainSuppressed) this.priceScaleControlRects = drawPriceScaleControls(ctx, view, crosshair);
          this.drawIndicatorInteractionControls(ctx, view, crosshair);
          // The crosshair has the plot to itself while the finger inspects.
          if (crosshair.touch && !crosshair.visible) {
            this.touchMenuButton = touchMenuButtonRect(view);
            if (this.touchMenuButton) drawTouchMenuButton(ctx, this.touchMenuButton);
          }
          break;
      }
    }
  }

  /** Temporary bounded coupling: indicator legend/readouts still receive crosshair in their draw contract. */
  requiresInteractionRedraw(): boolean {
    return (this.getIndicatorPanes?.().length ?? 0) > 0 || (this.getIndicatorPriceOverlays?.().length ?? 0) > 0;
  }

  private drawIndicatorInteractionControls(
    ctx: CanvasRenderingContext2D,
    view: View,
    crosshair: Crosshair,
  ): void {
    const panes = this.getIndicatorPanes?.() ?? [];
    if (!panes.length || view.priceAxisW <= 0) return;
    const axisX = view.area.left + view.area.width;
    let top = view.area.top + view.area.height;
    for (const pane of panes) {
      this.indicatorScaleControlRects.push(...drawIndicatorScaleControls(
        ctx, axisX, view.priceAxisW,
        { id: pane.id, top, height: pane.height, scaleMode: pane.scaleMode },
        crosshair,
      ));
      top += pane.height;
    }
  }

  private renderCombined(
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    range: [number, number]
  ): void {
    const ctx = this.ctx;
    const { left, top, width, height } = view.area;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.save();
    this.priceMarkers = [];
    this.timeMarkers = [];
    this.lineLabels = [];
    this.priceScaleControlRects = [];
    this.indicatorScaleControlRects = [];
    this.indicatorAxisRects = [];
    this.tpoProfileHitZones = [];

    if (series.length === 0) {
      // An empty series has no meaningful price range. Drawing the default View
      // scale produced a ladder of negative prices (-40, -80, ...), which is
      // especially misleading immediately after a market switch with no bars.
      drawTimeAxis(ctx, view, series, crosshair, this.timeMarkers);
      this.onHudText?.(null);
      ctx.restore();
      return;
    }

    if (this.isMainChartSuppressed?.()) {
      this.drawSubPanes(view, series, range, crosshair);
      drawTimeAxis(ctx, view, series, crosshair, this.timeMarkers);
      this.onHudText?.(null);
      ctx.restore();
      return;
    }

    this.drawOrderbookHeatmap?.(ctx, view, series, range);
    this.drawCells(view, series, range);
    this.drawSubPanes(view, series, range, crosshair);
    this.drawVolumeProfile(view, series, range);
    this.drawTpo(view, series, range);
    this.drawPreviousWeekStrategy(view, series);
    this.drawMondayRange(view, series);
    this.drawNakedPocs(view, series);
    this.drawReferenceLevels(view, series);
    this.drawForeground?.(ctx, view, series);
    this.drawIndicatorPriceOverlays(view, series, range, crosshair);
    if (settings.lastPrice) this.drawLastPrice(view, series);
    // draw ghost/sync crosshair before local crosshair so local crosshair overlays it
    const syncTime = this.getSyncCrosshairTime?.();
    if (syncTime != null) {
      const startTime = series.at(0)?.startTime;
      if (startTime !== undefined) {
        const idx = (syncTime - startTime) / series.config.intervalMs;
        const x = view.xOfIndex(idx) + view.colWidth / 2;
        this.drawSyncCrosshair(ctx, view, x);
      }
    }
    if (crosshair.visible) this.drawCrosshair(ctx, view, crosshair);
    this.drawHud(ctx, view, series, crosshair, range);
    this.drawOrderbookHover?.(ctx, view, series, crosshair);
    this.drawInteractionForeground?.(ctx, view, series);
    this.drawLineLabels(view);
    // Axes drawn last — chart content never overlaps axis labels
    drawPriceAxis(ctx, view, series.config.priceStep, series.config.pricePrecision, this.priceAxisKeepOut(view, crosshair));
    drawPriceMarkers(ctx, view, this.priceMarkers, series.config.priceStep, series.config.pricePrecision);
    if (crosshair.visible) drawCrosshairPriceLabel(ctx, view, series, crosshair);
    drawTimeAxis(ctx, view, series, crosshair, this.timeMarkers);
    this.priceScaleControlRects = drawPriceScaleControls(ctx, view, crosshair);

    ctx.restore();
    void left; void top; void width; void height;
  }

  /** ChartRuntime her state değişiminde effective config'i buraya iter. */
  setChartConfig(config: ChartViewConfig): void {
    this.chartConfig = config;
  }

  private drawPreviousWeekStrategy(view: View, series: FootprintSeries): void {
    const cfg = this.getPreviousWeekStrategySettings?.();
    if (!cfg) return;
    this.drawStrategyLevels(view, series, cfg, this.getPreviousWeekStrategyLevels?.() ?? []);
  }

  private drawMondayRange(view: View, series: FootprintSeries): void {
    const cfg = this.getMondayRangeSettings?.();
    if (!cfg) return;
    this.drawStrategyLevels(view, series, cfg, this.getMondayRangeLevels?.() ?? []);
  }

  private drawStrategyLevels<TId extends string, TGroup extends string>(
    view: View,
    series: FootprintSeries,
    cfg: { enabled: boolean; visible: Record<TId, boolean> },
    rawLevels: readonly StrategyLevel<TId, TGroup>[]
  ): void {
    if (!cfg.enabled) return;
    const levels = rawLevels.filter((level) => cfg.visible[level.id] !== false);
    if (!levels.length) return;
    const ctx = this.ctx;
    const x = levelStartX(view, series, levels[0].sourceEnd);
    const right = view.area.left + view.area.width;
    const zoneLevels: typeof levels = [];
    const lineLevels: typeof levels = [];
    for (const item of levels) {
      if (item.kind === "zone") zoneLevels.push(item);
      else if (item.kind === "line") lineLevels.push(item);
    }
    ctx.save();
    for (const level of zoneLevels) {
      if (level.fromPrice == null || level.toPrice == null) continue;
      const y1 = view.yOfPrice(level.fromPrice);
      const y2 = view.yOfPrice(level.toPrice);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      if (bottom < view.area.top || top > view.area.top + view.area.height) continue;
      ctx.globalAlpha = level.fillOpacity ?? 0.14;
      ctx.fillStyle = level.color;
      ctx.fillRect(
        x,
        Math.max(view.area.top, top),
        right - x,
        Math.max(1, Math.min(view.area.top + view.area.height, bottom) - Math.max(view.area.top, top))
      );
      ctx.globalAlpha = 1;
      const mid = (level.fromPrice + level.toPrice) / 2;
      this.queueLineObject(mid, level.label, level.color, level.priority ?? 62);
    }
    for (const level of lineLevels) {
      if (level.price == null) continue;
      const y = view.yOfPrice(level.price);
      if (y < view.area.top || y > view.area.top + view.area.height) continue;
      ctx.strokeStyle = level.color;
      ctx.lineWidth = level.lineWidth ?? 1.2;
      ctx.setLineDash(lineDash(level.lineStyle));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      this.queueLineObject(level.price, level.label, level.color, level.priority);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }


  private drawVolumeProfile(
    view: View,
    series: FootprintSeries,
    [from, to]: [number, number]
  ): void {
    const cfg = this.getProfileSettings?.();
    if (!cfg || !settings.volumeProfile || from >= to) return;
    const all = series.listReadonly();
    const visible = all.slice(from, to);
    const anchor = visible[visible.length - 1]?.startTime;
    const selected = cfg.mode === "session" && anchor !== undefined ? sessionBars(all, anchor) : visible;
    const last = selected[selected.length - 1];
    const key = [
      cfg.mode, cfg.valueAreaPercent, selected.length, selected[0]?.startTime ?? 0,
      last?.startTime ?? 0, series.revision,
    ].join("|");
    if (this.profileCache?.key !== key) {
      const result = calculateVolumeProfile(selected, cfg.valueAreaPercent);
      let maxVolume = 0;
      for (const level of result.levels) {
        if (level.totalVol > maxVolume) maxVolume = level.totalVol;
      }
      this.profileCache = { key, result, maxVolume };
    }
    const result = this.profileCache.result;
    if (!result.levels.length) return;

    const ctx = this.ctx;
    const step = series.config.priceStep;
    const maxVolume = this.profileCache.maxVolume;
    const maxWidth = Math.min(180, Math.max(80, view.area.width * 0.22));
    const right = view.area.left + view.area.width - 4;
    ctx.save();
    for (const level of result.levels) {
      const yTop = view.yOfPrice(level.priceBin + step);
      const yBottom = view.yOfPrice(level.priceBin);
      if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
      const width = maxWidth * (level.totalVol / maxVolume);
      const buyWidth = width * (level.buyVol / Math.max(level.totalVol, Number.EPSILON));
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = uiColor.sell;
      ctx.fillRect(right - width, yTop, width - buyWidth, Math.max(1, yBottom - yTop - 1));
      ctx.fillStyle = uiColor.buy;
      ctx.fillRect(right - buyWidth, yTop, buyWidth, Math.max(1, yBottom - yTop - 1));
    }
    ctx.globalAlpha = 1;
    this.drawProfileLevel(view, result.poc, "PPOC", uiColor.warn, settings.profilePoc);
    this.drawProfileLevel(view, result.vah, "VAH", uiColor.info, settings.profileVah);
    this.drawProfileLevel(view, result.val, "VAL", uiColor.info, settings.profileVal);
    ctx.restore();
  }

  /**
   * TPO (Market Profile) chart type: one horizontal count-histogram per UTC-day
   * session, anchored in that session's own x-region. Bar length = number of
   * brackets (bars) that touched the price level. POC/VAH/VAL reuse the volume
   * profile level toggles + value-area percent.
   */
  private drawTpo(view: View, series: FootprintSeries, [from, to]: [number, number]): void {
    const chartCfg = this.chartConfig ?? settings;
    if (chartCfg.chartType !== "tpo" || from >= to) return;
    const cfg = this.getProfileSettings?.();
    const vaPercent = cfg?.valueAreaPercent ?? 0.7;
    const all = series.listReadonly();
    const step = series.config.priceStep;

    const bracketMs = effectiveTpoBracketMs(chartCfg.tpoBracketSize, series.config.intervalMs);
    const brackets = aggregateTpoBrackets(all, from, to, bracketMs);
    const spans = buildTpoBracketSpans(brackets, chartCfg.tpoProfilePeriod);
    const groupsMeta = mergeTpoSessionSpans(spans, this.tpoMergeLeftSessionStarts);
    if (!groupsMeta.length) return;

    const key = [
      vaPercent, step, series.revision, chartCfg.tpoProfilePeriod, chartCfg.tpoBracketSize, bracketMs,
      ...groupsMeta.map((g) => `${g.sessionStarts.join("+")}:${g.firstIdx}:${g.lastIdx}`),
    ].join("|");
    if (this.tpoCache?.key !== key) {
      this.tpoCache = {
        key,
        groups: groupsMeta.map((g) => ({
          sessionStarts: [...g.sessionStarts],
          firstBracketIndex: g.firstBracketIndex,
          lastBracketIndex: g.lastBracketIndex,
          firstIdx: g.firstIdx,
          lastIdx: g.lastIdx,
          firstSpanIndex: g.firstSpanIndex,
          result: calculateTpoProfile(
            brackets.slice(g.firstBracketIndex, g.lastBracketIndex + 1).map((bracket) => bracket.bar),
            step,
            vaPercent
          ),
        })),
      };
    }

    const ctx = this.ctx;
    // Letters mode needs vertical room per price row and horizontal room per
    // bracket column; otherwise fall back to the collapsed histogram.
    const midPrice = view.priceOfY(view.area.top + view.area.height / 2);
    const cellH = Math.abs(view.yOfPrice(midPrice) - view.yOfPrice(midPrice + step));
    let minBracketWidth = Number.POSITIVE_INFINITY;
    for (const bracket of brackets) {
      const width = view.xOfIndex(bracket.lastIdx + 1) - view.xOfIndex(bracket.firstIdx);
      if (width < minBracketWidth) minBracketWidth = width;
    }
    const lettersMode = chartCfg.tpoMode === "letters" && cellH >= 9 && minBracketWidth >= 8;

    ctx.save();
    if (lettersMode) {
      ctx.font = `${Math.min(11, cellH - 1)}px ui-monospace, Menlo, monospace`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
    }
    for (const g of this.tpoCache.groups) {
      const result = g.result;
      if (!result.levels.length) continue;

      const left = view.xOfIndex(g.firstIdx);
      const right = view.xOfIndex(g.lastIdx + 1);
      const labelX = right - 2;
      const canUndoMerges = g.sessionStarts.some((sessionStart, index) =>
        index > 0 && this.tpoMergeLeftSessionStarts.has(sessionStart)
      );
      this.tpoProfileHitZones.push({
        left,
        right,
        sessionStart: g.sessionStarts[0],
        groupSessionStarts: [...g.sessionStarts],
        canMergeLeft: g.firstSpanIndex > 0,
        canUndoMerges,
      });
      // MMT-style red marker: only the latest/current price bin of the session,
      // not every price row touched by the last bracket's full high-low range.
      const lastBar = brackets[g.lastBracketIndex]?.bar;
      const lastCloseBin = lastBar ? Math.floor(lastBar.close / step) * step : NaN;

      if (lettersMode) {
        for (let i = g.firstBracketIndex; i <= g.lastBracketIndex; i++) {
          const bracket = brackets[i];
          if (!bracket) continue;
          const bar = bracket.bar;
          const label = tpoBracketLabel(i - g.firstBracketIndex);
          const cx = (view.xOfIndex(bracket.firstIdx) + view.xOfIndex(bracket.lastIdx + 1)) / 2;
          const lo = Math.floor(bar.low / step) * step;
          const hi = Math.floor(bar.high / step) * step;
          const isLast = i === g.lastBracketIndex;
          for (let bin = lo; bin <= hi; bin += step) {
            const yMid = view.yOfPrice(bin + step / 2);
            if (yMid < view.area.top || yMid > view.area.top + view.area.height) continue;
            ctx.fillStyle = isLast && bin === lastCloseBin ? tpoPalette.latest : bin === result.poc ? tpoPalette.pocLetters : tpoPalette.letters;
            ctx.fillText(label, cx, yMid);
          }
        }
      } else {
        // Market-Profile block columns: each square is one profile-local bracket
        // occurrence. Non-POC squares get a slight bracket-based tone variation.
        const maxCount = Math.max(...result.levels.map((l) => l.count));
        if (maxCount <= 0) continue;
        const sessionPx = Math.max(view.colWidth, view.xOfIndex(g.lastIdx + 1) - left);
        const maxWidth = Math.max(8, sessionPx);
        const vaLo = result.val;
        const vaHi = result.vah;
        const rawSquare = Math.min(Math.max(cellH, 4), maxWidth / maxCount);
        const blockMode = cellH >= TPO_MIN_BLOCK_CELL_HEIGHT && rawSquare >= TPO_MIN_BLOCK_CELL_WIDTH;

        if (blockMode) {
          const sqH = Math.max(cellH - 1, 1);
          for (const level of result.levels) {
            const yTop = view.yOfPrice(level.priceBin + step);
            if (yTop > view.area.top + view.area.height || yTop + cellH < view.area.top) continue;
            const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
            const baseColor = level.priceBin === result.poc ? tpoPalette.poc
              : inVA ? tpoPalette.valueArea
              : tpoPalette.outside;
            const latestPriceBin = level.priceBin === lastCloseBin;
            const latestLocalBracketIndex = g.lastBracketIndex - g.firstBracketIndex;
            const occurrenceIndices = level.bracketIndices.length
              ? level.bracketIndices
              : Array.from({ length: level.count }, (_, index) => index);
            for (let k = 0; k < occurrenceIndices.length; k++) {
              const bracketIndex = occurrenceIndices[k];
              const x = left + k * rawSquare;
              if (x - left > maxWidth) break;
              ctx.fillStyle = latestPriceBin && bracketIndex === latestLocalBracketIndex ? tpoPalette.latest
                : level.priceBin === result.poc ? baseColor
                : tpoBlockFillColor(baseColor, bracketIndex);
              ctx.fillRect(x, yTop, Math.max(rawSquare - 1, 1), sqH);
            }
          }
        } else {
          // Rows too small for blocks: keep TPO colors in a collapsed proportional bar.
          ctx.globalAlpha = 0.55;
          for (const level of result.levels) {
            const yTop = view.yOfPrice(level.priceBin + step);
            const yBottom = view.yOfPrice(level.priceBin);
            if (yBottom < view.area.top || yTop > view.area.top + view.area.height) continue;
            const inVA = vaLo !== null && vaHi !== null && level.priceBin >= vaLo && level.priceBin <= vaHi;
            const latestPriceBin = level.priceBin === lastCloseBin;
            ctx.fillStyle = latestPriceBin ? tpoPalette.latest
              : level.priceBin === result.poc ? tpoPalette.poc
              : inVA ? tpoPalette.valueArea
              : tpoPalette.outside;
            ctx.fillRect(left, yTop, maxWidth * (level.count / maxCount), Math.max(1, yBottom - yTop - 1));
          }
          ctx.globalAlpha = 1;
        }
      }

      // Level leaders + labels (both modes): solid white POC, dashed VA.
      if (settings.profilePoc && result.poc !== null) this.drawTpoLeader(view, result.poc + step / 2, "POC", tpoPalette.leaderPoc, left, labelX, false);
      if (settings.profileVah && result.vah !== null) this.drawTpoLeader(view, result.vah + step / 2, "VAH", tpoPalette.leaderVa, left, labelX, true);
      if (settings.profileVal && result.val !== null) this.drawTpoLeader(view, result.val + step / 2, "VAL", tpoPalette.leaderVa, left, labelX, true);
    }
    ctx.restore();
  }

  /** Level leader line (left→labelX) plus a text label, inside one TPO session. */
  private drawTpoLeader(
    view: View,
    centerPrice: number,
    label: string,
    color: string,
    left: number,
    labelX: number,
    dashed: boolean
  ): void {
    const y = view.yOfPrice(centerPrice);
    if (y < view.area.top || y > view.area.top + view.area.height) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = dashed ? 0.7 : 0.9;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(labelX, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = "9px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = color;
    ctx.fillText(label, labelX + 3, y);
    ctx.restore();
  }

  private drawProfileLevel(
    view: View,
    price: number | null,
    label: string,
    color: string,
    enabled: boolean
  ): void {
    if (!enabled || price === null) return;
    const y = view.yOfPrice(price);
    if (y < view.area.top || y > view.area.top + view.area.height) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.setLineDash(label === "PPOC" ? [] : [5, 4]);
    ctx.beginPath();
    ctx.moveTo(view.area.left, y);
    ctx.lineTo(view.area.left + view.area.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    this.queueLineObject(price, label, color);
  }

  private drawCells(view: View, series: FootprintSeries, [from, to]: [number, number]): void {
    const ctx = this.ctx;
    const step = series.config.priceStep;
    // Representative row height at the screen midpoint (varies per-price in log).
    const midPrice = view.priceOfY(view.area.top + view.area.height / 2);
    const cellH = Math.abs(view.yOfPrice(midPrice) - view.yOfPrice(midPrice + step));
    // Cell text mode depends on the active footprint chart type (separate
    // memory for Cluster vs Profile). No cell text for plain candlesticks.
    const chartCfg = this.chartConfig ?? settings;
    let mode: typeof settings.clusterCellData;
    if (chartCfg.chartType === "footprint") mode = chartCfg.clusterCellData;
    else if (chartCfg.chartType === "footprintProfile") mode = chartCfg.profileCellData;
    else return;
    if (!chartCfg.cellNumbers) return;

    const candleW = view.candleStripWidth();
    const fpW = view.colWidth - candleW;
    const textMode = cellTextModeFor(cellH, fpW);
    if (textMode === "none") return;
    // Between the heat layer's threshold and a full bid/ask pair there is a wide band
    // where cells were shaded but never labelled. There, one centred value per cell is
    // readable where two are not.
    const compact = textMode === "compact";
    const pTop = view.priceOfY(view.area.top);
    const pBot = view.priceOfY(view.area.top + view.area.height);
    const minVisPrice = Math.min(pTop, pBot) - step;
    const maxVisPrice = Math.max(pTop, pBot) + step;
    const showNotional = this.showNotional;
    const fmtCell = (v: number, bp: number): string =>
      showNotional ? fmtNotional(v * bp) : fmtVol(v);

    ctx.font = `${Math.min(12, cellH - 2)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = "middle";

    for (let i = from; i < to; i++) {
      const bar = series.at(i);
      if (!bar) continue;
      const fpLeft = view.xOfIndex(i) + candleW;
      const half = fpW / 2;

      for (const cell of bar.cells.values()) {
        if (cell.priceBin + step < minVisPrice || cell.priceBin > maxVisPrice) continue;
        const yMid = view.yOfPrice(cell.priceBin + step / 2);
        if (yMid < view.area.top || yMid > view.area.top + view.area.height) continue;

        const binPrice = cell.priceBin + step / 2;
        const fmt = (v: number): string => fmtCell(v, binPrice);

        if (mode === "bidask") {
          const imb = cellImbalance(cell);
          if (compact) {
            // One value, coloured by which side dominates.
            ctx.fillStyle = imb > 0.3 ? uiColor.buy : imb < -0.3 ? uiColor.sell : uiColor.text;
            ctx.textAlign = "center";
            ctx.fillText(fmt(cell.buyVol + cell.sellVol), fpLeft + half, yMid);
            continue;
          }
          // sell (left, right-aligned), buy (right, left-aligned)
          ctx.fillStyle = imb < -0.3 ? uiColor.sell : cellDimSell;
          ctx.textAlign = "right";
          ctx.fillText(fmt(cell.sellVol), fpLeft + half - 4, yMid);

          ctx.fillStyle = imb > 0.3 ? uiColor.buy : cellDimBuy;
          ctx.textAlign = "left";
          ctx.fillText(fmt(cell.buyVol), fpLeft + half + 4, yMid);
        } else if (mode === "volume") {
          ctx.fillStyle = uiColor.text;
          ctx.textAlign = "center";
          ctx.fillText(fmt(cell.buyVol + cell.sellVol), fpLeft + half, yMid);
        } else if (mode === "count") {
          // trade count is a raw tally, never a notional value
          ctx.fillStyle = uiColor.text;
          ctx.textAlign = "center";
          ctx.fillText(fmtVol(cellTradeCounts(cell).total), fpLeft + half, yMid);
        } else if (mode === "countBidask") {
          const counts = cellTradeCounts(cell);
          if (compact) {
            ctx.fillStyle = uiColor.text;
            ctx.textAlign = "center";
            ctx.fillText(fmtVol(counts.total), fpLeft + half, yMid);
            continue;
          }
          ctx.fillStyle = counts.sell > counts.buy ? uiColor.sell : cellDimSell;
          ctx.textAlign = "right";
          ctx.fillText(fmtVol(counts.sell), fpLeft + half - 4, yMid);

          ctx.fillStyle = counts.buy > counts.sell ? uiColor.buy : cellDimBuy;
          ctx.textAlign = "left";
          ctx.fillText(fmtVol(counts.buy), fpLeft + half + 4, yMid);
        } else if (mode === "deltaPct") {
          const deltaPct = cellDeltaPercent(cell);
          const sign = deltaPct > 0 ? "+" : deltaPct < 0 ? "-" : "";
          ctx.fillStyle = deltaPct > 0 ? uiColor.buy : deltaPct < 0 ? uiColor.sell : uiColor.textSecondary;
          ctx.textAlign = "center";
          ctx.fillText(`${sign}${Math.abs(deltaPct).toFixed(0)}%`, fpLeft + half, yMid);
        } else if (mode === "avgTradeSize") {
          ctx.fillStyle = uiColor.text;
          ctx.textAlign = "center";
          ctx.fillText(fmt(cellAverageTradeSize(cell)), fpLeft + half, yMid);
        } else if (mode === "avgTradeSizeBidask") {
          const averages = cellAverageTradeSizes(cell);
          if (compact) {
            ctx.fillStyle = uiColor.text;
            ctx.textAlign = "center";
            ctx.fillText(fmt(cellAverageTradeSize(cell)), fpLeft + half, yMid);
            continue;
          }
          ctx.fillStyle = averages.sell > averages.buy ? uiColor.sell : cellDimSell;
          ctx.textAlign = "right";
          ctx.fillText(fmt(averages.sell), fpLeft + half - 4, yMid);

          ctx.fillStyle = averages.buy > averages.sell ? uiColor.buy : cellDimBuy;
          ctx.textAlign = "left";
          ctx.fillText(fmt(averages.buy), fpLeft + half + 4, yMid);
        } else {
          // delta = buy - sell
          const delta = cell.buyVol - cell.sellVol;
          const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
          ctx.fillStyle = delta > 0 ? uiColor.buy : delta < 0 ? uiColor.sell : uiColor.textSecondary;
          ctx.textAlign = "center";
          ctx.fillText(sign + fmt(Math.abs(delta)), fpLeft + half, yMid);
        }
      }
    }
  }

  /** Indicator sub-panes in the band below the plot, above the time axis. */
  private drawSubPanes(
    view: View,
    series: FootprintSeries,
    range: [number, number],
    crosshair?: Crosshair,
    drawControls = true,
  ): void {
    if (view.subPanesH <= 0) return;
    const ctx = this.ctx;
    const indicatorPanes = this.getIndicatorPanes?.() ?? [];
    if (indicatorPanes.length) {
      // Fill the price-axis gutter band next to the sub-panes up front so
      // indicator axis ticks drawn into it survive; drawPriceAxis only fills
      // the gutter down to the main plot bottom.
      const axisX = view.area.left + view.area.width;
      if (view.priceAxisW > 0) {
        ctx.fillStyle = uiColor.bgApp;
        ctx.fillRect(axisX, view.area.top + view.area.height, view.priceAxisW, view.subPanesH);
        ctx.strokeStyle = uiColor.separator;
        ctx.beginPath();
        ctx.moveTo(axisX + 0.5, view.area.top + view.area.height);
        ctx.lineTo(axisX + 0.5, view.area.top + view.area.height + view.subPanesH);
        ctx.stroke();
      }
      let top = view.area.top + view.area.height;
      for (const pane of indicatorPanes) {
        const rect = { top, height: pane.height };
        this.indicatorAxisRects.push({ paneId: pane.id, plotX: view.area.left, x: axisX, y: top, w: view.priceAxisW, h: pane.height });
        if (view.priceAxisW > 0) {
          ctx.strokeStyle = uiColor.separatorStrong;
          ctx.beginPath();
          ctx.moveTo(axisX, top + 0.5);
          ctx.lineTo(axisX + view.priceAxisW, top + 0.5);
          ctx.stroke();
        }
        this.drawIndicatorPaneBackgroundFn?.(ctx, view, rect);
        pane.draw(ctx, view, series, rect, range, crosshair);
        if (drawControls) {
          this.indicatorScaleControlRects.push(...drawIndicatorScaleControls(
            ctx,
            axisX,
            view.priceAxisW,
            { ...rect, id: pane.id, scaleMode: pane.scaleMode },
            crosshair,
          ));
        }
        top += pane.height;
      }
      if (view.priceAxisW > 0) {
        ctx.strokeStyle = uiColor.separatorStrong;
        ctx.beginPath();
        ctx.moveTo(axisX, top - 0.5);
        ctx.lineTo(axisX + view.priceAxisW, top - 0.5);
        ctx.stroke();
      }
    }
  }

  private drawIndicatorPriceOverlays(view: View, series: FootprintSeries, range: [number, number], crosshair?: Crosshair): void {
    const overlays = this.getIndicatorPriceOverlays?.() ?? [];
    if (!overlays.length) return;
    const rect = { top: view.area.top, height: view.area.height };
    for (const overlay of overlays) {
      overlay.draw(this.ctx, view, series, rect, range, crosshair);
    }
  }

  /** Horizontal dashed line + colored axis label at the latest bar's close. */
  private drawLastPrice(view: View, series: FootprintSeries): void {
    const bar = series.at(series.length - 1);
    if (!bar) return;
    const prev = series.at(series.length - 2);
    const up = !prev || bar.close >= prev.close;
    const color = up ? uiColor.buy : uiColor.sell;
    const y = view.yOfPrice(bar.close);
    if (y < view.area.top || y > view.area.top + view.area.height) return;
    const ctx = this.ctx;
    const axisX = view.area.left + view.area.width;

    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(view.area.left, y);
    ctx.lineTo(axisX, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    this.queuePriceMarker(bar.close, color, 100);
  }

  private drawNakedPocs(view: View, series: FootprintSeries): void {
    const levels = this.getNakedPocs?.() ?? [];
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([7, 4]);
    for (const level of levels) {
      const y = view.yOfPrice(level.price);
      if (y < view.area.top || y > view.area.top + view.area.height) continue;
      const x = levelStartX(view, series, level.periodEnd);
      const prefix = periodPrefix(level.period);
      const unit = periodUnit(level.period);
      const color = nakedPocColor(level.period);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(view.area.left + view.area.width, y);
      ctx.stroke();
      this.queueLineObject(level.price, `${prefix}-NPOC · ${level.age} ${unit}`, color);
    }
    ctx.restore();
  }

  private drawReferenceLevels(view: View, series: FootprintSeries): void {
    const levels = this.getReferenceLevels?.() ?? [];
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    for (const level of levels) {
      const y = view.yOfPrice(level.price);
      if (y < view.area.top || y > view.area.top + view.area.height) continue;
      const start = level.family === "open" ? level.sourceStart : level.sourceEnd;
      const x = levelStartX(view, series, start);
      ctx.strokeStyle = level.color;
      ctx.setLineDash(level.family === "level" ? [4, 3] : level.family === "eq" ? [8, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(view.area.left + view.area.width, y);
      ctx.stroke();
      this.queueLineObject(level.price, level.label, level.color);
    }
    ctx.restore();
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

  private drawLineLabels(view: View): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const boxH = 14;
    const candidates = this.lineLabels
      .map((label) => ({ ...label, desiredY: view.yOfPrice(label.price), boxH }))
      .filter((label) => label.desiredY >= view.area.top && label.desiredY <= view.area.top + view.area.height);
    const labels = placeVerticalLabels(candidates, view.area.top, view.area.top + view.area.height, 2);
    for (const label of labels) {
      const width = ctx.measureText(label.text).width + 12;
      const x = view.area.left + view.area.width - 4;
      const boxX = x - width;
      const boxY = label.y - boxH / 2;
      drawOverlayPill(ctx, boxX, boxY, width, boxH, 4, lineLabelPillBg, "rgba(148, 163, 184, 0.22)");
      ctx.fillStyle = label.color;
      ctx.fillRect?.(boxX + 1, boxY + 2, 2, Math.max(2, boxH - 4));
      ctx.fillText(label.text, x - 4, label.y);
    }
    ctx.restore();
  }

  private drawCrosshair(ctx: CanvasRenderingContext2D, view: View, ch: Crosshair): void {
    ctx.strokeStyle = crosshairLineColor;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(ch.x, view.area.top);
    ctx.lineTo(ch.x, view.area.top + view.area.height);
    ctx.moveTo(view.area.left, ch.y);
    ctx.lineTo(view.area.left + view.area.width, ch.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Draw a ghost/sync crosshair as a vertical dashed line. Only vertical line is drawn;
   *  no horizontal or HUD labels. */
  private drawSyncCrosshair(ctx: CanvasRenderingContext2D, view: View, x: number): void {
    ctx.save();
    ctx.strokeStyle = syncCrosshairLineColor;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, view.area.top);
    ctx.lineTo(x, view.area.top + view.area.height);
    ctx.stroke();
    ctx.restore();
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
    [, to]: [number, number]
  ): void {
    // Bar priority: local crosshair, then synchronized ghost crosshair, else latest bar.
    let bar = series.at(to - 1);
    let hovered = false;
    if (crosshair.visible) {
      const idx = Math.floor(view.indexOfX(crosshair.x));
      const b = series.at(idx);
      if (b) {
        bar = b;
        hovered = true;
      }
    } else {
      const syncTime = this.getSyncCrosshairTime?.();
      if (syncTime != null) {
        const startTime = series.at(0)?.startTime;
        if (startTime !== undefined) {
          const idx = Math.floor((syncTime - startTime) / series.config.intervalMs);
          const b = series.at(idx);
          if (b) {
            bar = b;
            hovered = true;
          }
        }
      }
    }
    if (!bar) {
      this.onHudText?.(null);
      return;
    }

    const unit = this.showNotional ? "$" : "₿";
    const volTxt = this.showNotional ? fmtNotional(quoteVolumeForBar(bar)) : fmtVol(bar.volume);
    const deltaTxt = this.showNotional
      ? fmtNotional(Math.abs(bar.delta) * bar.close)
      : Math.abs(bar.delta).toFixed(2);
    const rangePct = bar.low > 0 ? ((bar.high - bar.low) / bar.low) * 100 : 0;
    const changePct = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    const pd = configDecimals(series.config);
    const x = view.area.left + 8;

    ctx.font = "12px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = uiColor.textHeading;
    const hudText = `O ${bar.open.toFixed(pd)} H ${bar.high.toFixed(pd)} L ${bar.low.toFixed(pd)} `
      + `C ${bar.close.toFixed(pd)} Vol ${unit}${volTxt} Δ ${bar.delta >= 0 ? "+" : "-"}${unit}${deltaTxt} `
      + `Trades ${bar.count} Range ${rangePct.toFixed(2)}% Chg ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    this.onHudText?.(hudText);

    const prefix = `${hovered ? "◆ " : ""}O ${bar.open.toFixed(pd)}  H ${bar.high.toFixed(pd)}  L ${bar.low.toFixed(pd)}  C ${bar.close.toFixed(pd)}  Vol ${unit}${volTxt}`;
    const prefixWidth = ctx.measureText(prefix + "   ").width;
    const deltaPart = `Δ ${bar.delta >= 0 ? "+" : "-"}${unit}${deltaTxt}`;
    const deltaWidth = ctx.measureText(deltaPart + "   ").width;
    const tradesPart = `Trades ${bar.count.toLocaleString("en-US")}`;
    const tradesWidth = ctx.measureText(tradesPart + "   ").width;

    const rangePart = `Range ${rangePct.toFixed(2)}%`;
    const rangeX = x + prefixWidth + deltaWidth + tradesWidth;
    const rangeWidth = ctx.measureText(rangePart + "   ").width;

    const chgPart = `Chg ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    const chgWidth = ctx.measureText(chgPart).width;

    // A plot too narrow for one line (a phone, a small pane) gets the readout in rows instead of
    // running over the price axis. The corner menu button keeps its column in touch mode.
    const reserved = crosshair.touch && touchMenuButtonRect(view) !== null ? TOUCH_MENU_BUTTON_RESERVE : 0;
    const maxWidth = view.area.width - 16 - reserved;
    if (prefixWidth + deltaWidth + tradesWidth + rangeWidth + chgWidth > maxWidth) {
      const hover = hovered ? "◆ " : "";
      const parts: HudPart[] = [
        { text: `${hover}O ${bar.open.toFixed(pd)}`, color: uiColor.textHeading, dropOrder: 0 },
        { text: `H ${bar.high.toFixed(pd)}`, color: uiColor.textHeading, dropOrder: 0 },
        { text: `L ${bar.low.toFixed(pd)}`, color: uiColor.textHeading, dropOrder: 0 },
        { text: `C ${bar.close.toFixed(pd)}`, color: uiColor.textHeading, dropOrder: 0 },
        { text: `Vol ${unit}${volTxt}`, color: uiColor.textHeading, dropOrder: 2 },
        { text: deltaPart, color: bar.delta >= 0 ? uiColor.buy : uiColor.sell, dropOrder: 3 },
        { text: tradesPart, color: uiColor.textSecondary, dropOrder: 4 },
        { text: rangePart, color: uiColor.textSecondary, dropOrder: 5 },
        { text: chgPart, color: changePct >= 0 ? uiColor.buy : uiColor.sell, dropOrder: 1 },
      ];
      this.drawHudRows(ctx, view, x, maxWidth, parts);
      return;
    }

    const pillW = Math.min(
      Math.max(0, view.area.width - 8),
      prefixWidth + deltaWidth + tradesWidth + rangeWidth + chgWidth + 12,
    );
    drawOverlayPill(ctx, x - 6, 4, pillW, 20, 5, "rgba(11, 16, 24, 0.78)", "rgba(148, 163, 184, 0.16)");

    ctx.fillStyle = uiColor.textHeading;
    ctx.fillText(prefix, x, 8);
    ctx.fillStyle = bar.delta >= 0 ? uiColor.buy : uiColor.sell;
    ctx.fillText(deltaPart, x + prefixWidth, 8);
    ctx.fillStyle = uiColor.textSecondary;
    ctx.fillText(tradesPart, x + prefixWidth + deltaWidth, 8);
    ctx.fillText(rangePart, rangeX, 8);
    ctx.fillStyle = changePct >= 0 ? uiColor.buy : uiColor.sell;
    ctx.fillText(chgPart, rangeX + rangeWidth, 8);
  }

  /** Price tick labels keep clear of the finger-sized scale buttons, which stand in the gutter in touch mode. */
  private priceAxisKeepOut(view: View, crosshair: Crosshair): PriceAxisKeepOut[] {
    if (!crosshair.touch) return [];
    const span = touchPriceScaleControlSpan(view);
    return span ? [span] : [];
  }

  /** The readout as rows of `parts`, widest row no wider than `maxWidth`; see layoutHud for what gives way. */
  private drawHudRows(ctx: CanvasRenderingContext2D, view: View, x: number, maxWidth: number, parts: readonly HudPart[]): void {
    if (maxWidth < 60) return;
    const layout = layoutHud(parts, (text) => ctx.measureText(text).width, maxWidth, hudMaxRows(view.area.height), ctx.measureText("  ").width);
    const pillW = Math.min(Math.max(0, view.area.width - 8), layout.width + 12);
    drawOverlayPill(ctx, x - 6, 4, pillW, 20 + (layout.rows.length - 1) * HUD_ROW_HEIGHT, 5, "rgba(11, 16, 24, 0.78)", "rgba(148, 163, 184, 0.16)");
    layout.rows.forEach((row, index) => {
      for (const part of row.parts) {
        ctx.fillStyle = part.color;
        ctx.fillText(part.text, x + part.x, 8 + index * HUD_ROW_HEIGHT);
      }
    });
  }
}

function drawOverlayPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: string,
  stroke?: string,
): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = fill;
  if (
    typeof ctx.roundRect === "function" &&
    typeof ctx.fill === "function" &&
    typeof ctx.beginPath === "function" &&
    typeof ctx.stroke === "function"
  ) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1), Math.max(0, radius - 0.5));
      ctx.stroke();
    }
    return;
  }
  ctx.fillRect?.(x, y, w, h);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.strokeRect?.(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  }
}

function nakedPocColor(period: NakedPocLevel["period"]): string {
  return period === "daily" ? nakedPocPalette.daily
    : period === "weekly" ? nakedPocPalette.weekly
    : period === "monthly" ? nakedPocPalette.monthly
    : period === "quarterly" ? nakedPocPalette.quarterly
    : period === "half-yearly" ? nakedPocPalette.halfYearly
    : nakedPocPalette.yearly;
}

function lineDash(style: StrategyLineStyle | undefined): number[] {
  if (style === "dashed") return [6, 4];
  if (style === "dotted") return [3, 3];
  if (style === "long-dashed") return [10, 4];
  return [];
}
