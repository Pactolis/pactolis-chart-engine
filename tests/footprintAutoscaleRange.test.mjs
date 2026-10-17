import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintRenderer } from "../dist/core/render/footprintRenderer.js";

const { autoscaleRange, visibleRange } = FootprintRenderer.prototype;

function viewWithRightEdgeAt(rightIndex, colWidth = 10, width = 1000) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height: 400 };
  view.colWidth = colWidth;
  view.offsetX = width - rightIndex * colWidth;
  return view;
}

test("autoscale range stops at the last bar that overlaps the right edge", () => {
  // Right edge falls inside bar 149: bar 150 starts off screen.
  const view = viewWithRightEdgeAt(149.4);
  assert.deepEqual(autoscaleRange.call(null, view, 500), [49, 150]);
  // Drawing keeps one extra bar for geometry that reaches into the next bar.
  assert.deepEqual(visibleRange.call(null, view, 500), [49, 151]);
});

test("a bar starting exactly at the right edge is not part of autoscale", () => {
  const view = viewWithRightEdgeAt(150);
  assert.deepEqual(autoscaleRange.call(null, view, 500), [50, 150]);
});

test("autoscale range is clamped to the series", () => {
  const view = viewWithRightEdgeAt(120.5);
  assert.deepEqual(autoscaleRange.call(null, view, 100), [20, 100]);
  view.offsetX = 300;
  assert.deepEqual(autoscaleRange.call(null, view, 100), [0, 70]);
});
