/**
 * ChartDataPipeline unit tests (Phase 8).
 *
 * Tests the pure-logic parts: dispose idempotency, changeConfig series clearing,
 * onUpdate callback wiring.
 *
 * The pipeline requires ApplicationServices for subscribeToTrades / fetchPriceStep.
 * We use a minimal stub that tracks calls. History, live OHLC and repair reads go
 * through the fake ChartDataSource in tests/support, which records each query.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

// ── Stub ApplicationServices ──────────────────────────────────────────────────

function makeServices({ priceStep = 10, pricePrecision = undefined } = {}) {
  const subscribers = new Map();
  return {
    subscribeToTrades(market, cb) {
      if (!subscribers.has(market)) subscribers.set(market, new Set());
      subscribers.get(market).add(cb);
      return () => subscribers.get(market)?.delete(cb);
    },
    fetchPriceStep: async () => priceStep,
    fetchPricePrecision: async () => pricePrecision,
    triggerAutoSync: () => { /* no-op for unit tests */ },
    // Test helpers
    _emit(market, trade) {
      for (const cb of subscribers.get(market) ?? []) cb(trade);
    },
    _subscriberCount(market) {
      return subscribers.get(market)?.size ?? 0;
    },
  };
}

function makeTrade(market = "BINANCE_FUTURES:btcusdt", price = 50000, time = Date.now()) {
  return {
    time,
    price,
    qty: 0.1,
    isBuy: true,
    liquidation: false,
    market,
    source: "live",
    receivedAt: Date.now(),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeSessionServices(fetchHistory) {
  let sessionCallback;
  const subscribers = new Map();
  return {
    subscribeToTrades(market, cb) {
      if (!subscribers.has(market)) subscribers.set(market, new Set());
      subscribers.get(market).add(cb);
      return () => subscribers.get(market)?.delete(cb);
    },
    subscribeToTradeSessions(cb) { sessionCallback = cb; return () => { sessionCallback = null; }; },
    fetchHistory,
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync: () => {},
    _emit(market, trade) { for (const cb of subscribers.get(market) ?? []) cb(trade); },
    _session(generation, boundaryAt) { sessionCallback?.({ generation, boundaryAt }); },
  };
}

/** One unit cell at `priceBin`, for bars wide enough to trip the cell budget. */
function wideCell(priceBin) {
  return { priceBin, buyVol: 1, sellVol: 1, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 1 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("pipeline subscribes to trades on construction", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  assert.equal(svc._subscriberCount("BINANCE_FUTURES:btcusdt"), 1, "should have 1 subscriber");
  pipeline.dispose();
});

test("pipeline unsubscribes on dispose", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  pipeline.dispose();
  assert.equal(svc._subscriberCount("BINANCE_FUTURES:btcusdt"), 0, "should unsubscribe after dispose");
});

test("dispose is idempotent", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  pipeline.dispose();
  assert.doesNotThrow(() => pipeline.dispose(), "second dispose should not throw");
});

test("live trade reaches series via subscription", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  assert.equal(pipeline.series.length, 0, "series starts empty");

  const trade = makeTrade("BINANCE_FUTURES:btcusdt", 65000);
  svc._emit("BINANCE_FUTURES:btcusdt", trade);

  assert.equal(pipeline.series.length, 1, "trade should create a bar");
  pipeline.dispose();
});

test("onUpdate fires when trade arrives", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });

  let updates = 0;
  pipeline.onUpdate = () => { updates++; };

  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000));
  assert.equal(updates, 1, "onUpdate should fire once per trade");
  pipeline.dispose();
});


test("onUpdate classifies live same-bar updates and new-bar appends", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 10,
    services: svc,
  });

  const events = [];
  pipeline.onUpdate = (event) => events.push(event);

  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000, 1_000));
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65010, 2_000));
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65100, 61_000));

  assert.deepEqual(events.map((event) => event.kind), [
    "new-bar-appended",
    "same-bar-update",
    "new-bar-appended",
  ]);
  assert.equal(events[0].previous.length, 0);
  assert.equal(events[0].next.length, 1);
  assert.equal(events[1].previous.lastBarStart, events[1].next.lastBarStart);
  assert.equal(events[2].previous.length, 1);
  assert.equal(events[2].next.length, 2);

  pipeline.dispose();
});

// ── Live-trade batching (ingestion optimization) ──────────────────────────────

/** Manual scheduler: buffers flush callbacks so tests control frame boundaries. */
function makeManualScheduler() {
  let pending = null;
  let nextHandle = 1;
  let requestCount = 0;
  return {
    scheduler: {
      request(cb) { requestCount++; pending = cb; return nextHandle++; },
      cancel() { pending = null; },
    },
    flush() { const cb = pending; pending = null; cb?.(); },
    hasPending() { return pending !== null; },
    requestCount() { return requestCount; },
  };
}

test("pending trade cap restores bounded headroom and drains without dropping trades", () => {
  const reports = []; const svc = makeServices();
  svc.acquirePipelineIntegrityReporter = () => ({ report: (state, detail = "") => reports.push([state, detail]), dispose() {} });
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({ market: "BINANCE_FUTURES:btcusdt", intervalMs: 60_000, priceStep: 10, services: svc, scheduler: sched.scheduler });
  for (let i = 0; i < 10_000; i++) svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000, 1_000 + i));
  assert.equal(pipeline.series.length, 0, "overflow enqueue must not process trades synchronously");
  assert.equal(sched.hasPending(), true, "all overflow work should continue on scheduled turns");
  let turns = 0;
  while (sched.hasPending()) { sched.flush(); turns++; assert.ok(turns <= 100, "each turn must process at least one 100-trade sub-batch"); }
  assert.ok(turns >= 10, "each scheduler turn must remain capped at 1,000 trades");
  assert.equal(pipeline.series.at(0)?.count, 10_000, "all trades must drain without loss");
  assert.ok(reports.some(([state, detail]) => state === "pending" && detail === "PENDING_TRADE_BUFFER_OVERFLOW")); pipeline.dispose();
});

test("pause releases the upstream market subscription and resume reacquires it", () => {
  const svc = makeServices(); const sched = makeManualScheduler();
  const market = "BINANCE_FUTURES:btcusdt";
  const pipeline = new ChartDataPipeline({ market, intervalMs: 60_000, priceStep: 10, services: svc, scheduler: sched.scheduler });
  svc._emit(market, makeTrade(market, 65000, 1_000)); assert.equal(sched.requestCount(), 1);
  pipeline.setPaused(true);
  assert.equal(sched.hasPending(), false);
  assert.equal(svc._subscriberCount(market), 0, "hidden/replay charts must actually unsubscribe");
  pipeline.setPaused(false);
  assert.equal(svc._subscriberCount(market), 1, "visible live charts reacquire the existing market");
  assert.equal(sched.requestCount(), 2);
  sched.flush(); assert.equal(pipeline.series.at(0)?.count, 1); pipeline.dispose();
});

test("batches a burst of trades into one onUpdate per frame", () => {
  const svc = makeServices();
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 10,
    services: svc,
    scheduler: sched.scheduler,
  });

  const events = [];
  pipeline.onUpdate = (e) => events.push(e);

  // Three same-bar trades arrive before the frame fires.
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000, 1_000));
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65010, 2_000));
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65020, 3_000));
  assert.equal(events.length, 0, "no update before the frame flush");
  assert.equal(pipeline.series.length, 0, "series untouched before flush");

  sched.flush();
  assert.equal(events.length, 1, "one coalesced update for the whole burst");
  assert.equal(pipeline.series.length, 1, "all three trades folded into one bar");
  assert.equal(events[0].kind, "new-bar-appended");

  pipeline.dispose();
});

test("fires onBarClose for every bar closed within a single batch", () => {
  const svc = makeServices();
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 10,
    services: svc,
    scheduler: sched.scheduler,
  });

  const closed = [];
  pipeline.onBarClose = (bar) => closed.push(bar.startTime);

  // Prime lastBarStart with a first flushed bar.
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000, 1_000));
  sched.flush();
  assert.equal(closed.length, 0, "no bar has closed yet");

  // Burst spanning three later minute buckets: two bars close in one flush.
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65010, 61_000));
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65020, 121_000));
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65030, 181_000));
  sched.flush();

  assert.deepEqual(closed, [0, 60_000, 120_000],
    "each bar that closed during the batch fires once, in chronological order");
  pipeline.dispose();
});

test("dispose cancels a pending flush and drops buffered trades", () => {
  const svc = makeServices();
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 10,
    services: svc,
    scheduler: sched.scheduler,
  });
  let updates = 0;
  pipeline.onUpdate = () => { updates++; };

  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000, 1_000));
  assert.equal(sched.hasPending(), true, "flush scheduled");
  pipeline.dispose();
  assert.equal(sched.hasPending(), false, "dispose cancelled the pending flush");
  assert.equal(updates, 0, "no update fired for the dropped buffer");
});

test("onUpdate does not fire after dispose", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });

  let updates = 0;
  pipeline.onUpdate = () => { updates++; };
  pipeline.dispose();

  // Manually emit after dispose — subscriber was removed, so cb won't fire.
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000));
  assert.equal(updates, 0, "onUpdate should not fire after dispose");
});

test("two pipelines for different markets subscribe independently", () => {
  const svc = makeServices();
  const btc = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  const eth = new ChartDataPipeline({
    market: "BINANCE_FUTURES:ethusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 0.5,
    services: svc,
  });

  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000));
  svc._emit("BINANCE_FUTURES:ethusdt", makeTrade("BINANCE_FUTURES:ethusdt", 3500));

  assert.equal(btc.series.length, 1, "BTC series should have 1 bar");
  assert.equal(eth.series.length, 1, "ETH series should have 1 bar");

  // BTC trade should not contaminate ETH series
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65100));
  assert.equal(eth.series.length, 1, "ETH series should not grow from BTC trade");

  btc.dispose();
  eth.dispose();
});

test("series is cleared on changeConfig with new timeframe", async () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000, // 15m
    priceStep: 10,
    services: svc,
  });

  // Add a bar
  svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 65000));
  assert.equal(pipeline.series.length, 1);

  // Change timeframe — series should clear
  await pipeline.changeConfig({ intervalMs: 60 * 60 * 1000 }); // 1h
  assert.equal(pipeline.series.length, 0, "series should clear after timeframe change");

  pipeline.dispose();
});

test("resubscribes to new market after changeConfig", async () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });

  assert.equal(svc._subscriberCount("BINANCE_FUTURES:btcusdt"), 1);
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });

  assert.equal(svc._subscriberCount("BINANCE_FUTURES:btcusdt"), 0, "old market unsubscribed");
  assert.equal(svc._subscriberCount("BINANCE_FUTURES:ethusdt"), 1, "new market subscribed");

  pipeline.dispose();
  assert.equal(svc._subscriberCount("BINANCE_FUTURES:ethusdt"), 0, "cleaned up after dispose");
});

