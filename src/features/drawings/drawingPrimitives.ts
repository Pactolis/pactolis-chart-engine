import type { View } from "../../core/engine/view.js";
import { t } from "../../core/chartLocale.js";
import { placeVerticalLabels } from "../../core/axisLabelUtils.js";
import { normalizeFixedRangeOrderFlowProfileSettings } from "../../core/orderFlowProfileSettings.js";
import { getDrawingTool, getDrawingToolLabelKey } from "./toolRegistry.js";
import {
  uiColor,
  drawingShortColorDefault,
  drawingLabelTextColor,
  drawingLabelPillBg,
  drawingLabelPillBorder,
} from "../../core/ui/seriesPalette.js";
import type {
  Drawing,
  DrawingContext,
  DrawingNamedPreset,
  DrawingPoint,
  DrawingStylePreset,
  DrawingTemplateState,
  DrawingType,
  FibonacciLabelFormat,
  FibonacciLabelSide,
  FibonacciLevel,
  PositionOrderKind,
  PositionRiskMetrics,
  PositionRiskSettings,
} from "../../core/drawingTypes.js";

export const DEFAULT_POSITION_RISK_SETTINGS: PositionRiskSettings = {
  accountBalance: 1_000,
  riskPercent: 1,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0004,
};

export const DEFAULT_DRAWING_TEMPLATE_STATE: DrawingTemplateState = {
  defaults: {},
  presets: [],
};

/** Eski (market alanı olmayan) çizimler tamamı BTC'de çizilmişti; normalize sırasında bu değere migrate edilir. */
export const LEGACY_DRAWING_MARKET = "BINANCE_FUTURES:btcusdt";

const ORDER_FLOW_PROFILE_STYLE_KEYS = [
  "profileMetric", "profileSide", "valueAreaPercent", "profileWidth", "pocMode", "vahMode", "valMode",
  "pocStaticColor", "pocStaticWidth", "pocStaticStyle",
  "pocDevelopingColor", "pocDevelopingWidth", "pocDevelopingStyle",
  "vahStaticColor", "vahStaticWidth", "vahStaticStyle",
  "vahDevelopingColor", "vahDevelopingWidth", "vahDevelopingStyle",
  "valStaticColor", "valStaticWidth", "valStaticStyle",
  "valDevelopingColor", "valDevelopingWidth", "valDevelopingStyle",
] as const satisfies readonly (keyof DrawingStylePreset)[];

const DRAWING_STYLE_PRESET_KEYS = [
  "color", "lineWidth", "lineStyle", "showLabel", "showPriceLabel", "showTimeLabel",
  "opacity", "fillOpacity", "extendLeft", "extendRight", "text", "valueAreaPercent",
  "showPoc", "showVah", "showVal", "profileWidth", "profileMetric", "profileSide",
  "pocMode", "vahMode", "valMode",
  "pocStaticColor", "pocStaticWidth", "pocStaticStyle",
  "pocDevelopingColor", "pocDevelopingWidth", "pocDevelopingStyle",
  "vahStaticColor", "vahStaticWidth", "vahStaticStyle",
  "vahDevelopingColor", "vahDevelopingWidth", "vahDevelopingStyle",
  "valStaticColor", "valStaticWidth", "valStaticStyle",
  "valDevelopingColor", "valDevelopingWidth", "valDevelopingStyle",
  "riskPercent", "entryOrderType", "stopOrderType", "targetOrderType", "fibLevels",
  "fibLabelFormat", "fibLabelSide", "fibReverse", "fibFillBands",
] as const satisfies readonly (keyof DrawingStylePreset)[];

function normalizeFixedRangeProfileStyle(source: DrawingStylePreset | Drawing): DrawingStylePreset {
  const raw = source as unknown as Record<string, unknown>;
  const normalized = normalizeFixedRangeOrderFlowProfileSettings(raw) as unknown as Record<string, unknown>;
  const result: DrawingStylePreset = {};
  for (const key of ORDER_FLOW_PROFILE_STYLE_KEYS) {
    const legacyKey = key === "pocMode" ? "showPoc" : key === "vahMode" ? "showVah" : key === "valMode" ? "showVal" : null;
    if (!(key in raw) && (!legacyKey || !(legacyKey in raw))) continue;
    (result as Record<string, unknown>)[key] = structuredClone(normalized[key]);
  }
  return result;
}

export function drawingStylePresetFromDrawing(drawing: Drawing): DrawingStylePreset {
  const preset: DrawingStylePreset = {};
  for (const key of DRAWING_STYLE_PRESET_KEYS) {
    const value = drawing[key];
    if (value !== undefined) {
      (preset as Record<string, unknown>)[key] = structuredClone(value);
    }
  }
  return normalizeDrawingStylePreset(drawing.type, preset);
}

export function applyStylePreset(drawing: Drawing, preset: DrawingStylePreset): void {
  const normalized = normalizeDrawingStylePreset(drawing.type, preset);
  for (const key of DRAWING_STYLE_PRESET_KEYS) {
    if (key in normalized) {
      (drawing as unknown as Record<string, unknown>)[key] = structuredClone(normalized[key]);
    }
  }
}

function normalizeDrawingStylePreset(type: DrawingType, preset: DrawingStylePreset | undefined): DrawingStylePreset {
  if (!preset) return {};
  const tool = safeDrawingTool(type);
  const next: DrawingStylePreset = {};
  if (preset.color !== undefined) next.color = normalizeOptionalColor(preset.color) ?? tool.color;
  if (preset.lineWidth !== undefined) next.lineWidth = normalizeLineWidth(preset.lineWidth);
  if (preset.lineStyle !== undefined) next.lineStyle = normalizeLineStyle(preset.lineStyle);
  if (preset.showLabel !== undefined) next.showLabel = preset.showLabel === true;
  if (preset.showPriceLabel !== undefined) next.showPriceLabel = preset.showPriceLabel === true;
  if (preset.showTimeLabel !== undefined) next.showTimeLabel = preset.showTimeLabel === true;
  if (preset.opacity !== undefined) next.opacity = normalizeOpacity(preset.opacity);
  if (preset.fillOpacity !== undefined) next.fillOpacity = normalizeOpacity(preset.fillOpacity);
  if (preset.extendLeft !== undefined) next.extendLeft = preset.extendLeft === true;
  if (preset.extendRight !== undefined) next.extendRight = preset.extendRight === true;
  if (typeof preset.text === "string") {
    const text = preset.text.trim();
    if (text) next.text = text;
  }
  if (preset.valueAreaPercent !== undefined) next.valueAreaPercent = clamp01(preset.valueAreaPercent);
  if (preset.showPoc !== undefined) next.showPoc = preset.showPoc === true;
  if (preset.showVah !== undefined) next.showVah = preset.showVah === true;
  if (preset.showVal !== undefined) next.showVal = preset.showVal === true;
  if (preset.profileWidth !== undefined) next.profileWidth = Number.isFinite(preset.profileWidth) ? Math.max(0.05, Math.min(0.9, preset.profileWidth)) : undefined;
  if (preset.riskPercent !== undefined) next.riskPercent = normalizePercentValue(preset.riskPercent, 1, 100);
  if (preset.entryOrderType === "market" || preset.entryOrderType === "limit") next.entryOrderType = preset.entryOrderType;
  if (preset.stopOrderType === "market" || preset.stopOrderType === "limit") next.stopOrderType = preset.stopOrderType;
  if (preset.targetOrderType === "market" || preset.targetOrderType === "limit") next.targetOrderType = preset.targetOrderType;
  if (isFibonacciTool(type)) {
    if (preset.fibLevels !== undefined) next.fibLevels = normalizeFibonacciLevels(preset.fibLevels);
    if (preset.fibLabelFormat !== undefined) next.fibLabelFormat = normalizeFibonacciLabelFormat(preset.fibLabelFormat);
    if (preset.fibLabelSide !== undefined) next.fibLabelSide = normalizeFibonacciLabelSide(preset.fibLabelSide);
    if (preset.fibReverse !== undefined) next.fibReverse = preset.fibReverse === true;
    if (preset.fibFillBands !== undefined) next.fibFillBands = preset.fibFillBands !== false;
  }
  if (type === "fixed-range-volume-profile") Object.assign(next, normalizeFixedRangeProfileStyle(preset));
  return next;
}

