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
