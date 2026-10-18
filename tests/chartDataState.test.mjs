// #314 (T04-A): OHLC correctness, footprint completeness and freshness are separate
// states, and "healthy" needs proof of all three.
//
// Oracle: the scenario table below is written from the issue's contract, not from the
// evaluator — supported/unsupported market, coverage reported or not, live trades
// dropped or not, trade age against the #308 1 s target and the app's 15 s / 60 s
// stale/offline defaults. A healthy verdict from any row other than the fully proven
// one is a false positive.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { evaluateChartDataState, DEFAULT_CHART_DATA_THRESHOLDS } = await import("../dist/features/chart/chartDataState.js");
const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");
const { historyBar, useFakeChartDataSource } = await import("./support/fakeChartDataSource.mjs");

const NOW = Date.UTC(2026, 9, 9, 12);

/** Everything proven: settled history, verified candles, complete coverage, a trade 200 ms ago. */
function proven(overrides = {}) {
  return {
    historyStatus: "settled",
    candleSourceGap: false,
    integrity: "healthy",
    integrityDetail: "",
    liveTradesDropped: false,
    liveBacklogOverloaded: false,
    footprintSupported: true,
    footprintReceived: true,
    footprintCoverageReported: true,
    footprintCoverageComplete: true,
    footprintHistoryDegraded: false,
    recentFootprintRepairActive: false,
    lastTradeTime: NOW - 200,
    transportOffline: false,
    ...overrides,
  };
}

const scenarios = [
  {
    given: "every axis proven",
    input: proven(),
    ohlc: "ok", footprint: "complete", freshness: "live", phase: "normal", healthy: true,
  },
  {
    given: "fresh OHLC but no footprint collected for the range",
    input: proven({ footprintReceived: false, footprintCoverageReported: false, footprintCoverageComplete: false }),
    ohlc: "ok", footprint: "missing", footprintReason: "NOT_COLLECTED", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "fresh OHLC with footprint that covers only part of the request",
    input: proven({ footprintCoverageComplete: false }),
    ohlc: "ok", footprint: "partial", footprintReason: "COVERAGE_INCOMPLETE", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "footprint received but the server never reported coverage",
    input: proven({ footprintCoverageReported: false, footprintCoverageComplete: false }),
    ohlc: "ok", footprint: "unknown", footprintReason: "COVERAGE_UNREPORTED", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "an unsupported market",
    input: proven({ footprintSupported: false, footprintReceived: false, footprintCoverageReported: false, footprintCoverageComplete: false }),
    ohlc: "ok", footprint: "unsupported", footprintReason: "MARKET_UNSUPPORTED", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "footprint support not known yet",
    input: proven({ footprintSupported: undefined }),
    ohlc: "ok", footprint: "unknown", footprintReason: "SUPPORT_UNKNOWN", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "the recent footprint window still being completed",
    input: proven({ recentFootprintRepairActive: true, footprintCoverageComplete: false }),
    ohlc: "ok", footprint: "pending", footprintReason: "RECENT_REPAIR_PENDING", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "a degraded history window (footprint store dropped bars)",
    input: proven({ footprintHistoryDegraded: true, footprintCoverageComplete: false }),
    ohlc: "ok", footprint: "degraded", footprintReason: "HISTORY_DEGRADED", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "fresh trades but the live queue overflowed and dropped some (fresh + repaired must not hide loss)",
    input: proven({ liveTradesDropped: true, liveBacklogOverloaded: true, integrity: "pending", integrityDetail: "PENDING_TRADE_BUFFER_OVERFLOW" }),
    ohlc: "repairing", ohlcReason: "LIVE_TRADES_DROPPED", footprint: "degraded", footprintReason: "LIVE_TRADES_DROPPED",
    freshness: "live", phase: "resyncing", healthy: false,
  },
  {
    given: "a full live queue that has not dropped anything",
    input: proven({ liveBacklogOverloaded: true, integrity: "pending" }),
    ohlc: "repairing", ohlcReason: "LIVE_REPAIR_PENDING", footprint: "complete", freshness: "live", phase: "resyncing", healthy: false,
  },
  {
    given: "a full live queue with the gate already healthy again",
    input: proven({ liveBacklogOverloaded: true }),
    ohlc: "ok", footprint: "complete", freshness: "live", phase: "catching-up", healthy: false,
  },
  {
    given: "a live repair after reconnect",
    input: proven({ integrity: "pending", integrityDetail: "waiting for live evidence" }),
    ohlc: "repairing", ohlcReason: "LIVE_REPAIR_PENDING", footprint: "complete", freshness: "live", phase: "resyncing", healthy: false,
  },
  {
    given: "a trade identity conflict",
    input: proven({ integrity: "error", integrityDetail: "TRADE_IDENTITY_CONFLICT: 1" }),
    ohlc: "error", ohlcReason: "INTEGRITY_ERROR", footprint: "complete", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "a live repair still failing past its fast retry ladder (#315)",
    input: proven({ integrity: "error", integrityDetail: "LIVE_REPAIR_UNRESOLVED: Trade-id repair snapshot source unavailable; retrying" }),
    ohlc: "error", ohlcReason: "LIVE_REPAIR_FAILED", footprint: "complete", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "a failed candle range being asked for again",
    input: proven({ candleSourceGap: true }),
    ohlc: "gap", ohlcReason: "CANDLE_SOURCE_GAP", footprint: "complete", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "a history load in flight",
    input: proven({ historyStatus: "loading" }),
    ohlc: "loading", footprint: "unknown", footprintReason: "HISTORY_LOADING", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "a failed history load",
    input: proven({ historyStatus: "failed" }),
    ohlc: "error", ohlcReason: "HISTORY_FAILED", footprint: "unknown", footprintReason: "HISTORY_FAILED", freshness: "live", phase: "normal", healthy: false,
  },
  {
    given: "no trade applied yet",
    input: proven({ lastTradeTime: null }),
    ohlc: "ok", footprint: "complete", freshness: "unknown", freshnessReason: "NO_TRADE_YET", phase: "normal", healthy: false,
  },
  {
    given: "the live stream transport closed",
    input: proven({ transportOffline: true }),
    ohlc: "ok", footprint: "complete", freshness: "offline", freshnessReason: "TRANSPORT_OFFLINE", phase: "normal", healthy: false,
  },
];