export function normalizeDrawingTemplateState(state: Partial<DrawingTemplateState> | undefined): DrawingTemplateState {
  const defaults: Partial<Record<DrawingType, DrawingStylePreset>> = {};
  if (state?.defaults && typeof state.defaults === "object") {
    for (const [type, preset] of Object.entries(state.defaults)) {
      const typed = type as DrawingType;
      if (!isKnownDrawingType(typed)) continue;
      const normalized = normalizeDrawingStylePreset(typed, preset as DrawingStylePreset);
      if (Object.keys(normalized).length) defaults[typed] = normalized;
    }
  }
  const presets = Array.isArray(state?.presets)
    ? state.presets.flatMap((preset): DrawingNamedPreset[] => {
      const type = preset?.type as DrawingType;
      if (!preset || !isKnownDrawingType(type) || typeof preset.name !== "string") return [];
      const style = normalizeDrawingStylePreset(type, preset.style);
      if (!Object.keys(style).length) return [];
      return [{
        id: typeof preset.id === "string" && preset.id.trim() ? preset.id : crypto.randomUUID(),
        name: preset.name.trim().slice(0, 60) || safeDrawingTypeLabel(type),
        type,
        style,
        createdAt: Number.isFinite(preset.createdAt) ? preset.createdAt : Date.now(),
      }];
    }).slice(0, 50)
    : [];
  return { defaults, presets };
}

function isKnownDrawingType(type: DrawingType): boolean {
  try {
    getDrawingTool(type);
    return true;
  } catch {
    return false;
  }
}

export interface DrawingMarketSummary {
  /** Primary selection, when it belongs to the market. */
  selectedId: string | null;
  selectedCount: number;
  /** Types of the market's committed drawings (the in-progress draft is left out). */
  types: DrawingType[];
}

/** Counts one market's drawings in a single pass without cloning them (chart test hook). */
export function summarizeMarketDrawings(
  drawings: readonly Drawing[],
  market: string,
  selectedId: string | null,
  selectedIds: ReadonlySet<string>,
  draftId: string | null,
): DrawingMarketSummary {
  const summary: DrawingMarketSummary = { selectedId: null, selectedCount: 0, types: [] };
  for (const drawing of drawings) {
    if (drawing.market !== market) continue;
    if (drawing.id === selectedId) summary.selectedId = drawing.id;
    if (selectedIds.has(drawing.id)) summary.selectedCount++;
    if (drawing.id !== draftId) summary.types.push(drawing.type);
  }
  return summary;
}

export function drawingDisplayName(drawing: Drawing, drawings: readonly Drawing[]): string {
  if (drawing.text && drawing.text.trim()) return drawing.text;
  if (drawing.type === "text") return t("draw.text");
  const base = safeDrawingTypeLabel(drawing.type);
  const same = drawings.filter((item) => item.type === drawing.type);
  return `${base} ${same.findIndex((item) => item.id === drawing.id) + 1}`;
}

export function duplicateDrawing(drawing: Drawing, drawings: readonly Drawing[], market?: string): Drawing {
  const timeOffset = Math.max(1, Math.round(Math.max(1, Math.abs((drawing.points[1]?.time ?? drawing.points[0]?.time ?? 0) - (drawing.points[0]?.time ?? 0))) * 0.08));
  const priceBasis = drawing.points[0]?.price ?? 1;
  const priceOffset = Math.max(Math.abs(priceBasis) * 0.002, 1);
  const copy = normalizeDrawing({
    ...structuredClone(drawing),
    id: crypto.randomUUID(),
    points: drawing.points.map((point) => ({ time: point.time + timeOffset, price: point.price + priceOffset })),
    text: drawing.text && drawing.text.trim() ? `${drawing.text} copy` : undefined,
    market: market ?? drawing.market,
  });
  if (!copy.text) {
    const label = safeDrawingTypeLabel(copy.type);
    const sameCount = drawings.filter((item) => item.type === copy.type).length;
    copy.text = `${label} ${sameCount + 1}`;
  }
  return copy;
}

export function drawObjectName(
  ctx: CanvasRenderingContext2D, text: string, color: string, x: number, y: number
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.fillText(text, x - 4, y - 4);
  ctx.restore();
}

export function screenPoint(point: DrawingPoint, view: View, time: DrawingContext): { x: number; y: number } {
  return {
    x: view.xOfIndex(time.indexForTime(point.time)) + view.colWidth / 2,
    y: view.yOfPrice(point.price),
  };
}

export function pointDistance(a: DrawingPoint, b: DrawingPoint): number {
  return Math.hypot(a.time - b.time, a.price - b.price);
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function segmentDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}


export function lastOf<T>(items: readonly T[]): T | undefined {
  return items.length ? items[items.length - 1] : undefined;
}

export function simplifyBrushPoints(points: DrawingPoint[]): DrawingPoint[] {
  if (points.length <= 64) return points;
  const simplified: DrawingPoint[] = [points[0]];
  const stride = Math.max(1, Math.floor(points.length / 128));
  for (let index = stride; index < points.length - 1; index += stride) {
    const point = points[index];
    const previous = simplified[simplified.length - 1];
    if (!previous || previous.time !== point.time || previous.price !== point.price) simplified.push(point);
  }
  const last = points[points.length - 1];
  if (simplified[simplified.length - 1] !== last) simplified.push(last);
  return simplified;
}

export function isSinglePointTool(type: DrawingType): boolean {
  return type === "horizontal"
    || type === "horizontal-ray"
    || type === "vertical"
    || type === "text"
    || type === "callout-note"
    || type === "arrow-marker"
    || type === "date-marker"
    || type === "event-marker"
    || type === "anchored-vwap";
}

export function isTextEditableTool(type: DrawingType): boolean {
  return type === "text" || type === "callout-note";
}

export function isPositionTool(type: DrawingType): boolean {
  return type === "long-position" || type === "short-position";
}

export function isThreePointTool(type: DrawingType): boolean {
  return type === "parallel-channel" || type === "fibonacci-extension" || type === "regression-channel" || type === "pitchfork";
}

export function hasThreeAnchors(type: DrawingType): boolean {
  return isPositionTool(type) || isThreePointTool(type);
}

export function normalizeDrawing(drawing: Drawing): Drawing {
  const tool = safeDrawingTool(drawing.type);
  const normalized: Drawing = {
    schemaVersion: drawing.schemaVersion ?? 2,
    ...drawing,
    points: normalizeDrawingPoints(drawing),
    color: drawing.color ?? tool.color,
    lineWidth: normalizeLineWidth(drawing.lineWidth ?? tool.lineWidth),
    lineStyle: normalizeLineStyle(drawing.lineStyle ?? tool.lineStyle),
    showLabel: drawing.showLabel ?? tool.showLabel ?? true,
    showPriceLabel: drawing.showPriceLabel ?? tool.showPriceLabel ?? false,
    showTimeLabel: drawing.showTimeLabel ?? tool.showTimeLabel ?? false,
    fillOpacity: normalizeOpacity(drawing.fillOpacity ?? tool.fillOpacity),
    opacity: normalizeOpacity(drawing.opacity ?? tool.opacity),
    locked: drawing.locked ?? false,
    visible: drawing.visible ?? true,
    extendLeft: drawing.extendLeft ?? tool.extendLeft,
    extendRight: drawing.extendRight ?? tool.extendRight,
    accountBalance: drawing.accountBalance,
    riskPercent: drawing.riskPercent,
    makerFeeRate: drawing.makerFeeRate,
    takerFeeRate: drawing.takerFeeRate,
    entryOrderType: drawing.entryOrderType,
    stopOrderType: drawing.stopOrderType,
    targetOrderType: drawing.targetOrderType,
    fibLevels: normalizeFibonacciLevels(drawing.fibLevels),
    fibLabelFormat: normalizeFibonacciLabelFormat(drawing.fibLabelFormat),
    fibLabelSide: normalizeFibonacciLabelSide(drawing.fibLabelSide),
    fibReverse: drawing.fibReverse === true,
    fibFillBands: drawing.fibFillBands ?? true,
    market: drawing.market && drawing.market.trim() ? drawing.market : LEGACY_DRAWING_MARKET,
  };
  normalizePositionRiskConfigInPlace(normalized);
  if (normalized.type === "fixed-range-volume-profile") {
    Object.assign(normalized, normalizeFixedRangeOrderFlowProfileSettings(normalized as unknown as Record<string, unknown>));
  }
  return normalized;
}


function normalizeDrawingPoints(drawing: Drawing): DrawingPoint[] {
  const points = drawing.points.map((point) => ({ ...point }));
  if (drawing.type === "partial-price-line" && points.length >= 2) {
    points[1] = { ...points[1], price: points[0].price };
  }
  if ((drawing.type === "session-box" || drawing.type === "date-range") && points.length >= 2) {
    points[1] = { ...points[1], price: points[0].price };
  }
  if (isPositionTool(drawing.type) && points.length >= 2) {
    normalizePositionPoints(points, drawing.type, 1);
  }
  if ((drawing.type === "parallel-channel" || drawing.type === "regression-channel") && points.length >= 2) {
    normalizeParallelChannelPoints(points);
  }
  if (drawing.type === "pitchfork" && points.length >= 2) {
    normalizePitchforkPoints(points);
  }
  if (drawing.type === "fibonacci-extension" && points.length >= 2) {
    normalizeFibonacciExtensionPoints(points);
  }
  return points;
}

