import type { View } from "../engine/view.js";
import { axisLayoutForChartView } from "../model/axisLayout.js";
import type { Crosshair } from "./overlay.js";
import { uiColor } from "../ui/seriesPalette.js";

export type PriceScaleControlId = "autoScale" | "logarithmic";
export interface PriceScaleControlRect { id: PriceScaleControlId; x: number; y: number; w: number; h: number; }
export interface IndicatorScaleControlRect extends PriceScaleControlRect { paneId: string; }

/** Finger-sized price-scale buttons: a fingertip cannot hover, so they are always shown and stacked. */
const TOUCH_CONTROL_SIZE = 32;
const TOUCH_CONTROL_GAP = 6;
const TOUCH_CONTROL_FONT_PX = 14;
/** A pane shorter than this (beyond the two buttons) has no room for them. */
const TOUCH_CONTROL_MIN_EXTRA_HEIGHT = 60;

export function drawPriceScaleControls(
  ctx: CanvasRenderingContext2D,
  view: View,
  crosshair: Crosshair
): PriceScaleControlRect[] {
  if (crosshair.touch) return drawTouchPriceScaleControls(ctx, view);
  const layout = axisLayoutForChartView(view);
  const axisX = layout.priceAxisRect.left;
  const axisW = layout.priceAxisRect.width;
  const axisBottom = view.area.top + view.area.height;
  const isHoveringPriceScale = crosshair.visible
    && crosshair.x >= axisX
    && crosshair.x <= axisX + axisW
    && crosshair.y >= view.area.top
    && crosshair.y <= axisBottom;

  if (!isHoveringPriceScale || axisW <= 0) return [];

  const size = 18;
  const gap = 4;
  const totalW = size * 2 + gap;
  const x = axisX + Math.max(3, Math.floor((axisW - totalW) / 2));
  const y = axisBottom - size - 3;
  const controls: PriceScaleControlRect[] = [
    { id: "autoScale", x, y, w: size, h: size },
    { id: "logarithmic", x: x + size + gap, y, w: size, h: size },
  ];

  drawPriceScaleControlButton(ctx, controls[0], "O", view.isPriceAutoScale(), isPointInControl(crosshair, controls[0]));
  drawPriceScaleControlButton(ctx, controls[1], "L", view.isLogScale(), isPointInControl(crosshair, controls[1]));
  return controls;
}

function drawTouchPriceScaleControls(ctx: CanvasRenderingContext2D, view: View): PriceScaleControlRect[] {
  const layout = axisLayoutForChartView(view);
  const axisX = layout.priceAxisRect.left;
  const axisW = layout.priceAxisRect.width;
  const size = TOUCH_CONTROL_SIZE;
  if (axisW < size + 4 || view.area.height < size * 2 + TOUCH_CONTROL_GAP + TOUCH_CONTROL_MIN_EXTRA_HEIGHT) return [];

  const x = axisX + Math.floor((axisW - size) / 2);
  const lowerY = view.area.top + view.area.height - size - 4;
  const upperY = lowerY - size - TOUCH_CONTROL_GAP;
  const auto: PriceScaleControlRect = { id: "autoScale", x, y: upperY, w: size, h: size };
  const log: PriceScaleControlRect = { id: "logarithmic", x, y: lowerY, w: size, h: size };
  drawPriceScaleControlButton(ctx, auto, "O", view.isPriceAutoScale(), false, TOUCH_CONTROL_FONT_PX);
  drawPriceScaleControlButton(ctx, log, "L", view.isLogScale(), false, TOUCH_CONTROL_FONT_PX);

  // The returned rects are the hit areas: grown to meet halfway across the gap between the buttons.
  const slop = TOUCH_CONTROL_GAP / 2;
  const grow = (rect: PriceScaleControlRect): PriceScaleControlRect => (
    { id: rect.id, x: rect.x - slop, y: rect.y - slop, w: rect.w + slop * 2, h: rect.h + slop * 2 }
  );
  return [grow(auto), grow(log)];
}

export function drawIndicatorScaleControls(
  ctx: CanvasRenderingContext2D,
  axisX: number,
  axisW: number,
  pane: { id: string; top: number; height: number; scaleMode: "linear" | "log" },
  crosshair?: Crosshair,
): IndicatorScaleControlRect[] {
  const hovering = crosshair?.visible
    && crosshair.x >= axisX && crosshair.x <= axisX + axisW
    && crosshair.y >= pane.top && crosshair.y <= pane.top + pane.height;
  if (!hovering || axisW <= 0) return [];
  const size = 18;
  const gap = 4;
  const totalW = size * 2 + gap;
  const x = axisX + Math.max(3, Math.floor((axisW - totalW) / 2));
  const y = pane.top + pane.height - size - 3;
  const controls: IndicatorScaleControlRect[] = [
    { paneId: pane.id, id: "autoScale", x, y, w: size, h: size },
    { paneId: pane.id, id: "logarithmic", x: x + size + gap, y, w: size, h: size },
  ];
  drawPriceScaleControlButton(ctx, controls[0], "O", true, isPointInControl(crosshair, controls[0]));
  drawPriceScaleControlButton(ctx, controls[1], "L", pane.scaleMode === "log", isPointInControl(crosshair, controls[1]));
  return controls;
}

function isPointInControl(crosshair: Crosshair | undefined, rect: PriceScaleControlRect): boolean {
  return Boolean(
    crosshair?.visible
      && crosshair.x >= rect.x
      && crosshair.x <= rect.x + rect.w
      && crosshair.y >= rect.y
      && crosshair.y <= rect.y + rect.h,
  );
}

function drawPriceScaleControlButton(
  ctx: CanvasRenderingContext2D,
  rect: PriceScaleControlRect,
  label: string,
  active: boolean,
  hovered = false,
  fontPx = 11,
): void {
  ctx.save();
  const fill = active
    ? "rgba(56, 189, 248, 0.16)"
    : hovered
      ? "rgba(30, 41, 59, 0.85)"
      : "rgba(15, 22, 34, 0.88)";
  const border = active
    ? "rgba(56, 189, 248, 0.55)"
    : hovered
      ? "rgba(148, 163, 184, 0.38)"
      : "rgba(148, 163, 184, 0.22)";
  ctx.fillStyle = fill;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  if (typeof ctx.roundRect === "function" && typeof ctx.fill === "function") {
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1), 3.5);
    ctx.stroke();
  } else {
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }
  ctx.font = `bold ${fontPx}px ui-monospace, monospace`;
  ctx.fillStyle = active || hovered ? uiColor.textHeading : uiColor.textSecondary;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
  ctx.restore();
}