for (const scenario of scenarios) {
  test(`given ${scenario.given}`, () => {
    const state = evaluateChartDataState(scenario.input, NOW);
    assert.equal(state.ohlc.state, scenario.ohlc, "OHLC");
    if (scenario.ohlcReason) assert.equal(state.ohlc.reason, scenario.ohlcReason, "OHLC reason");
    assert.equal(state.footprint.state, scenario.footprint, "footprint");
    if (scenario.footprintReason) assert.equal(state.footprint.reason, scenario.footprintReason, "footprint reason");
    assert.equal(state.freshness.state, scenario.freshness, "freshness");
    if (scenario.freshnessReason) assert.equal(state.freshness.reason, scenario.freshnessReason, "freshness reason");
    assert.equal(state.freshness.phase, scenario.phase, "phase");
    assert.equal(state.healthy, scenario.healthy, "healthy");
  });
}

test("freshness thresholds: 1 s live target, then the app's 15 s stale and 60 s offline", () => {
  assert.deepEqual({ ...DEFAULT_CHART_DATA_THRESHOLDS }, { liveMs: 1_000, staleMs: 15_000, offlineMs: 60_000 });
  const at = (ageMs) => evaluateChartDataState(proven({ lastTradeTime: NOW - ageMs }), NOW).freshness;
  assert.equal(at(0).state, "live");
  assert.equal(at(1_000).state, "live", "the 1 s target itself is still live");
  assert.equal(at(1_001).state, "delayed");
  assert.equal(at(1_001).reason, "TRADE_AGE");
  assert.equal(at(14_999).state, "delayed");
  assert.equal(at(15_000).state, "stale");
  assert.equal(at(59_999).state, "stale");
  assert.equal(at(60_000).state, "offline");
  assert.equal(at(2_500).ageMs, 2_500);
  assert.equal(evaluateChartDataState(proven({ lastTradeTime: NOW - 1_001 }), NOW).healthy, false, "a delayed chart is not healthy");
});

test("a venue clock ahead of the local clock reads as age 0, not negative", () => {
  const freshness = evaluateChartDataState(proven({ lastTradeTime: NOW + 300 }), NOW).freshness;
  assert.equal(freshness.ageMs, 0);
  assert.equal(freshness.state, "live");
});

test("no single input other than the proven set turns healthy on", () => {
  // Flip each proven input to its unproven value: none may leave the verdict healthy.
  const flips = {
    historyStatus: "loading", candleSourceGap: true, integrity: "pending", liveTradesDropped: true,
    liveBacklogOverloaded: true, footprintSupported: undefined, footprintReceived: false,
    footprintCoverageReported: false, footprintCoverageComplete: false, footprintHistoryDegraded: true,
    recentFootprintRepairActive: true, lastTradeTime: null, transportOffline: true,
  };
  for (const [key, value] of Object.entries(flips)) {
    assert.equal(evaluateChartDataState(proven({ [key]: value }), NOW).healthy, false, key);
  }
});

// ── Pipeline: the inputs come from what the history load and repair actually proved ──

const MARKET = "BINANCE_FUTURES:btcusdt";
const INTERVAL = 60_000;
const FROM = Date.UTC(2024, 0, 1);
const TO = FROM + 10 * INTERVAL - 1;

function footprintCoverage(q, { coveredThrough = q.to, status = "complete" } = {}) {
  return {
    schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: q.reference,
    authority: "provisional", status,
    requestedFrom: q.from, requestedTo: q.to,
    coveredFrom: q.from, coveredThrough,
    durableThroughId: null, projectionThroughId: "100", authorityToken: "token", reasonCode: null,
  };
}