export function normalizeDrawingPointsInPlace(drawing: Drawing, editedPointIndex: number): void {
  if (drawing.points.length < 2) return;
  if (drawing.type === "partial-price-line" || drawing.type === "session-box" || drawing.type === "date-range") {
    if (editedPointIndex === 0 || editedPointIndex === 1) {
      drawing.points[1] = { ...drawing.points[1], price: drawing.points[0].price };
    }
  }
  if (isPositionTool(drawing.type)) {
    normalizePositionPoints(drawing.points, drawing.type, editedPointIndex);
  }
  if (drawing.type === "parallel-channel" || drawing.type === "regression-channel") {
    normalizeParallelChannelPoints(drawing.points);
  }
  if (drawing.type === "pitchfork") {
    normalizePitchforkPoints(drawing.points);
  }
  if (drawing.type === "fibonacci-extension") {
    normalizeFibonacciExtensionPoints(drawing.points);
  }
}

export function normalizeDrawingStyleInPlace(drawing: Drawing): void {
  const tool = safeDrawingTool(drawing.type);
  drawing.color = drawing.color || tool.color;
  drawing.lineWidth = normalizeLineWidth(drawing.lineWidth ?? tool.lineWidth);
  drawing.lineStyle = normalizeLineStyle(drawing.lineStyle ?? tool.lineStyle);
  drawing.showLabel = drawing.showLabel ?? tool.showLabel ?? true;
  drawing.showPriceLabel = drawing.showPriceLabel ?? tool.showPriceLabel ?? false;
  drawing.showTimeLabel = drawing.showTimeLabel ?? tool.showTimeLabel ?? false;
  drawing.fillOpacity = normalizeOpacity(drawing.fillOpacity ?? tool.fillOpacity);
  drawing.opacity = normalizeOpacity(drawing.opacity ?? tool.opacity);
  drawing.extendLeft = drawing.extendLeft ?? tool.extendLeft;
  drawing.extendRight = drawing.extendRight ?? tool.extendRight;
  if (isFibonacciTool(drawing.type)) {
    drawing.fibLevels = normalizeFibonacciLevels(drawing.fibLevels);
    drawing.fibLabelFormat = normalizeFibonacciLabelFormat(drawing.fibLabelFormat);
    drawing.fibLabelSide = normalizeFibonacciLabelSide(drawing.fibLabelSide);
    drawing.fibReverse = drawing.fibReverse === true;
    drawing.fibFillBands = drawing.fibFillBands ?? true;
  }
  normalizePositionRiskConfigInPlace(drawing);
  if (drawing.type === "fixed-range-volume-profile") {
    Object.assign(drawing, normalizeFixedRangeOrderFlowProfileSettings(drawing as unknown as Record<string, unknown>));
  }
}

function normalizeFibonacciLevels(levels: Drawing["fibLevels"]): FibonacciLevel[] | undefined {
  if (!levels) return undefined;
  const normalized = levels
    .map((level) => ({
      value: normalizeFibonacciLevelValue(level.value),
      text: typeof level.text === "string" && level.text.trim() ? level.text.trim() : undefined,
      visible: level.visible !== false,
      color: normalizeOptionalColor(level.color),
      lineWidth: level.lineWidth === undefined ? undefined : normalizeLineWidth(level.lineWidth),
      lineStyle: level.lineStyle === undefined ? undefined : normalizeLineStyle(level.lineStyle),
      fillColor: normalizeOptionalColor(level.fillColor),
      fillOpacity: normalizeOpacity(level.fillOpacity),
    }))
    .sort((a, b) => a.value - b.value);
  const unique: FibonacciLevel[] = [];
  for (const level of normalized) {
    if (unique.some((item) => Math.abs(item.value - level.value) < 0.000001)) continue;
    unique.push(level);
  }
  return unique.length ? unique : undefined;
}

function normalizeFibonacciLevelValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-10, Math.min(10, value));
}

function normalizeOptionalColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const color = value.trim();
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? color : undefined;
}

function normalizeFibonacciLabelFormat(value: Drawing["fibLabelFormat"]): FibonacciLabelFormat {
  return value === "percent" || value === "price" || value === "text-price" || value === "percent-price" ? value : "percent-price";
}

function normalizeFibonacciLabelSide(value: Drawing["fibLabelSide"]): FibonacciLabelSide {
  return value === "left" ? "left" : "right";
}

function normalizeLineWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(8, value)) : 1.5;
}

function normalizeLineStyle(value: Drawing["lineStyle"]): "solid" | "dashed" | "dotted" {
  if (value === "dashed" || value === "dotted") return value;
  return "solid";
}

