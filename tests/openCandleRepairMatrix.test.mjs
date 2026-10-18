import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const START = Date.UTC(2024, 0, 1, 0, 0, 0);
const INTERVAL = 120_000;

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

function trade(id, time, price, qty, isBuy, market = "M", liquidation = false) {
  return { id: String(id), time, price, qty, isBuy, liquidation, market, source: "live", receivedAt: time + 1 };
}

function aggregate(trades, interval = INTERVAL) {
  const normal = trades.filter((t) => !t.liquidation);
  assert.ok(normal.length > 0);
  const startTime = Math.floor(normal[0].time / interval) * interval;
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
    startTime,
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
    updatedAt: normal.at(-1).time,
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

function repairMeta(q, {
  watermark = "100",
  authority = "provisional",
  coveredFrom = q.from,
  coveredThrough = q.to,
  complete = coveredFrom <= q.from && coveredThrough >= q.to,
} = {}) {
  return {
    schemaVersion: 2,
    generatedAt: Date.now(),
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      authority,
      status: complete ? "complete" : "pending",
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      durableThroughId: null,
      projectionThroughId: watermark,
      authorityToken: "projection-proof",
      reasonCode: null,
    },
    repairSnapshot: {
      schemaVersion: 1,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      interval: q.interval,
      priceStep: q.priceStep,
      authority,
      authorityToken: "projection-proof",
      watermark,
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      bucketFrom: Math.floor(q.from / q.interval) * q.interval,
      bucketThrough: Math.floor(q.to / q.interval) * q.interval,
      coverageProof: {
        kind: "resolver-contiguous-v1",
        authority,
        requestedFrom: q.from,
        requestedTo: q.to,
        coveredFrom,
        coveredThrough,
        complete,
      },
    },
  };
}

function harness({ market = "M", intervalMs = INTERVAL, priceStep = 1 } = {}) {
  const scheduler = manualScheduler();
  const requests = [];
  const reporters = [];
  const subscribers = new Map();
  let sessionCb;
  const services = {
    subscribeToTrades(name, cb) {
      const set = subscribers.get(name) ?? new Set();
      set.add(cb);
      subscribers.set(name, set);
      return () => set.delete(cb);
    },
    subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = undefined; }; },
    fetchHistory(q) {
      const d = deferred();
      requests.push({ q, deferred: d });
      return d.promise;
    },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      return { report(state, detail) { reporters.push({ state, detail }); }, dispose() {} };
    },
  };
  const pipeline = new ChartDataPipeline({ market, intervalMs, priceStep, services, scheduler });
  return {
    pipeline,
    scheduler,
    requests,
    reporters,
    session(boundaryAt, generation = 1) {
      sessionCb?.({ generation, epoch: 1, session: `s${generation}`, boundaryAt });
    },
    emit(name, value) {
      for (const cb of subscribers.get(name) ?? []) cb(value);
    },
    resolve(index, bars, options) {
      const request = requests[index];
      assert.ok(request, `repair request ${index} exists`);
      request.q.onMeta?.(repairMeta(request.q, options));
      request.deferred.resolve(bars.map(cloneBar));
    },
  };
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await new Promise(setImmediate);
}

async function finishInitialRepair(h, { boundaryAt = START + 60_000, market = "M", id = 101 } = {}) {
  h.session(boundaryAt);
  h.emit(market, trade(id, START + 70_000, 10_001, 1, true, market));
  assert.equal(h.requests.length, 1);
  h.resolve(0, [], { watermark: String(id - 1), coveredFrom: h.requests[0].q.from, coveredThrough: h.requests[0].q.to, complete: true });
  await settle();
  h.scheduler.flushAll();
  assert.equal(h.reporters.at(-1)?.state, "healthy");
}

