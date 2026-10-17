import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { TimeScaleModel } from "../dist/core/model/timeScale.js";
import { footprintAutoscaleSource } from "../dist/core/model/footprintAutoscale.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { alignLabelCenter, axisLayoutForView } from "../dist/core/model/axisLayout.js";
import { DEFAULT_CHART_LAYOUT_OPTIONS } from "../dist/core/model/chartLayoutOptions.js";

function makeView({ width = 900, height = 500, colWidth = 84 } = {}) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height };
  view.priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;
  view.subPanesH = 0;
  view.colWidth = colWidth;
  return view;
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

function makeSeries(bars, { intervalMs = 60_000, priceStep = 1 } = {}) {
  const series = new FootprintSeries({ intervalMs, priceStep });
  series.loadBars(bars);
  return series;
}

function applyAutoscale(view, series, visibleRange = { from: 0, to: series.length }) {
  const range = view.priceScale.autoscaleRange(
    visibleRange,
    [footprintAutoscaleSource(series)],
    { minMove: series.config.priceStep },
  );
  if (range !== null) view.setScaleRange(range);
  return range;
}

test("scenario: auto-scale contains a large live candle spike with margins", () => {
  const view = makeView();
  const series = makeSeries([
    emptyBar(0, 1000, 1010, 990, 1005),
    emptyBar(60_000, 1005, 1020, 1000, 1010),
    emptyBar(120_000, 1010, 2500, 995, 2300),
  ], { intervalMs: 60_000, priceStep: 1 });

  const range = applyAutoscale(view, series);

  assert.ok(range);
  assert.equal(view.isPriceAutoScale(), true);
  assert.ok(view.priceOfY(view.area.top) > 2500, "top edge should leave margin above the spike high");
  assert.ok(view.priceOfY(view.area.top + view.area.height) < 990, "bottom edge should leave margin below the visible low");
  assert.ok(Number.isFinite(view.yOfPrice(2500)));
});

test("scenario: manual price scale does not auto-fit a later spike", () => {
  const view = makeView();
  view.fitPriceRange(990, 1020);
  const before = { priceTop: view.priceTop, pricePerPx: view.pricePerPx };
  view.setPriceAutoScale(false);

  const series = makeSeries([
    emptyBar(0, 1000, 1010, 990, 1005),
    emptyBar(60_000, 1005, 1020, 1000, 1010),
    emptyBar(120_000, 1010, 2500, 995, 2300),
  ], { intervalMs: 60_000, priceStep: 1 });

  const range = applyAutoscale(view, series);

  assert.equal(range, null);
  assert.equal(view.priceTop, before.priceTop);
  assert.equal(view.pricePerPx, before.pricePerPx);
});

test("scenario: auto-scale ignores off-screen extreme bars", () => {
  const view = makeView();
  const series = makeSeries([
    emptyBar(0, 1000, 5000, 900, 1100),
    emptyBar(60_000, 1000, 1015, 995, 1005),
    emptyBar(120_000, 1005, 1020, 1000, 1010),
  ], { intervalMs: 60_000, priceStep: 1 });

  const range = applyAutoscale(view, series, { from: 1, to: 3 });

  assert.ok(range);
  assert.ok(view.priceOfY(view.area.top) < 1100, "off-screen 5000 high should not drive the visible auto-scale range");
  assert.ok(view.priceOfY(view.area.top + view.area.height) < 995);
});

test("scenario: logarithmic auto-scale keeps small positive prices finite", () => {
  const view = makeView();
  view.setScaleMode("log");
  const series = makeSeries([
    emptyBar(0, 0.000001, 0.0000012, 0.0000009, 0.0000011),
    emptyBar(60_000, 0.0000011, 0.0000025, 0.000001, 0.0000022),
  ], { intervalMs: 60_000, priceStep: 0.0000001 });

  const range = applyAutoscale(view, series);

  assert.ok(range);
  assert.equal(view.isLogScale(), true);
  for (const price of [0.0000009, 0.0000012, 0.0000025]) {
    assert.ok(Number.isFinite(view.yOfPrice(price)), `${price} should have a finite y-coordinate`);
  }
  assert.ok(view.priceOfY(view.area.top) > 0.0000025);
  assert.ok(view.priceOfY(view.area.top + view.area.height) < 0.0000009);
});

test("scenario: projected time labels are aligned inside the plot time-axis area", () => {
  const view = makeView({ width: 900, height: 500, colWidth: 84 });
  const intervalMs = 15 * 60_000;
  const series = makeSeries([
    emptyBar(Date.UTC(2026, 5, 23, 12, 0), 100, 101, 99, 100),
    emptyBar(Date.UTC(2026, 5, 23, 12, 15), 100, 101, 99, 100),
    emptyBar(Date.UTC(2026, 5, 23, 12, 30), 100, 101, 99, 100),
  ], { intervalMs, priceStep: 1 });
  view.scrollToIndex(series.length - 1, 4);

  const layout = axisLayoutForView(view, view.area.width + view.priceAxisW, view.area.height + DEFAULT_CHART_LAYOUT_OPTIONS.timeAxisHeight);
  const marks = TimeScaleModel.fromSeries(series).marks(view, { maxLabelWidth: 40 });
  const projected = marks.filter((mark) => mark.whitespace);

  assert.ok(projected.length > 0, "right-side whitespace/future marks should be produced by the time-scale model");
  for (const mark of projected) {
    const labelWidth = 40;
    const labelX = alignLabelCenter(mark.coord, labelWidth, layout.timeAxisRect);
    assert.ok(labelX - labelWidth / 2 >= layout.timeAxisRect.left);
    assert.ok(labelX + labelWidth / 2 <= layout.cornerRect.left);
  }
});

test("scenario: time-scale grid marks cover both loaded and projected logical range", () => {
  const view = makeView({ width: 900, height: 500, colWidth: 36 });
  const intervalMs = 15 * 60_000;
  const series = makeSeries(Array.from({ length: 12 }, (_, index) =>
    emptyBar(Date.UTC(2026, 5, 23, 9, 0) + index * intervalMs, 100, 101, 99, 100),
  ), { intervalMs, priceStep: 1 });
  view.scrollToIndex(series.length - 1, 5);

  const marks = TimeScaleModel.fromSeries(series).marks(view, { maxLabelWidth: 40 });

  assert.ok(marks.some((mark) => !mark.whitespace), "loaded-data marks should still exist");
  assert.ok(marks.some((mark) => mark.whitespace), "projected whitespace marks should exist in the right offset area");
  assert.ok(marks.every((mark) => mark.coord >= view.area.left - 40));
  assert.ok(marks.every((mark) => mark.coord <= view.area.left + view.area.width + 40));
});
