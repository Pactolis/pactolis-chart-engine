import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function wireServices() {
  const subscribers = new Map();
  return {
    services: {
      subscribeToTrades(market, cb) {
        if (!subscribers.has(market)) subscribers.set(market, new Set());
        subscribers.get(market).add(cb);
        return () => subscribers.get(market)?.delete(cb);
      },
      fetchPriceStep: async () => 1,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync() {},
    },
    emit(market, trade) { for (const cb of subscribers.get(market) ?? []) cb(trade); },
  };
}

test("two-phase history never overwrites the still-open bucket with a frozen snapshot", async (t) => {
  const interval = 60_000;
  const now = Date.now();
  const liveBucket = Math.floor(now / interval) * interval;
  const phase2 = deferred();
  let phase2Started = false;

  useFakeChartDataSource(t, {
    history: async (query) => {
      const fast = query.includeFootprint === false;
      if (fast) {
        return [historyBar(liveBucket, { open: 100, high: 100, low: 100, close: 100, volume: 0, delta: 0, count: 0 })];
      }
      phase2Started = true;
      await phase2.promise;
      return [historyBar(liveBucket, { open: 100, high: 100, low: 100, close: 100, volume: 0, delta: 0, count: 0 })];
    },
  });

  const market = "BINANCE_FUTURES:btcusdt";
  const h = wireServices();
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 1, services: h.services });
  const loading = pipeline.loadHistory({ from: liveBucket, to: now, twoPhase: true });
  while (!phase2Started) await new Promise(setImmediate);

  h.emit(market, {
    time: liveBucket + 10_000,
    price: 105,
    qty: 3,
    isBuy: true,
    liquidation: false,
    market,
    source: "live",
    receivedAt: Date.now(),
    id: "999999",
  });
  const beforeSnapshot = pipeline.series.get(liveBucket);
  assert.equal(beforeSnapshot?.count, 1);
  assert.equal(beforeSnapshot?.volume, 3);
  assert.equal(beforeSnapshot?.cells.get(105)?.buyVol, 3);

  phase2.resolve();
  await loading;

  const finalBar = pipeline.series.get(liveBucket);
  assert.equal(finalBar?.count, 1, "frozen phase-2 snapshot must not erase the live trade");
  assert.equal(finalBar?.volume, 3);
  assert.equal(finalBar?.cells.get(105)?.buyVol, 3, "live footprint cell must survive the frozen phase-2 snapshot");
  pipeline.dispose();
});

test("the bootstrap response seeds the open bucket instead of dropping it", async (t) => {
  const interval = 60_000;
  const now = Date.now();
  const liveBucket = Math.floor(now / interval) * interval;
  const closedBucket = liveBucket - interval;
  const phase2 = deferred();
  let phase2Started = false;

  useFakeChartDataSource(t, {
    history: async ({ from, includeFootprint }) => {
      if (includeFootprint === false) {
        // ChartHistoryController's dedicated rebuild seed is not in play here; the pipeline
        // is driven directly, so only the bootstrap response can put the open bucket on screen.
        if (from >= liveBucket) return new Promise(() => {});
        return [
          historyBar(closedBucket, { open: 100, high: 100, low: 100, close: 100, volume: 1, delta: 0, count: 1 }),
          historyBar(liveBucket, { open: 101, high: 103, low: 100, close: 102, volume: 5, delta: 1, count: 4 }),
        ];
      }
      phase2Started = true;
      await phase2.promise;
      return [
        historyBar(closedBucket, { open: 100, high: 100, low: 100, close: 100, volume: 1, delta: 0, count: 1, cells: [{ priceBin: 100, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }] }),
      ];
    },
  });

  const market = "BINANCE_FUTURES:btcusdt";
  const h = wireServices();
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 1, services: h.services });
  const loading = pipeline.loadHistory({ from: closedBucket, to: now, twoPhase: true });
  while (!phase2Started) await new Promise(setImmediate);

  const seeded = pipeline.series.get(liveBucket);
  assert.ok(seeded, "the open bucket is on screen with the closed candles, not one request later");
  assert.equal(seeded.open, 101);
  assert.equal(seeded.close, 102);
  assert.equal(seeded.cells.size, 0, "cells stay fenced for the trade-id repair");

  phase2.resolve();
  await loading;
  assert.ok(pipeline.series.get(liveBucket), "phase 2 leaves the open bucket alone");
  pipeline.dispose();
});

