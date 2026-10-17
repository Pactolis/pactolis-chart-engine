/**
 * Chart layout defaults shared by runtime, renderers, interaction hit testing,
 * and indicator panes.
 *
 * These values are intentionally named model options instead of ad-hoc runtime
 * constants. Future phases can replace the defaults with user/theme options
 * without making ChartRuntime, indicators, or renderers disagree about axis
 * ownership.
 */
export interface ChartLayoutOptions {
  /** Width of the right price-axis gutter in CSS pixels. */
  readonly priceAxisWidth: number;
  /** Height of the bottom time-axis strip in CSS pixels. */
  readonly timeAxisHeight: number;
}

export const DEFAULT_CHART_LAYOUT_OPTIONS: ChartLayoutOptions = Object.freeze({
  priceAxisWidth: 62,
  timeAxisHeight: 22,
});

export function normalizeChartLayoutOptions(options: Partial<ChartLayoutOptions> = {}): ChartLayoutOptions {
  return Object.freeze({
    priceAxisWidth: positiveOrDefault(options.priceAxisWidth, DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth),
    timeAxisHeight: positiveOrDefault(options.timeAxisHeight, DEFAULT_CHART_LAYOUT_OPTIONS.timeAxisHeight),
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;
}
