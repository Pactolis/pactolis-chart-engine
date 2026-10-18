import assert from "node:assert/strict";
import test from "node:test";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { registerRecentCoverageRetryScheduler } from "../dist/features/chart/recentCoverageRetryBridge.js";
import { splitHistoryCellBudgetWindow } from "../dist/features/chart/historyWindowPolicy.js";
import { bucketStart } from "../dist/core/time.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

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

/**
 * Repairs read through `services.fetchHistory`; tests that use it still install a data
 * source, which the repair asks whether the market is candle-only.
 */
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

test("local overflow repairs a lost closing price and volume without reconnecting", async (t) => {
  useFakeChartDataSource(t);
  let fetches = 0;
  let releaseRepair;
  const f = fixture(async (q) => {
    fetches++;
    const watermark = fetches === 1 ? 1 : 10003;
    if (fetches > 1) await new Promise((resolve) => { releaseRepair = resolve; });
    q.onMeta?.(snapshot(q, watermark));
    return [repairBar(q.from, watermark, watermark === 1 ? 100 : 101)];
  });
  try {
    f.session();
    f.emit(2);
    await settle();
    f.drain();
    assert.equal(f.pipeline.liveBootstrapReconciled, true);
    for (let id = 3; id <= 10003; id++) f.emit(id, id === 10003 ? 101 : 100);
    assert.equal(fetches, 2, "a healthy socket must not prevent local resync");
    assert.equal(f.pipeline.pendingTradeDataLoss, true);
    assert.notEqual(f.reports.at(-1).state, "healthy");
    f.drain();
    assert.equal(f.pipeline.pendingTradeDataLoss, true, "draining alone does not prove recovery");
    releaseRepair();
    await settle();
    f.drain();
    const bar = f.pipeline.series.get(START);
    assert.equal(bar.volume, 10003);
    assert.equal(bar.close, 101);
    assert.equal(f.pipeline.pendingTradeDataLoss, false);
    assert.equal(f.reports.at(-1).state, "healthy");
    assert.equal(f.degraded.at(-1).value, false);
    f.emit(10004, 101);
    f.drain();
    assert.equal(f.pipeline.series.get(START).volume, 10004, "the repaired tail stays exactly once");
    assert.equal(fetches, 2);
  } finally {
    f.pipeline.dispose();
  }
});

