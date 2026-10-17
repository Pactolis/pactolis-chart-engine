import test from "node:test";
import assert from "node:assert/strict";
import { calculateVolumeProfile, sessionBars } from "../dist/core/analysis/volumeProfile.js";

function bar(time, levels) {
  return {
    startTime: time, open: 100, high: 103, low: 100, close: 102,
    volume: 0, delta: 0, count: 1, hasRef: true,
    cells: new Map(levels.map(([priceBin, buyVol, sellVol]) => [
      priceBin, { priceBin, buyVol, sellVol },
    ])),
  };
}

test("calculates deterministic POC and contiguous value area", () => {
  const result = calculateVolumeProfile([
    bar(1, [[100, 5, 5], [101, 20, 10], [102, 8, 2], [103, 4, 1]]),
  ], 0.7);
  assert.equal(result.poc, 101);
  assert.equal(result.val, 100);
  assert.equal(result.vah, 101);
  assert.equal(result.totalVolume, 55);
});

test("aggregates buy and sell volume across bars", () => {
  const result = calculateVolumeProfile([
    bar(1, [[100, 2, 3]]),
    bar(2, [[100, 5, 7]]),
  ]);
  assert.deepEqual(result.levels[0], {
    priceBin: 100, buyVol: 7, sellVol: 10, totalVol: 17,
  });
});

test("session mode selects the UTC day containing the anchor", () => {
  const day = Date.UTC(2026, 5, 19);
  const bars = [bar(day - 1, []), bar(day + 1000, []), bar(day + 2000, [])];
  assert.deepEqual(sessionBars(bars, day + 3000).map((item) => item.startTime), [
    day + 1000, day + 2000,
  ]);
});
