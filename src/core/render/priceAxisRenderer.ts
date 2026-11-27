import type { View } from "../engine/view.js";
import type { FootprintSeries } from "../model/footprint.js";
import { axisLayoutForChartView } from "../model/axisLayout.js";
import type { Crosshair } from "./overlay.js";
import { clampLabelY, configDecimals, placeVerticalLabels, priceDecimals } from "../axisLabelUtils.js";
import { uiColor, axisGridLineColor, axisMajorLabelColor, axisLabelBorderColor } from "../ui/seriesPalette.js";
import { settings } from "../settings.js";
import type { ResolvedChartDisplayOptions } from "../model/chartDisplayOptions.js";

const priceAxisFormatterCache = new Map<string, Intl.NumberFormat | null>();

function formatPriceAxisMark(price: number, label: string, decimals: number, options?: ResolvedChartDisplayOptions): string {
  const locale = options?.numberLocale;
  if (!locale || locale === "en-US" || !Number.isInteger(decimals) || decimals < 0 || decimals > 100) return label;
  const key = locale + "|" + decimals;
  let formatter = priceAxisFormatterCache.get(key);
  if (formatter === undefined) {
    try {
      formatter = new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: false,
      });
    } catch {
      formatter = null;
    }
    if (priceAxisFormatterCache.size >= 32) priceAxisFormatterCache.delete(priceAxisFormatterCache.keys().next().value!);
    priceAxisFormatterCache.set(key, formatter);
  }
  return formatter?.format(price) ?? label;
}

const PRICE_AXIS_FONT = "12px ui-monospace, monospace";
const PRICE_LABEL_FONT = "11px ui-monospace, monospace";
const PRICE_LABEL_HEIGHT = 16;
const PRICE_AXIS_TEXT_WIDTH_CACHE_MAX = 512;
const priceAxisTextWidthCacheByCtx = new WeakMap<CanvasRenderingContext2D, Map<string, number>>();

function measurePriceAxisTextWidth(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  let cache = priceAxisTextWidthCacheByCtx.get(ctx);
  if (!cache) {
    cache = new Map();
    priceAxisTextWidthCacheByCtx.set(ctx, cache);
  }
  const key = `${font}|${text}`;
  let width = cache.get(key);
  if (width === undefined) {
    width = ctx.measureText(text).width;
    if (cache.size >= PRICE_AXIS_TEXT_WIDTH_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, width);
  }
  return width;
}

export interface PriceMarker {
  price: number;
  color: string;
  priority: number;
  text?: string;
}

/** A rectangle price tick labels keep out of, in canvas px (the touch scale buttons sit in the gutter). */
export interface PriceAxisKeepOut {
  y: number;
  h: number;
}

interface PaintPriceAxisOptions {
  readonly drawGrid: boolean;
  readonly includeCornerAndFullSeparator: boolean;
}

