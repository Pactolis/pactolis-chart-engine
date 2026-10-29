import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { buildChartAnalysisSnapshot, countClosedBars } from "../dist/features/chart/analysisSnapshot.js";

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

test("countClosedBars correctly computes closed count across fast paths and binary search", () => {
  const intervalMs = 60_000;
  assert.equal(countClosedBars([], intervalMs, 100_000), 0);

  const singleBar = [{ startTime: 0, open: 1, high: 2, low: 0, close: 1, volume: 1, cells: new Map() }];
  assert.equal(countClosedBars(singleBar, intervalMs, 59_999), 0);
  assert.equal(countClosedBars(singleBar, intervalMs, 60_000), 1);
  assert.equal(countClosedBars(singleBar, intervalMs, 100_000), 1);

  const tenBars = Array.from({ length: 10 }, (_, index) => ({
    startTime: index * intervalMs,
    open: 1, high: 2, low: 0, close: 1, volume: 1, cells: new Map()
  }));

  // All closed: now >= last bar bucketEnd (10 * 60_000)
  assert.equal(countClosedBars(tenBars, intervalMs, 10 * intervalMs), 10);
  assert.equal(countClosedBars(tenBars, intervalMs, 11 * intervalMs), 10);

  // Last bar open: now < last bar bucketEnd but >= 9th bar bucketEnd (9 * 60_000)
  assert.equal(countClosedBars(tenBars, intervalMs, 10 * intervalMs - 1), 9);
  assert.equal(countClosedBars(tenBars, intervalMs, 9 * intervalMs), 9);

  // Bisect path: 5 bars closed
  assert.equal(countClosedBars(tenBars, intervalMs, 5 * intervalMs), 5);
  assert.equal(countClosedBars(tenBars, intervalMs, 5 * intervalMs + 30_000), 5);

  // Bisect path: 1 bar closed
  assert.equal(countClosedBars(tenBars, intervalMs, 1 * intervalMs), 1);

  // None closed: now < 1st bar bucketEnd
  assert.equal(countClosedBars(tenBars, intervalMs, intervalMs - 1), 0);
  assert.equal(countClosedBars(tenBars, intervalMs, -1), 0);
});

test("equivalence: binary search buildChartAnalysisSnapshot matches linear reference on 5000+ bars", () => {
  const intervalMs = 60_000;
  const barCount = 5_000;
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  const bars = Array.from({ length: barCount }, (_, index) => ({
    startTime: BASE_TIME + index * intervalMs,
    open: 100 + (index % 10),
    high: 110 + (index % 10),
    low: 90 + (index % 10),
    close: 105 + (index % 10),
    volume: 100 + index,
    delta: 10,
    count: 20,
    deltaBySize: [5, -5],
    cells: new Map(),
    hasRef: true,
  }));
  series.loadBars(bars);

  function linearReference(allBars, now, timeRange, maxCandles) {
    const closedBars = allBars.filter((b) => (b.startTime + intervalMs) <= now);
    const scopedBars = timeRange
      ? closedBars.filter((b) => (b.startTime + intervalMs) > timeRange.from && b.startTime <= timeRange.to)
      : closedBars;
    const selectedBars = scopedBars.slice(-maxCandles);
    const warnings = [];
    if (scopedBars.length > selectedBars.length) warnings.push(`Candle context is limited to the latest ${selectedBars.length} contiguous bars`);
    if (timeRange && !selectedBars.length) warnings.push("No closed candles intersect the visible time range");
    return {
      candleTimes: selectedBars.map((b) => b.startTime),
      warnings,
    };
  }

  const analysisCtx = context();

  // Case 1: No visibleTimeRange, last bar is still open
  {
    const now = BASE_TIME + (barCount - 1) * intervalMs + 30_000;
    const ref = linearReference(bars, now, null, 100);
    const snap = buildChartAnalysisSnapshot({
      panelId: "p",
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      intervalMs,
      selectionGeneration: 1,
      series,
      analysis: analysisCtx,
      analysisRevision: revision,
      indicators: [],
      options: { now, maxCandles: 100 },
    });
    assert.deepEqual(snap.candles.map((c) => c.time), ref.candleTimes);
    assert.equal(snap.candles.length, 100);
    assert.deepEqual(snap.warnings, ref.warnings);
    assert.equal(snap.lastClosedBarEnd, BASE_TIME + (barCount - 1) * intervalMs);
  }

  // Case 2: No visibleTimeRange, all bars closed
  {
    const now = BASE_TIME + barCount * intervalMs + 10_000;
    const ref = linearReference(bars, now, null, 100);
    const snap = buildChartAnalysisSnapshot({
      panelId: "p",
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      intervalMs,
      selectionGeneration: 1,
      series,
      analysis: analysisCtx,
      analysisRevision: revision,
      indicators: [],
      options: { now, maxCandles: 100 },
    });
    assert.deepEqual(snap.candles.map((c) => c.time), ref.candleTimes);
    assert.deepEqual(snap.warnings, ref.warnings);
    assert.equal(snap.lastClosedBarEnd, BASE_TIME + barCount * intervalMs);
  }

  // Case 3: visibleTimeRange covering slice (index 1000..1500), last bar open
  {
    const now = BASE_TIME + (barCount - 1) * intervalMs + 10_000;
    const timeRange = {
      from: BASE_TIME + 1000 * intervalMs + 1,
      to: BASE_TIME + 1500 * intervalMs,
    };
    const ref = linearReference(bars, now, timeRange, 100);
    const snap = buildChartAnalysisSnapshot({
      panelId: "p",
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      intervalMs,
      selectionGeneration: 1,
      series,
      analysis: analysisCtx,
      analysisRevision: revision,
      indicators: [],
      options: { now, visibleTimeRange: timeRange, maxCandles: 100 },
    });
    assert.deepEqual(snap.candles.map((c) => c.time), ref.candleTimes);
    assert.deepEqual(snap.warnings, ref.warnings);
  }

  // Case 4: visibleTimeRange covering slice (index 4500..5000), all bars closed
  {
    const now = BASE_TIME + barCount * intervalMs + 60_000;
    const timeRange = {
      from: BASE_TIME + 4500 * intervalMs,
      to: BASE_TIME + 5000 * intervalMs,
    };
    const ref = linearReference(bars, now, timeRange, 100);
    const snap = buildChartAnalysisSnapshot({
      panelId: "p",
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      intervalMs,
      selectionGeneration: 1,
      series,
      analysis: analysisCtx,
      analysisRevision: revision,
      indicators: [],
      options: { now, visibleTimeRange: timeRange, maxCandles: 100 },
    });
    assert.deepEqual(snap.candles.map((c) => c.time), ref.candleTimes);
    assert.deepEqual(snap.warnings, ref.warnings);
  }

  // Case 5: visibleTimeRange outside closed bars range (no intersection)
  {
    const now = BASE_TIME + 1000 * intervalMs;
    const timeRange = {
      from: BASE_TIME + 2000 * intervalMs,
      to: BASE_TIME + 3000 * intervalMs,
    };
    const ref = linearReference(bars, now, timeRange, 100);
    const snap = buildChartAnalysisSnapshot({
      panelId: "p",
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      intervalMs,
      selectionGeneration: 1,
      series,
      analysis: analysisCtx,
      analysisRevision: revision,
      indicators: [],
      options: { now, visibleTimeRange: timeRange, maxCandles: 100 },
    });
    assert.deepEqual(snap.candles.map((c) => c.time), ref.candleTimes);
    assert.equal(snap.candles.length, 0);
    assert.deepEqual(snap.warnings, ref.warnings);
  }
});
