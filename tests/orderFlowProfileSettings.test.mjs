import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ORDER_FLOW_PROFILE_SETTINGS,
  normalizeOrderFlowProfileSettings,
  normalizeFixedRangeOrderFlowProfileSettings,
} from "../dist/core/orderFlowProfileSettings.js";
import {
  DRAWING_STYLE_PRESET_KEYS,
  ORDER_FLOW_PROFILE_STYLE_KEYS,
  applyStylePreset,
  drawingStylePresetFromDrawing,
  duplicateDrawing,
} from "../dist/features/drawings/drawingPrimitives.js";

test("new profile defaults are volume total with static independent levels", () => {
  assert.deepEqual(DEFAULT_ORDER_FLOW_PROFILE_SETTINGS, {
    profileMetric: "volume",
    profileSide: "total",
    profilePlacement: "right",
    pocMode: "static",
    vahMode: "static",
    valMode: "static",
  });
});

test("legacy indicator booleans migrate before defaults and preserve false", () => {
  const migrated = normalizeOrderFlowProfileSettings({
    showPoc: false,
    showValueArea: false,
    pocColor: "#123456",
    vaColor: "#654321",
  });
  assert.equal(migrated.profileMetric, "volume");
  assert.equal(migrated.profileSide, "total");
  assert.equal(migrated.pocMode, "off");
  assert.equal(migrated.vahMode, "off");
  assert.equal(migrated.valMode, "off");
  assert.equal(migrated.pocStaticColor, "#123456");
  assert.equal(migrated.vahStaticColor, "#654321");
  assert.equal(migrated.valStaticColor, "#654321");
});

test("valid new indicator fields win over legacy fields", () => {
  const migrated = normalizeOrderFlowProfileSettings({
    profileMetric: "trade-count",
    profileSide: "sell",
    pocMode: "both",
    vahMode: "developing",
    valMode: "static",
    showPoc: false,
    showValueArea: false,
  });
  assert.deepEqual(
    [migrated.profileMetric, migrated.profileSide, migrated.pocMode, migrated.vahMode, migrated.valMode],
    ["trade-count", "sell", "both", "developing", "static"],
  );
});

test("indicator normalization is idempotent", () => {
  const once = normalizeOrderFlowProfileSettings({ showPoc: false, showValueArea: true });
  const twice = normalizeOrderFlowProfileSettings(once);
  assert.deepEqual(twice, once);
});

test("legacy fixed-range flags migrate independently", () => {
  const migrated = normalizeFixedRangeOrderFlowProfileSettings({
    showPoc: false,
    showVah: true,
    showVal: false,
    valueAreaPercent: 0.65,
    profileWidth: 0.4,
  });
  assert.equal(migrated.pocMode, "off");
  assert.equal(migrated.vahMode, "static");
  assert.equal(migrated.valMode, "off");
  assert.equal(migrated.valueAreaPercent, 0.65);
  assert.equal(migrated.profileWidth, 0.4);
});

test("unsupported metrics keep hidden level preferences without enabling level calculation", () => {
  const migrated = normalizeOrderFlowProfileSettings({
    profileMetric: "delta",
    profileSide: "buy",
    pocMode: "both",
  });
  assert.equal(migrated.profileMetric, "delta");
  assert.equal(migrated.profileSide, "buy");
  assert.equal(migrated.pocMode, "both");
});

test("profilePlacement defaults to right for indicator and left for fixed-range with invalid fallback", () => {
  assert.equal(normalizeOrderFlowProfileSettings({}).profilePlacement, "right");
  assert.equal(normalizeOrderFlowProfileSettings({ profilePlacement: "left" }).profilePlacement, "left");
  assert.equal(normalizeOrderFlowProfileSettings({ profilePlacement: "right" }).profilePlacement, "right");
  assert.equal(normalizeOrderFlowProfileSettings({ profilePlacement: "center" }).profilePlacement, "right");
  assert.equal(normalizeOrderFlowProfileSettings({ profilePlacement: 42 }).profilePlacement, "right");

  assert.equal(normalizeFixedRangeOrderFlowProfileSettings({}).profilePlacement, "left");
  assert.equal(normalizeFixedRangeOrderFlowProfileSettings({ profilePlacement: "right" }).profilePlacement, "right");
  assert.equal(normalizeFixedRangeOrderFlowProfileSettings({ profilePlacement: "left" }).profilePlacement, "left");
  assert.equal(normalizeFixedRangeOrderFlowProfileSettings({ profilePlacement: "center" }).profilePlacement, "left");
  assert.equal(normalizeFixedRangeOrderFlowProfileSettings({ profilePlacement: null }).profilePlacement, "left");
});

test("drawing style preset keys include profilePlacement and preserve it across presets and duplicates", () => {
  assert.ok(ORDER_FLOW_PROFILE_STYLE_KEYS.includes("profilePlacement"));
  assert.ok(DRAWING_STYLE_PRESET_KEYS.includes("profilePlacement"));

  const source = {
    id: "frvp-1",
    type: "fixed-range-volume-profile",
    points: [
      { time: 1_000, price: 100 },
      { time: 2_000, price: 105 },
    ],
    color: "#ffffff",
    lineWidth: 1,
    locked: false,
    visible: true,
    market: "BINANCE_FUTURES:btcusdt",
    profilePlacement: "right",
  };
  const preset = drawingStylePresetFromDrawing(source);
  assert.equal(preset.profilePlacement, "right");

  const target = {
    ...source,
    id: "frvp-2",
    profilePlacement: "left",
  };
  applyStylePreset(target, preset);
  assert.equal(target.profilePlacement, "right");

  const copy = duplicateDrawing(source, [source]);
  assert.equal(copy.profilePlacement, "right");
});
