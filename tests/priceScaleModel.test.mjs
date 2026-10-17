import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRICE_SCALE_OPTIONS,
  PriceScaleModel,
  PriceScaleMode,
  normalizePriceScaleMode,
  priceScaleModeToLegacyScaleMode,
} from "../dist/core/model/priceScale.js";
import { PriceRange } from "../dist/core/model/priceRange.js";

function source(priceRange, visible = true) {
  return {
    visible: () => visible,
    autoscaleInfo: () => ({ priceRange }),
  };
}

test("price scale model defaults follow the reference naming policy", () => {
  const priceScale = new PriceScaleModel();
  const state = priceScale.state();

  assert.equal(state.autoScale, true);
  assert.equal(state.mode, PriceScaleMode.Normal);
  assert.equal(state.isInverted, false);
  assert.deepEqual(state.scaleMargins, { top: 0.2, bottom: 0.1 });
  assert.equal(state.tickMarkDensity, 2.5);
});

test("price scale model accepts legacy scale mode inputs without leaking them into internal state", () => {
  const priceScale = new PriceScaleModel();

  priceScale.setScaleMode("log");
  assert.equal(priceScale.mode(), PriceScaleMode.Logarithmic);
  assert.equal(priceScaleModeToLegacyScaleMode(priceScale.mode()), "log");

  priceScale.setScaleMode("linear");
  assert.equal(priceScale.mode(), PriceScaleMode.Normal);
  assert.equal(priceScaleModeToLegacyScaleMode(priceScale.mode()), "linear");

  priceScale.setMode({ mode: PriceScaleMode.Logarithmic, autoScale: false });
  assert.equal(priceScale.state().mode, PriceScaleMode.Logarithmic);
  assert.equal(priceScale.state().autoScale, false);
});

test("price scale options are defensively copied", () => {
  const priceScale = new PriceScaleModel({ scaleMargins: { top: 0.3, bottom: 0.2 } });
  const options = priceScale.options();
  options.scaleMargins.top = 0.9;

  assert.deepEqual(priceScale.scaleMargins(), { top: 0.3, bottom: 0.2 });
  assert.deepEqual(DEFAULT_PRICE_SCALE_OPTIONS.scaleMargins, { top: 0.2, bottom: 0.1 });
});

test("price scale mode normalization keeps Normal as the default internal mode", () => {
  assert.equal(normalizePriceScaleMode("linear"), PriceScaleMode.Normal);
  assert.equal(normalizePriceScaleMode("log"), PriceScaleMode.Logarithmic);
  assert.equal(normalizePriceScaleMode(PriceScaleMode.Normal), PriceScaleMode.Normal);
  assert.equal(normalizePriceScaleMode(PriceScaleMode.Logarithmic), PriceScaleMode.Logarithmic);
});


test("price scale model stores price ranges defensively", () => {
  const priceScale = new PriceScaleModel();
  const range = new PriceRange(100, 200);

  priceScale.setPriceRange(range);
  range.shift(100);

  assert.deepEqual(priceScale.priceRange()?.toRaw(), { minValue: 100, maxValue: 200 });

  const returnedRange = priceScale.priceRange();
  returnedRange?.shift(50);
  assert.deepEqual(priceScale.priceRange()?.toRaw(), { minValue: 100, maxValue: 200 });
  assert.equal(priceScale.isEmpty(), false);

  priceScale.setPriceRange(null);
  assert.equal(priceScale.priceRange(), null);
  assert.equal(priceScale.isEmpty(), true);
});


test("price scale mode switching converts stored ranges through the conversion layer", () => {
  const priceScale = new PriceScaleModel();
  priceScale.setPriceRange(new PriceRange(100, 400));

  priceScale.setScaleMode(PriceScaleMode.Logarithmic);
  const logicalRange = priceScale.priceRange();
  assert.ok(logicalRange);
  assert.notDeepEqual(logicalRange.toRaw(), { minValue: 100, maxValue: 400 });

  priceScale.setScaleMode(PriceScaleMode.Normal);
  const restoredRange = priceScale.priceRange();
  assert.ok(restoredRange);
  assert.ok(Math.abs(restoredRange.minValue() - 100) < 1e-9);
  assert.ok(Math.abs(restoredRange.maxValue() - 400) < 1e-9);
});

test("price scale log formula is updated from raw autoscale range", () => {
  const priceScale = new PriceScaleModel({ mode: PriceScaleMode.Logarithmic });
  const before = priceScale.getLogFormula();

  const range = priceScale.autoscaleRange(
    { from: 0, to: 10 },
    [source(new PriceRange(0.000001, 0.000002))],
    { minMove: 0.000001 },
  );

  assert.ok(range);
  const after = priceScale.getLogFormula();
  assert.ok(after.logicalOffset > before.logicalOffset);
});

test("price scale manual scale gesture owns snapshot and auto-scale transition", () => {
  const priceScale = new PriceScaleModel();
  priceScale.setPriceRange(new PriceRange(60, 120));

  priceScale.startScale(480, 240, new PriceRange(60, 120));
  assert.equal(priceScale.isAutoScale(), true, "startScale should only snapshot the gesture");

  const nextRange = priceScale.scaleTo(480, 160);
  assert.ok(nextRange);
  assert.equal(priceScale.isAutoScale(), false, "scaleTo should switch to manual scale");
  assert.ok(nextRange.length() < 60);
  assert.equal(priceScale.priceRange()?.equals(nextRange), true);

  priceScale.endScale();
  const afterEnd = priceScale.scaleTo(480, 140);
  assert.equal(afterEnd, null, "endScale should clear the gesture snapshot");
});

test("price scale reset restores auto scale and clears manual gesture", () => {
  const priceScale = new PriceScaleModel({ autoScale: false });
  priceScale.setPriceRange(new PriceRange(60, 120));
  priceScale.startScale(480, 240, new PriceRange(60, 120));

  priceScale.resetPriceScale();

  assert.equal(priceScale.isAutoScale(), true);
  assert.equal(priceScale.scaleTo(480, 160), null);
});
