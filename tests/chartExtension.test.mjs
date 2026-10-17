import test from "node:test";
import assert from "node:assert/strict";
import { ChartRenderScene } from "../dist/core/render/scene/chartScene.js";
import { ChartExtensionHost, createLayerExtension } from "../dist/core/render/scene/chartExtension.js";

function layer(id, stage = "gpu-series") {
  return { id, kind: "test", visible: true, passes: [{ id: `${id}:pass`, surface: "gpu-scene", stage, order: 0 }] };
}

test("extension host owns layer attach/detach lifecycle", () => {
  const scene = new ChartRenderScene();
  const host = new ChartExtensionHost(scene, { invalidate() {} });
  host.add(createLayerExtension("series", [layer("candles")]));
  assert.equal(host.has("series"), true);
  assert.equal(scene.hasLayer("candles"), true);
  assert.equal(host.remove("series"), true);
  assert.equal(scene.hasLayer("candles"), false);
});

test("extension host rolls back partial layer registration on conflicts", () => {
  const scene = new ChartRenderScene();
  const host = new ChartExtensionHost(scene, { invalidate() {} });
  host.add(createLayerExtension("base", [layer("existing")]));
  assert.throws(() => host.add(createLayerExtension("bad", [layer("new"), layer("existing")])), /duplicate layer id/);
  assert.equal(scene.hasLayer("new"), false);
  assert.equal(host.has("bad"), false);
});
