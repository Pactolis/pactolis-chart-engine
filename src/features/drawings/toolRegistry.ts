import type { ChartMessageKey } from "../../core/chartLocale.js";
import type { DrawingType } from "./drawingManager.js";
import {
  uiColor,
  drawingShapeColorDefault,
  drawingChannelColorDefault,
  drawingFibColorDefault,
  drawingAccentColorDefault,
  drawingMeasureColorDefault,
  drawingShortColorDefault,
  drawingRegressionColorDefault,
} from "../../core/ui/seriesPalette.js";

export type DrawingToolGroupId = "lines" | "shapes" | "annotations" | "measurement" | "advanced" | "orderflow";

export interface DrawingToolDefinition {
  id: DrawingType;
  type: DrawingType;
  group: DrawingToolGroupId;
  icon: string;
  labelKey: ChartMessageKey;
  pointsRequired: 1 | 2 | 3;
  color: string;
  lineWidth: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  showLabel?: boolean;
  showPriceLabel?: boolean;
  showTimeLabel?: boolean;
  fillOpacity?: number;
  opacity?: number;
  extendLeft?: boolean;
  extendRight?: boolean;
}

export interface DrawingToolGroupDefinition {
  id: DrawingToolGroupId;
  icon: string;
  labelKey: ChartMessageKey;
  tools: readonly DrawingType[];
}

