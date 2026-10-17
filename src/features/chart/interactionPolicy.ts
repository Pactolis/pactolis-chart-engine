import type { ChartAxisTarget } from "./axisInteraction.js";

/**
 * Interaction switches for one chart runtime.
 *
 * The switches make the scroll/scale/context-menu split explicit instead of baking every
 * decision into ChartRuntime handlers.
 */
export interface ChartInteractionPolicy {
  readonly scroll: {
    readonly plotPressedMouseMove: boolean;
    readonly mouseWheel: boolean;
    readonly horizontalWheelPan: boolean;
  };
  readonly scale: {
    readonly mouseWheel: boolean;
    readonly altWheelPrice: boolean;
    readonly priceAxisWheel: boolean;
    readonly axisPressedMouseMove: {
      readonly time: boolean;
      readonly price: boolean;
    };
    readonly axisDoubleClickReset: {
      readonly time: boolean;
      readonly price: boolean;
      readonly cornerBoth: boolean;
    };
  };
  readonly contextMenu: {
    readonly enabled: boolean;
    readonly targets: Readonly<Record<ChartAxisTarget, boolean>>;
  };
  readonly helpOverlay: {
    readonly enabled: boolean;
    readonly keyboardShortcut: boolean;
  };
}

export const DEFAULT_CHART_INTERACTION_POLICY: ChartInteractionPolicy = {
  scroll: {
    plotPressedMouseMove: true,
    mouseWheel: true,
    horizontalWheelPan: true,
  },
  scale: {
    mouseWheel: true,
    altWheelPrice: true,
    priceAxisWheel: true,
    axisPressedMouseMove: {
      time: true,
      price: true,
    },
    axisDoubleClickReset: {
      time: true,
      price: true,
      cornerBoth: true,
    },
  },
  contextMenu: {
    enabled: true,
    targets: {
      plot: true,
      "price-axis": true,
      "time-axis": true,
      "corner-axis": true,
    },
  },
  helpOverlay: {
    enabled: true,
    keyboardShortcut: true,
  },
};

export function canUseContextMenu(policy: ChartInteractionPolicy, target: ChartAxisTarget): boolean {
  return policy.contextMenu.enabled && policy.contextMenu.targets[target];
}
