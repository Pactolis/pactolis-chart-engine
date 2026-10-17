import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { createIndicatorScale } = await import("../dist/features/indicators/scale/indicatorScale.js");
const { cvdIndicatorDefinition } = await import("../dist/features/indicators/builtins/cvd.js");
const { rsiIndicatorDefinition } = await import("../dist/features/indicators/builtins/rsi.js");
const { deltaIndicatorDefinition } = await import("../dist/features/indicators/builtins/delta.js");
const { volumeIndicatorDefinition } = await import("../dist/features/indicators/builtins/volume.js");
const { tradeCountIndicatorDefinition } = await import("../dist/features/indicators/builtins/tradeCount.js");
const { rangeForPoints: liquidationsRange } = await import("../dist/features/indicators/builtins/liquidations.js");
const { rangeForPoints: fundingRange } = await import("../dist/features/indicators/builtins/fundingRegime.js");
const { rangeForPoints: positioningRange } = await import("../dist/features/indicators/builtins/futuresPositioning.js");

const T0 = Date.UTC(2026, 0, 1);

function seriesOf(count, barAt) {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 0.01 });
  series.loadBars(Array.from({ length: count }, (_, i) => ({
    startTime: T0 + i * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
    cellRevision: 0,
    ...barAt(i),
  })));
  return series;
}

function prepare(definition, series, range, settings = {}) {
  const merged = { ...definition.defaultSettings(), ...settings };
  return definition.prepareData({
    ctx: {}, view: {}, series, rect: { top: 0, height: 100 }, range,
    instance: { id: `${definition.type}-${range.join("-")}`, type: definition.type, title: definition.type, visible: true, paneId: "pane", order: 0, settings: merged },
    settings: merged,
    requestRefresh() {},
  });
}

function plottedExtent(prepared) {
  const values = prepared.meta.series.flatMap((plot) => plot.points.map((point) => point.value)).filter((value) => value !== null);
  return { min: Math.min(...values), max: Math.max(...values) };
}

test("a CVD line far from zero fits the visible values and follows the scroll", () => {
  // Every bar adds +10, so the cumulative line runs from 10 to 400.
  const series = seriesOf(40, () => ({ delta: 10 }));

  const recent = prepare(cvdIndicatorDefinition, series, [20, 40], { bucketMode: "total" });
  assert.deepEqual({ min: recent.range.min, max: recent.range.max }, { min: 210, max: 400 });

  const earlier = prepare(cvdIndicatorDefinition, series, [0, 20], { bucketMode: "total" });
  assert.deepEqual({ min: earlier.range.min, max: earlier.range.max }, { min: 10, max: 200 });
});

test("an RSI range does not reach down to 50 when the visible RSI stays above it", () => {
  // Up 2, down 1: RSI settles well above 50.
  let close = 100;
  const series = seriesOf(160, (i) => {
    close += i % 2 === 0 ? 2 : -1;
    return { open: close, high: close + 0.5, low: close - 0.5, close };
  });

  const prepared = prepare(rsiIndicatorDefinition, series, [100, 160]);
  const extent = plottedExtent(prepared);
  assert.ok(extent.min > 50, `visible RSI minimum ${extent.min} should be above 50`);
  assert.equal(prepared.range.min, extent.min);
  assert.equal(prepared.range.max, extent.max);
});

test("histogram panes keep their zero base in view", () => {
  const series = seriesOf(10, (i) => ({ volume: 20 + i, delta: 5 + i }));

  const volume = prepare(volumeIndicatorDefinition, series, [0, 10]);
  assert.deepEqual({ min: volume.range.min, max: volume.range.max }, { min: 0, max: 29 });

  const delta = prepare(deltaIndicatorDefinition, series, [0, 10]);
  assert.deepEqual({ min: delta.range.min, max: delta.range.max }, { min: 0, max: 14 });
});

test("a two-sided histogram is not mirrored around zero", () => {
  // 12 volume with +6 delta: 5 buys and 1 sell per bar.
  const series = seriesOf(3, () => ({ volume: 12, delta: 6, count: 6 }));

  const prepared = prepare(tradeCountIndicatorDefinition, series, [0, 3], { mode: "count", directional: true });
  assert.deepEqual({ min: prepared.range.min, max: prepared.range.max }, { min: -1, max: 5 });

  const scale = createIndicatorScale(
    { mode: prepared.meta.scaleMode, min: prepared.range.min, max: prepared.range.max, baseline: prepared.range.baseline },
    { top: 0, bottom: 100 },
  );
  assert.deepEqual({ min: scale.min, max: scale.max }, { min: -1, max: 5 });
});

test("liquidations fit each side separately instead of mirroring the larger one", () => {
  const points = [
    { longLiquidationsUsd: 50, shortLiquidationsUsd: 200, liquidationDeltaUsd: 150 },
    { longLiquidationsUsd: 20, shortLiquidationsUsd: 0, liquidationDeltaUsd: -20 },
  ];
  const all = { showLong: true, showShort: true, showDelta: false };

  assert.deepEqual(liquidationsRange(points, all), { min: -50, max: 200, baseline: 0 });
  assert.deepEqual(liquidationsRange(points, { ...all, showLong: false }), { min: 0, max: 200, baseline: 0 });
  assert.deepEqual(liquidationsRange(points, { showLong: false, showShort: false, showDelta: true }), { min: -20, max: 150, baseline: 0 });
});

test("funding and positioning lines fit their values; OI delta bars keep zero", () => {
  assert.deepEqual(fundingRange([{ value: 0.01 }, { value: 0.012 }]), { min: 0.01, max: 0.012, baseline: 0 });
  assert.deepEqual(fundingRange([{ value: Number.NaN }]), { min: -0.0001, max: 0.0001, baseline: 0 });

  assert.deepEqual(positioningRange([{ value: 1.4 }, { value: 1.8 }], "globalLongShortRatio"), { min: 1.4, max: 1.8, baseline: 1 });
  assert.deepEqual(positioningRange([{ value: 5 }, { value: 10 }], "openInterestDeltaUsd"), { min: 0, max: 10, baseline: 0 });
});