function paintPriceAxis(
  ctx: CanvasRenderingContext2D,
  view: View,
  priceStep: number,
  pricePrecision: number | undefined,
  keepOut: readonly PriceAxisKeepOut[],
  displayOptions: ResolvedChartDisplayOptions | undefined,
  options: PaintPriceAxisOptions,
): number[] {
  const dec = pricePrecision ?? priceDecimals(priceStep);
  const layout = axisLayoutForChartView(view);
  const axisX = layout.priceAxisRect.left;
  const axisW = layout.priceAxisRect.width;
  ctx.fillStyle = uiColor.bgApp;
  // Fill only down to the main plot bottom: the sub-pane gutter band is
  // filled by drawSubPanes before indicator axis ticks are drawn into it.
  const gutterFillH = Math.min(layout.priceAxisRect.height, view.area.top + view.area.height);
  ctx.fillRect(layout.priceAxisRect.left, layout.priceAxisRect.top, layout.priceAxisRect.width, gutterFillH);
  if (options.includeCornerAndFullSeparator) {
    ctx.fillRect(layout.cornerRect.left, layout.cornerRect.top, layout.cornerRect.width, layout.cornerRect.height);
  }
  const separatorBottom = options.includeCornerAndFullSeparator
    ? layout.cornerRect.top + layout.cornerRect.height
    : layout.priceAxisRect.top + gutterFillH;
  ctx.strokeStyle = uiColor.separator;
  ctx.beginPath();
  ctx.moveTo(axisX + 0.5, layout.priceAxisRect.top);
  ctx.lineTo(axisX + 0.5, separatorBottom);
  ctx.stroke();

  ctx.font = PRICE_AXIS_FONT;
  ctx.fillStyle = uiColor.textSecondary;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const marks = view.priceMarks(dec, 11);
  const gridYs: number[] = [];
  for (const mark of marks) {
    const y = view.area.top + mark.coord;
    if (y < view.area.top - 1 || y > view.area.top + view.area.height + 1) continue;
    gridYs.push(y);
    // Global grid toggle: skip only the plot grid stroke. Labels, background,
    // separator, price markers and crosshair stay untouched.
    if (options.drawGrid && settings.grid) {
      ctx.strokeStyle = axisGridLineColor;
      ctx.beginPath();
      ctx.moveTo(view.area.left, y);
      ctx.lineTo(axisX, y);
      ctx.stroke();
    }
    const label = formatPriceAxisMark(mark.price, mark.label, dec, displayOptions);
    const boxH = 16;
    const labelY = clampLabelY(view, y, boxH);
    if (keepOut.some((zone) => labelY + boxH / 2 > zone.y && labelY - boxH / 2 < zone.y + zone.h)) continue;
    ctx.fillStyle = axisMajorLabelColor;
    ctx.textAlign = "right";
    ctx.fillText(label, axisX + axisW - 6, labelY);
  }
  return gridYs;
}

export function drawPriceAxis(
  ctx: CanvasRenderingContext2D,
  view: View,
  priceStep: number,
  pricePrecision?: number,
  keepOut: readonly PriceAxisKeepOut[] = [],
  displayOptions?: ResolvedChartDisplayOptions,
): void {
  paintPriceAxis(ctx, view, priceStep, pricePrecision, keepOut, displayOptions, {
    drawGrid: true,
    includeCornerAndFullSeparator: true,
  });
}

/** Draw only the static price-axis gutter strip (excluding plot grid and corner stub) and return grid y positions. */
export function drawPriceAxisStrip(
  ctx: CanvasRenderingContext2D,
  view: View,
  priceStep: number,
  pricePrecision?: number,
  keepOut: readonly PriceAxisKeepOut[] = [],
  displayOptions?: ResolvedChartDisplayOptions,
): number[] {
  return paintPriceAxis(ctx, view, priceStep, pricePrecision, keepOut, displayOptions, {
    drawGrid: false,
    includeCornerAndFullSeparator: false,
  });
}

/** Draw cached horizontal plot grid lines directly onto the main annotation context. */
export function drawPriceAxisGridLines(
  ctx: CanvasRenderingContext2D,
  view: View,
  gridYs: readonly number[],
): void {
  if (!settings.grid || gridYs.length === 0) return;
  const axisX = view.area.left + view.area.width;
  ctx.strokeStyle = axisGridLineColor;
  for (const y of gridYs) {
    ctx.beginPath();
    ctx.moveTo(view.area.left, y);
    ctx.lineTo(axisX, y);
    ctx.stroke();
  }
}

