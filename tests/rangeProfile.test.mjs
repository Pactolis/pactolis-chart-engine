import test from "node:test";
import assert from "node:assert/strict";
import { calculateRangeProfile } from "../dist/core/analysis/rangeProfile.js";

test("range profile reports missing days and deterministic poc", () => {
  const bars = [
    {
      startTime: 0, open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 0, count: 1, hasRef: true,
      cells: new Map([[1, { priceBin: 1, buyVol: 4, sellVol: 1 }]]),
    },
    {
      startTime: 86_400_000, open: 2, high: 3, low: 2, close: 3, volume: 20, delta: 0, count: 1, hasRef: true,
      cells: new Map([[2, { priceBin: 2, buyVol: 10, sellVol: 0 }]]),
    },
  ];
  const result = calculateRangeProfile(bars, 0, 2 * 86_400_000, 0.7);
  assert.equal(result.complete, true);
  assert.equal(result.coverage, 1);
  assert.ok(result.poc);
});
