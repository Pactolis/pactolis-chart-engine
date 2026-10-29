/**
 * ChartInputController — per-panel mouse/touch/keyboard input layer (TASK-036).
 *
 * DOM event wiring and gesture state live here. Command behaviour is owned by
 * chartCommands.ts so context menus, palette commands and input routes cannot
 * drift into separate implementations.
 *
 * Touch (pointerType "touch") follows the mouse paths with these differences: a press only
 * becomes a drag past a larger dead zone, a second finger turns the pan into a pinch, a long
 * press inspects with the crosshair, and the corner "⋯" button opens the context menu.
 * Mouse, pen and synthetic events without a pointer type keep the mouse behavior.
 */

import { resolveChartWheelAction } from "./wheelPolicy.js";
import { DEFAULT_CHART_INTERACTION_POLICY, canUseContextMenu } from "./interactionPolicy.js";
import { hitTestChartAxis, type ChartAxisTarget } from "./axisInteraction.js";
import type { ChartContextMenuAction, ChartContextMenuDetail } from "./contextMenuModel.js";
import type { Crosshair } from "../../core/render/overlay.js";
import { ChartChange } from "../../core/render/scene/chartScene.js";
import type { View } from "../../core/engine/view.js";
import type { Overlay } from "../../core/render/overlay.js";
import type { ChartSession } from "./ChartSession.js";
import type { ChartDataPipeline } from "./ChartDataPipeline.js";
import type { TimeScaleViewportController } from "../controllers/timeScaleViewportController.js";
import type { ChartPanelState } from "../../core/chartPanelState.js";
import { isDrawingMagnetTransientActive, setDrawingMagnetTransient } from "./drawingInteractionState.js";
import { executeChartAction, type ChartCommandServices, type ChartCommandTarget } from "./chartCommands.js";
import { ChartGestureController, type ChartPanGesture } from "./ChartGestureController.js";
import { requestChartPanelMaximize } from "./chartPanelFocus.js";
import {
  LONG_PRESS_MS,
  TIME_AXIS_TOUCH_SLOP_PX,
  TOUCH_CLICK_SLOP_PX,
  TOUCH_CONTEXT_MENU_WINDOW_MS,
  TouchPointers,
  clickSlopPx,
  isTouchPointer,
  movedBeyondSlop,
  pinchSample,
  pinchStep,
} from "./touchGestures.js";
export { isDrawingMagnetTransientActive } from "./drawingInteractionState.js";

/** Internal owner-document route from WindowOverlayRoot back to the originating canvas. */
export const CHART_OVERLAY_ACTION_EVENT = "footprint-internal-chart-overlay-action";
export interface ChartOverlayActionEventDetail {
  action: ChartContextMenuAction;
}

/** A touch may start a time-axis scale from a little above the thin axis strip. */
const TOUCH_AXIS_HIT = { timeAxisSlop: TIME_AXIS_TOUCH_SLOP_PX };

const IS_CHROMIUM_WINDOWS = typeof navigator !== "undefined"
  && /Windows/.test(navigator.userAgent)
  && /Chrome\//.test(navigator.userAgent);

/** Chromium on Windows scales wheel pixel deltas by devicePixelRatio; undo that. */
function wheelDeltaScale(): number {
  if (!IS_CHROMIUM_WINDOWS || typeof window === "undefined") return 1;
  return 1 / (window.devicePixelRatio || 1);
}

