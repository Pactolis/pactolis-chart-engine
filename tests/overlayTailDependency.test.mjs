import test from "node:test";
import assert from "node:assert/strict";
import { Overlay } from "../dist/core/render/overlay.js";

function makeOverlay(getSyncCrosshairTime = () => null) {
  const ctx = { canvas: { width: 100, height: 100 }, clearRect() {} };
  return new Overlay(ctx, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, getSyncCrosshairTime);
}

const crosshair = { x: 0, y: 0, visible: false };
const range = [0, 1];
const emptySeries = { length: 0 };
const nonEmptySeries = { length: 1 };

test("annotation HUD invalidates only on local activation/deactivation edges", () => {
  const overlay = makeOverlay();
  const inactive = { x: 0, y: 0, visible: false };
  const active = { x: 0, y: 0, visible: true };

  assert.equal(overlay.hasInteractionDependentHudContent(inactive), false, "initial inactive state is unchanged");
  assert.equal(overlay.hasInteractionDependentHudContent(active), true, "local hover activation changes annotation HUD");
  assert.equal(overlay.hasInteractionDependentHudContent({ ...active, x: 10 }), false, "successive pointer movement stays Interaction-only");
  assert.equal(overlay.hasInteractionDependentHudContent({ ...active, x: 20 }), false, "another pointer move stays Interaction-only");
  assert.equal(overlay.hasInteractionDependentHudContent(inactive), true, "deactivation restores latest HUD");
  assert.equal(overlay.hasInteractionDependentHudContent(inactive), false, "repeated inactive state adds no annotation invalidation");
});

test("synchronized HUD invalidates when and only when its time changes", () => {
  let syncTime = null;
  const overlay = makeOverlay(() => syncTime);
  const inactive = { x: 0, y: 0, visible: false };

  assert.equal(overlay.hasInteractionDependentHudContent(inactive), false, "no sync cursor is unchanged");
  syncTime = 60_000;
  assert.equal(overlay.hasInteractionDependentHudContent(inactive), true, "sync activation changes HUD selection");
  assert.equal(overlay.hasInteractionDependentHudContent(inactive), false, "same sync time does not dirty Annotation");
  syncTime = 120_000;
  assert.equal(overlay.hasInteractionDependentHudContent(inactive), true, "changed sync time changes HUD selection");
  syncTime = null;
  assert.equal(overlay.hasInteractionDependentHudContent(inactive), true, "sync deactivation restores latest HUD");
  assert.equal(overlay.hasInteractionDependentHudContent(inactive), false, "repeated inactive state adds no annotation invalidation");
});

test("interaction tail dependency only covers a visible crosshair on the changing tail bar", () => {
  const overlay = makeOverlay();
  const indexedView = { indexOfX: (x) => x };
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, emptySeries, { x: 0, visible: true }, range), false);
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, crosshair, range), false, "inactive crosshair needs no tail redraw");
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, { x: 0, visible: true }, range, ["hud"]), false, "HUD no longer belongs to interaction");
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, { x: 0, visible: true }, range, ["crosshair"]), true, "active tail crosshair label depends on updated tail");
  assert.equal(overlay.hasTailDependentInteractionContent(indexedView, nonEmptySeries, { x: 1, visible: true }, range, ["crosshair"]), false, "a non-tail crosshair does not depend on tail data");
});
