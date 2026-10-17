import test from "node:test";
import assert from "node:assert/strict";
import { niceStepForPrice, reconcilePriceStep, quantizeToStep, neighbourBin } from "../dist/core/priceStep.js";

test("niceStepForPrice computes a sensible step per price magnitude", () => {
  assert.equal(niceStepForPrice(1576), 0.5);   // ETH ~1576 → 0.5 (NOT 10)
  assert.equal(niceStepForPrice(100_000), 50); // BTC ~100k → 50
  assert.equal(niceStepForPrice(150), 0.05);   // SOL ~150 → 0.05
  assert.equal(niceStepForPrice(0), 10);       // no price → fallback
});

test("reconcilePriceStep overrides a clearly-wrong canonical step (TASK: ETH 10-USD bins)", () => {
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
