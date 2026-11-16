import test from "node:test";
import assert from "node:assert/strict";
import {
  ChartDataPipeline,
  PRICE_STEP_RESOLVE_TIMEOUT_MS,
  SELECTION_PRICE_STEP_RETRY_DELAYS_MS,
} from "../dist/features/chart/ChartDataPipeline.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const MARKET = "BINANCE_FUTURES:btcusdt";
const INTERVAL = 60_000;
const BASE_TIME = Date.UTC(2026, 4, 1, 12, 0, 0);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeManualScheduler({ throttled = false } = {}) {
  let nextHandle = 1;
  let pending = null;
  let cancelled = 0;
  let isHidden = throttled;
  return {
    scheduler: {
      request(cb) {
        pending = cb;
        return nextHandle++;
      },
      cancel() {
        cancelled++;
        pending = null;
      },
      isThrottled: () => isHidden,
    },
    setThrottled(next) {
      isHidden = next;
    },
    flush() {
      const cb = pending;
      pending = null;
      cb?.();
    },
    hasPending() {
      return pending !== null;
    },
    cancelCount() {
      return cancelled;
    },
  };
}

function makeTrade(time, price, id, extra = {}) {
  return {
    id,
    time,
    price,
    qty: 1,
    isBuy: true,
    liquidation: false,
    market: MARKET,
    source: "live",
    receivedAt: time,
    ...extra,
  };
}

function makeServices({
  priceStep = 10,
  fetchPriceStepResult,
  fetchHistory,
} = {}) {
  const subscribers = new Map();
  const integrityLog = [];
  let sessionCb = null;
  let readinessCb = null;
  return {
    services: {
      subscribeToTrades(market, cb) {
        if (!subscribers.has(market)) subscribers.set(market, new Set());
        subscribers.get(market).add(cb);
        return () => subscribers.get(market)?.delete(cb);
      },
      subscribeToTradeSessions(cb) {
        sessionCb = cb;
        return () => { sessionCb = null; };
      },
      subscribeToTradeMarketReadiness(cb) {
        readinessCb = cb;
        return () => { readinessCb = null; };
      },
      fetchPriceStep: async () => priceStep,
      ...(fetchPriceStepResult ? { fetchPriceStepResult } : {}),
      fetchPricePrecision: async () => 2,
      ...(fetchHistory ? { fetchHistory } : {}),
      triggerAutoSync: () => {},
      acquirePipelineIntegrityReporter: () => ({
        report: (state, detail) => integrityLog.push({ state, detail: detail ?? "" }),
        dispose: () => {},
      }),
    },
    emit(market, trade) {
      for (const cb of subscribers.get(market) ?? []) cb(trade);
    },
    subscriberCount(market) {
      return subscribers.get(market)?.size ?? 0;
    },
    emitSession(session) {
      sessionCb?.(session);
    },
    emitReadiness(readiness) {
      readinessCb?.(readiness);
    },
    integrityLog,
  };
}