test("source-unavailable repair retries through the chart scheduler and recovers", async (t) => {
  useFakeChartDataSource(t);
  let calls = 0;
  const retry = [];
  const f = fixture(async (q) => {
    calls++;
    if (calls === 1) {
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
    assert.equal(retry.length, 1);
    assert.equal(retry[0].reason, "transport");
    assert.equal(f.reports.at(-1).state, "pending");
    assert.equal(f.pipeline.liveBootstrapReconciled, false);
    assert.equal(retry[0].run(), true);
    await settle();
    f.drain();
    assert.equal(calls, 2);
    assert.equal(f.pipeline.liveBootstrapReconciled, true);
    assert.equal(f.pipeline.series.get(START).volume, 3);
    assert.equal(f.reports.at(-1).state, "healthy");
  } finally {
    release();
    f.pipeline.dispose();
  }
});

test("degraded snapshot content is not promoted into a retryable source outage", async (t) => {
  useFakeChartDataSource(t);
  let retries = 0;
  const f = fixture(async (q) => {
    q.onMeta?.({ ...snapshot(q, 1), degraded: true });
    return [repairBar(q.from, 1)];
  });
  const release = registerRecentCoverageRetryScheduler(f.pipeline.series, () => { retries++; });
  try {
    f.session();
    f.emit(2);
    await settle();
    assert.equal(retries, 0);
    assert.equal(f.reports.at(-1).state, "error");
    assert.equal(f.pipeline.liveBootstrapReconciled, false);
  } finally {
    release();
    f.pipeline.dispose();
  }
});

function bar(start, cells) {
  return historyBar(start, {
    open: 100, high: 100, low: 100, close: 100, volume: 1, delta: 1, count: 1,
    cells: cells ? [{ priceBin: 100, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }] : [],
  });
}

function historyAnswer(query, maxBars = Infinity, budgetCode = "CELL_BUDGET") {
  const { from, to } = query;
  const count = Math.floor((to - from) / INTERVAL) + 1;
  const footprint = query.includeFootprint !== false;
  const exceeded = footprint && count > maxBars;
  const bars = Array.from({ length: count }, (_, i) => bar(from + i * INTERVAL, footprint && !exceeded));
  const meta = {
    footprint: { allowed: true, available: !exceeded },
    footprintCoverage: {
      schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
      authority: footprint ? "canonical" : null, status: footprint ? "verified" : "pending",
      requestedFrom: from, requestedTo: to, coveredFrom: footprint ? from : null,
      coveredThrough: footprint ? to : null, authorityToken: "canonical", reasonCode: null,
    },
  };
  if (exceeded) {
    meta.degraded = true;
    meta.provenance = [{ source: "footprint-cache", error: budgetCode + ": footprint query exceeded cell limit" }];
  }
  return { bars, meta };
}

for (const twoPhase of [false, true]) {
  test("verified history publishes complete coverage, twoPhase=" + twoPhase, async (t) => {
    useFakeChartDataSource(t, { history: (query) => historyAnswer(query) });
    const f = fixture();
    try {
      await f.pipeline.loadHistory({ from: START, to: START + INTERVAL - 1, twoPhase });
      assert.equal(f.pipeline.activeHistoryFootprintReceived, true);
      assert.equal(f.pipeline.activeHistoryFootprintCoverageComplete, true, "the candle-only phase cannot poison footprint coverage");
    } finally {
      f.pipeline.dispose();
    }
  });

  for (const budgetCode of ["CELL_BUDGET", "BASE_CELL_BUDGET"]) {
    test("server " + budgetCode + " narrows and recovers, twoPhase=" + twoPhase, async (t) => {
      const requests = [];
      useFakeChartDataSource(t, {
        history: (query) => {
          if (query.includeFootprint !== false) requests.push([query.from, query.to]);
          return historyAnswer(query, 25, budgetCode);
        },
      });
      const f = fixture();
      try {
        await f.pipeline.loadHistory({ from: START, to: START + 426 * INTERVAL - 1, twoPhase });
        assert.equal(f.pipeline.series.length, 426);
        assert.equal(f.pipeline.series.listReadonly().filter((bar) => bar.cells.size > 0).length, 426);
        assert.ok(requests.length > 3 && requests.length < 100, "the split tree must terminate");
        assert.equal(f.pipeline.activeHistoryFootprintAvailable, true, "superseded failed attempts cannot poison availability");
        assert.equal(f.pipeline.activeHistoryFootprintCoverageComplete, true);
        assert.ok(!f.degraded.some((entry) => entry.value), "recovered budget failures are not permanent degraded history");
      } finally {
        f.pipeline.dispose();
      }
    });
  }
}

test("one over-budget candle fails visibly instead of retrying forever", async (t) => {
  let requests = 0;
  useFakeChartDataSource(t, { history: (query) => { requests++; return historyAnswer(query, 0); } });
  const f = fixture();
  try {
    await assert.rejects(f.pipeline.loadHistory({ from: START, to: START + INTERVAL - 1 }), /CELL_BUDGET/);
    assert.equal(requests, 1);
    assert.equal(f.pipeline.activeHistoryFootprintAvailable, false);
    assert.equal(f.pipeline.activeHistoryFootprintCoverageComplete, false);
  } finally {
    f.pipeline.dispose();
  }
});

test("budget splitting preserves inclusive calendar-month partitions", () => {
  const interval = 30 * 86_400_000;
  const from = Date.UTC(2024, 0, 1), to = Date.UTC(2024, 3, 1) - 1;
  const split = splitHistoryCellBudgetWindow({ markets: [MARKET], reference: MARKET, from, to, interval, priceStep: 1 });
  assert.ok(split);
  assert.equal(split.older.from, from);
  assert.equal(split.newest.to, to);
  assert.equal(split.older.to + 1, split.newest.from);
  assert.equal(bucketStart(split.newest.from, interval), split.newest.from);
});

for (const preferCache of [undefined, false]) {
  test("phase two reuses verified candles unless explicitly bypassed: " + preferCache, async (t) => {
    const footprintQueries = [];
    useFakeChartDataSource(t, {
      history: (query) => {
        if (query.includeFootprint !== false) footprintQueries.push(query);
        return historyAnswer(query);
      },
    });
    const f = fixture();
    try {
      await f.pipeline.loadHistory({ from: START, to: START + 26 * INTERVAL - 1, twoPhase: true, preferCache });
      assert.equal(footprintQueries.length, 2);
      for (const q of footprintQueries) {
        assert.equal(q.preferCache, preferCache !== false);
        assert.equal(q.candleCoverage, "required", "reuse cannot opt out of source ownership");
      }
    } finally {
      f.pipeline.dispose();
    }
  });
}

for (const coverageMode of ["missing", "pending", "short"]) {
  test("one unproven footprint window prevents full coverage: " + coverageMode, async (t) => {
    let windows = 0;
    useFakeChartDataSource(t, {
      history: (query) => {
        const answer = historyAnswer(query);
        if (query.includeFootprint === false || ++windows !== 2) return answer;
        if (coverageMode === "missing") delete answer.meta.footprintCoverage;
        if (coverageMode === "pending") answer.meta.footprintCoverage.status = "pending";
        if (coverageMode === "short") answer.meta.footprintCoverage.coveredFrom++;
        return answer;
      },
    });
    const f = fixture();
    try {
      await f.pipeline.loadHistory({ from: START, to: START + 26 * INTERVAL - 1, twoPhase: true });
      assert.equal(windows, 2);
      assert.equal(f.pipeline.activeHistoryFootprintReceived, true);
      assert.equal(f.pipeline.activeHistoryFootprintCoverageComplete, false);
    } finally {
      f.pipeline.dispose();
    }
  });
}

test("a dropped deferred batch repairs every bucket and replays its uncovered tail", async (t) => {
  useFakeChartDataSource(t);
  let calls = 0;
  let releaseRepair;
  let repairQuery;
  const dropped = [
    { id: "10003", market: MARKET, time: START + INTERVAL + 1_000, price: 101, qty: 1, isBuy: true },
    { id: "10004", market: MARKET, time: START + 2 * INTERVAL + 1_000, price: 102, qty: 1, isBuy: true },
  ];
  const f = fixture(async (q) => {
    if (++calls === 1) {
      q.onMeta?.(snapshot(q, 1));
      return [repairBar(q.from, 1)];
    }
    repairQuery = q;
    await new Promise((resolve) => { releaseRepair = resolve; });
    q.onMeta?.(snapshot(q, 10003, dropped[0].time));
    return [repairBar(START + INTERVAL, 1, 101)];
  });
  try {
    f.session();
    f.emit(2);
    await settle();
    f.drain();
    for (let id = 3; id <= 10002; id++) f.emit(id);
    // Explicit history can return several deferred trades to an already-full queue.
    f.pipeline._enqueuePendingTrades(dropped);
    assert.equal(calls, 2);
    assert.equal(repairQuery.from, START + INTERVAL);
    assert.equal(repairQuery.to, START + 3 * INTERVAL - 1);
    f.drain();
    releaseRepair();
    await settle();
    f.drain();
    assert.equal(f.pipeline.series.get(START).volume, 10002);
    assert.equal(f.pipeline.series.get(START + INTERVAL).volume, 1);
    assert.equal(f.pipeline.series.get(START + 2 * INTERVAL).volume, 1);
    assert.equal(f.pipeline.series.get(START + 2 * INTERVAL).close, 102);
    assert.equal(f.pipeline.pendingTradeDataLoss, false);
    assert.equal(f.reports.at(-1).state, "healthy");
  } finally {
    f.pipeline.dispose();
  }
});

test("queue overflow cannot reset a terminal repair failure on every trade", async (t) => {
  useFakeChartDataSource(t);
  let calls = 0;
  const f = fixture(async (q) => {
    calls++;
    q.onMeta?.({ ...snapshot(q, 1), degraded: true });
    return [repairBar(q.from, 1)];
  });
  try {
    f.session();
    f.emit(2);
    await settle();
    f.drain();
    assert.equal(f.reports.at(-1).state, "error");
    for (let id = 3; id <= 10020; id++) f.emit(id);
    await settle();
    assert.equal(calls, 1);
    assert.equal(f.pipeline.pendingTradeDataLoss, true);
    assert.notEqual(f.reports.at(-1).state, "healthy");
  } finally {
    f.pipeline.dispose();
  }
});
