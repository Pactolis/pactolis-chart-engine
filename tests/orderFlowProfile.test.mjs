import test from "node:test";
import assert from "node:assert/strict";
import { calculateOrderFlowProfile } from "../dist/core/analysis/orderFlowProfile.js";

function bar(time, levels) {
  return {
    startTime: time,
    open: 100,
    high: 103,
    low: 100,
    close: 102,
    volume: 0,
    delta: 0,
    count: 1,
    hasRef: true,
    cells: new Map(levels.map((level) => [level.priceBin, level])),
  };
}

function level(priceBin, buyVol, sellVol, counts = {}) {
  return { priceBin, buyVol, sellVol, ...counts };
}

const weightedBars = [
  bar(1, [level(100, 20, 10, { buyCount: 4, sellCount: 2, count: 6 })]),
  bar(2, [level(100, 30, 40, { buyCount: 1, sellCount: 8, count: 9 })]),
];

test("calculates all ten valid metric and side combinations from accumulated raw totals", () => {
  const cases = [
    ["volume", "total", 100],
    ["volume", "buy", 50],
    ["volume", "sell", 50],
    ["delta", "total", 0],
    ["trade-count", "total", 15],
    ["trade-count", "buy", 5],
    ["trade-count", "sell", 10],
    ["average-trade-size", "total", 100 / 15],
    ["average-trade-size", "buy", 10],
    ["average-trade-size", "sell", 5],
  ];

  for (const [metric, side, expected] of cases) {
    const result = calculateOrderFlowProfile(weightedBars, { profileMetric: metric, profileSide: side });
    assert.equal(result.levels.length, 1);
    assert.ok(Math.abs(result.levels[0].value - expected) < 1e-10, `${metric}/${side}`);
    assert.ok(Math.abs(result.summaryValue - expected) < 1e-10, `${metric}/${side} summary`);
  }
});

test("delta cancels across bars and a real zero is not missing data", () => {
  const result = calculateOrderFlowProfile(weightedBars, { profileMetric: "delta", profileSide: "buy" });
  assert.equal(result.profileSide, "total");
  assert.equal(result.levels[0].value, 0);
  assert.equal(result.levels[0].magnitude, 0);
  assert.equal(result.levels[0].complete, true);
  assert.equal(result.dataComplete, true);
  assert.equal(result.summaryValue, 0);
  assert.equal(result.poc, null);
  assert.equal(result.vah, null);
  assert.equal(result.val, null);
});

test("total trade count remains usable when only total count is known", () => {
  const bars = [bar(1, [level(100, 8, 2, { count: 5 })])];
  const total = calculateOrderFlowProfile(bars, { profileMetric: "trade-count", profileSide: "total" });
  assert.equal(total.levels[0].value, 5);
  assert.equal(total.levels[0].buyValue, null);
  assert.equal(total.levels[0].sellValue, null);
  assert.equal(total.dataComplete, true);

  const buy = calculateOrderFlowProfile(bars, { profileMetric: "trade-count", profileSide: "buy" });
  assert.equal(buy.levels[0].value, null);
  assert.equal(buy.dataComplete, false);
});

test("derives a missing side count only from a valid total and the known other side", () => {
  const bars = [bar(1, [level(100, 8, 2, { count: 5, buyCount: 3 })])];
  const sell = calculateOrderFlowProfile(bars, { profileMetric: "trade-count", profileSide: "sell" });
  assert.equal(sell.levels[0].value, 2);
  assert.equal(sell.dataComplete, true);
});

test("does not estimate side counts from volume ratios", () => {
  const bars = [bar(1, [level(100, 9, 1, { count: 5 })])];
  const result = calculateOrderFlowProfile(bars, { profileMetric: "average-trade-size", profileSide: "buy" });
  assert.equal(result.levels[0].value, null);
  assert.equal(result.summaryValue, null);
  assert.equal(result.dataComplete, false);
});

test("positive volume with zero count is not accepted as an average denominator", () => {
  const bars = [bar(1, [level(100, 2, 0, { count: 0, buyCount: 0, sellCount: 0 })])];
  const result = calculateOrderFlowProfile(bars, { profileMetric: "average-trade-size", profileSide: "buy" });
  assert.equal(result.levels[0].value, null);
  assert.equal(result.dataComplete, false);
  assert.equal(result.summaryValue, null);
});

test("invalid and contradictory counts are surfaced instead of coerced to zero", () => {
  const invalid = calculateOrderFlowProfile([
    bar(1, [level(100, 4, 1, { count: 2, buyCount: 2, sellCount: 2 })]),
  ], { profileMetric: "trade-count", profileSide: "total" });
  assert.equal(invalid.levels[0].value, null);
  assert.equal(invalid.dataComplete, false);

  const nonFinite = calculateOrderFlowProfile([
    bar(1, [level(100, 4, 1, { count: Number.NaN })]),
  ], { profileMetric: "trade-count", profileSide: "total" });
  assert.equal(nonFinite.levels[0].value, null);
  assert.equal(nonFinite.dataComplete, false);
});

test("POC and value area use the selected supported metric", () => {
  const bars = [bar(1, [
    level(100, 30, 30, { count: 3, buyCount: 2, sellCount: 1 }),
    level(101, 20, 20, { count: 10, buyCount: 5, sellCount: 5 }),
    level(102, 10, 10, { count: 7, buyCount: 4, sellCount: 3 }),
  ])];
  const volume = calculateOrderFlowProfile(bars, { profileMetric: "volume", profileSide: "total", valueAreaPercent: 0.7 });
  assert.deepEqual([volume.poc, volume.val, volume.vah], [100, 100, 101]);

  const count = calculateOrderFlowProfile(bars, { profileMetric: "trade-count", profileSide: "total", valueAreaPercent: 0.7 });
  assert.deepEqual([count.poc, count.val, count.vah], [101, 101, 102]);
});

test("POC and value area tie breaks stay deterministic", () => {
  const result = calculateOrderFlowProfile([bar(1, [
    level(100, 5, 0),
    level(101, 10, 0),
    level(102, 5, 0),
    level(103, 10, 0),
  ])], { profileMetric: "volume", profileSide: "total", valueAreaPercent: 0.5 });
  assert.equal(result.poc, 101);
  assert.equal(result.val, 100);
  assert.equal(result.vah, 101);
});

test("unsupported metrics never produce static POC/VA levels", () => {
  for (const profileMetric of ["delta", "average-trade-size"]) {
    const result = calculateOrderFlowProfile(weightedBars, { profileMetric, profileSide: "total" });
    assert.deepEqual([result.poc, result.vah, result.val], [null, null, null]);
  }
});

test("small averages remain numeric and inputs are not mutated", () => {
  const cell = level(100, 0.0004, 0, { count: 2, buyCount: 2, sellCount: 0 });
  const input = bar(1, [cell]);
  const before = { ...cell };
  const result = calculateOrderFlowProfile([input], { profileMetric: "average-trade-size", profileSide: "buy" });
  assert.equal(result.levels[0].value, 0.0002);
  assert.deepEqual(cell, before);
  assert.equal(input.cells.get(100), cell);
});
