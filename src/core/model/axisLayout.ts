import type { ViewReadout } from "./viewContract.js";

export interface AxisRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface AxisLayout {
  /** Main plot area; candle/grid/crosshair plot content must not draw outside this rect. */
  readonly plotRect: AxisRect;
  /** Right-side price scale gutter above the time axis. */
  readonly priceAxisRect: AxisRect;
  /** Bottom time scale strip under the plot and sub-panes, excluding the right price-axis stub. */
  readonly timeAxisRect: AxisRect;
  /** Bottom-right price/time corner stub. Owned by the price-axis side, not by time labels. */
  readonly cornerRect: AxisRect;
}

/**
 * Central chart axis layout.
 *
 * The reference chart architecture keeps the pane/time-axis area and the
 * price-axis stubs separate. Renderers should ask this helper for the exact
 * rectangles instead of deriving their own canvas-wide axis bounds.
 */
export function axisLayoutForView(view: ViewReadout, canvasWidth: number, canvasHeight: number): AxisLayout {
  const plotRect = { ...view.area };
  const priceAxisLeft = view.area.left + view.area.width;
  const priceAxisWidth = Math.max(0, view.priceAxisW);
  const timeAxisTop = view.area.top + view.area.height + view.subPanesH;
  const timeAxisHeight = Math.max(0, canvasHeight - timeAxisTop);
  const priceAxisHeight = Math.max(0, timeAxisTop);
  const maxRight = Math.max(canvasWidth, priceAxisLeft + priceAxisWidth);
  const boundedPriceAxisWidth = Math.max(0, Math.min(priceAxisWidth, maxRight - priceAxisLeft));

  return {
    plotRect,
    priceAxisRect: {
      left: priceAxisLeft,
      top: 0,
      width: boundedPriceAxisWidth,
      height: priceAxisHeight,
    },
    timeAxisRect: {
      left: view.area.left,
      top: timeAxisTop,
      width: view.area.width,
      height: timeAxisHeight,
    },
    cornerRect: {
      left: priceAxisLeft,
      top: timeAxisTop,
      width: boundedPriceAxisWidth,
      height: timeAxisHeight,
    },
  };
}

/** Keep a horizontal label center within a rect without letting it leak into neighboring axis stubs. */
export function alignLabelCenter(centerX: number, labelWidth: number, rect: AxisRect, padding = 2): number {
  if (rect.width <= 0) return rect.left;
  const half = labelWidth / 2;
  const min = rect.left + half + padding;
  const max = rect.left + rect.width - half - padding;
  if (max < min) return rect.left + rect.width / 2;
  return Math.max(min, Math.min(max, centerX));
}

/**
 * Same layout as `axisLayoutForView`, with the canvas size derived from the view's
 * own geometry (plot + price gutter wide, plot + sub-panes + time axis tall).
 * Renderers use this so a draw never reads `canvas.clientWidth/clientHeight`,
 * which forces a synchronous layout when the DOM was touched earlier in the frame.
 */
export function axisLayoutForChartView(
  view: ViewReadout & { readonly chartLayoutOptions: { readonly timeAxisHeight: number } },
): AxisLayout {
  const canvasWidth = view.area.left + view.area.width + Math.max(0, view.priceAxisW);
  const canvasHeight = view.area.top + view.area.height + view.subPanesH + view.chartLayoutOptions.timeAxisHeight;
  return axisLayoutForView(view, canvasWidth, canvasHeight);
}
