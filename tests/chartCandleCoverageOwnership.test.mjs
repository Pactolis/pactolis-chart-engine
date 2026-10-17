import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

function services(integrityReporter) {
  return {
    subscribeToTrades() { return () => {}; },
    fetchPriceStep: async () => 0.1,
    fetchPricePrecision: async () => 1,
    triggerAutoSync: () => {},
    ...(integrityReporter ? { acquirePipelineIntegrityReporter: () => integrityReporter } : {}),
  };
}

function historyBar(startTime) {
  return {
    startTime,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    delta: 4,
    count: 10,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells: new Map(),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime,
    cellRevision: 0,
  };
}

function liveOnlyBar(startTime) {
  return {
    startTime,
    open: 100.2,
    high: 100.2,
    low: 100.2,
    close: 100.2,
    volume: 1,
    delta: 1,
    count: 1,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells: new Map([[100.2, {
      priceBin: 100.2,
      buyVol: 1,
      sellVol: 0,
      count: 1,
      buyCount: 1,
      sellCount: 0,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
    }]]),
    hasRef: true,
    completeness: "provisional",
    sources: ["live"],
    updatedAt: startTime + 30_000,
    cellRevision: 1,
  };
}

function trade(market, startTime) {
  return {
    id: "11",
    time: startTime + 30_000,
    price: 100.2,
    qty: 1,
    isBuy: true,
    liquidation: false,
    market,
    source: "live",
    receivedAt: startTime + 30_000,
  };
}

function verifiedCoverage(market, startTime, interval) {
  return {
    schemaVersion: 1,
    source: "binance-klines",
    instrument: market,
    ownership: "snapshot",
    status: "verified",
    requestedFrom: startTime,
    requestedTo: startTime + interval - 1,
    snapshotAt: startTime + 2 * interval,
    closedThrough: startTime + 2 * interval - 1,
    reasonCode: null,
  };
}

function state({ generation = 0, startTime, interval, candidate, applied, deferred, candleCoverage }) {
  return {
    generation,
    requestedFrom: startTime,
    requestedTo: startTime + interval - 1,
    trades: [candidate],
    applied: new Set(applied ? [candidate] : []),
    deferred: new Set(deferred ? [candidate] : []),
    liveAfterBarrier: new Set([candidate]),
    watermark: null,
    retiredWatermarks: new Map(),
    candleCoverage,
  };
}

function cellVolume(bar) {
  let total = 0;
  for (const cell of bar?.cells.values() ?? []) total += cell.buyVol + cell.sellVol;
  return total;
}

test("verified candle ownership keeps snapshot aggregates while preserving an already-applied live footprint", () => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 3 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const candidate = trade(market, startTime);
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 0.1, services: services() });
  pipeline.series.loadBars([liveOnlyBar(startTime)]);
  pipeline.explicitHistoryReconcile = state({
    startTime, interval, candidate, applied: true, deferred: false,
    candleCoverage: verifiedCoverage(market, startTime, interval),
  });
  try {
    assert.equal(pipeline._applyExplicitHistorySnapshot(
      startTime, startTime + interval, [historyBar(startTime)], 0, "history-loaded", true, false,
    ), true);
    const bar = pipeline.series.get(startTime);
    assert.ok(bar);
    assert.deepEqual(
      { volume: bar.volume, delta: bar.delta, count: bar.count, open: bar.open, high: bar.high, low: bar.low, close: bar.close, cells: cellVolume(bar) },
      { volume: 10, delta: 4, count: 10, open: 100, high: 101, low: 99, close: 100.5, cells: 1 },
    );
  } finally { pipeline.dispose(); }
});

test("verified candle ownership replays a deferred trade into footprint only", () => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 3 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const candidate = trade(market, startTime);
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 0.1, services: services() });
  pipeline.explicitHistoryReconcile = state({
    startTime, interval, candidate, applied: false, deferred: true,
    candleCoverage: verifiedCoverage(market, startTime, interval),
  });
  try {
    assert.equal(pipeline._applyExplicitHistorySnapshot(
      startTime, startTime + interval, [historyBar(startTime)], 0, "history-loaded", true, false,
    ), true);
    const bar = pipeline.series.get(startTime);
    assert.ok(bar);
    assert.deepEqual(
      { volume: bar.volume, delta: bar.delta, count: bar.count, open: bar.open, high: bar.high, low: bar.low, close: bar.close, cells: cellVolume(bar) },
      { volume: 10, delta: 4, count: 10, open: 100, high: 101, low: 99, close: 100.5, cells: 1 },
    );
  } finally { pipeline.dispose(); }
});