export const DRAWING_TOOLS: readonly DrawingToolDefinition[] = [
  { id: "horizontal", type: "horizontal", group: "lines", icon: "─", labelKey: "draw.horizontal", pointsRequired: 1, color: uiColor.warn, lineWidth: 1.5, showLabel: false, showPriceLabel: true },
  { id: "horizontal-ray", type: "horizontal-ray", group: "lines", icon: "↦", labelKey: "draw.horizontalRay", pointsRequired: 1, color: uiColor.warn, lineWidth: 1.5, showLabel: true, showPriceLabel: true, extendRight: true },
  { id: "vertical", type: "vertical", group: "lines", icon: "│", labelKey: "draw.vertical", pointsRequired: 1, color: uiColor.warn, lineWidth: 1.5, showLabel: true, showTimeLabel: true },
  { id: "trend", type: "trend", group: "lines", icon: "╱", labelKey: "draw.trend", pointsRequired: 2, color: uiColor.warn, lineWidth: 1.5, showLabel: true, showPriceLabel: false },
  { id: "trend-ray", type: "trend-ray", group: "lines", icon: "╱›", labelKey: "draw.trendRay", pointsRequired: 2, color: uiColor.warn, lineWidth: 1.5, showLabel: true, showPriceLabel: false, extendRight: true },
  { id: "extended-trend", type: "extended-trend", group: "lines", icon: "⟍", labelKey: "draw.extendedTrend", pointsRequired: 2, color: uiColor.warn, lineWidth: 1.5, showLabel: true, showPriceLabel: false, extendLeft: true, extendRight: true },
  { id: "partial-price-line", type: "partial-price-line", group: "lines", icon: "▔", labelKey: "draw.partialPriceLine", pointsRequired: 2, color: uiColor.warn, lineWidth: 1.5, showLabel: true, showPriceLabel: true, showTimeLabel: true },
  { id: "rectangle", type: "rectangle", group: "shapes", icon: "▭", labelKey: "draw.rectangle", pointsRequired: 2, color: drawingShapeColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.18 },
  { id: "extended-rectangle", type: "extended-rectangle", group: "shapes", icon: "▱", labelKey: "draw.extendedRectangle", pointsRequired: 2, color: drawingShapeColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.18, extendRight: true },
  { id: "session-box", type: "session-box", group: "shapes", icon: "▥", labelKey: "draw.sessionBox", pointsRequired: 2, color: drawingChannelColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: true, fillOpacity: 0.12 },
  { id: "ellipse", type: "ellipse", group: "shapes", icon: "◯", labelKey: "draw.ellipse", pointsRequired: 2, color: drawingShapeColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.14 },
  { id: "triangle", type: "triangle", group: "shapes", icon: "△", labelKey: "draw.triangle", pointsRequired: 2, color: drawingShapeColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.14 },
  { id: "brush", type: "brush", group: "shapes", icon: "✎", labelKey: "draw.brush", pointsRequired: 2, color: uiColor.warn, lineWidth: 2, lineStyle: "solid", showLabel: false, showPriceLabel: false, showTimeLabel: false },
  { id: "liquidity-zone", type: "liquidity-zone", group: "shapes", icon: "▰", labelKey: "draw.liquidityZone", pointsRequired: 2, color: drawingFibColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.16, extendRight: true },
  { id: "imbalance-zone", type: "imbalance-zone", group: "shapes", icon: "▧", labelKey: "draw.imbalanceZone", pointsRequired: 2, color: drawingAccentColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.16, extendRight: true },
  { id: "text", type: "text", group: "annotations", icon: "T", labelKey: "draw.textTitle", pointsRequired: 1, color: uiColor.warn, lineWidth: 1.5, showLabel: true },
  { id: "callout-note", type: "callout-note", group: "annotations", icon: "☰", labelKey: "draw.calloutNote", pointsRequired: 1, color: uiColor.warn, lineWidth: 1.5, showLabel: true, fillOpacity: 0.18 },
  { id: "arrow-marker", type: "arrow-marker", group: "annotations", icon: "↑", labelKey: "draw.arrowMarker", pointsRequired: 1, color: uiColor.buy, lineWidth: 1.5, showLabel: true },
  { id: "arrow-line", type: "arrow-line", group: "annotations", icon: "↗", labelKey: "draw.arrowLine", pointsRequired: 2, color: uiColor.buy, lineWidth: 1.5, showLabel: true },
  { id: "date-marker", type: "date-marker", group: "annotations", icon: "D", labelKey: "draw.dateMarker", pointsRequired: 1, color: drawingChannelColorDefault, lineWidth: 1.5, showLabel: true, showTimeLabel: true },
  { id: "event-marker", type: "event-marker", group: "annotations", icon: "◆", labelKey: "draw.eventMarker", pointsRequired: 1, color: drawingAccentColorDefault, lineWidth: 1.5, showLabel: true, showTimeLabel: true },
  { id: "measure", type: "measure", group: "measurement", icon: "↕", labelKey: "draw.measure", pointsRequired: 2, color: drawingMeasureColorDefault, lineWidth: 1.5, lineStyle: "dashed", showLabel: true, showPriceLabel: false, showTimeLabel: false },
  { id: "price-range", type: "price-range", group: "measurement", icon: "⇅", labelKey: "draw.priceRange", pointsRequired: 2, color: drawingMeasureColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: true, showTimeLabel: false, fillOpacity: 0.1 },
  { id: "date-range", type: "date-range", group: "measurement", icon: "⇄", labelKey: "draw.dateRange", pointsRequired: 2, color: drawingMeasureColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: true },
  { id: "long-position", type: "long-position", group: "measurement", icon: "L", labelKey: "draw.longPosition", pointsRequired: 2, color: uiColor.buy, lineWidth: 1.5, showLabel: true, showPriceLabel: true, showTimeLabel: false, fillOpacity: 0.16 },
  { id: "short-position", type: "short-position", group: "measurement", icon: "S", labelKey: "draw.shortPosition", pointsRequired: 2, color: drawingShortColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: true, showTimeLabel: false, fillOpacity: 0.16 },
  { id: "fibonacci-retracement", type: "fibonacci-retracement", group: "advanced", icon: "F", labelKey: "draw.fibonacciRetracement", pointsRequired: 2, color: drawingFibColorDefault, lineWidth: 1.5, lineStyle: "dashed", showLabel: true, showPriceLabel: true, showTimeLabel: false, fillOpacity: 0.08, extendRight: true },
  { id: "fibonacci-extension", type: "fibonacci-extension", group: "advanced", icon: "Fx", labelKey: "draw.fibonacciExtension", pointsRequired: 3, color: drawingFibColorDefault, lineWidth: 1.5, lineStyle: "dashed", showLabel: true, showPriceLabel: true, showTimeLabel: false, fillOpacity: 0.08, extendRight: true },
  { id: "parallel-channel", type: "parallel-channel", group: "advanced", icon: "∥", labelKey: "draw.parallelChannel", pointsRequired: 3, color: drawingChannelColorDefault, lineWidth: 1.5, showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.1, extendLeft: false, extendRight: true },
  { id: "regression-channel", type: "regression-channel", group: "advanced", icon: "R∥", labelKey: "draw.regressionChannel", pointsRequired: 3, color: drawingRegressionColorDefault, lineWidth: 1.5, lineStyle: "dashed", showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.1, extendLeft: false, extendRight: true },
  { id: "pitchfork", type: "pitchfork", group: "advanced", icon: "Ψ", labelKey: "draw.pitchfork", pointsRequired: 3, color: drawingFibColorDefault, lineWidth: 1.5, lineStyle: "dashed", showLabel: true, showPriceLabel: false, showTimeLabel: false, extendRight: true },
  { id: "gann-fan", type: "gann-fan", group: "advanced", icon: "⌯", labelKey: "draw.gannFan", pointsRequired: 2, color: drawingFibColorDefault, lineWidth: 1.2, lineStyle: "dotted", showLabel: true, showPriceLabel: false, showTimeLabel: false, extendRight: true },
  { id: "gann-grid", type: "gann-grid", group: "advanced", icon: "▦", labelKey: "draw.gannGrid", pointsRequired: 2, color: drawingChannelColorDefault, lineWidth: 1, lineStyle: "dotted", showLabel: true, showPriceLabel: false, showTimeLabel: false, fillOpacity: 0.04, extendRight: false },
  { id: "anchored-vwap", type: "anchored-vwap", group: "orderflow", icon: "◇", labelKey: "draw.avwap", pointsRequired: 1, color: uiColor.warn, lineWidth: 1.5, showLabel: true, showPriceLabel: true },
  { id: "fixed-range-volume-profile", type: "fixed-range-volume-profile", group: "orderflow", icon: "▥", labelKey: "draw.fixedRangeVolumeProfile", pointsRequired: 2, color: uiColor.warn, lineWidth: 1.5, showLabel: true, opacity: 0.55 },
] as const;

