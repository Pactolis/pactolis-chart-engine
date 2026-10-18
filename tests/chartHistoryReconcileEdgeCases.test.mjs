import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

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

function partialLiveBar(startTime) {
  return {
    startTime,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 5,
    delta: 5,
    count: 5,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells: new Map([[100, {
      priceBin: 100,
      buyVol: 5,
      sellVol: 0,
      count: 5,
      buyCount: 5,
      sellCount: 0,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
    }]]),
    hasRef: true,
    completeness: "provisional",
    sources: ["live"],
    updatedAt: startTime,
    cellRevision: 0,
  };
}

function historyBar(startTime) {
  return {
    startTime,
    open: 99.9,
    high: 100.3,
    low: 99.7,
    close: 100,
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

function liveTrade(market, startTime) {
  return {
    id: "11",
    time: startTime + 30_000,
    price: 99.8,
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

function cellVolume(bar) {
  let total = 0;
  for (const cell of bar.cells.values()) total += cell.buyVol + cell.sellVol;
  return total;
}

function summarize(bar) {
  assert.ok(bar);
  return {
    volume: bar.volume,
    delta: bar.delta,
    count: bar.count,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    cellVolume: cellVolume(bar),
  };
}

test("a verified candle snapshot replaces partial live aggregates while preserving the applied live footprint", async (t) => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 2 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const fastStarted = deferred();
  const releaseFast = deferred();
  const scheduler = makeManualScheduler();
  const services = makeServices();
  let atCandlesReady = null;

  useFakeChartDataSource(t, {
    history: async (query) => {
      if (query.includeFootprint === false) {
        fastStarted.resolve();
        await releaseFast.promise;
        return {
          bars: [historyBar(startTime)],
          meta: { candleCoverage: verifiedCoverage(market, startTime, interval) },
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
  pipeline.series.loadBars([partialLiveBar(startTime)]);
  pipeline.onHistoryCandlesReady = () => { atCandlesReady = summarize(pipeline.series.get(startTime)); };

  try {
    const load = pipeline.loadHistory({ from: startTime, to: startTime + interval - 1, twoPhase: true });
    await fastStarted.promise;
    services._emit(market, liveTrade(market, startTime));
    assert.equal(scheduler.hasPending(), true, "trade over the existing partial candle must remain flushable");
    scheduler.flush();
    assert.equal(pipeline.series.get(startTime)?.volume, 6, "precondition: partial live candle has received the trade");

    releaseFast.resolve();
    await load;

    assert.deepEqual(atCandlesReady, {
      volume: 10,
      delta: 4,
      count: 10,
      open: 99.9,
      high: 100.3,
      low: 99.7,
      close: 100,
      cellVolume: 6,
    });
  } finally {
    pipeline.dispose();
  }
});

test("a deferred trade already covered by the snapshot watermark is not replayed", () => {
  const interval = 60_000;
  const startTime = Math.floor(Date.now() / interval) * interval - 2 * interval;
  const market = "BINANCE_FUTURES:btcusdt";
  const pipeline = new ChartDataPipeline({
    market,
    intervalMs: interval,
    priceStep: 0.1,
    services: makeServices(),
  });
  const trade = liveTrade(market, startTime);
  pipeline.explicitHistoryReconcile = {
    generation: 0,
    requestedFrom: startTime,
    requestedTo: startTime,
    trades: [trade],
    applied: new Set(),
    deferred: new Set([trade]),
    liveAfterBarrier: new Set([trade]),
    watermark: 11n,
    candleCoverage: verifiedCoverage(market, startTime, interval),
    retiredWatermarks: new Map(),
  };

  try {
    assert.equal(
      pipeline._applyExplicitHistorySnapshot(
        startTime,
        startTime + interval,
        [historyBar(startTime)],
        0,
        "history-loaded",
        false,
        false,
      ),
      true,
    );
    const bar = pipeline.series.get(startTime);
    assert.ok(bar);
    assert.equal(bar.volume, 10);
    assert.equal(bar.delta, 4);
    assert.equal(bar.count, 10);
    assert.equal(cellVolume(bar), 0);
  } finally {
    pipeline.dispose();
  }
});
