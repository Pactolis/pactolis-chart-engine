import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { DEFAULT_TIME_SCALE_OPTIONS, normalizeTimeScaleOptions, timeTickMaxLabelWidth } from "../dist/core/model/timeScaleOptions.js";
import { TimeScaleModel } from "../dist/core/model/timeScale.js";

function makeSeries({ start = Date.UTC(2026, 5, 23, 8, 0), intervalMs = 60_000, count = 20 } = {}) {
  const bars = Array.from({ length: count }, (_, index) => ({ startTime: start + index * intervalMs }));
  return {
    length: bars.length,
    config: { intervalMs },
    at: (index) => bars[index],
  };
}

test("time scale options own default horizontal geometry values", () => {
  const view = new View();
  assert.equal(view.colWidth, DEFAULT_TIME_SCALE_OPTIONS.barSpacing);
  assert.equal(view.timeScaleOptions.latestBarRightPaddingBars, DEFAULT_TIME_SCALE_OPTIONS.latestBarRightPaddingBars);
  assert.equal(view.timeScaleOptions.defaultScrollRightPaddingBars, DEFAULT_TIME_SCALE_OPTIONS.defaultScrollRightPaddingBars);
  assert.equal(view.timeScaleOptions.resetRightPaddingBars, DEFAULT_TIME_SCALE_OPTIONS.resetRightPaddingBars);
});

test("view scroll and reset defaults are backed by named time scale options", () => {
  const view = new View({
    barSpacing: 20,
    defaultScrollRightPaddingBars: 2,
    resetRightPaddingBars: 4,
  });
  view.area = { left: 0, top: 0, width: 500, height: 300 };

  view.scrollToIndex(10);
  assert.equal(view.xOfIndex(10), 500 - 2 * 20);

  view.colWidth = 35;
  view.resetTimeScale(11);
  const spacing = view.area.width / (11 + view.timeScaleOptions.resetRightPaddingBars - 1);
  assert.equal(view.colWidth, spacing);
  assert.equal(view.xOfIndex(10), view.area.left + view.area.width - view.timeScaleOptions.resetRightPaddingBars * spacing);
});

test("viewport clamp defaults are backed by named time scale options", () => {
  const view = new View({ barSpacing: 40, minVisibleBars: 5, clampEdgePaddingBars: 2 });
  view.area = { left: 0, top: 0, width: 400, height: 300 };

  view.offsetX = -100_000;
  view.clampOffsetX(20);
  assert.equal(view.offsetX, -(20 - 3) * 40);

  view.offsetX = 100_000;
  view.clampOffsetX(20);
  assert.equal(view.offsetX, 400 - 3 * 40);
});

test("time mark density uses derived label width from view time scale options", () => {
  const view = new View({ tickMarkMaxCharacterLength: 6, tickMarkFontSize: 11 });
  view.area = { left: 0, top: 0, width: 700, height: 300 };
  view.colWidth = 20;
  view.scrollToIndex(19, 1);

  const model = TimeScaleModel.fromSeries(makeSeries());
  assert.deepEqual(
    model.marks(view),
    model.marks(view, { maxLabelWidth: timeTickMaxLabelWidth(view.timeScaleOptions) }),
  );
});

test("time mark density still accepts an explicit label-width override", () => {
  const view = new View({ tickMarkMaxLabelWidth: 36 });
  assert.equal(timeTickMaxLabelWidth(view.timeScaleOptions), 36);
});

test("time scale options normalization rejects invalid geometry values", () => {
  const options = normalizeTimeScaleOptions({
    barSpacing: -1,
    minBarSpacing: 10,
    maxBarSpacing: 4,
    minVisibleBars: 0,
    tickMarkMaxCharacterLength: 0,
    tickMarkFontSize: -1,
    tickMarkMaxLabelWidth: Number.NaN,
  });

  assert.equal(options.barSpacing, 10);
  assert.equal(options.minBarSpacing, 10);
  assert.equal(options.maxBarSpacing, 10);
  assert.equal(options.minVisibleBars, DEFAULT_TIME_SCALE_OPTIONS.minVisibleBars);
  assert.equal(options.tickMarkMaxCharacterLength, DEFAULT_TIME_SCALE_OPTIONS.tickMarkMaxCharacterLength);
  assert.equal(options.tickMarkFontSize, DEFAULT_TIME_SCALE_OPTIONS.tickMarkFontSize);
  assert.equal(options.tickMarkMaxLabelWidth, null);
});

