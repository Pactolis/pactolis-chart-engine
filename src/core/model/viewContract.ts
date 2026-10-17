import type { TimeScaleOptions } from "./timeScaleOptions.js";

/** Minimal rect shape mirroring `engine/view.ts`'s `ChartArea` (left/top/width/height px). */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Structural readout of `engine/view.ts`'s `View` class, scoped to the members
 * `axisLayout.ts` and `timeScale.ts` actually read. Lets model/ consume View
 * geometry without importing engine/ (engine/view.ts imports from model/, so
 * the reverse import would create a module cycle). `View` remains structurally
 * assignable here; no engine/view.ts changes are needed.
 */
export interface ViewReadout {
  readonly area: ViewRect;
  readonly priceAxisW: number;
  readonly subPanesH: number;
  readonly colWidth: number;
  readonly offsetX: number;
  readonly timeScaleOptions: TimeScaleOptions;
  xOfIndex(index: number): number;
  indexOfX(x: number): number;
}