test("characterization: public API surface, constants, and callback order across twoPhase history + bar close", async (t) => {
  assert.equal(PRICE_STEP_RESOLVE_TIMEOUT_MS, 6000);
  assert.deepEqual(SELECTION_PRICE_STEP_RETRY_DELAYS_MS, [5_000, 15_000, 30_000]);

  const fastBar = historyBar(BASE_TIME - 2 * INTERVAL, {
    open: 100, high: 105, low: 95, close: 102, volume: 5, delta: 2, count: 3,
  });
  const fpBar = historyBar(BASE_TIME - 2 * INTERVAL, {
    open: 100, high: 105, low: 95, close: 102, volume: 5, delta: 2, count: 3,
    cells: [{ priceBin: 100, buyVol: 3, sellVol: 2, count: 3, buyCount: 2, sellCount: 1, liquidationBuyVol: 0, liquidationSellVol: 0 }],
  });

  useFakeChartDataSource(t, {
    history: (q) => {
      const requestedFrom = BASE_TIME - 2 * INTERVAL;
      const requestedTo = BASE_TIME - INTERVAL - 1;
      const meta = {
        schemaVersion: 1,
        generatedAt: BASE_TIME,
        candleCoverage: {
          schemaVersion: 1,
          source: "binance-klines",
          instrument: MARKET,
          ownership: "snapshot",
          status: "verified",
          requestedFrom: q.from,
          requestedTo: q.to,
          closedThrough: BASE_TIME - 1,
          snapshotAt: BASE_TIME,
        },
        footprint: { available: true, allowed: true, priceStep: 10 },
        footprintCoverage: {
          schemaVersion: 1,
          source: "binance-usdm-aggTrade",
          instrument: MARKET,
          interval: INTERVAL,
          authority: "provisional",
          authorityToken: "tok-1",
          status: "verified",
          requestedFrom: q.from,
          requestedTo: q.to,
          coveredFrom: q.from,
          coveredThrough: q.to,
          reasonCode: null,
          projectionThroughId: "10",
        },
      };
      return { bars: [q.includeFootprint === false ? fastBar : fpBar], meta };
    },
  });

  const { services, emit } = makeServices();
  const sched = makeManualScheduler();
  const callLog = [];
  const closedBars = [];
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: INTERVAL,
    priceStep: 10,
    services,
    scheduler: sched.scheduler,
  });
  pipeline.onBeforeUpdate = (kind) => callLog.push(`before:${kind}`);
  pipeline.onUpdate = (ev) => callLog.push(`update:${ev.kind}:${ev.source}`);
  pipeline.onHistoryCandlesReady = () => callLog.push("candlesReady");
  pipeline.onBarClose = (closed) => {
    closedBars.push(closed.startTime);
    callLog.push(`barClose:${closed.startTime}`);
  };

  try {
    await pipeline.loadHistory({
      from: BASE_TIME - 2 * INTERVAL,
      to: BASE_TIME - 1,
      twoPhase: true,
    });

    assert.deepEqual(callLog, [
      "update:history-loaded:history",
      "candlesReady",
      "before:history-patched",
      "update:history-patched:history",
    ]);
    assert.equal(pipeline.activeHistoryFootprintReceived, true);
    assert.equal(pipeline.activeHistoryFootprintCoverageComplete, true);
    assert.equal(pipeline.series.get(BASE_TIME - 2 * INTERVAL)?.cells.get(100)?.buyVol, 3);

    const openTime = Date.now() + 10 * INTERVAL;
    const liveBucket0 = Math.floor(openTime / INTERVAL) * INTERVAL;
    const liveBucket1 = liveBucket0 + INTERVAL;
    emit(MARKET, makeTrade(liveBucket0 + 1000, 110, "101"));
    sched.flush();
    emit(MARKET, makeTrade(liveBucket1 + 1000, 120, "102"));
    sched.flush();

    assert.deepEqual(closedBars, [liveBucket0]);
    assert.equal(pipeline.dataStateInputs().lastTradeTime, liveBucket1 + 1000);
  } finally {
    pipeline.dispose();
  }
});