function normalizeOpacity(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return clamp01(value);
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

export function applyLineStyle(ctx: CanvasRenderingContext2D, style: Drawing["lineStyle"]): void {
  if (style === "dashed") ctx.setLineDash([7, 5]);
  else if (style === "dotted") ctx.setLineDash([2, 4]);
  else ctx.setLineDash([]);
}

export function queuePriceAxisLabel(
  drawing: Drawing,
  text: string,
  onLineObject?: (price: number, text: string, color: string) => void,
): void {
  if (drawing.showPriceLabel === false || drawing.points.length < 1) return;
  onLineObject?.(drawing.points[0].price, text, drawing.color);
}

export function queueTrendPriceLabels(
  drawing: Drawing,
  text: string,
  onLineObject?: (price: number, text: string, color: string) => void,
): void {
  if (drawing.showPriceLabel === false || drawing.points.length < 2) return;
  onLineObject?.(drawing.points[0].price, `${text} A`, drawing.color);
  onLineObject?.(drawing.points[1].price, `${text} B`, drawing.color);
}

export function queueTimeAxisLabel(
  drawing: Drawing,
  pointIndex: number,
  text: string,
  onTimeObject?: (time: number, text: string, color: string) => void,
): void {
  if (drawing.showTimeLabel === false || !drawing.points[pointIndex]) return;
  onTimeObject?.(drawing.points[pointIndex].time, text, drawing.color);
}

function safeDrawingTool(type: DrawingType): { color: string; lineWidth: number; lineStyle?: "solid" | "dashed" | "dotted"; showLabel?: boolean; showPriceLabel?: boolean; showTimeLabel?: boolean; fillOpacity?: number; opacity?: number; extendLeft?: boolean; extendRight?: boolean } {
  try {
    return getDrawingTool(type);
  } catch {
    return { color: uiColor.warn, lineWidth: 1.5 };
  }
}

function safeDrawingTypeLabel(type: DrawingType): string {
  try {
    return t(getDrawingToolLabelKey(type));
  } catch {
    return String(type);
  }
}

export function drawLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

export function trendRenderLine(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const extendLeft = drawing.type === "extended-trend" ? drawing.extendLeft !== false : drawing.extendLeft === true;
  const extendRight = drawing.type === "extended-trend" || drawing.type === "trend-ray"
    ? drawing.extendRight !== false
    : drawing.extendRight === true;
  if (extendLeft && extendRight) return extendedLine(a, b, view);
  if (extendRight) return { a, b: rayEnd(a, b, view) };
  if (extendLeft) return { a: rayLeftEnd(a, b, view), b };
  return { a, b };
}

function rayLeftEnd(
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
): { x: number; y: number } {
  const left = view.area.left;
  const bottom = view.area.top + view.area.height;
  if (a.x === b.x) return { x: a.x, y: b.y >= a.y ? view.area.top : bottom };
  const slope = (b.y - a.y) / (b.x - a.x);
  return { x: left, y: a.y + (left - a.x) * slope };
}

function rayEnd(
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
): { x: number; y: number } {
  const right = view.area.left + view.area.width;
  const bottom = view.area.top + view.area.height;
  if (a.x === b.x) return { x: a.x, y: b.y >= a.y ? bottom : view.area.top };
  const slope = (b.y - a.y) / (b.x - a.x);
  return { x: right, y: a.y + (right - a.x) * slope };
}

function extendedLine(
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const left = view.area.left;
  const right = view.area.left + view.area.width;
  const top = view.area.top;
  const bottom = view.area.top + view.area.height;
  if (a.x === b.x) return { a: { x: a.x, y: top }, b: { x: a.x, y: bottom } };
  const slope = (b.y - a.y) / (b.x - a.x);
  return {
    a: { x: left, y: a.y + (left - a.x) * slope },
    b: { x: right, y: a.y + (right - a.x) * slope },
  };
}

export function constrainDraftPoint(drawing: Drawing, point: DrawingPoint, pointIndex = 1): DrawingPoint {
  if (drawing.type === "partial-price-line" || drawing.type === "session-box" || drawing.type === "date-range") return { time: point.time, price: drawing.points[0].price };
  if (drawing.type === "parallel-channel" && pointIndex === 2) return point;
  return point;
}

export function constrainPointEdit(drawing: Drawing, index: number, point: DrawingPoint): DrawingPoint {
  if (drawing.type === "partial-price-line" || drawing.type === "session-box" || drawing.type === "date-range") {
    if (index === 0) return point;
    return { time: point.time, price: drawing.points[0].price };
  }
  if (isPositionTool(drawing.type)) return constrainPositionPointEdit(drawing, index, point);
  return point;
}

export function isZoneTool(type: DrawingType): boolean {
  return type === "rectangle"
    || type === "extended-rectangle"
    || type === "session-box"
    || type === "liquidity-zone"
    || type === "imbalance-zone";
}

function isRightExtendedZone(drawing: Drawing): boolean {
  return (drawing.type === "extended-rectangle" || drawing.type === "liquidity-zone" || drawing.type === "imbalance-zone")
    && drawing.extendRight !== false;
}

export function zoneRenderBox(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
  const left = Math.min(a.x, b.x);
  const right = drawing.type === "session-box"
    ? Math.max(a.x, b.x)
    : isRightExtendedZone(drawing)
      ? view.area.left + view.area.width
      : Math.max(a.x, b.x);
  const top = drawing.type === "session-box" ? view.area.top : Math.min(a.y, b.y);
  const bottom = drawing.type === "session-box" ? view.area.top + view.area.height : Math.max(a.y, b.y);
  return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function queueZonePriceLabels(
  drawing: Drawing,
  text: string,
  onLineObject?: (price: number, text: string, color: string) => void,
): void {
  if (drawing.showPriceLabel === false || drawing.type === "session-box" || drawing.points.length < 2) return;
  const high = Math.max(drawing.points[0].price, drawing.points[1].price);
  const low = Math.min(drawing.points[0].price, drawing.points[1].price);
  onLineObject?.(high, `${text} H`, drawing.color);
  if (high !== low) onLineObject?.(low, `${text} L`, drawing.color);
}

export function queueZoneTimeLabels(
  drawing: Drawing,
  text: string,
  onTimeObject?: (time: number, text: string, color: string) => void,
): void {
  if (drawing.showTimeLabel === false || drawing.points.length < 2) return;
  onTimeObject?.(drawing.points[0].time, `${text} A`, drawing.color);
  if (!isRightExtendedZone(drawing)) onTimeObject?.(drawing.points[1].time, `${text} B`, drawing.color);
}

export const DEFAULT_FIBONACCI_RETRACEMENT_LEVELS: readonly FibonacciLevel[] = [
  { value: 0 },
  { value: 0.236 },
  { value: 0.382 },
  { value: 0.5 },
  { value: 0.618 },
  { value: 0.786 },
  { value: 1 },
] as const;

export const DEFAULT_FIBONACCI_EXTENSION_LEVELS: readonly FibonacciLevel[] = [
  { value: 0 },
  { value: 0.618 },
  { value: 1 },
  { value: 1.272 },
  { value: 1.618 },
  { value: 2 },
  { value: 2.618 },
] as const;

export function isFibonacciTool(type: DrawingType): boolean {
  return type === "fibonacci-retracement" || type === "fibonacci-extension";
}

function defaultFibonacciLevels(type: DrawingType): FibonacciLevel[] {
  const source = type === "fibonacci-extension" ? DEFAULT_FIBONACCI_EXTENSION_LEVELS : DEFAULT_FIBONACCI_RETRACEMENT_LEVELS;
  return source.map((level) => ({ ...level }));
}

function fibonacciLevels(drawing: Drawing): FibonacciLevel[] {
  return normalizeFibonacciLevels(drawing.fibLevels) ?? defaultFibonacciLevels(drawing.type);
}

function visibleFibonacciLevels(drawing: Drawing): FibonacciLevel[] {
  return fibonacciLevels(drawing).filter((level) => level.visible !== false);
}

function fibonacciLevelTitle(level: FibonacciLevel): string {
  if (level.text && level.text.trim()) return level.text.trim();
  return `${formatFibonacciPercent(level.value)}%`;
}

function fibonacciLevelLabel(drawing: Drawing, level: FibonacciLevel, price: number): string {
  const percent = `${formatFibonacciPercent(level.value)}%`;
  const custom = level.text?.trim();
  const title = custom || percent;
  const formattedPrice = formatPriceLabel(price);
  const format = normalizeFibonacciLabelFormat(drawing.fibLabelFormat);
  if (format === "percent") return title;
  if (format === "price") return formattedPrice;
  if (format === "text-price") return custom ? `${custom} · ${percent} · ${formattedPrice}` : `${percent} · ${formattedPrice}`;
  return `${title} · ${formattedPrice}`;
}

function formatFibonacciPercent(level: number): string {
  const percent = level * 100;
  const abs = Math.abs(percent);
  const decimals = Number.isInteger(percent) ? 0 : abs >= 100 ? 1 : 1;
  return percent.toFixed(decimals).replace(/\.0$/, "");
}

function fibonacciLevelPrice(drawing: Drawing, level: number): number {
  const a = drawing.points[0]?.price ?? 0;
  const b = drawing.points[1]?.price ?? a;
  if (drawing.type === "fibonacci-extension") {
    const c = drawing.points[2]?.price ?? b;
    const impulse = b - a;
    return drawing.fibReverse === true ? c - impulse * level : c + impulse * level;
  }
  return drawing.fibReverse === true ? a + (b - a) * level : b - (b - a) * level;
}

function fibonacciRenderRange(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number } | null,
  view: View,
): { left: number; right: number } {
  const anchors = c ? [a.x, b.x, c.x] : [a.x, b.x];
  const left = drawing.extendLeft === true ? view.area.left : Math.min(...anchors);
  const right = drawing.extendRight !== false ? view.area.left + view.area.width : Math.max(...anchors);
  return { left, right };
}

export function renderFibonacciTool(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
  time: DrawingContext,
  displayName: string,
  onLineObject?: (price: number, text: string, color: string) => void,
): void {
  const c = drawing.type === "fibonacci-extension" && drawing.points[2]
    ? screenPoint(drawing.points[2], view, time)
    : null;
  const { left, right } = fibonacciRenderRange(drawing, a, b, c, view);
  const labelSide = normalizeFibonacciLabelSide(drawing.fibLabelSide);
  const labelPadding = drawing.showPriceLabel !== false && labelSide === "right" ? 78 : 8;
  const labelX = labelSide === "left"
    ? Math.max(left + labelPadding, view.area.left + labelPadding)
    : Math.min(right - labelPadding, view.area.left + view.area.width - labelPadding);
  const labelAlign: CanvasTextAlign = labelSide === "left" ? "left" : "right";
  const visibleLevels = visibleFibonacciLevels(drawing);
  const levelRows = visibleLevels.map((level) => ({ level, price: fibonacciLevelPrice(drawing, level.value) }))
    .map((row) => ({ ...row, y: view.yOfPrice(row.price) }))
    .sort((rowA, rowB) => rowA.y - rowB.y);

  if (drawing.type === "fibonacci-extension" && c) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.7, clamp01(drawing.opacity ?? 1));
    ctx.strokeStyle = drawing.color;
    ctx.lineWidth = Math.max(1, drawing.lineWidth * 0.75);
    ctx.setLineDash([4, 4]);
    drawLine(ctx, a.x, a.y, b.x, b.y);
    drawLine(ctx, b.x, b.y, c.x, c.y);
    ctx.restore();
  }

  if (drawing.fibFillBands !== false && levelRows.length >= 2) {
    for (let index = 0; index < levelRows.length - 1; index++) {
      const upper = levelRows[index];
      const lower = levelRows[index + 1];
      const bandTop = Math.max(view.area.top, Math.min(upper.y, lower.y));
      const bandBottom = Math.min(view.area.top + view.area.height, Math.max(upper.y, lower.y));
      if (bandBottom <= bandTop) continue;
      ctx.save();
      ctx.globalAlpha = clamp01(upper.level.fillOpacity ?? drawing.fillOpacity ?? 0.08);
      ctx.fillStyle = upper.level.fillColor ?? upper.level.color ?? drawing.color;
      ctx.fillRect(left, bandTop, Math.max(0, right - left), bandBottom - bandTop);
      ctx.restore();
    }
  }

  const placedLabels = drawing.showLabel === false
    ? []
    : placeVerticalLabels(
      levelRows.map((row, index) => ({
        ...row,
        desiredY: row.y,
        boxH: 14,
        priority: 1000 - index,
      })),
      view.area.top,
      view.area.top + view.area.height,
      2,
    );
  const labelByValue = new Map(placedLabels.map((row) => [row.level.value, row]));

  for (const level of visibleLevels) {
    const price = fibonacciLevelPrice(drawing, level.value);
    const y = view.yOfPrice(price);
    const color = level.color ?? drawing.color;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = normalizeLineWidth(level.lineWidth ?? drawing.lineWidth);
    applyLineStyle(ctx, level.lineStyle ?? drawing.lineStyle);
    drawLine(ctx, left, y, right, y);
    ctx.restore();

    const placed = labelByValue.get(level.value);
    if (placed) {
      const baselineY = placed.y + 4;
      if (Math.abs(placed.y - y) > 1) {
        ctx.save();
        ctx.globalAlpha = Math.min(0.8, clamp01(drawing.opacity ?? 1));
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(labelX, y);
        ctx.lineTo(labelX, placed.y);
        ctx.stroke();
        ctx.restore();
      }
      drawInlineLabel(ctx, fibonacciLevelLabel(drawing, level, price), color, labelX, baselineY, labelAlign);
    }
    if (drawing.showPriceLabel !== false) onLineObject?.(price, `${displayName} ${fibonacciLevelTitle(level)}`, color);
  }
}