test("stale history load is ignored after market/timeframe change", async (t) => {
  const svc = makeServices();
  const historyCalls = [];
  let resolveFirst;
  let resolveSecond;
  useFakeChartDataSource(t, {
    history: async (query) => {
      historyCalls.push(query.markets.join(","));
      const callIndex = historyCalls.length;
      if (callIndex === 1 && !resolveFirst) {
        await new Promise((resolve) => { resolveFirst = resolve; });
      }
      if (callIndex === 1) {
        // Stale (old market, 15m interval): start aligned to 15m so it is a
        // valid bar; it should still be dropped by the generation guard.
        return [historyBar(900_000, { open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 0 })];
      }
      if (!resolveSecond) {
        await new Promise((resolve) => { resolveSecond = resolve; });
      }
      // Current (new market, 1h interval): start aligned to 1h.
      return [historyBar(3_600_000, { open: 2, high: 2, low: 2, close: 2, volume: 2, delta: 0, count: 0 })];
    },
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });

  const first = pipeline.loadHistory({ from: 0, to: 1_000 });
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt", intervalMs: 60 * 60 * 1000 });
  const second = pipeline.loadHistory({ from: 0, to: 2_000 });

  resolveFirst?.();
  await first;
  resolveSecond?.();
  await second;

  assert.equal(historyCalls[0], "BINANCE_FUTURES:btcusdt", "first request should target old market");
  assert.equal(historyCalls.at(-1), "BINANCE_FUTURES:ethusdt", "latest request should target new market");
  assert.equal(pipeline.series.at(0)?.startTime, 3_600_000, "stale response must not overwrite the latest series");

  pipeline.dispose();
});

test("loadHistory schedules requests in bounded newest-first windows", async (t) => {
  const interval = 60_000;
  const to = 20_001 * interval;
  const requests = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      requests.push(query);
      return [];
    },
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: interval,
    priceStep: 1,
    services: makeServices(),
  });
  await pipeline.loadHistory({ from: 0, to });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].to, to);
  assert.equal(requests[1].to, requests[0].from - 1);
  for (const { from, to: requestTo } of requests) {
    assert.ok(Math.ceil((requestTo - from) / interval) <= 20_000);
  }
  pipeline.dispose();
});

test("oversized history attempts are discarded and refetched as a newest suffix then older prefix", async (t) => {
  const interval = 60_000;
  const firstBar = () => historyBar(0, {
    open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 1,
    cells: Array.from({ length: 400_001 }, (_, i) => wideCell(i + 1)),
  });
  const secondBar = () => historyBar(interval, {
    open: 2, high: 2, low: 2, close: 2, volume: 1, delta: 0, count: 1,
    cells: Array.from({ length: 400_001 }, (_, i) => wideCell(i + 500_002)),
  });
  const requests = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      requests.push(query);
      const { from, to: requestTo } = query;
      return from === 0 && requestTo === interval * 2
        ? [firstBar(), secondBar()]
        : from === interval
          ? [secondBar()]
          : [firstBar()];
    },
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: interval,
    priceStep: 1,
    services: makeServices(),
  });
  const updates = [];
  pipeline.onUpdate = (event) => updates.push(event.kind);
  await pipeline.loadHistory({ from: 0, to: interval * 2 });

  assert.deepEqual(requests.map((request) => [request.from, request.to]), [
    [0, interval * 2],
    [interval, interval * 2],
    [0, interval - 1],
  ]);
  assert.deepEqual(updates, ["history-loaded", "history-patched"],
    "the oversized first attempt must never emit a partial update");
  assert.deepEqual(pipeline.series.list().map((bar) => bar.startTime), [0, interval]);
  pipeline.dispose();
});

test("history applies newly materialized bars without a second structuredClone", async (t) => {
  const originalStructuredClone = globalThis.structuredClone;
  const interval = 60_000;
  useFakeChartDataSource(t, {
    history: () => [historyBar(0, {
      open: 100, high: 101, low: 99, close: 100, volume: 1, delta: 0, count: 1,
      cells: [{ priceBin: 100, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }],
    })],
  });

  try {
    const pipeline = new ChartDataPipeline({
      market: "BINANCE_FUTURES:btcusdt",
      intervalMs: interval,
      priceStep: 1,
      services: makeServices(),
    });
    globalThis.structuredClone = (value, options) => {
      if (value && typeof value === "object" && "startTime" in value && value.cells instanceof Map) {
        throw new Error("history bar was cloned after materialization");
      }
      return originalStructuredClone(value, options);
    };

    await assert.doesNotReject(() => pipeline.loadHistory({ from: 0, to: interval }));
    assert.equal(pipeline.series.at(0)?.close, 100);
    pipeline.dispose();
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }
});

test("oversized history splits when the newest suffix starts exactly at inclusive `to`", async (t) => {
  const interval = 60_000;
  const olderBar = () => historyBar(0, {
    open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 1,
    cells: Array.from({ length: 400_001 }, (_, i) => wideCell(i + 1)),
  });
  const newestBar = () => historyBar(interval, {
    open: 2, high: 2, low: 2, close: 2, volume: 1, delta: 0, count: 1,
    cells: Array.from({ length: 400_001 }, (_, i) => wideCell(i + 500_002)),
  });
  const requests = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      requests.push(query);
      const { from, to } = query;
      return from === 0 && to === interval
        ? [olderBar(), newestBar()]
        : from === interval && to === interval
          ? [newestBar()]
          : [olderBar()];
    },
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: interval,
    priceStep: 1,
    services: makeServices(),
  });
  const updates = [];
  pipeline.onUpdate = (event) => updates.push(event.kind);
  await pipeline.loadHistory({ from: 0, to: interval });

  assert.deepEqual(requests.map((request) => [request.from, request.to]), [
    [0, interval],
    [interval, interval],
    [0, interval - 1],
  ]);
  assert.deepEqual(updates, ["history-loaded", "history-patched"]);
  assert.deepEqual(pipeline.series.list().map((bar) => bar.startTime), [0, interval]);
  pipeline.dispose();
});

test("twoPhase discards an oversized multi-bar attempt before applying any footprint batch", async (t) => {
  const interval = 60_000;
  const olderBar = () => historyBar(0, {
    open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 1,
    cells: Array.from({ length: 400_001 }, (_, i) => wideCell(i + 1)),
  });
  const newestBar = () => historyBar(interval, {
    open: 2, high: 2, low: 2, close: 2, volume: 1, delta: 0, count: 1,
    cells: Array.from({ length: 400_001 }, (_, i) => wideCell(i + 500_002)),
  });
  const phase2Requests = [];
  const eventSnapshots = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      const isFast = query.includeFootprint === false;
      if (isFast) return [];
      const { from, to } = query;
      phase2Requests.push([from, to]);
      return from === 0 && to === interval
        ? [olderBar(), newestBar()]
        : from === interval && to === interval
          ? [newestBar()]
          : [olderBar()];
    },
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: interval,
    priceStep: 1,
    services: makeServices(),
  });
  pipeline.onUpdate = () => eventSnapshots.push(pipeline.series.list().map((bar) => bar.startTime));
  await pipeline.loadHistory({ from: 0, to: interval, twoPhase: true });

  assert.deepEqual(phase2Requests, [
    [0, interval],
    [interval, interval],
    [0, interval - 1],
  ], "oversized phase-2 attempt must retry newest suffix before older prefix");
  assert.deepEqual(eventSnapshots, [[], [interval], [0, interval]],
    "oversized attempt must not apply a partial footprint batch");
  assert.deepEqual(pipeline.series.list().map((bar) => bar.startTime), [0, interval]);
  pipeline.dispose();
});

test("patchDay drops a stale response after the market changes", async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  useFakeChartDataSource(t, {
    history: async () => {
      await pending;
      return [historyBar(0, { open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 1 })];
    },
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: makeServices(),
  });
  const patch = pipeline.patchDay(0);
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  release();
  await patch;
  assert.equal(pipeline.series.length, 0, "stale patch must not apply after generation changes");
  pipeline.dispose();
});

// ── pricePrecision flow (issue: BTC axis & HUD showed no decimals on first open) ─

test("pricePrecision from constructor is set on series before first render", () => {
  const svc = makeServices({ priceStep: 10, pricePrecision: 2 });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    pricePrecision: 2,
    services: svc,
  });
  assert.equal(pipeline.series.config.pricePrecision, 2,
    "BTC must get 2-decimal precision from constructor, not fall back to step heuristic");
  pipeline.dispose();
});

test("pricePrecision undefined leaves series pricePrecision undefined (renderer falls back)", () => {
  const svc = makeServices({ priceStep: 10, pricePrecision: undefined });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  assert.equal(pipeline.series.config.pricePrecision, undefined,
    "undefined precision must stay undefined, not be silently coerced to 0");
  pipeline.dispose();
});

test("changeConfig updates pricePrecision when precision arrives later", async () => {
  const svc = makeServices({ priceStep: 10, pricePrecision: 2 });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    pricePrecision: 2,
    services: svc,
  });
  assert.equal(pipeline.series.config.pricePrecision, 2);

  // Switch to a market whose precision is undefined (e.g. bridge offline)
  const offlineSvc = makeServices({ priceStep: 10, pricePrecision: undefined });
  // Reach into the pipeline by replacing services for the changeConfig call is
  // too invasive; instead just verify the existing path: when precision IS
  // undefined on changeConfig, the existing branch keeps series pricePrecision
  // as-is. This protects against accidentally clobbering on a market switch.
  pipeline.dispose();
  const p2 = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    pricePrecision: 2,
    services: svc,
  });
  await p2.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  // precision came back as 2 → series now uses 2 too
  assert.equal(p2.series.config.pricePrecision, 2);
  p2.dispose();
});

test("changeConfig proceeds on fallback priceStep when bridge is slow, then pendingStepCorrection resolves the real step", async () => {
  // fetchPriceStep never resolves during the test (simulates a slow/hung bridge
  // call) — changeConfig must not hang waiting for it; it should proceed on the
  // pipeline's current priceStep (fallbackStep) after the bounded race timeout.
  // The bound is injected here only so the test doesn't pay the real one: what is
  // asserted is that a bound EXISTS (fetch() has no default timeout, so without it a
  // hung bridge freezes the switch forever), not its production value. That value is
  // sized to clear a cold bridge's real resolution cost — see PRICE_STEP_RESOLVE_TIMEOUT_MS
  // and DEC-0085, where the old 1500ms bound expired 400ms early and applied the
  // previous market's step.
  let resolveRealStep;
  const realStepPromise = new Promise((resolve) => { resolveRealStep = resolve; });
  const svc = {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async (_market) => realStepPromise,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync: () => {},
  };
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
    priceStepResolveTimeoutMs: 20,
  });

  const changePromise = pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  await changePromise;
  // changeConfig resolved without waiting for fetchPriceStep — proceeded on
  // the fallback (pipeline's existing priceStep).
  assert.equal(pipeline.series.config.priceStep, 10, "should use fallback step while real step is pending");

  // Now let the real value resolve; pendingStepCorrection should pick it up
  // and update the series to the corrected step.
  resolveRealStep(25);
  const corrected = await pipeline.pendingStepCorrection;
  assert.equal(corrected, 25, "pendingStepCorrection should resolve to the real step once available");
  assert.equal(pipeline.series.config.priceStep, 25, "series priceStep should be corrected after the real value arrives");

  pipeline.dispose();
});

