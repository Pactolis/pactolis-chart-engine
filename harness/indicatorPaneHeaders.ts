// Indicator pane headers for specs that drive a standalone IndicatorManager. The
// engine only fills the headers model; drawing it is the host application's job,
// so the harness hands out the bare model.
import { createIndicatorPaneHeadersModel, type IndicatorPaneHeadersModel } from "../src/features/indicators/indicatorPaneHeaders.js";

export function mountIndicatorPaneHeaders(_target: HTMLElement): { headers: IndicatorPaneHeadersModel; dispose(): void } {
  return { headers: createIndicatorPaneHeadersModel(), dispose: () => {} };
}
