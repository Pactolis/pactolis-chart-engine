import type { TimeScaleOptions } from "./timeScaleOptions.js";
import { normalizeChartLayoutOptions, type ChartDensity, type ChartLayoutOptions } from "./chartLayoutOptions.js";

export type { ChartDensity } from "./chartLayoutOptions.js";

export type ChartPowerPreference = "default" | "low-power" | "high-performance";

/**
 * What a host may adapt per chart to the screen it runs on. Every field is optional and an
 * unset field keeps the engine's desktop behavior, so a host that never answers
 * `ChartHost.displayOptions` gets exactly what it got before these options existed.
 */
export interface ChartDisplayOptions {
  /** `compact` is for phones and small panes (see ChartDensity). Default `regular`. */
  density?: ChartDensity;
  /** Price-axis gutter width in CSS px. Default: the density's width (62). */
  priceAxisWidth?: number;
  /** Time-axis strip height in CSS px. Default: the density's height (22 regular, 32 compact). */
  timeAxisHeight?: number;
  /** Columns the default and reset horizontal fit aims for. Default 250, sized for a desktop plot. */
  defaultFitColumns?: number;
  /**
   * Highest pixel ratio (device px per CSS px) the canvases render at. Unset follows the window's
   * devicePixelRatio. A cap below the window's ratio trades sharpness for GPU memory and fill rate.
   * Values below 1 are ignored.
   */
  maxDevicePixelRatio?: number;
  /** WebGL2 antialiasing. Default true. Read when the chart's WebGL context is created. */
  antialias?: boolean;
  /** WebGL2 power preference. Default `default`. Read when the chart's WebGL context is created. */
  powerPreference?: ChartPowerPreference;
}

/** The context attributes a host may change; the rest (opaque, no preserved buffer) are the engine's. */
export interface ChartWebGlOptions {
  readonly antialias: boolean;
  readonly powerPreference: ChartPowerPreference;
}

export interface ResolvedChartDisplayOptions {
  readonly layout: ChartLayoutOptions;
  /** Only the time-scale fields a host set; the rest stay the engine's. */
  readonly timeScale: Partial<TimeScaleOptions>;
  /** Null: follow the window's devicePixelRatio. */
  readonly maxDevicePixelRatio: number | null;
  readonly webgl: ChartWebGlOptions;
}

const POWER_PREFERENCES: readonly ChartPowerPreference[] = ["default", "low-power", "high-performance"];
/** Fits no screen today; a larger request is a typo, not a wish. */
const MAX_FIT_COLUMNS = 4000;

export const DEFAULT_CHART_WEBGL_OPTIONS: ChartWebGlOptions = Object.freeze({
  antialias: true,
  powerPreference: "default",
});

/** Normalize what a host answered; invalid fields fall back to the engine's defaults one by one. */
export function resolveChartDisplayOptions(input: ChartDisplayOptions | null | undefined): ResolvedChartDisplayOptions {
  const options = input ?? {};
  const fit = Number(options.defaultFitColumns);
  const cap = Number(options.maxDevicePixelRatio);
  return Object.freeze({
    layout: normalizeChartLayoutOptions({
      density: options.density === "compact" ? "compact" : "regular",
      priceAxisWidth: options.priceAxisWidth,
      timeAxisHeight: options.timeAxisHeight,
    }),
    timeScale: Number.isFinite(fit) && fit >= 1
      ? Object.freeze({ defaultFitColumns: Math.min(MAX_FIT_COLUMNS, Math.floor(fit)) })
      : Object.freeze({}),
    maxDevicePixelRatio: Number.isFinite(cap) && cap >= 1 ? cap : null,
    webgl: Object.freeze({
      antialias: typeof options.antialias === "boolean" ? options.antialias : DEFAULT_CHART_WEBGL_OPTIONS.antialias,
      powerPreference: POWER_PREFERENCES.includes(options.powerPreference as ChartPowerPreference)
        ? options.powerPreference as ChartPowerPreference
        : DEFAULT_CHART_WEBGL_OPTIONS.powerPreference,
    }),
  });
}

/** The pixel ratio a canvas renders at: the window's, held down to the host's cap when there is one. */
export function effectivePixelRatio(devicePixelRatio: number, maxDevicePixelRatio: number | null): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return maxDevicePixelRatio === null ? dpr : Math.min(dpr, maxDevicePixelRatio);
}

/** Two resolved option sets would render the same chart. */
export function sameChartDisplayOptions(a: ResolvedChartDisplayOptions, b: ResolvedChartDisplayOptions): boolean {
  return a.layout.priceAxisWidth === b.layout.priceAxisWidth
    && a.layout.timeAxisHeight === b.layout.timeAxisHeight
    && a.layout.density === b.layout.density
    && a.timeScale.defaultFitColumns === b.timeScale.defaultFitColumns
    && a.maxDevicePixelRatio === b.maxDevicePixelRatio
    && a.webgl.antialias === b.webgl.antialias
    && a.webgl.powerPreference === b.webgl.powerPreference;
}
