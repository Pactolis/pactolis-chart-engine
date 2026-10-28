import test from "node:test";
import assert from "node:assert/strict";
import {
  LONG_PRESS_MS,
  MOUSE_CLICK_SLOP_PX,
  PINCH_MIN_DISTANCE_PX,
  TOUCH_CLICK_SLOP_PX,
  TouchPointers,
  clickSlopPx,
  isTouchPointer,
  movedBeyondSlop,
  pinchSample,
  pinchStep,
} from "../dist/features/chart/touchGestures.js";

test("only touch pointers are touch; mouse, pen and typeless synthetic events keep the mouse slop", () => {
  assert.equal(isTouchPointer({ pointerType: "touch" }), true);
  for (const pointerType of ["mouse", "pen", "", undefined]) {
    assert.equal(isTouchPointer({ pointerType }), false, `pointerType ${JSON.stringify(pointerType)}`);
    assert.equal(clickSlopPx({ pointerType }), MOUSE_CLICK_SLOP_PX);
  }
  assert.equal(clickSlopPx({ pointerType: "touch" }), TOUCH_CLICK_SLOP_PX);
  assert.ok(TOUCH_CLICK_SLOP_PX > MOUSE_CLICK_SLOP_PX);
  assert.equal(MOUSE_CLICK_SLOP_PX, 3, "the mouse slop the input layer always had");
});

test("movedBeyondSlop is true past the slop on either axis and false at it", () => {
  assert.equal(movedBeyondSlop(3, 0, 3), false);
  assert.equal(movedBeyondSlop(-3, 3, 3), false);
  assert.equal(movedBeyondSlop(3.5, 0, 3), true);
  assert.equal(movedBeyondSlop(0, -4, 3), true);
  assert.equal(movedBeyondSlop(9, -9, TOUCH_CLICK_SLOP_PX), false);
  assert.equal(movedBeyondSlop(0, 11, TOUCH_CLICK_SLOP_PX), true);
});

test("a long press is long enough to tell from a tap and short enough to feel immediate", () => {
  assert.ok(LONG_PRESS_MS >= 300 && LONG_PRESS_MS <= 600);
});

test("pinchSample measures the distance and the midpoint of two fingers", () => {
  const sample = pinchSample(100, 200, 160, 280);
  assert.equal(sample.distance, 100);
  assert.equal(sample.midX, 130);
  assert.equal(sample.midY, 240);
});

test("spreading the fingers zooms in, closing them zooms out, and the factor is the distance ratio", () => {
  const start = pinchSample(100, 300, 200, 300);
  const spread = pinchStep(start, pinchSample(80, 300, 220, 300));
  assert.ok(spread);
  assert.equal(spread.factor, 1.4);
  assert.equal(spread.dMidX, 0);
  assert.equal(spread.dMidY, 0);

  const closed = pinchStep(pinchSample(80, 300, 220, 300), start);
  assert.ok(closed);
  assert.ok(Math.abs(closed.factor - 1 / 1.4) < 1e-12);
});

test("pinch steps compose: the product of the factors is the total zoom", () => {
  const samples = [100, 130, 170, 220, 260].map((d) => pinchSample(200 - d / 2, 300, 200 + d / 2, 300));
  let product = 1;
  for (let i = 1; i < samples.length; i++) product *= pinchStep(samples[i - 1], samples[i]).factor;
  assert.ok(Math.abs(product - 2.6) < 1e-12);
});

test("two fingers moving together pan without zooming, and the step reports the midpoint travel", () => {
  const step = pinchStep(pinchSample(100, 300, 200, 300), pinchSample(130, 320, 230, 320));
  assert.ok(step);
  assert.equal(step.factor, 1);
  assert.equal(step.dMidX, 30);
  assert.equal(step.dMidY, 20);
});

test("fingers too close together give no step, so the zoom cannot jump when they open up", () => {
  const tight = pinchSample(100, 300, 100 + PINCH_MIN_DISTANCE_PX - 1, 300);
  const open = pinchSample(100, 300, 220, 300);
  assert.equal(pinchStep(tight, open), null);
  assert.equal(pinchStep(open, tight), null);
  assert.equal(pinchStep(tight, tight), null);
  assert.notEqual(pinchStep(pinchSample(100, 300, 100 + PINCH_MIN_DISTANCE_PX, 300), open), null);
});

test("TouchPointers tracks the fingers that are down, in the order they landed", () => {
  const touches = new TouchPointers();
  assert.equal(touches.size, 0);
  touches.down(7, 10, 20);
  touches.down(9, 30, 40);
  assert.equal(touches.size, 2);
  assert.deepEqual(touches.get(7), { x: 10, y: 20 });
  assert.equal(touches.has(9), true);
  assert.equal(touches.otherThan(7), 9);
  assert.equal(touches.otherThan(9), 7);

  touches.move(7, 15, 25);
  assert.deepEqual(touches.get(7), { x: 15, y: 25 });
  touches.move(99, 1, 1);
  assert.equal(touches.has(99), false, "a move from a finger that never landed is ignored");

  touches.up(7);
  assert.equal(touches.has(7), false);
  assert.equal(touches.otherThan(9), null, "a lone finger has no other");

  touches.clear();
  assert.equal(touches.size, 0);
});
