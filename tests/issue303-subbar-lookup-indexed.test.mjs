import test from "node:test";
import assert from "node:assert/strict";
import {
  heatmapTierFor,
  lastHeatmapSubBar,
  liveHeatmapSubBar,
} from "../dist/features/orderbook/heatmapModel.js";

const DAY_MS = 24 * 60 * 60_000;

test("#303: lastHeatmapSubBar / liveHeatmapSubBar avoid 365-730 Map.get misses on sparse 12M ranges", () => {
  const tier1d = heatmapTierFor(365 * DAY_MS);
  assert.equal(tier1d.name, "1d");

  const t0 = Date.UTC(2025, 0, 1);
  const t1 = Date.UTC(2026, 0, 1);
  const t2 = Date.UTC(2027, 0, 1);

  let getCount = 0;
  const rawMap = new Map([
    [t0 + 10 * DAY_MS, { t: t0 + 10 * DAY_MS, cells: [[100, 50, 50]] }],
  ]);
  const countedMap = {
    get size() { return rawMap.size; },
    keys() { return rawMap.keys(); },
    get(k) { getCount++; return rawMap.get(k); },
  };
  const sortedTimes = [t0 + 10 * DAY_MS];

  // Empty/sparse year 2026..2027 with sortedTimes index -> O(log N) lookup, <= 2 Map.get calls
  const miss = lastHeatmapSubBar(countedMap, t1, t2, tier1d, sortedTimes);
  assert.equal(miss, undefined);
  assert.ok(getCount <= 2, `expected <= 2 Map.get calls on empty 12M year, got ${getCount}`);

  getCount = 0;
  const liveHit = liveHeatmapSubBar(countedMap, t1, t2, tier1d, sortedTimes);
  assert.equal(liveHit?.t, t0 + 10 * DAY_MS);
  assert.ok(getCount <= 4, `expected <= 4 Map.get calls on live fallback, got ${getCount}`);
});