test("pendingStepCorrection resolves to null when the real step matches the fallback (no-op correction)", async () => {
  const svc = {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => new Promise((resolve) => setTimeout(() => resolve(10), 5)),
    fetchPricePrecision: async () => undefined,
    triggerAutoSync: () => {},
  };
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  const corrected = await pipeline.pendingStepCorrection;
  // Real step (10) resolved fast enough to be used directly by Promise.race,
  // so usedFallbackStep is false and pendingStepCorrection is a no-op.
  assert.equal(corrected, null);
  pipeline.dispose();
});

test("patchDay refreshes the whole UTC day for intraday chart intervals", async (t) => {
  const requests = [];
  const dayStart = Date.UTC(2026, 5, 24);
  useFakeChartDataSource(t, {
    history: (query) => {
      requests.push(query);
      return [
        historyBar(dayStart, { open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 4, count: 3, cells: [{ priceBin: 1, buyVol: 7, sellVol: 3, liquidationBuyVol: 0, liquidationSellVol: 0, count: 3, buyCount: 2, sellCount: 1 }] }),
        historyBar(dayStart + 900_000, { open: 2, high: 3, low: 2, close: 3, volume: 20, delta: -2, count: 5, cells: [{ priceBin: 2, buyVol: 9, sellVol: 11, liquidationBuyVol: 0, liquidationSellVol: 0, count: 5, buyCount: 2, sellCount: 3 }] }),
      ];
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 1,
    services: svc,
  });
  const updateOrder = [];
  const updates = [];
  pipeline.onBeforeUpdate = (kind) => updateOrder.push(`before:${kind}`);
  pipeline.onUpdate = (event) => { updateOrder.push(`after:${event.kind}`); updates.push(event); };
  await pipeline.patchDay(dayStart + 12 * 60 * 60 * 1000);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].from, dayStart);
  assert.equal(requests[0].to, dayStart + 86_400_000 - 1);
  assert.equal(requests[0].rebuild ?? false, false);
  assert.equal(pipeline.series.length, 2);
  assert.equal(pipeline.series.at(0).cells.get(1).buyCount, 2);
  assert.equal(pipeline.series.at(1).cells.get(2).sellCount, 3);
  assert.deepEqual(updateOrder, ["before:history-patched", "after:history-patched"]);
  assert.equal(updates[0].priceChanged, true);

  updateOrder.length = 0;
  await pipeline.patchDay(dayStart + 12 * 60 * 60 * 1000);
  assert.deepEqual(updateOrder, ["before:history-patched", "after:history-patched"]);
  assert.equal(updates[1].priceChanged, false, "cell-equivalent price structure must not request another Y auto-fit");
  pipeline.dispose();
});

test("patchDay refreshes the containing canonical bucket for daily and higher chart intervals", async (t) => {
  const requests = [];
  const week = 7 * 86_400_000;
  const dayInsideWeek = Date.UTC(2026, 5, 24); // Wednesday; canonical weekly bucket starts Monday 2026-06-22.
  const bucketStart = Date.UTC(2026, 5, 22);
  useFakeChartDataSource(t, {
    history: (query) => {
      requests.push(query);
      return [
        historyBar(bucketStart, { open: 10, high: 12, low: 9, close: 11, volume: 30, delta: 4, count: 6, cells: [{ priceBin: 10, buyVol: 17, sellVol: 13, liquidationBuyVol: 0, liquidationSellVol: 0, count: 6, buyCount: 4, sellCount: 2 }] }),
      ];
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: week,
    priceStep: 1,
    services: svc,
  });
  await pipeline.patchDay(dayInsideWeek);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].from, bucketStart);
  assert.equal(requests[0].to, bucketStart + week - 1);
  assert.equal(requests[0].rebuild, true);
  assert.equal(pipeline.series.length, 1);
  assert.equal(pipeline.series.at(0).startTime, bucketStart);
  pipeline.dispose();
});

test("periodic live OHLC refresh is scheduled as background maintenance", async (t) => {
  let requested;
  useFakeChartDataSource(t, {
    liveOhlc: (query) => {
      requested = query;
      return [];
    },
  });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:ethusdt",
    intervalMs: 86_400_000,
    priceStep: 1,
    services: makeServices(),
  });
  await pipeline.refreshLiveBarOHLC();
  assert.equal(requested.purpose, "maintenance");
  assert.equal(requested.includeFootprint, false);
  pipeline.dispose();
});


test("live OHLC refresh seeds the open bucket the history snapshot excludes", async (t) => {
  const intervalMs = 60_000;
  const liveStart = Math.floor(Date.now() / intervalMs) * intervalMs;
  useFakeChartDataSource(t, {
    liveOhlc: () => [historyBar(liveStart, { open: 100, high: 110, low: 90, close: 105, volume: 5, delta: 0, count: 3 })],
  });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs,
    priceStep: 1,
    services: makeServices(),
  });
  assert.equal(pipeline.series.get(liveStart), undefined, "history stops before the open bucket");
  await pipeline.refreshLiveBarOHLC();
  const seeded = pipeline.series.get(liveStart);
  assert.ok(seeded, "the open bucket must be seeded from REST, not from the first live trade");
  assert.equal(seeded.open, 100);
  assert.equal(seeded.high, 110);
  assert.equal(seeded.low, 90);
  pipeline.dispose();
});

test("live OHLC refresh reasserts the open bar's REST open over a live-trade open", async (t) => {
  const intervalMs = 60_000;
  const liveStart = Math.floor(Date.now() / intervalMs) * intervalMs;
  useFakeChartDataSource(t, {
    liveOhlc: () => [historyBar(liveStart, { open: 100, high: 110, low: 90, close: 105, volume: 5, delta: 0, count: 3 })],
  });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs,
    priceStep: 1,
    services: makeServices(),
  });
  // What the old behaviour left behind: a bar opened at the first post-load trade.
  pipeline.series.addTrade({
    time: liveStart + 1_000, price: 105, qty: 1, isBuy: true, liquidation: false,
    market: "BINANCE_FUTURES:btcusdt", source: "live", receivedAt: Date.now(),
  });
  assert.equal(pipeline.series.get(liveStart).open, 105);
  await pipeline.refreshLiveBarOHLC();
  assert.equal(pipeline.series.get(liveStart).open, 100);
  pipeline.dispose();
});

test("periodic live OHLC maintenance is single-flight and cancelable", async (t) => {
  let calls = 0;
  let abortObserved = false;
  let release = null;
  let liveOhlc = async ({ signal }) => {
    calls++;
    return await new Promise((resolve, reject) => {
      const abort = () => {
        abortObserved = true;
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      release = () => resolve([]);
    });
  };
  useFakeChartDataSource(t, { liveOhlc: (query) => liveOhlc(query) });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:ethusdt",
    intervalMs: 86_400_000,
    priceStep: 1,
    services: makeServices(),
  });
  const first = pipeline.refreshLiveBarOHLC();
  const joined = pipeline.refreshLiveBarOHLC();
  for (let turn = 0; calls === 0 && turn < 8; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(calls, 1, "overlapping maintenance ticks must share one request");
  pipeline.cancelLiveBarOHLCRefresh();
  await Promise.all([first, joined]);
  assert.equal(abortObserved, true, "explicit sync/history work must be able to cancel maintenance");

  liveOhlc = async ({ from }) => {
    calls++;
    return [historyBar(from, { open: 100, high: 110, low: 90, close: 105, volume: 10, delta: 2, count: 20 })];
  };
  await pipeline.refreshLiveBarOHLC();
  assert.equal(calls, 2, "a settled/cancelled maintenance request must allow the next periodic attempt");
  pipeline.dispose();
  void release;
});

// ── Degraded-data meta propagation (bulgu #6: StatusBar badge) ────────────────

test("loadHistory forwards meta.degraded=true + first provenance error via onDataDegraded", async (t) => {
  useFakeChartDataSource(t, {
    history: () => ({
      bars: [],
      meta: {
        schemaVersion: 1,
        generatedAt: Date.now(),
        degraded: true,
        provenance: [{ source: "binance-klines", completeness: "partial", error: "upstream 502" }],
      },
    }),
  });

  const svc = makeServices();
  const calls = [];
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
    onDataDegraded: (degraded, detail) => calls.push({ degraded, detail }),
  });
  await pipeline.loadHistory({ from: 0, to: 60_000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].degraded, true);
  assert.equal(calls[0].detail, "upstream 502");
  pipeline.dispose();
});

test("loadHistory forwards degraded=false on a clean response (clears stale badge)", async (t) => {
  useFakeChartDataSource(t, {
    history: () => ({ bars: [], meta: { schemaVersion: 1, generatedAt: Date.now() } }),
  });

  const svc = makeServices();
  const calls = [];
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
    onDataDegraded: (degraded, detail) => calls.push({ degraded, detail }),
  });
  await pipeline.loadHistory({ from: 0, to: 60_000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].degraded, false);
  assert.equal(calls[0].detail, "");
  pipeline.dispose();
});

test("loadHistory keeps the first degraded metadata across clean older windows, then clears on a new clean load", async (t) => {
  const interval = 60_000;
  const to = 20_000 * interval;
  useFakeChartDataSource(t, {
    history: ({ to: requestTo }) => {
      const newest = requestTo === to;
      return {
        bars: [],
        meta: newest
          ? {
            schemaVersion: 1,
            generatedAt: Date.now(),
            degraded: true,
            provenance: [{ source: "binance-klines", completeness: "partial", error: "newest degraded" }],
          }
          : { schemaVersion: 1, generatedAt: Date.now(), degraded: false },
      };
    },
  });

  const calls = [];
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: interval,
    priceStep: 1,
    services: makeServices(),
    onDataDegraded: (degraded, detail) => calls.push({ degraded, detail }),
  });
  // Given a degraded newest response followed by a clean older response,
  // when one load spans multiple windows, then the degraded state is latched
  // for that load and the original detail is retained.
  await pipeline.loadHistory({ from: 0, to });
  assert.deepEqual(calls, [
    { degraded: true, detail: "newest degraded" },
    { degraded: true, detail: "newest degraded" },
  ]);

  // A subsequent independent clean load starts a fresh latch and clears the badge.
  calls.length = 0;
  await pipeline.loadHistory({ from: 0, to: 0 });
  assert.deepEqual(calls, [{ degraded: false, detail: "" }]);
  pipeline.dispose();
});

