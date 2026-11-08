import test from "node:test";
import assert from "node:assert/strict";
import { Overlay } from "../dist/core/render/overlay.js";

function makeOverlay() {
  const ctx = { canvas: { width: 100, height: 100 }, clearRect() {} };
  return new Overlay(ctx);
}

const crosshair = { x: 0, y: 0, visible: false };
const view = {};
const range = [0, 1];
const emptySeries = { length: 0 };
const nonEmptySeries = { length: 1 };

test("interaction tail dependency is false only when renderInteraction has no content", () => {
  const overlay = makeOverlay();
  assert.equal(overlay.hasTailDependentInteractionContent(view, emptySeries, crosshair, range), false);
  assert.equal(overlay.hasTailDependentInteractionContent(view, nonEmptySeries, crosshair, range, []), false);
  assert.equal(overlay.hasTailDependentInteractionContent(view, nonEmptySeries, crosshair, range, ["unrecognized"]), true);
});

test("every recognized interaction layer conservatively depends on live tail inputs", () => {
  const overlay = makeOverlay();
  for (const layer of ["crosshair", "hud", "interaction-controls"]) {
    assert.equal(overlay.hasTailDependentInteractionContent(view, nonEmptySeries, crosshair, range, [layer]), true, layer);
  }
  assert.equal(overlay.hasTailDependentInteractionContent(view, nonEmptySeries, crosshair, range), true);
});
