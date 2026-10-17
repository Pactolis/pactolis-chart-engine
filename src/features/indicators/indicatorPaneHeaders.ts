/**
 * Indicator pane header view model.
 *
 * IndicatorManager owns pane state and writes this model; the Svelte ChartSurface
 * renders it. The manager never builds header DOM itself.
 */

export interface IndicatorPaneHeaderView {
  id: string;
  type: string;
  /** Instance title, used for the accessible name. */
  title: string;
  /** Visible header text; definitions may add live values to the title. */
  label: string;
  showLabel: boolean;
  collapsed: boolean;
  visible: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Header top, relative to the header layer. */
  top: number;
  /** Resize handle top, relative to the header layer. */
  resizeTop: number;
}

export interface IndicatorPaneHeaderCommands {
  toggleCollapsed(id: string): void;
  move(id: string, direction: -1 | 1): void;
  toggleVisible(id: string): void;
  openSettings(id: string, trigger: HTMLElement | null): void;
  refresh(): void;
  remove(id: string): void;
  undoRemove(): void;
  dismissUndo(): void;
  beginResize(event: PointerEvent, id: string): void;
}

export interface IndicatorPaneHeaderLayer {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface IndicatorPaneHeadersModel {
  layer: IndicatorPaneHeaderLayer;
  panes: IndicatorPaneHeaderView[];
  /** Resize handles are hidden while a pane is maximized. */
  resizable: boolean;
  commands: IndicatorPaneHeaderCommands | null;
  lastRemovedTitle: string;
}

export function createIndicatorPaneHeadersModel(): IndicatorPaneHeadersModel {
  return {
    layer: { left: 0, top: 0, width: 0, height: 0 },
    panes: [],
    resizable: true,
    commands: null,
    lastRemovedTitle: "",
  };
}
