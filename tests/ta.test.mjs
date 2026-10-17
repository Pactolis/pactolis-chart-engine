import test from "node:test";
import assert from "node:assert/strict";
import {
  simpleMovingAverage,
  exponentialMovingAverage,
  wilderSmooth,
  averageTrueRange,
  rollingSum,
  rollingMin,
  rollingMax,
  rsi,
  moneyFlowIndex,
  cci,
  deltaSeries,
  macd,
  kdj,
  createCompensatedSum,
  addCompensated,
} from "../dist/core/analysis/calc/ta.js";

function bar(time, close, extra = {}) {
  return { time, open: close, high: close, low: close, close, volume: 1, ...extra };
}

// --- (22) wilderSmooth: propagate a gap instead of coercing a missing value to 0 ---------

test("wilderSmooth propagates a gap for a non-finite input instead of coercing it to zero", () => {
  const values = [10, 10, 10, 10, 10, NaN, 10, 10, 10, 10];
  const result = wilderSmooth(values, 3);
  assert.equal(result[2], 10, "seeds from the mean of the first 3 values");
  assert.equal(result[4], 10);
  assert.equal(result[5], null, "the bad bar must show a gap, not a value pulled toward zero");
  assert.equal(result[6], 10, "recovers on the next valid bar using the untouched smoothed state");
  assert.equal(result[9], 10);
});

test("averageTrueRange (built on wilderSmooth) gaps on a bad bar instead of biasing ATR toward zero", () => {
  const mkBar = (t, h, l, c) => ({ time: t, open: c, high: h, low: l, close: c, volume: 1 });
  const bars = [
    mkBar(0, 101, 99, 100),
    mkBar(1, 102, 98, 100),
    mkBar(2, 103, 97, 100),
    mkBar(3, NaN, 96, 100), // bad bar -- non-finite high makes trueRange non-finite too
    mkBar(4, 104, 96, 100),
  ];
  const atr = averageTrueRange(bars, 3);
  assert.equal(atr[2], 4, "seed = mean of the first 3 true ranges (2, 4, 6)");
  assert.equal(atr[3], null, "a non-finite bar must gap ATR, not silently shrink it toward zero");
  assert.ok(atr[4] !== null && atr[4] > 0, "ATR recovers on the next valid bar");
});

// --- (24) exponentialMovingAverage: gap instead of carrying the previous value forward -----

test("exponentialMovingAverage gaps on a non-finite input instead of republishing the stale value", () => {
  const values = [1, 2, 3, 4, 5, NaN, 7, 8, 9, 10];
  const result = exponentialMovingAverage(values, 3);
  assert.equal(result[2], 2, "seeds from the mean of the first 3 values");
  assert.equal(result[4], 4);
  assert.equal(result[5], null, "the bad bar must gap the output, not carry the last EMA forward");
  assert.ok(result[6] !== null, "recovers on the next valid bar from the untouched internal state");
});

test("macd() never reports a signal value on a bar where macd itself is null (NUMERIC OUTPUT CHANGE, see finding 24)", () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(
    i,
    i === 20 ? NaN : 100 + Math.sin(i / 3) * 5, // one bad close in the middle of an otherwise clean series
  ));
  const points = macd(bars, 5, 10, 4);
  assert.equal(points[20].macd, null, "sanity: the bad bar actually does gap macd, or this test proves nothing");
  for (const point of points) {
    if (point.macd === null) {
      assert.equal(point.signal, null, `bar ${point.time}: signal must be null whenever macd is null`);
    }
  }
});

// --- (23) rsi / moneyFlowIndex: a flat series is neutral (50), not maximally overbought (100) ---

test("rsi returns 50 (neutral), not 100, for a perfectly flat closing series (NUMERIC OUTPUT CHANGE)", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100));
  assert.equal(rsi(bars, 14).at(-1).value, 50);
});

test("rsi still returns 100 for a genuine all-gains series (regression guard)", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, i));
  assert.equal(rsi(bars, 14).at(-1).value, 100);
});

test("moneyFlowIndex returns 50 (neutral), not 100, for a perfectly flat series (NUMERIC OUTPUT CHANGE)", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100, { volume: 10 }));
  assert.equal(moneyFlowIndex(bars, 14).at(-1).value, 50);
});

test("moneyFlowIndex still returns 100 for a genuine all-positive-flow series (regression guard)", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, i, { volume: 10 }));
  assert.equal(moneyFlowIndex(bars, 14).at(-1).value, 100);
});

// --- (27) kdj: RSV must be smoothed with wilderSmooth's alpha = 1/n, not EMA's 2/(n+1) -------

