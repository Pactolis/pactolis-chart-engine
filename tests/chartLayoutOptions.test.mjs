import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHART_LAYOUT_OPTIONS, normalizeChartLayoutOptions } from "../dist/core/model/chartLayoutOptions.js";

test("chart layout defaults centralize price and time axis dimensions", () => {
  assert.equal(DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth, 62);
  assert.equal(DEFAULT_CHART_LAYOUT_OPTIONS.timeAxisHeight, 22);
  assert.throws(() => {
    DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth = 80;
  }, TypeError);
});


test("chart layout options normalization rejects invalid axis dimensions", () => {
  const options = normalizeChartLayoutOptions({ priceAxisWidth: -10, timeAxisHeight: Number.NaN });
  assert.equal(options.priceAxisWidth, DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth);
  assert.equal(options.timeAxisHeight, DEFAULT_CHART_LAYOUT_OPTIONS.timeAxisHeight);
});
