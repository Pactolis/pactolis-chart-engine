import type { ChartAxisTarget } from "./axisInteraction.js";
import type { LinkGroupColor } from "../../core/chartPanelState.js";
import { t } from "../../core/chartLocale.js";
import type { ChartPanelMaximizeState } from "./chartPanelFocus.js";

export type ChartContextMenuAction =
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
  | "drawing-send-backward"
  | "link-group-submenu"
  | { kind: "tpo-merge-left"; sessionStart: number }
  | { kind: "tpo-undo-merges"; sessionStarts: readonly number[] }
  | { kind: "indicator-reset-scale"; paneId: string }
  | { kind: "indicator-toggle-auto-scale"; paneId: string }
  | { kind: "indicator-toggle-log-scale"; paneId: string }
  | { kind: "toggle-indicator-panes" }
  | { kind: "toggle-panel-maximize" }
  /** Grup rengi atama veya kaldırma.
   *  `color === null` gruplanmamış anlamına gelir. */
  | { kind: "set-link-group"; color: LinkGroupColor | null };

export interface ChartContextMenuItem {
  readonly action: ChartContextMenuAction;
  readonly label: string;
  readonly hint?: string;
  /** Child items rendered in a right-side flyout. */
  readonly submenu?: readonly ChartContextMenuItem[];
  /** Current link-group shown on the parent flyout row. */
  readonly currentLinkGroup?: LinkGroupColor | null;
}

/** Build the list of link group menu items: five colors plus a disabled option. */
export function linkGroupMenuItems(): ChartContextMenuItem[] {
  const options: Array<{ color: LinkGroupColor | null; label: string; hint: string }> = [
    { color: null, label: t("linkgroup.none"), hint: "⌧" },
    { color: "red", label: t("linkgroup.red"), hint: "R" },
    { color: "blue", label: t("linkgroup.blue"), hint: "B" },
    { color: "green", label: t("linkgroup.green"), hint: "G" },
    { color: "orange", label: t("linkgroup.orange"), hint: "O" },
    { color: "purple", label: t("linkgroup.purple"), hint: "P" },
  ];
  return options.map(({ color, label, hint }) => ({
    action: { kind: "set-link-group", color },
    label,
    hint,
  }));
}

export interface ChartContextMenuDetail {
  readonly target: ChartAxisTarget;
  readonly x: number;
  readonly y: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly panelId: string;
  readonly market: string;
  readonly timeframe: string;
  readonly linkGroup?: LinkGroupColor | null;
  readonly drawingSelectionCount?: number;
  readonly tpoProfile?: {
    readonly sessionStart: number;
    readonly groupSessionStarts: readonly number[];
    readonly canMergeLeft: boolean;
    readonly canUndoMerges: boolean;
  } | null;
  readonly indicatorPaneId?: string | null;
  readonly indicatorAxis?: boolean;
  /** Plot menu only: state behind the "hide indicators" / "maximize tab" toggles. */
  readonly paneFocus?: ChartPaneFocusState | null;
}

export interface ChartPaneFocusState {
  readonly hasIndicatorPanes: boolean;
  readonly indicatorsHidden: boolean;
  readonly panel: ChartPanelMaximizeState;
}

/** Hide-indicators and maximize-tab toggles; each item is left out when it has nothing to do. */
export function paneFocusMenuItems(focus: ChartPaneFocusState | null | undefined): ChartContextMenuItem[] {
  if (!focus) return [];
  const items: ChartContextMenuItem[] = [];
  if (focus.hasIndicatorPanes || focus.indicatorsHidden) {
    items.push({
      action: { kind: "toggle-indicator-panes" },
      label: focus.indicatorsHidden ? t("menu.showIndicatorPanes") : t("menu.hideIndicatorPanes"),
    });
  }
  if (focus.panel.available) {
    items.push(focus.panel.maximized
      ? { action: { kind: "toggle-panel-maximize" }, label: t("menu.exitPanelMaximize"), hint: "Esc" }
      : { action: { kind: "toggle-panel-maximize" }, label: t("menu.maximizePanel") });
  }
  return items;
}

export interface ChartContextMenuState extends ChartContextMenuDetail {
  readonly items: readonly ChartContextMenuItem[];
}

