/**
 * Touch input rules shared by the input layer, the drawing hit tests and the tests.
 *
 * Pure helpers only: gesture orchestration (what a pinch or a long press does to the
 * chart) stays in ChartInputController, which owns the DOM events and the host.
 */

/** A press that moves less than this is a click for a mouse or pen. */
export const MOUSE_CLICK_SLOP_PX = 3;
/** A fingertip is far less steady than a cursor, so a tap may wander this far. */
export const TOUCH_CLICK_SLOP_PX = 10;
/** A finger held still this long opens the crosshair instead of panning. */
export const LONG_PRESS_MS = 400;
/** Two fingers closer than this give a noisy zoom factor, so the pinch ignores them. */
export const PINCH_MIN_DISTANCE_PX = 24;
/** The time axis strip is thin; a touch may start its scale gesture this far above it. */
export const TIME_AXIS_TOUCH_SLOP_PX = 8;
/**
 * Browsers fire a native contextmenu for a long press, after a delay the user can stretch in the
 * system settings (Android goes up to 1.5s); one inside this window of a touch landing is the touch's.
 */
export const TOUCH_CONTEXT_MENU_WINDOW_MS = 2500;

export function isTouchPointer(e: { readonly pointerType?: string }): boolean {
  return e.pointerType === "touch";
}

/** Pointer types other than touch (mouse, pen and the empty type of synthetic events) keep the mouse slop. */
export function clickSlopPx(e: { readonly pointerType?: string }): number {
  return isTouchPointer(e) ? TOUCH_CLICK_SLOP_PX : MOUSE_CLICK_SLOP_PX;
}

export function movedBeyondSlop(dx: number, dy: number, slopPx: number): boolean {
  return Math.abs(dx) > slopPx || Math.abs(dy) > slopPx;
}

export interface PinchSample {
  readonly distance: number;
  readonly midX: number;
  readonly midY: number;
}

export function pinchSample(ax: number, ay: number, bx: number, by: number): PinchSample {
  return {
    distance: Math.hypot(bx - ax, by - ay),
    midX: (ax + bx) / 2,
    midY: (ay + by) / 2,
  };
}

export interface PinchStep {
  /** Zoom factor between the two samples: above 1 the fingers spread (zoom in). */
  readonly factor: number;
  /** Midpoint travel between the two samples, in pixels. */
  readonly dMidX: number;
  readonly dMidY: number;
}

/**
 * One pinch move. Null while either sample is too tight to read a factor from, so the
 * caller keeps tracking from the newest sample and the chart never jumps when the fingers
 * open up from touching.
 */
export function pinchStep(previous: PinchSample, next: PinchSample): PinchStep | null {
  if (previous.distance < PINCH_MIN_DISTANCE_PX || next.distance < PINCH_MIN_DISTANCE_PX) return null;
  return {
    factor: next.distance / previous.distance,
    dMidX: next.midX - previous.midX,
    dMidY: next.midY - previous.midY,
  };
}

export interface TouchPoint {
  x: number;
  y: number;
}

/** The fingers currently down on one canvas, in canvas-local pixels, in the order they landed. */
export class TouchPointers {
  private readonly points = new Map<number, TouchPoint>();

  get size(): number {
    return this.points.size;
  }

  has(pointerId: number): boolean {
    return this.points.has(pointerId);
  }

  get(pointerId: number): TouchPoint | undefined {
    return this.points.get(pointerId);
  }

  down(pointerId: number, x: number, y: number): void {
    this.points.set(pointerId, { x, y });
  }

  /** Records a move for a finger that is down; a move from any other pointer is ignored. */
  move(pointerId: number, x: number, y: number): void {
    const point = this.points.get(pointerId);
    if (!point) return;
    point.x = x;
    point.y = y;
  }

  up(pointerId: number): void {
    this.points.delete(pointerId);
  }

  /** The id of a finger other than `pointerId`, or null when it is the only one down. */
  otherThan(pointerId: number): number | null {
    for (const id of this.points.keys()) if (id !== pointerId) return id;
    return null;
  }

  clear(): void {
    this.points.clear();
  }
}
