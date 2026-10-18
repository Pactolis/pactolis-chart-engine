import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const INTERVAL = 120_000;
const START = Date.UTC(2024, 0, 1, 0, 0, 0);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function manualScheduler() {
  let next = 1;
  const callbacks = new Map();
  return {
    request(cb) { const id = next++; callbacks.set(id, cb); return id; },
    cancel(id) { callbacks.delete(id); },
    flushAll() {
      while (callbacks.size) {
        const batch = [...callbacks.entries()];
        callbacks.clear();
        for (const [, cb] of batch) cb();
      }
    },
  };
}

function synchronousRepairRescheduleScheduler() {
  let next = 1;
  let requests = 0;
  const callbacks = new Map();
  return {
    request(cb) {
      requests++;
      if (requests === 1) {
        const id = next++;
        callbacks.set(id, cb);
        return id;
      }
      cb();
      return 0;
    },
    cancel(id) { callbacks.delete(id); },
    flushAll() {
      while (callbacks.size) {
        const batch = [...callbacks.entries()];
        callbacks.clear();
        for (const [, cb] of batch) cb();
      }
    },
  };
}

function trade(id, time, price, qty, isBuy, liquidation = false) {
  return { id: String(id), time, price, qty, isBuy, liquidation, market: "M", source: "live", receivedAt: time + 1 };
}

function aggregate(trades) {
  const normal = trades.filter((t) => !t.liquidation);
  assert.ok(normal.length > 0);
  const cells = new Map();
  for (const t of normal) {
    let cell = cells.get(t.price);
    if (!cell) {
      cell = { priceBin: t.price, buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 };
      cells.set(t.price, cell);
    }
    cell.count++;
    if (t.isBuy) { cell.buyVol += t.qty; cell.buyCount++; }
    else { cell.sellVol += t.qty; cell.sellCount++; }
  }
  return {
    startTime: START,
    open: normal[0].price,
    high: Math.max(...normal.map((t) => t.price)),
    low: Math.min(...normal.map((t) => t.price)),
    close: normal.at(-1).price,
    volume: normal.reduce((n, t) => n + t.qty, 0),
    delta: normal.reduce((n, t) => n + (t.isBuy ? t.qty : -t.qty), 0),
    count: normal.length,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells,
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: START + 60_000,
  };
}

function cloneBar(bar) {
  return { ...bar, cells: new Map([...bar.cells].map(([price, cell]) => [price, { ...cell }])) };
}

function normalCells(bar) {
  return [...bar.cells]
    .filter(([, cell]) => cell.count > 0 || cell.buyVol > 0 || cell.sellVol > 0)
    .sort(([a], [b]) => a - b)
    .map(([price, cell]) => [price, cell.buyVol, cell.sellVol, cell.count, cell.buyCount, cell.sellCount]);
}

function assertBarEqualsOracle(actual, expected) {
  assert.ok(actual);
  assert.equal(actual.open, expected.open, "open");
  assert.equal(actual.high, expected.high, "high");
  assert.equal(actual.low, expected.low, "low");
  assert.equal(actual.close, expected.close, "close");
  assert.equal(actual.volume, expected.volume, "volume");
  assert.equal(actual.delta, expected.delta, "delta");
  assert.equal(actual.count, expected.count, "tradeCount");
  assert.deepEqual(normalCells(actual), normalCells(expected), "footprint cells");
}

function meta(q, watermark = "102") {
  const coveredFrom = q.from;
  const coveredThrough = START + 60_000;
  return {
    schemaVersion: 2,
    generatedAt: START + 60_000,
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      authority: "provisional",
      status: "pending",
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      durableThroughId: null,
      projectionThroughId: watermark,
      authorityToken: "projection-1",
      reasonCode: null,
    },
    repairSnapshot: {
      schemaVersion: 2,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      interval: q.interval,
      priceStep: q.priceStep,
      authority: "provisional",
      authorityToken: "projection-1",
      watermark,
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      bucketFrom: START,
      bucketThrough: START,
      coverageProof: {
        kind: "resolver-watermark-contiguous-v2",
        authority: "provisional",
        authorityToken: "projection-1",
        projectionThroughId: watermark,
        requestedFrom: q.from,
        requestedTo: q.to,
        coveredFrom,
        coveredThrough,
        watermarkComplete: true,
      },
    },
  };
}