export function chartContextMenuItemsForTarget(
  target: ChartAxisTarget,
  linkGroup: LinkGroupColor | null = null,
  drawingSelectionCount = 0,
  tpoProfile: ChartContextMenuDetail["tpoProfile"] = null,
  paneFocus: ChartPaneFocusState | null = null,
): readonly ChartContextMenuItem[] {
  let base: ChartContextMenuItem[];
  switch (target) {
    case "price-axis":
      base = [
        { action: "reset-price-scale", label: t("menu.resetPriceScale"), hint: "Y" },
        { action: "toggle-auto-scale", label: t("menu.toggleAutoScale"), hint: "O" },
        { action: "toggle-log-scale", label: t("menu.toggleLogScale"), hint: "L" },
      ];
      break;
    case "time-axis":
      base = [
        { action: "reset-time-scale", label: t("menu.resetTimeScale"), hint: "X" },
        { action: "go-latest", label: t("menu.goLatest"), hint: "End" },
      ];
      break;
    case "corner-axis":
      base = [
        { action: "reset-all-scales", label: t("menu.resetAllScales"), hint: "X+Y" },
        { action: "go-latest", label: t("menu.goLatest"), hint: "End" },
      ];
      break;
    case "plot":
    default:
      base = [
        { action: "reset-price-scale", label: t("menu.resetPriceScale"), hint: "Y" },
        { action: "go-latest", label: t("menu.goLatest"), hint: "End" },
        { action: "reset-all-scales", label: t("menu.resetAllScales"), hint: "X+Y" },
      ];
      break;
  }
  const drawingItems: ChartContextMenuItem[] = drawingSelectionCount > 0 ? [
    { action: "drawing-duplicate", label: t("object.duplicateDrawing"), hint: "Ctrl+D" },
    { action: "drawing-copy", label: t("object.copyDrawing"), hint: "Ctrl+C" },
    { action: "drawing-paste", label: t("object.pasteDrawing"), hint: "Ctrl+V" },
    { action: "drawing-bring-forward", label: t("object.bringForward") },
    { action: "drawing-send-backward", label: t("object.sendBackward") },
    { action: "drawing-lock", label: t("common.lock") },
    { action: "drawing-unlock", label: t("common.unlock") },
    { action: "drawing-hide", label: t("object.hideDrawing") },
    { action: "drawing-show", label: t("object.showDrawing") },
    { action: "drawing-delete", label: t("object.deleteDrawing"), hint: "Del" },
  ] : [];
  // A context menu opened on a drawing is object-scoped. Chart commands such as
  // reset scale / go latest / link group belong to the empty plot context only.
  if (target === "plot" && drawingItems.length > 0) return drawingItems;

  const tpoItems: ChartContextMenuItem[] = target === "plot" && tpoProfile ? [
    ...(tpoProfile.canMergeLeft ? [{
      action: { kind: "tpo-merge-left" as const, sessionStart: tpoProfile.sessionStart },
      label: t("menu.tpoMergeLeft"),
    }] : []),
    ...(tpoProfile.canUndoMerges ? [{
      action: { kind: "tpo-undo-merges" as const, sessionStarts: [...tpoProfile.groupSessionStarts] },
      label: t("menu.tpoUndoMerges"),
    }] : []),
  ] : [];
  if (target === "plot" || target === "corner-axis") {
    return [
      ...tpoItems,
      ...base,
      ...(target === "plot" ? paneFocusMenuItems(paneFocus) : []),
      {
        action: "link-group-submenu",
        label: t("linkgroup.label"),
        currentLinkGroup: linkGroup ?? null,
        submenu: linkGroupMenuItems(),
      },
    ];
  }
  return base;
}

export function makeChartContextMenuState(detail: ChartContextMenuDetail): ChartContextMenuState {
  if (detail.indicatorPaneId) {
    return {
      ...detail,
      items: [
        { action: { kind: "indicator-reset-scale", paneId: detail.indicatorPaneId }, label: t("menu.resetPriceScale"), hint: "Y" },
        { action: { kind: "indicator-toggle-auto-scale", paneId: detail.indicatorPaneId }, label: t("menu.toggleAutoScale"), hint: "O" },
        { action: { kind: "indicator-toggle-log-scale", paneId: detail.indicatorPaneId }, label: t("menu.toggleLogScale"), hint: "L" },
      ],
    };
  }
  return {
    ...detail,
    items: chartContextMenuItemsForTarget(
      detail.target,
      detail.linkGroup,
      detail.drawingSelectionCount,
      detail.tpoProfile ?? null,
      detail.paneFocus ?? null,
    ),
  };
}
