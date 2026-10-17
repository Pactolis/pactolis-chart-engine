import test from "node:test";
import assert from "node:assert/strict";

import {
  ChartChange,
  ChartRenderScene,
  ChartSurfaceDirty,
  chartChangeForDataUpdate,
  invalidationScopeForChanges,
  surfaceDirtyForChanges,
  surfaceForStage,
} from "../dist/core/render/scene/chartScene.js";
import {
  buildIndicatorSceneLayer,
  resolveBuiltInLayerPreset,
} from "../dist/core/render/scene/chartLayerPreset.js";

test("render stages have a hard physical-surface mapping", () => {
  assert.equal(surfaceForStage("gpu-background"), "gpu-scene");
  assert.equal(surfaceForStage("gpu-series"), "gpu-scene");
  assert.equal(surfaceForStage("gpu-signal"), "gpu-scene");
  assert.equal(surfaceForStage("annotation-data"), "annotation");
  assert.equal(surfaceForStage("annotation-overlay"), "annotation");
  assert.equal(surfaceForStage("axis-ui"), "annotation");
  assert.equal(surfaceForStage("interaction"), "interaction");
});

test("interaction-only changes dirty only the interaction surface", () => {
  assert.equal(surfaceDirtyForChanges(ChartChange.Interaction), ChartSurfaceDirty.Interaction);
  assert.equal(surfaceDirtyForChanges(ChartChange.GpuContext), ChartSurfaceDirty.GpuScene);
  assert.equal(
    surfaceDirtyForChanges(ChartChange.Data),
    ChartSurfaceDirty.GpuScene | ChartSurfaceDirty.Annotation | ChartSurfaceDirty.Interaction,
  );
});

// T05-A (#316) oracle, written from the issue rather than from the implementation: each kind of
// update names its own change, and this first stage keeps every surface decision exactly as it was.
const ALL_SURFACES = ChartSurfaceDirty.GpuScene | ChartSurfaceDirty.Annotation | ChartSurfaceDirty.Interaction;
const EXPECTED_SCOPES = [
  ["style", ChartChange.Style, ALL_SURFACES],
  ["visibility", ChartChange.Visibility, ALL_SURFACES],
  ["viewport", ChartChange.Viewport, ALL_SURFACES],
  ["layout", ChartChange.Layout, ALL_SURFACES],
  ["tail data", ChartChange.DataTail, ALL_SURFACES],
  ["non-tail correction", ChartChange.DataNonTail, ALL_SURFACES],
  ["interaction", ChartChange.Interaction, ChartSurfaceDirty.Interaction],
  ["gpu context", ChartChange.GpuContext, ChartSurfaceDirty.GpuScene],
  ["nothing", ChartChange.None, ChartSurfaceDirty.None],
];

test("each named change has its own bit and keeps the full-surface redraw it had before", () => {
  const named = EXPECTED_SCOPES.filter(([, change]) => change !== ChartChange.None);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      assert.equal(named[i][1] & named[j][1], 0, `${named[i][0]} and ${named[j][0]} must not share a bit`);
    }
  }
  assert.equal(ChartChange.Data, ChartChange.DataTail | ChartChange.DataNonTail);
  assert.equal(
    ChartChange.All,
    named.reduce((mask, [, change]) => mask | change, ChartChange.None),
    "All covers every named change and nothing else",
  );
  for (const [label, change, surfaces] of EXPECTED_SCOPES) {
    assert.deepEqual(invalidationScopeForChanges(change), { changes: change, surfaces }, label);
  }
});

test("combined changes dirty the union of their surfaces", () => {
  for (let mask = 0; mask <= ChartChange.All; mask++) {
    if ((mask & ~ChartChange.All) !== 0) continue;
    let expected = ChartSurfaceDirty.None;
    for (const [, change, surfaces] of EXPECTED_SCOPES) if (mask & change) expected |= surfaces;
    assert.equal(surfaceDirtyForChanges(mask), expected, `mask ${mask}`);
  }
});

test("classified data updates map to tail or non-tail data changes", () => {
  const expected = {
    "same-bar-update": ChartChange.DataTail,
    "new-bar-appended": ChartChange.DataTail,
    "replay-step": ChartChange.DataTail,
    "history-loaded": ChartChange.DataNonTail,
    "history-patched": ChartChange.DataNonTail,
    "price-step-reset": ChartChange.DataNonTail,
    "series-cleared": ChartChange.DataNonTail,
    "replay-reset": ChartChange.DataNonTail,
    "metadata-updated": ChartChange.DataNonTail,
  };
  for (const [kind, change] of Object.entries(expected)) {
    assert.equal(chartChangeForDataUpdate(kind), change, kind);
  }
});

