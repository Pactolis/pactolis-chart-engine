import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { buildChartAnalysisSnapshot } from "../dist/features/chart/analysisSnapshot.js";

const BASE_TIME = Date.UTC(2024, 0, 1);

function cell(priceBin, buyVol, sellVol, count, buyCount, sellCount) {
  return { priceBin, buyVol, sellVol, count, buyCount, sellCount };
}

function bar(startTime, open, close, cells) {
  const values = [...cells.values()];
  const buy = values.reduce((sum, item) => sum + item.buyVol, 0);
  const sell = values.reduce((sum, item) => sum + item.sellVol, 0);
  return {
    startTime,
    open,
    high: Math.max(open, close) + 2,
    low: Math.min(open, close) - 2,
    close,
    volume: buy + sell,
    delta: buy - sell,
    count: values.reduce((sum, item) => sum + (item.count ?? 0), 0),
    deltaBySize: [1, -1],
    cells,
    hasRef: true,
  };
}

function context(drawings = []) {
  return {
    market: "BINANCE_FUTURES:btcusdt",
    profileSettings: { enabled: false, mode: "visible", valueAreaPercent: .7, showPoc: true, showVah: true, showVal: true },
    previousWeekStrategySettings: { enabled: false, visible: {}, groups: [], levels: [], labelFormat: "label", presets: [] },
    previousWeekStrategyLevels: [],
    mondayRangeSettings: { enabled: false, visible: {}, groups: [], levels: [], labelFormat: "label", presets: [] },
    mondayRangeLevels: [],
    nakedPocs: [],
    referenceLevels: [
      { id: "btc-open", market: "BINANCE_FUTURES:btcusdt", family: "open", period: "daily", sourceStart: BASE_TIME, sourceEnd: BASE_TIME + 86_400_000, price: 100, age: 0, complete: false, label: "D-OPEN", color: "#fff" },
      { id: "btc-val", market: "BINANCE_FUTURES:btcusdt", family: "valueArea", period: "weekly", sourceStart: BASE_TIME, sourceEnd: BASE_TIME + 604_800_000, valueAreaKind: "val", price: 96, age: 0, complete: true, label: "PW-VAL", color: "#fff" },
      { id: "btc-vah", market: "BINANCE_FUTURES:btcusdt", family: "valueArea", period: "weekly", sourceStart: BASE_TIME, sourceEnd: BASE_TIME + 604_800_000, valueAreaKind: "vah", price: 104, age: 0, complete: true, label: "PW-VAH", color: "#fff" },
    ],
    drawings: { listForMarket: () => structuredClone(drawings) },
  };
}

const revision = { revision: 1, market: "BINANCE_FUTURES:btcusdt", canonical: { status: "complete", market: "BINANCE_FUTURES:btcusdt", runKey: "x", generation: 1, revision: 1, failedPeriods: [] } };

function build(drawings = []) {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([
    bar(BASE_TIME, 99, 101, new Map([
      [99, cell(99, 4, 1, 5, 4, 1)],
      [100, cell(100, 5, 2, 7, 5, 2)],
      [101, cell(101, 2, 6, 8, 2, 6)],
    ])),
    bar(BASE_TIME + 60_000, 101, 103, new Map([
      [101, cell(101, 3, 1, 4, 3, 1)],
      [102, cell(102, 7, 2, 9, 7, 2)],
      [103, cell(103, 6, 4, 10, 6, 4)],
    ])),
  ]);
  return buildChartAnalysisSnapshot({
    panelId: "p",
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    intervalMs: 60_000,
    selectionGeneration: 1,
    series,
    analysis: context(drawings),
    analysisRevision: revision,
    indicators: [],
    options: { now: BASE_TIME + 180_000 },
  });
}

test("snapshot exposes real footprint price cells without inventing counts", () => {
  const snapshot = build();
  assert.equal(snapshot.candles.length, 2);
  const footprint = snapshot.candles[0].footprint;
  assert.equal(footprint.length, 3);
  assert.deepEqual(footprint.find((item) => item.price === 100), {
    price: 100,
    buyVolume: 5,
    sellVolume: 2,
    totalVolume: 7,
    delta: 3,
    tradeCount: 7,
    buyTradeCount: 5,
    sellTradeCount: 2,
  });
  assert.deepEqual(snapshot.candles[0].deltaBySize, [1, -1]);
});

test("Open and VAL/VAH keep semantic reference-level metadata", () => {
  const snapshot = build();
  const open = snapshot.levels.find((item) => item.id === "btc-open");
  const val = snapshot.levels.find((item) => item.id === "btc-val");
  const vah = snapshot.levels.find((item) => item.id === "btc-vah");
  assert.equal(open.family, "open");
  assert.equal(open.period, "daily");
  assert.equal(open.complete, false);
  assert.equal(val.family, "valueArea");
  assert.equal(val.valueAreaKind, "val");
  assert.equal(vah.valueAreaKind, "vah");
});

test("Fibonacci, anchored VWAP and Fixed Range Order Flow Profile carry calculated values", () => {
  const drawings = [
    { id: "fib", type: "fibonacci-retracement", points: [{ time: BASE_TIME, price: 90 }, { time: BASE_TIME + 60_000, price: 110 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:btcusdt" },
    { id: "avwap", type: "anchored-vwap", points: [{ time: BASE_TIME, price: 100 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:btcusdt" },
    { id: "profile", type: "fixed-range-volume-profile", points: [{ time: BASE_TIME, price: 99 }, { time: BASE_TIME + 60_000, price: 103 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:btcusdt", profileMetric: "volume", profileSide: "total", valueAreaPercent: .7 },
  ];
  const snapshot = build(drawings);
  const fib = snapshot.drawings.find((item) => item.id === "fib");
  const avwap = snapshot.drawings.find((item) => item.id === "avwap");
  const profile = snapshot.drawings.find((item) => item.id === "profile");
  assert.equal(fib.numericallySupported, true);
  assert.ok(fib.levels.some((item) => item.ratio === 0.5 && item.price === 100));
  assert.equal(avwap.series[0].key, "avwap");
  assert.ok(Number.isFinite(avwap.summary.lastValue));
  assert.equal(profile.numericallySupported, true);
  assert.equal(profile.profile.metric, "volume");
  assert.ok(Number.isFinite(profile.profile.poc));
  assert.ok(Number.isFinite(profile.profile.vah));
  assert.ok(Number.isFinite(profile.profile.val));
  assert.ok(profile.profile.bins.length > 0);
});
