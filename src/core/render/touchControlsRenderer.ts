import type { View } from "../engine/view.js";
import { uiColor } from "../ui/seriesPalette.js";

/** Visible size of the corner menu button; a fingertip needs well over the 18px of a cursor button. */
export const TOUCH_MENU_BUTTON_SIZE = 36;
/** Extra pixels around a touch control that still count as a hit. */
export const TOUCH_CONTROL_HIT_SLOP = 4;
/** A plot smaller than this has no room for the corner menu button. */
const MENU_BUTTON_MIN_PLOT_WIDTH = 160;
const MENU_BUTTON_MIN_PLOT_HEIGHT = 120;
/** Below the HUD pill, which owns the top row of the plot. */
const MENU_BUTTON_TOP_OFFSET = 30;
const MENU_BUTTON_EDGE_OFFSET = 8;

export interface TouchMenuButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The "⋯" button in the plot's top-right corner, or null when the plot is too small for it. */
export function touchMenuButtonRect(view: View): TouchMenuButtonRect | null {
  const { left, top, width, height } = view.area;
  if (width < MENU_BUTTON_MIN_PLOT_WIDTH || height < MENU_BUTTON_MIN_PLOT_HEIGHT) return null;
  const size = TOUCH_MENU_BUTTON_SIZE;
  return { x: left + width - size - MENU_BUTTON_EDGE_OFFSET, y: top + MENU_BUTTON_TOP_OFFSET, w: size, h: size };
}

export function pointInTouchControl(rect: TouchMenuButtonRect, x: number, y: number, slop = TOUCH_CONTROL_HIT_SLOP): boolean {
  return x >= rect.x - slop && x <= rect.x + rect.w + slop && y >= rect.y - slop && y <= rect.y + rect.h + slop;
}

export function drawTouchMenuButton(ctx: CanvasRenderingContext2D, rect: TouchMenuButtonRect): void {
  ctx.save();
  ctx.fillStyle = "rgba(15, 22, 34, 0.82)";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.32)";
  ctx.lineWidth = 1;
  if (typeof ctx.roundRect === "function" && typeof ctx.fill === "function") {
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1), 7.5);
    ctx.stroke();
  } else {
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }
  ctx.fillStyle = uiColor.textHeading;
  const cy = rect.y + rect.h / 2;
  for (const dx of [-8, 0, 8]) {
    ctx.beginPath();
    ctx.arc(rect.x + rect.w / 2 + dx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