test("scene validates stage/surface ownership and duplicate IDs", () => {
  const scene = new ChartRenderScene();
  scene.addLayer({
    id: "candles",
    kind: "candles",
    visible: true,
    passes: [{ id: "candles:gpu", surface: "gpu-scene", stage: "gpu-series", order: 20 }],
  });

  assert.throws(
    () => scene.addLayer({
      id: "candles",
      kind: "duplicate",
      visible: true,
      passes: [],
    }),
    /duplicate layer id/i,
  );

  assert.throws(
    () => scene.addLayer({
      id: "broken",
      kind: "broken",
      visible: true,
      passes: [{ id: "broken:pass", surface: "annotation", stage: "gpu-series", order: 1 }],
    }),
    /stage.*surface/i,
  );
});

test("scene ordering is deterministic and hidden layers are omitted", () => {
  const scene = new ChartRenderScene();
  scene.addLayer({
    id: "footprint",
    kind: "footprint",
    visible: true,
    passes: [{ id: "footprint:gpu", surface: "gpu-scene", stage: "gpu-series", order: 30 }],
  });
  scene.addLayer({
    id: "grid",
    kind: "grid",
    visible: true,
    passes: [{ id: "grid:gpu", surface: "gpu-scene", stage: "gpu-background", order: 50 }],
  });
  scene.addLayer({
    id: "candles-b",
    kind: "candles",
    visible: true,
    passes: [{ id: "candles:b", surface: "gpu-scene", stage: "gpu-series", order: 20 }],
  });
  scene.addLayer({
    id: "candles-a",
    kind: "candles",
    visible: true,
    passes: [{ id: "candles:a", surface: "gpu-scene", stage: "gpu-series", order: 20 }],
  });
  scene.addLayer({
    id: "hidden-signal",
    kind: "signal",
    visible: false,
    passes: [{ id: "hidden:gpu", surface: "gpu-scene", stage: "gpu-signal", order: 1 }],
  });

  assert.deepEqual(
    scene.passesForSurface("gpu-scene").map((pass) => pass.id),
    ["grid:gpu", "candles:a", "candles:b", "footprint:gpu"],
  );
  assert.deepEqual(scene.layerIdsForSurface("gpu-scene"), ["grid", "candles-a", "candles-b", "footprint"]);
});

test("built-in chart presets preserve deterministic semantic layer composition", () => {
  const candlestick = resolveBuiltInLayerPreset("candlestick");
  const footprint = resolveBuiltInLayerPreset("footprint");
  const profile = resolveBuiltInLayerPreset("footprintProfile");
  const tpo = resolveBuiltInLayerPreset("tpo");

  assert.deepEqual(candlestick.gpu, ["grid", "candles"]);
  assert.ok(footprint.gpu.includes("footprint"));
  assert.ok(footprint.annotation.includes("footprint-text"));
  assert.ok(profile.gpu.includes("footprint-profile"));
  assert.ok(tpo.annotation.includes("tpo"));

  for (const preset of [candlestick, footprint, profile, tpo]) {
    assert.ok(preset.annotation.includes("indicators"));
    assert.ok(preset.annotation.includes("drawings"));
    assert.deepEqual(preset.interaction, ["crosshair", "hud", "interaction-controls"]);
  }
});


test("visible indicator instances are independent semantic layers", () => {
  const scene = new ChartRenderScene();
  scene.addLayer(buildIndicatorSceneLayer("vwap-main", 0));
  scene.addLayer(buildIndicatorSceneLayer("ema-50", 1));

  assert.equal(scene.hasLayer("indicator:vwap-main"), true);
  assert.equal(scene.hasLayer("indicator:ema-50"), true);
  assert.deepEqual(
    scene.layerIdsForSurface("annotation").filter((id) => id.startsWith("indicator:")),
    ["indicator:vwap-main", "indicator:ema-50"],
  );
  assert.deepEqual(
    scene.passesForSurface("annotation").map((pass) => [pass.ownerLayerId, pass.stage]),
    [
      ["indicator:vwap-main", "annotation-overlay"],
      ["indicator:ema-50", "annotation-overlay"],
    ],
  );
});
