import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";

globalThis.$state ??= (value) => value;

const [
  { buildIndicatorAnalysisSnapshot },
  { getIndicatorDefinition },
] = await Promise.all([
  import("../dist/features/indicators/analysisSnapshot.js"),
  import("../dist/features/indicators/registry.js"),
]);

const HOUR = 60 * 60 * 1000;
const BASE_TIME = Date.UTC(2024, 0, 1);

function bar(index) {
  const close = 40_000 + index * 10;
  return {
    startTime: BASE_TIME + index * HOUR,
    open: close - 5,
    high: close + 10,
    low: close - 10,
    close,
    volume: 100 + index,
    delta: 0,
    count: 10,
    cells: new Map(),
    hasRef: true,
  };
}

function instance(type, settings) {
  return {
    id: `${type}-context`,
    type,
    title: type,
    visible: true,
    paneId: "main",
    order: 0,
    placement: "price-overlay",
    settings,
  };
}

function buildSeries(length = 240) {
  const series = new FootprintSeries({ intervalMs: HOUR, priceStep: 1 });
  series.loadBars(Array.from({ length }, (_, index) => bar(index)));
  return series;
}

test("AI indicator context exports a long moving average as contiguous bounded real price samples", () => {
  const series = buildSeries();
  const indicator = instance("moving-average", {
    lines: [{ id: "ma-200", method: "sma", period: 200, timeframe: "chart", color: "#fff", enabled: true }],
    lineWidth: 1.5,
    showLastValueLabel: true,
    showPlotLabel: true,
    showChartLabels: false,
  });
  const snapshot = buildIndicatorAnalysisSnapshot(
    indicator,
    getIndicatorDefinition("moving-average"),
    series,
    { market: "BINANCE_FUTURES:btcusdt", timeframe: "1h", intervalMs: HOUR },
    [140, 240],
    100,
  );

  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.series.length, 1);
  assert.equal(snapshot.series[0].key, "ma-ma-200");
  assert.equal(snapshot.series[0].unit, "price");
  assert.equal(snapshot.series[0].samples.length, 41);
  assert.ok(snapshot.series[0].samples.every((sample) => Number.isFinite(sample.value)));
  assert.equal(snapshot.series[0].samples[0].time, BASE_TIME + 199 * HOUR);
  assert.equal(snapshot.series[0].samples.at(-1).time, BASE_TIME + 239 * HOUR);
});

test("AI indicator context represents the full calculable rolling VWAP tail while using earlier history", () => {
  const series = buildSeries();
  const indicator = instance("vwap", {
    lines: [{
      id: "rolling-7d",
      enabled: true,
      family: "rolling",
      period: "daily",
      rollingWindowDays: 7,
      color: "#fff",
      showBands: false,
      bandSigma: 1,
      bandColor: "#fff",
    }],
    lineWidth: 1.5,
    showLastValueLabel: true,
    showPlotLabel: true,
    showChartLabels: false,
  });
  const snapshot = buildIndicatorAnalysisSnapshot(
    indicator,
    getIndicatorDefinition("vwap"),
    series,
    { market: "BINANCE_FUTURES:btcusdt", timeframe: "1h", intervalMs: HOUR },
    [140, 240],
    100,
  );

  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.series.length, 1);
  assert.equal(snapshot.series[0].key, "vwap-rolling-7d");
  assert.equal(snapshot.series[0].unit, "price");
  assert.equal(snapshot.series[0].samples.length, 72);
  assert.ok(snapshot.series[0].samples.every((sample) => Number.isFinite(sample.value)));
  const sampleTimes = snapshot.series[0].samples.map((sample) => sample.time);
  assert.ok(sampleTimes.every((time, index) => index === 0 || time > sampleTimes[index - 1]));
  assert.equal(sampleTimes[0], BASE_TIME + 168 * HOUR);
  assert.equal(sampleTimes.at(-1), BASE_TIME + 239 * HOUR);
});