import test from "node:test";
import assert from "node:assert/strict";
import { rsi, stochasticRsi } from "../dist/core/analysis/calc/ta.js";

const bar = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });

test("RSI seeds from the first period real price changes", () => {
  const points = rsi([bar(0, 10), bar(1, 11), bar(2, 10), bar(3, 11)], 3);
  assert.deepEqual(points.slice(0, 3).map((point) => point.value), [null, null, null]);
  assert.ok(Math.abs(points[3].value - 66.66666666666666) < 1e-10);
});

test("RSI warmup shift propagates to StochRSI rather than emitting an early value", () => {
  const bars = [10, 11, 10, 11, 12, 11, 12, 13, 12, 13].map((close, index) => bar(index, close));
  const rsiPoints = rsi(bars, 3);
  assert.equal(rsiPoints[2].value, null);
  assert.notEqual(rsiPoints[3].value, null);
  const stoch = stochasticRsi(bars, 3, 2, 2);
  assert.equal(stoch[3].k, null, "StochRSI must still honor its own RSI/window warmup after the corrected seed");
});