export function fibonacciHitTest(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number },
  view: View,
  time: DrawingContext,
  tolerance: number,
): boolean {
  const c = drawing.type === "fibonacci-extension" && drawing.points[2]
    ? screenPoint(drawing.points[2], view, time)
    : null;
  const { left, right } = fibonacciRenderRange(drawing, a, b, c, view);
  if (p.x < left - tolerance || p.x > right + tolerance) return false;
  if (drawing.type === "fibonacci-extension" && c) {
    if (segmentDistance(p, a, b) <= tolerance || segmentDistance(p, b, c) <= tolerance) return true;
  }
  return visibleFibonacciLevels(drawing).some((level) => Math.abs(p.y - view.yOfPrice(fibonacciLevelPrice(drawing, level.value))) <= tolerance);
}

function channelOffset(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: 0, y: c.y - b.y };
  const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2;
  const projected = { x: a.x + t * dx, y: a.y + t * dy };
  return { x: c.x - projected.x, y: c.y - projected.y };
}

function parallelChannelLines(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  view: View,
): { baseA: { x: number; y: number }; baseB: { x: number; y: number }; outerA: { x: number; y: number }; outerB: { x: number; y: number } } {
  const base = trendRenderLine(drawing, a, b, view);
  const offset = channelOffset(a, b, c);
  return {
    baseA: base.a,
    baseB: base.b,
    outerA: { x: base.a.x + offset.x, y: base.a.y + offset.y },
    outerB: { x: base.b.x + offset.x, y: base.b.y + offset.y },
  };
}

export function renderParallelChannel(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
  time: DrawingContext,
  displayName: string,
): void {
  const third = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : { x: b.x, y: b.y };
  const channel = parallelChannelLines(drawing, a, b, third, view);
  ctx.save();
  ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.1);
  ctx.beginPath();
  ctx.moveTo(channel.baseA.x, channel.baseA.y);
  ctx.lineTo(channel.baseB.x, channel.baseB.y);
  ctx.lineTo(channel.outerB.x, channel.outerB.y);
  ctx.lineTo(channel.outerA.x, channel.outerA.y);
  if (typeof ctx.closePath === "function") ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawLine(ctx, channel.baseA.x, channel.baseA.y, channel.baseB.x, channel.baseB.y);
  drawLine(ctx, channel.outerA.x, channel.outerA.y, channel.outerB.x, channel.outerB.y);
  drawLine(ctx, channel.baseA.x, channel.baseA.y, channel.outerA.x, channel.outerA.y);
  drawLine(ctx, channel.baseB.x, channel.baseB.y, channel.outerB.x, channel.outerB.y);
  if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, channel.outerB.x, channel.outerB.y);
}

export function parallelChannelHitTest(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number },
  view: View,
  time: DrawingContext,
  tolerance: number,
): boolean {
  const third = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : { x: b.x, y: b.y };
  const channel = parallelChannelLines(drawing, a, b, third, view);
  if (segmentDistance(p, channel.baseA, channel.baseB) <= tolerance) return true;
  if (segmentDistance(p, channel.outerA, channel.outerB) <= tolerance) return true;
  if (segmentDistance(p, channel.baseA, channel.outerA) <= tolerance) return true;
  if (segmentDistance(p, channel.baseB, channel.outerB) <= tolerance) return true;
  return pointInConvexQuad(p, [channel.baseA, channel.baseB, channel.outerB, channel.outerA]);
}

function regressionChannelLines(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  view: View,
): { centerA: { x: number; y: number }; centerB: { x: number; y: number }; upperA: { x: number; y: number }; upperB: { x: number; y: number }; lowerA: { x: number; y: number }; lowerB: { x: number; y: number } } {
  const center = trendRenderLine(drawing, a, b, view);
  const offset = channelOffset(a, b, c);
  return {
    centerA: center.a,
    centerB: center.b,
    upperA: { x: center.a.x + offset.x, y: center.a.y + offset.y },
    upperB: { x: center.b.x + offset.x, y: center.b.y + offset.y },
    lowerA: { x: center.a.x - offset.x, y: center.a.y - offset.y },
    lowerB: { x: center.b.x - offset.x, y: center.b.y - offset.y },
  };
}

export function renderRegressionChannel(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
  time: DrawingContext,
  displayName: string,
): void {
  const third = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : { x: b.x, y: b.y };
  const channel = regressionChannelLines(drawing, a, b, third, view);
  ctx.save();
  ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.1);
  ctx.beginPath();
  ctx.moveTo(channel.upperA.x, channel.upperA.y);
  ctx.lineTo(channel.upperB.x, channel.upperB.y);
  ctx.lineTo(channel.lowerB.x, channel.lowerB.y);
  ctx.lineTo(channel.lowerA.x, channel.lowerA.y);
  if (typeof ctx.closePath === "function") ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawLine(ctx, channel.upperA.x, channel.upperA.y, channel.upperB.x, channel.upperB.y);
  drawLine(ctx, channel.lowerA.x, channel.lowerA.y, channel.lowerB.x, channel.lowerB.y);
  ctx.save();
  applyLineStyle(ctx, "dashed");
  drawLine(ctx, channel.centerA.x, channel.centerA.y, channel.centerB.x, channel.centerB.y);
  ctx.restore();
  drawLine(ctx, channel.upperA.x, channel.upperA.y, channel.lowerA.x, channel.lowerA.y);
  drawLine(ctx, channel.upperB.x, channel.upperB.y, channel.lowerB.x, channel.lowerB.y);
  if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, channel.upperB.x, channel.upperB.y);
}

export function regressionChannelHitTest(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number },
  view: View,
  time: DrawingContext,
  tolerance: number,
): boolean {
  const third = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : { x: b.x, y: b.y };
  const channel = regressionChannelLines(drawing, a, b, third, view);
  if (segmentDistance(p, channel.centerA, channel.centerB) <= tolerance) return true;
  if (segmentDistance(p, channel.upperA, channel.upperB) <= tolerance) return true;
  if (segmentDistance(p, channel.lowerA, channel.lowerB) <= tolerance) return true;
  if (segmentDistance(p, channel.upperA, channel.lowerA) <= tolerance) return true;
  if (segmentDistance(p, channel.upperB, channel.lowerB) <= tolerance) return true;
  return pointInConvexQuad(p, [channel.upperA, channel.upperB, channel.lowerB, channel.lowerA]);
}

export function isAnnotationTool(type: DrawingType): boolean {
  return type === "callout-note" || type === "arrow-marker" || type === "arrow-line" || type === "date-marker" || type === "event-marker";
}

export function renderAnnotationTool(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
  displayName: string,
  onTimeObject?: (time: number, text: string, color: string) => void,
): void {
  if (drawing.type === "arrow-line") {
    drawArrowLine(ctx, a, b, drawing.color, drawing.lineWidth);
    if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, b.x, b.y);
    return;
  }
  if (drawing.type === "arrow-marker") {
    drawArrowLine(ctx, { x: a.x, y: a.y + 24 }, a, drawing.color, drawing.lineWidth);
    if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, a.x + 28, a.y - 2);
    return;
  }
  if (drawing.type === "date-marker" || drawing.type === "event-marker") {
    drawLine(ctx, a.x, view.area.top, a.x, view.area.top + view.area.height);
    ctx.save();
    ctx.fillStyle = drawing.color;
    if (drawing.type === "event-marker") {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - 7);
      ctx.lineTo(a.x + 7, a.y);
      ctx.lineTo(a.x, a.y + 7);
      ctx.lineTo(a.x - 7, a.y);
      if (typeof ctx.closePath === "function") ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(a.x - 5, view.area.top + 3, 10, 10);
    }
    ctx.restore();
    if (drawing.showLabel !== false) drawInlineLabel(ctx, displayName, drawing.color, a.x + 8, drawing.type === "date-marker" ? view.area.top + 16 : a.y - 8, "left");
    queueTimeAxisLabel(drawing, 0, displayName, onTimeObject);
    return;
  }
  drawCallout(ctx, drawing, a, displayName);
}

