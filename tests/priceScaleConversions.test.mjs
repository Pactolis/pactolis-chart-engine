import test from "node:test";
import assert from "node:assert/strict";
import { PriceRange } from "../dist/core/model/priceRange.js";
import {
  canConvertPriceRangeFromLog,
  convertPriceRangeFromLog,
  convertPriceRangeToLog,
  fromLog,
  logFormulaForPriceRange,
  logFormulasAreSame,
  toLog,
} from "../dist/core/model/priceScaleConversions.js";

test("log conversion preserves sign and round-trips prices", () => {
  const formula = logFormulaForPriceRange(new PriceRange(100, 400));

  for (const price of [-250, -1, 0, 1, 250]) {
    const logical = toLog(price, formula);
    const restored = fromLog(logical, formula);
    assert.ok(Math.abs(restored - price) < 1e-9, `${price} should round-trip`);
  }
});

test("log conversion converts ranges explicitly", () => {
  const formula = logFormulaForPriceRange(new PriceRange(100, 400));
  const rawRange = new PriceRange(100, 400);
  const logicalRange = convertPriceRangeToLog(rawRange, formula);

  assert.ok(logicalRange);
  assert.ok(logicalRange.minValue() < logicalRange.maxValue());
  assert.equal(canConvertPriceRangeFromLog(logicalRange, formula), true);
  const restored = convertPriceRangeFromLog(logicalRange, formula);
  assert.ok(restored);
  assert.ok(Math.abs(restored.minValue() - 100) < 1e-9);
  assert.ok(Math.abs(restored.maxValue() - 400) < 1e-9);
});

test("log formula adapts to very small ranges", () => {
  const defaultFormula = logFormulaForPriceRange(new PriceRange(1, 2));
  const smallRangeFormula = logFormulaForPriceRange(new PriceRange(0.000001, 0.000002));

  assert.equal(defaultFormula.logicalOffset, 4);
  assert.ok(smallRangeFormula.logicalOffset > defaultFormula.logicalOffset);
  assert.equal(logFormulasAreSame(defaultFormula, smallRangeFormula), false);
});