test("kdj() smooths RSV with wilderSmooth (alpha = 1/n), not exponentialMovingAverage (NUMERIC OUTPUT CHANGE)", () => {
  const bars = Array.from({ length: 30 }, (_, i) => {
    const close = 50 + 40 * Math.sin(i / 4);
    return { time: i, open: close, high: close + 5, low: close - 5, close, volume: 1 };
  });
  const period = 9, kSmoothing = 3, dSmoothing = 3;
  const points = kdj(bars, period, kSmoothing, dSmoothing);

  // Recompute RSV exactly as kdj() does and reference-smooth it with wilderSmooth directly --
  // if kdj() still used exponentialMovingAverage internally these would diverge immediately
  // after the shared seed value.
  const lows = rollingMin(bars.map((b) => b.low), period);
  const highs = rollingMax(bars.map((b) => b.high), period);
  const rsv = bars.map((b, index) => {
    const low = lows[index], high = highs[index];
    return low === null || high === null || high === low ? NaN : ((b.close - low) / (high - low)) * 100;
  });
  const expectedK = wilderSmooth(rsv, kSmoothing);
  const expectedD = wilderSmooth(expectedK.map((v) => v ?? NaN), dSmoothing);

  for (let i = 0; i < bars.length; i++) {
    assert.equal(points[i].k, expectedK[i], `k mismatch at index ${i}`);
    assert.equal(points[i].d, expectedD[i], `d mismatch at index ${i}`);
  }

  // Sanity: this is a real behaviour change versus the old EMA-based smoothing, not a
  // no-op refactor -- the two diverge on the very first bar after the shared seed value.
  const emaK = exponentialMovingAverage(rsv, kSmoothing);
  const seedIndex = expectedK.findIndex((v) => v !== null);
  assert.notEqual(points[seedIndex + 1].k, emaK[seedIndex + 1]);
});

// --- (29) cci / deltaSeries: an undefined case must be null, not an indistinguishable 0 ------

test("cci returns null, not 0, when meanDeviation is 0 (a flat window makes CCI undefined)", () => {
  const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100));
  assert.equal(cci(bars, 5).at(-1).value, null);
});

test("deltaSeries percent mode returns null, not 0, when volume is 0 (raw mode is unaffected)", () => {
  const bars = [bar(0, 1, { volume: 0, delta: 0 })];
  assert.equal(deltaSeries(bars, true)[0].value, null);
  assert.equal(deltaSeries(bars, false)[0].value, 0, "raw delta of 0 with 0 volume is a real reading, not undefined");
});

// --- (25) rollingMin/rollingMax: O(n) monotonic deque must match the naive slice+spread ------

function naiveRollingExtrema(values, period, fn) {
  const n = Math.max(1, Math.floor(period));
  return values.map((_v, index) => {
    if (index + 1 < n) return null;
    const window = values.slice(index + 1 - n, index + 1);
    if (!window.every(Number.isFinite)) return null;
    return fn(...window);
  });
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("rollingMin/rollingMax match the naive per-bar slice+spread implementation, including NaNs", () => {
  const rand = seededRandom(20260902);
  const values = Array.from({ length: 400 }, () => (rand() < 0.1 ? NaN : Math.round((rand() - 0.5) * 200)));
  for (const period of [1, 3, 5, 10, 30, 77]) {
    assert.deepEqual(rollingMin(values, period), naiveRollingExtrema(values, period, Math.min), `rollingMin period ${period}`);
    assert.deepEqual(rollingMax(values, period), naiveRollingExtrema(values, period, Math.max), `rollingMax period ${period}`);
  }
});

test("rollingMin/rollingMax do not throw RangeError for a large period (the old spread-based fn(...window) could)", () => {
  const N = 200_000;
  const period = 150_000; // spreading this many args into Math.max/Math.min throws in this runtime -- verified separately
  const values = Array.from({ length: N }, (_, i) => Math.sin(i * 0.001) * 1000);
  const result = rollingMax(values, period);
  assert.equal(result.length, N);
  let expectedLastMax = -Infinity;
  for (let i = N - period; i < N; i++) if (values[i] > expectedLastMax) expectedLastMax = values[i]; // reduce, no spread
  assert.equal(result[N - 1], expectedLastMax);
});

// --- (26) rolling accumulation must not drift on a long series (Kahan/Neumaier compensation) --

test("addCompensated keeps rounding drift near zero versus naive accumulation (classic adversarial series)", () => {
  const N = 100_000;
  const term = 0.1; // not exactly representable in float64 -- the textbook Kahan demonstration
  let naive = 0;
  for (let i = 0; i < N; i++) naive += term;
  const acc = createCompensatedSum();
  for (let i = 0; i < N; i++) addCompensated(acc, term);
  const expected = N * term;
  const naiveError = Math.abs(naive - expected);
  const compensatedError = Math.abs(acc.sum - expected);
  assert.ok(naiveError > 1e-9, "sanity: naive accumulation must actually drift here, or this test proves nothing");
  assert.ok(compensatedError < 1e-9, `compensated sum drifted too: ${acc.sum} vs expected ${expected}`);
  assert.ok(compensatedError <= naiveError, "compensated summation must be at least as accurate as naive accumulation");
});

test("simpleMovingAverage/rollingSum stay accurate on a long adversarial series (bounded drift)", () => {
  const N = 60_000;
  const period = 1_000;
  const values = Array.from({ length: N }, () => 0.1);
  const sma = simpleMovingAverage(values, period);
  const sum = rollingSum(values, period);
  for (const i of [period, 20_000, N - 1]) {
    assert.ok(Math.abs(sum[i] - period * 0.1) < 1e-9, `rollingSum drift at ${i}: ${sum[i]}`);
    assert.ok(Math.abs(sma[i] - 0.1) < 1e-9, `simpleMovingAverage drift at ${i}: ${sma[i]}`);
  }
});