export const DRAWING_TOOL_GROUPS: readonly DrawingToolGroupDefinition[] = [
  {
    id: "lines",
    icon: "╱",
    labelKey: "draw.group.lines",
    tools: ["horizontal", "horizontal-ray", "vertical", "trend", "trend-ray", "extended-trend", "partial-price-line"],
  },
  { id: "shapes", icon: "▭", labelKey: "draw.group.shapes", tools: ["rectangle", "extended-rectangle", "session-box", "ellipse", "triangle", "brush", "liquidity-zone", "imbalance-zone"] },
  { id: "annotations", icon: "T", labelKey: "draw.group.annotations", tools: ["text", "callout-note", "arrow-marker", "arrow-line", "date-marker", "event-marker"] },
  { id: "measurement", icon: "↕", labelKey: "draw.group.measurement", tools: ["measure", "price-range", "date-range", "long-position", "short-position"] },
  { id: "advanced", icon: "F", labelKey: "draw.group.advanced", tools: ["fibonacci-retracement", "fibonacci-extension", "parallel-channel", "regression-channel", "pitchfork", "gann-fan", "gann-grid"] },
  { id: "orderflow", icon: "▥", labelKey: "draw.group.orderflow", tools: ["anchored-vwap", "fixed-range-volume-profile"] },
] as const;

export function getDrawingTool(type: DrawingType): DrawingToolDefinition {
  const tool = DRAWING_TOOLS.find((item) => item.type === type);
  if (!tool) throw new Error(`Unknown drawing tool: ${type}`);
  return tool;
}

export function getDrawingToolLabelKey(type: DrawingType): ChartMessageKey {
  return getDrawingTool(type).labelKey;
}

export function toolsForGroup(groupId: DrawingToolGroupId): readonly DrawingToolDefinition[] {
  const group = DRAWING_TOOL_GROUPS.find((item) => item.id === groupId);
  if (!group) return [];
  return group.tools.map((type) => getDrawingTool(type));
}
