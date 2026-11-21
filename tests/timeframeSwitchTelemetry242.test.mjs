import test from "node:test";
import assert from "node:assert/strict";

import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { ChartHistoryController } from "../dist/features/chart/ChartHistoryController.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
  snapshotSwitchTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const MARKET = "BINANCE_FUTURES:btcusdt";
const BASE_TIME = Date.UTC(2026, 10, 21, 12, 0, 0);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 10) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeServices() {
  const analysisCalls = [];
  return {
    analysisCalls,
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 10,
    fetchPriceStepResult: async () => ({ step: 10, resolved: true }),
    fetchPricePrecision: async () => 1,
    notifyActiveMarket() {},
    notifyInteractiveCandlesReady() {},
    notifyInteractiveHistorySettled() {},
    updateAnalysisFromSeries(market, series, priceStep) {
      analysisCalls.push({ market, len: series.length, intervalMs: series.config.intervalMs, priceStep });
    },
    triggerAutoSync() {},
  };
}

function alignedBar(startTime, closePrice, withCells = true) {
  return historyBar(startTime, {
    open: closePrice - 10,
    high: closePrice + 20,
    low: closePrice - 20,
    close: closePrice,
    volume: 12,
    delta: 4,
    count: 10,
    cells: withCells
      ? [{ priceBin: closePrice - 10, buyVol: 8, sellVol: 4, liquidationBuyVol: 0, liquidationSellVol: 0, count: 10, buyCount: 6, sellCount: 4 }]
      : [],
  });
}

function makeControllerHost(pipeline, svc, initialState) {
  let state = { ...initialState };
  let disposed = false;
  const settled = [];
  const loadingEvents = [];
  const marks = [];
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 500 };

  let historyGen = 0;
  let activeHistoryGen = 0;
  let activeMarket = state.market;
  let activeTf = state.timeframe;

  const host = {
    pipeline,
    session: { invalidate() {} },
    view,
    timeViewport: {
      followsLatest: () => true,
      userViewportRevision: () => 0,
      applyDataUpdate() { return false; },
      placeLatestAfterDataReset() {},
      keepViewportAfterHistoryLoad() {},
      completeInitialHistoryFit() {},
      rescaleForIntervalChange() {},
      restoreTimeAnchor() {},
      markUserViewportChange() {},
      placeFocusedRangeEnd() {},
    },
    svc,
    capture: {
      beginHistoryLoad(market, timeframe) {
        activeHistoryGen = ++historyGen;
        activeMarket = market;
        activeTf = timeframe;
        return activeHistoryGen;
      },
      settleHistoryLoad(generation, market, timeframe) {
        return generation === activeHistoryGen && market === activeMarket && timeframe === activeTf;
      },
      failHistoryLoad() { return false; },
    },
    replay: {
      isActive: () => false,
      getSnapshot: () => null,
      prepareForTimeframeChange() {},
      reconfigureAfterTimeframeChange() {},
    },
    getChartId: () => "chart-242-test",
    isDisposed: () => disposed,
    getState: () => state,
    autoFit() {},
    shouldAutoFitSameBarLiveUpdate: () => false,
    setLoading(loading) { loadingEvents.push(loading); },
    revealCandles() {},
    setFootprintAvailable() {},
    notifyHistorySettled(market, timeframe) { settled.push({ market, timeframe }); },
    onHistoryLoadBegin(ctx) { marks.push({ event: "begin", ...ctx }); },
    onHistoryLoadSettled(ctx) { marks.push({ event: "settled", ...ctx }); },
    onOpenCandleCompleted(ctx) { marks.push({ event: "open-candle", ...ctx }); },
  };

  const controller = new ChartHistoryController(host);
  return {
    controller,
    settled,
    loadingEvents,
    marks,
    switchTimeframe(timeframe) {
      const previous = state;
      state = { ...state, timeframe };
      controller.handleSelectionChange(previous, state);
    },
    dispose() {
      disposed = true;
      controller.dispose();
    },
  };
}