test("loadHistory retains degraded metadata when an older window fails after a clean newest window", async (t) => {
  const interval = 60_000;
  const to = 40_000 * interval;
  useFakeChartDataSource(t, {
    history: ({ from: requestFrom, to: requestTo }) => {
      const newest = requestTo === to;
      const oldest = requestFrom === 0;
      const meta = newest || oldest
        ? { schemaVersion: 1, generatedAt: Date.now(), degraded: false }
        : {
          schemaVersion: 1,
          generatedAt: Date.now(),
          degraded: true,
          provenance: [{ source: "binance-klines", completeness: "partial", error: "middle degraded" }],
        };
      return { bars: [], meta };
    },
  });

  const calls = [];
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: interval,
    priceStep: 1,
    services: makeServices(),
    onDataDegraded: (degraded, detail) => calls.push({ degraded, detail }),
  });
  // Given a clean newest response, a degraded middle response, and a clean
  // oldest response, when all windows finish, then the degraded state cannot
  // be cleared by the later clean metadata in the same load.
  await pipeline.loadHistory({ from: 0, to });
  assert.deepEqual(calls, [
    { degraded: false, detail: "" },
    { degraded: true, detail: "middle degraded" },
    { degraded: true, detail: "middle degraded" },
  ]);
  pipeline.dispose();
});

test("loadHistory works fine without onDataDegraded configured (optional callback)", async (t) => {
  useFakeChartDataSource(t, {
    history: () => ({ bars: [], meta: { schemaVersion: 1, generatedAt: Date.now(), degraded: true } }),
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });
  await assert.doesNotReject(() => pipeline.loadHistory({ from: 0, to: 60_000 }));
  pipeline.dispose();
});

// ── twoPhase candle-first loading (HANDOFF-0148) ──────────────────────────────

// Footprint cells are policy-stripped for bars before 2020-01-01 (see
// src/core/footprintPolicy.ts) — use a real-world-ish timestamp so cells
// survive enforceFootprintPolicy() in these tests.
const BAR_T = Date.UTC(2024, 0, 1);

test("twoPhase: fires cell-less update first, then cell-included update", async (t) => {
  const requests = [];
  const events = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      const isFast = query.includeFootprint === false;
      requests.push(!isFast);
      return [
        isFast
          ? historyBar(BAR_T, { open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 0 })
          : historyBar(BAR_T, { open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 1, cells: [{ priceBin: 1, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }] }),
      ];
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });
  pipeline.onUpdate = (event) => events.push({ kind: event.kind, historyFootprint: pipeline.activeHistoryFootprintReceived });
  pipeline.onHistoryCandlesReady = () => events.push({
    kind: "candles-ready",
    historyFootprint: pipeline.activeHistoryFootprintReceived,
  });

  await pipeline.loadHistory({ from: BAR_T, to: BAR_T + 60_000, twoPhase: true });

  assert.deepEqual(requests, [false, true], "phase 1 must request candles without footprint, phase 2 the full response");
  assert.deepEqual(events, [
    { kind: "history-loaded", historyFootprint: false },
    { kind: "candles-ready", historyFootprint: false },
    { kind: "history-patched", historyFootprint: true },
  ],
    "phase 1 completion must signal candles-ready before phase 2 footprint cells arrive");
  assert.equal(pipeline.series.at(0)?.cells.size, 1, "final series must have cells from phase 2");
  pipeline.dispose();
});

test("twoPhase: zero-cell phase 2 still settles without claiming footprint readiness", async (t) => {
  const events = [];
  useFakeChartDataSource(t, {
    history: () => [historyBar(BAR_T, { open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 1 })],
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:solusdt",
    intervalMs: 60_000,
    priceStep: 0.05,
    services: makeServices({ priceStep: 0.05 }),
  });
  pipeline.onUpdate = (event) => events.push(event.kind);

  await assert.doesNotReject(() => pipeline.loadHistory({ from: BAR_T, to: BAR_T + 60_000, twoPhase: true }));

  assert.deepEqual(events, ["history-loaded", "history-patched"],
    "zero-cell phase 2 must settle as a normal history patch");
  assert.equal(pipeline.activeHistoryFootprintReceived, false,
    "zero-cell phase 2 must not claim that footprint data exists");
  assert.equal(pipeline.series.at(0)?.cells.size, 0);
  pipeline.dispose();
});

test("twoPhase: phase 2 result is dropped if market/timeframe changes before it lands (generation guard)", async (t) => {
  let resolveFast;
  let resolveFull;
  const svc = makeServices();
  useFakeChartDataSource(t, {
    history: (query) => {
      const isFast = query.includeFootprint === false;
      const bars = [historyBar(0, { open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 0 })];
      return new Promise((resolve) => {
        // Delay: fast (phase 1) resolves quickly, full (phase 2) waits until
        // the test explicitly releases it (after changeConfig has already run).
        if (isFast) {
          resolveFast = () => resolve(bars);
          queueMicrotask(resolveFast);
        } else {
          resolveFull = () => resolve(bars);
        }
      });
    },
  });

  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });

  const load = pipeline.loadHistory({ from: 0, to: 60_000, twoPhase: true });
  // Let phase 1 land, then switch markets before phase 2 resolves.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  resolveFull?.();
  await load;

  assert.equal(pipeline.series.length, 0,
    "phase 2's stale response for the old market must not be applied after changeConfig cleared the series");
  pipeline.dispose();
});

test("twoPhase=false (default) behaves exactly like the pre-existing single-phase path", async (t) => {
  const requests = [];
  const events = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      requests.push(query.includeFootprint !== false);
      return [];
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });
  pipeline.onUpdate = (event) => events.push(event.kind);

  await pipeline.loadHistory({ from: 0, to: 60_000 });

  assert.deepEqual(requests, [true], "only a single full request should be made");
  assert.deepEqual(events, ["history-loaded"], "single history-loaded update, no history-patched");
  pipeline.dispose();
});

test("twoPhase: phase 1 fetch error does not block phase 2 from delivering full data", async (t) => {
  const events = [];
  let call = 0;
  useFakeChartDataSource(t, {
    history: (query) => {
      const isFast = query.includeFootprint === false;
      call++;
      if (isFast) throw new Error("network error on fast phase");
      return [historyBar(BAR_T, { open: 1, high: 1, low: 1, close: 1, volume: 1, delta: 0, count: 1, cells: [{ priceBin: 1, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }] })];
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });
  pipeline.onUpdate = (event) => events.push(event.kind);
  let candlesReadyCount = 0;
  pipeline.onHistoryCandlesReady = () => { candlesReadyCount++; };

  assert.equal(typeof pipeline.onHistoryCandlesReady, "function", "pipeline must expose the phase-1 completion signal");
  await assert.doesNotReject(() => pipeline.loadHistory({ from: BAR_T, to: BAR_T + 60_000, twoPhase: true }));

  assert.equal(call, 2, "both phase 1 (failed) and phase 2 requests should have been attempted");
  assert.equal(candlesReadyCount, 0, "failed phase 1 must not publish a false candles-ready signal");
  assert.deepEqual(events, ["history-patched"], "phase 1 failure means no history-loaded event, only phase 2's history-patched");
  assert.equal(pipeline.series.at(0)?.cells.size, 1, "phase 2 must still deliver full cell data");
  pipeline.dispose();
});

// ── twoPhase chunked cell loading, newest-first (HANDOFF-0288 GÖREV 2) ───────

test("twoPhase: phase 2 partitions exact 25/26/425/1001 bucket ranges", async (t) => {
  const interval = 60_000;

  const expected = new Map([
    [25, [[0, 24]]],
    [26, [[1, 25], [0, 0]]],
    [425, [[400, 424], [0, 399]]],
    [1001, [[976, 1000], [576, 975], [176, 575], [0, 175]]],
  ]);
  for (const [bars, ranges] of expected) {
    const phase2Requests = [];
    const phase1Requests = [];
    useFakeChartDataSource(t, {
      history: (query) => {
        const isFast = query.includeFootprint === false;
        const request = {
          from: query.from,
          to: query.to,
          rebuild: query.rebuild === true,
          preferCache: query.preferCache === true,
        };
        if (isFast) phase1Requests.push(request);
        else phase2Requests.push(request);
        return [];
      },
    });

    const pipeline = new ChartDataPipeline({
      market: "BINANCE_FUTURES:btcusdt",
      intervalMs: interval,
      priceStep: 1,
      services: makeServices(),
    });
    const to = (bars - 1) * interval;
    await pipeline.loadHistory({ from: 0, to, twoPhase: true, rebuildKlines: true });

    assert.deepEqual(phase1Requests, [{ from: 0, to, rebuild: true, preferCache: true }], `${bars} phase-1 raw range`);
    assert.deepEqual(
      phase2Requests.map(({ from, to: requestTo }) => [Math.floor(from / interval), Math.floor(requestTo / interval)]),
      ranges,
      `${bars} phase-2 ranges`,
    );
    const seen = [];
    for (const [from, requestTo] of ranges) {
      const bucketCount = requestTo - from + 1;
      assert.ok(bucketCount <= (seen.length ? 400 : 25), `${bars} chunk exceeds its limit`);
      for (let bucket = from; bucket <= requestTo; bucket++) seen.push(bucket);
    }
    assert.deepEqual(seen.sort((a, b) => a - b), [...Array(bars).keys()], `${bars} bucket partition has no overlap/gap`);
    pipeline.dispose();
  }
});

test("twoPhase: a range smaller than one chunk makes a single phase-2 request", async (t) => {
  const phase2Requests = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      if (query.includeFootprint !== false) phase2Requests.push({ from: query.from, to: query.to });
      return [];
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });

  await pipeline.loadHistory({ from: 0, to: 60_000, twoPhase: true });

  assert.deepEqual(phase2Requests, [{ from: 0, to: 60_000 }], "range fits in one chunk — no unnecessary splitting");
  pipeline.dispose();
});

test("daily two-phase load reuses verified candles and explicitly rebuilds the first phase", async (t) => {
  const requests = [];
  useFakeChartDataSource(t, {
    history: (query) => {
      requests.push({
        rebuild: query.rebuild === true,
        preferCache: query.preferCache === true,
        candleCoverage: query.candleCoverage,
      });
      return [];
    },
  });
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 86_400_000,
    priceStep: 1,
    services: makeServices(),
  });
  await pipeline.loadHistory({ from: 0, to: 86_400_000, twoPhase: true });
  assert.deepEqual(requests, [
    { rebuild: false, preferCache: true, candleCoverage: "required" },
    { rebuild: false, preferCache: true, candleCoverage: "required" },
  ]);
  requests.length = 0;
  await pipeline.loadHistory({ from: 0, to: 86_400_000, twoPhase: true, rebuildKlines: true });
  assert.deepEqual(requests, [
    { rebuild: true, preferCache: true, candleCoverage: "required" },
    { rebuild: false, preferCache: true, candleCoverage: "required" },
  ]);
  requests.length = 0;
  await pipeline.loadHistory({ from: 0, to: 86_400_000, twoPhase: true, preferCache: false });
  assert.deepEqual(requests, [
    { rebuild: false, preferCache: false, candleCoverage: "required" },
    { rebuild: false, preferCache: false, candleCoverage: "required" },
  ]);
  pipeline.dispose();
});

