/**
 * Chart layout defaults shared by runtime, renderers, interaction hit testing,
 * and indicator panes.
 *
 * These values are intentionally named model options instead of ad-hoc runtime
 * constants. Hosts replace them per chart through `ChartDisplayOptions`, so
 * ChartRuntime, indicators, and renderers never disagree about axis ownership.
 */

/**
 * How much room a chart gives its own chrome. `compact` is for phones and small
 * panes: shorter labels, a readout that wraps to the plot width, a taller time axis.
 */
export type ChartDensity = "regular" | "compact";

export interface ChartLayoutOptions {
  /** Width of the right price-axis gutter in CSS pixels. */
  readonly priceAxisWidth: number;
  /** Height of the bottom time-axis strip in CSS pixels. */
  readonly timeAxisHeight: number;
  /** Presentation density; the axis sizes above stay individually overridable. */
  readonly density: ChartDensity;
}

export const DEFAULT_CHART_LAYOUT_OPTIONS: ChartLayoutOptions = Object.freeze({
  priceAxisWidth: 62,
  timeAxisHeight: 22,
  density: "regular",
});

/**
 * Axis sizes `density: "compact"` starts from. The price gutter keeps its width: a
 * 7-character tick label at 12px needs about 56px, so narrowing it would clip prices.
 * The time strip grows to a finger-sized drag target.
 */
export const COMPACT_CHART_LAYOUT_OPTIONS: ChartLayoutOptions = Object.freeze({
  priceAxisWidth: 62,
  timeAxisHeight: 32,
  density: "compact",
});

export function normalizeChartLayoutOptions(options: Partial<ChartLayoutOptions> = {}): ChartLayoutOptions {
  const base = options.density === "compact" ? COMPACT_CHART_LAYOUT_OPTIONS : DEFAULT_CHART_LAYOUT_OPTIONS;
  return Object.freeze({
    priceAxisWidth: positiveOrDefault(options.priceAxisWidth, base.priceAxisWidth),
    timeAxisHeight: positiveOrDefault(options.timeAxisHeight, base.timeAxisHeight),
    density: base.density,
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;
}
