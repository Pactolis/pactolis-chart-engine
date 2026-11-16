/** Public compatibility facade and annotation rendering. Dependency direction is facade → gestures → selection → state → notifications. All domains share one state owner; rendering and exports retain the existing public API. */
import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { drawAnalysisDrawings } from "../../core/render/analysisDrawings.js";
import { t } from "../../core/chartLocale.js";
import type { Drawing, DrawingContext, DrawingType } from "../../core/drawingTypes.js";
import { applyLineStyle, clamp01, drawLine, drawObjectName, drawingDisplayName, isAnnotationTool, isFibonacciTool, isMeasurementTool, isZoneTool, queuePriceAxisLabel, queueTimeAxisLabel, queueTrendPriceLabels, queueZonePriceLabels, queueZoneTimeLabels, renderAnnotationTool, renderBrush, renderEllipse, renderFibonacciTool, renderGannFan, renderGannGrid, renderMeasurementTool, renderParallelChannel, renderPitchfork, renderRegressionChannel, renderTriangle, screenPoint, trendRenderLine, zoneRenderBox } from "./drawingPrimitives.js";
import { DrawingGestures } from "./drawingGestures.js";

export type {
  Drawing,
  DrawingContext,
  DrawingDataState,
  DrawingNamedPreset,
  DrawingPoint,
  DrawingStylePreset,
  DrawingTemplateState,
  DrawingType,
  FibonacciLabelFormat,
  FibonacciLabelSide,
  FibonacciLevel,
  PositionOrderKind,
  PositionRiskSettings,
} from "../../core/drawingTypes.js";

export {
  DEFAULT_DRAWING_TEMPLATE_STATE,
  DEFAULT_FIBONACCI_EXTENSION_LEVELS,
  DEFAULT_FIBONACCI_RETRACEMENT_LEVELS,
  DEFAULT_POSITION_RISK_SETTINGS,
  LEGACY_DRAWING_MARKET,
  normalizePositionRiskSettings,
  positionRiskMetrics,
} from "./drawingPrimitives.js";

export class DrawingManager extends DrawingGestures {
  constructor(
    onChange: (drawings: Drawing[], transient: boolean) => void,
    onToolChange?: (tool: DrawingType | null) => void,
    onRequestText?: (id: string, deleteOnCancel?: boolean) => void,
    onRequestSettings?: (id: string) => void,
  ) {
    super(onChange, onToolChange, onRequestText, onRequestSettings);
  }

  /** Read-only render seam: avoids cloning the full drawing graph on every frame. */
  renderAnalysis(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    time: DrawingContext,
    onLineObject?: (price: number, text: string, color: string) => void,
    market?: string,
  ): void {
    drawAnalysisDrawings(
      ctx,
      view,
      series,
      time,
      this.drawings,
      market ?? this.currentMarket,
      onLineObject,
    );
  }

