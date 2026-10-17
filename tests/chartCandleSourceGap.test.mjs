/**
 * A /history response whose kline source failed comes back HTTP 200 with fewer or no candles and
 * `candleCoverage.status: "error"`. It must not wipe candles the chart already shows (the gap
 * after a 1m -> 5m switch), and the failed range is asked for again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

globalThis.$state ??= (value) => value;

const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");
const { ChartHistoryController } = await import("../dist/features/chart/ChartHistoryController.js");

const MARKET = "BINANCE_FUTURES:btcusdt";
const INTERVAL = 5 * 60_000;

function services() {
  return {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 0.1,
    fetchPricePrecision: async () => 1,
    triggerAutoSync() {},
  };
}

function bar(startTime, close = 100) {
  return {
    startTime, open: 100, high: 101, low: 99, close,
    volume: 10, delta: 0, count: 10, liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map(), hasRef: true, completeness: "complete", sources: ["history"],
    updatedAt: startTime, cellRevision: 0,
  };
}

function coverage(status, from, to) {
  return status === "verified"
    ? {
      schemaVersion: 1, source: "binance-klines", instrument: MARKET, ownership: "snapshot", status,
      requestedFrom: from, requestedTo: to - 1, snapshotAt: to + INTERVAL, closedThrough: to + INTERVAL - 1, reasonCode: null,
    }
    : {
      schemaVersion: 1, source: "binance-klines", instrument: MARKET, ownership: null, status,
      requestedFrom: from, requestedTo: to - 1, snapshotAt: null, closedThrough: null, reasonCode: "source_unavailable",
    };
}

function pipelineWithThreeCandles() {
  const start = Math.floor(Date.now() / INTERVAL) * INTERVAL - 10 * INTERVAL;
  const pipeline = new ChartDataPipeline({ market: MARKET, intervalMs: INTERVAL, priceStep: 0.1, services: services() });
  const starts = [start, start + INTERVAL, start + 2 * INTERVAL];
  pipeline.series.loadBars(starts.map((time) => bar(time)));
  const from = start;
  const to = start + 3 * INTERVAL;
  const apply = (status, bars) => {
    pipeline.explicitHistoryReconcile = {
      generation: 0, requestedFrom: from, requestedTo: to - 1, bootstrapFrom: to + 5 * INTERVAL,
      trades: [], applied: new Set(), deferred: new Set(), liveAfterBarrier: new Set(),
      watermark: null, retiredWatermarks: new Map(), candleCoverage: coverage(status, from, to),
    };
    assert.equal(pipeline._applyExplicitHistorySnapshot(from, to, bars, 0, "history-patched", false, false), true);
  };
  return { pipeline, starts, from, to, apply };
}

const startsOf = (pipeline) => pipeline.series.listReadonly().map((item) => item.startTime);

test("a healthy response still replaces the range", () => {
  const { pipeline, starts, apply } = pipelineWithThreeCandles();
  apply("verified", starts.map((time) => bar(time, 100.5)));
  assert.deepEqual(startsOf(pipeline), starts);
  assert.ok(pipeline.series.listReadonly().every((item) => item.close === 100.5));
  assert.equal(pipeline.activeHistoryCandleSourceGap, null);
  pipeline.dispose();
});

test("an empty response from a failed kline source keeps all candles and marks the range for retry", () => {
  const { pipeline, starts, from, to, apply } = pipelineWithThreeCandles();
  apply("error", []);
  assert.deepEqual(startsOf(pipeline), starts);
  assert.deepEqual(pipeline.activeHistoryCandleSourceGap, { from, to });
  pipeline.dispose();
});

test("a failed source returning only the first and last candle keeps the middle one", () => {
  const { pipeline, starts, apply } = pipelineWithThreeCandles();
  apply("error", [bar(starts[0], 100.5), bar(starts[2], 100.5)]);
  assert.deepEqual(startsOf(pipeline), starts);
  assert.equal(pipeline.series.get(starts[0]).close, 100.5, "the bars that did arrive are applied");
  assert.equal(pipeline.series.get(starts[1]).close, 100, "the missing bar is kept as it was");
  pipeline.dispose();
});

test("a verified snapshot may still say a bucket has no candle", () => {
  const { pipeline, starts, apply } = pipelineWithThreeCandles();
  apply("verified", [bar(starts[0]), bar(starts[2])]);
  assert.deepEqual(startsOf(pipeline), [starts[0], starts[2]]);
  pipeline.dispose();
});

test("the history controller asks for a failed candle range again with backoff", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const loads = [];
    let gap = { from: 1_000, to: 2_000 };
    const pipeline = {
      series: { length: 0, config: { priceStep: 0.1 } },
      intervalMs: INTERVAL,
      get activeHistoryCandleSourceGap() { return gap; },
      cancelRecentFootprintCoverageRepair() {},
      cancelLiveBarOHLCRefresh() {},
      loadHistory: async (opts) => { loads.push(opts); gap = loads.length >= 2 ? null : gap; },
    };
    const host = {
      pipeline,
      view: {},
      replay: { isActive: () => false },
      isDisposed: () => false,
      getState: () => ({ market: MARKET, timeframe: "5m" }),
      svc: { updateAnalysisFromSeries() {} },
      session: { invalidate() {} },
    };
    const controller = new ChartHistoryController(host);
    controller.scheduleCandleGapRetry(MARKET, "5m", INTERVAL, 0);
    mock.timers.tick(5_000);
    await new Promise(setImmediate);
    assert.deepEqual(loads, [{ from: 1_000, to: 1_999 }]);
    mock.timers.tick(20_000);
    await new Promise(setImmediate);
    assert.equal(loads.length, 2, "the range is asked for again while the source keeps failing");
    mock.timers.tick(60_000);
    await new Promise(setImmediate);
    assert.equal(loads.length, 2, "once the range loads cleanly the retries stop");
    controller.dispose();
  } finally {
    mock.timers.reset();
  }
});
