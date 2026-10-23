import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { SIZE_BUCKET_COUNT_V1, SIZE_BUCKET_LIMITS_V1, addDeltaBySize } from "../dist/core/analysis/calc/ta.js";

const ACTIVE_TIME = Date.UTC(2020, 0, 2);
const zeros = () => new Array(SIZE_BUCKET_COUNT_V1).fill(0);
// Independent oracle for the size bucket of a notional, written as a plain walk over the limits.
const bucketOf = (notional) => {
  let index = 0;
  while (index < SIZE_BUCKET_LIMITS_V1.length && notional >= SIZE_BUCKET_LIMITS_V1[index]) index++;
  return index;
};

test("addDeltaBySize updates a normalized array in place", () => {
  const target = zeros();
  const result = addDeltaBySize(target, 50_000, 2);
  assert.equal(result, target);
  assert.deepEqual(target, [0, 0, 0, 0, 2, 0, 0, 0, 0, 0]);
  assert.equal(addDeltaBySize(target, 50_000, -0.5), target);
  assert.equal(target[4], 1.5);
});

test("addDeltaBySize builds a normalized copy for anything that is not a writable, finite bucket array", () => {
  const fresh = addDeltaBySize(undefined, 500, 3);
  assert.deepEqual(fresh, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  const short = [1, 2, 3];
  const grown = addDeltaBySize(short, 2_000_000, 4);
  assert.deepEqual(grown, [1, 2, 3, 0, 0, 0, 0, 0, 4, 0]);
  assert.deepEqual(short, [1, 2, 3], "the caller's array is left alone");

  const long = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  assert.deepEqual(addDeltaBySize(long, 1, 1), [2, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(long.length, 12);

  const dirty = [1, Number.NaN, Number.POSITIVE_INFINITY, 4, 5, 6, 7, 8, 9, Number.NEGATIVE_INFINITY];
  assert.deepEqual(addDeltaBySize(dirty, 1, 1), [2, 0, 0, 4, 5, 6, 7, 8, 9, 0]);
  assert.ok(Number.isNaN(dirty[1]), "the caller's array is left alone");

  const frozen = Object.freeze(zeros());
  const copy = addDeltaBySize(frozen, 1, 5);
  assert.notEqual(copy, frozen);
  assert.equal(copy[0], 5);
  assert.deepEqual([...frozen], zeros());

  const typed = new Float64Array(SIZE_BUCKET_COUNT_V1);
  const converted = addDeltaBySize(typed, 1, 6);
  assert.ok(Array.isArray(converted));
  assert.equal(converted[0], 6);
  assert.equal(typed[0], 0);

  const holey = new Array(SIZE_BUCKET_COUNT_V1);
  assert.deepEqual(addDeltaBySize(holey, 1, 7), [7, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("addDeltaBySize heals a bucket that overflowed on the next trade, as a rebuild would", () => {
  let stored = zeros();
  stored = addDeltaBySize(stored, 1, Number.MAX_VALUE);
  stored = addDeltaBySize(stored, 1, Number.MAX_VALUE);
  assert.equal(stored[0], Number.POSITIVE_INFINITY);
  stored = addDeltaBySize(stored, 20_000, 1);
  assert.deepEqual(stored, [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
});

test("live trades accumulate per-bucket signed quantity on one array per bar", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  const expected = zeros();
  // price x qty is exact for each pair, so the notional lands on the intended side of every limit.
  const fills = [
    [10, 1], [450, 2], [250, 4], [9_999, 1], [5_000, 2], [30_000, 1], [99_999, 1],
    [25_000, 4], [400_000, 1], [999_999, 1], [500_000, 2], [4_999_999, 1], [1_250_000, 4], [8_000_000, 1],
  ];
  let stored;
  fills.forEach(([price, qty], index) => {
    const isBuy = index % 3 !== 0;
    series.addTrade({ time: ACTIVE_TIME + index, price, qty, isBuy });
    expected[bucketOf(price * qty)] += isBuy ? qty : -qty;
    const bar = series.at(0);
    stored ??= bar.deltaBySize;
    assert.equal(bar.deltaBySize, stored, "the same array keeps being updated within the bar");
    assert.deepEqual(bar.deltaBySize, expected);
  });
  const bar = series.at(0);
  assert.equal(bar.deltaBySize.reduce((sum, value) => sum + value, 0), bar.delta);
  assert.equal(bar.deltaBySize.length, SIZE_BUCKET_COUNT_V1);
  assert.ok(expected.every((value) => value !== 0), "every bucket was exercised");
});

test("each bar of a series accumulates into its own array", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  series.addTrade({ time: ACTIVE_TIME + 1, price: 100, qty: 1, isBuy: true });
  series.addTrade({ time: ACTIVE_TIME + 60_001, price: 100, qty: 2, isBuy: false });
  series.addTrade({ time: ACTIVE_TIME + 2, price: 100, qty: 4, isBuy: true });
  const [first, second] = series.listReadonly();
  assert.notEqual(first.deltaBySize, second.deltaBySize);
  assert.deepEqual(first.deltaBySize, [5, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(second.deltaBySize, [-2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("a history bar's own bucket array is normalized by the first live trade, never rewritten", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  const history = [5, 0, 0, 0, 0, 0, 0, 0, 0];
  series.loadBars([{
    startTime: ACTIVE_TIME, open: 100, high: 100, low: 100, close: 100,
    volume: 5, delta: 5, count: 1, cells: new Map(), hasRef: true, deltaBySize: history,
  }]);
  series.addTrade({ time: ACTIVE_TIME + 1, price: 100, qty: 2, isBuy: false });
  assert.deepEqual(series.at(0).deltaBySize, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(history, [5, 0, 0, 0, 0, 0, 0, 0, 0], "the loaded array was too short to adopt, so it is left untouched");
});