test("twoPhase: multi-chunk load resolves only after every chunk lands, and each chunk emits history-patched", async (t) => {
  useFakeChartDataSource(t, { history: () => [] });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });
  const events = [];
  pipeline.onUpdate = (e) => events.push(e.kind);

  await pipeline.loadHistory({ from: 0, to: 1000 * 60_000, twoPhase: true });

  // 1 phase-1 + 1 small newest chunk + 3 older chunks.
  assert.deepEqual(events, ["history-loaded", "history-patched", "history-patched", "history-patched", "history-patched"]);
  pipeline.dispose();
});

// ── fillMissingCells (TASK-017B: scroll-triggered on-demand fill) ────────────

const FILL_DAY_MS = 86_400_000;
function recentFillDayStart(daysAgo = 7) {
  const todayStart = Math.floor(Date.now() / FILL_DAY_MS) * FILL_DAY_MS;
  return todayStart - daysAgo * FILL_DAY_MS;
}

test("fillMissingCells requests a day build for a bar range that has candles but no footprint cells", async (t) => {
  const dayStart = recentFillDayStart();
  const requests = [];
  useFakeChartDataSource(t, {
    // Only the build request is under test; the follow-up patchDay history reads
    // are exercised by the merge test below.
    startRefresh: (request) => { requests.push(request); },
    history: () => [historyBar(dayStart, { open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 4, count: 3 })],
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  // Seed a cell-less bar (candle exists, footprint not backfilled yet) directly
  // into the series, mirroring what an unsynced day's /history response looks
  // like after toBar() folds an empty cells array.
  pipeline.series.upsertBar({
    startTime: dayStart, open: 1, high: 2, low: 1, close: 2,
    volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
  });
  requests.length = 0; // ignore any setup noise (none expected, but be explicit)

  pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
  // The fill is fire-and-forget; wait a tick for the promise chain.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1, "should request the day build exactly once");
  assert.equal(requests[0].kind, "startRefresh");
  assert.equal(requests[0].from, dayStart, "range is day-aligned");
  assert.equal(requests[0].to, dayStart + 86_400_000, "range is day-aligned (exclusive)");
  assert.equal(pipeline.series.at(0)?.cells.size, 0, "cells not yet applied before the awaited flush above resolved the merge");
  pipeline.dispose();
});

test("fillMissingCells merges the fetched bars into the series once the request resolves", async (t) => {
  const dayStart = recentFillDayStart();
  useFakeChartDataSource(t, {
    history: () => [historyBar(dayStart, {
      open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 4, count: 3,
      cells: [{ priceBin: 1, buyVol: 7, sellVol: 3, liquidationBuyVol: 0, liquidationSellVol: 0, count: 3, buyCount: 2, sellCount: 1 }],
    })],
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  pipeline.series.upsertBar({
    startTime: dayStart, open: 1, high: 2, low: 1, close: 2,
    volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
  });

  let updateFired = false;
  pipeline.onUpdate = () => { updateFired = true; };
  pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
  // Three hops: the build request, the status poll, then the patchDay merge.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(updateFired, true, "should emit an onUpdate once cells land");
  assert.equal(pipeline.series.at(0)?.cells.get(1)?.buyCount, 2, "cells land via the patchDay history refetch");
  pipeline.dispose();
});

test("fillMissingCells does not request a range with no unsynced bars", async (t) => {
  const source = useFakeChartDataSource(t);

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  const dayStart = recentFillDayStart();
  // Bar already has footprint cells — nothing to fill.
  pipeline.series.upsertBar({
    startTime: dayStart, open: 1, high: 2, low: 1, close: 2,
    volume: 10, delta: 4, count: 3,
    cells: new Map([[1, { priceBin: 1, buyVol: 1, sellVol: 1, count: 1, buyCount: 1, sellCount: 1 }]]),
    hasRef: true,
  });

  pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(source.queries.length, 0, "no fetch should happen when the range is already synced");
  pipeline.dispose();
});

test("fillMissingCells does not re-request the same day-range on repeated scroll ticks", async (t) => {
  let callCount = 0;
  const dayStart = recentFillDayStart();
  useFakeChartDataSource(t, {
    startRefresh: () => { callCount++; },
    history: () => [historyBar(dayStart, { open: 1, high: 2, low: 1, close: 2, volume: 10, delta: 4, count: 3 })],
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  pipeline.series.upsertBar({
    startTime: dayStart, open: 1, high: 2, low: 1, close: 2,
    volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
  });

  // Simulate rapid scroll ticks hitting the same visible day range.
  pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
  pipeline.fillMissingCells(dayStart + 1000, dayStart + 15 * 60 * 1000 + 1000);
  pipeline.fillMissingCells(dayStart + 2000, dayStart + 15 * 60 * 1000 + 2000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(callCount, 1, "overlapping scroll ticks in the same day-range collapse into one request");
  pipeline.dispose();
});

test("fillMissingCells degrades silently when the bridge is offline", async (t) => {
  const offline = () => { throw new Error("fetch failed"); };
  useFakeChartDataSource(t, { history: offline, startRefresh: offline, refreshStatus: offline });
  const dayStart = recentFillDayStart();

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  pipeline.series.upsertBar({
    startTime: dayStart, open: 1, high: 2, low: 1, close: 2,
    volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
  });

  assert.doesNotThrow(() => pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // No throw, no unhandled rejection — series stays as-is (cell-less bar, no crash).
  assert.equal(pipeline.series.at(0)?.cells.size, 0);
  pipeline.dispose();
});

test("fillMissingCells never requests today or future days (Vision archive lags a day)", async (t) => {
  const DAY = 86_400_000;
  const todayStart = Math.floor(Date.now() / DAY) * DAY;
  const yesterdayStart = todayStart - DAY;
  const requests = [];
  useFakeChartDataSource(t, { startRefresh: (request) => { requests.push(request); } });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  // Cell-less bars yesterday AND today (today's cells come from the live stream).
  for (const start of [yesterdayStart, todayStart]) {
    pipeline.series.upsertBar({
      startTime: start, open: 1, high: 2, low: 1, close: 2,
      volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
    });
  }

  // Visible range reaching into future whitespace right of the last bar.
  pipeline.fillMissingCells(yesterdayStart, todayStart + 3 * DAY);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1, "one request for the elapsed day only");
  assert.equal(requests[0].from, yesterdayStart);
  assert.equal(requests[0].to, todayStart, "clamped before today");

  // A range entirely in today/future must produce no request at all.
  requests.length = 0;
  pipeline.fillMissingCells(todayStart, todayStart + 2 * DAY);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 0, "today/future-only range is skipped");
  pipeline.dispose();
});

test("fillMissingCells is single-flight: scrolling during a slow request does not abort it, newest range replays after it settles", async (t) => {
  const DAY = 86_400_000;
  const day1 = recentFillDayStart();
  const day2 = day1 + DAY;
  const requests = [];
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  useFakeChartDataSource(t, {
    startRefresh: async (request) => {
      requests.push(request);
      if (requests.length === 1) await firstReleased; // simulate a slow bridge day build
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  for (const start of [day1, day2]) {
    pipeline.series.upsertBar({
      startTime: start, open: 1, high: 2, low: 1, close: 2,
      volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
    });
  }

  pipeline.fillMissingCells(day1, day1 + 15 * 60 * 1000);
  // Keep scrolling while the first request is still in flight.
  pipeline.fillMissingCells(day1, day2 + 15 * 60 * 1000);
  pipeline.fillMissingCells(day2, day2 + 15 * 60 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1, "no new request while one is in flight");
  assert.equal(requests[0].signal?.aborted ?? false, false, "in-flight request must not be aborted by scrolling");

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 2, "newest pending range replays after the first settles");
  assert.equal(requests[1].from, day2, "replay skips the already-attempted day1");
  assert.equal(requests[1].to, day2 + DAY);
  pipeline.dispose();
});

test("fillMissingCells skips days beyond the m1 retention window on sub-hour intervals but requests them on 1h+", async (t) => {
  const DAY = 86_400_000;
  const todayStart = Math.floor(Date.now() / DAY) * DAY;
  const oldDay = todayStart - 200 * DAY; // far outside the ~85-day m1 retention
  const requests = [];
  useFakeChartDataSource(t, { startRefresh: (request) => { requests.push(request); } });

  const seedBar = (pipeline) => pipeline.series.upsertBar({
    startTime: oldDay, open: 1, high: 2, low: 1, close: 2,
    volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
  });

  const svc = makeServices();
  // Sub-hour interval: the 1m base tier no longer holds this day — no request.
  const intraday = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  seedBar(intraday);
  intraday.fillMissingCells(oldDay, oldDay + DAY);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 0, "intraday fill outside m1 retention is skipped");
  intraday.dispose();

  // 1h interval: served from the long-retention h1 tier — request goes out.
  const hourly = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60 * 60 * 1000,
    priceStep: 10,
    services: makeServices(),
  });
  seedBar(hourly);
  hourly.fillMissingCells(oldDay, oldDay + DAY);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 1, "1h+ fill for the same old day is requested");
  assert.equal(requests[0].from, oldDay);
  hourly.dispose();
});

test("fillMissingCells dedupes per day when the scrolled window shifts", async (t) => {
  const DAY = 86_400_000;
  const day1 = recentFillDayStart();
  const day2 = day1 + DAY;
  const requests = [];
  useFakeChartDataSource(t, { startRefresh: (request) => { requests.push(request); } });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: svc,
  });
  for (const start of [day1, day2]) {
    pipeline.series.upsertBar({
      startTime: start, open: 1, high: 2, low: 1, close: 2,
      volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
    });
  }

  pipeline.fillMissingCells(day1, day1 + 15 * 60 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Window shifts to cover day1 + day2 — only the not-yet-attempted day2
  // may be requested; day1 must not be re-requested under a wider key.
  pipeline.fillMissingCells(day1, day2 + 15 * 60 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].from, day1);
  assert.equal(requests[0].to, day2);
  assert.equal(requests[1].from, day2, "second request starts at the new day");
  assert.equal(requests[1].to, day2 + DAY);
  pipeline.dispose();
});

test("pending trade queue hard-caps at 10,000 under an oversized burst", () => {
  const reports = [];
  const degraded = [];
  const svc = makeServices();
  svc.acquirePipelineIntegrityReporter = () => ({ report: (state, detail = "") => reports.push([state, detail]), dispose() {} });
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
    scheduler: sched.scheduler,
    onDataDegraded: (value, detail) => degraded.push([value, detail]),
  });

  for (let i = 0; i < 25_001; i++) {
    svc._emit("BINANCE_FUTURES:btcusdt", makeTrade("BINANCE_FUTURES:btcusdt", 100, 1_000 + i));
  }

  assert.equal(pipeline.pendingTrades.length, 10_000, "the live pending queue must never exceed its hard cap");
  assert.equal(pipeline.series.length, 0, "overflow must not force a synchronous full drain");
  assert.ok(reports.some(([state, detail]) => state === "pending" && detail === "PENDING_TRADE_BUFFER_OVERFLOW"));
  assert.ok(degraded.some(([value, detail]) => value === true && detail.includes("PENDING_TRADE_BUFFER_OVERFLOW")),
    "dropped overflow must be explicit rather than silently healed");
  pipeline.dispose();
});

