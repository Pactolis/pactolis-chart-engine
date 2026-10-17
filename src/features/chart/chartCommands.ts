import type { ChartMessageKey } from "../../core/chartLocale.js";
import { t } from "../../core/chartLocale.js";
import type { AnalysisContext } from "../../core/analysisContext.js";
import type { ChartPanelState, LinkGroupColor } from "../../core/chartPanelState.js";
import type { ChartContextMenuAction } from "./contextMenuModel.js";

export type ChartCommandId =
  | "reset-price-scale"
  | "reset-time-scale"
  | "reset-all-scales"
  | "go-latest"
  | "toggle-auto-scale"
  | "toggle-log-scale"
  | "drawing-duplicate"
  | "drawing-copy"
  | "drawing-paste"
  | "drawing-delete"
  | "drawing-lock"
  | "drawing-unlock"
  | "drawing-hide"
  | "drawing-show"
  | "drawing-bring-forward"
  | "drawing-send-backward";

export interface ChartCommandDefinition {
  id: ChartCommandId;
  titleKey: ChartMessageKey;
}

/**
 * Canonical chart command catalogue. Palette/context-menu/keyboard adapters expose
 * these IDs; behaviour lives only in executeChartAction().
 */
export const CHART_COMMAND_DEFINITIONS: readonly ChartCommandDefinition[] = [
  { id: "reset-price-scale", titleKey: "command.resetPriceScale" },
  { id: "reset-time-scale", titleKey: "command.resetTimeScale" },
  { id: "reset-all-scales", titleKey: "command.resetAllScales" },
  { id: "go-latest", titleKey: "command.goLatest" },
  { id: "toggle-auto-scale", titleKey: "command.toggleAutoScale" },
  { id: "toggle-log-scale", titleKey: "command.toggleLogScale" },
  { id: "drawing-duplicate", titleKey: "command.drawingDuplicate" },
  { id: "drawing-copy", titleKey: "command.drawingCopy" },
  { id: "drawing-paste", titleKey: "command.drawingPaste" },
  { id: "drawing-delete", titleKey: "command.drawingDelete" },
  { id: "drawing-lock", titleKey: "command.drawingLock" },
  { id: "drawing-unlock", titleKey: "command.drawingUnlock" },
  { id: "drawing-hide", titleKey: "command.drawingHide" },
  { id: "drawing-show", titleKey: "command.drawingShow" },
  { id: "drawing-bring-forward", titleKey: "command.drawingBringForward" },
  { id: "drawing-send-backward", titleKey: "command.drawingSendBackward" },
];

const COMMAND_IDS = new Set<string>(CHART_COMMAND_DEFINITIONS.map((definition) => definition.id));

export function isChartCommandId(value: string): value is ChartCommandId {
  return COMMAND_IDS.has(value);
}

export interface ChartCommandTarget {
  resetPriceScale(): void;
  resetTimeScale(): void;
  resetAllScales(): void;
  goLatest(): void;
  togglePriceAutoScale(): boolean;
  togglePriceScaleMode(): ChartPanelState["scaleMode"];
  setLinkGroup(color: LinkGroupColor | null): void;
  mergeTpoProfileLeft(sessionStart: number): boolean;
  undoTpoProfileMerges(sessionStarts: readonly number[]): boolean;
  invalidate(): void;
  resetIndicatorPaneScale(paneId: string): boolean;
  toggleIndicatorPaneAutoScale(paneId: string): boolean;
  toggleIndicatorScaleModeFromControl(paneId: string): "linear" | "log" | null;
  toggleIndicatorPanes(): void;
  togglePanelMaximize(): void;
}

export interface ChartCommandServices {
  getAnalysisContext(market?: string, includeHiddenAutomatic?: boolean): AnalysisContext;
  notify(message: string): void;
  /** Chart panel that owns window-level keyboard shortcuts; absent hosts let every chart handle them. */
  getKeyboardTargetChartId?(): string | undefined;
}

