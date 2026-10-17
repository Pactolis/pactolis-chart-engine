import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { buildIndicatorAnalysisSnapshot } from "../dist/features/indicators/analysisSnapshot.js";

function series() {
  const value = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  value.loadBars(Array.from({ length: 30 }, (_, index) => ({
    startTime: index * 60_000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
    delta: 0,
    count: 0,
    cells: new Map(),
    hasRef: true,
  })));
  return value;
}

function instance(id, period, visible = true, type = "rsi") {
  return { id, type, title: "RSI", visible, order: 0, placement: "separate-pane", paneHeight: 100, collapsed: false, settings: { period } };
}

function definition() {
  let calls = 0;
  const def = {
    name: "RSI",
    paneHeight: 100,
    defaultSettings: () => ({ period: 14 }),
    settingsSchema: { sections: [] },
    prepareData: (context) => {
      calls++;
      const period = Number(context.settings.period);
      return {
        status: "ok",
        meta: {
          series: [{ key: "rsi", label: "RSI", points: [{ time: context.series.at(context.range[1] - 1).startTime, value: period }] }],
        },
      };
    },
    // A draw method is deliberately present and must never be called by snapshot preparation.
    drawSubPane: () => { throw new Error("render path must not run"); },
  };
  return { def, calls: () => calls };
}

const chart = { market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000 };

test("same indicator type with different settings stays as separate numeric instances", () => {
  const data = series();
  const { def } = definition();
  const first = buildIndicatorAnalysisSnapshot(instance("rsi-7", 7), def, data, chart, [10, 30], 20);
  const second = buildIndicatorAnalysisSnapshot(instance("rsi-14", 14), def, data, chart, [10, 30], 20);
  assert.equal(first.instanceId, "rsi-7");
  assert.equal(second.instanceId, "rsi-14");
  assert.equal(first.parameters.period, 7);
  assert.equal(second.parameters.period, 14);
  assert.equal(first.series[0].samples.at(-1).value, 7);
  assert.equal(second.series[0].samples.at(-1).value, 14);
});

test("snapshot calculation does not execute draw methods and recomputes from current series/range", () => {
  const data = series();
  const { def, calls } = definition();
  const first = buildIndicatorAnalysisSnapshot(instance("rsi-14", 14), def, data, chart, [0, 10], 20);
  const second = buildIndicatorAnalysisSnapshot(instance("rsi-14", 14), def, data, chart, [10, 30], 20);
  assert.equal(calls(), 2);
  assert.notEqual(first.series[0].samples[0].time, second.series[0].samples[0].time);
});

test("hidden, timeframe-hidden, and unsupported indicator states remain explicit without inventing zero values", () => {
  const data = series();
  const { def, calls } = definition();
  const hidden = buildIndicatorAnalysisSnapshot(instance("hidden", 14, false), def, data, chart, [10, 30], 20);
  const timeframeHiddenInstance = instance("timeframe-hidden", 14);
  timeframeHiddenInstance.settings.timeframeVisibility = { minutes: { enabled: false } };
  const timeframeHidden = buildIndicatorAnalysisSnapshot(timeframeHiddenInstance, def, data, chart, [10, 30], 20);
  const unsupported = buildIndicatorAnalysisSnapshot(instance("unsupported", 14), { ...def, prepareData: undefined }, data, chart, [10, 30], 20);
  assert.equal(hidden.status, "hidden");
  assert.equal(timeframeHidden.status, "hidden");
  assert.deepEqual(hidden.series, []);
  assert.deepEqual(timeframeHidden.series, []);
  assert.equal(calls(), 0, "hidden indicators must not run prepareData");
  assert.equal(unsupported.status, "unsupported");
  assert.deepEqual(unsupported.series, []);
});

test("visible-range indicators preserve their real analysis scope", () => {
  const data = series();
  const { def } = definition();
  const profile = buildIndicatorAnalysisSnapshot(instance("profile", 14, true, "volume-profile"), def, data, chart, [10, 30], 20);
  assert.equal(profile.scope, "visible-range");
});

test("derivative point adapters export aligned numeric values and never replace missing OI with zero", () => {
  const data = series();
  const oiDefinition = {
    name: "Cross-Exchange OI",
    paneHeight: 100,
    defaultSettings: () => ({}),
    settingsSchema: { sections: [] },
    prepareData: () => ({
      status: "ok",
      meta: { interval: "1m", mode: "openInterestUsd", symbolCount: 2 },
      points: [
        { index: 28, candleStart: 28 * 60_000, candleEnd: 29 * 60_000, time: 28 * 60_000 + 10, openInterestUsd: Number.NaN, openInterestDeltaUsd: Number.NaN, value: Number.NaN, hasData: false },
        { index: 29, candleStart: 29 * 60_000, candleEnd: 30 * 60_000, time: 29 * 60_000 + 20, openInterestUsd: 123_000, openInterestDeltaUsd: 4_500, value: 123_000, hasData: true },
      ],
    }),
  };
  const snapshot = buildIndicatorAnalysisSnapshot(instance("oi", 14, true, "cross-exchange-open-interest"), oiDefinition, data, chart, [10, 30], 20);
  assert.equal(snapshot.status, "ok");
  const oi = snapshot.series.find((item) => item.key === "openInterestUsd");
  assert.deepEqual(oi.samples, [{ time: 29 * 60_000, value: 123_000, sourceTime: 29 * 60_000 + 20 }]);
  assert.equal(oi.unit, "USD");
  assert.equal(snapshot.series.some((item) => item.samples.some((sample) => sample.time === 28 * 60_000 && sample.value === 0)), false);
});

test("options GEX adapter exports price levels and USD exposure from the prepared surface", () => {
  const data = series();
  const gexDefinition = {
    name: "Options GEX Wall",
    paneHeight: 0,
    defaultSettings: () => ({}),
    settingsSchema: { sections: [] },
    prepareData: () => ({
      status: "ok",
      points: [],
      meta: {
        base: "BTC",
        surface: {
          timestamp: 123456,
          spotPrice: 60_000,
          totalGrossGexUsd: 2_500_000,
          callTotalGrossGexUsd: 1_500_000,
          putTotalGrossGexUsd: 1_000_000,
          strikeNetGexCrossing: 59_500,
          strikeNetGexCrossingKind: "inferred-net",
          callWall: 62_000,
          putWall: 58_000,
          maxPain: null,
          callWallZone: { priceLow: 61_800, priceHigh: 62_200, confidence: 0.8 },
        },
      },
    }),
  };
  const snapshot = buildIndicatorAnalysisSnapshot(instance("gex", 14, true, "options-gex-wall"), gexDefinition, data, chart, [10, 30], 20);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.series.find((item) => item.key === "callWall").unit, "price");
  assert.equal(snapshot.series.find((item) => item.key === "totalGrossGexUsd").unit, "USD");
  assert.equal(snapshot.series.find((item) => item.key === "callWallZoneConfidence").unit, "%");
  assert.equal(snapshot.summary.strikeNetGexCrossingKind, "inferred-net");
  assert.equal(snapshot.summary.maxPain, null);
});
