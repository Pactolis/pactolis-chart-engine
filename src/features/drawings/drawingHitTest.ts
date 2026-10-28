import type { View } from "../../core/engine/view.js";
import type { Drawing, DrawingContext, DrawingPoint, PositionRiskSettings } from "../../core/drawingTypes.js";
import {
  annotationHitTest,
  brushHitTest,
  distance,
  ellipseHitTest,
  fibonacciHitTest,
  gannFanHitTest,
  gannGridHitTest,
  isAnnotationTool,
  isFibonacciTool,
  isMeasurementTool,
  isPositionTool,
  isZoneTool,
  measurementHitTest,
  parallelChannelHitTest,
  pitchforkHitTest,
  pointDistance,
  regressionChannelHitTest,
  screenPoint,
  segmentDistance,
  trendRenderLine,
  triangleHitTest,
  zoneRenderBox,
} from "./drawingPrimitives.js";

/** How far a pointer may be from a drawing's line and still pick it. */
export const DRAWING_HIT_TOLERANCE_PX = 7;
/** Same, for the entry/stop/target level lines of a position drawing. */
export const DRAWING_LEVEL_HIT_TOLERANCE_PX = 9;
/** Radius of the anchor handles drawn on a selected drawing. */
export const DRAWING_HANDLE_RADIUS_PX = 4;
/** A fingertip covers far more than a cursor tip, so touch picks wider and draws bigger handles. */
export const TOUCH_DRAWING_HIT_TOLERANCE_PX = 16;
export const TOUCH_DRAWING_LEVEL_HIT_TOLERANCE_PX = 18;
export const TOUCH_DRAWING_HANDLE_RADIUS_PX = 8;

/** The chart state a hit test reads: the last view and time mapping the manager was given. */
export interface DrawingHitContext {
  readonly view: View | null;
  readonly time: DrawingContext | null;
  readonly positionRisk: PositionRiskSettings;
  readonly touch: boolean;
}

type ScreenPoint = { x: number; y: number };

export function drawingHitTest(
  drawing: Drawing,
  point: DrawingPoint,
  screen: ScreenPoint | undefined,
  context: DrawingHitContext,
): boolean {
  const { view, time } = context;
  if (!screen || !view || !time || drawing.points.length < 2) {
    return drawing.points.some((item) => pointDistance(item, point) <= 1);
  }
  const a = screenPoint(drawing.points[0], view, time);
  const b = screenPoint(drawing.points[1], view, time);
  const p = screen;
  const tolerance = context.touch ? TOUCH_DRAWING_HIT_TOLERANCE_PX : DRAWING_HIT_TOLERANCE_PX;
  if (drawing.type === "horizontal") return Math.abs(p.y - a.y) <= tolerance;
  if (drawing.type === "horizontal-ray") {
    return Math.abs(p.y - a.y) <= tolerance && p.x >= Math.max(a.x, view.area.left) - tolerance;
  }
  if (drawing.type === "vertical") return Math.abs(p.x - a.x) <= tolerance;
  if (isAnnotationTool(drawing.type)) return annotationHitTest(drawing, a, b, p, view, tolerance);
  if (drawing.type === "trend" || drawing.type === "trend-ray" || drawing.type === "extended-trend") {
    const line = trendRenderLine(drawing, a, b, view);
    return segmentDistance(p, line.a, line.b) <= tolerance;
  }
  if (drawing.type === "partial-price-line") {
    const left = Math.min(a.x, b.x) - tolerance;
    const right = Math.max(a.x, b.x) + tolerance;
    return p.x >= left && p.x <= right && Math.abs(p.y - a.y) <= tolerance;
  }
  if (isFibonacciTool(drawing.type)) return fibonacciHitTest(drawing, a, b, p, view, time, tolerance);
  if (drawing.type === "parallel-channel") return parallelChannelHitTest(drawing, a, b, p, view, time, tolerance);
  if (drawing.type === "regression-channel") return regressionChannelHitTest(drawing, a, b, p, view, time, tolerance);
  if (drawing.type === "pitchfork") return pitchforkHitTest(drawing, a, b, p, view, time, tolerance);
  if (drawing.type === "gann-fan") return gannFanHitTest(drawing, a, b, p, view, tolerance);
  if (drawing.type === "gann-grid") return gannGridHitTest(drawing, a, b, p, view, tolerance);
  if (isMeasurementTool(drawing.type)) return measurementHitTest(drawing, a, b, p, view, time, tolerance, context.positionRisk);
  if (drawing.type === "ellipse") return ellipseHitTest(a, b, p, tolerance);
  if (drawing.type === "triangle") return triangleHitTest(a, b, p, tolerance);
  if (drawing.type === "brush") return brushHitTest(drawing, p, view, time, tolerance);
  if (isZoneTool(drawing.type)) {
    const box = zoneRenderBox(drawing, a, b, view);
    return p.x >= box.left - tolerance && p.x <= box.right + tolerance && p.y >= box.top - tolerance && p.y <= box.bottom + tolerance;
  }
  if (drawing.type === "text") {
    const width = Math.max(32, (drawing.text?.length ?? 3) * 8);
    return p.x >= a.x && p.x <= a.x + width && p.y >= a.y - 20 && p.y <= a.y + 6;
  }
  if (drawing.type === "anchored-vwap") return distance(p, a) <= tolerance;
  return distance(p, a) <= tolerance || distance(p, b) <= tolerance;
}

/** Which of a position drawing's three level lines the pointer is on, if any. */
export function positionLevelHitIndex(
  drawing: Drawing,
  point: DrawingPoint,
  screen: ScreenPoint | undefined,
  context: DrawingHitContext,
): number | null {
  if (!isPositionTool(drawing.type) || drawing.points.length < 3) return null;
  const { view, time } = context;
  if (!screen || !view || !time) {
    const distances = drawing.points.slice(0, 3).map((item) => pointDistance(item, point));
    const best = distances.reduce((bestIndex, value, index) => value < distances[bestIndex] ? index : bestIndex, 0);
    return distances[best] <= 1 ? best : null;
  }
  const anchors = [drawing.points[0], drawing.points[1], drawing.points[2]];
  const screenAnchors = anchors.map((item) => screenPoint(item, view, time));
  const left = Math.min(...screenAnchors.map((item) => item.x));
  const right = Math.max(...screenAnchors.map((item) => item.x));
  const tolerance = context.touch ? TOUCH_DRAWING_LEVEL_HIT_TOLERANCE_PX : DRAWING_LEVEL_HIT_TOLERANCE_PX;
  const minX = Math.max(view.area.left, left) - tolerance;
  const maxX = Math.min(view.area.left + view.area.width, right) + tolerance;
  if (screen.x < minX || screen.x > maxX) return null;
  let bestIndex: number | null = null;
  let bestDistance = tolerance + 1;
  for (let index = 0; index < screenAnchors.length; index++) {
    const distanceToLevel = Math.abs(screen.y - screenAnchors[index].y);
    if (distanceToLevel <= tolerance && distanceToLevel < bestDistance) {
      bestDistance = distanceToLevel;
      bestIndex = index;
    }
  }
  return bestIndex;
}