/**
 * Execute both string command IDs and structured context-menu actions through one
 * feature-owned behaviour contract. Returns true when the action was recognized.
 */
export function executeChartAction(
  action: ChartContextMenuAction,
  target: ChartCommandTarget,
  services: ChartCommandServices,
): boolean {
  if (action === "link-group-submenu") return true;

  if (typeof action === "object") {
    if (action.kind === "set-link-group") {
      target.setLinkGroup(action.color);
      services.notify(action.color ? t("notify.linkGroupSet", { color: action.color }) : t("notify.linkGroupCleared"));
      return true;
    }
    if (action.kind === "tpo-merge-left") {
      const merged = target.mergeTpoProfileLeft(action.sessionStart);
      services.notify(merged ? t("notify.tpoMergedLeft") : t("notify.tpoMergeUnavailable"));
      return true;
    }
    if (action.kind === "tpo-undo-merges") {
      const undone = target.undoTpoProfileMerges(action.sessionStarts);
      services.notify(undone ? t("notify.tpoMergesUndone") : t("notify.tpoMergeUnavailable"));
      return true;
    }
    if (action.kind === "indicator-reset-scale") {
      target.resetIndicatorPaneScale?.(action.paneId);
      return true;
    }
    if (action.kind === "indicator-toggle-auto-scale") {
      target.toggleIndicatorPaneAutoScale?.(action.paneId);
      return true;
    }
    if (action.kind === "indicator-toggle-log-scale") {
      target.toggleIndicatorScaleModeFromControl?.(action.paneId);
      return true;
    }
    if (action.kind === "toggle-indicator-panes") {
      target.toggleIndicatorPanes();
      return true;
    }
    if (action.kind === "toggle-panel-maximize") {
      target.togglePanelMaximize();
      return true;
    }
    return false;
  }

  if (!isChartCommandId(action)) return false;
  const drawings = () => services.getAnalysisContext().drawings;
  switch (action) {
    case "reset-price-scale":
      target.resetPriceScale();
      services.notify(t("notify.priceScaleReset"));
      return true;
    case "reset-time-scale":
      target.resetTimeScale();
      services.notify(t("notify.timeScaleReset"));
      return true;
    case "reset-all-scales":
      target.resetAllScales();
      services.notify(t("notify.allScalesReset"));
      return true;
    case "go-latest":
      target.goLatest();
      services.notify(t("notify.goLatest"));
      return true;
    case "toggle-auto-scale": {
      const enabled = target.togglePriceAutoScale();
      services.notify(enabled ? t("notify.autoScaleOn") : t("notify.autoScaleOff"));
      return true;
    }
    case "toggle-log-scale": {
      const mode = target.togglePriceScaleMode();
      services.notify(mode === "log" ? t("notify.logScaleOn") : t("notify.linearScaleOn"));
      return true;
    }
    case "drawing-duplicate":
      drawings().duplicateSelected();
      target.invalidate();
      return true;
    case "drawing-copy":
      drawings().copySelected();
      return true;
    case "drawing-paste":
      drawings().pasteClipboard();
      target.invalidate();
      return true;
    case "drawing-delete":
      drawings().deleteSelected();
      target.invalidate();
      return true;
    case "drawing-lock":
      drawings().setSelectedLocked(true);
      target.invalidate();
      return true;
    case "drawing-unlock":
      drawings().setSelectedLocked(false);
      target.invalidate();
      return true;
    case "drawing-hide":
      drawings().setSelectedVisible(false);
      target.invalidate();
      return true;
    case "drawing-show":
      drawings().setSelectedVisible(true);
      target.invalidate();
      return true;
    case "drawing-bring-forward":
      drawings().bringSelectedForward();
      target.invalidate();
      return true;
    case "drawing-send-backward":
      drawings().sendSelectedBackward();
      target.invalidate();
      return true;
  }
}
