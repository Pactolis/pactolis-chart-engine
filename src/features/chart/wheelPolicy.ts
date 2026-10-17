import type { ChartAxisTarget } from "./axisInteraction.js";
import { DEFAULT_CHART_INTERACTION_POLICY, type ChartInteractionPolicy } from "./interactionPolicy.js";

export interface ChartWheelInput {
  deltaX: number;
  deltaY: number;
  altKey: boolean;
  shiftKey: boolean;
  /** WheelEvent.deltaMode: 0 = pixels (default), 1 = lines, 2 = pages. */
  deltaMode?: number;
  /** Platform correction applied to pixel deltas (Chromium on Windows scales them by DPR). */
  deltaScale?: number;
  /** Hit-tested region under the pointer. Defaults to plot for legacy callers. */
  target?: ChartAxisTarget;
}

export type ChartWheelAction =
  | { kind: "zoom-y"; factor: number }
  | { kind: "zoom-x"; factor: number }
  | { kind: "pan-x"; deltaPx: number }
  | { kind: "zoom-pan-x"; factor: number; deltaPx: number };

/** Largest zoom step a single wheel event may apply (one physical notch). */
const MAX_ZOOM_STEP = 1.1;
/**
 * Pixel delta that counts as one full zoom step. Mouse wheels report ~100-120px
 * per notch, so they keep the full 10% step; trackpads and pinch gestures emit
 * many small deltas and now zoom proportionally.
 */
const FULL_STEP_DELTA_PX = 100;
const LINE_DELTA_PX = 32;
const PAGE_DELTA_PX = 120;
const HORIZONTAL_PAN_SPEED = 0.5;

/** Convert a raw wheel delta into CSS pixels, honouring deltaMode and platform scaling. */
function normalizeDelta(delta: number, input: ChartWheelInput): number {
  const modeScale = input.deltaMode === 1 ? LINE_DELTA_PX : input.deltaMode === 2 ? PAGE_DELTA_PX : 1;
  return delta * modeScale * (input.deltaScale ?? 1);
}

/**
 * Map a normalized delta to a zoom factor proportional to its size, capped at
 * one full step. The exponential form keeps zoom in/out symmetric, so the same
 * gesture reversed returns to the starting scale.
 */
function zoomFactorFromDelta(delta: number): number {
  const step = Math.max(-1, Math.min(1, delta / FULL_STEP_DELTA_PX));
  return step === 0 ? 1 : MAX_ZOOM_STEP ** step;
}

function factorFromWheelDelta(delta: number, input: ChartWheelInput): number {
  // Wheel up (negative delta) widens bars, i.e. factor > 1.
  return zoomFactorFromDelta(-normalizeDelta(delta, input));
}

function priceZoomDelta(input: ChartWheelInput): number {
  // A physical mouse wheel reports deltaY. Some trackpads/browsers may surface
  // the active gesture as deltaX; fall back so price-axis wheel still has a
  // deterministic vertical-scale intent when the pointer is over the Y axis.
  return input.deltaY !== 0 ? input.deltaY : input.deltaX;
}

function priceZoomFactor(input: ChartWheelInput): number {
  // View.zoomY() uses factors below 1 to narrow the visible price range, so the
  // price-axis/Alt convention is intentionally inverted from X zoom.
  return zoomFactorFromDelta(normalizeDelta(priceZoomDelta(input), input));
}

function shiftZoomDelta(input: ChartWheelInput): number {
  // Browsers differ here: some keep Shift+wheel in deltaY, others translate it
  // to horizontal deltaX. Prefer deltaY when present so the physical wheel
  // direction stays stable, and fall back to deltaX for trackpads/browsers that
  // emit horizontal deltas only.
  return input.deltaY !== 0 ? input.deltaY : input.deltaX;
}

export function resolveChartWheelAction(
  input: ChartWheelInput,
  policy: ChartInteractionPolicy = DEFAULT_CHART_INTERACTION_POLICY,
): ChartWheelAction {
  if (!policy.scale.mouseWheel && !policy.scroll.mouseWheel) {
    return { kind: "zoom-x", factor: 1 };
  }

  if (input.altKey && policy.scale.altWheelPrice) {
    // Alt + wheel scales the price axis for footprint detail inspection.
    // This is a manual Y-scale action; callers must not re-enable auto-fit.
    return { kind: "zoom-y", factor: priceZoomFactor(input) };
  }

  if (input.target === "price-axis" && policy.scale.priceAxisWheel) {
    // When the pointer is over the Y axis, plain wheel should act on price scale
    // directly instead of falling through to the plot/time horizontal policy.
    return { kind: "zoom-y", factor: priceZoomFactor(input) };
  }

  if (input.shiftKey) {
    // Shift + wheel is an explicit horizontal/detail zoom, not a pan and not an
    // auto-fit reset. It is used to make footprint text/columns wider.
    return { kind: "zoom-x", factor: factorFromWheelDelta(shiftZoomDelta(input), input) };
  }

  // Trackpads report diagonal gestures with both axes populated. Apply the
  // vertical part as zoom and the horizontal part as pan in the same event so
  // neither axis swallows the other.
  const factor = policy.scale.mouseWheel ? factorFromWheelDelta(input.deltaY, input) : 1;
  const panPx = policy.scroll.mouseWheel && policy.scroll.horizontalWheelPan
    ? normalizeDelta(input.deltaX, input) * HORIZONTAL_PAN_SPEED
    : 0;

  if (panPx !== 0 && factor !== 1) return { kind: "zoom-pan-x", factor, deltaPx: panPx };
  if (panPx !== 0) return { kind: "pan-x", deltaPx: panPx };
  return { kind: "zoom-x", factor };
}