test("a live-owned open bucket survives the bootstrap response", async (t) => {
  const interval = 60_000;
  const now = Date.now();
  const liveBucket = Math.floor(now / interval) * interval;
  const closedBucket = liveBucket - interval;
  const phase1 = deferred();
  let phase1Started = false;

  useFakeChartDataSource(t, {
    history: async ({ from, includeFootprint }) => {
      if (includeFootprint === false) {
        if (from >= liveBucket) return new Promise(() => {});
        phase1Started = true;
        await phase1.promise;
        return [
          // A stale open bucket: the response was computed before the live trade printed.
          historyBar(liveBucket, { open: 50, high: 50, low: 50, close: 50, volume: 0, delta: 0, count: 0 }),
        ];
      }
      return [];
    },
  });

  const market = "BINANCE_FUTURES:btcusdt";
  const h = wireServices();
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 1, services: h.services });
  const loading = pipeline.loadHistory({ from: closedBucket, to: now, twoPhase: true });
  while (!phase1Started) await new Promise(setImmediate);

  h.emit(market, {
    time: liveBucket + 1_000, price: 105, qty: 2, isBuy: true, liquidation: false,
    market, source: "live", receivedAt: Date.now(), id: "42",
  });
  assert.equal(pipeline.series.get(liveBucket)?.close, 105);

  phase1.resolve();
  await loading;

  const bar = pipeline.series.get(liveBucket);
  assert.equal(bar?.open, 105, "the stale bootstrap bucket must not overwrite live data");
  assert.equal(bar?.close, 105);
  assert.equal(bar?.volume, 2);
  pipeline.dispose();
});

test("a footprint-bearing bootstrap response seeds candle data only", async (t) => {
  const interval = 60_000;
  const now = Date.now();
  const liveBucket = Math.floor(now / interval) * interval;
  const closedBucket = liveBucket - interval;

  // The single-phase path asks for footprint, so its response carries cells for every
  // bucket it returns — the open one included. Those cells are not owned by a proven
  // trade-id repair snapshot and must never reach the series.
  useFakeChartDataSource(t, {
    history: () => [
      historyBar(closedBucket, { open: 100, high: 100, low: 100, close: 100, volume: 1, delta: 0, count: 1, cells: [{ priceBin: 100, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }] }),
      historyBar(liveBucket, { open: 101, high: 103, low: 100, close: 102, volume: 5, delta: 1, count: 4, deltaBySize: [0, 0, 0, 10], cells: [{ priceBin: 101, buyVol: 3, sellVol: 2, liquidationBuyVol: 0, liquidationSellVol: 0, count: 4, buyCount: 2, sellCount: 2 }] }),
    ],
  });

  const market = "BINANCE_FUTURES:btcusdt";
  const h = wireServices();
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 1, services: h.services });
  await pipeline.loadHistory({ from: closedBucket, to: now });

  const open = pipeline.series.get(liveBucket);
  assert.ok(open, "the open bucket is still seeded");
  assert.equal(open.open, 101, "candle data comes through");
  assert.equal(open.close, 102);
  assert.equal(open.volume, 5);
  assert.equal(pipeline.liveBootstrapReconciled, false, "no repair has been proven yet");
  assert.equal(open.cells.size, 0, "unproven footprint must not reach the open bucket");
  assert.equal(open.liquidationBuyVol ?? 0, 0);
  assert.equal(open.liquidationSellVol ?? 0, 0);
  // deltaBySize only accumulates from live trades under the same includeCells gate as
  // cells (core/model/footprint.ts), so it is repair-owned too: seeding it would feed
  // size-bucketed CVD an unproven distribution.
  assert.equal(open.deltaBySize, undefined, "unproven size-bucketed delta must not reach CVD");

  assert.equal(pipeline.series.get(closedBucket)?.cells.size, 1, "closed buckets keep their footprint");
  pipeline.dispose();
});

