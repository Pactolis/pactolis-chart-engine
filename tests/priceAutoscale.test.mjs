import test from "node:test";
import assert from "node:assert/strict";
import { PriceRange } from "../dist/core/model/priceRange.js";
import { PriceScaleModel, PriceScaleMode } from "../dist/core/model/priceScale.js";
import { toLog } from "../dist/core/model/priceScaleConversions.js";
import { footprintAutoscaleSource } from "../dist/core/model/footprintAutoscale.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";

function source(priceRange, visible = true) {
  return {
    visible: () => visible,
    autoscaleInfo: () => ({ priceRange }),
  };
}

function emptyBar(time, open, high, low, close) {
  return {
    startTime: time,
    open,
    high,
    low,
    close,
    volume: 0,
    delta: 0,
    count: 0,
    cells: new Map(),
    hasRef: true,
  };
}

test("price autoscale pipeline merges visible source ranges and applies scale margins", () => {
  const priceScale = new PriceScaleModel();
  const range = priceScale.autoscaleRange(
    { from: 0, to: 10 },
    [source(new PriceRange(100, 200)), source(new PriceRange(80, 220))],
    { minMove: 1 },
  );

  assert.ok(range);
  // Data span 140 with top=0.2, bottom=0.1 means full span = 140 / 0.7 = 200.
  assert.equal(range.minValue(), 60);
  assert.equal(range.maxValue(), 260);
});

test("price autoscale pipeline is inactive when autoScale is disabled", () => {
  const priceScale = new PriceScaleModel({ autoScale: false });
  const range = priceScale.autoscaleRange(
    { from: 0, to: 10 },
    [source(new PriceRange(100, 200))],
    { minMove: 1 },
  );

  assert.equal(range, null);
});

test("price autoscale pipeline respects logarithmic mode in scale-space", () => {
  const priceScale = new PriceScaleModel({ mode: PriceScaleMode.Logarithmic });
  const range = priceScale.autoscaleRange(
    { from: 0, to: 10 },
    [source(new PriceRange(100, 400))],
    { minMove: 1 },
  );

  assert.ok(range);
  const formula = priceScale.getLogFormula();
  assert.ok(range.minValue() < toLog(100, formula));
  assert.ok(range.maxValue() > toLog(400, formula));
});

test("footprint autoscale source uses only the visible logical bar range", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([
    emptyBar(0, 10, 12, 9, 11),
    emptyBar(60_000, 11, 50, 10, 49),
    emptyBar(120_000, 49, 55, 40, 41),
  ]);

  const info = footprintAutoscaleSource(series).autoscaleInfo({ from: 1, to: 3 });
  assert.deepEqual(info?.priceRange?.toRaw(), { minValue: 10, maxValue: 55 });
});