  render(
    ctx: CanvasRenderingContext2D,
    view: View,
    time: DrawingContext,
    onLineObject?: (price: number, text: string, color: string) => void,
    onTimeObject?: (time: number, text: string, color: string) => void,
    market?: string
  ): void {
    this.lastView = view;
    this.lastTime = time;
    const renderMarket = market ?? this.currentMarket;
    const displayNames = this.getDisplayNames();
    ctx.save();
    ctx.font = "12px ui-monospace, monospace";
    for (const drawing of this.drawings) {
      if (!drawing.visible || drawing.points.length < 2 || drawing.market !== renderMarket) continue;
      const a = screenPoint(drawing.points[0], view, time);
      const b = screenPoint(drawing.points[1], view, time);
      ctx.strokeStyle = drawing.color;
      ctx.fillStyle = drawing.color;
      ctx.lineWidth = drawing.lineWidth;
      applyLineStyle(ctx, drawing.lineStyle);
      const displayName = displayNames.get(drawing.id) ?? drawingDisplayName(drawing, this.drawings);
      ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
      if (drawing.type === "anchored-vwap" || drawing.type === "fixed-range-volume-profile") {
        ctx.fillStyle = drawing.color;
        ctx.beginPath();
        ctx.arc(a.x, a.y, this.selectedIds.has(drawing.id) ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
        if (drawing.type === "fixed-range-volume-profile") {
          ctx.beginPath();
          ctx.arc(b.x, b.y, this.selectedIds.has(drawing.id) ? 5 : 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (drawing.type === "horizontal") {
        drawLine(ctx, view.area.left, a.y, view.area.left + view.area.width, a.y);
        queuePriceAxisLabel(drawing, displayName, onLineObject);
      } else if (drawing.type === "horizontal-ray") {
        drawLine(ctx, Math.max(view.area.left, a.x), a.y, view.area.left + view.area.width, a.y);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, Math.max(view.area.left, a.x), a.y);
        queuePriceAxisLabel(drawing, displayName, onLineObject);
      } else if (drawing.type === "vertical") {
        drawLine(ctx, a.x, view.area.top, a.x, view.area.top + view.area.height);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, a.x, view.area.top + 14);
        queueTimeAxisLabel(drawing, 0, displayName, onTimeObject);
      } else if (isAnnotationTool(drawing.type)) {
        renderAnnotationTool(ctx, drawing, a, b, view, displayName, onTimeObject);
      } else if (drawing.type === "trend" || drawing.type === "trend-ray" || drawing.type === "extended-trend") {
        const line = trendRenderLine(drawing, a, b, view);
        drawLine(ctx, line.a.x, line.a.y, line.b.x, line.b.y);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, line.b.x, line.b.y);
        queueTrendPriceLabels(drawing, displayName, onLineObject);
      } else if (drawing.type === "partial-price-line") {
        const y = a.y;
        drawLine(ctx, Math.min(a.x, b.x), y, Math.max(a.x, b.x), y);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, b.x, y);
        queuePriceAxisLabel(drawing, displayName, onLineObject);
        queueTimeAxisLabel(drawing, 0, displayName, onTimeObject);
        queueTimeAxisLabel(drawing, 1, displayName, onTimeObject);
      } else if (isFibonacciTool(drawing.type)) {
        renderFibonacciTool(ctx, drawing, a, b, view, time, displayName, onLineObject);
      } else if (drawing.type === "parallel-channel") {
        renderParallelChannel(ctx, drawing, a, b, view, time, displayName);
      } else if (drawing.type === "regression-channel") {
        renderRegressionChannel(ctx, drawing, a, b, view, time, displayName);
      } else if (drawing.type === "pitchfork") {
        renderPitchfork(ctx, drawing, a, b, view, time, displayName);
      } else if (drawing.type === "gann-fan") {
        renderGannFan(ctx, drawing, a, b, view, displayName);
      } else if (drawing.type === "gann-grid") {
        renderGannGrid(ctx, drawing, a, b, view, displayName);
      } else if (isMeasurementTool(drawing.type)) {
        renderMeasurementTool(ctx, drawing, a, b, view, time, displayName, this.positionRiskSettings, onLineObject, onTimeObject);
      } else if (drawing.type === "ellipse") {
        renderEllipse(ctx, drawing, a, b, displayName);
      } else if (drawing.type === "triangle") {
        renderTriangle(ctx, drawing, a, b, displayName);
      } else if (drawing.type === "brush") {
        renderBrush(ctx, drawing, view, time);
      } else if (isZoneTool(drawing.type)) {
        const box = zoneRenderBox(drawing, a, b, view);
        ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.18);
        ctx.fillRect(box.left, box.top, box.width, box.height);
        ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
        ctx.strokeRect(box.left, box.top, box.width, box.height);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, box.right, box.top + 12);
        queueZonePriceLabels(drawing, displayName, onLineObject);
        queueZoneTimeLabels(drawing, displayName, onTimeObject);
      } else {
        if (drawing.showLabel !== false) ctx.fillText(drawing.text || t("draw.text"), a.x + 4, a.y - 4);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}