function bar(startTime) {
  return {
    startTime, open: 100, high: 101, low: 99, close: 100,
    volume: 1, delta: 1, count: 1, liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([[100, { price: 100, buyVol: 1, sellVol: 0, buyLiqVol: 0, sellLiqVol: 0, buyCount: 1, sellCount: 0, delta: 1 }]]),
    hasRef: true, completeness: "complete", sources: ["history"], updatedAt: startTime,
  };
}

/** History loads go through the data source; the recent-coverage repair goes through `services.fetchHistory`. */
function pipelineWith(t, metaFor) {
  useFakeChartDataSource(t, {
    history: (q) => {
      const footprint = q.includeFootprint !== false;
      const cells = footprint
        ? [{ priceBin: 100, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 0, sellCount: 1 }]
        : [];
      const bars = [historyBar(bucket(q.from), { open: 100, high: 101, low: 99, close: 100, volume: 1, delta: 1, count: 1, cells })];
      return { bars, meta: metaFor(q, footprint) };
    },
  });
  const services = {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    fetchHistory: async (q) => {
      q.onMeta?.(metaFor(q, true));
      return [bar(bucket(q.from))];
    },
  };
  return new ChartDataPipeline({ market: MARKET, intervalMs: INTERVAL, priceStep: 1, services });
}

const bucket = (time) => Math.floor(time / INTERVAL) * INTERVAL;

test("pipeline: a history load whose coverage stops short reads partial, not complete", async (t) => {
  const realNow = Date.now;
  Date.now = () => TO + 5 * INTERVAL;
  t.after(() => { Date.now = realNow; });
  const pipeline = pipelineWith(t, (q) => ({
    schemaVersion: 2, generatedAt: q.to, degraded: false,
    footprint: { available: true, allowed: true },
    footprintCoverage: footprintCoverage(q, { coveredThrough: q.to - 3 * INTERVAL }),
  }));
  await pipeline.loadHistory({ from: FROM, to: TO });
  const inputs = pipeline.dataStateInputs();
  assert.equal(inputs.footprintReceived, true);
  assert.equal(inputs.footprintCoverageReported, true);
  assert.equal(inputs.footprintCoverageComplete, false);
  const state = evaluateChartDataState({ ...inputs, historyStatus: "settled", footprintSupported: true, transportOffline: false }, Date.now());
  assert.equal(state.footprint.state, "partial");
  assert.equal(state.healthy, false);
  pipeline.dispose();
});

test("pipeline: a recent repair that reaches back over the uncovered tail completes the footprint", async (t) => {
  const realNow = Date.now;
  Date.now = () => TO + 5 * INTERVAL;
  t.after(() => { Date.now = realNow; });
  let repairing = false;
  const pipeline = pipelineWith(t, (q) => ({
    schemaVersion: 2, generatedAt: q.to, degraded: false,
    footprint: { available: true, allowed: true },
    footprintCoverage: repairing ? footprintCoverage(q) : footprintCoverage(q, { coveredThrough: q.to - 3 * INTERVAL }),
  }));
  await pipeline.loadHistory({ from: FROM, to: TO });
  assert.equal(pipeline.dataStateInputs().footprintCoverageComplete, false);

  repairing = true;
  // A window that starts after the uncovered tail does not prove the tail.
  const late = await pipeline.repairRecentFootprintCoverage(TO - INTERVAL + 1, TO + 2 * INTERVAL);
  assert.equal(late, "complete", "the later window itself is fully covered");
  assert.equal(pipeline.dataStateInputs().footprintCoverageComplete, false, "a later window leaves the tail unproven");

  const outcome = await pipeline.repairRecentFootprintCoverage(TO - 5 * INTERVAL + 1, TO + 2 * INTERVAL);
  assert.equal(outcome, "complete");
  assert.equal(pipeline.dataStateInputs().footprintCoverageComplete, true);
  assert.equal(pipeline.dataStateInputs().recentFootprintRepairActive, false);
  pipeline.dispose();
});

test("pipeline: dropped live trades stay visible on every axis until the resync clears them", async () => {
  const pipeline = new ChartDataPipeline({
    market: MARKET, intervalMs: INTERVAL, priceStep: 1,
    services: { subscribeToTrades: () => () => {}, fetchPriceStep: async () => 1, fetchPricePrecision: async () => undefined },
    scheduler: { request: () => 1, cancel() {} },
  });
  const trades = Array.from({ length: 10_001 }, (_, i) => ({
    time: NOW - 100, price: 100, qty: 1, isBuy: true, liquidation: false, market: MARKET, id: String(i + 1),
  }));
  pipeline._enqueuePendingTrades(trades);
  const inputs = pipeline.dataStateInputs();
  assert.equal(inputs.liveTradesDropped, true);
  assert.equal(inputs.integrity, "pending");
  const state = evaluateChartDataState({
    ...inputs, lastTradeTime: NOW - 100, historyStatus: "settled", footprintSupported: true, transportOffline: false,
    footprintReceived: true, footprintCoverageReported: true, footprintCoverageComplete: true,
  }, NOW);
  assert.equal(state.ohlc.state, "repairing");
  assert.equal(state.footprint.state, "degraded");
  assert.equal(state.freshness.phase, "resyncing");
  assert.equal(state.healthy, false);
  pipeline.dispose();
});
