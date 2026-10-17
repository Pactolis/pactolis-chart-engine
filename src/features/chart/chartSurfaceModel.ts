/**
 * ChartSurface view model — the chart's visible UI state outside the canvases.
 *
 * ChartRuntime and IndicatorManager write it; the host renders it. The host
 * creates the object, typically as reactive state, and passes it to
 * mountChartRuntime. Rendering (WebGL/Canvas2D) stays imperative in the runtime.
 */
import type { IndicatorPaneHeadersModel } from "../indicators/indicatorPaneHeaders.js";

export type ChartSurfaceStatus = "loading" | "ready" | "failed";

export interface ChartSurfaceModel {
  status: ChartSurfaceStatus;
  /** Full-surface cover while the first history window loads. */
  historyOverlay: boolean;
  /**
   * Non-blocking "still loading older history" indicator: candles are already
   * revealed but the (two-phase) history load has not finished yet.
   */
  historyBackground: boolean;
  indicatorHeaders: IndicatorPaneHeadersModel;
}