function drawCallout(ctx: CanvasRenderingContext2D, drawing: Drawing, a: { x: number; y: number }, displayName: string): void {
  const text = drawing.text?.trim() || displayName;
  ctx.save();
  ctx.font = "11px ui-monospace, monospace";
  const width = Math.max(56, (typeof ctx.measureText === "function" ? ctx.measureText(text).width : text.length * 7) + 16);
  const height = 24;
  const left = a.x + 10;
  const top = a.y - height - 12;
  ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.18);
  ctx.fillStyle = drawing.color;
  ctx.fillRect(left, top, width, height);
  ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
  ctx.strokeStyle = drawing.color;
  ctx.strokeRect(left, top, width, height);
  drawLine(ctx, a.x, a.y, left, top + height);
  ctx.fillStyle = drawingLabelTextColor;
  ctx.textAlign = "left";
  ctx.fillText(text, left + 8, top + 16);
  ctx.restore();
}

export function annotationHitTest(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number },
  _view: View,
  tolerance: number,
): boolean {
  if (drawing.type === "arrow-line") return segmentDistance(p, a, b) <= tolerance || distance(p, b) <= tolerance + 4;
  if (drawing.type === "arrow-marker" || drawing.type === "event-marker") return distance(p, a) <= tolerance + 7;
  if (drawing.type === "date-marker") return Math.abs(p.x - a.x) <= tolerance;
  const text = drawing.text?.trim() || safeDrawingTypeLabel(drawing.type);
  const width = Math.max(56, text.length * 7 + 16);
  const left = a.x + 10;
  const top = a.y - 36;
  return p.x >= left - tolerance && p.x <= left + width + tolerance && p.y >= top - tolerance && p.y <= top + 24 + tolerance;
}

function drawArrowLine(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, color: string, width: number): void {
  drawLine(ctx, a.x, a.y, b.x, b.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const size = Math.max(8, width * 5);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - size * Math.cos(angle - Math.PI / 6), b.y - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(b.x - size * Math.cos(angle + Math.PI / 6), b.y - size * Math.sin(angle + Math.PI / 6));
  if (typeof ctx.closePath === "function") ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function renderEllipse(ctx: CanvasRenderingContext2D, drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, displayName: string): void {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const width = Math.abs(b.x - a.x);
  const height = Math.abs(b.y - a.y);
  ctx.save();
  ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.14);
  ctx.beginPath();
  ctx.ellipse(left + width / 2, top + height / 2, Math.max(1, width / 2), Math.max(1, height / 2), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
  ctx.stroke();
  ctx.restore();
  if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, left + width, top + 12);
}

export function renderTriangle(ctx: CanvasRenderingContext2D, drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, displayName: string): void {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo((left + right) / 2, top);
  ctx.lineTo(right, bottom);
  ctx.lineTo(left, bottom);
  if (typeof ctx.closePath === "function") ctx.closePath();
  ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.14);
  ctx.fill();
  ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
  ctx.stroke();
  ctx.restore();
  if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, right, top + 12);
}

export function renderBrush(ctx: CanvasRenderingContext2D, drawing: Drawing, view: View, time: DrawingContext): void {
  if (drawing.points.length < 2) return;
  ctx.beginPath();
  const first = screenPoint(drawing.points[0], view, time);
  ctx.moveTo(first.x, first.y);
  for (const point of drawing.points.slice(1)) {
    const p = screenPoint(point, view, time);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

export function ellipseHitTest(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }, tolerance: number): boolean {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.max(1, Math.abs(b.x - a.x) / 2);
  const ry = Math.max(1, Math.abs(b.y - a.y) / 2);
  const normalized = ((p.x - cx) ** 2) / ((rx + tolerance) ** 2) + ((p.y - cy) ** 2) / ((ry + tolerance) ** 2);
  return normalized <= 1.15;
}

export function triangleHitTest(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }, tolerance: number): boolean {
  const left = Math.min(a.x, b.x) - tolerance;
  const right = Math.max(a.x, b.x) + tolerance;
  const top = Math.min(a.y, b.y) - tolerance;
  const bottom = Math.max(a.y, b.y) + tolerance;
  return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
}

export function brushHitTest(drawing: Drawing, p: { x: number; y: number }, view: View, time: DrawingContext, tolerance: number): boolean {
  for (let index = 1; index < drawing.points.length; index++) {
    if (segmentDistance(p, screenPoint(drawing.points[index - 1], view, time), screenPoint(drawing.points[index], view, time)) <= tolerance) return true;
  }
  return false;
}

export function renderPitchfork(ctx: CanvasRenderingContext2D, drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, view: View, time: DrawingContext, displayName: string): void {
  const c = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : { x: b.x, y: b.y };
  for (const line of pitchforkLines(drawing, a, b, c, view)) drawLine(ctx, line.a.x, line.a.y, line.b.x, line.b.y);
  if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, c.x, c.y);
}

function pitchforkLines(drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, view: View): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
  const median = trendRenderLine(drawing, a, mid, view);
  const offsetB = { x: b.x - mid.x, y: b.y - mid.y };
  const offsetC = { x: c.x - mid.x, y: c.y - mid.y };
  return [
    median,
    { a: { x: median.a.x + offsetB.x, y: median.a.y + offsetB.y }, b: { x: median.b.x + offsetB.x, y: median.b.y + offsetB.y } },
    { a: { x: median.a.x + offsetC.x, y: median.a.y + offsetC.y }, b: { x: median.b.x + offsetC.x, y: median.b.y + offsetC.y } },
    { a: b, b: c },
  ];
}

export function pitchforkHitTest(drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }, view: View, time: DrawingContext, tolerance: number): boolean {
  const c = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : { x: b.x, y: b.y };
  return pitchforkLines(drawing, a, b, c, view).some((line) => segmentDistance(p, line.a, line.b) <= tolerance);
}

export function renderGannFan(ctx: CanvasRenderingContext2D, drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, view: View, displayName: string): void {
  for (const line of gannFanLines(drawing, a, b, view)) drawLine(ctx, line.a.x, line.a.y, line.b.x, line.b.y);
  if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, a.x + 24, a.y - 8);
}

function gannFanLines(drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, view: View): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  const dx = Math.max(1, b.x - a.x);
  const slope = (b.y - a.y) / dx;
  return [0.125, 0.25, 0.333, 0.5, 1, 2, 3, 4, 8].map((ratio) => trendRenderLine(drawing, a, { x: b.x, y: a.y + slope * ratio * dx }, view));
}

export function gannFanHitTest(drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }, view: View, tolerance: number): boolean {
  return gannFanLines(drawing, a, b, view).some((line) => segmentDistance(p, line.a, line.b) <= tolerance);
}

export function renderGannGrid(ctx: CanvasRenderingContext2D, drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, _view: View, displayName: string): void {
  const box = { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
  const width = Math.max(1, box.right - box.left);
  const height = Math.max(1, box.bottom - box.top);
  ctx.save();
  ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.04);
  ctx.fillRect(box.left, box.top, width, height);
  ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
  ctx.strokeRect(box.left, box.top, width, height);
  const steps = 4;
  for (let i = 1; i < steps; i++) {
    const x = box.left + width * i / steps;
    const y = box.top + height * i / steps;
    drawLine(ctx, x, box.top, x, box.bottom);
    drawLine(ctx, box.left, y, box.right, y);
  }
  for (let i = -steps; i <= steps; i++) {
    const startX = box.left + width * i / steps;
    drawLine(ctx, startX, box.bottom, startX + width, box.top);
    drawLine(ctx, startX, box.top, startX + width, box.bottom);
  }
  ctx.restore();
  if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, box.right, box.top + 12);
}

export function gannGridHitTest(drawing: Drawing, a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }, _view: View, tolerance: number): boolean {
  void drawing;
  const left = Math.min(a.x, b.x) - tolerance;
  const right = Math.max(a.x, b.x) + tolerance;
  const top = Math.min(a.y, b.y) - tolerance;
  const bottom = Math.max(a.y, b.y) + tolerance;
  return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
}

function pointInConvexQuad(point: { x: number; y: number }, quad: readonly { x: number; y: number }[]): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

function drawInlineLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  color: string,
  x: number,
  y: number,
  align: CanvasTextAlign = "left",
): void {
  ctx.save();
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = align;
  const measuredWidth = typeof ctx.measureText === "function" ? ctx.measureText(text).width : text.length * 6;
  const width = Math.max(12, measuredWidth + 8);
  const left = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
  ctx.fillStyle = drawingLabelPillBg;
  ctx.fillRect(left, y - 11, width, 14);
  ctx.strokeStyle = drawingLabelPillBorder;
  ctx.strokeRect(left, y - 11, width, 14);
  ctx.fillStyle = color;
  ctx.fillText(text, x + (align === "right" ? -4 : align === "left" ? 4 : 0), y);
  ctx.restore();
}

