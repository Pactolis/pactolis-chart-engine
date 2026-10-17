import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHART_INTERACTION_POLICY, canUseContextMenu } from "../dist/features/chart/interactionPolicy.js";
import { resolveChartWheelAction } from "../dist/features/chart/wheelPolicy.js";

test("default chart interaction policy mirrors enabled scroll scale split", () => {
  assert.equal(DEFAULT_CHART_INTERACTION_POLICY.scroll.plotPressedMouseMove, true);
  assert.equal(DEFAULT_CHART_INTERACTION_POLICY.scale.axisPressedMouseMove.time, true);
  assert.equal(DEFAULT_CHART_INTERACTION_POLICY.scale.axisPressedMouseMove.price, true);
  assert.equal(DEFAULT_CHART_INTERACTION_POLICY.scale.axisDoubleClickReset.cornerBoth, true);
  // Plot double-click maximizes the pane; it never resets the price scale.
  assert.equal("plotPrice" in DEFAULT_CHART_INTERACTION_POLICY.scale.axisDoubleClickReset, false);
  assert.equal(canUseContextMenu(DEFAULT_CHART_INTERACTION_POLICY, "plot"), true);
  assert.equal(canUseContextMenu(DEFAULT_CHART_INTERACTION_POLICY, "price-axis"), true);
});

test("wheel resolver honors disabled price-axis wheel policy", () => {
  const policy = {
    ...DEFAULT_CHART_INTERACTION_POLICY,
    scale: {
      ...DEFAULT_CHART_INTERACTION_POLICY.scale,
      priceAxisWheel: false,
    },
  };
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 0, deltaY: -120, altKey: false, shiftKey: false, target: "price-axis" }, policy),
    { kind: "zoom-x", factor: 1.1 },
  );
});
