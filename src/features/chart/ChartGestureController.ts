import type { ChartAxisTarget } from "./axisInteraction.js";
import type { PinchSample } from "./touchGestures.js";

export interface ChartPanGesture {
  /** Drag reference point; rebased after a wheel step so drag deltas continue from the new viewport. */
  x: number;
  y: number;
  /** Pointer-down position; never rebased, so click detection on release stays honest. */
  readonly startX: number;
  readonly startY: number;
  /** A wheel step landed during this press, so its release is never a click. */
  wheeled: boolean;
  priceTop: number;
  pricePerPx: number;
  target: ChartAxisTarget;
  pointerId: number;
  /** Touch only: the finger left the tap dead zone, so this press is a drag and can no longer be a tap. */
  dragging?: boolean;
  /** Touch only: runs on release when the press stayed a tap (no drag, no long press). */
  tap?: (release: PointerEvent) => void;
}

/** Two fingers on the plot: the pair zooms and pans the time axis together. */
export interface PinchGesture {
  readonly firstId: number;
  readonly secondId: number;
  last: PinchSample;
}

/** A long press in progress: the finger moves the crosshair instead of the chart. */
export interface InspectGesture {
  readonly pointerId: number;
}

/** A press that began on the touch corner menu button; it opens the menu when released on it. */
export interface MenuPressGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
}

export interface IndicatorScaleGesture {
  paneId: string;
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
}

/**
 * Owns mutable pointer/gesture bookkeeping for ChartInputController.
 * DOM event interpretation stays in the input adapter; ownership and cleanup do not.
 */
export class ChartGestureController {
  drawingActive = false;
  acceptedDrawingPointerId: number | null = null;
  pan: ChartPanGesture | null = null;
  indicatorScale: IndicatorScaleGesture | null = null;
  pinch: PinchGesture | null = null;
  inspect: InspectGesture | null = null;
  menuPress: MenuPressGesture | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  releasePointer(pointerId: number): void {
    if (!this.canvas.hasPointerCapture(pointerId)) return;
    try {
      this.canvas.releasePointerCapture(pointerId);
    } catch {
      // Browser cancellation/context-menu paths may already have released it.
    }
  }

  clearPan(pointerId?: number): ChartPanGesture | null {
    const current = this.pan;
    if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) return null;
    this.pan = null;
    this.releasePointer(current.pointerId);
    return current;
  }

  clearIndicatorScale(pointerId?: number): IndicatorScaleGesture | null {
    const current = this.indicatorScale;
    if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) return null;
    this.indicatorScale = null;
    this.releasePointer(current.pointerId);
    return current;
  }

  /** Ends the pinch and lets go of both fingers, except `keepPointerId` when it keeps driving another gesture. */
  clearPinch(keepPointerId?: number): PinchGesture | null {
    const current = this.pinch;
    if (!current) return null;
    this.pinch = null;
    for (const id of [current.firstId, current.secondId]) if (id !== keepPointerId) this.releasePointer(id);
    return current;
  }

  clearInspect(pointerId?: number): InspectGesture | null {
    const current = this.inspect;
    if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) return null;
    this.inspect = null;
    this.releasePointer(current.pointerId);
    return current;
  }

  clearMenuPress(pointerId?: number): MenuPressGesture | null {
    const current = this.menuPress;
    if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) return null;
    this.menuPress = null;
    this.releasePointer(current.pointerId);
    return current;
  }

  clearDrawing(pointerId?: number): boolean {
    if (this.acceptedDrawingPointerId === null) return false;
    if (pointerId !== undefined && this.acceptedDrawingPointerId !== pointerId) return false;
    const accepted = this.acceptedDrawingPointerId;
    this.acceptedDrawingPointerId = null;
    this.drawingActive = false;
    this.releasePointer(accepted);
    return true;
  }

  reset(): void {
    if (this.acceptedDrawingPointerId !== null) this.releasePointer(this.acceptedDrawingPointerId);
    if (this.pan) this.releasePointer(this.pan.pointerId);
    if (this.indicatorScale) this.releasePointer(this.indicatorScale.pointerId);
    this.clearPinch();
    this.clearInspect();
    this.clearMenuPress();
    this.acceptedDrawingPointerId = null;
    this.drawingActive = false;
    this.pan = null;
    this.indicatorScale = null;
  }
}