test("snapshot without current candle keeps first display syncing and rebuilds the live bucket exactly once", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const h = harness();
  try {
    h.session(START + 60_000);
    const tail = [
      trade(103, START + 70_000, 10_002, 2, false),
      trade(104, START + 80_000, 9_998, 1, true),
    ];
    for (const t of tail) h.emit("M", t);
    h.scheduler.flushAll();
    const beforeSnapshot = h.pipeline.series.get(START);
    h.resolve(0, [], { watermark: "102", coveredFrom: h.requests[0].q.from, coveredThrough: h.requests[0].q.to, complete: true });
    await settle();
    h.scheduler.flushAll();

    assert.ok(beforeSnapshot, "open candle remains visible while footprint repair is syncing");
    assert.equal(beforeSnapshot.volume, 3);
    assert.equal(beforeSnapshot.count, 2);
    assert.equal(normalCells(beforeSnapshot).length, 0, "unproven footprint cells remain blocked while candle data stays live");
    assert.equal(h.reporters.at(-1)?.state, "healthy");
    assertBarEqualsOracle(h.pipeline.series.get(START), aggregate(tail));
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("repair refuses a snapshot whose proof does not cover the requested prefix", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 180_000;
  const h = harness();
  try {
    const existingTrades = [trade(90, START + 10_000, 10_000, 2, true), trade(91, START + 20_000, 9_999, 1, false)];
    const existing = aggregate(existingTrades);
    h.pipeline.series.upsertBar(cloneBar(existing));
    h.session(START + 60_000);
    const liveTrade = trade(101, START + 70_000, 10_001, 1, true);
    h.emit("M", liveTrade);
    h.resolve(0, [], {
      watermark: "100",
      coveredFrom: START + 30_000,
      coveredThrough: START + 60_000,
      complete: false,
    });
    await settle();
    h.scheduler.flushAll();

    assert.notEqual(h.reporters.at(-1)?.state, "healthy");
    const live = h.pipeline.series.get(START);
    assert.ok(live);
    assert.equal(live.open, 10_000);
    assert.equal(live.high, 10_001);
    assert.equal(live.low, 9_999);
    assert.equal(live.close, 10_001);
    assert.equal(live.volume, 4);
    assert.equal(live.delta, 2);
    assert.equal(live.count, 3);
    assert.deepEqual(normalCells(live), normalCells(existing), "invalid repair proof must not admit new footprint cells");
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("buffer gaps at or below W are owned by the frozen snapshot and do not reject a continuous >W tail", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const h = harness();
  try {
    const projection = [
      trade(100, START + 10_000, 10_000, 1, true),
      trade(101, START + 20_000, 10_001, 2, false),
      trade(102, START + 30_000, 9_999, 3, true),
      trade(103, START + 40_000, 10_002, 1, false),
    ];
    h.session(START + 60_000);
    h.emit("M", trade(101, START + 20_000, 10_001, 2, false));
    h.emit("M", trade(103, START + 40_000, 10_002, 1, false));
    const tail = trade(104, START + 80_000, 10_003, 2, true);
    h.emit("M", tail);
    h.resolve(0, [aggregate(projection)], { watermark: "103", coveredFrom: h.requests[0].q.from, coveredThrough: h.requests[0].q.to, complete: true });
    await settle();
    h.scheduler.flushAll();

    assert.equal(h.reporters.at(-1)?.state, "healthy");
    assertBarEqualsOracle(h.pipeline.series.get(START), aggregate([...projection, tail]));
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("candle rollover while repair is in flight extends the atomic rebuild and preserves independent liquidation", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  let now = START + 50_000;
  Date.now = () => now;
  const h = harness({ intervalMs: 60_000 });
  try {
    const projection = [trade(100, START + 40_000, 10_000, 2, true)];
    h.session(START + 50_000);
    const oldTail = trade(101, START + 55_000, 10_001, 1, false);
    h.emit("M", oldTail);
    now = START + 70_000;
    const newTail = trade(102, START + 65_000, 10_002, 3, true);
    const liquidation = trade(900, START + 66_000, 9_998, 4, true, "M", true);
    h.emit("M", newTail);
    h.emit("M", liquidation);
    h.scheduler.flushAll();
    h.resolve(0, [aggregate(projection, 60_000)], { watermark: "100", coveredFrom: h.requests[0].q.from, coveredThrough: h.requests[0].q.to, complete: true });
    await settle();
    h.scheduler.flushAll();

    assert.equal(h.reporters.at(-1)?.state, "healthy");
    assertBarEqualsOracle(h.pipeline.series.get(START), aggregate([...projection, oldTail], 60_000));
    assertBarEqualsOracle(h.pipeline.series.get(START + 60_000), aggregate([newTail], 60_000));
    assert.equal(h.pipeline.series.get(START + 60_000)?.liquidationBuyVol, 4);
    assert.equal(h.pipeline.series.get(START + 60_000)?.cells.get(9_998)?.liquidationBuyVol, 4);
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("mixed canonical + provisional repair is accepted only with contiguous explicit coverage proof", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const h = harness();
  try {
    const projection = [trade(100, START + 10_000, 10_000, 2, true), trade(101, START + 20_000, 9_999, 1, false)];
    h.session(START + 60_000);
    const tail = trade(102, START + 80_000, 10_001, 3, true);
    h.emit("M", tail);
    h.resolve(0, [aggregate(projection)], {
      watermark: "101",
      authority: "mixed",
      coveredFrom: h.requests[0].q.from,
      coveredThrough: h.requests[0].q.to,
      complete: true,
    });
    await settle();
    h.scheduler.flushAll();

    assert.equal(h.reporters.at(-1)?.state, "healthy");
    assertBarEqualsOracle(h.pipeline.series.get(START), aggregate([...projection, tail]));
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("price-step change bootstraps repair on the existing transport session", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const h = harness();
  try {
    await finishInitialRepair(h);
    h.pipeline.setPriceStep(2);
    h.emit("M", trade(102, START + 85_000, 10_002, 1, true));
    assert.equal(h.requests.length, 2, "config change must not wait for another transport session event");
    assert.equal(h.requests[1].q.priceStep, 2);
    h.resolve(1, [], { watermark: "101", coveredFrom: h.requests[1].q.from, coveredThrough: h.requests[1].q.to, complete: true });
    await settle();
    h.scheduler.flushAll();
    assert.equal(h.reporters.at(-1)?.state, "healthy");
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("timeframe change bootstraps repair on the existing transport session", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const h = harness();
  try {
    await finishInitialRepair(h);
    await h.pipeline.changeConfig({ intervalMs: 60_000 });
    h.emit("M", trade(102, START + 85_000, 10_002, 1, true));
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].q.interval, 60_000);
    h.resolve(1, [], { watermark: "101", coveredFrom: h.requests[1].q.from, coveredThrough: h.requests[1].q.to, complete: true });
    await settle();
    h.scheduler.flushAll();
    assert.equal(h.reporters.at(-1)?.state, "healthy");
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("pair change bootstraps repair after resubscribe without requiring a new transport session", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const h = harness();
  try {
    await finishInitialRepair(h);
    await h.pipeline.changeConfig({ market: "N" });
    h.emit("N", trade(202, START + 85_000, 20_002, 1, true, "N"));
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].q.reference, "N");
    h.resolve(1, [], { watermark: "201", coveredFrom: h.requests[1].q.from, coveredThrough: h.requests[1].q.to, complete: true });
    await settle();
    h.scheduler.flushAll();
    assert.equal(h.reporters.at(-1)?.state, "healthy");
  } finally {
    h.pipeline.dispose();
    Date.now = previousNow;
  }
});

test("identical immutable normal delivery applies financial totals once across flushes", { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  const scenario = { callbacks: 0, pending: new Set(), resources: [] };
  let now = START + 90_000;
  let primaryError;
  const cleanupErrors = [];
  Date.now = () => now;

  function createBoundedHarness() {
    const holder = {
      scheduler: manualScheduler(), requests: [], reporters: [],
      subscribers: new Map(), sessionCb: undefined, pipeline: undefined,
      unsubscribes: [], resolved: new Set(), pendingCallbacks: new Set(),
    };
    scenario.resources.push(holder);
    const request = holder.scheduler.request.bind(holder.scheduler);
    const cancel = holder.scheduler.cancel.bind(holder.scheduler);
    holder.scheduler.request = (cb) => {
      let id;
      id = request(() => {
        holder.pendingCallbacks.delete(id);
        scenario.pending.delete(`${scenario.resources.indexOf(holder)}:${id}`);
        scenario.callbacks++;
        assert.ok(scenario.callbacks <= 128, "scenario callback budget exceeded");
        cb();
      });
      holder.pendingCallbacks.add(id);
      scenario.pending.add(`${scenario.resources.indexOf(holder)}:${id}`);
      assert.ok(scenario.pending.size <= 3, "scenario outstanding callback budget exceeded");
      return id;
    };
    holder.scheduler.cancel = (id) => {
      holder.pendingCallbacks.delete(id);
      scenario.pending.delete(`${scenario.resources.indexOf(holder)}:${id}`);
      cancel(id);
    };
    const services = {
      subscribeToTrades(name, cb) {
        const set = holder.subscribers.get(name) ?? new Set();
        set.add(cb);
        holder.subscribers.set(name, set);
        const unsubscribe = () => set.delete(cb);
        holder.unsubscribes.push(unsubscribe);
        return unsubscribe;
      },
      subscribeToTradeSessions(cb) {
        holder.sessionCb = cb;
        const unsubscribe = () => { holder.sessionCb = undefined; };
        holder.unsubscribes.push(unsubscribe);
        return unsubscribe;
      },
      fetchHistory(q) {
        const d = deferred();
        holder.requests.push({ q, deferred: d });
        assertResourceCaps();
        return d.promise;
      },
      fetchPriceStep: async () => 1,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync() {},
      acquirePipelineIntegrityReporter() {
        return { report(state, detail) { holder.reporters.push({ state, detail }); }, dispose() {} };
      },
    };
    holder.services = services;
    holder.pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services, scheduler: holder.scheduler });
    return holder;
  }

  function unresolvedCount() {
    return scenario.resources.reduce((count, h) => count + h.requests.filter((_, i) => !h.resolved.has(i)).length, 0);
  }
  function assertResourceCaps() {
    assert.ok(scenario.callbacks <= 128, "scenario callback budget exceeded");
    assert.ok(scenario.pending.size <= 3, "scenario outstanding callback budget exceeded");
    assert.ok(unresolvedCount() <= 3, "scenario outstanding deferred-request budget exceeded");
  }
  function activeTradeSubscriptions(h) {
    return [...h.subscribers.values()].reduce((count, set) => count + set.size, 0);
  }
  function boundedFlush(h) {
    h.scheduler.flushAll();
    assertResourceCaps();
  }
  function resolveTracked(h, index, bars, options) {
    const request = h.requests[index];
    assert.ok(request, `repair request ${index} exists`);
    request.q.onMeta?.(repairMeta(request.q, options));
    request.deferred.resolve(bars.map(cloneBar));
    h.resolved.add(index);
    assertResourceCaps();
  }
  function emit(h, name, value) {
    for (const cb of h.subscribers.get(name) ?? []) cb(value);
    assertResourceCaps();
  }
  function snapshotBar(h, time) {
    const bar = h.pipeline.series.get(time);
    assert.ok(bar, `expected existing bar at ${time}`);
    return {
      open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      volume: bar.volume, delta: bar.delta, count: bar.count,
      liquidationBuyVol: bar.liquidationBuyVol ?? 0,
      liquidationSellVol: bar.liquidationSellVol ?? 0,
      cells: [...bar.cells].sort(([a], [b]) => a - b).map(([price, cell]) => [
        price, cell.buyVol, cell.sellVol, cell.count, cell.buyCount, cell.sellCount,
        cell.liquidationBuyVol ?? 0, cell.liquidationSellVol ?? 0,
      ]),
    };
  }
  function assertFinancialBar(bar, { price, volume, delta, count, buyVol, sellVol, buyCount, sellCount }) {
    assert.ok(bar);
    assert.equal(bar.open, price);
    assert.equal(bar.high, price);
    assert.equal(bar.low, price);
    assert.equal(bar.close, price);
    assert.equal(bar.volume, volume);
    assert.equal(bar.delta, delta);
    assert.equal(bar.count, count);
    assert.deepEqual(normalCells(bar), [[price, buyVol, sellVol, count, buyCount, sellCount]]);
    assert.equal(bar.liquidationBuyVol ?? 0, 0);
    assert.equal(bar.liquidationSellVol ?? 0, 0);
    assert.equal(bar.cells.get(price)?.liquidationBuyVol ?? 0, 0);
    assert.equal(bar.cells.get(price)?.liquidationSellVol ?? 0, 0);
  }

  try {
    const a = createBoundedHarness();
    const b = createBoundedHarness();
    let updatesA = 0;
    let updatesB = 0;
    a.pipeline.onUpdate = () => { updatesA++; };
    b.pipeline.onUpdate = () => { updatesB++; };
    async function prime(h) {
      h.sessionCb?.({ generation: 1, epoch: 1, session: "s1", boundaryAt: START + 60_000 });
      emit(h, "M", trade(101, START + 70_000, 10_001, 1, true));
      assert.equal(h.requests.length, 1);
      resolveTracked(h, 0, [aggregate([trade(100, START + 10_000, 10_000, 1, true)])], {
        watermark: "100", coveredFrom: h.requests[0].q.from,
        coveredThrough: h.requests[0].q.to, complete: true,
      });
      await settle();
      boundedFlush(h);
      assert.equal(h.reporters.at(-1)?.state, "healthy");
      assert.equal(h.pipeline.series.length, 1);
      assert.ok(h.pipeline.series.get(START), "initial completed repair must leave a nonempty series");
    }

    await prime(a);
    await prime(b);
    assert.ok(updatesA > 0, "A public subscription must observe prime updates");
    assert.ok(updatesB > 0, "B public subscription must observe prime updates");
    const next = START + INTERVAL;
    now = next + 80_000;
    assert.equal(Math.floor(Date.now() / INTERVAL) * INTERVAL, next, "clock must be inside NEXT bucket");
    const firstTrade = Object.freeze({ ...trade(102, next + 70_000, 10_002, 2, true), tradeCount: 3 });
    const duplicateTrade = Object.freeze({ ...trade(102, next + 70_000, 10_002, 2, true), tradeCount: 3 });
    assert.deepEqual(firstTrade, duplicateTrade);
    assert.ok(firstTrade.time <= Date.now(), "delivery must not rely on a future-event shortcut");
    assert.ok(activeTradeSubscriptions(a) > 0, "A must have active trade subscriptions after prime");
    assert.ok(activeTradeSubscriptions(b) > 0, "B must have active trade subscriptions after prime");
    assert.ok(a.sessionCb, "A must have an active session subscription after prime");
    assert.ok(b.sessionCb, "B must have an active session subscription after prime");
    const baselineB = {
      tradeSubscriptions: activeTradeSubscriptions(b),
      sessionActive: Boolean(b.sessionCb),
      length: b.pipeline.series.length,
      start: snapshotBar(b, START),
      revision: b.pipeline.series.revision,
      structureRevision: b.pipeline.series.structureRevision,
      updates: updatesB,
      reports: b.reporters.length,
      requests: b.requests.length,
    };
    for (const h of [a, b]) {
      assert.equal(h.pipeline.series.isRepairOwned(next), false, "NEXT bucket must be outside repair ownership");
      assert.equal(h.reporters.at(-1)?.state, "healthy");
      assert.equal(h.requests.length, 1, "completed repair must not trigger another request on rollover");
    }
    assert.equal(a.pipeline.series.get(next), undefined);
    assert.equal(b.pipeline.series.get(next), undefined);

    emit(a, "M", firstTrade);
    boundedFlush(a);
    assertFinancialBar(a.pipeline.series.get(next), {
      price: 10_002, volume: 2, delta: 2, count: 3, buyVol: 2, sellVol: 0, buyCount: 3, sellCount: 0,
    });
    assert.equal(a.pipeline.series.isRepairOwned(next), false);
    assert.equal(a.reporters.at(-1)?.state, "healthy");
    assert.equal(a.requests.length, 1);
    assert.equal(b.pipeline.series.length, baselineB.length);
    assert.deepEqual(snapshotBar(b, START), baselineB.start);
    assert.equal(b.pipeline.series.revision, baselineB.revision);
    assert.equal(b.pipeline.series.structureRevision, baselineB.structureRevision);
    assert.equal(updatesB, baselineB.updates);
    assert.equal(b.reporters.length, baselineB.reports);
    assert.equal(b.requests.length, baselineB.requests);
    assert.equal(activeTradeSubscriptions(b), baselineB.tradeSubscriptions);
    assert.equal(Boolean(b.sessionCb), baselineB.sessionActive);
    assert.equal(b.pipeline.series.get(next), undefined);

    emit(a, "M", duplicateTrade);
    boundedFlush(a);
    assert.equal(b.pipeline.series.length, baselineB.length);
    assert.deepEqual(snapshotBar(b, START), baselineB.start);
    assert.equal(b.pipeline.series.revision, baselineB.revision);
    assert.equal(b.pipeline.series.structureRevision, baselineB.structureRevision);
    assert.equal(updatesB, baselineB.updates);
    assert.equal(b.reporters.length, baselineB.reports);
    assert.equal(b.requests.length, baselineB.requests);
    assert.equal(activeTradeSubscriptions(b), baselineB.tradeSubscriptions);
    assert.equal(Boolean(b.sessionCb), baselineB.sessionActive);
    assert.equal(b.pipeline.series.get(next), undefined);

    const control = Object.freeze({ ...trade(70001, next + 8_000, 9_999, 5, false), tradeCount: 1 });
    emit(b, "M", control);
    boundedFlush(b);
    assertFinancialBar(b.pipeline.series.get(next), {
      price: 9_999, volume: 5, delta: -5, count: 1, buyVol: 0, sellVol: 5, buyCount: 0, sellCount: 1,
    });
    assert.ok(b.pipeline.series.revision > baselineB.revision);
    assert.ok(updatesB > baselineB.updates, "B public subscription must receive its control event");
    assert.equal(b.pipeline.series.isRepairOwned(next), false);
    assert.equal(b.reporters.at(-1)?.state, "healthy");
    assert.equal(b.requests.length, 1);

    assertFinancialBar(a.pipeline.series.get(next), {
      price: 10_002, volume: 2, delta: 2, count: 3, buyVol: 2, sellVol: 0, buyCount: 3, sellCount: 0,
    });
    assert.equal(a.pipeline.series.isRepairOwned(next), false);
    assert.equal(a.reporters.at(-1)?.state, "healthy");
    assert.equal(a.requests.length, 1);
    assertResourceCaps();
  } catch (error) {
    primaryError = error;
  } finally {
    for (const h of scenario.resources) {
      for (let i = 0; i < h.requests.length; i++) {
        if (!h.resolved.has(i)) {
          try { h.requests[i].deferred.resolve([]); h.resolved.add(i); }
          catch (error) { cleanupErrors.push(error); }
        }
      }
      try { h.pipeline?.dispose(); }
      catch (error) { cleanupErrors.push(error); }
      for (const unsubscribe of h.unsubscribes) {
        try { unsubscribe(); }
        catch (error) { cleanupErrors.push(error); }
      }
      for (const id of [...h.pendingCallbacks]) {
        try { h.scheduler.cancel(id); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    try { await settle(); }
    catch (error) { cleanupErrors.push(error); }
    for (const h of scenario.resources) {
      if (h.pendingCallbacks.size !== 0) cleanupErrors.push(new Error("manual callbacks remain after cleanup"));
      if (activeTradeSubscriptions(h) !== 0) cleanupErrors.push(new Error("trade subscriptions remain after cleanup"));
      if (h.sessionCb !== undefined) cleanupErrors.push(new Error("session subscription remains after cleanup"));
    }
    if (unresolvedCount() !== 0) cleanupErrors.push(new Error("deferred requests remain unsettled after cleanup"));
    Date.now = previousNow;
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "R1 cleanup failed");
});

const T02D_TARGET = START + INTERVAL;
const T02D_NOW = T02D_TARGET + 90_000;
const T02D_NO_ID = Symbol('no-id');

function t02dTrade(id, time = T02D_TARGET + 70_000, price = 10_002, qty = 2, isBuy = true, tradeCount = 3, includeId = true, liquidation = false) {
  const value = { time, price, qty, tradeCount, isBuy, liquidation, market: 'M', source: 'live', receivedAt: time + 1 };
  if (includeId && id !== T02D_NO_ID) value.id = id;
  return Object.freeze(value);
}

function t02dBudget() {
  const budget = { callbacks: 0, pending: new Set(), fixtures: new Set() };
  budget.assert = () => {
    let deferredCount = 0;
    for (const fixture of budget.fixtures) deferredCount += fixture.requests.filter((entry) => !entry.settled).length;
    assert.ok(budget.callbacks <= 128, 'T02-D callback budget exceeded');
    assert.ok(budget.pending.size <= 3, 'T02-D outstanding callback budget exceeded');
    assert.ok(deferredCount <= 3, 'T02-D outstanding deferred-request budget exceeded');
  };
  return budget;
}

function t02dAddDisposer(fixture, dispose) {
  let active = true;
  fixture.disposers.push(() => {
    if (!active) return;
    active = false;
    dispose();
  });
}

function createT02DFixture(budget, registry) {
  const scheduler = manualScheduler();
  const fixture = {
    scheduler, requests: [], reporters: [], subscribers: new Map(), sessionCb: undefined,
    pipeline: undefined, pendingCallbacks: new Map(), disposers: [],
  };
  budget.fixtures.add(fixture);
  registry.push(fixture);

  const request = scheduler.request.bind(scheduler);
  const cancel = scheduler.cancel.bind(scheduler);
  scheduler.request = (callback) => {
    if (budget.pending.size >= 3) throw new Error('T02-D callback capacity exhausted before allocation');
    const token = Symbol('pending-callback');
    const id = request(() => {
      fixture.pendingCallbacks.delete(token);
      budget.pending.delete(token);
      if (budget.callbacks >= 128) throw new Error('T02-D callback limit reached before callback body');
      budget.callbacks++;
      callback();
      budget.assert();
    });
    fixture.pendingCallbacks.set(token, id);
    budget.pending.add(token);
    budget.assert();
    return id;
  };
  scheduler.cancel = (id) => {
    for (const [token, handle] of fixture.pendingCallbacks) {
      if (handle === id) {
        fixture.pendingCallbacks.delete(token);
        budget.pending.delete(token);
        break;
      }
    }
    cancel(id);
  };

  const services = {
    subscribeToTrades(name, callback) {
      const set = fixture.subscribers.get(name) ?? new Set();
      set.add(callback);
      fixture.subscribers.set(name, set);
      const unsubscribe = () => set.delete(callback);
      t02dAddDisposer(fixture, unsubscribe);
      return unsubscribe;
    },
    subscribeToTradeSessions(callback) {
      fixture.sessionCb = callback;
      const unsubscribe = () => { if (fixture.sessionCb === callback) fixture.sessionCb = undefined; };
      t02dAddDisposer(fixture, unsubscribe);
      return unsubscribe;
    },
    fetchHistory(query) {
      let outstanding = 0;
      for (const owner of budget.fixtures) outstanding += owner.requests.filter((entry) => !entry.settled).length;
      if (outstanding >= 3) throw new Error('T02-D deferred capacity exhausted before allocation');
      const pending = deferred();
      fixture.requests.push({ query, pending, settled: false });
      budget.assert();
      return pending.promise;
    },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      const reporter = { report(state, detail) { fixture.reporters.push({ state, detail }); }, dispose() {} };
      t02dAddDisposer(fixture, () => reporter.dispose());
      return reporter;
    },
  };

  fixture.pipeline = new ChartDataPipeline({ market: 'M', intervalMs: INTERVAL, priceStep: 1, services, scheduler });
  fixture.emit = (market, value) => {
    const callbacks = [...(fixture.subscribers.get(market) ?? [])];
    assert.ok(callbacks.length > 0, 'event must reach an active public subscription');
    for (const callback of callbacks) callback(value);
    budget.assert();
  };
  fixture.flush = () => { scheduler.flushAll(); budget.assert(); };
  fixture.settleRequest = (index, bars, options = {}, runRepair = true) => {
    const entry = fixture.requests[index];
    assert.ok(entry, 'expected public history request');
    if (entry.settled) return;
    if (!runRepair) {
      entry.pending.resolve([]);
      entry.settled = true;
    } else {
      entry.query.onMeta?.(repairMeta(entry.query, options));
      const repairedBars = bars.map(cloneBar);
      entry.pending.resolve(repairedBars);
      entry.settled = true;
    }
    budget.assert();
  };
  fixture.resolve = (index, bars, options = {}) => fixture.settleRequest(index, bars, options, true);
  return fixture;
}

async function withT02DOwners(budget, count, action) {
  const previousNow = Date.now;
  const fixtures = [];
  const cleanupErrors = [];
  let primaryError;
  Date.now = () => T02D_NOW;
  try {
    for (let index = 0; index < count; index++) {
      const fixture = createT02DFixture(budget, fixtures);
      assert.equal(typeof fixture.sessionCb, 'function');
      fixture.sessionCb({ generation: 1, epoch: 1, session: 's1', boundaryAt: START + 60_000 });
      fixture.emit('M', trade(101, START + 70_000, 10_001, 1, true));
      assert.equal(fixture.requests.length, 1);
      const query = fixture.requests[0].query;
      fixture.resolve(0, [], { watermark: '100', coveredFrom: query.from, coveredThrough: query.to, complete: true });
      await settle();
      fixture.flush();
      assert.equal(fixture.reporters.at(-1)?.state, 'healthy');
      assert.equal(fixture.pipeline.series.isRepairOwned(T02D_TARGET), false);
    }
    await action(fixtures);
  } catch (error) {
    primaryError = error;
  } finally {
    for (const fixture of fixtures) {
      for (const entry of fixture.requests) {
        if (!entry.settled) {
          try {
            entry.pending.resolve([]);
            entry.settled = true;
          } catch (error) { cleanupErrors.push(error); }
        }
      }
      try { fixture.pipeline?.dispose(); }
      catch (error) { cleanupErrors.push(error); }
      for (const dispose of [...fixture.disposers].reverse()) {
        try { dispose(); }
        catch (error) { cleanupErrors.push(error); }
      }
      for (const id of [...fixture.pendingCallbacks.values()]) {
        try { fixture.scheduler.cancel(id); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    try { await settle(); }
    catch (error) { cleanupErrors.push(error); }
    for (const fixture of fixtures) {
      if (fixture.pendingCallbacks.size !== 0) cleanupErrors.push(new Error('manual callbacks remain after cleanup'));
      if ([...fixture.subscribers.values()].some((set) => set.size !== 0)) cleanupErrors.push(new Error('trade subscriptions remain after cleanup'));
      if (fixture.sessionCb !== undefined) cleanupErrors.push(new Error('session subscription remains after cleanup'));
      if (fixture.requests.some((entry) => !entry.settled)) cleanupErrors.push(new Error('deferred requests remain unsettled after cleanup'));
      budget.fixtures.delete(fixture);
    }
    try { budget.assert(); }
    catch (error) { cleanupErrors.push(error); }
    Date.now = previousNow;
  }
  if (primaryError && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'T02-D cleanup failed; primary error is the cause', { cause: primaryError });
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'T02-D cleanup failed');
}

function t02dCellRows(bar) {
  return [...bar.cells.entries()]
    .sort(([priceA], [priceB]) => priceA - priceB)
    .map(([price, cell]) => [
      price, cell.buyVol, cell.sellVol, cell.count, cell.buyCount, cell.sellCount,
      cell.liquidationBuyVol ?? 0, cell.liquidationSellVol ?? 0,
    ]);
}

function t02dSnapshotAt(fixture, time) {
  const bar = fixture.pipeline.series.get(time);
  if (!bar) return null;
  return {
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volume: bar.volume, delta: bar.delta, count: bar.count,
    liquidationBuyVol: bar.liquidationBuyVol ?? 0, liquidationSellVol: bar.liquidationSellVol ?? 0,
    cells: t02dCellRows(bar),
  };
}

function assertT02DBar(fixture, expected, time = T02D_TARGET) {
  const bar = fixture.pipeline.series.get(time);
  assert.ok(bar, 'expected candle');
  for (const key of ['open', 'high', 'low', 'close', 'volume', 'delta', 'count']) assert.equal(bar[key], expected[key]);
  assert.deepEqual(normalCells(bar), expected.cells);
  assert.equal(bar.liquidationBuyVol ?? 0, expected.liquidationBuyVol ?? 0);
  assert.equal(bar.liquidationSellVol ?? 0, expected.liquidationSellVol ?? 0);
  const cells = t02dCellRows(bar);
  assert.deepEqual(cells, expected.fullCells ?? expected.cells.map(([price, buy, sell, trades, buyCount, sellCount]) => [price, buy, sell, trades, buyCount, sellCount, 0, 0]));
}

function t02dSnapshot(fixture) { return t02dSnapshotAt(fixture, T02D_TARGET); }

function t02dSubscriptionCounts(fixture) {
  return [...fixture.subscribers].map(([name, callbacks]) => [name, callbacks.size]).sort(([a], [b]) => a.localeCompare(b));
}

function t02dAssertBSame(b, baseline) {
  assert.deepEqual(t02dSnapshotAt(b, START), baseline.startBar);
  assert.equal(b.pipeline.series.get(T02D_TARGET), undefined);
  assert.equal(b.pipeline.series.revision, baseline.revision);
  assert.equal(b.pipeline.series.structureRevision, baseline.structureRevision);
  assert.equal(baseline.updates(), baseline.updateCount);
  assert.equal(b.requests.length, baseline.requests);
  assert.equal(b.reporters.length, baseline.reports);
  assert.deepEqual(t02dSubscriptionCounts(b), baseline.subscriptions);
  assert.equal(b.sessionCb, baseline.sessionCb);
}

test('equal-value anonymous normal events retain both contributions', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const budget = t02dBudget();
  const expected = { open: 10_002, high: 10_002, low: 10_002, close: 10_002, volume: 4, delta: 4, count: 6, cells: [[10_002, 4, 0, 6, 6, 0]] };
  await withT02DOwners(budget, 1, async ([fixture]) => {
    fixture.pipeline.onUpdate = () => {};
    fixture.emit('M', t02dTrade(T02D_NO_ID));
    fixture.emit('M', t02dTrade(T02D_NO_ID));
    fixture.flush();
    assertT02DBar(fixture, expected);
  });
  await withT02DOwners(budget, 1, async ([fixture]) => {
    fixture.pipeline.onUpdate = () => {};
    fixture.emit('M', t02dTrade(T02D_NO_ID));
    fixture.flush();
    fixture.emit('M', t02dTrade(T02D_NO_ID));
    fixture.flush();
    assertT02DBar(fixture, expected);
  });
});

test('absent or non-string IDs stay anonymous', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const budget = t02dBudget();
  const variants = [['empty', '', true], ['undefined', undefined, true], ['absent', undefined, false], ['null', null, true], ['number-zero', 0, true]];
  for (const [label, id, includeId] of variants) {
    await withT02DOwners(budget, 1, async ([fixture]) => {
      fixture.pipeline.onUpdate = () => {};
      fixture.emit('M', t02dTrade(id, T02D_TARGET + 70_000, 10_002, 2, true, 3, includeId));
      fixture.emit('M', t02dTrade(id, T02D_TARGET + 70_000, 10_002, 2, true, 3, includeId));
      fixture.flush();
      assertT02DBar(fixture, { open: 10_002, high: 10_002, low: 10_002, close: 10_002, volume: 4, delta: 4, count: 6, cells: [[10_002, 4, 0, 6, 6, 0]] });
      assert.ok(label.length > 0);
    });
  }
});

test('string zero identity deduplicates normal delivery', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const budget = t02dBudget();
  await withT02DOwners(budget, 1, async ([fixture]) => {
    fixture.pipeline.onUpdate = () => {};
    fixture.emit('M', t02dTrade('0'));
    fixture.flush();
    fixture.emit('M', t02dTrade('0'));
    fixture.flush();
    assertT02DBar(fixture, { open: 10_002, high: 10_002, low: 10_002, close: 10_002, volume: 2, delta: 2, count: 3, cells: [[10_002, 2, 0, 3, 3, 0]] });
  });
});

test('mixed identified and anonymous delivery preserves order and totals', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const budget = t02dBudget();
  await withT02DOwners(budget, 1, async ([fixture]) => {
    fixture.pipeline.onUpdate = () => {};
    const events = [
      t02dTrade('201', T02D_TARGET + 70_000, 10_002, 2, true, 3),
      t02dTrade(T02D_NO_ID, T02D_TARGET + 71_000, 10_001, 1, false, 2),
      t02dTrade('201', T02D_TARGET + 70_000, 10_002, 2, true, 3),
      t02dTrade(T02D_NO_ID, T02D_TARGET + 71_000, 10_001, 1, false, 2),
      t02dTrade('202', T02D_TARGET + 72_000, 10_003, 3, true, 4),
    ];
    for (const event of events) fixture.emit('M', event);
    fixture.flush();
    assertT02DBar(fixture, {
      open: 10_002, high: 10_003, low: 10_001, close: 10_003, volume: 7, delta: 3, count: 11,
      cells: [[10_001, 0, 2, 4, 0, 4], [10_002, 2, 0, 3, 3, 0], [10_003, 3, 0, 4, 4, 0]],
    });
  });
});

test('normal identity dedup remains owner-local', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const budget = t02dBudget();
  await withT02DOwners(budget, 2, async ([a, b]) => {
    let updatesA = 0;
    let updatesB = 0;
    a.pipeline.onUpdate = () => { updatesA++; };
    b.pipeline.onUpdate = () => { updatesB++; };
    const startBar = t02dSnapshotAt(b, START);
    assert.ok(startBar, 'B must have its populated START bar after healthy repair');
    assert.ok(startBar.cells.length > 0, 'B START bar must contain real cells');
    assert.equal(b.pipeline.series.get(T02D_TARGET), undefined, 'B target bar must start absent');
    const baseline = {
      startBar, revision: b.pipeline.series.revision, structureRevision: b.pipeline.series.structureRevision,
      updates: () => updatesB, updateCount: updatesB, requests: b.requests.length, reports: b.reporters.length,
      subscriptions: t02dSubscriptionCounts(b), sessionCb: b.sessionCb,
    };
    assert.ok(baseline.subscriptions.some(([name, size]) => name === 'M' && size > 0));
    a.emit('M', t02dTrade('102'));
    a.flush();
    assertT02DBar(a, { open: 10_002, high: 10_002, low: 10_002, close: 10_002, volume: 2, delta: 2, count: 3, cells: [[10_002, 2, 0, 3, 3, 0]] });
    assert.ok(updatesA > 0);
    t02dAssertBSame(b, baseline);
    const revisionA = a.pipeline.series.revision;
    a.emit('M', t02dTrade('102'));
    a.flush();
    assert.equal(a.pipeline.series.revision, revisionA);
    t02dAssertBSame(b, baseline);
    b.emit('M', t02dTrade('102'));
    b.flush();
    assert.ok(updatesB > baseline.updateCount);
    assertT02DBar(b, { open: 10_002, high: 10_002, low: 10_002, close: 10_002, volume: 2, delta: 2, count: 3, cells: [[10_002, 2, 0, 3, 3, 0]] });
    const revisionB = b.pipeline.series.revision;
    b.emit('M', t02dTrade('102'));
    b.flush();
    assert.equal(b.pipeline.series.revision, revisionB);
    assertT02DBar(b, { open: 10_002, high: 10_002, low: 10_002, close: 10_002, volume: 2, delta: 2, count: 3, cells: [[10_002, 2, 0, 3, 3, 0]] });
  });
});

test('liquidation contributions preserve legacy no-dedup semantics', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const budget = t02dBudget();
  const expected = {
    open: 10_002, high: 10_002, low: 10_002, close: 10_002, volume: 2, delta: 2, count: 3,
    liquidationBuyVol: 10, liquidationSellVol: 0,
    cells: [[10_002, 2, 0, 3, 3, 0]],
    fullCells: [[10_002, 2, 0, 3, 3, 0, 10, 0]],
  };
  for (const liquidationFirst of [false, true]) {
    await withT02DOwners(budget, 1, async ([fixture]) => {
      fixture.pipeline.onUpdate = () => {};
      const normal = t02dTrade('102', T02D_TARGET + 70_000, 10_002, 2, true, 3);
      const liquidationA = t02dTrade('102', T02D_TARGET + 71_000, 10_002, 5, true, 1, true, true);
      const liquidationB = t02dTrade('102', T02D_TARGET + 71_000, 10_002, 5, true, 1, true, true);
      const events = liquidationFirst ? [liquidationA, liquidationB, normal] : [normal, liquidationA, liquidationB];
      for (const event of events) fixture.emit('M', event);
      fixture.flush();
      assertT02DBar(fixture, expected);
    });
  }
});

// T02-D L1-L3 append-local case-wide instrumentation.
function t02dCreateCaseLedger() {
  const budget = t02dBudget();
  const ledger = {
    budget, fixtures: budget.fixtures,
    tradeAllocations: 0, deliveries: 0, historyRequests: 0, publicRecords: 0,
    maxOwners: 0,
  };
  ledger.assertBounds = () => {
    assert.ok(ledger.tradeAllocations <= 32, 'T02-D case-wide trade allocation budget exceeded');
    assert.ok(ledger.deliveries <= 32, 'T02-D case-wide delivery budget exceeded');
    assert.ok(ledger.fixtures.size <= 2, 'T02-D simultaneous owner budget exceeded');
    assert.ok(ledger.maxOwners <= 2, 'T02-D maximum owner budget exceeded');
    assert.ok(ledger.historyRequests <= 8, 'T02-D total history request budget exceeded');
    assert.ok(ledger.publicRecords <= 256, 'T02-D public record budget exceeded');
    budget.assert();
  };
  ledger.allocateTrade = (factory) => {
    assert.ok(ledger.tradeAllocations < 32, 'T02-D allocation cap reached before trade creation');
    ledger.tradeAllocations++;
    const value = factory();
    ledger.assertBounds();
    return value;
  };
  ledger.recordPublic = () => {
    assert.ok(ledger.publicRecords < 256, 'T02-D public record cap reached before recording');
    ledger.publicRecords++;
    ledger.assertBounds();
  };
  ledger.deliver = (fixture, market, value) => {
    const callbacks = [...(fixture.subscribers.get(market) ?? [])];
    assert.ok(callbacks.length > 0, 'event must reach an active public subscription');
    for (const callback of callbacks) {
      assert.ok(ledger.deliveries < 32, 'T02-D delivery cap reached before callback invocation');
      ledger.deliveries++;
      ledger.assertBounds();
      callback(value);
      ledger.assertBounds();
    }
  };
  ledger.emitNew = (fixture, market, factory) => {
    const value = ledger.allocateTrade(factory);
    ledger.deliver(fixture, market, value);
    return value;
  };
  return ledger;
}

function t02dCreateCaseFixture(ledger, holders, constructorCallbacks = {}) {
  assert.ok(ledger.fixtures.size < 2, 'T02-D owner cap reached before fixture construction');
  const scheduler = manualScheduler();
  const fixture = {
    scheduler, requests: [], reporters: [], subscribers: new Map(), sessionCb: undefined,
    pipeline: undefined, pendingCallbacks: new Map(), disposers: [], updateCount: 0,
  };
  // Register the partial holder before any constructor/service operation.
  ledger.fixtures.add(fixture);
  holders.push(fixture);
  ledger.maxOwners = Math.max(ledger.maxOwners, ledger.fixtures.size);
  ledger.assertBounds();

  const request = scheduler.request.bind(scheduler);
  const cancel = scheduler.cancel.bind(scheduler);
  scheduler.request = (callback) => {
    const budget = ledger.budget;
    assert.ok(budget.pending.size < 3, 'T02-D callback cap reached before allocation');
    const token = Symbol('pending-callback');
    const id = request(() => {
      fixture.pendingCallbacks.delete(token);
      budget.pending.delete(token);
      assert.ok(budget.callbacks < 128, 'T02-D callback cap reached before callback body');
      budget.callbacks++;
      try { callback(); }
      finally { budget.assert(); }
    });
    fixture.pendingCallbacks.set(token, id);
    budget.pending.add(token);
    ledger.assertBounds();
    return id;
  };
  scheduler.cancel = (id) => {
    for (const [token, handle] of fixture.pendingCallbacks) {
      if (handle === id) {
        fixture.pendingCallbacks.delete(token);
        ledger.budget.pending.delete(token);
        break;
      }
    }
    cancel(id);
    ledger.assertBounds();
  };

  const services = {
    subscribeToTrades(name, callback) {
      const set = fixture.subscribers.get(name) ?? new Set();
      set.add(callback);
      fixture.subscribers.set(name, set);
      const unsubscribe = () => set.delete(callback);
      t02dAddDisposer(fixture, unsubscribe);
      return unsubscribe;
    },
    subscribeToTradeSessions(callback) {
      fixture.sessionCb = callback;
      const unsubscribe = () => { if (fixture.sessionCb === callback) fixture.sessionCb = undefined; };
      t02dAddDisposer(fixture, unsubscribe);
      return unsubscribe;
    },
    fetchHistory(query) {
      assert.ok(ledger.historyRequests < 8, 'T02-D total request cap reached before deferred allocation');
      let outstanding = 0;
      for (const owner of ledger.fixtures) {
        outstanding += owner.requests.filter((entry) => !entry.settled).length;
      }
      assert.ok(outstanding < 3, 'T02-D outstanding request cap reached before deferred allocation');
      ledger.historyRequests++;
      const entry = { query, pending: undefined, settled: false };
      fixture.requests.push(entry);
      ledger.assertBounds();
      try {
        const pending = deferred();
        entry.pending = pending;
        ledger.assertBounds();
        return pending.promise;
      } catch (error) {
        if (entry.pending === undefined) entry.settled = true;
        throw error;
      }
    },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      const reporter = {
        report(state, detail) {
          ledger.recordPublic();
          fixture.reporters.push({ state, detail });
        },
        dispose() {},
      };
      t02dAddDisposer(fixture, () => reporter.dispose());
      return reporter;
    },
  };

  const onServerPriceStep = constructorCallbacks.onServerPriceStep;
  const publicConstructorOptions = typeof onServerPriceStep === 'function'
    ? { onServerPriceStep(step) { ledger.recordPublic(); onServerPriceStep(step); } }
    : {};
  fixture.pipeline = new ChartDataPipeline({
    market: 'M', intervalMs: INTERVAL, priceStep: 1, services, scheduler, ...publicConstructorOptions,
  });
  // The current constructor reports healthy but emits no onUpdate; install immediately
  // after construction, before any session callback, setup trade, or prime operation.
  fixture.pipeline.onUpdate = () => {
    ledger.recordPublic();
    fixture.updateCount++;
  };
  fixture.emit = (market, value) => ledger.deliver(fixture, market, value);
  fixture.applyMeta = (index, options) => {
    const entry = fixture.requests[index];
    assert.ok(entry && !entry.settled, 'expected unsettled public history request');
    entry.query.onMeta?.(repairMeta(entry.query, options));
    ledger.assertBounds();
  };
  fixture.resolveBars = (index, bars) => {
    const entry = fixture.requests[index];
    assert.ok(entry && !entry.settled, 'expected unsettled public history request');
    const resolvedBars = bars.map(cloneBar);
    entry.pending.resolve(resolvedBars);
    entry.settled = true;
    ledger.assertBounds();
  };
  fixture.flush = () => {
    scheduler.flushAll();
    ledger.assertBounds();
  };
  return fixture;
}

async function withT02DCaseOwnersV2(ledger, count, now, action, perOwnerOptions = []) {
  const previousNow = Date.now;
  const fixtures = [];
  const cleanupErrors = [];
  let primaryError;
  try {
    Date.now = () => now;
    for (let index = 0; index < count; index++) t02dCreateCaseFixture(ledger, fixtures, perOwnerOptions[index] ?? {});
    await action(fixtures);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      for (const fixture of fixtures) {
        for (const entry of fixture.requests) {
          if (!entry.settled) {
            try {
              assert.ok(entry.pending, 'unallocated deferred request remains');
              entry.pending.resolve([]);
              entry.settled = true;
              ledger.assertBounds();
            } catch (error) { cleanupErrors.push(error); }
          }
        }
      }
      for (const fixture of fixtures) {
        try { fixture.pipeline?.dispose(); }
        catch (error) { cleanupErrors.push(error); }
        for (const dispose of [...fixture.disposers].reverse()) {
          try { dispose(); }
          catch (error) { cleanupErrors.push(error); }
        }
        for (const id of [...fixture.pendingCallbacks.values()]) {
          try { fixture.scheduler.cancel(id); }
          catch (error) { cleanupErrors.push(error); }
        }
      }
      try { await settle(); }
      catch (error) { cleanupErrors.push(error); }
      for (const fixture of fixtures) {
        if (fixture.pendingCallbacks.size !== 0) cleanupErrors.push(new Error('manual callbacks remain after T02-D cleanup'));
        if ([...fixture.subscribers.values()].some((set) => set.size !== 0)) cleanupErrors.push(new Error('trade subscriptions remain after T02-D cleanup'));
        if (fixture.sessionCb !== undefined) cleanupErrors.push(new Error('session subscriber remains after T02-D cleanup'));
        if (fixture.requests.some((entry) => !entry.settled)) cleanupErrors.push(new Error('history request remains unsettled after T02-D cleanup'));
        ledger.fixtures.delete(fixture);
      }
      if (ledger.budget.pending.size !== 0) cleanupErrors.push(new Error('global manual callbacks remain after T02-D cleanup'));
      try { ledger.assertBounds(); }
      catch (error) { cleanupErrors.push(error); }
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try { Date.now = previousNow; }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  if (primaryError && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'T02-D cleanup failed; primary error is the cause', { cause: primaryError });
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'T02-D cleanup failed');
}

async function t02dPrimeOwnerV2(ledger, fixture, sessionReady = false) {
  assert.equal(typeof fixture.sessionCb, 'function');
  if (!sessionReady) fixture.sessionCb({ generation: 1, epoch: 1, session: 's1', boundaryAt: START + 60_000 });
  ledger.assertBounds();
  ledger.emitNew(fixture, 'M', () => trade(101, START + 70_000, 10_001, 1, true));
  assert.equal(fixture.requests.length, 1);
  const query = fixture.requests[0].query;
  fixture.applyMeta(0, { watermark: '100', coveredFrom: query.from, coveredThrough: query.to, complete: true });
  fixture.resolveBars(0, []);
  await settle();
  ledger.assertBounds();
  fixture.flush();
  assert.equal(fixture.reporters.at(-1)?.state, 'healthy');
  assert.equal(fixture.pipeline.series.isRepairOwned(T02D_TARGET), false);
  ledger.assertBounds();
}

test('post-repair late trades preserve event-time OHLC in the repair-owned open candle', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const ledger = t02dCreateCaseLedger();
  const prefix = {
    startTime: START,
    open: 10_000, high: 10_001, low: 9_999, close: 9_999,
    volume: 6, delta: 0, count: 6,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([
      [9_999, { priceBin: 9_999, buyVol: 1, sellVol: 0, count: 3, buyCount: 3, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [10_000, { priceBin: 10_000, buyVol: 2, sellVol: 0, count: 2, buyCount: 2, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      [10_001, { priceBin: 10_001, buyVol: 0, sellVol: 3, count: 1, buyCount: 0, sellCount: 1, liquidationBuyVol: 0, liquidationSellVol: 0 }],
    ]),
    hasRef: true, completeness: 'complete', sources: ['history'], updatedAt: START + 70_000,
  };
  const expectedPrefix = {
    open: 10_000, high: 10_001, low: 9_999, close: 9_999,
    volume: 6, delta: 0, count: 6,
    cells: [[9_999, 1, 0, 3, 3, 0], [10_000, 2, 0, 2, 2, 0], [10_001, 0, 3, 1, 0, 1]],
    fullCells: [[9_999, 1, 0, 3, 3, 0, 0, 0], [10_000, 2, 0, 2, 2, 0, 0, 0], [10_001, 0, 3, 1, 0, 1, 0, 0]],
    liquidationBuyVol: 0, liquidationSellVol: 0,
  };
  const expectedFinal = {
    open: 10_000, high: 10_002, low: 9_999, close: 10_002,
    volume: 11, delta: -1, count: 11,
    cells: [[9_999, 1, 3, 6, 3, 3], [10_000, 2, 0, 2, 2, 0], [10_001, 0, 3, 1, 0, 1], [10_002, 2, 0, 2, 2, 0]],
    fullCells: [[9_999, 1, 3, 6, 3, 3, 0, 0], [10_000, 2, 0, 2, 2, 0, 0, 0], [10_001, 0, 3, 1, 0, 1, 0, 0], [10_002, 2, 0, 2, 2, 0, 0, 0]],
    liquidationBuyVol: 0, liquidationSellVol: 0,
  };
  const expectedB = {
    open: 10_001, high: 10_002, low: 10_001, close: 10_002,
    volume: 3, delta: 3, count: 2,
    cells: [[10_001, 1, 0, 1, 1, 0], [10_002, 2, 0, 1, 1, 0]],
  };

  for (const separateFlush of [false, true]) {
    await withT02DCaseOwnersV2(ledger, 2, START + 90_000, async ([a, b]) => {
      assert.equal(Math.floor(Date.now() / INTERVAL) * INTERVAL, START, 'START is still the current open bucket');
      for (const fixture of [a, b]) {
        assert.equal(typeof fixture.sessionCb, 'function');
        fixture.sessionCb({ generation: 1, epoch: 1, session: 's1', boundaryAt: START + 60_000 });
        ledger.assertBounds();
      }
      await t02dPrimeOwnerV2(ledger, b, true);

      const baselineB = {
        startBar: t02dSnapshotAt(b, START), targetBar: t02dSnapshot(b),
        length: b.pipeline.series.length,
        revision: b.pipeline.series.revision, structureRevision: b.pipeline.series.structureRevision,
        updates: b.updateCount, requests: b.requests.length, reports: b.reporters.length,
        subscriptions: t02dSubscriptionCounts(b), sessionCb: b.sessionCb,
      };
      assert.ok(baselineB.startBar?.volume > 0, 'B must have a populated financial baseline');
      assert.ok(baselineB.startBar.cells.length > 0, 'B must have populated footprint cells');
      assert.ok(baselineB.subscriptions.some(([market, size]) => market === 'M' && size > 0));
      assert.ok(baselineB.sessionCb);
      assert.equal(baselineB.targetBar, null);

      function assertBUnchanged() {
        assert.deepEqual(t02dSnapshotAt(b, START), baselineB.startBar);
        assert.equal(t02dSnapshot(b), baselineB.targetBar);
        assert.equal(b.pipeline.series.length, baselineB.length);
        assert.equal(b.pipeline.series.revision, baselineB.revision);
        assert.equal(b.pipeline.series.structureRevision, baselineB.structureRevision);
        assert.equal(b.updateCount, baselineB.updates);
        assert.equal(b.requests.length, baselineB.requests);
        assert.equal(b.reporters.length, baselineB.reports);
        assert.deepEqual(t02dSubscriptionCounts(b), baselineB.subscriptions);
        assert.equal(b.sessionCb, baselineB.sessionCb);
      }

      const coveredWitness = ledger.allocateTrade(() => t02dTrade('102', START + 70_000, 9_999, 1, true, 3));
      ledger.deliver(a, 'M', coveredWitness);
      ledger.assertBounds();
      assertBUnchanged();
      assert.equal(a.requests.length, 1);
      const query = a.requests[0].query;
      a.applyMeta(0, { watermark: '102', coveredFrom: query.from, coveredThrough: query.to, complete: true });
      assertBUnchanged();
      a.resolveBars(0, [prefix]);
      assertBUnchanged();
      await settle();
      ledger.assertBounds();
      assertBUnchanged();
      a.flush();
      ledger.assertBounds();
      assertBUnchanged();
      assert.equal(a.reporters.at(-1)?.state, 'healthy');
      assert.equal(a.pipeline.series.isRepairOwned(START), true);
      assert.equal(a.pipeline.series.isRepairOwned(T02D_TARGET), false);
      assertT02DBar(a, expectedPrefix, START);

      const late103 = ledger.allocateTrade(() => t02dTrade('103', START + 80_000, 10_002, 2, true, 2));
      const late104 = ledger.allocateTrade(() => t02dTrade('104', START + 70_000, 9_999, 3, false, 3));
      ledger.deliver(a, 'M', late103);
      ledger.assertBounds();
      assertBUnchanged();
      if (separateFlush) {
        a.flush();
        ledger.assertBounds();
        assertBUnchanged();
      }
      ledger.deliver(a, 'M', late104);
      ledger.assertBounds();
      assertBUnchanged();
      if (separateFlush) {
        a.flush();
        ledger.assertBounds();
        assertBUnchanged();
      }
      if (!separateFlush) {
        a.flush();
        ledger.assertBounds();
        assertBUnchanged();
      }

      assert.equal(a.pipeline.series.isRepairOwned(START), true);
      assertT02DBar(a, expectedFinal, START);
      const finalBar = t02dSnapshotAt(a, START);
      for (const key of ['open', 'high', 'low', 'close', 'volume', 'delta', 'count', 'liquidationBuyVol', 'liquidationSellVol']) {
        assert.ok(Number.isFinite(finalBar[key]), `${key} must be finite`);
      }
      for (const cell of finalBar.cells) for (const value of cell) assert.ok(Number.isFinite(value), 'cell values must be finite');
      assert.equal(finalBar.liquidationBuyVol, 0);
      assert.equal(finalBar.liquidationSellVol, 0);
      assertBUnchanged();

      const committed = t02dSnapshotAt(a, START);
      const committedRevision = a.pipeline.series.revision;
      ledger.deliver(a, 'M', late103);
      ledger.assertBounds();
      assertBUnchanged();
      ledger.deliver(a, 'M', late104);
      ledger.assertBounds();
      assertBUnchanged();
      a.flush();
      ledger.assertBounds();
      assertBUnchanged();
      assert.deepEqual(t02dSnapshotAt(a, START), committed, 'post-commit duplicate IDs must not add contributions');
      assert.equal(a.pipeline.series.revision, committedRevision);

      const updatesAAfterDuplicates = a.updateCount;
      ledger.emitNew(b, 'M', () => t02dTrade('102', START + 85_000, 10_002, 2, true, 1));
      b.flush();
      ledger.assertBounds();
      assertT02DBar(b, expectedB, START);
      assert.ok(b.updateCount > baselineB.updates, 'B must remain independently live');
      assert.equal(b.pipeline.series.revision > baselineB.revision, true);
      assert.equal(b.pipeline.series.isRepairOwned(START), true);
      assert.equal(b.requests.length, baselineB.requests);
      assert.equal(b.reporters.length, baselineB.reports);
      assert.deepEqual(t02dSubscriptionCounts(b), baselineB.subscriptions);
      assert.equal(b.sessionCb, baselineB.sessionCb);
      assert.deepEqual(t02dSnapshotAt(a, START), committed);
      assert.equal(a.pipeline.series.revision, committedRevision);
      assert.equal(a.updateCount, updatesAAfterDuplicates);
    });
  }
  ledger.assertBounds();
});

test('normal event-time ordering holds for one-batch and per-delivery flushes', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const ledger = t02dCreateCaseLedger();
  const expected = {
    open: 10_000, high: 10_002, low: 9_999, close: 10_002,
    volume: 6, delta: 0, count: 11,
    cells: [[9_999, 0, 3, 2, 0, 2], [10_000, 1, 0, 4, 4, 0], [10_002, 2, 0, 5, 5, 0]],
  };

  for (const separateFlush of [false, true]) {
    await withT02DCaseOwnersV2(ledger, 1, T02D_NOW, async ([fixture]) => {
      await t02dPrimeOwnerV2(ledger, fixture);
      assert.equal(Math.floor(Date.now() / INTERVAL) * INTERVAL, T02D_TARGET);
      assert.equal(fixture.pipeline.series.isRepairOwned(T02D_TARGET), false);

      const factories = [
        () => t02dTrade('201', T02D_TARGET + 80_000, 10_002, 2, true, 5),
        () => t02dTrade('202', T02D_TARGET + 70_000, 9_999, 3, false, 2),
        () => t02dTrade('200', T02D_TARGET + 60_000, 10_000, 1, true, 4),
      ];
      const events = [];
      for (const factory of factories) {
        const event = ledger.emitNew(fixture, 'M', factory);
        events.push(event);
        if (separateFlush) {
          fixture.flush();
          ledger.assertBounds();
        }
      }
      if (!separateFlush) {
        fixture.flush();
        ledger.assertBounds();
      }
      assertT02DBar(fixture, expected, T02D_TARGET);
      assert.equal(fixture.pipeline.series.isRepairOwned(T02D_TARGET), false);
      const committed = t02dSnapshotAt(fixture, T02D_TARGET);
      const committedRevision = fixture.pipeline.series.revision;

      for (const event of events) {
        ledger.deliver(fixture, 'M', event);
        if (separateFlush) {
          fixture.flush();
          ledger.assertBounds();
        }
      }
      if (!separateFlush) {
        fixture.flush();
        ledger.assertBounds();
      }
      assert.deepEqual(t02dSnapshotAt(fixture, T02D_TARGET), committed, 'final duplicate deliveries must preserve the snapshot');
      assert.equal(fixture.pipeline.series.revision, committedRevision);
      assertT02DBar(fixture, expected, T02D_TARGET);
    });
  }
  ledger.assertBounds();
});

test('wrong-market events cannot mutate either subscribed owner', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const ledger = t02dCreateCaseLedger();
  const expectedA = {
    open: 10_002, high: 10_002, low: 10_002, close: 10_002,
    volume: 2, delta: 2, count: 2, cells: [[10_002, 2, 0, 2, 2, 0]],
  };
  const expectedB = {
    open: 9_999, high: 9_999, low: 9_999, close: 9_999,
    volume: 3, delta: -3, count: 1, cells: [[9_999, 0, 3, 1, 0, 1]],
  };

  await withT02DCaseOwnersV2(ledger, 2, T02D_NOW, async ([a, b]) => {
    for (const fixture of [a, b]) await t02dPrimeOwnerV2(ledger, fixture);

    function capture(fixture) {
      return {
        startBar: t02dSnapshotAt(fixture, START), targetBar: t02dSnapshot(fixture),
        length: fixture.pipeline.series.length,
        revision: fixture.pipeline.series.revision,
        structureRevision: fixture.pipeline.series.structureRevision,
        updates: fixture.updateCount, requests: fixture.requests.length, reports: fixture.reporters.length,
        subscriptions: t02dSubscriptionCounts(fixture), sessionCb: fixture.sessionCb,
      };
    }
    const baselineA = capture(a);
    const baselineB = capture(b);
    for (const baseline of [baselineA, baselineB]) {
      assert.ok(baseline.startBar?.volume > 0, 'each owner needs a populated financial baseline');
      assert.ok(baseline.startBar.cells.length > 0, 'each owner needs populated footprint cells');
      assert.equal(baseline.targetBar, null);
      assert.ok(baseline.subscriptions.some(([market, size]) => market === 'M' && size > 0));
      assert.ok(baseline.sessionCb);
    }

    const wrongBase = ledger.allocateTrade(() => t02dTrade('901', T02D_TARGET + 80_000, 10_002, 2, true, 1));
    const wrongMarket = ledger.allocateTrade(() => Object.freeze({ ...wrongBase, market: 'N' }));
    assert.equal(wrongMarket.market, 'N');
    ledger.deliver(a, 'M', wrongMarket);
    assert.deepEqual(capture(a), baselineA, 'A wrong-market callback must be a no-op');
    assert.deepEqual(capture(b), baselineB, 'A wrong-market callback must not affect B');
    ledger.deliver(b, 'M', wrongMarket);
    assert.deepEqual(capture(a), baselineA, 'B wrong-market callback must not affect A');
    assert.deepEqual(capture(b), baselineB, 'B wrong-market callback must be a no-op');

    ledger.emitNew(a, 'M', () => t02dTrade('401', T02D_TARGET + 80_000, 10_002, 2, true, 2));
    a.flush();
    ledger.assertBounds();
    assertT02DBar(a, expectedA, T02D_TARGET);
    assert.ok(a.pipeline.series.revision > baselineA.revision);
    assert.ok(a.updateCount > baselineA.updates, 'A M delivery must reach its owner callback');
    assert.deepEqual(capture(b), baselineB, 'A valid delivery remains owner-local');
    const afterA = capture(a);

    ledger.emitNew(b, 'M', () => t02dTrade('402', T02D_TARGET + 75_000, 9_999, 3, false, 1));
    b.flush();
    ledger.assertBounds();
    assertT02DBar(b, expectedB, T02D_TARGET);
    assert.ok(b.pipeline.series.revision > baselineB.revision);
    assert.ok(b.updateCount > baselineB.updates, 'B M delivery must reach its owner callback');
    assert.deepEqual(capture(a), afterA, 'B valid delivery must leave A unchanged');
  });
  ledger.assertBounds();
});
test('superseded repair metadata cannot notify the active owner', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const ledger = t02dCreateCaseLedger();
  const serverStepsA = [];
  const serverStepsB = [];
  const expectedStart = {
    open: 10_001, high: 10_001, low: 10_001, close: 10_001,
    volume: 1, delta: 1, count: 1, cells: [[10_001, 1, 0, 1, 1, 0]],
  };
  const expectedTarget = {
    open: 10_002, high: 10_002, low: 10_002, close: 10_002,
    volume: 2, delta: 2, count: 3, cells: [[10_002, 2, 0, 3, 3, 0]],
  };
  const expectedB = {
    open: 9_999, high: 9_999, low: 9_999, close: 9_999,
    volume: 3, delta: -3, count: 1, cells: [[9_999, 0, 3, 1, 0, 1]],
  };
  const sourceBars = [
    {
      startTime: START,
      open: 10_001, high: 10_001, low: 10_001, close: 10_001,
      volume: 1, delta: 1, count: 1,
      liquidationBuyVol: 0, liquidationSellVol: 0,
      cells: new Map([[10_001, { priceBin: 10_001, buyVol: 1, sellVol: 0, count: 1, buyCount: 1, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
      hasRef: true, completeness: 'complete', sources: ['history'], updatedAt: START + 70_000,
    },
    {
      startTime: T02D_TARGET,
      open: 10_002, high: 10_002, low: 10_002, close: 10_002,
      volume: 2, delta: 2, count: 3,
      liquidationBuyVol: 0, liquidationSellVol: 0,
      cells: new Map([[10_002, { priceBin: 10_002, buyVol: 2, sellVol: 0, count: 3, buyCount: 3, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
      hasRef: true, completeness: 'complete', sources: ['history'], updatedAt: T02D_TARGET + 70_000,
    },
  ];

  await withT02DCaseOwnersV2(ledger, 2, T02D_NOW, async ([a, b]) => {
    await t02dPrimeOwnerV2(ledger, a);
    await t02dPrimeOwnerV2(ledger, b);

    function capture(fixture, serverSteps) {
      return {
        startBar: t02dSnapshotAt(fixture, START),
        targetBar: t02dSnapshotAt(fixture, T02D_TARGET),
        length: fixture.pipeline.series.length,
        revision: fixture.pipeline.series.revision,
        structureRevision: fixture.pipeline.series.structureRevision,
        configPriceStep: fixture.pipeline.series.config.priceStep,
        updates: fixture.updateCount,
        reports: fixture.reporters.map(({ state, detail }) => ({ state, detail })),
        subscriptions: t02dSubscriptionCounts(fixture),
        sessionCb: fixture.sessionCb,
        onUpdate: fixture.pipeline.onUpdate,
        requests: fixture.requests.length,
        serverSteps: [...serverSteps],
      };
    }
    function assertSame(fixture, serverSteps, baseline, label) {
      assert.deepEqual(capture(fixture, serverSteps), baseline, label);
    }
    function assertRequestedBuckets(query, bars) {
      for (let start = Math.floor(query.from / INTERVAL) * INTERVAL; start <= query.to; start += INTERVAL) {
        assert.ok(bars.some((bar) => bar.startTime === start), `missing requested repair bucket ${start}`);
      }
    }

    const baselineB = capture(b, serverStepsB);
    assert.equal(baselineB.startBar?.volume, 1, 'B must have a populated baseline');
    assert.equal(baselineB.targetBar, null);
    assert.equal(baselineB.reports.at(-1)?.state, 'healthy');
    assert.deepEqual(baselineB.serverSteps, []);
    assert.ok(baselineB.subscriptions.some(([market, size]) => market === 'M' && size > 0));

    assert.equal(typeof a.sessionCb, 'function');
    a.sessionCb({ generation: 2, epoch: 1, session: 's2', boundaryAt: T02D_TARGET + 60_000 });
    await settle();
    ledger.assertBounds();
    assert.equal(a.requests.length, 2, 'generation 2 repair must be captured');
    const superseded = a.requests[1];
    assert.equal(superseded.settled, false, 'generation 2 repair remains deferred');
    assertSame(b, serverStepsB, baselineB, 'A generation 2 must not affect B');

    a.sessionCb({ generation: 3, epoch: 1, session: 's3', boundaryAt: T02D_TARGET + 60_000 });
    await settle();
    ledger.assertBounds();
    assert.equal(a.requests.length, 3, 'generation 3 must start a distinct repair');
    const current = a.requests[2];
    assert.notStrictEqual(superseded, current);
    assert.notStrictEqual(superseded.query, current.query);
    assert.notStrictEqual(superseded.query.signal, current.query.signal);
    assert.equal(superseded.query.signal.aborted, true, 'superseded request signal must be aborted');
    assert.equal(current.query.signal.aborted, false, 'current request signal must remain active');
    assert.equal(current.settled, false);
    assertSame(b, serverStepsB, baselineB, 'A generation 3 must not affect B');

    const baselineA = capture(a, serverStepsA);
    assert.equal(baselineA.startBar?.volume, 1, 'A must retain its populated baseline');
    assert.equal(baselineA.targetBar, null);
    assert.equal(baselineA.configPriceStep, 1);
    assert.deepEqual(baselineA.serverSteps, []);

    const oldQuery = superseded.query;
    assertRequestedBuckets(oldQuery, sourceBars);
    oldQuery.onMeta?.({ footprint: { priceStep: 2 } });
    assertSame(b, serverStepsB, baselineB, 'superseded metadata must not affect B');
    a.resolveBars(1, sourceBars);
    assertSame(b, serverStepsB, baselineB, 'superseded nonempty bars must not affect B');
    await settle();
    ledger.assertBounds();
    assertSame(b, serverStepsB, baselineB, 'settling superseded bars must not affect B');
    a.flush();
    ledger.assertBounds();
    assertSame(b, serverStepsB, baselineB, 'flushing A after superseded bars must not affect B');
    assert.deepEqual(serverStepsA, baselineA.serverSteps, 'superseded metadata must contribute zero server-step callbacks');
    assert.deepEqual(capture(a, serverStepsA), baselineA, 'superseded metadata and nonempty bars must be no-ops for A');

    const currentQuery = current.query;
    assert.equal(currentQuery.priceStep, 1);
    assertRequestedBuckets(currentQuery, sourceBars);
    const beforePositiveMeta = capture(a, serverStepsA);
    currentQuery.onMeta?.({ footprint: { priceStep: 3 } });
    assert.deepEqual(serverStepsA, [...beforePositiveMeta.serverSteps, 3], 'active partial metadata must reach the public observer');
    const afterPositiveMeta = capture(a, serverStepsA);
    assert.deepEqual({ ...afterPositiveMeta, serverSteps: beforePositiveMeta.serverSteps }, beforePositiveMeta,
      'positive metadata control must not mutate financial, config, revision, update, or report state');
    assertSame(b, serverStepsB, baselineB, 'active A metadata must not affect B');

    a.applyMeta(2, {
      watermark: '201', coveredFrom: currentQuery.from, coveredThrough: currentQuery.to, complete: true,
    });
    ledger.assertBounds();
    assert.deepEqual(serverStepsA, [3], 'full repair proof must not fabricate another step notification');
    assertSame(b, serverStepsB, baselineB, 'current A proof must not affect B');

    ledger.emitNew(a, 'M', () => t02dTrade('201', T02D_TARGET + 70_000, 10_002, 2, true, 3));
    ledger.assertBounds();
    assertSame(b, serverStepsB, baselineB, 'A live witness must not affect B');
    a.resolveBars(2, sourceBars);
    assertSame(b, serverStepsB, baselineB, 'current A response must not affect B before settlement');
    await settle();
    ledger.assertBounds();
    assertSame(b, serverStepsB, baselineB, 'settling current A response must not affect B');
    a.flush();
    ledger.assertBounds();
    assertSame(b, serverStepsB, baselineB, 'flushing current A response must not affect B');

    assertT02DBar(a, expectedStart, START);
    assertT02DBar(a, expectedTarget, T02D_TARGET);
    assert.equal(a.pipeline.series.config.priceStep, 1);
    assert.ok(a.pipeline.series.revision > baselineA.revision, 'valid current repair must advance the series');
    assert.ok(a.updateCount > baselineA.updates, 'valid current repair must reach the active owner update');
    assert.equal(a.reporters.at(-1)?.state, 'healthy', 'valid current repair must end healthy');
    const finalA = capture(a, serverStepsA);

    ledger.emitNew(b, 'M', () => t02dTrade('301', T02D_TARGET + 75_000, 9_999, 3, false, 1));
    b.flush();
    ledger.assertBounds();
    assertT02DBar(b, expectedB, T02D_TARGET);
    assert.ok(b.pipeline.series.revision > baselineB.revision, 'B must advance through its independent valid control');
    assert.ok(b.updateCount > baselineB.updates, 'B control must reach its owner update');
    assert.equal(b.requests.length, baselineB.requests);
    assert.deepEqual(b.reporters.map(({ state, detail }) => ({ state, detail })), baselineB.reports);
    assert.deepEqual(t02dSubscriptionCounts(b), baselineB.subscriptions);
    assert.equal(b.sessionCb, baselineB.sessionCb);
    assert.deepEqual(serverStepsB, baselineB.serverSteps);
    assertSame(a, serverStepsA, finalA, 'B independent control must leave repaired A unchanged');
  }, [
    { onServerPriceStep: (step) => serverStepsA.push(step) },
    { onServerPriceStep: (step) => serverStepsB.push(step) },
  ]);
  ledger.assertBounds();
});

test('disposed repair metadata cannot emit public callbacks', { timeout: 10_000 }, async (t) => {
  useFakeChartDataSource(t);
  const ledger = t02dCreateCaseLedger();
  const serverStepsA = [];
  const serverStepsB = [];
  const expectedB = {
    open: 9_999, high: 9_999, low: 9_999, close: 9_999,
    volume: 3, delta: -3, count: 1, cells: [[9_999, 0, 3, 1, 0, 1]],
  };
  const sourceBars = [
    {
      startTime: START,
      open: 10_001, high: 10_001, low: 10_001, close: 10_001,
      volume: 1, delta: 1, count: 1,
      liquidationBuyVol: 0, liquidationSellVol: 0,
      cells: new Map([[10_001, { priceBin: 10_001, buyVol: 1, sellVol: 0, count: 1, buyCount: 1, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
      hasRef: true, completeness: 'complete', sources: ['history'], updatedAt: START + 70_000,
    },
    {
      startTime: T02D_TARGET,
      open: 10_002, high: 10_002, low: 10_002, close: 10_002,
      volume: 2, delta: 2, count: 3,
      liquidationBuyVol: 0, liquidationSellVol: 0,
      cells: new Map([[10_002, { priceBin: 10_002, buyVol: 2, sellVol: 0, count: 3, buyCount: 3, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
      hasRef: true, completeness: 'complete', sources: ['history'], updatedAt: T02D_TARGET + 70_000,
    },
  ];

  await withT02DCaseOwnersV2(ledger, 2, T02D_NOW, async ([a, b]) => {
    await t02dPrimeOwnerV2(ledger, a);
    await t02dPrimeOwnerV2(ledger, b);

    function capture(fixture, serverSteps) {
      return {
        startBar: t02dSnapshotAt(fixture, START),
        targetBar: t02dSnapshotAt(fixture, T02D_TARGET),
        length: fixture.pipeline.series.length,
        revision: fixture.pipeline.series.revision,
        structureRevision: fixture.pipeline.series.structureRevision,
        configPriceStep: fixture.pipeline.series.config.priceStep,
        updates: fixture.updateCount,
        reports: fixture.reporters.map(({ state, detail }) => ({ state, detail })),
        subscriptions: t02dSubscriptionCounts(fixture),
        sessionCb: fixture.sessionCb,
        onUpdate: fixture.pipeline.onUpdate,
        requests: fixture.requests.length,
        serverSteps: [...serverSteps],
      };
    }
    function assertSame(fixture, serverSteps, baseline, label) {
      assert.deepEqual(capture(fixture, serverSteps), baseline, label);
    }
    function assertFinancialSame(fixture, serverSteps, baseline, label) {
      const actual = capture(fixture, serverSteps);
      for (const key of ['startBar', 'targetBar', 'length', 'structureRevision', 'configPriceStep', 'updates', 'reports', 'serverSteps']) {
        assert.deepEqual(actual[key], baseline[key], `${label}: ${key}`);
      }
    }
    function assertRequestedBuckets(query, bars) {
      for (let start = Math.floor(query.from / INTERVAL) * INTERVAL; start <= query.to; start += INTERVAL) {
        assert.ok(bars.some((bar) => bar.startTime === start), `missing requested repair bucket ${start}`);
      }
    }

    const baselineB = capture(b, serverStepsB);
    assert.equal(baselineB.startBar?.volume, 1, 'B must have a populated baseline');
    assert.equal(baselineB.targetBar, null);
    assert.equal(baselineB.reports.at(-1)?.state, 'healthy');
    assert.deepEqual(baselineB.serverSteps, []);
    assert.ok(baselineB.subscriptions.some(([market, size]) => market === 'M' && size > 0));

    assert.equal(typeof a.sessionCb, 'function');
    a.sessionCb({ generation: 2, epoch: 1, session: 's2', boundaryAt: T02D_TARGET + 60_000 });
    await settle();
    ledger.assertBounds();
    assert.equal(a.requests.length, 2, 'deferred repair request must be captured');
    const request = a.requests[1];
    assert.equal(request.settled, false, 'repair request must remain deferred');
    const oldQuery = request.query;
    assert.equal(oldQuery.signal.aborted, false);
    assertRequestedBuckets(oldQuery, sourceBars);
    assertSame(b, serverStepsB, baselineB, 'A deferred repair must not affect B');

    const beforeDisposeA = capture(a, serverStepsA);
    assert.equal(beforeDisposeA.startBar?.volume, 1, 'A must have a populated baseline');
    assert.ok(beforeDisposeA.subscriptions.some(([market, size]) => market === 'M' && size > 0));
    a.pipeline.dispose();
    ledger.assertBounds();
    assert.equal(oldQuery.signal.aborted, true, 'public dispose must abort the captured query');
    assert.ok(t02dSubscriptionCounts(a).every(([, size]) => size === 0), 'public dispose must remove A trade subscriptions');
    assert.equal(a.sessionCb, undefined, 'public dispose must remove A session subscription');
    assert.equal(a.pipeline.onUpdate, null, 'public dispose must clear the public update callback');
    const disposedBaseline = capture(a, serverStepsA);
    assert.equal(disposedBaseline.revision, beforeDisposeA.revision + 1,
      'dispose must advance revision once while releasing active repair barriers');
    assertFinancialSame(a, serverStepsA, beforeDisposeA, 'dispose must preserve A financial/config/update/report state');
    assertSame(b, serverStepsB, baselineB, 'disposing A must not affect B');
    assert.equal(disposedBaseline.onUpdate, null);
    assert.equal(disposedBaseline.targetBar, null);
    oldQuery.onMeta?.({ footprint: { priceStep: 2 } });
    assertSame(b, serverStepsB, baselineB, 'disposed A metadata must not affect B');
    a.resolveBars(1, sourceBars);
    assertSame(b, serverStepsB, baselineB, 'disposed A nonempty bars must not affect B');
    await settle();
    ledger.assertBounds();
    assertSame(b, serverStepsB, baselineB, 'settling disposed A bars must not affect B');
    a.flush();
    ledger.assertBounds();
    assertSame(b, serverStepsB, baselineB, 'flushing disposed A must not affect B');
    assert.deepEqual(serverStepsA, disposedBaseline.serverSteps, 'disposed metadata must contribute zero server-step callbacks');
    assert.deepEqual(capture(a, serverStepsA), disposedBaseline, 'disposed metadata and nonempty bars must leave A unchanged');

    ledger.emitNew(b, 'M', () => t02dTrade('302', T02D_TARGET + 75_000, 9_999, 3, false, 1));
    b.flush();
    ledger.assertBounds();
    assertT02DBar(b, expectedB, T02D_TARGET);
    assert.ok(b.pipeline.series.revision > baselineB.revision, 'B must advance through its independent valid control');
    assert.ok(b.updateCount > baselineB.updates, 'B control must reach its owner update');
    assert.equal(b.requests.length, baselineB.requests);
    assert.deepEqual(b.reporters.map(({ state, detail }) => ({ state, detail })), baselineB.reports);
    assert.deepEqual(t02dSubscriptionCounts(b), baselineB.subscriptions);
    assert.equal(b.sessionCb, baselineB.sessionCb);
    assert.deepEqual(serverStepsB, baselineB.serverSteps);
    assertSame(a, serverStepsA, disposedBaseline, 'B independent control must leave disposed A unchanged');
  }, [
    { onServerPriceStep: (step) => serverStepsA.push(step) },
    { onServerPriceStep: (step) => serverStepsB.push(step) },
  ]);
  ledger.assertBounds();
});

const O1_LIMITS = Object.freeze({ trades: 10006, deliveries: 10010, callbacks: 10020, records: 10064, requests: 2, events: 10001, scenarios: 3, ownerInstances: 6, reporterInstances: 6, owners: 2, handles: 3, activeReporters: 2 });

function o1Aggregate() {
  const totals = { trades: 0, deliveries: 0, callbacks: 0, records: 0, requests: 0, events: 0 };
  let scenarios = 0, ownerInstances = 0, reporterInstances = 0;
  return {
    totals,
    get scenarios() { return scenarios; },
    get ownerInstances() { return ownerInstances; },
    get reporterInstances() { return reporterInstances; },
    enter() { if (scenarios >= O1_LIMITS.scenarios) throw new RangeError('scenario limit'); scenarios++; },
    add(field) {
      if (!Object.hasOwn(totals, field) || totals[field] >= O1_LIMITS[field] * O1_LIMITS.scenarios) throw new RangeError('aggregate limit');
      totals[field]++;
    },
    owner() { if (ownerInstances >= O1_LIMITS.ownerInstances) throw new RangeError('owner instance limit'); ownerInstances++; },
    reporter() { if (reporterInstances >= O1_LIMITS.reporterInstances) throw new RangeError('reporter instance limit'); reporterInstances++; },
    check() {
      if (scenarios > O1_LIMITS.scenarios || ownerInstances > O1_LIMITS.ownerInstances || reporterInstances > O1_LIMITS.reporterInstances) throw new RangeError('aggregate limit');
      for (const field of Object.keys(totals)) if (totals[field] > O1_LIMITS[field] * O1_LIMITS.scenarios) throw new RangeError('aggregate limit');
    }
  };
}

function o1Ledger(aggregate) {
  aggregate.enter();
  const counts = { trades: 0, deliveries: 0, callbacks: 0, records: 0, requests: 0, events: 0 };
  const owners = new Set(), handles = new Set(), activeReporters = new Set(), registry = [];
  function bump(field) {
    if (!Object.hasOwn(counts, field) || counts[field] >= O1_LIMITS[field] || aggregate.totals[field] >= O1_LIMITS[field] * O1_LIMITS.scenarios) throw new RangeError('case limit');
    counts[field]++;
    aggregate.add(field);
  }
  return {
    aggregate, counts, owners, handles, activeReporters, registry,
    bump,
    trade(factory) { bump('trades'); return factory(); },
    record() { bump('records'); },
    event() { bump('events'); },
    check() {
      aggregate.check();
      for (const field of Object.keys(counts)) if (counts[field] > O1_LIMITS[field]) throw new RangeError('case limit');
      if (owners.size > O1_LIMITS.owners || handles.size > O1_LIMITS.handles || activeReporters.size > O1_LIMITS.activeReporters) throw new RangeError('active instance limit');
      let outstanding = 0;
      for (const holder of registry) for (const request of holder.requests) if (request.settled === false) outstanding++;
      if (outstanding > O1_LIMITS.requests) throw new RangeError('outstanding request limit');
    }
  };
}

function o1Fixture(ledger) {
  if (ledger.owners.size >= 2) throw new RangeError('owner limit');
  ledger.aggregate.owner();
  const h = {
    pipeline: undefined, requests: [], subscribers: new Map(), sessionCb: undefined,
    pendingCallbacks: new Map(), disposers: [], reporters: [], steps: [], degraded: [],
    updates: 0, updateEvents: [], hooks: [], ownerDisposed: false,
    onPublicUpdate: undefined, onReport: undefined
  };
  ledger.registry.push(h);
  ledger.owners.add(h);
  let nextHandle = 0, nextSubscriber = 0;
  const scheduler = {
    request(callback) {
      if (ledger.handles.size >= 3) throw new RangeError('handle limit');
      const id = ++nextHandle, token = Symbol('scheduler-handle');
      ledger.handles.add(token);
      h.pendingCallbacks.set(id, { token, callback });
      return id;
    },
    cancel(id) {
      const entry = h.pendingCallbacks.get(id);
      if (!entry) return;
      h.pendingCallbacks.delete(id);
      ledger.handles.delete(entry.token);
    }
  };
  h.scheduler = scheduler;
  h.flush = () => {
    while (h.pendingCallbacks.size) {
      const [id, entry] = h.pendingCallbacks.entries().next().value;
      ledger.bump('callbacks');
      h.pendingCallbacks.delete(id);
      ledger.handles.delete(entry.token);
      entry.callback();
    }
    ledger.check();
  };
  const services = {
    subscribeToTrades(market, callback) {
      let listeners = h.subscribers.get(market);
      if (!listeners) h.subscribers.set(market, listeners = new Map());
      const id = ++nextSubscriber;
      listeners.set(id, callback);
      let active = true;
      const restore = () => {
        if (!active) return;
        active = false;
        listeners.delete(id);
        if (!listeners.size) h.subscribers.delete(market);
      };
      h.disposers.push(restore);
      return restore;
    },
    subscribeToTradeSessions(callback) {
      h.sessionCb = callback;
      let active = true;
      const restore = () => {
        if (!active) return;
        active = false;
        if (h.sessionCb === callback) h.sessionCb = undefined;
      };
      h.disposers.push(restore);
      return restore;
    },
    fetchHistory(q) {
      ledger.bump('requests');
      if (ledger.registry.reduce((n, holder) => n + holder.requests.filter(r => r.settled === false).length, 0) >= 2) {
        throw new RangeError('request limit');
      }
      const entry = { q, d: undefined, settled: false };
      h.requests.push(entry);
      try {
        entry.d = deferred();
      } catch (error) {
        entry.settled = true;
        throw error;
      }
      return entry.d.promise;
    },
    async fetchPriceStep() { return 1; },
    async fetchPricePrecision() { return undefined; },
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      if (ledger.activeReporters.size >= 2) throw new RangeError('active reporter limit');
      ledger.aggregate.reporter();
      const token = Symbol('reporter');
      ledger.activeReporters.add(token);
      let active = true;
      const reporter = {
        report(state, detail) {
          ledger.bump('records');
          h.reporters.push([state, detail]);
          if (h.onReport) h.onReport(state, detail);
        },
        dispose() {
          if (!active) return;
          active = false;
          ledger.activeReporters.delete(token);
        }
      };
      h.disposers.push(reporter.dispose);
      return reporter;
    }
  };
  h.services = services;
  h.emit = (market, event) => {
    const listeners = h.subscribers.get(market);
    if (!listeners || !listeners.size) throw new Error('no active subscribers');
    for (const callback of listeners.values()) {
      ledger.bump('deliveries');
      callback(event);
    }
    ledger.check();
  };
  h.resolveBars = (index, bars) => {
    const entry = h.requests[index];
    if (!entry || entry.settled || !entry.d) throw new Error('request is not pending');
    const cloned = bars.map(cloneBar);
    entry.settled = true;
    entry.d.resolve(cloned);
    ledger.check();
  };
  h.dispose = () => {
    h.pipeline.dispose();
    h.ownerDisposed = true;
  };
  h.pipeline = new ChartDataPipeline({
    market: 'M', intervalMs: INTERVAL, priceStep: 1, services, scheduler,
    onServerPriceStep(step) {
      ledger.bump('records');
      h.steps.push(step);
    },
    onDataDegraded(value, detail) {
      ledger.bump('records');
      h.degraded.push([value, detail]);
    }
  });
  h.pipeline.onUpdate = event => {
    ledger.bump('records');
    h.updateEvents.push([event.kind, event.source]);
    h.updates++;
    if (h.onPublicUpdate) h.onPublicUpdate(event);
  };
  ledger.check();
  return h;
}

async function o1WithOwners(ledger, action) {
  const originalNow = Date.now;
  const cleanupErrors = [];
  const primary = { failed: false, value: undefined };
  let result;
  const attempt = fn => { try { return fn(); } catch (error) { cleanupErrors.push(error); } };
  try {
    Date.now = () => T02D_NOW;
    const a = o1Fixture(ledger);
    const b = o1Fixture(ledger);
    result = await action(a, b);
  } catch (error) {
    primary.failed = true;
    primary.value = error;
  } finally {
    try {
      const holders = [...ledger.registry];
      for (const h of holders) {
        for (const request of h.requests) {
          if (request.settled !== false) continue;
          attempt(() => {
            if (!request.d || typeof request.d.resolve !== 'function') throw new Error('unsettled request has no resolver');
            request.d.resolve([]);
            request.settled = true;
          });
        }
      }
      for (const h of holders) {
        let disposed = false;
        if (h.pipeline) {
          attempt(() => {
            h.pipeline.dispose();
            h.ownerDisposed = true;
            disposed = true;
          });
        } else {
          h.ownerDisposed = true;
          disposed = true;
        }
        if (disposed) attempt(() => ledger.owners.delete(h));
        for (const restore of [...h.disposers]) attempt(restore);
        for (const id of [...h.pendingCallbacks.keys()]) attempt(() => h.scheduler.cancel(id));
      }
      for (let round = 0; round < 6; round++) {
        try { await settle(); } catch (error) { cleanupErrors.push(error); }
      }
      const check = (condition, message) => { if (!condition) cleanupErrors.push(new Error(message)); };
      for (const h of holders) {
        check(h.pendingCallbacks.size === 0, 'pending callbacks remain');
        check(h.subscribers.size === 0, 'subscribers remain');
        check(h.sessionCb === undefined, 'session callback remains');
        check(h.requests.every(request => request.settled === true), 'unsettled request remains');
      }
      check(ledger.activeReporters.size === 0, 'active reporters remain');
      check(ledger.handles.size === 0, 'scheduler handles remain');
      check(ledger.owners.size === 0, 'active owners remain');
      attempt(() => ledger.check());
    } finally {
      attempt(() => { Date.now = originalNow; });
    }
  }
  if (primary.failed) throw primary.value;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'owner cleanup failed');
  return result;
}

function o1Healthy(h) { return h.reporters.filter(([state]) => state === 'healthy').length; }
function o1Signature(h) {
  const copy = value => JSON.parse(JSON.stringify(value));
  return { bar: t02dSnapshotAt(h, T02D_TARGET), revision: h.pipeline.series.revision, structureRevision: h.pipeline.series.structureRevision, updates: h.updates, updateEvents: copy(h.updateEvents), hooks: copy(h.hooks), reporters: copy(h.reporters), steps: copy(h.steps), degraded: copy(h.degraded), requests: h.requests.length, subscriptions: t02dSubscriptionCounts(h), sessionCb: h.sessionCb, reconciled: h.pipeline.liveBootstrapReconciled, repairOwned: h.pipeline.series.isRepairOwned(T02D_TARGET) };
}
function o1OldMeta(q) { return { ...repairMeta(q, { watermark: '100', complete: true }), footprint: { priceStep: 3 } }; }
function o1StaleBar() {
  return { startTime: T02D_TARGET, open: 777, high: 777, low: 777, close: 777, volume: 9, delta: 9, count: 1,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([[777, { priceBin: 777, buyVol: 9, sellVol: 0, count: 1, buyCount: 1, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
    hasRef: true, completeness: 'complete', sources: ['history'], updatedAt: T02D_TARGET + 80000 };
}
async function o1Scenario(mode, ledger) {
  await o1WithOwners(ledger, async (a, b) => {
    assert.equal(a.pipeline.series.revision, 0); assert.equal(a.pipeline.series.structureRevision, 0);
    assert.equal(a.pipeline.series.get(START), undefined); assert.equal(a.pipeline.series.get(T02D_TARGET), undefined);
    const baseHealthy = o1Healthy(a); assert.ok(baseHealthy >= 1);
    const buy = (id, time, price, qty) => ledger.trade(() => Object.freeze({ id: String(id), time, price, qty, tradeCount: 1, isBuy: true, liquidation: false, market: 'M', source: 'live', receivedAt: time + 1 }));
    const sell = (id, time, price, qty) => ledger.trade(() => Object.freeze({ id: String(id), time, price, qty, tradeCount: 1, isBuy: false, liquidation: false, market: 'M', source: 'live', receivedAt: time + 1 }));
    b.emit('M', buy('b-1', T02D_TARGET + 70000, 10000, 2)); b.flush();
    b.emit('M', sell('b-2', T02D_TARGET + 71000, 10001, 3)); b.flush();
    const bExpected = { open: 10000, high: 10001, low: 10000, close: 10001, volume: 5, delta: -1, count: 2,
      cells: [[10000, 2, 0, 1, 1, 0], [10001, 0, 3, 1, 0, 1]], fullCells: [[10000, 2, 0, 1, 1, 0, 0, 0], [10001, 0, 3, 1, 0, 1, 0, 0]] };
    assertT02DBar(b, bExpected); assert.equal(b.pipeline.series.get(T02D_TARGET).updatedAt, T02D_TARGET + 71001);
    const bBaseline = { startBar: t02dSnapshotAt(b, START), revision: b.pipeline.series.revision, structureRevision: b.pipeline.series.structureRevision,
      updates: () => b.updates, updateCount: b.updates, requests: b.requests.length, reports: b.reporters.length,
      subscriptions: t02dSubscriptionCounts(b), sessionCb: b.sessionCb };
    const bFrozen = o1Signature(b);
    const assertB = () => { assert.deepEqual(o1Signature(b), bFrozen); assert.deepEqual(t02dSnapshotAt(b, START), bBaseline.startBar); };
    let pendingSeen = false, acceptedA, acceptedB, lastA, oldResolvedInHook = false, historyCommitStageSeen = false;
    a.onReport = (state, detail) => { const text = String(JSON.stringify([state, detail])).toLowerCase(); if (text.includes('pending') || text.includes('resynchronizing')) pendingSeen = true; if (state === 'healthy') assert.ok(historyCommitStageSeen || o1Healthy(a) <= baseHealthy, 'healthy report before history-patched commit stage'); assertB(); };
    a.pipeline.onBeforeUpdate = kind => {
      ledger.record(); a.hooks.push(kind); assertB();
      if (kind !== 'history-patched') return;
      assert.equal(o1Healthy(a), baseHealthy);
      historyCommitStageSeen = true;
      if (mode === 'OLD_RESOLVED_ON_BEFORE_UPDATE' && !oldResolvedInHook) {
        const old = a.requests[0].q, before = o1Signature(a);
        old.onMeta(o1OldMeta(old)); assert.deepEqual(o1Signature(a), before); assertB();
        a.emit('M', lastA); assertB(); assert.equal(o1Healthy(a), baseHealthy);
        a.flush(); assertB(); assert.equal(o1Healthy(a), baseHealthy);
        a.resolveBars(0, [o1StaleBar()]); assertB(); oldResolvedInHook = true;
      }
    };
    a.onPublicUpdate = event => {
      assertB();
      if (event.kind !== 'history-patched' || event.source !== 'history') return;
      assert.equal(historyCommitStageSeen, true); assert.equal(acceptedA, undefined); assert.equal(o1Healthy(a), baseHealthy + 1);
      acceptedA = o1Signature(a); acceptedB = o1Signature(b);
    };
    assert.equal(typeof a.sessionCb, 'function');
    a.sessionCb({ generation: 1, epoch: 1, session: 's1', boundaryAt: T02D_TARGET + 60000 });
    assertB(); for (let i = 0; i < 6; i++) await settle(); assertB();
    assert.equal(pendingSeen, true); assert.equal(a.requests.length, 1);
    const firstQ = a.requests[0].q;
    assert.ok(Number.isFinite(firstQ.from)); assert.ok(Number.isFinite(firstQ.to));
    assert.equal(firstQ.from, T02D_TARGET); assert.equal(firstQ.to, T02D_TARGET + INTERVAL - 1);
    assert.equal(firstQ.reference, 'M'); assert.equal(firstQ.interval, INTERVAL); assert.equal(firstQ.priceStep, 1);
    const oldSignal = firstQ.signal; assert.equal(oldSignal.aborted, false);
    const sendA = id => {
      const time = T02D_TARGET + 70000 + id;
      lastA = id % 2 ? buy(id, time, 10000, 1) : sell(id, time, 10001, 1);
      ledger.event(); a.emit('M', lastA); assertB(); assert.equal(o1Healthy(a), baseHealthy);
      a.flush(); assertB(); assert.equal(o1Healthy(a), baseHealthy);
    };
    for (let id = 1; id <= 10000; id++) sendA(id);
    assert.equal(a.requests.length, 1); assert.equal(oldSignal.aborted, false);
    sendA(10001);
    for (let i = 0; i < 6; i++) await settle(); assertB();
    assert.equal(a.requests.length, 2); assert.equal(oldSignal.aborted, true); assert.equal(a.requests[1].q.signal.aborted, false);
    assert.ok(a.reporters.some(([state, detail]) => { const s = String(JSON.stringify([state, detail])).toLowerCase(); return s.includes('resynchronizing') && s.includes('1/4'); }));
    assert.equal(o1Healthy(a), baseHealthy);
    const currentQ = a.requests[1].q, oldQ = a.requests[0].q, beforeOld = o1Signature(a), stale = o1StaleBar();
    assert.equal(currentQ.from, T02D_TARGET); assert.equal(currentQ.to, T02D_TARGET + INTERVAL - 1);
    assert.equal(currentQ.reference, 'M'); assert.equal(currentQ.interval, INTERVAL); assert.equal(currentQ.priceStep, 1);
    assert.equal(typeof oldQ.onMeta, 'function'); assert.equal(typeof currentQ.onMeta, 'function');
    if (mode === 'OLD_BEFORE_CURRENT_PROOF') {
      oldQ.onMeta(o1OldMeta(oldQ)); assert.deepEqual(o1Signature(a), beforeOld); assertB();
      a.resolveBars(0, [stale]); assertB();
      for (let i = 0; i < 6; i++) await settle(); a.flush(); assertB();
      assert.deepEqual(o1Signature(a), beforeOld); assert.equal(o1Healthy(a), baseHealthy);
    }
    const meta = repairMeta(currentQ, { watermark: '10001', coveredFrom: currentQ.from, coveredThrough: currentQ.to, complete: true });
    meta.footprint = { priceStep: 2 }; currentQ.onMeta(meta); assertB();
    assert.equal(meta.repairSnapshot.priceStep, 1); assert.equal(meta.repairSnapshot.watermark, '10001');
    assert.equal(a.steps.at(-1), 2); assert.equal(o1Healthy(a), baseHealthy); assert.equal(a.requests.length, 2);
    if (mode === 'OLD_BEFORE_CURRENT_PROOF' || mode === 'OLD_AFTER_CURRENT_PROOF') {
      const beforeDuplicate = o1Signature(a);
      a.emit('M', lastA); assert.deepEqual(o1Signature(a), beforeDuplicate); assertB(); assert.equal(o1Healthy(a), baseHealthy); assert.equal(a.requests.length, 2);
      a.flush(); assert.deepEqual(o1Signature(a), beforeDuplicate); assertB(); assert.equal(o1Healthy(a), baseHealthy); assert.equal(a.requests.length, 2);
    }
    const currentBar = { startTime: T02D_TARGET, open: 10000, high: 10001, low: 10000, close: 10000, volume: 10001, delta: 1, count: 10001,
      liquidationBuyVol: 0, liquidationSellVol: 0,
      cells: new Map([[10000, { priceBin: 10000, buyVol: 5001, sellVol: 0, count: 5001, buyCount: 5001, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }],
        [10001, { priceBin: 10001, buyVol: 0, sellVol: 5000, count: 5000, buyCount: 0, sellCount: 5000, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
      hasRef: true, completeness: 'complete', sources: ['history'], updatedAt: T02D_TARGET + 80001 };
    a.resolveBars(1, [currentBar]); assertB();
    for (let i = 0; i < 6; i++) await settle(); a.flush(); assertB();
    assert.equal(acceptedA !== undefined, true); assert.deepEqual(acceptedB, bFrozen);
    const expectedA = { open: 10000, high: 10001, low: 10000, close: 10000, volume: 10001, delta: 1, count: 10001,
      cells: [[10000, 5001, 0, 5001, 5001, 0], [10001, 0, 5000, 5000, 0, 5000]],
      fullCells: [[10000, 5001, 0, 5001, 5001, 0, 0, 0], [10001, 0, 5000, 5000, 0, 5000, 0, 0]] };
    assertT02DBar(a, expectedA); assert.equal(a.pipeline.series.get(T02D_TARGET).updatedAt, T02D_TARGET + 80001);
    assert.equal(a.pipeline.series.isRepairOwned(T02D_TARGET), true); assert.equal(a.pipeline.liveBootstrapReconciled, true);
    assert.equal(a.hooks.filter(kind => kind === 'history-patched').length, 1);
    assert.equal(a.updateEvents.filter(([kind, source]) => kind === 'history-patched' && source === 'history').length, 1);
    assert.equal(o1Healthy(a), baseHealthy + 1); assert.equal(a.requests.length, 2);
    if (mode === 'OLD_AFTER_CURRENT_PROOF') {
      const before = o1Signature(a); oldQ.onMeta(o1OldMeta(oldQ)); assert.deepEqual(o1Signature(a), before); assertB();
      a.resolveBars(0, [stale]); assertB();
    }
    if (mode === 'OLD_RESOLVED_ON_BEFORE_UPDATE') assert.equal(oldResolvedInHook, true);
    for (let i = 0; i < 6; i++) await settle(); a.flush(); assertB();
    assert.deepEqual(o1Signature(a), acceptedA); assert.equal(o1Healthy(a), baseHealthy + 1);
    assert.equal(a.requests[0].settled, true); assert.equal(a.requests[1].settled, true);
    assert.equal(oldSignal.aborted, true); assert.equal(a.requests[1].q.signal.aborted, false);
    const finalBuy = buy('b-3', T02D_TARGET + 72000, 10000, 1);
    b.emit('M', finalBuy); b.flush(); assert.deepEqual(o1Signature(a), acceptedA);
    const finalB = { open: 10000, high: 10001, low: 10000, close: 10000, volume: 6, delta: 0, count: 3,
      cells: [[10000, 3, 0, 2, 2, 0], [10001, 0, 3, 1, 0, 1]], fullCells: [[10000, 3, 0, 2, 2, 0, 0, 0], [10001, 0, 3, 1, 0, 1, 0, 0]] };
    assertT02DBar(b, finalB); assert.equal(b.pipeline.series.get(T02D_TARGET).updatedAt, T02D_TARGET + 72001);
    assert.equal(a.requests.length, 2); ledger.check();
  });
}
test('real overflow, stale repair ordering, and owner isolation', { timeout: 30000, concurrency: false }, async t => {
  useFakeChartDataSource(t);
  const aggregate = o1Aggregate();
  for (const mode of ['OLD_BEFORE_CURRENT_PROOF', 'OLD_AFTER_CURRENT_PROOF', 'OLD_RESOLVED_ON_BEFORE_UPDATE']) {
    await t.test(mode, async () => {
      const ledger = o1Ledger(aggregate); await o1Scenario(mode, ledger);
      assert.equal(ledger.counts.events, 10001); assert.equal(ledger.counts.trades, 10004);
      assert.equal(ledger.counts.deliveries, 10005);
      assert.equal(ledger.owners.size, 0); assert.equal(ledger.handles.size, 0); assert.equal(ledger.activeReporters.size, 0);
      assert.equal(ledger.registry.flatMap(h => h.requests).filter(r => r.settled === false).length, 0);
      assert.ok(ledger.registry.every(h => h.pendingCallbacks.size === 0)); ledger.check();
    });
  }
  assert.equal(aggregate.scenarios, 3); assert.equal(aggregate.ownerInstances, 6); assert.equal(aggregate.reporterInstances, 6);
  assert.equal(aggregate.totals.events, 30003); aggregate.check();
});
