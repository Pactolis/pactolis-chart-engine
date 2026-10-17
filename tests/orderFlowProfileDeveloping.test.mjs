import test from "node:test";
import assert from "node:assert/strict";
import { calculateOrderFlowProfile } from "../dist/core/analysis/orderFlowProfile.js";

function bar(time, levels, cellRevision = 0) {
  return {
    startTime: time,
    open: 100,
    high: 104,
    low: 99,
    close: 102,
    volume: 0,
    delta: 0,
    count: 1,
    hasRef: true,
    cellRevision,
    cells: new Map(levels.map((level) => [level.priceBin, level])),
  };
}

function level(priceBin, buyVol, sellVol, counts = {}) {
  return { priceBin, buyVol, sellVol, ...counts };
}

const options = {
  profileMetric: "volume",
  profileSide: "total",
  valueAreaPercent: 0.7,
  developing: true,
};

test("each developing point equals an independently calculated prefix", () => {
  const bars = [
    bar(1, [level(100, 5, 0), level(101, 1, 0)]),
    bar(2, [level(101, 10, 0)]),
    bar(3, [level(102, 20, 0)]),
  ];
  const result = calculateOrderFlowProfile(bars, options);
  assert.equal(result.developing.length, bars.length);
  for (let i = 0; i < bars.length; i++) {
    const expected = calculateOrderFlowProfile(bars.slice(0, i + 1), { ...options, developing: false });
    const point = result.developing[i];
    assert.deepEqual([point.poc, point.val, point.vah], [expected.poc, expected.val, expected.vah]);
    assert.equal(point.valid, expected.dataComplete);
  }
});

test("last valid developing levels equal static levels", () => {
  const bars = [
    bar(1, [level(100, 3, 1)]),
    bar(2, [level(101, 8, 2)]),
  ];
  const result = calculateOrderFlowProfile(bars, options);
  const last = result.developing.at(-1);
  assert.deepEqual([last.poc, last.val, last.vah], [result.poc, result.val, result.vah]);
});

test("adding a future dominant bar does not rewrite prior developing points", () => {
  const firstTwo = [
    bar(1, [level(100, 10, 0)]),
    bar(2, [level(101, 12, 0)]),
  ];
  const earlier = calculateOrderFlowProfile(firstTwo, options).developing;
  const later = calculateOrderFlowProfile([
    ...firstTwo,
    bar(3, [level(103, 1000, 0)]),
  ], options).developing;
  assert.deepEqual(later.slice(0, 2), earlier);
});

test("a newly introduced future price bin does not change past tie decisions", () => {
  const first = bar(1, [level(100, 10, 0), level(102, 10, 0)]);
  const before = calculateOrderFlowProfile([first], options).developing[0];
  const after = calculateOrderFlowProfile([
    first,
    bar(2, [level(101, 100, 0)]),
  ], options).developing[0];
  assert.deepEqual(after, before);
  assert.equal(before.poc, 100);
});

test("missing required count data breaks affected developing levels without inventing continuity", () => {
  const bars = [
    bar(1, [level(100, 10, 0, { count: 2, buyCount: 2, sellCount: 0 })]),
    bar(2, [level(101, 5, 0, { count: 1 })]),
    bar(3, [level(102, 2, 0, { count: 1, buyCount: 1, sellCount: 0 })]),
  ];
  const result = calculateOrderFlowProfile(bars, {
    profileMetric: "trade-count",
    profileSide: "buy",
    valueAreaPercent: 0.7,
    developing: true,
  });
  assert.equal(result.developing[0].valid, true);
  assert.equal(result.developing[1].valid, false);
  assert.equal(result.developing[2].valid, false);
  assert.deepEqual([result.developing[1].poc, result.developing[1].vah, result.developing[1].val], [null, null, null]);
});

test("replacing an open bar contribution recalculates instead of double counting", () => {
  const v1 = [
    bar(1, [level(100, 10, 0)]),
    bar(2, [level(101, 5, 0)], 1),
  ];
  const v2 = [
    v1[0],
    bar(2, [level(101, 20, 0)], 2),
  ];
  const first = calculateOrderFlowProfile(v1, options);
  const second = calculateOrderFlowProfile(v2, options);
  assert.equal(first.levels.find((item) => item.priceBin === 101).value, 5);
  assert.equal(second.levels.find((item) => item.priceBin === 101).value, 20);
  assert.equal(second.levels.find((item) => item.priceBin === 100).value, 10);
});

test("historical correction changes that prefix and later prefixes on recalculation", () => {
  const initial = [
    bar(1, [level(100, 10, 0)], 1),
    bar(2, [level(101, 9, 0)], 1),
  ];
  const corrected = [
    bar(1, [level(100, 1, 0)], 2),
    initial[1],
  ];
  const before = calculateOrderFlowProfile(initial, options).developing;
  const after = calculateOrderFlowProfile(corrected, options).developing;
  assert.notDeepEqual(after, before);
  assert.equal(before[0].poc, 100);
  assert.equal(after[1].poc, 101);
});

test("reversed fixed-range selection inputs are equivalent after caller selection", () => {
  const bars = [
    bar(1, [level(100, 1, 0)]),
    bar(2, [level(101, 5, 0)]),
    bar(3, [level(102, 2, 0)]),
  ];
  const select = (from, to) => {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return bars.filter((item) => item.startTime >= start && item.startTime <= end);
  };
  const a = calculateOrderFlowProfile(select(1, 3), options);
  const b = calculateOrderFlowProfile(select(3, 1), options);
  assert.deepEqual(a, b);
});
