import test from "node:test";
import assert from "node:assert/strict";
import { niceStepForPrice, reconcilePriceStep, quantizeToStep, neighbourBin } from "../dist/core/priceStep.js";

test("niceStepForPrice computes a sensible step per price magnitude", () => {
  assert.equal(niceStepForPrice(1576), 0.5);   // ETH ~1576 → 0.5 (NOT 10)
  assert.equal(niceStepForPrice(100_000), 50); // BTC ~100k → 50
  assert.equal(niceStepForPrice(150), 0.05);   // SOL ~150 → 0.05
  assert.equal(niceStepForPrice(0), 10);       // no price → fallback
});

test("reconcilePriceStep overrides a clearly-wrong canonical step (ETH 10-USD bins)", () => {
  // ETH synced with a foreign step of 10 while the price-derived step is 0.5 → use computed.
  assert.equal(reconcilePriceStep(10, 0.5), 0.5);
  // A correctly-synced market keeps its canonical step (hash consistency).
  assert.equal(reconcilePriceStep(0.5, 0.5), 0.5);
  // Within the tolerance factor (ratio 2 ≤ 8): keep canonical.
  assert.equal(reconcilePriceStep(1, 0.5), 1);
  // Canonical wrong in the other direction (too small): use computed.
  assert.equal(reconcilePriceStep(0.5, 50), 50);
});

test("reconcilePriceStep falls back gracefully when an input is missing", () => {
  assert.equal(reconcilePriceStep(undefined, 0.5), 0.5);
  assert.equal(reconcilePriceStep(0.5, undefined), 0.5);
  assert.equal(reconcilePriceStep(undefined, undefined), undefined);
  assert.equal(reconcilePriceStep(0, 0.5), 0.5);
});

// (21) neighbourBin is the canonical way to address the cell one step above/below a
// `cell.priceBin` -- plain `bin +/- step` misses the toPrecision(15)-normalized key
// `quantizeToStep` produces when that neighbour cell was actually created.
test("quantizeToStep normalizes fractional-step float noise the same way FootprintSeries bins cells", () => {
  assert.equal(quantizeToStep(3 * 0.05, 0.05), 0.15);
  assert.equal(quantizeToStep(4 * 0.05, 0.05), 0.2);
  assert.equal(quantizeToStep(101.7, 1), 101);
});

test("neighbourBin matches the quantized key even where raw +/- step float arithmetic misses it", () => {
  const step = 0.05;
  const bin = quantizeToStep(3 * step, step); // 0.15
  // The documented failure case: 0.15 - 0.05 !== the stored 0.1 key.
  assert.notEqual(bin - step, quantizeToStep(2 * step, step));
  assert.equal(neighbourBin(bin, step, -1), quantizeToStep(2 * step, step));
  assert.equal(neighbourBin(bin, step, 1), quantizeToStep(4 * step, step));
});

// The definition `quantizeToStep` is held to: snap to a tick, then `tick * step` rounded to 15
// significant digits through a string. The implementation skips the string for short decimal
// steps, so every result is compared against this one bit for bit (including the sign of zero).
function quantizeByString(value, step) {
  const scaled = value / step;
  const nearest = Math.round(scaled);
  const tick = Math.abs(scaled - nearest) <= 1e-10 * Math.max(1, Math.abs(scaled)) ? nearest : Math.floor(scaled);
  return Number((tick * step).toPrecision(15));
}

function stepUp(x) {
  const view = new Float64Array([x]);
  new BigInt64Array(view.buffer)[0] += x >= 0 ? 1n : -1n;
  return view[0];
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const DECIMAL_STEPS = [1, 10, 50, 100, 0.5, 0.25, 0.1, 0.05, 0.01, 0.001, 0.0001, 1e-6, 1e-8, 2.5, 0.025, 5, 25, 0.3, 0.7, 1.1, 12.5, 0.15, 123456.789, 0.123456789012, 1000];
// No short decimal form, or out of the range the fast path covers: all of these keep the string round trip.
const OTHER_STEPS = [1 / 3, 2 / 3, 0.1 + 0.2, Math.PI, 1e-16, 1e-300, 1e14, 1e15, 1e16, 1e20, 1e300, Number.MAX_VALUE, 0, -1, -0.05, Number.NaN, Number.POSITIVE_INFINITY];

test("quantizeToStep matches the 15-digit string definition for decimal steps", () => {
  const random = lcg(20260422);
  for (const step of DECIMAL_STEPS) {
    for (let tick = 0; tick <= 1_500; tick++) {
      const grid = tick * step;
      for (const value of [grid, stepUp(grid), -stepUp(-grid), grid + step, grid - step, grid + step * 0.4999999999, grid + step * 0.5000000001]) {
        assert.ok(Object.is(quantizeToStep(value, step), quantizeByString(value, step)), `step ${step} value ${value}`);
      }
    }
    for (let i = 0; i < 1_500; i++) {
      const tick = Math.floor(random() * 10 ** (1 + Math.floor(random() * 16)));
      const value = tick * step + (random() - 0.5) * step;
      assert.ok(Object.is(quantizeToStep(value, step), quantizeByString(value, step)), `step ${step} value ${value}`);
      const bin = quantizeToStep(value, step);
      for (const direction of [1, -1]) {
        assert.ok(Object.is(neighbourBin(bin, step, direction), quantizeByString(bin + direction * step, step)), `step ${step} bin ${bin}`);
      }
    }
  }
});

test("quantizeToStep matches the string definition for steps and values outside the decimal fast path", () => {
  const random = lcg(7);
  const values = [0, -0, 1, -1, 0.1, 100_000.05, 1e-300, -1e-300, 5e-324, 1e15, 1e21, 1e300, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < 200; i++) values.push((random() - 0.1) * 10 ** Math.floor(random() * 20));
  for (const step of [...OTHER_STEPS, ...DECIMAL_STEPS]) {
    for (const value of values) {
      assert.ok(Object.is(quantizeToStep(value, step), quantizeByString(value, step)), `step ${step} value ${value}`);
    }
  }
});

test("quantizeToStep keeps a decimal step's result right when other steps are used in between", () => {
  const sequence = [[100.05, 0.05], [100.05, 10], [100.05, 1 / 3], [100.05, 0.05], [100.05, 0.1], [-0.0001, 0.05], [100.05, 0.05], [100.05, Number.NaN], [100.05, 0.05]];
  for (const [value, step] of sequence) {
    assert.ok(Object.is(quantizeToStep(value, step), quantizeByString(value, step)), `step ${step} value ${value}`);
  }
  assert.equal(quantizeToStep(100.05, 0.05), 100.05);
  assert.equal(quantizeToStep(-1e-300, 25), 0);
  assert.ok(Object.is(quantizeToStep(-1e-300, 25), 0), "a snap to -0 comes back as 0");
});
