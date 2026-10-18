import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeManualScheduler() {
  let pending = null;
  let nextHandle = 1;
  return {
    scheduler: {
      request(cb) { pending = cb; return nextHandle++; },
      cancel() { pending = null; },
    },
    flush() { const cb = pending; pending = null; cb?.(); },
    hasPending() { return pending !== null; },
  };
}

function makeServices() {
  const subscribers = new Map();
  return {
    subscribeToTrades(market, cb) {
      if (!subscribers.has(market)) subscribers.set(market, new Set());
      subscribers.get(market).add(cb);
      return () => subscribers.get(market)?.delete(cb);
    },
    fetchPriceStep: async () => 0.1,
    fetchPricePrecision: async () => 1,
    triggerAutoSync: () => {},
    _emit(market, trade) {
      for (const cb of subscribers.get(market) ?? []) cb(trade);
    },
  };
}

function baseBar(startTime) {
  return {
    startTime,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 10,
    delta: 10,
    count: 10,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells: new Map([[100, {
      priceBin: 100,
      buyVol: 10,
      sellVol: 0,
      count: 10,
      buyCount: 10,
      sellCount: 0,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
    }]]),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime,
    cellRevision: 0,
  };
}

function historySnapshot(startTime) {
  return historyBar(startTime, {
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 10,
    delta: 10,
    count: 10,
  });
}

function candleCoverage(market, startTime, interval) {
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

function summarize(bar) {
  assert.ok(bar, "history candle callback must observe the reconciled bar");
  let cellVolume = 0;
  for (const cell of bar.cells.values()) cellVolume += cell.buyVol + cell.sellVol;
  return {
    volume: bar.volume,
    delta: bar.delta,
    count: bar.count,
    cellVolume,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

async function runScenario(t, flushBeforeSnapshot, preloadHistory = true) {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 2 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const fastStarted = deferred();
  const releaseFast = deferred();
  const services = makeServices();
  const scheduler = makeManualScheduler();
  let observed = null;

  useFakeChartDataSource(t, {
    history: async (query) => {
      if (query.includeFootprint === false) {
        assert.equal(query.candleCoverage, "required", "interactive candle reads must request explicit ownership");
        fastStarted.resolve();
        await releaseFast.promise;
        return {
          bars: [historySnapshot(startTime)],
          meta: { candleCoverage: candleCoverage(market, startTime, interval) },
        };
      }
      return [];
    },
  });

  const pipeline = new ChartDataPipeline({
    market,
    intervalMs: interval,
    priceStep: 0.1,
    services,
    scheduler: scheduler.scheduler,
  });
  if (preloadHistory) pipeline.series.loadBars([baseBar(startTime)]);
  pipeline.onHistoryCandlesReady = () => {
    observed = summarize(pipeline.series.get(startTime));
  };

  try {
    const load = pipeline.loadHistory({ from: startTime, to: startTime + interval - 1, twoPhase: true });
    await fastStarted.promise;
    services._emit(market, {
      id: "11",
      time: startTime + 30_000,
      price: 100.1,
      qty: 1,
      isBuy: true,
      liquidation: false,
      market,
      source: "live",
      receivedAt: startTime + 30_000,
    });
    assert.equal(
      scheduler.hasPending(),
      preloadHistory,
      preloadHistory
        ? "a live trade over an existing candle stays scheduler-flushable"
        : "a first-load live trade is serialized behind the missing history candle",
    );
    if (flushBeforeSnapshot) scheduler.flush();
    releaseFast.resolve();
    await load;
    return observed;
  } finally {
    pipeline.dispose();
  }
}

test("history/live reconciliation is invariant to whether the live trade flushed before the candle snapshot", async (t) => {
  const pendingAtSnapshot = await runScenario(t, false);
  const appliedBeforeSnapshot = await runScenario(t, true);

  const expected = {
    volume: 10,
    delta: 10,
    count: 10,
    cellVolume: 11,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
  };
  assert.deepEqual(pendingAtSnapshot, expected, "verified snapshot owns candle aggregates while pending live footprint replays exactly once");
  assert.deepEqual(appliedBeforeSnapshot, expected, "verified snapshot replaces already-applied candle aggregates without duplicating preserved cells");
  assert.deepEqual(appliedBeforeSnapshot, pendingAtSnapshot, "flush timing must not change the reconciled bar");
});

test("first history load preserves history aggregates when a live trade flushed into an initially empty series", async (t) => {
  const pendingAtSnapshot = await runScenario(t, false, false);
  const appliedBeforeSnapshot = await runScenario(t, true, false);

  const expected = {
    volume: 10,
    delta: 10,
    count: 10,
    cellVolume: 1,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
  };
  assert.deepEqual(pendingAtSnapshot, expected, "verified first snapshot owns candle aggregates while deferred live footprint replays once");
  assert.deepEqual(appliedBeforeSnapshot, expected, "flush timing cannot override verified first-snapshot candle ownership");
  assert.deepEqual(appliedBeforeSnapshot, pendingAtSnapshot, "initial series state must not make flush timing observable");
});