async function runOrdering({ flushBeforeSnapshot, scheduler = manualScheduler(), queueWatermarkDuplicate = false }) {
  const history = deferred();
  let sessionCb;
  let query;
  const subscribers = new Set();
  const reporter = [];
  let pipeline;
  const services = {
    subscribeToTrades(_market, cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
    subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = undefined; }; },
    fetchHistory(q) { query = q; q.onMeta?.(meta(q)); return history.promise; },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      return {
        // Keep what the chart held at each report, so an early healthy is caught, not only the last state.
        report(state, detail) { const bar = pipeline?.series.get(START); reporter.push({ state, detail, bar: bar && cloneBar(bar) }); },
        dispose() {},
      };
    },
  };
  pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services, scheduler });
  try {
    const emit = (value) => { for (const cb of subscribers) cb(value); };

    const projectionTrades = [
      trade(100, START + 10_000, 10_000, 5, true),
      trade(101, START + 20_000, 9_999, 3, false),
      trade(102, START + 50_000, 10_001, 5, true),
    ];
    const tail = [
      trade(103, START + 70_000, 10_002, 2, false),
      trade(104, START + 80_000, 9_998, 1, true),
    ];
    const liquidation = trade(900, START + 75_000, 9_997, 4, true, true);
    const snapshotBar = aggregate(projectionTrades);

    sessionCb({ generation: 1, epoch: 1, session: "s1", boundaryAt: START + 60_000 });
    for (const t of tail) emit(t);
    emit(liquidation);
    if (queueWatermarkDuplicate) emit(trade(102, START + 70_000, 10_001, 5, true));
    if (flushBeforeSnapshot) scheduler.flushAll();
    history.resolve([cloneBar(snapshotBar)]);
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    scheduler.flushAll();

    assert.equal(query.from, START);
    assert.equal(query.to, START + INTERVAL - 1, "120s repair must select both M1 base bars");
    assert.equal(meta(query).repairSnapshot.coveredThrough, START + 60_000, "snapshot time coverage remains truthful while candle is open");
    assert.equal(reporter.at(-1)?.state, "healthy");
    const expected = aggregate([...projectionTrades, ...tail]);
    const firstPending = reporter.findIndex((entry) => entry.state === "pending");
    assert.ok(firstPending >= 0, "the repair reports pending first");
    const healthy = reporter.slice(firstPending).filter((entry) => entry.state === "healthy");
    assert.equal(healthy.length, 1, "healthy is reported once, at the commit");
    assertBarEqualsOracle(healthy[0].bar, expected);
    assertBarEqualsOracle(pipeline.series.get(START), expected);
    assert.equal(pipeline.series.get(START)?.liquidationBuyVol, 4, "liquidation overlay is independent of aggTrade W");
    assert.equal(pipeline.series.get(START)?.cells.get(9_997)?.liquidationBuyVol, 4, "liquidation-only cell is preserved exactly once");

    emit(trade(102, START + 70_000, 10_001, 5, true));
    emit(trade(103, START + 70_000, 10_002, 2, false));
    scheduler.flushAll();
    assertBarEqualsOracle(pipeline.series.get(START), expected);
    assert.equal(pipeline.series.get(START)?.liquidationBuyVol, 4);
    assert.equal(pipeline.series.get(START)?.cells.get(9_997)?.liquidationBuyVol, 4);

    emit(trade("not-a-number", START + 85_000, 10_004, 7, true));
    emit(trade("18446744073709551616", START + 86_000, 9_996, 8, false));
    scheduler.flushAll();
    assertBarEqualsOracle(pipeline.series.get(START), expected);
    assert.equal(pipeline.series.get(START)?.liquidationBuyVol, 4);

    const next = trade(105, START + 90_000, 10_003, 1, true);
    emit(next);
    scheduler.flushAll();
    assertBarEqualsOracle(pipeline.series.get(START), aggregate([...projectionTrades, ...tail, next]));
    assert.equal(pipeline.series.get(START)?.liquidationBuyVol, 4);
  } finally {
    pipeline.dispose();
  }
}

test("repair is deterministic when queued trades flush before snapshot resolution", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  try { await runOrdering({ flushBeforeSnapshot: true }); } finally { Date.now = previousNow; }
});

test("repair is deterministic when snapshot resolves before queued flush", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  try { await runOrdering({ flushBeforeSnapshot: false }); } finally { Date.now = previousNow; }
});

test("repair ownership fences a synchronous pending flush before id<=W can reapply", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  try {
    await runOrdering({
      flushBeforeSnapshot: false,
      scheduler: synchronousRepairRescheduleScheduler(),
      queueWatermarkDuplicate: true,
    });
  } finally {
    Date.now = previousNow;
  }
});


