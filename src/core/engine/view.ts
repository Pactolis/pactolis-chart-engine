// View/camera: maps (bar index, price) <-> screen pixels and handles pan/zoom.

import {
  PriceScaleModel,
  PriceScaleMode,
  normalizePriceScaleMode,
  priceScaleModeToLegacyScaleMode,
  type PriceScaleModeInput,
  type PriceMark,
  type PriceScaleState,
  type ScaleMode,
} from "../model/priceScale.js";
import { PriceRange } from "../model/priceRange.js";
import { DEFAULT_TIME_SCALE_OPTIONS, normalizeTimeScaleOptions, type TimeScaleOptions } from "../model/timeScaleOptions.js";
import { DEFAULT_CHART_LAYOUT_OPTIONS, normalizeChartLayoutOptions, type ChartLayoutOptions } from "../model/chartLayoutOptions.js";

export { PriceScaleModel, PriceScaleMode, normalizePriceScaleMode } from "../model/priceScale.js";
export { PriceRange } from "../model/priceRange.js";
export type { PriceMark, PriceScaleModeInput, PriceScaleState, ScaleMode } from "../model/priceScale.js";

export interface ChartArea {
  /** Left edge x of the plotting area (px). */
  left: number;
  /** Top edge y (px). */
  top: number;
  /** Plotting width (px), excludes the price axis gutter. */
  width: number;
  /** Plotting height (px), excludes the time axis gutter. */
  height: number;
}


export const DEFAULT_COL_WIDTH = DEFAULT_TIME_SCALE_OPTIONS.barSpacing;
export const MAX_VISIBLE_BARS = 4000;
/** Target full candle columns for the default/reset horizontal fit (Settings/250). */
export const DEFAULT_FIT_COLUMNS = 250;

export class View {
  readonly timeScaleOptions: TimeScaleOptions;
  readonly chartLayoutOptions: ChartLayoutOptions;
  /** Pixel width of one bar column. */
  colWidth: number;

  constructor(timeScaleOptions: Partial<TimeScaleOptions> = {}, chartLayoutOptions: Partial<ChartLayoutOptions> = {}) {
    this.timeScaleOptions = normalizeTimeScaleOptions(timeScaleOptions);
    this.chartLayoutOptions = normalizeChartLayoutOptions(chartLayoutOptions);
    this.colWidth = this.timeScaleOptions.barSpacing;
    this.priceAxisW = this.chartLayoutOptions.priceAxisWidth;
  }
  /** Pixel x of the left edge of bar index 0. */
  offsetX = 0;
  /** Scale-space value at the top edge of the chart area (price in linear mode,
   *  logarithmic logical value in log mode). See toScale/fromScale. */
  priceTop = 0;
  /** Scale-space units per vertical pixel. */
  pricePerPx = 1;
  /** Vertical price scale model state. Range math still bridges through View in this phase. */
  readonly priceScale = new PriceScaleModel();
  /** Total px reserved below the price plot for sub-panes (delta/CVD). The
   *  time axis sits below this band; `area.height` already excludes it. */
  subPanesH = 0;
  /** Width of the price-axis gutter. Kept separate from right-side docks. */
  priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;

  area: ChartArea = { left: 0, top: 0, width: 0, height: 0 };

  /** Pixel width of the mini-candlestick strip on the left of each column. */
  candleStripWidth(): number {
    return Math.min(16, Math.max(5, this.colWidth * 0.22));
  }

  /** Map a price into scale space (identity for Normal, conversion model for Logarithmic). */
  toScale(price: number): number {
    return this.priceScale.priceToLogical(price) ?? this.priceScale.priceToLogical(1e-9) ?? 0;
  }

  /** Inverse of toScale: scale-space value back to price. */
  fromScale(s: number): number {
    return this.priceScale.logicalToPrice(s);
  }

  /** Switch scale mode while keeping the currently visible price range fixed
   *  on screen (no jump). Re-solves priceTop/pricePerPx in the new space. */
  get priceScaleState(): PriceScaleState {
    return this.priceScale.state();
  }

  get scaleMode(): ScaleMode {
    return priceScaleModeToLegacyScaleMode(this.priceScale.mode());
  }

  get priceScaleMode(): PriceScaleMode {
    return this.priceScale.mode();
  }

  setPriceAutoScale(autoScale: boolean): void {
    this.priceScale.setAutoScale(autoScale);
  }

