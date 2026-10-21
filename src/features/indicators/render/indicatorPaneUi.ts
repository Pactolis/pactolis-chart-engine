import type { IndicatorScale } from "../scale/indicatorScale.js";
import type { IndicatorDrawContext, IndicatorPaneRect, IndicatorReadout, IndicatorSettings } from "../types.js";
import {
  uiColor,
  indicatorBadgeBg,
  indicatorBadgeBorder,
  indicatorReadoutTextColor,
  indicatorMessageTextColor,
  indicatorLastValueTextColor,
  indicatorAxisTickTextColor,
  indicatorHoverGuideColor,
  axisLabelBorderColor,
} from "../../../core/ui/seriesPalette.js";

export const INDICATOR_PANE_HEADER_H = 24;

export interface IndicatorBadgeOptions {
  color?: string;
  align?: CanvasTextAlign;
  maxWidth?: number;
}

export interface IndicatorLastValueLabelOptions {
  text: string;
  y: number;
  color: string;
  textColor?: string;
}

export function compactNumber(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `${sign}${(absolute / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${sign}${(absolute / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${sign}${(absolute / 1e3).toFixed(1)}K`;
  return `${sign}${absolute.toFixed(2)}`;
}

export function compactUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `${sign}$${(absolute / 1e9).toFixed(3)}B`;
  if (absolute >= 1e6) return `${sign}$${(absolute / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${sign}$${(absolute / 1e3).toFixed(1)}K`;
  return `${sign}$${absolute.toFixed(0)}`;
}

export function settingEnabled(
  settings: IndicatorSettings,
  key: string,
  fallbackKey: string | null,
  defaultValue: boolean,
): boolean {
  const primary = settings[key];
  if (typeof primary === "boolean") return primary;
  if (fallbackKey) {
    const fallback = settings[fallbackKey];
    if (typeof fallback === "boolean") return fallback;
  }
  return defaultValue;
}

export function drawIndicatorBadge(
  canvas: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: IndicatorBadgeOptions = {},
): void {
  canvas.save();
  canvas.font = "11px ui-monospace, monospace";
  canvas.textAlign = options.align ?? "left";
  canvas.textBaseline = "middle";

  const padX = 8;
  const h = 20;
  const maxWidth = options.maxWidth ?? 260;
  const clipped = truncateCanvasText(canvas, text, Math.max(32, maxWidth - padX * 2));
  const w = Math.min(maxWidth, canvas.measureText(clipped).width + padX * 2);
  const left = canvas.textAlign === "right" ? x - w : x;
  const top = y - h / 2;

  canvas.fillStyle = indicatorBadgeBg;
  if (typeof canvas.roundRect === "function" && typeof canvas.fill === "function") {
    canvas.beginPath();
    canvas.roundRect(left, top, w, h, 4);
    canvas.fill();
    canvas.strokeStyle = indicatorBadgeBorder;
    canvas.beginPath();
    canvas.roundRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1), 3.5);
    canvas.stroke();
  } else {
    canvas.fillRect(left, top, w, h);
    canvas.strokeStyle = indicatorBadgeBorder;
    canvas.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
  }
  canvas.fillStyle = options.color ?? uiColor.info;
  canvas.fillRect(left + 1, top + 3, 2, h - 6);
  canvas.fillStyle = options.color ?? uiColor.textHeading;
  canvas.fillText(clipped, canvas.textAlign === "right" ? x - padX : x + padX + 2, y);
  canvas.restore();
}

export function drawIndicatorReadout(
  ctx: IndicatorDrawContext,
  text: string,
  y = ctx.rect.top + INDICATOR_PANE_HEADER_H + 14,
  color = indicatorReadoutTextColor,
): void {
  drawIndicatorBadge(ctx.ctx, text, ctx.view.area.left + ctx.view.area.width - 6, y, {
    color,
    align: "right",
    maxWidth: Math.max(240, Math.min(620, ctx.view.area.width - 16)),
  });
}


export function indicatorReadoutToText(readout: IndicatorReadout): string {
  const parts: string[] = [];
  if (readout.title) parts.push(readout.title);
  if (readout.time) parts.push(readout.time);
  for (const item of readout.items) {
    if (item.value === undefined || item.value === "") {
      parts.push(item.label);
    } else if (item.label) {
      parts.push(`${item.label} ${item.value}`);
    } else {
      parts.push(item.value);
    }
  }
  return parts.join(" · ");
}

export function drawIndicatorMessage(
  ctx: IndicatorDrawContext,
  message: string,
  color = indicatorMessageTextColor,
): void {
  const y = ctx.rect.top + INDICATOR_PANE_HEADER_H + Math.max(18, (ctx.rect.height - INDICATOR_PANE_HEADER_H) / 2);
  drawIndicatorBadge(ctx.ctx, `${ctx.instance.title}: ${message}`, ctx.view.area.left + 8, y, {
    color,
    align: "left",
    maxWidth: Math.max(180, ctx.view.area.width - 16),
  });
}

