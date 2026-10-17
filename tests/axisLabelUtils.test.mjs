import test from "node:test";
import assert from "node:assert/strict";
import { placeVerticalLabels } from "../dist/core/axisLabelUtils.js";

test("placeVerticalLabels preserves source price order while resolving collisions", () => {
  const labels = placeVerticalLabels([
    { id: "lower-cluster-a", desiredY: 72, priority: 100, boxH: 14 },
    { id: "lower-cluster-b", desiredY: 72, priority: 90, boxH: 14 },
    { id: "lower-cluster-c", desiredY: 72, priority: 80, boxH: 14 },
    { id: "higher-level", desiredY: 18, priority: 40, boxH: 14 },
  ], 0, 90, 2);

  const higher = labels.find((label) => label.id === "higher-level");
  const lowerLabels = labels.filter((label) => label.id.startsWith("lower-cluster"));
  assert.ok(higher);
  assert.ok(lowerLabels.length >= 1);
  assert.ok(lowerLabels.every((label) => higher.y < label.y));
});

test("placeVerticalLabels keeps displayed labels non-overlapping", () => {
  const boxH = 14;
  const gap = 2;
  const labels = placeVerticalLabels(
    Array.from({ length: 12 }, (_, index) => ({
      id: `label-${index}`,
      desiredY: 40 + index,
      priority: 100 - index,
      boxH,
    })),
    0,
    100,
    gap
  );

  for (let index = 1; index < labels.length; index += 1) {
    assert.ok(
      labels[index].y - labels[index - 1].y >= boxH + gap - 1e-6,
      `labels ${index - 1} and ${index} overlap`
    );
  }
});