test("characterization: explicit history watermark barrier replays only id > watermark once", async (t) => {
  const closedFrom = BASE_TIME - 3 * INTERVAL;
  const closedEnd = BASE_TIME - INTERVAL - 1;

  useFakeChartDataSource(t, {
    history: (q) => ({
      bars: [historyBar(closedFrom, {
        open: 100, high: 105, low: 95, close: 101, volume: 4, delta: 2, count: 2,
      })],
      meta: {
        schemaVersion: 1,
        generatedAt: BASE_TIME,
        candleCoverage: {
          schemaVersion: 1,
          source: "binance-klines",
          instrument: MARKET,
          ownership: "snapshot",
          status: "verified",
          requestedFrom: q.from,
          requestedTo: q.to,
          closedThrough: closedEnd,
          snapshotAt: BASE_TIME,
        },
        footprintCoverage: {
          schemaVersion: 1,
          source: "binance-usdm-aggTrade",
          instrument: MARKET,
          interval: INTERVAL,
          authority: "provisional",
          authorityToken: "t1",
          status: "verified",
          requestedFrom: q.from,
          requestedTo: q.to,
          coveredFrom: q.from,
          coveredThrough: q.to,
          reasonCode: null,
          projectionThroughId: "50",
        },
      },
    }),
  });

  const { services, emit } = makeServices();
  const sched = makeManualScheduler();
  const pipeClean = new ChartDataPipeline({
    market: MARKET,
    intervalMs: INTERVAL,
    priceStep: 10,
    services,
    scheduler: sched.scheduler,
  });

  try {
    // Queue live trades before loadHistory so explicitHistoryReconcile defers and reconciles against watermark "50".
    emit(MARKET, makeTrade(closedFrom + 1000, 100, "50"));
    emit(MARKET, makeTrade(closedFrom + 2000, 100, "51"));
    await pipeClean.loadHistory({ from: closedFrom, to: closedEnd });
    const bar = pipeClean.series.get(closedFrom);
    assert.equal(bar?.cells.get(100)?.buyVol, 1, "only id 51 > watermark 50 replays footprint cells");
    assert.equal(bar?.cells.get(100)?.count, 1);
    assert.equal(pipeClean.pendingTrades.length, 0);
  } finally {
    pipeClean.dispose();
  }
});

test("characterization: explicit history regressed watermark reports HISTORY_SNAPSHOT_WATERMARK_REGRESSION and aborts load", async (t) => {
  const bucket = BASE_TIME - 2 * INTERVAL;
  let calls = 0;

  useFakeChartDataSource(t, {
    history: (q) => {
      calls++;
      const highWatermark = calls === 1;
      return {
        bars: [historyBar(bucket, {
          open: 200, high: 205, low: 195, close: 202, volume: 10, delta: 4, count: 5,
        })],
        meta: {
          schemaVersion: 1,
          generatedAt: BASE_TIME,
          candleCoverage: {
            schemaVersion: 1,
            source: "binance-klines",
            instrument: MARKET,
            ownership: "snapshot",
            status: "verified",
            requestedFrom: q.from,
            requestedTo: q.to,
            closedThrough: BASE_TIME,
            snapshotAt: BASE_TIME,
          },
          footprintCoverage: {
            schemaVersion: 1,
            source: "binance-usdm-aggTrade",
            instrument: MARKET,
            interval: INTERVAL,
            authority: "provisional",
            authorityToken: "tok",
            status: "verified",
            requestedFrom: q.from,
            requestedTo: q.to,
            coveredFrom: q.from,
            coveredThrough: q.to,
            reasonCode: null,
            projectionThroughId: highWatermark ? "90" : "80",
          },
        },
      };
    },
  });

  const { services, emit, integrityLog } = makeServices();
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: INTERVAL,
    priceStep: 10,
    services,
    scheduler: sched.scheduler,
  });

  try {
    // Keep trade id "90" queued so Phase 1 watermark "90" records retiredWatermarks[bucket] = 90n;
    // Phase 2 then arrives on the same bucket with regressed watermark "80" and must abort cleanly.
    emit(MARKET, makeTrade(bucket + 1000, 200, "90"));
    await pipeline.loadHistory({
      from: bucket,
      to: bucket + INTERVAL - 1,
      twoPhase: true,
    });
    assert.ok(
      integrityLog.some((e) => e.state === "pending" && e.detail === "HISTORY_SNAPSHOT_WATERMARK_REGRESSION"),
      "regressed watermark on retired bucket must abort and report regression",
    );
  } finally {
    pipeline.dispose();
  }
});

