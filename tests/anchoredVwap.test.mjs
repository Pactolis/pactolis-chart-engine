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

test("anchored vwap binary search lower-bound handles between-bars and boundary anchors", () => {
  const bars = [
    { startTime: 1000, open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 2000, open: 2, high: 4, low: 2, close: 4, volume: 20, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 3000, open: 3, high: 5, low: 3, close: 5, volume: 30, delta: 0, count: 1, hasRef: true, cells: new Map() },
    { startTime: 4000, open: 4, high: 6, low: 4, close: 6, volume: 40, delta: 0, count: 1, hasRef: true, cells: new Map() },
  ];

  // Anchor between bar 0 and bar 1: starts at bar 1 (startTime 2000)
  const resultMid = calculateAnchoredVwap(bars, 1500);
  assert.equal(resultMid.points.length, 3);
  assert.equal(resultMid.points[0].time, 2000);

  // Anchor before all bars: includes all 4 bars
  const resultBefore = calculateAnchoredVwap(bars, 500);
  assert.equal(resultBefore.points.length, 4);
  assert.equal(resultBefore.points[0].time, 1000);

  // Anchor after all bars: empty points
  const resultAfter = calculateAnchoredVwap(bars, 5000);
  assert.equal(resultAfter.points.length, 0);
  assert.equal(resultAfter.available, false);

  // endTime parameter stops iteration early
  const resultEnd = calculateAnchoredVwap(bars, 1000, 2500);
  assert.equal(resultEnd.points.length, 2);
  assert.equal(resultEnd.points[0].time, 1000);
  assert.equal(resultEnd.points[1].time, 2000);
});