test("unknown candle coverage preserves an overlapping live bucket and marks reconciliation degraded", () => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 3 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const candidate = trade(market, startTime);
  const degraded = [];
  const integrity = [];
  const reporter = { report: (value, detail) => integrity.push([value, detail]), dispose() {} };
  const pipeline = new ChartDataPipeline({
    market, intervalMs: interval, priceStep: 0.1, services: services(reporter),
    onDataDegraded: (value, detail) => degraded.push([value, detail]),
  });
  pipeline.series.loadBars([liveOnlyBar(startTime)]);
  pipeline.explicitHistoryReconcile = state({
    startTime, interval, candidate, applied: true, deferred: false, candleCoverage: null,
  });
  try {
    assert.equal(pipeline._applyExplicitHistorySnapshot(
      startTime, startTime + interval, [historyBar(startTime)], 0, "history-loaded", true, false,
    ), true);
    const bar = pipeline.series.get(startTime);
    assert.ok(bar);
    assert.deepEqual(
      { volume: bar.volume, delta: bar.delta, count: bar.count, close: bar.close, cells: cellVolume(bar) },
      { volume: 1, delta: 1, count: 1, close: 100.2, cells: 1 },
    );
    assert.ok(degraded.some(([value, detail]) => value === true && String(detail).includes("CANDLE_COVERAGE_UNKNOWN")));
    assert.ok(integrity.some(([value, detail]) => value === "pending" && String(detail).includes("CANDLE_COVERAGE_UNKNOWN")));
  } finally { pipeline.dispose(); }
});

test("verified candle ownership never double-counts a live trade already present in the snapshot aggregate", () => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 3 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const candidate = trade(market, startTime);
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 0.1, services: services() });
  pipeline.explicitHistoryReconcile = state({
    startTime, interval, candidate, applied: false, deferred: true,
    candleCoverage: verifiedCoverage(market, startTime, interval),
  });
  const snapshot = {
    ...historyBar(startTime),
    high: 101.2,
    close: 100.2,
    volume: 11,
    delta: 5,
    count: 11,
  };
  try {
    assert.equal(pipeline._applyExplicitHistorySnapshot(
      startTime, startTime + interval, [snapshot], 0, "history-loaded", true, false,
    ), true);
    const bar = pipeline.series.get(startTime);
    assert.ok(bar);
    assert.deepEqual(
      { volume: bar.volume, delta: bar.delta, count: bar.count, close: bar.close, cells: cellVolume(bar) },
      { volume: 11, delta: 5, count: 11, close: 100.2, cells: 1 },
    );
  } finally { pipeline.dispose(); }
});

test("unknown candle coverage keeps a deferred live trade pending instead of guessing from history", () => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 3 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const candidate = trade(market, startTime);
  const degraded = [];
  const integrity = [];
  const reporter = { report: (value, detail) => integrity.push([value, detail]), dispose() {} };
  const pipeline = new ChartDataPipeline({
    market, intervalMs: interval, priceStep: 0.1, services: services(reporter),
    onDataDegraded: (value, detail) => degraded.push([value, detail]),
  });
  pipeline.explicitHistoryReconcile = state({
    startTime, interval, candidate, applied: false, deferred: true, candleCoverage: null,
  });
  try {
    assert.equal(pipeline._applyExplicitHistorySnapshot(
      startTime, startTime + interval, [historyBar(startTime)], 0, "history-loaded", true, false,
    ), true);
    assert.equal(pipeline.series.get(startTime), undefined, "unowned history must not replace an unresolved missing live bucket");
    assert.equal(pipeline.explicitHistoryReconcile.deferred.has(candidate), true, "deferred trade must remain recoverable");
    assert.equal(pipeline.explicitHistoryReconcile.trades.includes(candidate), true, "journal ownership must remain pending");
    assert.ok(degraded.some(([value, detail]) => value === true && String(detail).includes("CANDLE_COVERAGE_UNKNOWN")));
    assert.ok(integrity.some(([value, detail]) => value === "pending" && String(detail).includes("CANDLE_COVERAGE_UNKNOWN")));
  } finally { pipeline.dispose(); }
});

test("rolling-backend responses without candle coverage still apply history when no live trade overlaps", () => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 3 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 0.1, services: services() });
  pipeline.explicitHistoryReconcile = {
    generation: 0,
    requestedFrom: startTime,
    requestedTo: startTime + interval - 1,
    trades: [],
    applied: new Set(),
    deferred: new Set(),
    liveAfterBarrier: new Set(),
    watermark: null,
    candleCoverage: null,
    retiredWatermarks: new Map(),
  };
  try {
    assert.equal(pipeline._applyExplicitHistorySnapshot(
      startTime, startTime + interval, [historyBar(startTime)], 0, "history-loaded", true, false,
    ), true);
    assert.equal(pipeline.series.get(startTime)?.volume, 10);
  } finally { pipeline.dispose(); }
});
