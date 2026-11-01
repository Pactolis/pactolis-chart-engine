import test from "node:test";
import assert from "node:assert/strict";

import {
  ChartChange,
  ChartSurfaceDirty,
  chartChangeForDataUpdate,
  invalidationScopeForChanges,
  surfaceDirtyForChanges,
  surfaceForStage,
} from "../dist/core/render/scene/chartScene.js";
import {
  LAYER_STAGE,
  resolveBuiltInLayerPreset,
  resolveLayerOrder,
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

test("LAYER_STAGE maps each layer descriptor to a valid stage and surface", () => {
  for (const [layerId, descriptor] of Object.entries(LAYER_STAGE)) {
    assert.ok(descriptor.stage, `layer '${layerId}' has stage`);
    assert.ok(typeof descriptor.order === "number", `layer '${layerId}' has numeric order`);
    const surface = surfaceForStage(descriptor.stage);
    assert.ok(
      surface === "gpu-scene" || surface === "annotation" || surface === "interaction",
      `layer '${layerId}' surface '${surface}' must be a valid surface`,
    );
  }
});

test("resolveLayerOrder resolves deterministic layer orders across all 4 chart types with {0, 1, 3} indicators", () => {
  const chartTypes = ["candlestick", "footprint", "footprintProfile", "tpo"];
  const indicatorSets = [
    [],
    ["rsi"],
    ["vwap", "ema", "rsi"],
  ];

  for (const chartType of chartTypes) {
    for (const indicatorIds of indicatorSets) {
      const order = resolveLayerOrder(chartType, indicatorIds);

      assert.ok(order.gpu instanceof Set, "gpu must be a Set");
      assert.ok(Array.isArray(order.annotation), "annotation must be an Array");
      assert.ok(Array.isArray(order.interaction), "interaction must be an Array");

      // Verify grid and candles exist in GPU layers for all built-in types
      assert.ok(order.gpu.has("grid"), `${chartType} must have grid`);
      assert.ok(order.gpu.has("candles"), `${chartType} must have candles`);

      // Verify indicator instances appear in annotation order
      for (const id of indicatorIds) {
        assert.ok(
          order.annotation.includes(`indicator:${id}`),
          `annotation must include indicator:${id}`,
        );
      }

      // Verify interaction layers order
      assert.deepEqual(
        order.interaction,
        ["crosshair", "hud", "interaction-controls"],
        `interaction order for ${chartType}`,
      );

      // Verify no duplicate IDs on any surface
      const allIds = [...order.gpu, ...order.annotation, ...order.interaction];
      const uniqueIds = new Set(allIds);
      assert.equal(allIds.length, uniqueIds.size, `all layer IDs must be unique for ${chartType}`);
    }
  }
});