test("derived time tick label width follows reference-style character and font budget", () => {
  const options = normalizeTimeScaleOptions({ tickMarkMaxCharacterLength: 8, tickMarkFontSize: 11 });
  assert.equal(timeTickMaxLabelWidth(options), 75);

  const wider = normalizeTimeScaleOptions({ tickMarkMaxCharacterLength: 10, tickMarkFontSize: 11 });
  assert.ok(timeTickMaxLabelWidth(wider) > timeTickMaxLabelWidth(options));
});

test("the default fit aims for the host's column count and for 250 when it names none", () => {
  const desktop = new View();
  desktop.area = { left: 0, top: 0, width: 500, height: 300 };
  desktop.resetTimeScale(1000);
  const padding = desktop.timeScaleOptions.resetRightPaddingBars;
  assert.equal(DEFAULT_TIME_SCALE_OPTIONS.defaultFitColumns, 250);
  assert.equal(desktop.colWidth, 500 / (250 + padding - 1));

  const phone = new View({ defaultFitColumns: 60 });
  phone.area = { left: 0, top: 0, width: 500, height: 300 };
  phone.resetTimeScale(1000);
  assert.equal(phone.colWidth, 500 / (60 + padding - 1));
  assert.ok(phone.colWidth > desktop.colWidth * 3, "fewer columns, wider candles");

  phone.resetTimeScale(20);
  assert.equal(phone.colWidth, 500 / (20 + padding - 1), "a series shorter than the fit still fits whole");
});

test("default fit columns normalize to a whole number of at least one", () => {
  assert.equal(normalizeTimeScaleOptions({ defaultFitColumns: 80.9 }).defaultFitColumns, 80);
  assert.equal(normalizeTimeScaleOptions({ defaultFitColumns: 0.4 }).defaultFitColumns, 1, "a fraction still means one column");
  assert.equal(normalizeTimeScaleOptions({ defaultFitColumns: Number.NaN }).defaultFitColumns, 250);
  assert.equal(normalizeTimeScaleOptions({ defaultFitColumns: -5 }).defaultFitColumns, 250);
  assert.equal(normalizeTimeScaleOptions({ defaultFitColumns: 1 }).defaultFitColumns, 1);
});

test("a live view takes new display options in place and says whether anything changed", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 330, height: 420 };
  view.colWidth = 9;
  view.offsetX = -123;

  assert.equal(view.setDisplayOptions({}, {}), false, "the same defaults change nothing");
  assert.equal(view.chartLayoutOptions.density, "regular");

  assert.equal(view.setDisplayOptions({ defaultFitColumns: 70 }, { density: "compact" }), true);
  assert.equal(view.timeScaleOptions.defaultFitColumns, 70);
  assert.equal(view.chartLayoutOptions.density, "compact");
  assert.equal(view.chartLayoutOptions.timeAxisHeight, 32);
  assert.equal(view.colWidth, 9, "nothing moves; laying out again is the caller's job");
  assert.equal(view.offsetX, -123);
  assert.deepEqual({ ...view.area }, { left: 0, top: 0, width: 330, height: 420 });

  assert.equal(view.setDisplayOptions({ defaultFitColumns: 70 }, { density: "compact" }), false);
  assert.equal(view.setDisplayOptions({ defaultFitColumns: 70 }, { density: "compact", timeAxisHeight: 36 }), true);
  assert.equal(view.chartLayoutOptions.timeAxisHeight, 36);

  assert.equal(view.setDisplayOptions({}, {}), true, "back to the desktop defaults");
  assert.equal(view.timeScaleOptions.defaultFitColumns, 250);
  assert.equal(view.chartLayoutOptions.density, "regular");
  assert.equal(view.chartLayoutOptions.timeAxisHeight, 22);
});