test("rapid 1m -> 1d -> 15m and 1w -> 12M -> 5m switches abort superseded jobs and ignore late non-aborting responses", async (t) => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();
  t.after(() => {
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: false });
  });

  const pendingByInterval = new Map();
  const pendingLiveSeeds = [];
  const seenSignals = [];
  useFakeChartDataSource(t, {
    history: async (query) => {
      seenSignals.push({ interval: query.interval, signal: query.signal });
      const key = `${query.interval}:${query.includeFootprint === false ? "ohlcv" : "fp"}:${seenSignals.length}`;
      const gate = deferred();
      pendingByInterval.set(key, { query, gate });
      // Intentionally ignore query.signal inside the mock promise so we exercise
      // the generation guard even if a transport resolves after abort().
      return gate.promise;
    },
    liveOhlc: async (query) => {
      const gate = deferred();
      pendingLiveSeeds.push({ query, gate });
      return gate.promise;
    },
  });

  const svc = makeServices();
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: 60_000,
    priceStep: 10,
    chartId: "chart-242-test",
    chartType: "footprint",
    timeframe: "1m",
    services: svc,
  });
  const harness = makeControllerHost(pipeline, svc, {
    type: "chart",
    market: MARKET,
    timeframe: "1m",
    scaleMode: "linear",
    chartType: "footprint",
  });

  try {
    // Sequence 1: 1m -> 1d -> 15m (final = 15m / 900_000ms)
    harness.switchTimeframe("1d");
    await drainMicrotasks(4);
    harness.switchTimeframe("15m");
    await drainMicrotasks(6);

    const tf15mMs = 15 * 60_000;
    const tf1dMs = 24 * 60 * 60_000;
    const tf1mMs = 60_000;
    const candle15m = Math.floor((Date.now() - 2 * tf15mMs) / tf15mMs) * tf15mMs;
    const candle1d = Math.floor((Date.now() - 2 * tf1dMs) / tf1dMs) * tf1dMs;

    // Resolve stale 1d entries first with 1d bars, then resolve 15m entries.
    for (const [key, entry] of pendingByInterval) {
      if (entry.query.interval === tf1dMs) {
        assert.equal(entry.query.signal?.aborted, true, `stale 1d signal (${key}) must be aborted`);
        entry.gate.resolve([alignedBar(candle1d, 42000, entry.query.includeFootprint !== false)]);
      }
    }
    await drainMicrotasks(6);
    assert.equal(pipeline.intervalMs, tf15mMs);
    assert.equal(pipeline.series.length, 0, "stale 1d response must never populate 15m series");

    for (let pass = 0; pass < 20; pass++) {
      let resolvedAny = false;
      for (const [, entry] of pendingByInterval) {
        if (entry.query.interval === tf15mMs && !entry.resolved) {
          assert.equal(entry.query.signal?.aborted, false);
          entry.resolved = true;
          resolvedAny = true;
          entry.gate.resolve([alignedBar(candle15m, 61000, entry.query.includeFootprint !== false)]);
        }
      }
      await drainMicrotasks(8);
      if (!resolvedAny) break;
    }
    assert.equal(pipeline.series.length, 1);
    assert.equal(pipeline.series.at(0)?.startTime, candle15m);
    assert.equal(pipeline.series.at(0)?.close, 61000);

    // Sequence 2: 1w -> 12M -> 5m (final = 5m / 300_000ms)
    pendingByInterval.clear();
    harness.switchTimeframe("1w");
    await drainMicrotasks(3);
    harness.switchTimeframe("12M");
    await drainMicrotasks(3);
    harness.switchTimeframe("5m");
    await drainMicrotasks(6);

    const tf5mMs = 5 * 60_000;
    const tf1wMs = 7 * 24 * 60 * 60_000;
    const candle5m = Math.floor((Date.now() - 2 * tf5mMs) / tf5mMs) * tf5mMs;
    const candle1w = Math.floor((Date.now() - 2 * tf1wMs) / tf1wMs) * tf1wMs;

    for (const [, entry] of pendingByInterval) {
      if (entry.query.interval !== tf5mMs && !entry.resolved) {
        assert.equal(entry.query.signal?.aborted, true);
        entry.resolved = true;
        entry.gate.resolve([alignedBar(candle1w, 30000, true)]);
      }
    }
    await drainMicrotasks(6);
    assert.equal(pipeline.series.length, 0, "stale 1w/12M responses must not mutate 5m series");

    for (let pass = 0; pass < 20; pass++) {
      let resolvedAny = false;
      for (const [, entry] of pendingByInterval) {
        if (entry.query.interval === tf5mMs && !entry.resolved) {
          entry.resolved = true;
          resolvedAny = true;
          entry.gate.resolve([alignedBar(candle5m, 62500, entry.query.includeFootprint !== false)]);
        }
      }
      await drainMicrotasks(8);
      if (!resolvedAny) break;
    }
    assert.equal(pipeline.series.length, 1);
    assert.equal(pipeline.series.at(0)?.startTime, candle5m);
    assert.equal(pipeline.series.at(0)?.close, 62500);

    // Verify job attribution for history, canonical-analysis, and live-seed
    const switchSnap = snapshotSwitchTelemetry();
    const historyJobs = switchSnap.jobs.filter((job) => job.jobKind === "history");
    const analysisJobs = switchSnap.jobs.filter((job) => job.jobKind === "canonical-analysis");
    const liveSeedJobs = switchSnap.jobs.filter((job) => job.jobKind === "live-seed");

    for (const seed of pendingLiveSeeds) seed.gate.resolve([]);
    await drainMicrotasks(4);

    assert.ok(historyJobs.some((job) => job.phase === "aborted" && job.timeframe === "1d"));
    assert.ok(historyJobs.some((job) => job.phase === "applied" && job.timeframe === "5m"));
    assert.ok(analysisJobs.some((job) => job.phase === "applied" && job.timeframe === "5m"));
    assert.ok(liveSeedJobs.some((job) => job.phase === "aborted"));
    assert.ok(switchSnap.jobs.every((job) =>
      job.chartId === "chart-242-test"
      && job.market === MARKET
      && typeof job.timeframe === "string"
      && job.timeframe.length > 0
      && typeof job.generation === "number"
      && typeof job.reason === "string"
      && job.reason.length > 0));
    assert.ok(tf1mMs > 0);
  } finally {
    harness.dispose();
    pipeline.dispose();
  }
});