function formatPriceLabel(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 1 : abs >= 1 ? 2 : 4;
  return value.toFixed(decimals);
}

function normalizeParallelChannelPoints(points: DrawingPoint[]): void {
  if (points.length < 2) return;
  if (!points[2]) points[2] = defaultParallelChannelPoint(points[0], points[1]);
}

export function defaultParallelChannelPoint(a: DrawingPoint, b: DrawingPoint): DrawingPoint {
  const priceOffset = Math.abs(b.price - a.price) || Math.max(Math.abs(a.price) * 0.005, 1);
  return { time: b.time, price: b.price + priceOffset };
}

function normalizeFibonacciExtensionPoints(points: DrawingPoint[]): void {
  if (points.length < 2) return;
  if (!points[2]) points[2] = defaultFibonacciExtensionPoint(points[0], points[1]);
}

export function defaultFibonacciExtensionPoint(a: DrawingPoint, b: DrawingPoint): DrawingPoint {
  const timeSpan = Math.max(1, Math.abs(b.time - a.time));
  return { time: b.time + timeSpan, price: b.price };
}

function normalizePitchforkPoints(points: DrawingPoint[]): void {
  if (points.length < 2) return;
  if (!points[2]) points[2] = defaultPitchforkPoint(points[0], points[1]);
}

export function defaultPitchforkPoint(a: DrawingPoint, b: DrawingPoint): DrawingPoint {
  const timeSpan = Math.max(1, Math.abs(b.time - a.time));
  const priceOffset = Math.abs(b.price - a.price) || Math.max(Math.abs(a.price) * 0.005, 1);
  return { time: b.time + timeSpan, price: b.price - priceOffset };
}

export function isMeasurementTool(type: DrawingType): boolean {
  return type === "measure"
    || type === "price-range"
    || type === "date-range"
    || type === "long-position"
    || type === "short-position";
}

export function renderMeasurementTool(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
  time: DrawingContext,
  displayName: string,
  riskSettings: PositionRiskSettings,
  onLineObject?: (price: number, text: string, color: string) => void,
  onTimeObject?: (time: number, text: string, color: string) => void,
): void {
  if (drawing.type === "measure") {
    drawLine(ctx, a.x, a.y, b.x, b.y);
    if (drawing.showLabel !== false) drawCenteredLabel(ctx, measurementSummary(drawing.points[0], drawing.points[1], time), drawing.color, (a.x + b.x) / 2, (a.y + b.y) / 2 - 8);
    return;
  }
  if (drawing.type === "price-range") {
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    ctx.save();
    ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.1);
    ctx.fillRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    ctx.restore();
    const x = right;
    drawLine(ctx, x, top, x, bottom);
    drawLine(ctx, x - 6, top, x + 6, top);
    drawLine(ctx, x - 6, bottom, x + 6, bottom);
    if (drawing.showLabel !== false) drawCenteredLabel(ctx, priceRangeSummary(drawing.points[0], drawing.points[1]), drawing.color, x + 36, (top + bottom) / 2);
    queueRangePriceLabels(drawing, displayName, onLineObject);
    return;
  }
  if (drawing.type === "date-range") {
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const y = a.y;
    drawLine(ctx, left, y, right, y);
    drawLine(ctx, left, y - 6, left, y + 6);
    drawLine(ctx, right, y - 6, right, y + 6);
    if (drawing.showLabel !== false) drawCenteredLabel(ctx, dateRangeSummary(drawing.points[0], drawing.points[1], time), drawing.color, (left + right) / 2, y - 8);
    queueTimeAxisLabel(drawing, 0, `${displayName} A`, onTimeObject);
    queueTimeAxisLabel(drawing, 1, `${displayName} B`, onTimeObject);
    return;
  }
  renderPositionTool(ctx, drawing, a, b, view, time, displayName, riskSettings, onLineObject);
}

function renderPositionTool(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  view: View,
  time: DrawingContext,
  displayName: string,
  riskSettings: PositionRiskSettings,
  onLineObject?: (price: number, text: string, color: string) => void,
): void {
  const levels = positionRiskMetrics(drawing, riskSettings);
  const entryY = view.yOfPrice(levels.entry);
  const stopY = view.yOfPrice(levels.stop);
  const targetY = view.yOfPrice(levels.target);
  const targetPoint = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : null;
  const left = Math.min(a.x, b.x, targetPoint?.x ?? b.x);
  const rawRight = Math.max(a.x, b.x, targetPoint?.x ?? b.x);
  const right = rawRight > left + 16 ? rawRight : Math.min(view.area.left + view.area.width, left + 120);
  const width = Math.max(16, right - left);
  const profitColor = uiColor.buy;
  const riskColor = drawingShortColorDefault;
  ctx.save();
  ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.16);
  ctx.fillStyle = profitColor;
  ctx.fillRect(left, Math.min(entryY, targetY), width, Math.abs(targetY - entryY));
  ctx.fillStyle = riskColor;
  ctx.fillRect(left, Math.min(entryY, stopY), width, Math.abs(stopY - entryY));
  ctx.restore();
  drawLine(ctx, left, entryY, right, entryY);
  ctx.save();
  ctx.strokeStyle = riskColor;
  drawLine(ctx, left, stopY, right, stopY);
  ctx.strokeStyle = profitColor;
  drawLine(ctx, left, targetY, right, targetY);
  ctx.strokeRect(left, Math.min(stopY, targetY), width, Math.abs(targetY - stopY));
  ctx.restore();
  if (drawing.showLabel !== false) {
    drawCenteredLabel(ctx, `${displayName} · ${levels.netRiskReward.toFixed(2)}R · Size ${formatQuantity(levels.positionSize)} · Risk ${formatMoney(levels.netRisk)} · Reward ${formatMoney(levels.netReward)}`, drawing.color, left + width / 2, Math.min(stopY, targetY) - 8);
  }
  if (drawing.showPriceLabel !== false) {
    onLineObject?.(levels.entry, `${displayName} Entry`, drawing.color);
    onLineObject?.(levels.stop, `${displayName} Stop`, riskColor);
    onLineObject?.(levels.target, `${displayName} Target`, profitColor);
  }
}

export function measurementHitTest(
  drawing: Drawing,
  a: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number },
  view: View,
  time: DrawingContext,
  tolerance: number,
  riskSettings: PositionRiskSettings = DEFAULT_POSITION_RISK_SETTINGS,
): boolean {
  if (drawing.type === "measure") return segmentDistance(p, a, b) <= tolerance;
  if (drawing.type === "price-range") {
    const left = Math.min(a.x, b.x) - tolerance;
    const right = Math.max(a.x, b.x) + tolerance;
    const top = Math.min(a.y, b.y) - tolerance;
    const bottom = Math.max(a.y, b.y) + tolerance;
    return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
  }
  if (drawing.type === "date-range") {
    const left = Math.min(a.x, b.x) - tolerance;
    const right = Math.max(a.x, b.x) + tolerance;
    return p.x >= left && p.x <= right && Math.abs(p.y - a.y) <= tolerance;
  }
  const levels = positionRiskMetrics(drawing, riskSettings);
  const entryY = view.yOfPrice(levels.entry);
  const stopY = view.yOfPrice(levels.stop);
  const targetY = view.yOfPrice(levels.target);
  const targetPoint = drawing.points[2] ? screenPoint(drawing.points[2], view, time) : null;
  const left = Math.min(a.x, b.x, targetPoint?.x ?? b.x) - tolerance;
  const right = Math.max(a.x, b.x, targetPoint?.x ?? b.x, a.x + 120) + tolerance;
  const top = Math.min(entryY, stopY, targetY) - tolerance;
  const bottom = Math.max(entryY, stopY, targetY) + tolerance;
  return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
}

function drawCenteredLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  color: string,
  x: number,
  y: number,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
  ctx.restore();
}

function measurementSummary(a: DrawingPoint, b: DrawingPoint, time: DrawingContext): string {
  return `${priceRangeSummary(a, b)} · ${dateRangeSummary(a, b, time)}`;
}

function priceRangeSummary(a: DrawingPoint, b: DrawingPoint): string {
  const diff = b.price - a.price;
  const pct = a.price !== 0 ? diff / a.price * 100 : 0;
  return `${formatPriceDelta(diff)} (${formatPercentDelta(pct)})`;
}

function dateRangeSummary(a: DrawingPoint, b: DrawingPoint, time: DrawingContext): string {
  const bars = Math.abs(time.indexForTime(b.time) - time.indexForTime(a.time));
  return `${bars} bars · ${formatDuration(Math.abs(b.time - a.time))}`;
}

function formatPriceDelta(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return `${sign}${abs.toFixed(decimals)}`;
}

function formatPercentDelta(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(Math.abs(value) >= 1000 ? 1 : 2);
}