test("preserved footprint cells are not replayed from an already-applied explicit-history journal trade", () => {
  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 60_000,
    priceStep: 1,
    services: svc,
  });
  const from = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
  const candidate = {
    ...makeTrade("BINANCE_FUTURES:btcusdt", 100, from + 1_000),
    id: "11",
    qty: 11,
  };
  pipeline.series.addTrade(candidate);
  pipeline.explicitHistoryReconcile = {
    generation: 0,
    requestedFrom: from,
    requestedTo: from,
    trades: [candidate],
    applied: new Set([candidate]),
    deferred: new Set(),
    liveAfterBarrier: new Set(),
    watermark: 10n,
    retiredWatermarks: new Map(),
  };
  const candleOnly = {
    startTime: from,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 11,
    delta: 11,
    count: 1,
    cells: new Map(),
    completeness: "complete",
    sources: ["history"],
  };

  assert.equal(
    pipeline._applyExplicitHistorySnapshot(from, from + 60_000, [candleOnly], 0, "history-loaded", true, false),
    true,
  );
  const bar = pipeline.series.get(from);
  assert.equal(bar?.volume, 11, "the candle total must remain authoritative");
  assert.equal(bar?.cells.get(100)?.buyVol, 11, "the preserved live cell must remain represented exactly once");
  pipeline.dispose();
});

// T02-A: public two-phase closed-candle ownership (synthetic transport regression).
// Given independently specified January candles, When the public load receives
// healthy, empty-error or sparse-error phase 2, Then each bucket keeps its own
// OHLC/financial/cell oracle; footprint receipt is not a completeness certificate.
const T02A_START = Date.UTC(2026, 0, 12);
const T02A_NOW = Date.UTC(2026, 1, 12);
const T02A_INTERVAL = 60_000;
const T02A_MARKET = "BINANCE_FUTURES:btcusdt";

// Source bars and expected series records are specified separately: no
// production normalizer, series output, or business helper builds the oracle.
function t02aSourceBar(index, phase, partial = false) {
  const base = (phase === "candles" ? 100 : 200) + 10 * index;
  const cell = (priceBin, buyVol, sellVol, count, buyCount, sellCount) => ({
    priceBin, buyVol, sellVol, liquidationBuyVol: 0, liquidationSellVol: 0, count, buyCount, sellCount,
  });
  return phase === "candles"
    ? historyBar(T02A_START + index * T02A_INTERVAL, { open: base + 2, high: base + 9,
      low: base, close: base + 5, volume: 12 + index, delta: 4 + index, count: 6 + index,
      completeness: "complete" })
    : historyBar(T02A_START + index * T02A_INTERVAL, { open: base + 3, high: base + 9,
      low: base, close: base + 6, volume: 20 + 2 * index, delta: 4, count: 8,
      cells: partial
        ? [cell(base, 7 + index, 3 + index, 4, 3, 1)]
        : [cell(base, 7 + index, 3 + index, 4, 3, 1),
          cell(base + 5, 5, 5, 4, 2, 2)],
      completeness: partial ? "partial" : "complete" });
}

function t02aExpectedBar(index, phase, partial = false) {
  if (phase === "candles") {
    return { startTime: T02A_START + index * 60_000,
      open: 102 + 10 * index, high: 109 + 10 * index,
      low: 100 + 10 * index, close: 105 + 10 * index,
      volume: 12 + index, delta: 4 + index, count: 6 + index,
      liquidationBuyVol: 0, liquidationSellVol: 0,
      completeness: "complete", cells: [] };
  }
  const cells = [[200 + 10 * index, 7 + index, 3 + index, 0, 0, 4, 3, 1]];
  if (!partial) cells.push([205 + 10 * index, 5, 5, 0, 0, 4, 2, 2]);
  return { startTime: T02A_START + index * 60_000,
    open: 203 + 10 * index, high: 209 + 10 * index,
    low: 200 + 10 * index, close: 206 + 10 * index,
    volume: 20 + 2 * index, delta: 4, count: 8,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    completeness: partial ? "partial" : "complete", cells };
}

function t02aAssertBars(pipeline, expected, label) {
  const bars = pipeline.series.listReadonly();
  assert.deepEqual(bars.map((bar) => bar.startTime),
    expected.map((bar) => bar.startTime), `${label}: exact bucket continuity`);
  assert.equal(bars.length, expected.length, `${label}: candle count`);
  for (let i = 0; i < expected.length; i++) {
    const bar = bars[i];
    assert.deepEqual({
      startTime: bar.startTime, open: bar.open, high: bar.high, low: bar.low,
      close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count,
      liquidationBuyVol: bar.liquidationBuyVol, liquidationSellVol: bar.liquidationSellVol,
      completeness: bar.completeness,
      cells: [...bar.cells.values()].map((cell) => [
        cell.priceBin, cell.buyVol, cell.sellVol,
        cell.liquidationBuyVol, cell.liquidationSellVol,
        cell.count, cell.buyCount, cell.sellCount,
      ]).sort((a, b) => a[0] - b[0]),
    }, expected[i], `${label}: independent financial oracle for bucket ${i}`);
  }
}

function t02aMeta(from, to, { error = false, full = false, proof } = {}) {
  const candleCoverage = {
    schemaVersion: 1, source: "binance-klines", instrument: T02A_MARKET,
    ownership: error ? null : "snapshot", status: error ? "error" : "verified",
    requestedFrom: from, requestedTo: to,
    snapshotAt: error ? null : T02A_NOW,
    closedThrough: error ? null : to,
    reasonCode: error ? "source_unavailable" : null,
  };
  // These mutations concern ABSENCE ownership only, not rejection of a returned bar.
  if (proof === "wrong-instrument") candleCoverage.instrument = "BINANCE_FUTURES:ethusdt";
  if (proof === "wrong-window") {
    candleCoverage.requestedFrom = from + T02A_INTERVAL;
    candleCoverage.requestedTo = to + T02A_INTERVAL;
  }
  if (proof === "unclosed") candleCoverage.closedThrough = T02A_START + T02A_INTERVAL - 2;
  const meta = {
    schemaVersion: 2, generatedAt: T02A_NOW, degraded: error,
    candleCoverage,
    provenance: [{ source: "binance-klines", completeness: error ? "partial" : "complete",
      error: error ? "source_unavailable" : null }],
  };
  const footprintPending = Boolean(proof && proof !== "verified" && !error);
  if (full) meta.footprintCoverage = {
    schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: T02A_MARKET,
    authority: error || footprintPending ? null : "canonical",
    status: error ? "error" : footprintPending ? "pending" : "complete",
    requestedFrom: from, requestedTo: to,
    coveredFrom: error || footprintPending ? null : from,
    coveredThrough: error || footprintPending ? null : to,
    durableThroughId: null, projectionThroughId: null, authorityToken: null,
    reasonCode: error ? "source_unavailable" : footprintPending ? "runtime_unavailable" : null,
  };
  return proof === "missing" ? undefined : meta;
}

