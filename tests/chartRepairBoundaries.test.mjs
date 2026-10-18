/**
 * Regressions for live repair boundaries:
 *  - a reconnect repair after a long outage starts at the last applied trade, not the boundary bucket
 *  - a timeframe change replays market readiness with a fresh boundary
 *  - patchDay drops queued trades its built day already counts
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { LiveTradeRepairController } = await import("../dist/features/chart/LiveTradeRepairController.js");
const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");
const { historyBar, useFakeChartDataSource } = await import("./support/fakeChartDataSource.mjs");

const MARKET = "BINANCE_FUTURES:btcusdt";
const MINUTE = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function makeController(cursor) {
  const host = {
    services: {},
    series: { releaseRepairBarriers: () => undefined, beginRepairBarrier: () => undefined, config: { priceStep: 10 } },
    isDisposed: () => false,
    getGeneration: () => 1,
    getMarket: () => MARKET,
    getIntervalMs: () => MINUTE,
    getLastAppliedTradeTime: () => cursor.value,
    onBeforeHistoryPatch: () => undefined,
    emitHistoryPatch: () => undefined,
    reconcileHistorySnapshot: () => null,
    handleMeta: () => undefined,
    setDataDegraded: () => undefined,
  };
  const controller = new LiveTradeRepairController(host);
  // Only the queued range matters here; no repair request is sent.
  controller.startPendingRepair = () => undefined;
  return controller;
}

test("a reconnect repair covers the whole outage, not only the boundary bucket", () => {
  const cursor = { value: T0 + 30_000 };
  const controller = makeController(cursor);
  controller.onSession({ generation: 1, boundaryAt: T0 }, false);

  // The tab comes back ten minutes later; the new stream applies a trade before readiness arrives.
  const boundaryAt = T0 + 10 * MINUTE + 5_000;
  controller.onSession({ generation: 2, boundaryAt });
  cursor.value = boundaryAt + 1_000;
  controller.onMarketReady({ generation: 2, boundaryAt, market: MARKET });

  assert.equal(controller.pendingRepairFrom, T0);
});

test("a market readiness with nothing missed still repairs from its boundary bucket", () => {
  const cursor = { value: -Infinity };
  const controller = makeController(cursor);
  const boundaryAt = T0 + 10 * MINUTE + 5_000;
  controller.onMarketReady({ generation: 1, boundaryAt, market: MARKET });
  assert.equal(controller.pendingRepairFrom, T0 + 10 * MINUTE);
});

function makePipeline() {
  return new ChartDataPipeline({
    market: MARKET,
    intervalMs: MINUTE,
    priceStep: 10,
    services: {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 10,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync: () => {},
    },
    scheduler: { request: () => 0, cancel: () => {} },
  });
}

test("a timeframe change replays market readiness with a fresh boundary", async () => {
  const pipeline = makePipeline();
  try {
    const staleBoundary = Date.now() - 3 * 60 * MINUTE;
    pipeline.latestMarketReadiness = { generation: 1, boundaryAt: staleBoundary, market: MARKET };
    const replayed = [];
    pipeline.repair.onMarketReady = (readiness) => replayed.push(readiness);

    const before = Date.now();
    await pipeline.changeConfig({ intervalMs: 5 * MINUTE });

    assert.equal(replayed.length, 1);
    assert.ok(replayed[0].boundaryAt >= before, "the replayed boundary is not the stale one");
  } finally {
    pipeline.dispose();
  }
});

test("patchDay drops queued trades for the closed buckets it replaces", async (t) => {
  useFakeChartDataSource(t, {
    history: () => ({
      bars: [historyBar(T0, {
        open: 100, high: 101, low: 99, close: 100, volume: 50, delta: 0, count: 5, liquidationBuyVol: 0, liquidationSellVol: 0,
        cells: [{ priceBin: 100, buyVol: 25, sellVol: 25, liquidationBuyVol: 0, liquidationSellVol: 0, count: 5, buyCount: 2, sellCount: 3 }],
      })],
      meta: { schemaVersion: 2, generatedAt: 0 },
    }),
  });
  const pipeline = makePipeline();
  try {
    const inDay = { time: T0 + 1_000, price: 100, qty: 1, isBuyerMaker: false, market: MARKET };
    const nextDay = { time: T0 + DAY + 1_000, price: 100, qty: 1, isBuyerMaker: false, market: MARKET };
    pipeline.pendingTrades = [inDay, nextDay];

    await pipeline.patchDay(T0);

    assert.deepEqual(pipeline.pendingTrades, [nextDay]);
    assert.equal(pipeline.series.at(0).volume, 50);
  } finally {
    pipeline.dispose();
  }
});
