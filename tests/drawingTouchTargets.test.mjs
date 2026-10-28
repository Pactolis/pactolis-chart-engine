import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POSITION_RISK_SETTINGS, DrawingManager } from "../dist/features/drawings/drawingManager.js";
import {
  DRAWING_HANDLE_RADIUS_PX,
  DRAWING_HIT_TOLERANCE_PX,
  DRAWING_LEVEL_HIT_TOLERANCE_PX,
  TOUCH_DRAWING_HANDLE_RADIUS_PX,
  TOUCH_DRAWING_HIT_TOLERANCE_PX,
  TOUCH_DRAWING_LEVEL_HIT_TOLERANCE_PX,
  drawingHitTest,
  positionLevelHitIndex,
} from "../dist/features/drawings/drawingHitTest.js";

// Same fixture geometry as drawingHitReference.test.mjs: screen(t, p) = { x: 8 * t + 4, y: 600 - p }.
const MARKET = "BINANCE_FUTURES:btcusdt";

const view = {
  area: { left: 0, top: 0, width: 800, height: 600 },
  colWidth: 8,
  offsetX: 0,
  priceTop: 600,
  pricePerPx: 1,
  xOfIndex(index) { return this.area.left + this.offsetX + index * this.colWidth; },
  yOfPrice(price) { return this.area.top + (this.priceTop - price) / this.pricePerPx; },
};
const timeCtx = { indexForTime: (t) => t, timeForIndex: (i) => i };

// A data-space point far from every anchor, so only the screen mapping can hit.
const FAR = { time: 5_000, price: 5_000 };

function drawing(type, points, extra = {}) {
  return {
    schemaVersion: 2,
    id: extra.id ?? type,
    type,
    points,
    color: "#ffffff",
    lineWidth: 1.5,
    locked: false,
    visible: true,
    market: MARKET,
    ...extra,
  };
}

function makeManager(drawings) {
  const manager = new DrawingManager(() => {});
  manager.replace(drawings);
  manager.setMarket(MARKET);
  manager.setHitTestContext(view, timeCtx);
  return manager;
}

// Trend line from screen (84, 500) to (484, 400): y = 500 - 0.25 * (x - 84), so 12px below its
// middle (284, 450) is ~11.6px from it, past a mouse tolerance of 7 and inside a touch's 16.
const trend = () => drawing("trend", [{ time: 10, price: 100 }, { time: 60, price: 200 }], { id: "line" });
const NEAR = { x: 284, y: 462 };
const AWAY = { x: 284, y: 475 };

test("touch tolerances are wider than the mouse's but still bounded", () => {
  assert.ok(TOUCH_DRAWING_HIT_TOLERANCE_PX > DRAWING_HIT_TOLERANCE_PX);
  assert.ok(TOUCH_DRAWING_LEVEL_HIT_TOLERANCE_PX > DRAWING_LEVEL_HIT_TOLERANCE_PX);
  assert.ok(TOUCH_DRAWING_HANDLE_RADIUS_PX > DRAWING_HANDLE_RADIUS_PX);
  assert.equal(DRAWING_HIT_TOLERANCE_PX, 7);
  assert.equal(DRAWING_LEVEL_HIT_TOLERANCE_PX, 9);
  assert.equal(DRAWING_HANDLE_RADIUS_PX, 4);
});

test("a touch picks a line from farther away than a mouse, within the touch tolerance", () => {
  const context = { view, time: timeCtx, positionRisk: DEFAULT_POSITION_RISK_SETTINGS, touch: false };
  const line = trend();
  assert.equal(drawingHitTest(line, FAR, NEAR, context), false);
  assert.equal(drawingHitTest(line, FAR, NEAR, { ...context, touch: true }), true);
  assert.equal(drawingHitTest(line, FAR, AWAY, { ...context, touch: true }), false);
});

