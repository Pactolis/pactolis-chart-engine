import test from "node:test";
import assert from "node:assert/strict";
import { PriceScaleModel, PriceScaleMode } from "../dist/core/model/priceScale.js";
import { PriceRange } from "../dist/core/model/priceRange.js";
import { priceTickStep, smallestLabelStep } from "../dist/core/model/priceTickStep.js";
import { buildPriceMarks } from "../dist/core/model/priceTickMarkBuilder.js";

test("price tick step chooses decimal-friendly steps from label precision", () => {
  assert.equal(priceTickStep(1.5, 1, 0.08, smallestLabelStep(2)), 0.1);
});

test("price tick step walks the whole-unit ladder and never exceeds the covering decade", () => {
  assert.equal(priceTickStep(1000, 0, 3.5, 1), 4);
  assert.equal(priceTickStep(1000, 0, 2.2, 1), 2.5);
  assert.equal(priceTickStep(1000, 0, 45, 1), 50);
  assert.equal(priceTickStep(150, 100, 500, 1), 100);
});

test("price tick step stops at the label precision", () => {
  assert.equal(priceTickStep(1.5, 1, 0.0001, smallestLabelStep(2)), 0.01);
  assert.equal(priceTickStep(1.5, 1, 0.0001, smallestLabelStep(0)), 1);
  assert.equal(priceTickStep(5, 5, 1, smallestLabelStep(1)), 0.1);
});

test("price tick builder creates bounded, formatted normal-scale marks", () => {
  const priceScale = new PriceScaleModel();
  const marks = buildPriceMarks({
    priceScale,
    height: 300,
    priceTop: 200,
    pricePerPx: (200 - 100) / 300,
    pricePrecision: 2,
    fontSize: 11,
    tickMarkDensity: priceScale.tickMarkDensity(),
    entireTextOnly: true,
  });

  assert.ok(marks.length > 0);
  assert.ok(marks.every((mark) => mark.coord >= 0 && mark.coord <= 299));
  assert.ok(marks.every((mark) => /^\d+\.\d{2}$/.test(mark.label)));
  for (let i = 1; i < marks.length; i++) {
    assert.ok(Math.abs(marks[i].coord - marks[i - 1].coord) >= 25);
  }
});

test("price scale model exposes marks in active viewport scale-space", () => {
  const priceScale = new PriceScaleModel();
  const marks = priceScale.marks({
    height: 400,
    priceTop: 500,
    pricePerPx: 1,
    pricePrecision: 0,
    fontSize: 11,
    entireTextOnly: true,
  });

  assert.ok(marks.length > 0);
  assert.ok(marks.every((mark) => Number.isFinite(mark.logical)));
  assert.ok(marks.every((mark) => Number.isFinite(mark.price)));
});

test("price tick builder formats logarithmic marks through the conversion layer", () => {
  const priceScale = new PriceScaleModel({ mode: PriceScaleMode.Logarithmic });
  const logicalRange = priceScale.rangeToLogical(new PriceRange(100, 400));
  assert.ok(logicalRange);

  const marks = priceScale.marks({
    height: 320,
    priceTop: logicalRange.maxValue(),
    pricePerPx: logicalRange.length() / 320,
    pricePrecision: 2,
    fontSize: 11,
    entireTextOnly: true,
  });

  assert.ok(marks.length > 0);
  assert.ok(marks.every((mark) => mark.price > 0));
  assert.ok(marks.some((mark) => mark.label.includes(".")));
});

test("price tick builder keeps BTC logarithmic narrow-range marks visible", () => {
  const priceScale = new PriceScaleModel({ mode: PriceScaleMode.Logarithmic });
  const logicalRange = priceScale.rangeToLogical(new PriceRange(62050, 62310));
  assert.ok(logicalRange);

  const marks = priceScale.marks({
    height: 900,
    priceTop: logicalRange.maxValue(),
    pricePerPx: logicalRange.length() / 900,
    pricePrecision: 1,
    fontSize: 11,
    entireTextOnly: true,
  });

  assert.ok(marks.length > 0, "log mode should not blank the price axis for BTC-like narrow ranges");
  assert.ok(marks.every((mark) => mark.coord >= 0 && mark.coord <= 899));
  assert.ok(marks.every((mark) => mark.price >= 62050 && mark.price <= 62310));
  assert.ok(marks.every((mark) => /^\d+\.\d$/.test(mark.label)));
});