test("changeConfig clears stale market bars when superseded before metadata await resolves", async () => {
  const stepGate = deferred();
  const svc = {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 10,
    fetchPriceStepResult: async (market) => {
      if (market === "BINANCE_FUTURES:ethusdt") return stepGate.promise;
      return { step: 10, resolved: true };
    },
    fetchPricePrecision: async () => 1,
  };
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: 15 * 60_000,
    priceStep: 10,
    services: svc,
  });

  try {
    const start = Math.floor((Date.now() - 2 * 15 * 60_000) / (15 * 60_000)) * (15 * 60_000);
    pipeline.series.loadBars([alignedBar(start, 60000, true)]);
    assert.equal(pipeline.series.length, 1);

    const first = pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
    const second = pipeline.changeConfig({ intervalMs: 15 * 60_000 });
    stepGate.resolve({ step: 10, resolved: true });
    await Promise.all([first, second]);

    assert.equal(pipeline.market, "BINANCE_FUTURES:ethusdt");
    assert.equal(pipeline.series.length, 0, "BTC bars must be cleared even when first market changeConfig is superseded");
  } finally {
    pipeline.dispose();
  }
});

test("repeated range counter, cache hit counter, and open/closed candle merge are tracked and preserved", async (t) => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();
  t.after(() => {
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: false });
  });

  const intervalMs = 15 * 60_000;
  const now = Date.now();
  const openStart = Math.floor(now / intervalMs) * intervalMs;
  const closedStart = openStart - intervalMs;
  let calls = 0;

  useFakeChartDataSource(t, {
    history: async (query) => {
      calls++;
      const bars = query.includeFootprint === false
        ? [alignedBar(closedStart, 61000, false), alignedBar(openStart, 61100, false)]
        : [alignedBar(closedStart, 61000, true)];
      return {
        bars,
        meta: {
          schemaVersion: 2,
          generatedAt: now,
          cache: { hit: calls > 2 },
          candleCoverage: {
            schemaVersion: 1,
            source: "binance-klines",
            instrument: MARKET,
            ownership: "snapshot",
            status: "verified",
            requestedFrom: query.from,
            requestedTo: query.to,
            snapshotAt: now,
            closedThrough: openStart - 1,
            reasonCode: null,
          },
          footprintCoverage: {
            schemaVersion: 1,
            source: "binance-usdm-aggTrade",
            instrument: MARKET,
            authority: "canonical",
            status: "verified",
            requestedFrom: query.from,
            requestedTo: query.to,
            coveredFrom: query.from,
            coveredThrough: query.to,
            durableThroughId: "100",
            projectionThroughId: "100",
            authorityToken: "canonical",
            reasonCode: null,
          },
        },
      };
    },
  });

  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs,
    priceStep: 10,
    chartId: "merge-check",
    timeframe: "15m",
    services: makeServices(),
  });

  try {
    const queryRange = { from: closedStart, to: openStart + intervalMs - 1, twoPhase: true };
    await pipeline.loadHistory(queryRange);
    await pipeline.loadHistory(queryRange);

    const closedBar = pipeline.series.get(closedStart);
    const openBar = pipeline.series.get(openStart);
    assert.ok(closedBar && closedBar.cells.size > 0, "closed candle retains footprint cells");
    assert.ok(openBar, "open candle seeded from history/live seed is preserved");

    const counters = snapshotPerformanceTelemetry().counters;
    assert.ok((counters["pipeline.history.request.total"] ?? 0) >= 4);
    assert.ok((counters["pipeline.history.request.repeated_range"] ?? 0) >= 2);
    assert.ok((counters["pipeline.history.cache.hit"] ?? 0) >= 1);
  } finally {
    pipeline.dispose();
  }
});