test("a cell-free bootstrap bar still cannot carry size-bucketed delta", async (t) => {
  const interval = 60_000;
  const now = Date.now();
  const liveBucket = Math.floor(now / interval) * interval;
  const closedBucket = liveBucket - interval;

  // No cells and no liquidations, so nothing forces a defensive copy — but `deltaBySize`
  // is still footprint-domain data the trade-id repair owns.
  useFakeChartDataSource(t, {
    history: () => [
      historyBar(closedBucket, { open: 100, high: 100, low: 100, close: 100, volume: 1, delta: 0, count: 1 }),
      historyBar(liveBucket, { open: 101, high: 103, low: 100, close: 102, volume: 5, delta: 1, count: 4, deltaBySize: [0, 0, 0, 10] }),
    ],
  });

  const market = "BINANCE_FUTURES:btcusdt";
  const h = wireServices();
  const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 1, services: h.services });
  await pipeline.loadHistory({ from: closedBucket, to: now });

  const open = pipeline.series.get(liveBucket);
  assert.ok(open, "the open bucket is still seeded");
  assert.equal(open.close, 102, "candle data still comes through");
  assert.equal(pipeline.liveBootstrapReconciled, false);
  assert.equal(open.deltaBySize, undefined, "unproven size-bucketed delta must not reach CVD");
  pipeline.dispose();
});

test("a bucket that closes while two-phase history loads keeps its live footprint", async (t) => {
  const originalNow = Date.now;
  const interval = 60_000;
  const openAtStart = Math.floor(originalNow() / interval) * interval;
  const nextBucket = openAtStart + interval;
  const closedBucket = openAtStart - interval;
  let clock = openAtStart + 50_000;
  Date.now = () => clock;
  const phase2 = deferred();
  let phase2Started = false;
  // Both responses were computed while `openAtStart` was still open, so their copy of it is a partial snapshot.
  const bars = (cells) => [
    historyBar(closedBucket, { open: 90, high: 90, low: 90, close: 90, volume: 1, delta: 1, count: 1, cells: cells ? [{ priceBin: 90, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }] : [] }),
    historyBar(openAtStart, { open: 100, high: 100, low: 100, close: 100, volume: 1, delta: 1, count: 1, cells: cells ? [{ priceBin: 100, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }] : [] }),
  ];

  useFakeChartDataSource(t, {
    history: async (query) => {
      const fast = query.includeFootprint === false;
      if (!fast) {
        phase2Started = true;
        await phase2.promise;
      }
      return bars(!fast);
    },
  });

  try {
    const market = "BINANCE_FUTURES:btcusdt";
    const h = wireServices();
    const pipeline = new ChartDataPipeline({ market, intervalMs: interval, priceStep: 1, services: h.services });
    const loading = pipeline.loadHistory({ from: closedBucket, to: clock, twoPhase: true });
    while (!phase2Started) await new Promise(setImmediate);

    const trade = (time, price, id) => ({
      time, price, qty: 3, isBuy: true, liquidation: false, market, source: "live", receivedAt: clock, id,
    });
    h.emit(market, trade(openAtStart + 55_000, 105, "999998"));
    // The minute rolls over before phase 2 answers: `openAtStart` is closed, `nextBucket` is the open one.
    clock = nextBucket + 5_000;
    h.emit(market, trade(nextBucket + 1_000, 106, "999999"));
    assert.equal(pipeline.series.get(openAtStart)?.cells.get(105)?.buyVol, 3);
    assert.equal(pipeline.series.get(nextBucket)?.cells.get(106)?.buyVol, 3);

    phase2.resolve();
    await loading;

    const closedAtLoad = pipeline.series.get(closedBucket);
    assert.equal(closedAtLoad?.cells.get(90)?.buyVol, 1, "history still owns buckets closed before the load began");
    const rolledOver = pipeline.series.get(openAtStart);
    assert.equal(rolledOver?.cells.get(105)?.buyVol, 3, "the frozen snapshot must not erase the bucket's live footprint");
    assert.equal(rolledOver?.cells.has(100), false, "the partial snapshot's cells must not be written into the live bucket");
    assert.equal(pipeline.series.get(nextBucket)?.cells.get(106)?.buyVol, 3, "the new open bucket stays live-owned");
    pipeline.dispose();
  } finally {
    Date.now = originalNow;
  }
});