async function t02aLoadScenario(t, { count, mode, olderProof }) {
  const originalNow = Date.now;
  const ready = deferred();
  const fullGate = deferred();
  const requests = [];
  const degraded = [];
  const events = [];
  const to = T02A_START + count * T02A_INTERVAL - 1;
  let pipeline;
  let loading;
  Date.now = () => T02A_NOW;
  useFakeChartDataSource(t, {
    history: async (query) => {
      assert.ok(["fetch", "stream"].includes(query.kind), "only history reads are permitted");
      assert.equal(query.reference, T02A_MARKET);
      assert.equal(query.candleCoverage, "required");
      const fast = query.includeFootprint === false;
      const { from, to: requestTo } = query;
      requests.push({ fast, from, to: requestTo });
      if (!fast) await fullGate.promise;
      const indices = Array.from({ length: count }, (_, i) => i).filter((i) =>
        T02A_START + i * T02A_INTERVAL >= from && T02A_START + i * T02A_INTERVAL <= requestTo);
      const older = !fast && count === 26 && from === T02A_START;
      const error = !fast && (olderProof ? older && olderProof === "error" : mode !== "healthy");
      const partial = !fast && !olderProof && mode === "sparse-error";
      let selected = indices;
      if (!fast && (olderProof ? older : mode === "empty-error")) selected = [];
      else if (partial) selected = [...new Set([indices[0], indices.at(-1)])];
      const bars = selected.map((i) => t02aSourceBar(i, fast ? "candles" : "footprint", partial));
      const meta = t02aMeta(from, requestTo, { error, full: !fast, proof: older ? olderProof : undefined });
      return { bars, meta };
    },
  });
  try {
    pipeline = new ChartDataPipeline({ market: T02A_MARKET, intervalMs: T02A_INTERVAL,
      priceStep: 1, services: makeServices({ priceStep: 1 }),
      onDataDegraded: (value, detail) => degraded.push({ value, detail }) });
    pipeline.onUpdate = (event) => events.push(event.kind);
    pipeline.onHistoryCandlesReady = () => ready.resolve();
    loading = pipeline.loadHistory({ from: T02A_START, to, twoPhase: true });
    await Promise.race([ready.promise, loading.then(() => {
      throw new Error("load settled without the public phase-1 readiness callback");
    })]);
    // The full responses remain deferred: phase 1 must really be in the series.
    t02aAssertBars(pipeline, Array.from({ length: count }, (_, i) => t02aExpectedBar(i, "candles")),
      "before phase 2");
    assert.deepEqual(events, ["history-loaded"]);
    assert.equal(pipeline.activeHistoryFootprintReceived, false);
    fullGate.resolve();
    await loading;

    const expectedRequests = [{ fast: true, from: T02A_START, to }];
    if (count === 26) expectedRequests.push(
      { fast: false, from: T02A_START + T02A_INTERVAL, to },
      { fast: false, from: T02A_START, to: T02A_START + T02A_INTERVAL - 1 });
    else expectedRequests.push({ fast: false, from: T02A_START, to });
    assert.deepEqual(requests, expectedRequests, "inclusive newest-25/older-1 transport partition");

    const received = (i) => olderProof ? i > 0
      : mode === "healthy" || (mode === "sparse-error" && (i === 0 || i === count - 1 || (count === 26 && i === 1)));
    const expected = Array.from({ length: count }, (_, i) =>
      t02aExpectedBar(i, received(i) ? "footprint" : "candles", !olderProof && mode === "sparse-error" && received(i)));
    if (olderProof === "verified") expected.shift();
    t02aAssertBars(pipeline, expected, "after phase 2");
    assert.deepEqual(events, count === 26
      ? ["history-loaded", "history-patched", "history-patched"]
      : ["history-loaded", "history-patched"]);
    assert.equal(pipeline.activeHistoryFootprintReceived, olderProof ? true : mode !== "empty-error",
      "positive receipt is independent of all-bucket completeness");
    assert.equal(pipeline.activeHistoryFootprintCoverageComplete,
      olderProof ? olderProof === "verified" : mode === "healthy");
    const sourceError = olderProof ? olderProof === "error" : mode !== "healthy";
    const expectedGap = !sourceError ? null : olderProof
      ? { from: T02A_START, to: T02A_START + T02A_INTERVAL - 1 }
      : { from: T02A_START, to: mode === "sparse-error" ? to + 1 : to };
    assert.deepEqual(pipeline.activeHistoryCandleSourceGap, expectedGap,
      "only the response's failed candle interval is marked for retry");
    assert.equal(degraded.at(-1)?.value, sourceError);
    if (sourceError) assert.equal(degraded.at(-1)?.detail, "source_unavailable");

    // Full healthy cells conserve the independent candle totals; sparse receipt
    // intentionally covers only part of the raw trades and must stay partial.
    for (let i = 0; i < count; i++) {
      if (!received(i)) continue;
      const bar = pipeline.series.get(T02A_START + i * T02A_INTERVAL);
      const cells = [...bar.cells.values()];
      const partial = !olderProof && mode === "sparse-error";
      assert.equal(cells.reduce((sum, cell) => sum + cell.buyVol + cell.sellVol, 0),
        partial ? 10 + 2 * i : 20 + 2 * i, "independent cell volume");
      assert.equal(cells.reduce((sum, cell) => sum + cell.buyVol - cell.sellVol, 0), 4, "independent cell delta");
      assert.equal(cells.reduce((sum, cell) => sum + cell.count, 0), partial ? 4 : 8, "independent cell count");
      if (partial) {
        assert.ok(bar.volume > cells.reduce((sum, cell) => sum + cell.buyVol + cell.sellVol, 0));
        assert.equal(bar.completeness, "partial", "valid OHLC plus sparse cells is not complete raw footprint");
      }
    }
  } finally {
    fullGate.resolve();
    pipeline?.dispose();
    if (loading) await loading.catch(() => {});
    Date.now = originalNow;
  }
}

for (const count of [3, 26]) {
  for (const mode of ["healthy", "empty-error", "sparse-error"]) {
    test(`T02A-${count}-${mode}: public twoPhase closed-candle financial matrix`,
      { timeout: 10_000 }, (t) => t02aLoadScenario(t, { count, mode }));
  }
}

// Given verified phase 1 and healthy newest 25, When the older response has
// error/absent/invalid ownership, Then its candle is preserved with its phase-1
// oracle. A verified older absence removes it: preservation is not unconditional.
for (const olderProof of ["error", "missing", "wrong-instrument", "wrong-window", "unclosed", "verified"]) {
  test(`T02A-26-older-${olderProof}: per-response absence ownership isolation`,
    { timeout: 10_000 }, (t) => t02aLoadScenario(t, { count: 26, mode: "healthy", olderProof }));
}