test("characterization: hidden-tab throttled drain empties burst safely and trade identity conflict holds until reset", () => {
  const { services, emit, integrityLog } = makeServices();
  const sched = makeManualScheduler({ throttled: true });
  const degradedEvents = [];
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: INTERVAL,
    priceStep: 10,
    services,
    scheduler: sched.scheduler,
    onDataDegraded: (degraded, detail) => degradedEvents.push({ degraded, detail }),
  });

  try {
    // 1,001 trades while throttled must drain inline without data loss or overflow drop
    for (let i = 1; i <= 1_005; i++) {
      emit(MARKET, makeTrade(BASE_TIME + i, 50000, String(i)));
    }
    assert.equal(pipeline.dataStateInputs().liveTradesDropped, false);
    assert.ok(pipeline.pendingTrades.length <= 1_000, "throttled drain keeps queue bounded");
    while (pipeline.pendingTrades.length > 0 && sched.hasPending()) sched.flush();
    assert.equal(pipeline.pendingTrades.length, 0);

    // Same ID with identical payload is deduped cleanly; differing payload locks identityConflict until priceStep reset
    const beforeQty = pipeline.series.get(bucketOf(BASE_TIME + 1))?.volume;
    emit(MARKET, makeTrade(BASE_TIME + 1, 50000, "1"));
    sched.flush();
    assert.equal(pipeline.series.get(bucketOf(BASE_TIME + 1))?.volume, beforeQty, "identical ID dedupes");
    assert.equal(pipeline.dataStateInputs().integrity, "healthy");

    emit(MARKET, makeTrade(BASE_TIME + 1, 50500, "1"));
    sched.flush();
    assert.equal(pipeline.dataStateInputs().integrity, "error");
    assert.ok(integrityLog.some((e) => e.state === "error" && e.detail.includes("TRADE_IDENTITY_CONFLICT")));
    assert.ok(degradedEvents.some((e) => e.degraded === true && e.detail.includes("TRADE_IDENTITY_CONFLICT")));

    // New trades do not clear a held conflict until setPriceStep bumps series.resetEpoch
    emit(MARKET, makeTrade(BASE_TIME + 2000, 50000, "2000"));
    sched.flush();
    assert.equal(pipeline.dataStateInputs().integrity, "error");

    pipeline.setPriceStep(20);
    assert.equal(pipeline.dataStateInputs().integrity, "healthy");
  } finally {
    pipeline.dispose();
  }
});

test("characterization: reentrancy inside onBeforeUpdate voids mutation cleanly and recentCoverageRepair guards generation", async (t) => {
  const from = BASE_TIME - INTERVAL;
  const to = BASE_TIME + INTERVAL;
  const gate = deferred();
  useFakeChartDataSource(t, {
    history: async (q) => {
      await gate.promise;
      return {
        bars: [historyBar(from, {
          open: 100, high: 110, low: 90, close: 105, volume: 10, delta: 2, count: 4,
          cells: [{ priceBin: 100, buyVol: 6, sellVol: 4, count: 4, buyCount: 2, sellCount: 2, liquidationBuyVol: 0, liquidationSellVol: 0 }],
        })],
        meta: {
          schemaVersion: 1,
          generatedAt: to,
          footprintCoverage: {
            schemaVersion: 1,
            source: "binance-usdm-aggTrade",
            instrument: MARKET,
            interval: INTERVAL,
            authority: "provisional",
            authorityToken: "tok-rep",
            status: "complete",
            requestedFrom: q.from,
            requestedTo: q.to,
            coveredFrom: from,
            coveredThrough: to - 1,
            reasonCode: null,
            projectionThroughId: "100",
          },
        },
      };
    },
  });

  const { services, emit } = makeServices();
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: INTERVAL,
    priceStep: 10,
    services,
    scheduler: sched.scheduler,
  });

  try {
    const repairPromise = pipeline.repairRecentFootprintCoverage(from, to);
    // Cancel / changeConfig mid-repair invalidates active repair generation cleanly
    emit(MARKET, makeTrade(to + 100, 100, "200"));
    await pipeline.changeConfig({ intervalMs: 5 * INTERVAL });
    gate.resolve();
    const outcome = await repairPromise;
    assert.equal(outcome, "stop");
    assert.equal(pipeline.dataStateInputs().recentFootprintRepairActive, false);

    // Reentrancy: onBeforeUpdate mutating config cancels planned snapshot before series change
    const pipe2 = new ChartDataPipeline({
      market: MARKET,
      intervalMs: INTERVAL,
      priceStep: 10,
      services,
      scheduler: sched.scheduler,
    });
    try {
      let updates = 0;
      pipe2.onBeforeUpdate = (kind) => {
        if (kind === "history-patched") pipe2.dispose();
      };
      pipe2.onUpdate = () => { updates++; };
      const applied = pipe2.applyLiveBarSeed(
        [historyBar(bucketOf(Date.now()), { open: 10, high: 11, low: 9, close: 10, volume: 1 })],
        { market: MARKET, intervalMs: INTERVAL, from: 0, observedAt: Date.now() },
      );
      assert.deepEqual(applied, []);
      assert.equal(updates, 0);
      assert.equal(pipe2.series.length, 0);
    } finally {
      pipe2.dispose();
    }
  } finally {
    pipeline.dispose();
  }
});

