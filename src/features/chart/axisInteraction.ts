import type { View } from "../../core/engine/view.js";
import { axisLayoutForView, type AxisRect } from "../../core/model/axisLayout.js";

export type ChartAxisTarget = "plot" | "price-axis" | "time-axis" | "corner-axis";

export interface AxisHitOptions {
  /** Pixels the time axis reaches above its top edge: a fingertip cannot hit a 22px strip squarely. */
  timeAxisSlop?: number;
}

export function hitTestChartAxis(view: View, x: number, y: number, options: AxisHitOptions = {}): ChartAxisTarget {
  const layout = interactionAxisLayout(view);
  const inPriceAxisX = containsX(layout.priceAxisRect, x);
  const inMainPriceAxisY = y >= view.area.top && y <= view.area.top + view.area.height;

  if (contains(layout.cornerRect, x, y)) return "corner-axis";
  if (inPriceAxisX && inMainPriceAxisY) return "price-axis";
  if (contains(layout.timeAxisRect, x, y)) return "time-axis";
  const slop = options.timeAxisSlop ?? 0;
  if (slop > 0 && containsX(layout.timeAxisRect, x) && y >= layout.timeAxisRect.top - slop && y < layout.timeAxisRect.top) {
    return "time-axis";
  }
  return "plot";
}

export function dragScaleFactor(deltaPx: number, sensitivity = 0.006): number {
  const factor = Math.exp(deltaPx * sensitivity);
  return Math.max(0.25, Math.min(4, factor));
}

function interactionAxisLayout(view: View) {
  const canvasWidth = view.area.left + view.area.width + Math.max(0, view.priceAxisW);
  const canvasHeight = view.area.top
    + view.area.height
    + view.subPanesH
    + view.chartLayoutOptions.timeAxisHeight;
  return axisLayoutForView(view, canvasWidth, canvasHeight);
}

function contains(rect: AxisRect, x: number, y: number): boolean {
  return containsX(rect, x) && y >= rect.top && y <= rect.top + rect.height;
}

function containsX(rect: AxisRect, x: number): boolean {
  return x >= rect.left && x <= rect.left + rect.width;
}
