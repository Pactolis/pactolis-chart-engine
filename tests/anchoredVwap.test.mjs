import test from "node:test";
import assert from "node:assert/strict";
import { calculateAnchoredVwap } from "../dist/core/analysis/anchoredVwap.js";

test("anchored vwap ignores candles before the anchor", () => {
  const bars = [
    { startTime: 0, open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 1000, open: 2, high: 4, low: 2, close: 4, volume: 20, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 2000, open: 3, high: 5, low: 3, close: 5, volume: 30, delta: 0, count: 1, hasRef: true, cells: new Map() },
  ];
  const result = calculateAnchoredVwap(bars, 1000);
  assert.equal(result.points.length, 2);
  assert.equal(result.points[0].time, 1000);
  assert.ok(result.points[1].value > result.points[0].value);
});
