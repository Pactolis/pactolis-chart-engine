/**
 * Chart → workspace bridge for "maximize this chart's tab". The chart engine
 * does not know about the workspace, so it asks the hosting panel through a
 * bubbling DOM event that the host answers synchronously. Without a host
 * (popout app, tests) the panel reports itself unavailable.
 */
export const CHART_PANEL_MAXIMIZE_EVENT = "footprint-chart-panel-maximize";

export type ChartPanelMaximizeAction = "query" | "enter" | "exit";

export interface ChartPanelMaximizeState {
  /** The hosting panel can be maximized inside the workspace. */
  available: boolean;
  /** The hosting panel is currently maximized. */
  maximized: boolean;
}

export interface ChartPanelMaximizeDetail extends ChartPanelMaximizeState {
  action: ChartPanelMaximizeAction;
}

/** Dispatches a maximize request from inside a chart and returns the host's answer. */
export function requestChartPanelMaximize(target: Element, action: ChartPanelMaximizeAction): ChartPanelMaximizeState {
  const CustomEventCtor = target.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
  const detail: ChartPanelMaximizeDetail = { action, available: false, maximized: false };
  target.dispatchEvent(new CustomEventCtor<ChartPanelMaximizeDetail>(CHART_PANEL_MAXIMIZE_EVENT, { bubbles: true, detail }));
  return { available: detail.available, maximized: detail.maximized };
}
