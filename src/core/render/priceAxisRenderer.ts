import type { View } from "../engine/view.js";
import type { FootprintSeries } from "../model/footprint.js";
import { axisLayoutForChartView } from "../model/axisLayout.js";
import type { Crosshair } from "./overlay.js";
import { clampLabelY, configDecimals, placeVerticalLabels, priceDecimals } from "../axisLabelUtils.js";
import { uiColor, axisGridLineColor, axisMajorLabelColor, axisLabelBorderColor } from "../ui/seriesPalette.js";
import { settings } from "../settings.js";

const PRICE_AXIS_FONT = "12px ui-monospace, monospace";
const PRICE_LABEL_FONT = "11px ui-monospace, monospace";
const PRICE_LABEL_HEIGHT = 16;

export interface PriceMarker {
  price: number;
  color: string;
  priority: number;
  text?: string;
}

export function drawPriceAxis(
  ctx: CanvasRenderingContext2D,
  view: View,
  priceStep: number,
  pricePrecision?: number
): void {
  const dec = pricePrecision ?? priceDecimals(priceStep);
  const layout = axisLayoutForChartView(view);
  const axisX = layout.priceAxisRect.left;
  const axisW = layout.priceAxisRect.width;
  ctx.fillStyle = uiColor.bgApp;
  // Fill only down to the main plot bottom: the sub-pane gutter band is
  // filled by drawSubPanes before indicator axis ticks are drawn into it.
  const gutterFillH = Math.min(layout.priceAxisRect.height, view.area.top + view.area.height);
  ctx.fillRect(layout.priceAxisRect.left, layout.priceAxisRect.top, layout.priceAxisRect.width, gutterFillH);
  ctx.fillRect(layout.cornerRect.left, layout.cornerRect.top, layout.cornerRect.width, layout.cornerRect.height);
  ctx.strokeStyle = uiColor.separator;
  ctx.beginPath();
  ctx.moveTo(axisX + 0.5, layout.priceAxisRect.top);
  ctx.lineTo(axisX + 0.5, layout.cornerRect.top + layout.cornerRect.height);
  ctx.stroke();

  ctx.font = PRICE_AXIS_FONT;
  ctx.fillStyle = uiColor.textSecondary;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const marks = view.priceMarks(dec, 11);
  for (const mark of marks) {
    const y = view.area.top + mark.coord;
    if (y < view.area.top - 1 || y > view.area.top + view.area.height + 1) continue;
    // Global grid toggle: skip only the plot grid stroke. Labels, background,
    // separator, price markers and crosshair stay untouched.
    if (settings.grid) {
      ctx.strokeStyle = axisGridLineColor;
      ctx.beginPath();
      ctx.moveTo(view.area.left, y);
      ctx.lineTo(axisX, y);
      ctx.stroke();
    }
    const label = mark.label;
    const boxH = 16;
    const labelY = clampLabelY(view, y, boxH);
    ctx.fillStyle = axisMajorLabelColor;
    ctx.textAlign = "right";
    ctx.fillText(label, axisX + axisW - 6, labelY);
  }
}

export function drawPriceMarkers(
  ctx: CanvasRenderingContext2D,
  view: View,
  priceMarkers: readonly PriceMarker[],
  priceStep: number,
  pricePrecision?: number
): void {
  const dec = pricePrecision ?? priceDecimals(priceStep);
  const boxH = PRICE_LABEL_HEIGHT;
  const byKey = new Map<string, { price: number; color: string; priority: number; desiredY: number; boxH: number; text?: string }>();
  for (const item of priceMarkers) {
    const desiredY = view.yOfPrice(item.price);
    if (desiredY < view.area.top || desiredY > view.area.top + view.area.height) continue;
    const key = `${item.price.toFixed(dec)}|${item.color}|${item.text ?? ""}`;
    const next = { ...item, desiredY, boxH };
    const prev = byKey.get(key);
    if (!prev || next.priority > prev.priority) byKey.set(key, next);
  }
  const labels = placeVerticalLabels([...byKey.values()], view.area.top, view.area.top + view.area.height, 2);
  if (!labels.length) return;
  const axisX = view.area.left + view.area.width;
  const axisW = view.priceAxisW;
  ctx.save();
  ctx.font = PRICE_LABEL_FONT;
  ctx.textBaseline = "middle";
  for (const label of labels) {
    const livePrice = label.priority >= 100 && !label.text;
    const text = label.text ?? (livePrice ? `Price ${label.price.toFixed(dec)}` : label.price.toFixed(dec));
    const padX = 3;
    const maxBoxW = label.text || livePrice ? Math.max(axisW - 2, 180) : axisW - 2;
    const boxW = Math.min(maxBoxW, Math.ceil(ctx.measureText(text).width) + padX * 2);
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
  ch: Crosshair
): void {
  if (ch.y < view.area.top || ch.y > view.area.top + view.area.height) return;
  const price = view.priceOfY(ch.y);
  const axisX = view.area.left + view.area.width;
  const text = price.toFixed(configDecimals(series.config));
  ctx.font = PRICE_LABEL_FONT;
  const padX = 3;
  const axisW = view.priceAxisW;
  const boxW = Math.min(axisW - 2, Math.ceil(ctx.measureText(text).width) + padX * 2);
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