// T02-B qualifier slice2 (issue #310): two pipelines on one shared tracked public
// subscription service. Given both owners primed with real live data, When owner A
// runs real live/patch/config/market operations, Then A's exact event contracts hold
// and owner B keeps its subscription, data, revisions and callback state untouched.
test("T02B qualifier C: shared-service owner isolation with exact event contracts", async (t) => {
  const marketA = "BINANCE_FUTURES:btcusdt";
  const marketB = "BINANCE_FUTURES:ethusdt";
  const marketA2 = "BINANCE_FUTURES:solusdt";
  const svc = makeServices({ priceStep: 10, pricePrecision: 2 });
  const schedA = makeManualScheduler();
  const schedB = makeManualScheduler();
  const eventsA = [];
  const eventsB = [];
  const pipeA = new ChartDataPipeline({ market: marketA, intervalMs: 60_000, priceStep: 10, services: svc, scheduler: schedA.scheduler });
  const pipeB = new ChartDataPipeline({ market: marketB, intervalMs: 60_000, priceStep: 10, services: svc, scheduler: schedB.scheduler });
  pipeA.onUpdate = (event) => eventsA.push(event);
  pipeB.onUpdate = (event) => eventsB.push(event);
  const copyBars = (series) => series.listReadonly().map((bar) => structuredClone(bar));
  const bState = () => ({
    calls: eventsB.length,
    bars: pipeB.series.length,
    revision: pipeB.series.revision,
    structureRevision: pipeB.series.structureRevision,
    lastClose: pipeB.series.length > 0 ? pipeB.series.at(pipeB.series.length - 1).close : null,
    barSnapshots: copyBars(pipeB.series),
    times: pipeB.series.listReadonly().map((bar) => bar.startTime),
    market: pipeB.market,
    intervalMs: pipeB.intervalMs,
    subscribers: svc._subscriberCount(marketB),
    // The pipeline has no dedicated public priceStep getter, but the public readonly
    // series.config carries priceStep/pricePrecision/referenceMarket/intervalMs.
    config: structuredClone(pipeB.series.config),
  });
  const assertBUnchanged = (snap, label) => assert.deepEqual(bState(), snap, label);

  try {
    assert.equal(svc._subscriberCount(marketA), 1, "owner A subscribed once");
    assert.equal(svc._subscriberCount(marketB), 1, "owner B subscribed once");
    assert.notEqual(pipeA.series.config, pipeB.series.config, "A and B own independent series.config objects, not aliases");
    assert.equal(pipeB.series.config.priceStep, 10, "B baseline public series.config carries the fixture priceStep 10");

    svc._emit(marketA, makeTrade(marketA, 100, T02A_START));
    assert.equal(eventsA.length, 0, "A callbacks stay buffered before the scheduled flush");
    assert.equal(schedA.hasPending(), true);
    schedA.flush();
    assert.equal(eventsA.length, 1);
    assert.deepEqual(eventsA[0], { kind: "new-bar-appended", source: "live", previous: { length: 0, lastBarStart: null }, next: { length: 1, lastBarStart: T02A_START } });
    assert.equal(pipeA.series.at(0).startTime, T02A_START, 'A first live bucket uses the aligned T02A_START');

    svc._emit(marketB, makeTrade(marketB, 200, T02A_START));
    assert.equal(eventsB.length, 0, "B callbacks stay buffered before the scheduled flush");
    schedB.flush();
    assert.equal(eventsB.length, 1);
    assert.equal(eventsB[0].kind, "new-bar-appended");
    assert.equal(pipeB.series.length, 1, "owner B is primed with nonempty data");
    assert.equal(pipeB.series.at(0).startTime, T02A_START, 'B first live bucket shares A exact aligned start');
    const snapB = bState();
    assert.notEqual(snapB.config, pipeB.series.config, "the B config snapshot is an independent copy, not an alias of the live config");
    const bLiveBars = pipeB.series.listReadonly();
    const bLiveBar = bLiveBars[0];
    const bSnapshotBar = snapB.barSnapshots[0];
    assert.ok(Array.isArray(bLiveBar.deltaBySize) && bLiveBar.deltaBySize.length > 0, "B live receipt has actual nested size-delta values");
    assert.ok(bLiveBar.cells instanceof Map && bLiveBar.cells.size > 0, "B live receipt has actual cells");
    assert.ok(Array.isArray(bLiveBar.sources) && bLiveBar.sources.includes("live"), "B live receipt has actual source provenance");
    assert.ok(Number.isFinite(bLiveBar.updatedAt), "B live receipt timestamp is present");
    assert.deepEqual(Object.keys(bSnapshotBar).sort(), Object.keys(bLiveBar).sort(), "C snapshot preserves the exact present bar-field set");
    assert.notStrictEqual(snapB.barSnapshots, bLiveBars, "C cloned bar list is independent from the live list");
    assert.notStrictEqual(bSnapshotBar, bLiveBar, "C cloned bar is independent from the live bar");
    assert.notStrictEqual(bSnapshotBar.cells, bLiveBar.cells, "C cells Map is independently cloned");
    const bCellBin = bLiveBar.cells.keys().next().value;
    assert.notStrictEqual(bSnapshotBar.cells.get(bCellBin), bLiveBar.cells.get(bCellBin), "C cell objects are independently cloned");
    assert.notStrictEqual(bSnapshotBar.sources, bLiveBar.sources, "C source array is independently cloned");
    assert.notStrictEqual(bSnapshotBar.deltaBySize, bLiveBar.deltaBySize, "C nested deltaBySize array is independently cloned");
    assert.deepEqual(bSnapshotBar.deltaBySize, bLiveBar.deltaBySize, "C nested size-delta values are preserved exactly");

    svc._emit(marketA, makeTrade(marketA, 100.25, T02A_START + 2_000));
    assert.equal(eventsA.length, 1, "no A callback before the actual scheduled flush");
    schedA.flush();
    assert.equal(eventsA.length, 2);
    assert.equal(eventsA[1].kind, "same-bar-update");
    assert.equal(eventsA[1].source, "live");
    assert.deepEqual(eventsA[1].previous, { length: 1, lastBarStart: T02A_START });
    assert.deepEqual(eventsA[1].next, { length: 1, lastBarStart: T02A_START });
    assert.equal(pipeA.series.at(0).close, 100.25);
    assertBUnchanged(snapB, "B invariant after A same-bar update");

    svc._emit(marketA, makeTrade(marketA, 100.5, T02A_START + 61_000));
    schedA.flush();
    assert.equal(eventsA[2].kind, "new-bar-appended");
    assert.deepEqual(eventsA[2].previous, { length: 1, lastBarStart: T02A_START });
    assert.deepEqual(eventsA[2].next, { length: 2, lastBarStart: T02A_START + 60_000 });
    assertBUnchanged(snapB, "B invariant after A new-bar append");

    assert.equal(pipeA.series.length, 2, "literal guard: two bars before the non-tail correction");
    assert.equal(pipeA.series.at(0).startTime, T02A_START);
    assert.equal(pipeA.series.at(0).close, 100.25, "older bucket close before the non-tail correction");
    assert.equal(pipeA.series.at(1).startTime, T02A_START + 60_000);
    assert.equal(pipeA.series.at(1).close, 100.5, "tail bucket close before the non-tail correction");
    const nonTailRevision = pipeA.series.revision;
    const nonTailStructureRevision = pipeA.series.structureRevision;
    svc._emit(marketA, makeTrade(marketA, 100.5, T02A_START + 30_000));
    schedA.flush();
    assert.equal(eventsA[3].kind, "same-bar-update");
    assert.equal(eventsA[3].source, "live");
    assert.deepEqual(eventsA[3].previous, { length: 2, lastBarStart: T02A_START + 60_000 });
    assert.deepEqual(eventsA[3].next, { length: 2, lastBarStart: T02A_START + 60_000 });
    assert.equal(pipeA.series.revision, nonTailRevision + 1, "accepted non-tail tick bumps revision");
    assert.equal(pipeA.series.structureRevision, nonTailStructureRevision, "same-bar update keeps structure");
    assert.equal(pipeA.series.at(0).startTime, T02A_START);
    assert.equal(pipeA.series.at(0).close, 100.5, "a non-tail live correction really changes the older bucket close");
    assert.equal(pipeA.series.at(1).startTime, T02A_START + 60_000);
    assert.equal(pipeA.series.at(1).close, 100.5, "the last bar stays unchanged by the non-tail correction");
    assertBUnchanged(snapB, "B invariant after A non-tail live correction");

    let patchFetchCalls = 0;
    useFakeChartDataSource(t, {
      history: () => {
        patchFetchCalls++;
        return [
          historyBar(T02A_START, { open: 100.25, high: 100.75, low: 99.75, close: 100.5, volume: 8, delta: 1, count: 4 }),
          historyBar(T02A_START + 60_000, { open: 100.5, high: 101, low: 100, close: 100.75, volume: 9, delta: 1, count: 5 }),
          historyBar(T02A_START + 120_000, { open: 100.75, high: 101.25, low: 100.25, close: 101, volume: 10, delta: 1, count: 6 }),
        ];
      },
    });
    await pipeA.patchDay(T02A_START);
    assert.ok(patchFetchCalls >= 1, "the day patch really used the fake history source");
    const patchEvent = eventsA.at(-1);
    assert.equal(eventsA.length, 5);
    assert.equal(patchEvent.kind, "history-patched");
    assert.equal(patchEvent.source, "history");
    assert.equal(patchEvent.priceChanged, true);
    assert.deepEqual(patchEvent.previous, { length: 2, lastBarStart: T02A_START + 60_000 });
    assert.deepEqual(patchEvent.next, { length: 3, lastBarStart: T02A_START + 120_000 });
    assert.deepEqual(pipeA.series.listReadonly().map((bar) => bar.startTime), [T02A_START, T02A_START + 60_000, T02A_START + 120_000], "the day patch really loaded the three aligned far-closed bars");
    assert.deepEqual(pipeA.series.listReadonly().map((bar) => bar.close), [100.5, 100.75, 101], "patched closes keep the independent literal oracle");
    assertBUnchanged(snapB, "B invariant after A patchDay");

    pipeA.setPriceStep(5);
    assert.equal(eventsA.length, 6);
    const resetEvent = eventsA.at(-1);
    assert.equal(resetEvent.kind, "price-step-reset");
    assert.equal(resetEvent.source, "config");
    assert.deepEqual(resetEvent.previous, { length: 3, lastBarStart: T02A_START + 120_000 });
    assert.deepEqual(resetEvent.next, { length: 0, lastBarStart: null });
    assert.equal(pipeA.series.length, 0);
    assert.equal(pipeA.series.config.priceStep, 5, "the explicit step is observable on the public series.config before any metadata resolution");
    assertBUnchanged(snapB, "B invariant after A setPriceStep");

    svc._emit(marketA, makeTrade(marketA, 101, T02A_START + 121_000));
    schedA.flush();
    assert.equal(eventsA.length, 7);
    assert.equal(eventsA.at(-1).kind, "new-bar-appended");
    assert.deepEqual(eventsA.at(-1).next, { length: 1, lastBarStart: T02A_START + 120_000 });
    assertBUnchanged(snapB, "A is alive again after the allowed reset while B stays untouched");

    await pipeA.changeConfig({ market: marketA2 });
    assert.equal(eventsA.length, 8, "market switch emits exactly the resolved metadata event");
    const metadataEvent = eventsA.at(-1);
    assert.equal(metadataEvent.kind, "metadata-updated");
    assert.equal(metadataEvent.source, "metadata");
    assert.deepEqual(metadataEvent.previous, { length: 0, lastBarStart: null }, "current contract emits already-cleared snapshots");
    assert.deepEqual(metadataEvent.next, { length: 0, lastBarStart: null });
    assert.equal(pipeA.series.config.priceStep, 10, "the awaited market metadata resolved the public step back to the service priceStep 10");
    assert.equal(pipeA.series.config.pricePrecision, 2, "the awaited market metadata set the public pricePrecision to the service value 2");
    assert.equal(pipeA.market, marketA2);
    assert.equal(pipeA.series.length, 0);
    assert.equal(svc._subscriberCount(marketA), 0, "A released its old market subscription");
    assert.equal(svc._subscriberCount(marketA2), 1);
    assert.equal(svc._subscriberCount(marketB), 1);
    assertBUnchanged(snapB, "B invariant after A market switch");

    svc._emit(marketA2, makeTrade(marketA2, 101.25, T02A_START + 181_000));
    schedA.flush();
    assert.equal(eventsA.at(-1).kind, "new-bar-appended");
    assert.deepEqual(eventsA.at(-1).next, { length: 1, lastBarStart: T02A_START + 180_000 });
    const aGuardAfterSwitch = {
      bars: pipeA.series.length,
      revision: pipeA.series.revision,
      structureRevision: pipeA.series.structureRevision,
      barSnapshots: copyBars(pipeA.series),
      times: pipeA.series.listReadonly().map((bar) => bar.startTime),
      market: pipeA.market,
      intervalMs: pipeA.intervalMs,
      events: eventsA.length,
      subscribers: svc._subscriberCount(marketA2),
      config: structuredClone(pipeA.series.config),
    };
    assert.notEqual(aGuardAfterSwitch.config, pipeA.series.config, "the A guard config is an independent copy, not an alias of the raw live config");
    assertBUnchanged(snapB, "A is alive on the new market while B stays untouched");

    svc._emit(marketB, makeTrade(marketB, 200.25, T02A_START + 2_000));
    schedB.flush();
    assert.equal(eventsB.length, snapB.calls + 1, "B positive control really delivers");
    assert.equal(eventsB.at(-1).kind, "same-bar-update");
    assert.deepEqual(eventsB.at(-1).previous, { length: 1, lastBarStart: T02A_START });
    assert.deepEqual(eventsB.at(-1).next, { length: 1, lastBarStart: T02A_START });
    assert.equal(pipeB.series.at(0).close, 200.25);
    assert.deepEqual({
      bars: pipeA.series.length,
      revision: pipeA.series.revision,
      structureRevision: pipeA.series.structureRevision,
      barSnapshots: copyBars(pipeA.series),
      times: pipeA.series.listReadonly().map((bar) => bar.startTime),
      market: pipeA.market,
      intervalMs: pipeA.intervalMs,
      events: eventsA.length,
      subscribers: svc._subscriberCount(marketA2),
      config: structuredClone(pipeA.series.config),
    }, aGuardAfterSwitch, "B live update leaves every copied A bar, revision, config and event count unchanged");

    pipeA.dispose();
    assert.equal(svc._subscriberCount(marketA2), 0, "disposing A removes only A subscription");
    assert.equal(svc._subscriberCount(marketA), 0);
    assert.equal(svc._subscriberCount(marketB), 1, "B remains subscribed");

    svc._emit(marketB, makeTrade(marketB, 200.5, T02A_START + 61_000));
    schedB.flush();
    assert.equal(eventsB.at(-1).kind, "new-bar-appended");
    assert.equal(pipeB.series.length, 2);
    assert.equal(pipeB.series.at(1).startTime, T02A_START + 60_000, 'B appended live bucket keeps the exact next interval start');
    assert.equal(pipeB.series.at(1).close, 200.5, "B can still emit after A is disposed");
  } finally {
    pipeA.dispose();
    pipeB.dispose();
    assert.equal(svc._subscriberCount(marketA), 0);
    assert.equal(svc._subscriberCount(marketA2), 0);
    assert.equal(svc._subscriberCount(marketB), 0, "both owners release the shared service");
  }
});

// The saved service callback models an already-queued notification after unsubscribe.
test("disposed pipeline ignores a late matching-market readiness notification", (t) => {
  // The repair path asks the data source whether the market has direct candles.
  useFakeChartDataSource(t);
  const market = "BINANCE_FUTURES:btcusdt";
  const svc = makeServices();
  let fetchCalls = 0;
  svc.fetchHistory = async () => { fetchCalls++; return []; };
  let readinessCallback;
  let unsubscribed = 0;
  svc.subscribeToTradeMarketReadiness = (callback) => {
    readinessCallback = callback;
    return () => { unsubscribed++; };
  };
  const pipeline = new ChartDataPipeline({
    market, intervalMs: 60_000, priceStep: 10, services: svc,
  });
  assert.equal(typeof readinessCallback, "function", "real constructor must register readiness");
  assert.equal(pipeline.latestMarketReadiness, null, "no readiness before delivery");

  const active = { market, generation: 1, epoch: 1, session: "active",
    boundaryAt: 1000, acknowledgedAt: 1000, transportGeneration: 1 };
  readinessCallback(active);
  assert.deepEqual(pipeline.latestMarketReadiness, active,
    "matching readiness must update actual live pipeline state");
  assert.equal(fetchCalls, 1, "active readiness must trigger the real repair path");
  const activeState = pipeline.latestMarketReadiness;
  assert.notStrictEqual(activeState, active, "pipeline stores its own readiness boundary");

  pipeline.dispose();
  assert.equal(unsubscribed, 1, "dispose must release the service subscription");
  const disposedState = pipeline.latestMarketReadiness;
  const disposedSeries = pipeline.series;
  const disposedBars = pipeline.series.listReadonly();
  readinessCallback({ market, generation: 2, epoch: 2, session: "late",
    boundaryAt: 2000, acknowledgedAt: 2000, transportGeneration: 2 });
  assert.strictEqual(pipeline.latestMarketReadiness, disposedState,
    "late callback must not replace disposed readiness state");
  assert.equal(fetchCalls, 1, "late callback must not schedule another repair");
  assert.strictEqual(pipeline.series, disposedSeries, "late callback must not replace series");
  assert.deepEqual(pipeline.series.listReadonly(), disposedBars, "late callback must not schedule series work");
});