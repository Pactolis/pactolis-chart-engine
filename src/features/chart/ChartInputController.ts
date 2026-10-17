/**
 * ChartInputController — per-panel mouse/keyboard input layer (TASK-036).
 *
 * DOM event wiring and gesture state live here. Command behaviour is owned by
 * chartCommands.ts so context menus, palette commands and input routes cannot
 * drift into separate implementations.
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
import { ChartGestureController } from "./ChartGestureController.js";
import { requestChartPanelMaximize } from "./chartPanelFocus.js";
export { isDrawingMagnetTransientActive } from "./drawingInteractionState.js";

/** Internal owner-document route from WindowOverlayRoot back to the originating canvas. */
export const CHART_OVERLAY_ACTION_EVENT = "footprint-internal-chart-overlay-action";
export interface ChartOverlayActionEventDetail {
  action: ChartContextMenuAction;
}

const IS_CHROMIUM_WINDOWS = typeof navigator !== "undefined"
  && /Windows/.test(navigator.userAgent)
  && /Chrome\//.test(navigator.userAgent);

/** Chromium on Windows scales wheel pixel deltas by devicePixelRatio; undo that. */
function wheelDeltaScale(): number {
  if (!IS_CHROMIUM_WINDOWS || typeof window === "undefined") return 1;
  return 1 / (window.devicePixelRatio || 1);
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
  let transientMagnetActive = false;
  const transientMagnetSource = {};

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

  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const drawings = host.svc.getAnalysisContext().drawings;
    if (gestures.drawingActive || drawings.hasDraft()) {
      syncTransientMagnet(e);
      drawings.setMarket(host.state.market);
      drawings.pointerMove(host.screenToDrawingPoint(cx, cy, shouldUseTemporaryDrawingMagnet(drawings.activeTool, e)));
      session.invalidate();
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

  const endActiveGesture = (pointerId?: number): void => {
    if (!gestures.pan) return;
    if (pointerId !== undefined && gestures.pan.pointerId !== pointerId) return;
    const target = gestures.pan.target;
    const capturedPointerId = gestures.pan.pointerId;
    if (target === "price-axis") view.endPriceAxisScale();
    if (target === "time-axis") host.timeViewport.endTimeAxisScale();
    if (target === "plot") host.timeViewport.endPlotPan();
    gestures.pan = null;
    gestures.releasePointer(pointerId ?? capturedPointerId);
    canvas.style.cursor = "default";
  };

  /** One pointer drives a gesture at a time; a second finger must not take over or end it. */
  const ownedByOtherPointer = (pointerId: number): boolean =>
    (gestures.pan !== null && gestures.pan.pointerId !== pointerId)
    || (gestures.indicatorScale !== null && gestures.indicatorScale.pointerId !== pointerId)
    || (gestures.drawingActive && gestures.acceptedDrawingPointerId !== null && gestures.acceptedDrawingPointerId !== pointerId);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (ownedByOtherPointer(e.pointerId)) return;
    canvas.focus({ preventScroll: true });
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const indicatorPaneId = host.overlay.getIndicatorAxisPaneAt(cx, cy);
    if (indicatorPaneId) {
      gestures.indicatorScale = { paneId: indicatorPaneId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastY: e.clientY };
      canvas.style.cursor = "ns-resize";
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const target = hitTestChartAxis(view, cx, cy);
    if (target === "plot" && host.isReplaySelecting()) {
      host.selectReplayStart(host.screenToDrawingPoint(cx, cy).time);
      canvas.style.cursor = "default";
      return;
    }
    if (target === "plot") {
      const drawings = host.svc.getAnalysisContext().drawings;
      syncTransientMagnet(e);
      drawings.setMarket(host.state.market);
      if (drawings.pointerDown(host.screenToDrawingPoint(cx, cy, shouldUseTemporaryDrawingMagnet(drawings.activeTool, e)), { x: cx, y: cy }, { additive: e.shiftKey || e.ctrlKey || e.metaKey })) {
        gestures.acceptedDrawingPointerId = e.pointerId;
        gestures.drawingActive = drawings.isPointerDragActive();
        if (gestures.drawingActive) canvas.setPointerCapture(e.pointerId);
        session.invalidate();
        return;
      }
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
    };
    canvas.setPointerCapture(e.pointerId);
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
    if (gestures.acceptedDrawingPointerId === e.pointerId) {
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
      return;
    }
    if (gestures.indicatorScale) {
      if (gestures.indicatorScale.pointerId !== e.pointerId) return;
      const drag = gestures.indicatorScale;
      gestures.indicatorScale = null;
      gestures.releasePointer(e.pointerId);
      canvas.style.cursor = "default";
      const wasDragging = Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3;
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
      || Math.abs(e.clientX - gestures.pan.startX) > 3
      || Math.abs(e.clientY - gestures.pan.startY) > 3;
    endActiveGesture(e.pointerId);

    if (!wasDragging) {
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

  const onPointerCancel = (e: PointerEvent) => {
    clearTransientMagnet();
    if (gestures.indicatorScale?.pointerId === e.pointerId) gestures.indicatorScale = null;
    cancelDrawingPointer(e.pointerId);
    endActiveGesture(e.pointerId);
    crosshair.visible = false;
    session.invalidate();
  };

  const onLostPointerCapture = (e: PointerEvent) => {
    clearTransientMagnet();
    if (gestures.indicatorScale?.pointerId === e.pointerId) gestures.indicatorScale = null;
    cancelDrawingPointer(e.pointerId);
    endActiveGesture(e.pointerId);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
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
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const target = hitTestChartAxis(view, localX, localY);
    const indicatorAxisPaneId = host.overlay.getIndicatorAxisPaneAt(localX, localY);
    const indicatorPaneId = indicatorAxisPaneId ?? host.overlay.getIndicatorPaneAt(localX, localY);
    if (!indicatorPaneId && !canUseContextMenu(interactionPolicy, target)) return;
    const drawings = host.svc.getAnalysisContext().drawings;
    let drawingHit = false;
    if (target === "plot") {
      drawings.setMarket(host.state.market);
      drawingHit = drawings.hitTestAt(host.screenToDrawingPoint(localX, localY), { x: localX, y: localY }) !== null;
      session.invalidate();
    }
    const detail: ChartContextMenuDetail = {
      target,
      x: localX,
      y: localY,
      clientX: e.clientX,
      clientY: e.clientY,
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
    canvas.dispatchEvent(new MouseEventCtor("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2),
    }));
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

  const onPointerMoveMain = (e: PointerEvent) => {
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