export function drawPriceMarkers(
  ctx: CanvasRenderingContext2D,
  view: View,
  priceMarkers: readonly PriceMarker[],
  priceStep: number,
  pricePrecision?: number,
  displayOptions?: ResolvedChartDisplayOptions,
): void {
  const dec = pricePrecision ?? priceDecimals(priceStep);
  const boxH = PRICE_LABEL_HEIGHT;
  const byKey = new Map<string, { price: number; color: string; priority: number; desiredY: number; boxH: number; text?: string }>();
  for (let i = 0; i < priceMarkers.length; i++) {
    const item = priceMarkers[i];
    const desiredY = view.yOfPrice(item.price);
    if (desiredY < view.area.top || desiredY > view.area.top + view.area.height) continue;
    const key = `${item.price.toFixed(dec)}|${item.color}|${item.text ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        price: item.price,
        color: item.color,
        priority: item.priority,
        desiredY,
        boxH,
        text: item.text,
      });
    } else if (item.priority > prev.priority) {
      prev.price = item.price;
      prev.color = item.color;
      prev.priority = item.priority;
      prev.desiredY = desiredY;
      prev.text = item.text;
    }
  }
  if (byKey.size === 0) return;
  const deduped = Array.from(byKey.values());
  const labels = placeVerticalLabels(deduped, view.area.top, view.area.top + view.area.height, 2);
  if (!labels.length) return;
  const axisX = view.area.left + view.area.width;
  const axisW = view.priceAxisW;
  // Compact charts keep the live price inside the gutter: the "Price" caption would cover a third of a phone's plot.
  const compact = view.chartLayoutOptions.density === "compact";
  ctx.save();
  ctx.font = PRICE_LABEL_FONT;
  ctx.textBaseline = "middle";
  for (const label of labels) {
    const livePrice = label.priority >= 100 && !label.text;
    const priceText = formatPriceAxisMark(label.price, label.price.toFixed(dec), dec, displayOptions);
    const text = label.text ?? (livePrice && !compact ? `${displayOptions?.labels.price ?? "Price"} ${priceText}` : priceText);
    const padX = 3;
    const maxBoxW = label.text || (livePrice && !compact) ? Math.max(axisW - 2, 180) : axisW - 2;
    // The compact live price spans the gutter, so a tick label at the same height is covered whole, not left peeking out.
    const minBoxW = livePrice && compact ? axisW - 2 : 0;
    const boxW = Math.min(maxBoxW, Math.max(minBoxW, Math.ceil(measurePriceAxisTextWidth(ctx, PRICE_LABEL_FONT, text)) + padX * 2));
    const boxX = axisX + axisW - boxW - 1;
    const boxY = label.y - boxH / 2;
    ctx.fillStyle = label.color;
    if (typeof ctx.roundRect === "function" && typeof ctx.fill === "function") {
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 3.5);
      ctx.fill();
      ctx.strokeStyle = "rgba(11, 16, 24, 0.38)";
      ctx.beginPath();
      ctx.roundRect(boxX + 0.5, boxY + 0.5, Math.max(0, boxW - 1), Math.max(0, boxH - 1), 3);
      ctx.stroke();
    } else {
      ctx.fillRect(boxX, boxY, boxW, boxH);
    }
    ctx.fillStyle = uiColor.bgApp;
    ctx.textAlign = "right";
    ctx.fillText(text, boxX + boxW - padX, label.y);
  }
  ctx.restore();
}

/** Crosshair price readout on the right axis — drawn after drawPriceMarkers so it's on top. */
export function drawCrosshairPriceLabel(
  ctx: CanvasRenderingContext2D,
  view: View,
  series: FootprintSeries,
  ch: Crosshair,
  displayOptions?: ResolvedChartDisplayOptions,
): void {
  if (ch.y < view.area.top || ch.y > view.area.top + view.area.height) return;
  const price = view.priceOfY(ch.y);
  const axisX = view.area.left + view.area.width;
  const decimals = configDecimals(series.config);
  const text = formatPriceAxisMark(price, price.toFixed(decimals), decimals, displayOptions);
  ctx.font = PRICE_LABEL_FONT;
  const padX = 3;
  const axisW = view.priceAxisW;
  const boxW = Math.min(axisW - 2, Math.ceil(measurePriceAxisTextWidth(ctx, PRICE_LABEL_FONT, text)) + padX * 2);
  const boxX = axisX + axisW - boxW - 1;
  const labelY = clampLabelY(view, ch.y, PRICE_LABEL_HEIGHT);
  const boxY = labelY - PRICE_LABEL_HEIGHT / 2;
  ctx.fillStyle = uiColor.bgPanelAlt;
  if (typeof ctx.roundRect === "function" && typeof ctx.fill === "function") {
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, PRICE_LABEL_HEIGHT, 3.5);
    ctx.fill();
    ctx.strokeStyle = axisLabelBorderColor;
    ctx.beginPath();
    ctx.roundRect(boxX + 0.5, labelY - 7.5, Math.max(0, boxW - 1), 15, 3);
    ctx.stroke();
  } else {
    ctx.fillRect(boxX, boxY, boxW, PRICE_LABEL_HEIGHT);
    ctx.strokeStyle = axisLabelBorderColor;
    ctx.strokeRect(boxX + 0.5, labelY - 7.5, boxW - 1, 15);
  }
  ctx.fillStyle = uiColor.textHeading;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(text, boxX + boxW - padX, labelY);
}