function prefersCoarsePointer(win: Window | null): boolean {
  try {
    return win?.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

export function isDrawingMagnetEnabled(persistentMagnet: boolean, temporaryMagnet: boolean): boolean {
  return persistentMagnet || temporaryMagnet;
}

/**
 * Snap a raw drawing price to the nearest candle OHLC level in screen pixels.
 * The persistent magnet is weak (8px threshold); the temporary modifier magnet
 * forces the nearest level, even when the pointer is farther away.
 */
export function snapPriceToOhlc(
  rawPrice: number,
  cy: number,
  ohlc: readonly number[],
  yOfPrice: (price: number) => number,
  forceNearest: boolean,
): number {
  let nearestPrice = rawPrice;
  let nearestDistancePx = Infinity;
  for (const price of ohlc) {
    const distancePx = Math.abs(yOfPrice(price) - cy);
    if (distancePx < nearestDistancePx) {
      nearestDistancePx = distancePx;
      nearestPrice = price;
    }
  }
  return forceNearest || nearestDistancePx <= 8 ? nearestPrice : rawPrice;
}

export function isDrawingMagnetModifierPressed(
  modifiers: Pick<MouseEvent, "ctrlKey" | "metaKey">,
): boolean {
  return modifiers.ctrlKey || modifiers.metaKey;
}

export function shouldUseTemporaryDrawingMagnet(
  activeTool: string | null,
  modifiers: Pick<MouseEvent, "ctrlKey" | "metaKey">,
): boolean {
  return activeTool !== null && isDrawingMagnetModifierPressed(modifiers);
}

/**
 * The exact surface the input layer needs from its host (ChartRuntime). Keeping
 * this narrow means an input handler can never accidentally mutate unrelated
 * runtime state — only the members listed here are reachable.
 */
export interface ChartInputHost extends ChartCommandTarget {
  readonly svc: ChartCommandServices;
  readonly view: View;
  readonly session: ChartSession;
  readonly pipeline: ChartDataPipeline;
  readonly overlay: Overlay;
  readonly timeViewport: TimeScaleViewportController;
  readonly state: ChartPanelState;
  readonly panelId: string;
  /** Re-entrancy guard owned by ChartRuntime (link-group sync); input reads only. */
  readonly applyingExternal: boolean;

  screenToDrawingPoint(cx: number, cy: number, temporaryMagnet?: boolean): { time: number; price: number };
  indexToTime(index: number): number | null;
  /** Internal seam: maps screen coords through the runtime-owned raw cursor contract. */
  resolveScreenCrosshair(cx: number, cy: number): { time: number | null; price: number | null };

  setPriceAutoScaleFromControl(autoScale: boolean): void;
  togglePriceScaleModeFromControl(): ChartPanelState["scaleMode"];
  scaleIndicatorPane(paneId: string, factorMultiplier: number): boolean;

  autoFit(): void;
  emitVisibleRange(): void;
  notifyCrosshair(e: { time: number | null; price: number | null }): void;
  isReplaySelecting(): boolean;
  previewReplayStart(time: number | null): void;
  selectReplayStart(time: number): void;
  togglePaneMaximizeAt(y: number): boolean;
  isChartPaneMaximized(): boolean;
  hasIndicatorPanes(): boolean;
}

export class ChartInputController {
  private readonly disposeFn: () => void;

  constructor(canvas: HTMLCanvasElement, crosshair: Crosshair, host: ChartInputHost) {
    this.disposeFn = attachChartInput(canvas, crosshair, host);
  }

  dispose(): void {
    this.disposeFn();
  }
}

/** Wires every canvas/window listener and returns a cleanup function. */
function attachChartInput(canvas: HTMLCanvasElement, crosshair: Crosshair, host: ChartInputHost): () => void {
  const view = host.view;
  const session = host.session;
  const ownerWindow = canvas.ownerDocument.defaultView;
  const interactionPolicy = DEFAULT_CHART_INTERACTION_POLICY;
  const gestures = new ChartGestureController(canvas);
  const touches = new TouchPointers();
  let longPress: { timer: ReturnType<typeof setTimeout>; pointerId: number } | null = null;
  let lastTouchDownAt = Number.NEGATIVE_INFINITY;
  /** True while the keyboard route dispatches its synthetic contextmenu, which must not be mistaken for a touch's. */
  let keyboardContextMenu = false;
  let transientMagnetActive = false;
  const transientMagnetSource = {};

  const nowMs = (): number => ownerWindow?.performance?.now() ?? Date.now();

  // A touch screen as the primary pointer shows the touch controls before the first touch.
  if (prefersCoarsePointer(ownerWindow)) {
    crosshair.touch = true;
    session?.invalidate(ChartChange.Interaction | ChartChange.Style);
  }

  const setTouchMode = (on: boolean): void => {
    if ((crosshair.touch === true) === on) return;
    crosshair.touch = on;
    // The price gutter's tick labels make room for the touch buttons, so the annotation surface repaints too.
    session.invalidate(ChartChange.Interaction | ChartChange.Style);
  };

  const syncTransientMagnet = (modifiers: Pick<MouseEvent, "ctrlKey" | "metaKey">): void => {
    const drawings = host.svc.getAnalysisContext().drawings;
    const active = isDrawingMagnetTransientActive(drawings.activeTool, modifiers);
    if (active === transientMagnetActive || !ownerWindow) return;
    transientMagnetActive = active;
    setDrawingMagnetTransient(transientMagnetSource, active);
  };

  const clearTransientMagnet = (): void => {
    if (!transientMagnetActive || !ownerWindow) return;
    transientMagnetActive = false;
    setDrawingMagnetTransient(transientMagnetSource, false);
  };

  const applyHorizontalViewportChange = (): void => {
    host.autoFit();
    session.invalidate(ChartChange.Viewport);
    host.emitVisibleRange();
  };

  const cursorForTarget = (target: ChartAxisTarget): string => {
    if (target === "price-axis") return "ns-resize";
    if (target === "time-axis") return "ew-resize";
    return "default";
  };

  const updateAxisCursor = (e: PointerEvent): void => {
    if (gestures.pan) {
      canvas.style.cursor = cursorForTarget(gestures.pan.target);
      return;
    }
    if (gestures.indicatorScale) {
      canvas.style.cursor = "ns-resize";
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    canvas.style.cursor = cursorForTarget(hitTestChartAxis(view, cx, cy));
  };

  const rebaseActiveGestureAfterWheel = (e: WheelEvent, localX: number, localY: number): void => {
    if (!gestures.pan) return;

    if (gestures.pan.target === "price-axis") {
      view.endPriceAxisScale();
      view.startPriceAxisScale(localY);
    } else if (gestures.pan.target === "time-axis") {
      host.timeViewport.endTimeAxisScale();
      host.timeViewport.beginTimeAxisScale(localX);
    } else if (gestures.pan.target === "plot") {
      host.timeViewport.endPlotPan();
      host.timeViewport.beginPlotPan();
    }

    gestures.pan = {
      ...gestures.pan,
      x: e.clientX,
      y: e.clientY,
      priceTop: view.priceTop,
      pricePerPx: view.pricePerPx,
      wheeled: true,
    };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const indicatorPaneId = host.overlay.getIndicatorAxisPaneAt(localX, localY);
    if (indicatorPaneId) {
      host.scaleIndicatorPane(indicatorPaneId, Math.exp(e.deltaY * 0.0015));
      session.invalidate(ChartChange.Viewport);
      return;
    }
    const hitTarget = hitTestChartAxis(view, localX, localY);
    const target = gestures.pan && gestures.pan.target !== "corner-axis" ? gestures.pan.target : hitTarget;
    const action = resolveChartWheelAction({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      deltaMode: e.deltaMode,
      deltaScale: wheelDeltaScale(),
      target,
    }, interactionPolicy);

    if (action.kind === "zoom-y") {
      view.zoomY(action.factor, localY);
      host.view.setPriceAutoScale(false);
      rebaseActiveGestureAfterWheel(e, localX, localY);
      session.invalidate(ChartChange.Viewport);
      return;
    }

    const total = host.pipeline.series.length;
    if (action.kind === "zoom-x" || action.kind === "zoom-pan-x") {
      host.timeViewport.applyWheelZoom(action.factor, localX, total);
    }
    if (action.kind === "pan-x" || action.kind === "zoom-pan-x") {
      host.timeViewport.applyWheelPan(action.deltaPx, total);
    }
    rebaseActiveGestureAfterWheel(e, localX, localY);
    applyHorizontalViewportChange();
  };

  const moveDrawing = (e: PointerEvent, cx: number, cy: number): void => {
    const drawings = host.svc.getAnalysisContext().drawings;
    syncTransientMagnet(e);
    drawings.setMarket(host.state.market);
    drawings.pointerMove(host.screenToDrawingPoint(cx, cy, shouldUseTemporaryDrawingMagnet(drawings.activeTool, e)));
    session.invalidate();
  };

  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const drawings = host.svc.getAnalysisContext().drawings;
    if (gestures.drawingActive || drawings.hasDraft()) {
      moveDrawing(e, cx, cy);
      if (gestures.drawingActive) return;
    }
    crosshair.x = cx;
    crosshair.y = cy;
    crosshair.visible = true;
    session.invalidate(ChartChange.Interaction);
    if (!host.applyingExternal) {
      const pointer = host.resolveScreenCrosshair(crosshair.x, crosshair.y);
      host.notifyCrosshair({ time: pointer.time, price: pointer.price });
    }
  };

  const onPointerLeave = () => {
    crosshair.visible = false;
    if (host.isReplaySelecting()) host.previewReplayStart(null);
    if (!gestures.pan) canvas.style.cursor = "default";
    session.invalidate(ChartChange.Interaction);
    if (!host.applyingExternal) {
      host.notifyCrosshair({ time: null, price: null });
    }
  };

  /** `keepCapture` leaves the finger captured when it goes on to drive another gesture (a pinch). */
  const endActiveGesture = (pointerId?: number, keepCapture = false): void => {
    if (!gestures.pan) return;
    if (pointerId !== undefined && gestures.pan.pointerId !== pointerId) return;
    const target = gestures.pan.target;
    const capturedPointerId = gestures.pan.pointerId;
    if (target === "price-axis") view.endPriceAxisScale();
    if (target === "time-axis") host.timeViewport.endTimeAxisScale();
    if (target === "plot") host.timeViewport.endPlotPan();
    gestures.pan = null;
    if (!keepCapture) gestures.releasePointer(pointerId ?? capturedPointerId);
    canvas.style.cursor = "default";
  };

  /** One pointer drives a gesture at a time; a second finger must not take over or end it. */
  const ownedByOtherPointer = (pointerId: number): boolean =>
    (gestures.pan !== null && gestures.pan.pointerId !== pointerId)
    || (gestures.indicatorScale !== null && gestures.indicatorScale.pointerId !== pointerId)
    || (gestures.drawingActive && gestures.acceptedDrawingPointerId !== null && gestures.acceptedDrawingPointerId !== pointerId)
    || (gestures.pinch !== null && gestures.pinch.firstId !== pointerId && gestures.pinch.secondId !== pointerId)
    || (gestures.inspect !== null && gestures.inspect.pointerId !== pointerId)
    || (gestures.menuPress !== null && gestures.menuPress.pointerId !== pointerId);

  const gestureInProgress = (): boolean =>
    gestures.pan !== null || gestures.pinch !== null || gestures.inspect !== null || gestures.menuPress !== null
    || gestures.indicatorScale !== null || gestures.drawingActive;

  // --- Touch ----------------------------------------------------------------------------------

  const cancelLongPress = (pointerId?: number): void => {
    if (!longPress || (pointerId !== undefined && longPress.pointerId !== pointerId)) return;
    clearTimeout(longPress.timer);
    longPress = null;
  };

  const armLongPress = (pointerId: number): void => {
    cancelLongPress();
    longPress = {
      pointerId,
      timer: setTimeout(() => {
        longPress = null;
        startInspect(pointerId);
      }, LONG_PRESS_MS),
    };
  };

  const hideCrosshair = (): void => {
    crosshair.visible = false;
    session.invalidate(ChartChange.Interaction);
    if (!host.applyingExternal) host.notifyCrosshair({ time: null, price: null });
  };

  /** The inspecting finger moves the crosshair, kept inside the plot (and the panes under it). */
  const moveInspect = (localX: number, localY: number): void => {
    const area = view.area;
    crosshair.x = Math.min(Math.max(localX, area.left), area.left + area.width);
    crosshair.y = Math.min(Math.max(localY, area.top), area.top + area.height + view.subPanesH);
    crosshair.visible = true;
    session.invalidate(ChartChange.Interaction);
    if (!host.applyingExternal) {
      const pointer = host.resolveScreenCrosshair(crosshair.x, crosshair.y);
      host.notifyCrosshair({ time: pointer.time, price: pointer.price });
    }
  };

  /** A finger held still on the plot swaps its pan for the crosshair; lifting it closes the crosshair. */
  const startInspect = (pointerId: number): void => {
    const pan = gestures.pan;
    const finger = touches.get(pointerId);
    if (!pan || pan.pointerId !== pointerId || pan.target !== "plot" || pan.dragging || pan.wheeled || !finger) return;
    host.timeViewport.endPlotPan();
    gestures.pan = null;
    gestures.inspect = { pointerId };
    moveInspect(finger.x, finger.y);
  };

  const endInspect = (pointerId: number): void => {
    if (gestures.clearInspect(pointerId)) hideCrosshair();
  };

  const startPinch = (firstId: number, secondId: number): void => {
    const first = touches.get(firstId);
    const second = touches.get(secondId);
    if (!first || !second) return;
    cancelLongPress();
    endActiveGesture(firstId, true);
    if (crosshair.visible) hideCrosshair();
    gestures.pinch = { firstId, secondId, last: pinchSample(first.x, first.y, second.x, second.y) };
    canvas.setPointerCapture(secondId);
  };

  /** The fingers' midpoint drags the chart and their spread zooms it around that midpoint. */
  const stepPinch = (): void => {
    const pinch = gestures.pinch;
    const first = pinch && touches.get(pinch.firstId);
    const second = pinch && touches.get(pinch.secondId);
    if (!pinch || !first || !second) return;
    const next = pinchSample(first.x, first.y, second.x, second.y);
    const step = pinchStep(pinch.last, next);
    pinch.last = next;
    if (!step) return;
    view.panX(step.dMidX);
    if (!view.isPriceAutoScale()) view.priceTop += step.dMidY * view.pricePerPx;
    host.timeViewport.applyWheelZoom(step.factor, next.midX, host.pipeline.series.length);
    applyHorizontalViewportChange();
  };

  /** The finger left down after a pinch carries on as a plain plot pan. */
  const resumePan = (pointerId: number): void => {
    const finger = touches.get(pointerId);
    if (!finger || gestures.pan) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = finger.x + rect.left;
    const clientY = finger.y + rect.top;
    if (interactionPolicy.scroll.plotPressedMouseMove) host.timeViewport.beginPlotPan();
    gestures.pan = {
      x: clientX,
      y: clientY,
      startX: clientX,
      startY: clientY,
      wheeled: false,
      priceTop: view.priceTop,
      pricePerPx: view.pricePerPx,
      target: "plot",
      pointerId,
    };
  };

  /**
   * A second finger on a plot pan turns it into a pinch; against any other gesture the extra
   * finger is ignored. Returns true when the pointer-down was consumed.
   */
  const onExtraFinger = (e: PointerEvent): boolean => {
    const pan = gestures.pan;
    if (gestures.pinch || gestures.inspect || gestures.menuPress || gestures.drawingActive || gestures.indicatorScale) return true;
    // Fingers already down hold no gesture (a replay pick, say): this one starts its own.
    if (!pan) return false;
    if (pan.target === "plot") startPinch(pan.pointerId, e.pointerId);
    return true;
  };

  /** Registers a finger that just landed; true when it was an extra finger the gestures in progress consume. */
  const trackTouchDown = (e: PointerEvent): boolean => {
    const rect = canvas.getBoundingClientRect();
    // With no gesture in progress, fingers still on record are stale (a lift the canvas never saw).
    if (!gestureInProgress()) touches.clear();
    touches.down(e.pointerId, e.clientX - rect.left, e.clientY - rect.top);
    lastTouchDownAt = nowMs();
    setTouchMode(true);
    return touches.size > 1 && onExtraFinger(e);
  };

  /** Ends the touch-only gesture a lifted or cancelled finger belonged to; true when it owned one. */
  const endTouchGesture = (e: PointerEvent, cancelled: boolean): boolean => {
    const pointerId = e.pointerId;
    const pinch = gestures.pinch;
    if (pinch && (pinch.firstId === pointerId || pinch.secondId === pointerId)) {
      const remaining = pinch.firstId === pointerId ? pinch.secondId : pinch.firstId;
      const stillDown = touches.has(remaining);
      gestures.clearPinch(stillDown ? remaining : undefined);
      if (stillDown) resumePan(remaining);
      return true;
    }
    if (gestures.inspect?.pointerId === pointerId) {
      endInspect(pointerId);
      return true;
    }
    const press = gestures.clearMenuPress(pointerId);
    if (press) {
      if (!cancelled) openMenuFromButton(e, press);
      return true;
    }
    return false;
  };

  /** A tap on the corner "⋯" button opens the same menu a right click would, anchored under the button. */
  const openMenuFromButton = (release: PointerEvent, press: { startX: number; startY: number }): void => {
    if (movedBeyondSlop(release.clientX - press.startX, release.clientY - press.startY, TOUCH_CLICK_SLOP_PX)) return;
    const rect = canvas.getBoundingClientRect();
    if (!host.overlay.getMenuButtonAt(release.clientX - rect.left, release.clientY - rect.top)) return;
    const button = host.overlay.getMenuButtonRect();
    if (!button) return;
    openContextMenu(
      button.x + button.w / 2,
      button.y + button.h / 2,
      rect.left + button.x,
      rect.top + button.y + button.h + 4,
      true,
    );
  };

  /** The native contextmenu a long press fires: the touch UI has the crosshair and the "⋯" button instead. */
  const isTouchContextMenu = (e: MouseEvent): boolean =>
    (e as PointerEvent).pointerType === "touch" || nowMs() - lastTouchDownAt < TOUCH_CONTEXT_MENU_WINDOW_MS;

  // --- Drawings -------------------------------------------------------------------------------

  /** Hands a press to the drawing tools; true when DrawingManager took it (placing, editing or dragging). */
  const pressDrawing = (e: PointerEvent, cx: number, cy: number, capture: boolean): boolean => {
    const drawings = host.svc.getAnalysisContext().drawings;
    syncTransientMagnet(e);
    drawings.setMarket(host.state.market);
    const point = host.screenToDrawingPoint(cx, cy, shouldUseTemporaryDrawingMagnet(drawings.activeTool, e));
    if (!drawings.pointerDown(point, { x: cx, y: cy }, { additive: e.shiftKey || e.ctrlKey || e.metaKey, touch: isTouchPointer(e) })) return false;
    gestures.acceptedDrawingPointerId = e.pointerId;
    gestures.drawingActive = drawings.isPointerDragActive();
    if (gestures.drawingActive && capture) canvas.setPointerCapture(e.pointerId);
    session.invalidate();
    return true;
  };

  const releaseDrawing = (e: PointerEvent): void => {
    const drawings = host.svc.getAnalysisContext().drawings;
    gestures.acceptedDrawingPointerId = null;
    // Multi-point tools use click-to-place anchors: pointer release only
    // completes drag-native gestures (brush/editing), never a 2nd/3rd anchor.
    if (!drawings.hasDraft() || drawings.activeTool === "brush") drawings.pointerUp();
    gestures.drawingActive = false;
    syncTransientMagnet(e);
    gestures.releasePointer(e.pointerId);
    canvas.style.cursor = "default";
    session.invalidate();
  };

  /**
   * Touch: a press that would place or select a drawing waits for the release, so dragging still pans
   * the chart and a second finger can still pinch. Drag-native tools (brush) and the drawings already
   * selected take the press at once, as with a mouse.
   */
  const defersDrawingPress = (cx: number, cy: number): boolean => {
    const drawings = host.svc.getAnalysisContext().drawings;
    if (drawings.activeTool !== null || drawings.hasDraft()) return drawings.activeTool !== "brush";
    drawings.setMarket(host.state.market);
    const hit = drawings.peekAt(host.screenToDrawingPoint(cx, cy), { x: cx, y: cy }, { touch: true });
    return hit !== null && !hit.selected;
  };

  const tapDrawing = (release: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    if (pressDrawing(release, release.clientX - rect.left, release.clientY - rect.top, false)) releaseDrawing(release);
  };

  const onPointerDown = (e: PointerEvent) => {
    const touch = isTouchPointer(e);
    if (touch) {
      if (trackTouchDown(e)) return;
    } else if (crosshair.touch) {
      setTouchMode(false);
    }
    if (e.button !== 0) return;
    if (ownedByOtherPointer(e.pointerId)) return;
    canvas.focus({ preventScroll: true });
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (touch && host.overlay.getMenuButtonAt(cx, cy)) {
      gestures.menuPress = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const indicatorPaneId = host.overlay.getIndicatorAxisPaneAt(cx, cy);
    if (indicatorPaneId) {
      gestures.indicatorScale = { paneId: indicatorPaneId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastY: e.clientY };
      canvas.style.cursor = "ns-resize";
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const target = hitTestChartAxis(view, cx, cy, touch ? TOUCH_AXIS_HIT : undefined);
    if (target === "plot" && host.isReplaySelecting()) {
      host.selectReplayStart(host.screenToDrawingPoint(cx, cy).time);
      canvas.style.cursor = "default";
      return;
    }
    let tap: ChartPanGesture["tap"];
    if (target === "plot") {
      if (touch && defersDrawingPress(cx, cy)) tap = tapDrawing;
      else if (pressDrawing(e, cx, cy, true)) return;
    }
    canvas.style.cursor = cursorForTarget(target);
    if (target === "price-axis" && interactionPolicy.scale.axisPressedMouseMove.price) {
      view.startPriceAxisScale(cy);
    } else if (target === "time-axis" && interactionPolicy.scale.axisPressedMouseMove.time) {
      host.timeViewport.beginTimeAxisScale(cx);
    } else if (target === "plot" && interactionPolicy.scroll.plotPressedMouseMove) {
      host.timeViewport.beginPlotPan();
    }
    gestures.pan = {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      wheeled: false,
      priceTop: view.priceTop,
      pricePerPx: view.pricePerPx,
      target,
      pointerId: e.pointerId,
      tap,
    };
    canvas.setPointerCapture(e.pointerId);
    if (touch && target === "plot") armLongPress(e.pointerId);
  };

  const onPointerDrag = (e: PointerEvent) => {
    if (gestures.indicatorScale) {
      if (gestures.indicatorScale.pointerId !== e.pointerId) return;
      const dy = e.clientY - gestures.indicatorScale.lastY;
      gestures.indicatorScale.lastY = e.clientY;
      host.scaleIndicatorPane(gestures.indicatorScale.paneId, Math.exp(dy * 0.01));
      session.invalidate(ChartChange.Viewport);
      return;
    }
    if (!gestures.pan || gestures.pan.pointerId !== e.pointerId) return;
    if (isTouchPointer(e) && !gestures.pan.dragging) {
      // A finger is never perfectly still: nothing moves until it has clearly left the spot it landed on.
      if (!movedBeyondSlop(e.clientX - gestures.pan.startX, e.clientY - gestures.pan.startY, TOUCH_CLICK_SLOP_PX)) return;
      gestures.pan.dragging = true;
      cancelLongPress(e.pointerId);
    }
    const dx = e.clientX - gestures.pan.x;
    const dy = e.clientY - gestures.pan.y;

    if (gestures.pan.target === "price-axis") {
      const rect = canvas.getBoundingClientRect();
      const currentLocalY = e.clientY - rect.top;
      view.scalePriceAxisTo(currentLocalY);
      session.invalidate(ChartChange.Viewport);
      return;
    }

    if (gestures.pan.target === "time-axis") {
      const rect = canvas.getBoundingClientRect();
      const currentLocalX = e.clientX - rect.left;
      host.timeViewport.dragTimeAxisScaleTo(currentLocalX, host.pipeline.series.length);
      applyHorizontalViewportChange();
      return;
    }

    if (gestures.pan.target === "corner-axis") {
      session.invalidate();
      return;
    }

    host.timeViewport.dragPlotPanTo(dx, host.pipeline.series.length);
    applyHorizontalViewportChange();
    if (!view.isPriceAutoScale()) {
      view.priceTop = gestures.pan.priceTop + dy * gestures.pan.pricePerPx;
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (isTouchPointer(e)) {
      touches.up(e.pointerId);
      cancelLongPress(e.pointerId);
      if (endTouchGesture(e, false)) return;
    }
    if (gestures.acceptedDrawingPointerId === e.pointerId) {
      releaseDrawing(e);
      return;
    }
    if (gestures.indicatorScale) {
      if (gestures.indicatorScale.pointerId !== e.pointerId) return;
      const drag = gestures.indicatorScale;
      gestures.indicatorScale = null;
      gestures.releasePointer(e.pointerId);
      canvas.style.cursor = "default";
      const wasDragging = movedBeyondSlop(e.clientX - drag.startX, e.clientY - drag.startY, clickSlopPx(e));
      if (!wasDragging) {
        const rect = canvas.getBoundingClientRect();
        const control = host.overlay.getIndicatorScaleControlAt(e.clientX - rect.left, e.clientY - rect.top);
        if (control?.id === "autoScale") host.resetIndicatorPaneScale(control.paneId);
        if (control?.id === "logarithmic") host.toggleIndicatorScaleModeFromControl(control.paneId);
      }
      return;
    }
    if (!gestures.pan || gestures.pan.pointerId !== e.pointerId) return;
    const wasDragging = gestures.pan.wheeled
      || gestures.pan.dragging === true
      || movedBeyondSlop(e.clientX - gestures.pan.startX, e.clientY - gestures.pan.startY, clickSlopPx(e));
    const tap = gestures.pan.tap;
    endActiveGesture(e.pointerId);

    if (!wasDragging) {
      if (tap) {
        tap(e);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const control = host.overlay.getPriceScaleControlAt(cx, cy);
      const indicatorControl = host.overlay.getIndicatorScaleControlAt(cx, cy);
      if (indicatorControl) {
        if (indicatorControl.id === "autoScale") {
          host.resetIndicatorPaneScale(indicatorControl.paneId);
        } else {
          host.toggleIndicatorScaleModeFromControl(indicatorControl.paneId);
        }
        return;
      }
      if (control === "autoScale") {
        host.setPriceAutoScaleFromControl(!view.isPriceAutoScale());
        return;
      }
      if (control === "logarithmic") {
        host.togglePriceScaleModeFromControl();
        return;
      }
    }
  };

  const cancelDrawingPointer = (pointerId: number): void => {
    if (gestures.acceptedDrawingPointerId !== pointerId) return;
    const activeDrawings = host.svc.getAnalysisContext().drawings;
    gestures.acceptedDrawingPointerId = null;
    if (activeDrawings.hasDraft()) activeDrawings.cancelDraft();
    else activeDrawings.pointerUp();
    gestures.drawingActive = false;
  };

  const dropTouchPointer = (e: PointerEvent): void => {
    if (!isTouchPointer(e)) return;
    touches.up(e.pointerId);
    cancelLongPress(e.pointerId);
    endTouchGesture(e, true);
  };

  const onPointerCancel = (e: PointerEvent) => {
    clearTransientMagnet();
    dropTouchPointer(e);
    if (gestures.indicatorScale?.pointerId === e.pointerId) gestures.indicatorScale = null;
    cancelDrawingPointer(e.pointerId);
    endActiveGesture(e.pointerId);
    crosshair.visible = false;
    session.invalidate();
  };

  const onLostPointerCapture = (e: PointerEvent) => {
    clearTransientMagnet();
    dropTouchPointer(e);
    if (gestures.indicatorScale?.pointerId === e.pointerId) gestures.indicatorScale = null;
    cancelDrawingPointer(e.pointerId);
    endActiveGesture(e.pointerId);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (!keyboardContextMenu && isTouchContextMenu(e)) return;
    const activeDrawings = host.svc.getAnalysisContext().drawings;
    if (gestures.acceptedDrawingPointerId !== null) {
      const pointerId = gestures.acceptedDrawingPointerId;
      gestures.acceptedDrawingPointerId = null;
      if (activeDrawings.hasDraft()) activeDrawings.cancelDraft();
      else activeDrawings.pointerUp();
      gestures.releasePointer(pointerId);
    }
    if (activeDrawings.hasDraft()) activeDrawings.cancelDraft();
    gestures.drawingActive = false;
    endActiveGesture();
    const rect = canvas.getBoundingClientRect();
    openContextMenu(e.clientX - rect.left, e.clientY - rect.top, e.clientX, e.clientY);
  };

  /** `fromMenuButton`: the touch "⋯" button has no pointer position to hit-test, so it acts on the selected drawings. */
  const openContextMenu = (localX: number, localY: number, clientX: number, clientY: number, fromMenuButton = false): void => {
    const target = hitTestChartAxis(view, localX, localY);
    const indicatorAxisPaneId = host.overlay.getIndicatorAxisPaneAt(localX, localY);
    const indicatorPaneId = indicatorAxisPaneId ?? host.overlay.getIndicatorPaneAt(localX, localY);
    if (!indicatorPaneId && !canUseContextMenu(interactionPolicy, target)) return;
    const drawings = host.svc.getAnalysisContext().drawings;
    let drawingHit = false;
    if (target === "plot") {
      drawings.setMarket(host.state.market);
      drawingHit = fromMenuButton
        ? drawings.getSelectedIds().length > 0
        : drawings.hitTestAt(host.screenToDrawingPoint(localX, localY), { x: localX, y: localY }) !== null;
      session.invalidate();
    }
    const detail: ChartContextMenuDetail = {
      target,
      x: localX,
      y: localY,
      clientX,
      clientY,
      panelId: host.panelId,
      market: host.state.market,
      timeframe: host.state.timeframe,
      linkGroup: host.state.linkGroup ?? null,
      drawingSelectionCount: drawingHit ? drawings.getSelectedIds().length : 0,
      tpoProfile: target === "plot" ? host.overlay.getTpoProfileAt(localX, localY) : null,
      indicatorPaneId,
      indicatorAxis: indicatorAxisPaneId !== null,
      paneFocus: target === "plot" ? {
        hasIndicatorPanes: host.hasIndicatorPanes(),
        indicatorsHidden: host.isChartPaneMaximized(),
        panel: requestChartPanelMaximize(canvas, "query"),
      } : null,
    };
    const ContextMenuEvent = canvas.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
    canvas.dispatchEvent(new ContextMenuEvent("chartcontextmenu", {
      bubbles: true,
      cancelable: true,
      detail,
    }));
  };

  const onContextMenuKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.target !== canvas) return;
    if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const MouseEventCtor = canvas.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
    keyboardContextMenu = true;
    try {
      canvas.dispatchEvent(new MouseEventCtor("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.max(1, rect.width / 2),
        clientY: rect.top + Math.max(1, rect.height / 2),
      }));
    } finally {
      keyboardContextMenu = false;
    }
  };

  const onOverlayAction = (event: Event): void => {
    const detail = (event as CustomEvent<ChartOverlayActionEventDetail>).detail;
    if (!detail || !("action" in detail)) return;
    executeChartAction(detail.action, host, host.svc);
  };

  const onHelpKeyDown = (e: KeyboardEvent): void => {
    if (!interactionPolicy.helpOverlay.enabled || !interactionPolicy.helpOverlay.keyboardShortcut) return;
    if (e.defaultPrevented || e.target !== canvas) return;
    const target = e.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (!(e.key === "?" || (e.shiftKey && e.key === "/"))) return;
    e.preventDefault();
    const HelpEvent = canvas.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
    canvas.dispatchEvent(new HelpEvent("charthelp", {
      bubbles: true,
      cancelable: true,
      detail: { panelId: host.panelId },
    }));
  };

  const onDrawingKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Control" || e.key === "Meta") syncTransientMagnet(e);
  };

  const onWindowBlur = (): void => clearTransientMagnet();
  const onVisibilityChange = (): void => {
    if (ownerWindow?.document.visibilityState === "hidden") clearTransientMagnet();
  };

  /**
   * Every chart in a window listens on that window, but the drawing store is shared, so
   * a shortcut must run once: in the chart the key event came from, else the active chart.
   */
  const ownsWindowShortcut = (e: KeyboardEvent): boolean => {
    const target = e.target;
    if (target instanceof Node && canvas.parentElement?.contains(target)) return true;
    if (target instanceof Element && target.closest(".chart-interaction-canvas")) return false;
    const owner = host.svc.getKeyboardTargetChartId?.();
    return owner === undefined || owner === host.panelId;
  };

  const onDrawingKeyDown = (e: KeyboardEvent) => {
    syncTransientMagnet(e);
    const target = e.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (!ownsWindowShortcut(e)) return;
    const drawings = host.svc.getAnalysisContext().drawings;
    if (e.key === "Delete" || e.key === "Backspace") {
      drawings.deleteSelected();
      session.invalidate();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "a") {
      drawings.selectMany(drawings.listCurrent().filter((drawing) => drawing.visible).map((drawing) => drawing.id));
      session.invalidate();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "d") {
      drawings.duplicateSelected();
      session.invalidate();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "c") {
      drawings.copySelected();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "v") {
      drawings.pasteClipboard();
      session.invalidate();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      drawings.undo();
      session.invalidate();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
      drawings.redo();
      session.invalidate();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && drawings.activeTool !== null) {
      drawings.setTool(null);
      session.invalidate();
      e.preventDefault();
    }
    if (e.key === "Escape" && !e.defaultPrevented && requestChartPanelMaximize(canvas, "query").maximized) {
      requestChartPanelMaximize(canvas, "exit");
      e.preventDefault();
    }
    if (e.key.toLowerCase() === "x" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      host.resetTimeScale();
      session.invalidate(ChartChange.Viewport);
      e.preventDefault();
    }
  };

  const onDblClick = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const indicatorPaneId = host.overlay.getIndicatorAxisPaneAt(cx, cy);
    if (indicatorPaneId) {
      host.resetIndicatorPaneScale(indicatorPaneId);
      return;
    }
    const target = hitTestChartAxis(view, cx, cy);

    if (target === "time-axis" && interactionPolicy.scale.axisDoubleClickReset.time) {
      host.resetTimeScale();
      return;
    }

    if (target === "price-axis" && interactionPolicy.scale.axisDoubleClickReset.price) {
      host.resetPriceScale();
      return;
    }

    if (target === "plot") {
      const drawings = host.svc.getAnalysisContext().drawings;
      drawings.setMarket(host.state.market);
      drawings.setHitTestContext(view, {
        indexForTime: (time: number) => host.pipeline.series.indexOfTime(time),
        timeForIndex: (index: number) => host.pipeline.series.timeOfIndex(Math.round(index)),
      });
      const hit = drawings.hitTestAt(host.screenToDrawingPoint(cx, cy), { x: cx, y: cy });
      if (hit?.type === "text" || hit?.type === "callout-note") {
        drawings.requestText(hit.id);
        session.invalidate();
        return;
      }
      if (hit) {
        drawings.requestSettings(hit.id);
        session.invalidate();
        return;
      }
      host.togglePaneMaximizeAt(cy);
      return;
    }

    const plotRight = view.area.left + view.area.width;
    const panesBottom = view.area.top + view.area.height + view.subPanesH;
    if (cx >= view.area.left && cx < plotRight && cy >= view.area.top + view.area.height && cy < panesBottom) {
      host.togglePaneMaximizeAt(cy);
      return;
    }

    if (target === "corner-axis" && interactionPolicy.scale.axisDoubleClickReset.cornerBoth) {
      host.resetAllScales();
    }
  };

  /** A finger moves one gesture at a time (pinch, inspect, drawing drag, pan) and never shows a hover crosshair. */
  const onTouchMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    touches.move(e.pointerId, cx, cy);
    if (gestures.pinch) {
      if (e.pointerId === gestures.pinch.firstId || e.pointerId === gestures.pinch.secondId) stepPinch();
      return;
    }
    if (gestures.inspect) {
      if (gestures.inspect.pointerId === e.pointerId) moveInspect(cx, cy);
      return;
    }
    if (gestures.menuPress) return;
    if (gestures.drawingActive) {
      if (gestures.acceptedDrawingPointerId === e.pointerId) moveDrawing(e, cx, cy);
      return;
    }
    if (gestures.pan || gestures.indicatorScale) onPointerDrag(e);
  };

  const onPointerMoveMain = (e: PointerEvent) => {
    if (isTouchPointer(e)) {
      onTouchMove(e);
      return;
    }
    if (crosshair.touch) setTouchMode(false);
    onPointerMove(e);
    if (host.isReplaySelecting()) {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const target = hitTestChartAxis(view, cx, cy);
      host.previewReplayStart(target === "plot" ? host.screenToDrawingPoint(cx, cy).time : null);
      canvas.style.cursor = target === "plot" ? "crosshair" : cursorForTarget(target);
      return;
    }
    if (gestures.drawingActive) return;
    updateAxisCursor(e);
    if (gestures.pan || gestures.indicatorScale) onPointerDrag(e);
  };

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointermove", onPointerMoveMain);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture);
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("dblclick", onDblClick);
  canvas.addEventListener(CHART_OVERLAY_ACTION_EVENT, onOverlayAction as EventListener);
  canvas.addEventListener("keydown", onHelpKeyDown);
  canvas.addEventListener("keydown", onContextMenuKeyDown);
  ownerWindow?.addEventListener("pointerup", onPointerUp);
  ownerWindow?.addEventListener("keydown", onDrawingKeyDown);
  ownerWindow?.addEventListener("keyup", onDrawingKeyUp);
  ownerWindow?.addEventListener("blur", onWindowBlur);
  ownerWindow?.document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    clearTransientMagnet();
    cancelLongPress();
    if (gestures.inspect) crosshair.visible = false;
    touches.clear();
    if (gestures.acceptedDrawingPointerId !== null) {
      const activeDrawings = host.svc.getAnalysisContext().drawings;
      const pointerId = gestures.acceptedDrawingPointerId;
      gestures.acceptedDrawingPointerId = null;
      if (activeDrawings.hasDraft()) activeDrawings.cancelDraft();
      else activeDrawings.pointerUp();
      gestures.drawingActive = false;
      gestures.releasePointer(pointerId);
    }
    endActiveGesture();
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointermove", onPointerMoveMain);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("dblclick", onDblClick);
    canvas.removeEventListener(CHART_OVERLAY_ACTION_EVENT, onOverlayAction as EventListener);
    canvas.removeEventListener("keydown", onHelpKeyDown);
    canvas.removeEventListener("keydown", onContextMenuKeyDown);
    ownerWindow?.removeEventListener("pointerup", onPointerUp);
    ownerWindow?.removeEventListener("keydown", onDrawingKeyDown);
    ownerWindow?.removeEventListener("keyup", onDrawingKeyUp);
    ownerWindow?.removeEventListener("blur", onWindowBlur);
    ownerWindow?.document.removeEventListener("visibilitychange", onVisibilityChange);
    gestures.reset();
  };
}
