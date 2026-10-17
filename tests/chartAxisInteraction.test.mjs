import test from "node:test";
import assert from "node:assert/strict";
import { PriceScaleMode, View } from "../dist/core/engine/view.js";
import { DEFAULT_CHART_LAYOUT_OPTIONS } from "../dist/core/model/chartLayoutOptions.js";
import { dragScaleFactor, hitTestChartAxis } from "../dist/features/chart/axisInteraction.js";

function makeView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 700, height: 480 };
  view.priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;
  view.subPanesH = 80;
  return view;
}

test("chart axis hit testing separates plot, price axis, time axis, and corner", () => {
  const view = makeView();
  assert.equal(hitTestChartAxis(view, 120, 120), "plot");
  assert.equal(hitTestChartAxis(view, 710, 120), "price-axis");
  assert.equal(hitTestChartAxis(view, 120, 570), "time-axis");
  assert.equal(hitTestChartAxis(view, 710, 570), "corner-axis");
});



test("chart axis hit testing uses chart layout options for time-axis height", () => {
  const view = new View({}, { priceAxisWidth: 80, timeAxisHeight: 40 });
  view.area = { left: 0, top: 0, width: 700, height: 480 };
  view.subPanesH = 80;

  assert.equal(hitTestChartAxis(view, 120, 599), "time-axis");
  assert.equal(hitTestChartAxis(view, 710, 599), "corner-axis");
  assert.equal(hitTestChartAxis(view, 120, 601), "plot");
});

test("dragScaleFactor keeps bounded wheel-style vertical scaling", () => {
  assert.ok(dragScaleFactor(-80) < 1);
  assert.ok(dragScaleFactor(80) > 1);
  assert.equal(dragScaleFactor(-10000), 0.25);
  assert.equal(dragScaleFactor(10000), 4);
});

test("price axis up drag narrows the centered price range without changing X scale", () => {
  const view = makeView();
  view.colWidth = 84;
  view.offsetX = -1200;
  view.priceTop = 110;
  view.pricePerPx = 0.1;

  const previousColWidth = view.colWidth;
  const previousOffsetX = view.offsetX;
  const previousCenter = view.priceOfY(view.area.top + view.area.height / 2);

  view.startPriceAxisScale(240);
  view.scalePriceAxisTo(160);
  view.endPriceAxisScale();

  assert.equal(view.colWidth, previousColWidth);
  assert.equal(view.offsetX, previousOffsetX);
  assert.ok(view.pricePerPx < 0.1);
  assert.ok(Math.abs(view.priceOfY(view.area.top + view.area.height / 2) - previousCenter) < 1e-9);
});

test("price axis down drag expands the centered price range without changing X scale", () => {
  const view = makeView();
  view.colWidth = 84;
  view.offsetX = -1200;
  view.priceTop = 110;
  view.pricePerPx = 0.1;

  const previousCenter = view.priceOfY(view.area.top + view.area.height / 2);

  view.startPriceAxisScale(240);
  view.scalePriceAxisTo(320);
  view.endPriceAxisScale();

  assert.ok(view.pricePerPx > 0.1);
  assert.ok(Math.abs(view.priceOfY(view.area.top + view.area.height / 2) - previousCenter) < 1e-9);
});

test("price scale mode names follow Normal and Logarithmic internally", () => {
  const view = makeView();
  assert.equal(view.priceScaleMode, PriceScaleMode.Normal);
  assert.equal(view.scaleMode, "linear");

  view.setScaleMode("log");
  assert.equal(view.priceScaleMode, PriceScaleMode.Logarithmic);
  assert.equal(view.scaleMode, "log");

  view.setScaleMode(PriceScaleMode.Normal);
  assert.equal(view.priceScaleMode, PriceScaleMode.Normal);
  assert.equal(view.scaleMode, "linear");
});

test("time axis right drag compresses columns and preserves Y scale", () => {
  const view = makeView();
  view.colWidth = 84;
  view.offsetX = -1200;
  view.priceTop = 110;
  view.pricePerPx = 0.1;

  const previousPriceTop = view.priceTop;
  const previousPricePerPx = view.pricePerPx;
  const startX = 300;
  const currentX = 380;
  const rightEdgeIndex = view.indexOfX(view.area.left + view.area.width);

  view.scaleTimeAxisTo(startX, currentX, view.colWidth, view.offsetX);

  assert.equal(view.priceTop, previousPriceTop);
  assert.equal(view.pricePerPx, previousPricePerPx);
  assert.ok(view.colWidth < 84);
  assert.ok(Math.abs(view.indexOfX(view.area.left + view.area.width) - rightEdgeIndex) < 1e-9);
});

test("time axis left drag expands columns and preserves Y scale", () => {
  const view = makeView();
  view.colWidth = 84;
  view.offsetX = -1200;
  view.priceTop = 110;
  view.pricePerPx = 0.1;

  const previousPriceTop = view.priceTop;
  const previousPricePerPx = view.pricePerPx;
  const startX = 300;
  const currentX = 220;
  const rightEdgeIndex = view.indexOfX(view.area.left + view.area.width);

  view.scaleTimeAxisTo(startX, currentX, view.colWidth, view.offsetX);

  assert.equal(view.priceTop, previousPriceTop);
  assert.equal(view.pricePerPx, previousPricePerPx);
  assert.ok(view.colWidth > 84);
  assert.ok(Math.abs(view.indexOfX(view.area.left + view.area.width) - rightEdgeIndex) < 1e-9);
});

test("time scale reset fits available columns and latest-bar position", () => {
  const view = makeView();
  view.colWidth = 42;
  view.offsetX = -3200;

  view.resetTimeScale(100, 1);

  const spacing = view.area.width / (100 + 1 - 1);
  assert.equal(view.colWidth, spacing);
  assert.equal(view.xOfIndex(99), view.area.left + view.area.width - spacing);
});

test("price scale controls read and update the model-owned state", () => {
  const view = makeView();

  assert.equal(view.isPriceAutoScale(), true);
  assert.equal(view.isLogScale(), false);

  view.setPriceAutoScale(false);
  assert.equal(view.priceScale.state().autoScale, false);
  assert.equal(view.isPriceAutoScale(), false);

  view.resetPriceScale();
  assert.equal(view.priceScale.state().autoScale, true);
  assert.equal(view.isPriceAutoScale(), true);

  view.setScaleMode("log");
  assert.equal(view.priceScale.state().mode, PriceScaleMode.Logarithmic);
  assert.equal(view.isLogScale(), true);

  view.setScaleMode("linear");
  assert.equal(view.priceScale.state().mode, PriceScaleMode.Normal);
  assert.equal(view.isLogScale(), false);
});