export function drawIndicatorLastValueLabel(
  ctx: IndicatorDrawContext,
  options: IndicatorLastValueLabelOptions,
): void {
  const { ctx: canvas, view } = ctx;
  const text = options.text;
  const padX = 5;
  const height = 18;
  const x = view.area.left + view.area.width - 4;

  canvas.save();
  canvas.font = "10px ui-monospace, monospace";
  canvas.textBaseline = "middle";
  canvas.textAlign = "right";
  const width = canvas.measureText(text).width + padX * 2;
  const boxX = x - width;
  const boxY = options.y - height / 2;
  canvas.fillStyle = options.color;
  if (typeof canvas.roundRect === "function" && typeof canvas.fill === "function") {
    canvas.beginPath();
    canvas.roundRect(boxX, boxY, width, height, 4);
    canvas.fill();
    canvas.strokeStyle = "rgba(15, 22, 34, 0.45)";
    canvas.beginPath();
    canvas.roundRect(boxX + 0.5, boxY + 0.5, Math.max(0, width - 1), Math.max(0, height - 1), 3.5);
    canvas.stroke();
  } else {
    canvas.fillRect(boxX, boxY, width, height);
  }
  canvas.fillStyle = options.textColor ?? indicatorLastValueTextColor;
  canvas.fillText(text, x - padX, options.y);
  canvas.restore();
}


export function drawIndicatorAxisTicks(
  ctx: IndicatorDrawContext,
  scale: IndicatorScale,
  top: number,
  bottom: number,
  count = 3,
): void {
  const { ctx: canvas, view } = ctx;
  const axisX = view.area.left + view.area.width;
  const axisW = Math.max(0, view.priceAxisW);
  canvas.save();
  canvas.font = "12px ui-monospace, monospace";
  canvas.textAlign = "right";
  canvas.textBaseline = "middle";
  canvas.strokeStyle = uiColor.separatorStrong;
  for (const tick of scale.ticks(count)) {
    // Clamp instead of skipping: min/max ticks land exactly on the pane
    // bounds, so a skip filter would always drop them (only $0 survived).
    const y = Math.max(top + 8, Math.min(bottom - 8, tick.y));
    canvas.beginPath();
    canvas.moveTo(axisX - 5, y + 0.5);
    canvas.lineTo(axisX, y + 0.5);
    canvas.stroke();
    canvas.fillStyle = indicatorAxisTickTextColor;
    if (axisW > 0) {
      // Labels live in the price-axis gutter, mirroring drawPriceAxis placement.
      canvas.fillText(tick.label, axisX + axisW - 6, y);
    } else {
      canvas.fillText(tick.label, axisX - 8, y);
    }
  }
  canvas.restore();
}

/** Crosshair value readout in the price-axis gutter — sub-pane counterpart of drawCrosshairPriceLabel. */
export function drawIndicatorCrosshairValueLabel(
  ctx: IndicatorDrawContext,
  scale: IndicatorScale,
  top: number,
  bottom: number,
): void {
  const ch = ctx.crosshair;
  if (!ch?.visible || ch.y < top || ch.y > bottom) return;
  const { ctx: canvas, view } = ctx;
  const axisW = Math.max(0, view.priceAxisW);
  if (axisW <= 0) return;
  const value = scale.valueAtY(ch.y);
  const text = scale.format(value);
  const axisX = view.area.left + view.area.width;
  canvas.save();
  canvas.font = "10px ui-monospace, monospace";
  const padX = 3;
  const boxW = Math.min(axisW - 2, Math.ceil(canvas.measureText(text).width) + padX * 2);
  const boxH = 16;
  const y = Math.max(top + boxH / 2, Math.min(bottom - boxH / 2, ch.y));
  const boxX = axisX + axisW - boxW - 1;
  const boxY = y - boxH / 2;
  canvas.fillStyle = "rgba(15, 22, 34, 0.94)";
  if (typeof canvas.roundRect === "function" && typeof canvas.fill === "function") {
    canvas.beginPath();
    canvas.roundRect(boxX, boxY, boxW, boxH, 4);
    canvas.fill();
    canvas.strokeStyle = axisLabelBorderColor;
    canvas.beginPath();
    canvas.roundRect(boxX + 0.5, boxY + 0.5, Math.max(0, boxW - 1), Math.max(0, boxH - 1), 3.5);
    canvas.stroke();
  } else {
    canvas.fillRect(boxX, boxY, boxW, boxH);
    canvas.strokeStyle = axisLabelBorderColor;
    canvas.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
  }
  canvas.fillStyle = uiColor.textHeading;
  canvas.textAlign = "right";
  canvas.textBaseline = "middle";
  canvas.fillText(text, boxX + boxW - padX, y);
  canvas.restore();
}

export function panePlotBounds(rect: IndicatorPaneRect, topInset = 32, bottomInset = 5): { top: number; bottom: number; height: number } {
  const top = rect.top + INDICATOR_PANE_HEADER_H + topInset;
  const bottom = rect.top + rect.height - bottomInset;
  return { top, bottom, height: Math.max(1, bottom - top) };
}

export function drawHoveredVerticalGuide(
  canvas: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
): void {
  canvas.save();
  canvas.strokeStyle = indicatorHoverGuideColor;
  canvas.setLineDash([3, 3]);
  canvas.beginPath();
  canvas.moveTo(x, top);
  canvas.lineTo(x, bottom);
  canvas.stroke();
  canvas.restore();
}

function truncateCanvasText(canvas: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (canvas.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (canvas.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, Math.max(0, lo)) + ellipsis;
}
