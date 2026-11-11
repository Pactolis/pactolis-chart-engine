import test from "node:test";
import assert from "node:assert/strict";
import { Overlay } from "../dist/core/render/overlay.js";

function makeOverlay() {
  const ctx = { canvas: { width: 100, height: 100 }, clearRect() {} };
  return new Overlay(ctx);
}

const crosshair = { x: 0, y: 0, visible: false };
const range = [0, 1];
const emptySeries = { length: 0 };
const nonEmptySeries = { length: 1 };

test("interaction tail dependency only covers a visible crosshair on the changing tail bar", () => {
  const overlay = makeOverlay();
  const indexedView = { indexOfX: (x) => x };
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, emptySeries, { x: 0, visible: true }, range), false);
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, crosshair, range), false, "inactive crosshair needs no tail redraw");
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, { x: 0, visible: true }, range, ["hud"]), false, "HUD no longer belongs to interaction");
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, { x: 0, visible: true }, range, ["crosshair"]), true, "active tail crosshair label depends on updated tail");
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, { x: 1, visible: true }, range, ["crosshair"]), false, "a non-tail crosshair does not depend on tail data");
});