  /** Apply auto-scale margins to the price-scale model (TASK-029 P3). */
  setScaleMargins(top: number, bottom: number): void {
    const clampMargin = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(0.49, value)) : 0;
    this.priceScale.applyOptions({ scaleMargins: { top: clampMargin(top), bottom: clampMargin(bottom) } });
  }

  isPriceAutoScale(): boolean {
    return this.priceScale.isAutoScale();
  }

  isLogScale(): boolean {
    return this.priceScale.isLogarithmic();
  }

  /** Switch price scale mode while keeping the currently visible price range fixed
   *  on screen (no jump). Re-solves priceTop/pricePerPx in the new space. */
  setScaleMode(mode: PriceScaleModeInput): void {
    const nextMode = normalizePriceScaleMode(mode);
    if (nextMode === this.priceScale.mode()) return;
    const topPrice = this.priceOfY(this.area.top);
    const bottomPrice = this.priceOfY(this.area.top + this.area.height);
    this.priceScale.setScaleMode(nextMode);
    const sTop = this.toScale(topPrice);
    const sBottom = this.toScale(bottomPrice);
    this.pricePerPx = (sTop - sBottom) / Math.max(this.area.height, 1);
    this.priceTop = sTop;
  }

  // --- X axis (bar index <-> pixel) ---
  xOfIndex(index: number): number {
    return this.area.left + this.offsetX + index * this.colWidth;
  }

  indexOfX(x: number): number {
    return (x - this.area.left - this.offsetX) / this.colWidth;
  }

  /** Current visible range in scale space (linear price or log price). */
  scaleRange(): PriceRange {
    const maxValue = this.priceTop;
    const minValue = this.priceTop - this.area.height * this.pricePerPx;
    return new PriceRange(minValue, maxValue);
  }

  /** Apply a scale-space range to the current viewport. */
  setScaleRange(range: PriceRange): void {
    const length = Math.max(range.length(), 1e-9);
    this.pricePerPx = clamp(length / Math.max(this.area.height, 1), 1e-9, 1e6);
    this.priceTop = range.maxValue();
    this.priceScale.setPriceRange(range);
  }

  /** Build price-axis marks from the price scale model for the current viewport. */
  priceMarks(pricePrecision: number, fontSize = 11): PriceMark[] {
    return this.priceScale.marks({
      height: this.area.height,
      priceTop: this.priceTop,
      pricePerPx: this.pricePerPx,
      pricePrecision,
      fontSize,
      entireTextOnly: true,
    });
  }

  priceRange(): PriceRange {
    const topPrice = this.priceOfY(this.area.top);
    const bottomPrice = this.priceOfY(this.area.top + this.area.height);
    return new PriceRange(Math.min(bottomPrice, topPrice), Math.max(bottomPrice, topPrice));
  }

  /** Apply a real-price range in the current price scale mode. */
  setPriceRange(range: PriceRange): void {
    const sMin = this.toScale(range.minValue());
    const sMax = this.toScale(range.maxValue());
    this.setScaleRange(new PriceRange(Math.min(sMin, sMax), Math.max(sMin, sMax)));
  }

  // --- Y axis (price <-> pixel) ---
  yOfPrice(price: number): number {
    return this.area.top + (this.priceTop - this.toScale(price)) / this.pricePerPx;
  }

  priceOfY(y: number): number {
    return this.fromScale(this.priceTop - (y - this.area.top) * this.pricePerPx);
  }

  // --- Interaction ---
  panX(dxPixels: number): void {
    this.offsetX += dxPixels;
  }

  panY(dyPixels: number): void {
    this.priceTop += dyPixels * this.pricePerPx;
  }

  /**
   * Rescale bar spacing when the timeframe changes so the visible *time window*
   * stays roughly constant instead of the visible *bar count*. colWidth is pixels
   * per bar, so after e.g. 4h→1d each bar spans 6× the time; keeping colWidth fixed
   * would show 6× the time span (a 4000-bar zoom-out became a 33-year window with the
   * candles crushed to invisibility — the NPOC drift the user reported). Scaling by
   * newInterval/oldInterval preserves the time window; clamp keeps it usable.
   */
  rescaleColWidthForInterval(oldIntervalMs: number, newIntervalMs: number): void {
    if (!(oldIntervalMs > 0) || !(newIntervalMs > 0) || oldIntervalMs === newIntervalMs) return;
    const ratio = newIntervalMs / oldIntervalMs;
    this.colWidth = clamp(this.colWidth * ratio, this.minimumBarSpacing(), this.timeScaleOptions.maxBarSpacing);
  }

  /** Zoom X around a pixel anchor (keeps the bar under the cursor fixed). */
  zoomX(factor: number, anchorX: number): void {
    const indexAtAnchor = this.indexOfX(anchorX);
    this.colWidth = clamp(this.colWidth * factor, this.minimumBarSpacing(), this.timeScaleOptions.maxBarSpacing);
    // re-solve offsetX so indexAtAnchor maps back to anchorX
    this.offsetX = anchorX - this.area.left - indexAtAnchor * this.colWidth;
  }

  /**
   * Rescale columns while the time axis is dragged.
   *
   * The plot's right edge acts as the pivot: column width scales with the
   * pointer's distance from that edge, so dragging toward it narrows columns
   * and dragging away widens them. The bar position at the right edge stays
   * put, so the chart does not pan while only the scale changes. A pointer on
   * or past the edge leaves the view unchanged.
   */
  scaleTimeAxisTo(startX: number, currentX: number, startColWidth: number, startOffsetX: number): void {
    const width = this.area.width;
    const startGap = clamp(width - (startX - this.area.left), 0, width);
    const currentGap = clamp(width - (currentX - this.area.left), 0, width);
    if (startGap === 0 || currentGap === 0) return;

    const pivotIndex = (width - startOffsetX) / startColWidth;
    this.colWidth = clamp(startColWidth * (currentGap / startGap), this.minimumBarSpacing(), this.timeScaleOptions.maxBarSpacing);
    this.offsetX = width - pivotIndex * this.colWidth;
  }

  /**
   * Restore the default horizontal scale: fit min(total, 250) full candle columns
   * into the usable CSS plot width, keeping the latest columns near the right edge.
   *
   * Spacing is fractional: plotW / (N + rightPadCols - 1), bounded only by the
   * existing min/max bar spacing and the dynamic 4000-bar floor. With no data the
   * default bar spacing is restored. Invalid geometry (width <= 1) mutates nothing;
   * the caller owns deferring the fit until real plot geometry exists.
   */
  resetTimeScale(total: number, rightPadCols = this.timeScaleOptions.resetRightPaddingBars): void {
    if (!(total > 0)) {
      this.colWidth = this.timeScaleOptions.barSpacing;
      this.offsetX = 0;
      return;
    }
    if (!(this.area.width > 1)) return;
    const fitColumns = Math.min(total, DEFAULT_FIT_COLUMNS);
    const spacingDivisor = fitColumns + Math.max(0, rightPadCols) - 1;
    const spacing = spacingDivisor > 0 ? this.area.width / spacingDivisor : this.area.width;
    if (!Number.isFinite(spacing) || spacing <= 0) return;
    this.colWidth = clamp(spacing, this.minimumBarSpacing(), this.timeScaleOptions.maxBarSpacing);
    this.scrollToIndex(total - 1, rightPadCols);
  }

  /** Zoom Y around a pixel anchor (keeps the price under the cursor fixed). */
  zoomY(factor: number, anchorY: number): void {
    const sAtAnchor = this.priceTop - (anchorY - this.area.top) * this.pricePerPx;
    const range = this.scaleRange();
    range.scaleAroundCenter(factor);
    this.setScaleRange(range);
    this.priceTop = sAtAnchor + (anchorY - this.area.top) * this.pricePerPx;
  }

  /**
   * Start a price-axis drag (see PriceScaleModel.scaleTo).
   *
   * View translates canvas coordinates into pane-local coordinates and delegates
   * the gesture state to PriceScaleModel. Runtime should not snapshot price
   * ranges itself.
   */
  startPriceAxisScale(startY: number): void {
    const localY = clamp(startY - this.area.top, 0, this.area.height);
    this.priceScale.startScale(this.area.height, localY, this.scaleRange());
  }

  /** Continue a manual price-axis scale gesture and apply the model-produced range. */
  scalePriceAxisTo(currentY: number): void {
    const localY = clamp(currentY - this.area.top, 0, this.area.height);
    const range = this.priceScale.scaleTo(this.area.height, localY);
    if (range !== null) this.setScaleRange(range);
  }

  /** Finish a manual price-axis scale gesture. */
  endPriceAxisScale(): void {
    this.priceScale.endScale();
  }

  /** Reset price scale to automatic fitting. The caller decides when to fit visible data. */
  resetPriceScale(): void {
    this.priceScale.resetPriceScale();
  }

  /** Fit the visible price range to [min, max] with symmetric padding.
   *  Works in the current scale space (linear or log), so log mode gives
   *  proportional padding automatically. */
  fitPriceRange(min: number, max: number, paddingFrac = 0.1): void {
    const sMin = this.toScale(min);
    const sMax = this.toScale(max);
    const range = new PriceRange(Math.min(sMin, sMax), Math.max(sMin, sMax));
    // 1e-6 prevents degenerate (zero-height) view when all bars are at the same price.
    const span = Math.max(range.length(), 1e-6);
    const padding = span * paddingFrac;
    this.setScaleRange(new PriceRange(range.minValue() - padding, range.maxValue() + padding));
  }

  /** Scroll so the bar at `index` sits near the right edge. */
  scrollToIndex(index: number, rightPadCols = this.timeScaleOptions.defaultScrollRightPaddingBars): void {
    const targetX = this.area.left + this.area.width - rightPadCols * this.colWidth;
    this.offsetX = targetX - this.area.left - index * this.colWidth;
  }

  /** Center the bar at `index` in the visible plot area. */
  centerIndex(index: number): void {
    const targetX = this.area.left + this.area.width * 0.5;
    this.offsetX = targetX - this.area.left - index * this.colWidth;
  }

  /**
   * Görünür index aralığını [fromIdx, toIdx] plot genişliğine oturt. fromIdx sol
   * kenara gelecek şekilde colWidth'i ve offsetX'i yeniden hesaplar. Bar
   * aralıkları min/max barSpacing'e clamp edilir, böylece aralık tam
   * sığmayabilir. total veri sayısına bağımlı değildir.
   */
  setVisibleIndexRange(fromIdx: number, toIdx: number): void {
    const span = Math.max(toIdx - fromIdx, 1e-6);
    // column width = plot width / span, clamped between allowed bar spacings
    this.colWidth = clamp(
      this.area.width / span,
      this.minimumBarSpacing(),
      this.timeScaleOptions.maxBarSpacing,
    );
    // Solve offsetX so that xOfIndex(fromIdx) == area.left → offsetX = -fromIdx * colWidth
    this.offsetX = -fromIdx * this.colWidth;
  }

  /** Dynamic zoom-out floor: exactly MAX_VISIBLE_BARS columns fill the plot. */
  minimumBarSpacing(): number {
    const widthBound = this.area.width > 0 ? this.area.width / MAX_VISIBLE_BARS : 0;
    return Math.max(this.timeScaleOptions.minBarSpacing, widthBound);
  }

  /** Re-apply the dynamic floor after a plot resize while preserving the anchor. */
  enforceMinimumBarSpacing(anchorX = this.area.left + this.area.width): boolean {
    const minimum = this.minimumBarSpacing();
    if (this.colWidth >= minimum) return false;
    const indexAtAnchor = this.indexOfX(anchorX);
    this.colWidth = minimum;
    this.offsetX = anchorX - this.area.left - indexAtAnchor * this.colWidth;
    return true;
  }

  /**
   * Clamp offsetX so that at least `minVisibleCols` bars remain visible.
   * Prevents panning/zooming the viewport entirely outside the data range,
   * which would cause visibleRange() to return [0,0] and blank the chart.
   */
  clampOffsetX(
    total: number,
    minVisibleCols = this.timeScaleOptions.minVisibleBars,
    edgePaddingCols = this.timeScaleOptions.clampEdgePaddingBars,
  ): void {
    if (total <= 0 || this.area.width <= 0) return;
    const requiredCols = Math.min(total, Math.max(1, Math.floor(minVisibleCols)));
    const paddingCols = Math.min(
      Math.max(0, Math.floor(edgePaddingCols)),
      Math.max(0, requiredCols - 1),
    );
    const guardedCols = requiredCols - paddingCols;
    // Right guard: newest bars must remain at least minVisibleCols from right edge.
    // offsetX is the pixel-left of bar 0 relative to area.left.
    // Bar `total-1` right edge = offsetX + total * colWidth.
    // We need: area.left + offsetX + (total - minVisibleCols) * colWidth < area.width
    //  → offsetX < area.width - (total - minVisibleCols) * colWidth
    const maxOffset = this.area.width - guardedCols * this.colWidth;
    // Left guard: bar 0 must not drift past the right boundary entirely.
    // We need at least minVisibleCols bars from the left visible:
    //  offsetX + minVisibleCols * colWidth > 0  → offsetX > -minVisibleCols * colWidth
    const minOffset = -(total - guardedCols) * this.colWidth;
    this.offsetX = clamp(this.offsetX, minOffset, maxOffset);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
