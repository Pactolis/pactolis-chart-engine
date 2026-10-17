import test from "node:test";
import assert from "node:assert/strict";
import { PriceRange } from "../dist/core/model/priceRange.js";

test("price range exposes cloneable min max length and empty state", () => {
  const range = new PriceRange(10, 25);
  const clone = range.clone();

  assert.equal(range.minValue(), 10);
  assert.equal(range.maxValue(), 25);
  assert.equal(range.length(), 15);
  assert.equal(range.isEmpty(), false);
  assert.notEqual(clone, range);
  assert.equal(clone.equals(range), true);
  assert.equal(new PriceRange(10, 10).isEmpty(), true);
});

test("price range merge keeps finite values and returns a new range", () => {
  const range = new PriceRange(10, 20);
  const merged = range.merge(new PriceRange(5, 30));

  assert.deepEqual(merged.toRaw(), { minValue: 5, maxValue: 30 });
  assert.deepEqual(range.toRaw(), { minValue: 10, maxValue: 20 });
  assert.deepEqual(new PriceRange(Number.NaN, 12).merge(new PriceRange(8, Number.NaN)).toRaw(), {
    minValue: 8,
    maxValue: 12,
  });
});

test("price range scales around center and shifts without changing responsibilities", () => {
  const range = new PriceRange(100, 200);
  range.scaleAroundCenter(0.5);
  assert.deepEqual(range.toRaw(), { minValue: 125, maxValue: 175 });

  range.shift(10);
  assert.deepEqual(range.toRaw(), { minValue: 135, maxValue: 185 });
});

test("price range raw conversion is explicit", () => {
  assert.equal(PriceRange.fromRaw(null), null);
  assert.deepEqual(PriceRange.fromRaw({ minValue: 1, maxValue: 2 })?.toRaw(), { minValue: 1, maxValue: 2 });
});