function formatQuantity(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  if (ms >= day) return `${(ms / day).toFixed(ms >= day * 10 ? 0 : 1)}d`;
  if (ms >= hour) return `${(ms / hour).toFixed(ms >= hour * 10 ? 0 : 1)}h`;
  if (ms >= minute) return `${(ms / minute).toFixed(ms >= minute * 10 ? 0 : 1)}m`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function queueRangePriceLabels(
  drawing: Drawing,
  text: string,
  onLineObject?: (price: number, text: string, color: string) => void,
): void {
  if (drawing.showPriceLabel === false || drawing.points.length < 2) return;
  onLineObject?.(drawing.points[0].price, `${text} A`, drawing.color);
  if (drawing.points[1].price !== drawing.points[0].price) onLineObject?.(drawing.points[1].price, `${text} B`, drawing.color);
}

export function positionRiskMetrics(drawing: Drawing, settings: PositionRiskSettings = DEFAULT_POSITION_RISK_SETTINGS): PositionRiskMetrics {
  const entry = drawing.points[0]?.price ?? 0;
  const stop = drawing.points[1]?.price ?? entry;
  const risk = Math.abs(entry - stop);
  const direction = drawing.type === "short-position" ? -1 : 1;
  const fallbackTarget = entry + direction * risk * 2;
  const target = drawing.points[2]?.price ?? fallbackTarget;
  const reward = Math.abs(target - entry);
  const riskReward = risk > 0 ? reward / risk : 0;
  const normalizedSettings = normalizePositionRiskSettings(settings);
  const accountBalance = normalizedSettings.accountBalance;
  const riskPercent = normalizePercentValue(drawing.riskPercent, normalizedSettings.riskPercent, 100);
  const makerFeeRate = normalizedSettings.makerFeeRate;
  const takerFeeRate = normalizedSettings.takerFeeRate;
  const entryOrderType = normalizeOrderKind(drawing.entryOrderType, "limit");
  const stopOrderType = normalizeOrderKind(drawing.stopOrderType, "market");
  const targetOrderType = normalizeOrderKind(drawing.targetOrderType, "limit");
  const entryFeeRate = feeRateFor(entryOrderType, makerFeeRate, takerFeeRate);
  const stopFeeRate = feeRateFor(stopOrderType, makerFeeRate, takerFeeRate);
  const targetFeeRate = feeRateFor(targetOrderType, makerFeeRate, takerFeeRate);
  const riskBudget = accountBalance * riskPercent / 100;
  const riskPerUnitGross = risk;
  const riskPerUnitWithFees = riskPerUnitGross + entry * entryFeeRate + stop * stopFeeRate;
  const positionSize = riskPerUnitWithFees > 0 ? riskBudget / riskPerUnitWithFees : 0;
  const notional = positionSize * entry;
  const entryFee = positionSize * entry * entryFeeRate;
  const stopFee = positionSize * stop * stopFeeRate;
  const targetFee = positionSize * target * targetFeeRate;
  const rewardPerUnitGross = reward;
  const rewardPerUnitNet = rewardPerUnitGross - entry * entryFeeRate - target * targetFeeRate;
  const netRisk = positionSize * riskPerUnitGross + entryFee + stopFee;
  const netReward = positionSize * rewardPerUnitGross - entryFee - targetFee;
  const netRiskReward = netRisk > 0 ? netReward / netRisk : 0;
  return {
    entry, stop, target, risk, reward, riskReward, accountBalance, riskPercent, riskBudget,
    makerFeeRate, takerFeeRate, entryOrderType, stopOrderType, targetOrderType,
    entryFeeRate, stopFeeRate, targetFeeRate, riskPerUnitGross, riskPerUnitWithFees,
    rewardPerUnitGross, rewardPerUnitNet, positionSize, notional, entryFee, stopFee, targetFee,
    netRisk, netReward, netRiskReward,
  };
}

function normalizePositionRiskConfigInPlace(drawing: Drawing): void {
  if (!isPositionTool(drawing.type)) return;
  if (drawing.riskPercent != null) drawing.riskPercent = normalizePercentValue(drawing.riskPercent, 1, 100);
  delete drawing.accountBalance;
  delete drawing.makerFeeRate;
  delete drawing.takerFeeRate;
  drawing.entryOrderType = normalizeOrderKind(drawing.entryOrderType, "limit");
  drawing.stopOrderType = normalizeOrderKind(drawing.stopOrderType, "market");
  drawing.targetOrderType = normalizeOrderKind(drawing.targetOrderType, "limit");
}

export function normalizePositionRiskSettings(settings: Partial<PositionRiskSettings> | undefined): PositionRiskSettings {
  return {
    accountBalance: normalizePositiveNumber(settings?.accountBalance, DEFAULT_POSITION_RISK_SETTINGS.accountBalance),
    riskPercent: normalizePercentValue(settings?.riskPercent, DEFAULT_POSITION_RISK_SETTINGS.riskPercent, 100),
    makerFeeRate: normalizeFeeRate(settings?.makerFeeRate, DEFAULT_POSITION_RISK_SETTINGS.makerFeeRate),
    takerFeeRate: normalizeFeeRate(settings?.takerFeeRate, DEFAULT_POSITION_RISK_SETTINGS.takerFeeRate),
  };
}

function feeRateFor(kind: PositionOrderKind, makerFeeRate: number, takerFeeRate: number): number {
  return kind === "market" ? takerFeeRate : makerFeeRate;
}

function normalizeOrderKind(value: unknown, fallback: PositionOrderKind): PositionOrderKind {
  return value === "market" || value === "limit" ? value : fallback;
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value != null && value > 0 ? value : fallback;
}

function normalizePercentValue(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value == null) return fallback;
  return Math.max(0.01, Math.min(max, value));
}

function normalizeFeeRate(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null) return fallback;
  return Math.max(0, Math.min(0.02, value));
}

function defaultPositionTarget(entry: DrawingPoint, stop: DrawingPoint, type: DrawingType): DrawingPoint {
  const direction = type === "short-position" ? -1 : 1;
  const risk = Math.abs(entry.price - stop.price);
  return { time: stop.time, price: entry.price + direction * risk * 2 };
}

function normalizePositionPoints(points: DrawingPoint[], type: DrawingType, editedPointIndex: number): void {
  if (points.length < 2) return;
  if (!points[2]) points[2] = defaultPositionTarget(points[0], points[1], type);

  const entry = points[0].price;
  if (type === "long-position") {
    if (editedPointIndex === 0) {
      const lower = Math.min(points[1].price, points[2].price);
      const upper = Math.max(points[1].price, points[2].price);
      points[0] = { ...points[0], price: Math.max(lower, Math.min(upper, points[0].price)) };
    } else if (editedPointIndex === 1) {
      points[1] = { ...points[1], price: Math.min(points[1].price, entry) };
    } else if (editedPointIndex === 2) {
      points[2] = { ...points[2], price: Math.max(points[2].price, entry) };
    } else {
      points[1] = { ...points[1], price: Math.min(points[1].price, entry) };
      points[2] = { ...points[2], price: Math.max(points[2].price, entry) };
    }
  } else if (type === "short-position") {
    if (editedPointIndex === 0) {
      const lower = Math.min(points[1].price, points[2].price);
      const upper = Math.max(points[1].price, points[2].price);
      points[0] = { ...points[0], price: Math.max(lower, Math.min(upper, points[0].price)) };
    } else if (editedPointIndex === 1) {
      points[1] = { ...points[1], price: Math.max(points[1].price, entry) };
    } else if (editedPointIndex === 2) {
      points[2] = { ...points[2], price: Math.min(points[2].price, entry) };
    } else {
      points[1] = { ...points[1], price: Math.max(points[1].price, entry) };
      points[2] = { ...points[2], price: Math.min(points[2].price, entry) };
    }
  }
}

function constrainPositionPointEdit(drawing: Drawing, index: number, point: DrawingPoint): DrawingPoint {
  const entry = drawing.points[0];
  const stop = drawing.points[1];
  const target = drawing.points[2] ?? defaultPositionTarget(entry, stop, drawing.type);
  const original = drawing.points[index] ?? point;
  const withLockedTime = (price: number): DrawingPoint => ({ time: original.time, price });
  if (drawing.type === "long-position") {
    if (index === 0) return withLockedTime(Math.max(stop.price, Math.min(target.price, point.price)));
    if (index === 1) return withLockedTime(Math.min(point.price, entry.price));
    if (index === 2) return withLockedTime(Math.max(point.price, entry.price));
  }
  if (drawing.type === "short-position") {
    if (index === 0) return withLockedTime(Math.max(target.price, Math.min(stop.price, point.price)));
    if (index === 1) return withLockedTime(Math.max(point.price, entry.price));
    if (index === 2) return withLockedTime(Math.min(point.price, entry.price));
  }
  return { ...point, time: original.time };
}