test("characterization: async price-step retry resolves via callback, respects dispose abort, and blocks timeframe race", async () => {
  let stepAttempts = 0;
  const firstLookup = deferred();
  const adoptedSteps = [];
  const { services } = makeServices({
    priceStep: 10,
    fetchPriceStepResult: async () => {
      stepAttempts++;
      if (stepAttempts === 1) return firstLookup.promise;
      return { step: 25, resolved: true };
    },
  });
  const sched = makeManualScheduler();
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:ethusdt",
    intervalMs: INTERVAL,
    priceStep: 10,
    services,
    scheduler: sched.scheduler,
    priceStepResolveTimeoutMs: 5,
    priceStepRetryDelaysMs: [1, 1],
    onServerPriceStep: async (step) => {
      adoptedSteps.push(step);
    },
  });

  try {
    const switchPromise = pipeline.changeConfig({ market: MARKET });
    // Timeframe race while market switch metadata is pending waits cleanly without adopting old step
    const tfRace = pipeline.changeConfig({ intervalMs: 5 * INTERVAL });
    firstLookup.resolve({ step: 10, resolved: false });
    await Promise.all([switchPromise, tfRace]);
    const corrected = await pipeline.pendingStepCorrection;
    assert.equal(corrected, 25);
    assert.deepEqual(adoptedSteps, [25]);
    assert.equal(pipeline.intervalMs, 5 * INTERVAL);
    assert.equal(pipeline.series.config.intervalMs, 5 * INTERVAL);
  } finally {
    pipeline.dispose();
  }

  // Dispose during a long retry delay aborts cleanly without waiting on wall-clock timer
  const slowLookup = deferred();
  const { services: slowServices } = makeServices({
    priceStep: 10,
    fetchPriceStepResult: async () => slowLookup.promise,
  });
  const pipeDispose = new ChartDataPipeline({
    market: "BINANCE_FUTURES:ethusdt",
    intervalMs: INTERVAL,
    priceStep: 10,
    services: slowServices,
    scheduler: makeManualScheduler().scheduler,
    priceStepResolveTimeoutMs: 2,
    priceStepRetryDelaysMs: [60_000],
  });
  try {
    const p = pipeDispose.changeConfig({ market: MARKET });
    await p;
    slowLookup.resolve({ step: 10, resolved: false });
    pipeDispose.dispose();
    const res = await pipeDispose.pendingStepCorrection;
    assert.equal(res, null);
  } finally {
    pipeDispose.dispose();
  }
});

function bucketOf(ts) {
  return Math.floor(ts / INTERVAL) * INTERVAL;
}