test("peekAt reports the drawing under the pointer without selecting it", () => {
  const manager = makeManager([trend()]);
  assert.equal(manager.peekAt(FAR, NEAR), null, "12px away is a miss for a mouse");
  assert.deepEqual(manager.peekAt(FAR, NEAR, { touch: true }), { id: "line", selected: false });
  assert.equal(manager.peekAt(FAR, AWAY, { touch: true }), null);
  assert.deepEqual(manager.getSelectedIds(), [], "peeking selects nothing");

  assert.equal(manager.hitTestAt(FAR, { x: 284, y: 452 })?.id, "line", "hitTestAt still selects");
  assert.deepEqual(manager.peekAt(FAR, NEAR, { touch: true }), { id: "line", selected: true });
});

test("peekAt skips hidden drawings and other markets", () => {
  const manager = makeManager([
    drawing("trend", trend().points, { id: "hidden", visible: false }),
    drawing("trend", trend().points, { id: "elsewhere", market: "BINANCE_FUTURES:ethusdt" }),
  ]);
  assert.equal(manager.peekAt(FAR, { x: 284, y: 452 }, { touch: true }), null);
});

test("a touch press selects a line a mouse press would miss", () => {
  const mouse = makeManager([trend()]);
  assert.equal(mouse.pointerDown(FAR, NEAR), false);
  assert.deepEqual(mouse.getSelectedIds(), []);

  const touch = makeManager([trend()]);
  assert.equal(touch.pointerDown(FAR, NEAR, { touch: true }), true);
  assert.deepEqual(touch.getSelectedIds(), ["line"]);
});

test("the touch tolerance follows the last press, so the next mouse press is exact again", () => {
  const manager = makeManager([trend()]);
  assert.equal(manager.pointerDown(FAR, NEAR, { touch: true }), true);
  manager.pointerUp();
  manager.select("line");
  assert.equal(manager.pointerDown(FAR, NEAR), false, "a mouse press 12px away misses again");
});

test("position levels are picked from farther away by touch", () => {
  // Entry, stop and target levels at screen y 500, 520 and 460 across x 84..484.
  const position = drawing("long-position", [
    { time: 10, price: 100 },
    { time: 60, price: 80 },
    { time: 60, price: 140 },
  ], { id: "pos" });
  const context = { view, time: timeCtx, positionRisk: DEFAULT_POSITION_RISK_SETTINGS, touch: false };
  const point = { x: 200, y: 486 }; // 14px above the entry level, 26px under the target level
  assert.equal(positionLevelHitIndex(position, FAR, point, context), null);
  assert.equal(positionLevelHitIndex(position, FAR, point, { ...context, touch: true }), 0);
  assert.equal(positionLevelHitIndex(position, FAR, { x: 200, y: 500 }, context), 0, "an exact hit is unchanged");
});

function recordingContext() {
  const radii = [];
  return new Proxy({ radii }, {
    get(target, prop) {
      if (prop === "radii") return target.radii;
      if (prop === "arc") return (_x, _y, radius) => { radii.push(radius); };
      if (prop === "measureText") return () => ({ width: 40 });
      return () => undefined;
    },
    set() { return true; },
  });
}

test("selected drawings draw bigger anchor handles after a touch press", () => {
  const manager = makeManager([trend()]);
  manager.select("line");

  const mouse = recordingContext();
  manager.renderSelection(mouse, view, timeCtx);
  assert.ok(mouse.radii.length >= 2, "both anchors of the selected line get a handle");
  assert.ok(mouse.radii.every((radius) => radius === DRAWING_HANDLE_RADIUS_PX));

  manager.pointerDown(FAR, NEAR, { touch: true });
  const touch = recordingContext();
  manager.renderSelection(touch, view, timeCtx);
  assert.ok(touch.radii.length >= 2);
  assert.ok(touch.radii.every((radius) => radius === TOUCH_DRAWING_HANDLE_RADIUS_PX));
});
