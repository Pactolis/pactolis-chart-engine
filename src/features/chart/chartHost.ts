import type { ChartType } from "../../core/chartPanelState.js";
import type { ChartRuntime } from "./ChartRuntime.js";

/**
 * Application state the chart engine reports to or reads from. The engine does
 * not own these stores; the host application supplies them before mounting a
 * chart.
 */
export interface ChartHost {
  /** A runtime finished mounting under `panelId`. */
  registerRuntime(panelId: string, runtime: ChartRuntime): void;
  /** A runtime is being disposed. Hosts should ignore stale registrations. */
  unregisterRuntime(panelId: string, runtime: ChartRuntime): void;
  /** The set of indicators on some chart changed. */
  indicatorsChanged(): void;
  /** Mark the data behind `key` as degraded (or recovered), with an optional detail line. */
  setDataDegraded(key: string, degraded: boolean, detail?: string): void;
  /** Whether missing footprint cells in the visible range should be filled automatically. */
  isFootprintAutoFillEnabled(): boolean;
  /** The chart type last chosen for `market`, if one was remembered. */
  getPairChartType(market: string): ChartType | undefined;
  /** Remember the chart type chosen for `market`. */
  setPairChartType(market: string, type: ChartType): void;
  /** Whether mounted runtimes install their `window` debug helpers (load tracing installs them regardless). */
  exposeDebugGlobals(): boolean;
}

let configured: ChartHost | null = null;

export function configureChartHost(host: ChartHost): void {
  configured = host;
}

export function chartHost(): ChartHost {
  if (configured === null) {
    throw new Error("chart host is not configured; call configureChartHost() before mounting a chart");
  }
  return configured;
}