function rawFillSnapshotBar() {
  return {
    startTime: START,
    open: 10000, high: 10001, low: 9999, close: 9999,
    volume: 6, delta: 0, count: 6,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([
      [9999, { priceBin: 9999, buyVol: 1, sellVol: 0, count: 3, buyCount: 3, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [10000, { priceBin: 10000, buyVol: 2, sellVol: 0, count: 2, buyCount: 2, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [10001, { priceBin: 10001, buyVol: 0, sellVol: 3, count: 1, buyCount: 0, sellCount: 1, liquidationBuyVol: 0, liquidationSellVol: 0 }],
    ]),
    hasRef: true, completeness: "complete", sources: ["history"], updatedAt: START + 60_000,
  };
}

function rawFillFinalOracle() {
  return {
    startTime: START,
    open: 10000, high: 10002, low: 9999, close: 10000,
    volume: 12, delta: 2, count: 9,
    liquidationBuyVol: 5, liquidationSellVol: 0,
    cells: new Map([
      [9999, { priceBin: 9999, buyVol: 1, sellVol: 0, count: 3, buyCount: 3, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [10000, { priceBin: 10000, buyVol: 6, sellVol: 0, count: 3, buyCount: 3, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [10001, { priceBin: 10001, buyVol: 0, sellVol: 3, count: 1, buyCount: 0, sellCount: 1, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [10002, { priceBin: 10002, buyVol: 0, sellVol: 2, count: 2, buyCount: 0, sellCount: 2, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [9998, { priceBin: 9998, buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0, liquidationBuyVol: 5, liquidationSellVol: 0 }],
    ]),
    hasRef: true, completeness: "complete", sources: ["history"], updatedAt: START + 60_000,
  };
}

async function runRawFillOrdering(flushBeforeSnapshot) {
  const history = deferred();
  let sessionCb;
  let query;
  let sentMeta;
  const subscribers = new Set();
  const reporter = [];
  const services = {
    subscribeToTrades(_market, cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
    subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = undefined; }; },
    fetchHistory(q) { query = q; sentMeta = meta(q); q.onMeta?.(sentMeta); return history.promise; },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() { return { report(state, detail) { reporter.push({ state, detail }); }, dispose() {} }; },
  };
  const scheduler = manualScheduler();
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services, scheduler });
  try {
    const emit = (value) => { for (const cb of subscribers) cb(value); };
    const withRawCount = (id, time, price, qty, isBuy, tradeCount, liquidation = false) =>
      ({ ...trade(id, time, price, qty, isBuy, liquidation), tradeCount });
    const tail104 = withRawCount(104, START + 80_000, 10000, 4, true, 1);
    const tail103 = withRawCount(103, START + 70_000, 10002, 2, false, 2);
    const liq900 = withRawCount(900, START + 75_000, 9998, 5, true, 1, true);
    const oracle = rawFillFinalOracle();
    const assertFinal = () => {
      assertBarEqualsOracle(pipeline.series.get(START), oracle);
      const bar = pipeline.series.get(START);
      assert.equal(bar?.liquidationBuyVol, 5);
      assert.equal(bar?.liquidationSellVol, 0);
      const liqCell = bar?.cells.get(9998);
      assert.deepEqual(liqCell && {
        buyVol: liqCell.buyVol, sellVol: liqCell.sellVol, count: liqCell.count,
        buyCount: liqCell.buyCount, sellCount: liqCell.sellCount,
        liquidationBuyVol: liqCell.liquidationBuyVol, liquidationSellVol: liqCell.liquidationSellVol,
      }, { buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0, liquidationBuyVol: 5, liquidationSellVol: 0 });
      const cells = [...bar.cells.values()];
      assert.equal(cells.reduce((n, c) => n + c.count, 0), 9);
      assert.equal(cells.reduce((n, c) => n + c.buyCount, 0), 6);
      assert.equal(cells.reduce((n, c) => n + c.sellCount, 0), 3);
      assert.equal(bar.cells.get(10000)?.count, 3);
      assert.equal(bar.cells.get(10000)?.buyCount, 3);
      assert.equal(bar.cells.get(10002)?.sellCount, 2);
    };

    sessionCb({ generation: 1, epoch: 1, session: "s1", boundaryAt: START + 60_000 });
    emit(tail104);
    emit(tail103);
    emit({ ...tail103 });
    emit(liq900);
    if (flushBeforeSnapshot) scheduler.flushAll();
    history.resolve([cloneBar(rawFillSnapshotBar())]);
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    scheduler.flushAll();

    assert.equal(query.from, START);
    assert.equal(query.to, START + INTERVAL - 1);
    assert.equal(query.reference, "M");
    assert.equal(sentMeta?.schemaVersion, 2);
    assert.equal(sentMeta?.repairSnapshot?.schemaVersion, 2);
    assert.equal(sentMeta?.repairSnapshot?.mode, "trade-id-v1");
    assert.equal(sentMeta?.repairSnapshot?.instrument, "M");
    assert.equal(sentMeta?.repairSnapshot?.watermark, "102");
    assert.equal(sentMeta?.repairSnapshot?.coveredFrom, START);
    assert.equal(sentMeta?.repairSnapshot?.coveredThrough, START + 60_000);
    assert.equal(sentMeta?.repairSnapshot?.coverageProof?.kind, "resolver-watermark-contiguous-v2");
    assert.equal(sentMeta?.repairSnapshot?.coverageProof?.watermarkComplete, true);
    assert.equal(sentMeta?.repairSnapshot?.coverageProof?.projectionThroughId, "102");
    assert.equal(reporter.at(-1)?.state, "healthy");
    assertFinal();

    emit(withRawCount(102, START + 50_000, 9999, 1, true, 3));
    emit({ ...tail103 });
    scheduler.flushAll();
    assertFinal();
  } finally {
    pipeline.dispose();
    assert.equal(subscribers.size, 0, "pipeline disposal unsubscribes trade callbacks");
    assert.equal(sessionCb, undefined, "pipeline disposal unsubscribes session callback");
  }
}

test("raw-fill totals remain exactly once when queued flush precedes snapshot", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  try { await runRawFillOrdering(true); } finally { Date.now = previousNow; }
});

test("raw-fill totals remain exactly once when snapshot precedes queued flush", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  try { await runRawFillOrdering(false); } finally { Date.now = previousNow; }
});
