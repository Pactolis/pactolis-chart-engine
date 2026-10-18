import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { registerRecentCoverageRetryScheduler } from "../dist/features/chart/recentCoverageRetryBridge.js";
import { evaluateChartDataState } from "../dist/features/chart/chartDataState.js";
import { bucketStart } from "../dist/core/time.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

// #315 (T04-B): a live repair whose source stays unavailable keeps retrying at the
// ladder's pace, but after its fast ladder (4 min) the chart reads as failed, not
// "repairing", until a repair succeeds.

const START = Date.UTC(2026, 0, 1);
const INTERVAL = 60_000;
const MARKET = "BINANCE_FUTURES:btcusdt";

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
}

function repairBar(start, volume, close = 100) {
  return {
    startTime: start, open: 100, high: close, low: 100, close,
    volume, delta: volume, count: volume,
    cells: new Map([[100, { priceBin: 100, buyVol: volume, sellVol: 0, count: volume, buyCount: volume, sellCount: 0 }]]),
    hasRef: true, completeness: "complete", sources: ["history"],
  };
}

function snapshot(q, watermark, throughTime = START + 1000 + watermark) {
  const prefix = {
    authority: "provisional", authorityToken: "snapshot-" + watermark,
    requestedFrom: q.from, requestedTo: q.to,
    coveredFrom: q.from, coveredThrough: Math.min(q.to, throughTime),
  };
  return {
    footprint: { allowed: true, available: true },
    repairSnapshot: {
      schemaVersion: 2, mode: "trade-id-v1", source: "binance-usdm-aggTrade",
      instrument: MARKET, interval: q.interval, priceStep: q.priceStep,
      ...prefix, watermark: String(watermark),
      bucketFrom: bucketStart(q.from, q.interval), bucketThrough: bucketStart(q.to, q.interval),
      coverageProof: {
        kind: "resolver-watermark-contiguous-v2", ...prefix,
        projectionThroughId: String(watermark), watermarkComplete: true,
      },
    },
  };
}

function fixture(fetchHistory) {
  let trade, session, scheduled = null, handle = 0;
  const reports = [];
  const degraded = [];
  const pipeline = new ChartDataPipeline({
    market: MARKET, intervalMs: INTERVAL, priceStep: 1,
    services: {
      subscribeToTrades(_market, cb) { trade = cb; return () => {}; },
      subscribeToTradeSessions(cb) { session = cb; return () => {}; },
      fetchHistory,
      fetchPriceStep: async () => 1, fetchPricePrecision: async () => undefined,
      acquirePipelineIntegrityReporter() {
        return { report(state, detail) { reports.push({ state, detail }); }, dispose() {} };
      },
    },
    scheduler: {
      request(cb) { scheduled = cb; return ++handle; },
      cancel() { scheduled = null; },
    },
    onDataDegraded(value, detail) { degraded.push({ value, detail }); },
  });
  return {
    pipeline, reports, degraded,
    session() { session({ generation: 1, epoch: 1, session: "s1", boundaryAt: START + 1000 }); },
    emit(id, price = 100) { trade({ id: String(id), market: MARKET, time: START + 1000 + id, price, qty: 1, isBuy: true }); },
    drain() {
      let turns = 0;
      while (scheduled) {
        const cb = scheduled; scheduled = null; cb();
        assert.ok(++turns < 2000, "queue must make bounded progress");
      }
    },
  };
}


function ohlcOf(pipeline) {
  return evaluateChartDataState({
    ...pipeline.dataStateInputs(), historyStatus: "settled", footprintSupported: true, transportOffline: false,
  }, Date.now()).ohlc;
}

test("an unresolved live repair turns from repairing to failed after 4 min, keeps retrying, and recovers on success", async (t) => {
  useFakeChartDataSource(t);
  mock.timers.enable({ apis: ["Date"], now: START + 10_000 });
  let sourceUp = false;
  let calls = 0;
  const retry = [];
  const f = fixture(async (q) => {
    calls++;
    if (!sourceUp) {
      q.onMeta?.({ degraded: true, footprint: { allowed: true, available: false }, provenance: [{ error: "footprint query registry full" }] });
      return [];
    }
    q.onMeta?.(snapshot(q, 3));
    return [repairBar(q.from, 3)];
  });
  const release = registerRecentCoverageRetryScheduler(f.pipeline.series, (attempt, run, reason) => retry.push({ attempt, run, reason }));
  try {
    f.session();
    f.emit(3);
    await settle();
    assert.equal(f.reports.at(-1).state, "pending");
    assert.equal(ohlcOf(f.pipeline).reason, "LIVE_REPAIR_PENDING");

    // Each retry a minute later, as the ladder's steady pace would run it.
    for (let minute = 1; minute <= 3; minute++) {
      mock.timers.tick(60_000);
      assert.equal(retry.at(-1).run(), true);
      await settle();
      assert.equal(f.reports.at(-1).state, "pending", `minute ${minute}: still repairing`);
    }
    assert.equal(f.degraded.some((entry) => entry.value), false);

    mock.timers.tick(60_000);
    assert.equal(retry.at(-1).run(), true);
    await settle();
    assert.equal(f.reports.at(-1).state, "error", "past the fast ladder the repair reads as failed");
    assert.match(f.reports.at(-1).detail, /^LIVE_REPAIR_UNRESOLVED: /);
    assert.equal(f.degraded.at(-1).value, true);
    const ohlc = ohlcOf(f.pipeline);
    assert.equal(ohlc.state, "error");
    assert.equal(ohlc.reason, "LIVE_REPAIR_FAILED");

    const retriesBefore = retry.length;
    mock.timers.tick(60_000);
    assert.equal(retry.at(-1).run(), true);
    await settle();
    assert.equal(retry.length, retriesBefore + 1, "retries continue after the status turns to failed");
    assert.equal(f.reports.at(-1).state, "error");

    sourceUp = true;
    mock.timers.tick(60_000);
    assert.equal(retry.at(-1).run(), true);
    await settle();
    f.drain();
    assert.equal(f.pipeline.liveBootstrapReconciled, true);
    assert.equal(f.reports.at(-1).state, "healthy");
    assert.equal(f.degraded.at(-1).value, false);
    assert.equal(ohlcOf(f.pipeline).state, "ok");
    assert.equal(calls, 7);
  } finally {
    release();
    f.pipeline.dispose();
    mock.timers.reset();
  }
});

test("a reconnect starts the failed repair over as repairing", async (t) => {
  useFakeChartDataSource(t);
  mock.timers.enable({ apis: ["Date"], now: START + 10_000 });
  const retry = [];
  const f = fixture(async (q) => {
    q.onMeta?.({ degraded: true, footprint: { allowed: true, available: false }, provenance: [{ error: "down" }] });
    return [];
  });
  const release = registerRecentCoverageRetryScheduler(f.pipeline.series, (attempt, run, reason) => retry.push({ attempt, run, reason }));
  try {
    f.session();
    f.emit(3);
    await settle();
    for (let minute = 1; minute <= 4; minute++) {
      mock.timers.tick(60_000);
      retry.at(-1).run();
      await settle();
    }
    assert.equal(ohlcOf(f.pipeline).reason, "LIVE_REPAIR_FAILED");
    f.pipeline.repair.onSession({ generation: 2, epoch: 1, session: "s2", boundaryAt: Date.now() });
    await settle();
    assert.equal(f.reports.at(-1).state, "pending");
    assert.equal(ohlcOf(f.pipeline).reason, "LIVE_REPAIR_PENDING");
  } finally {
    release();
    f.pipeline.dispose();
    mock.timers.reset();
  }
});
