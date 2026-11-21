import test from "node:test";
import assert from "node:assert/strict";

import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import {
  configurePerformanceTelemetry,
  recordTelemetryJob,
  recordTelemetryMark,
  resetPerformanceTelemetry,
  snapshotSwitchTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const MARKET = "BINANCE_FUTURES:btcusdt";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("chart-type job attribution distinguishes completed, aborted, and reusable work across rapid transitions", async (t) => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();
  t.after(() => {
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: false });
  });

  const intervalMs = 15 * 60_000;
  const base = Math.floor(Date.now() / intervalMs) * intervalMs - 4 * intervalMs;
  const fillGate = deferred();
  const refreshCalls = [];

  useFakeChartDataSource(t, {
    history: async (query) => {
      refreshCalls.push(query);
      return [
        historyBar(base, {
          open: 60000, high: 60200, low: 59900, close: 60100, volume: 10, delta: 2, count: 5,
          cells: [{ priceBin: 60000, buyVol: 6, sellVol: 4, liquidationBuyVol: 0, liquidationSellVol: 0, count: 5, buyCount: 3, sellCount: 2 }],
        }),
      ];
    },
    startRefresh: async (req) => {
      refreshCalls.push(req);
      return fillGate.promise;
    },
  });

  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs,
    priceStep: 10,
    chartId: "chart-244-unit",
    chartType: "candlestick",
    timeframe: "15m",
    services: {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 10,
      fetchPriceStepResult: async () => ({ step: 10, resolved: true }),
      fetchPricePrecision: async () => 1,
    },
  });

  try {
    // Load candle-only bars (simulating cold candlestick before footprint is filled).
    pipeline.series.loadBars([
      historyBar(base, { open: 60000, high: 60200, low: 59900, close: 60100, volume: 10, delta: 2, count: 5 }),
    ]);

    // 1. Switch to footprint (Cluster) -> starts fillMissingCells while waiting.
    pipeline.setTelemetryContext({ chartId: "chart-244-unit", chartType: "footprint", timeframe: "15m", reason: "chart-type-switch" });
    recordTelemetryMark("chart:type-selected", pipeline.getTelemetryAttribution("chart-type-switch"), { reusable: false });
    pipeline.fillMissingCells(base, base + intervalMs);

    // 2. Rapidly switch to TPO before fillMissingCells resolves, then simulate config reset aborting stale work.
    pipeline.setTelemetryContext({ chartId: "chart-244-unit", chartType: "tpo", timeframe: "15m", reason: "chart-type-switch" });
    recordTelemetryJob("history", "reused", pipeline.getTelemetryAttribution("chart-type-switch"), {
      bars: pipeline.series.length,
      reusable: true,
      detail: "reuse-for-tpo",
    });

    // 3. Trigger timeframe change while old footprint fill is still waiting -> old fill must be aborted cleanly.
    await pipeline.changeConfig({ intervalMs: 5 * 60_000, chartType: "candlestick", reason: "timeframe-switch" });
    fillGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    const switchSnap = snapshotSwitchTelemetry();
    const reused = switchSnap.jobs.filter((job) => job.phase === "reused");
    const aborted = switchSnap.jobs.filter((job) => job.phase === "aborted");
    const selectedMarks = switchSnap.marks.filter((mark) => mark.name === "chart:type-selected");

    assert.equal(reused.length, 1);
    assert.equal(reused[0].chartType, "tpo");
    assert.equal(reused[0].reusable, true);
    assert.ok(aborted.some((job) => job.detail === "config-change"));
    assert.equal(selectedMarks.length, 1);
    assert.equal(selectedMarks[0].chartId, "chart-244-unit");
    assert.equal(selectedMarks[0].market, MARKET);
    assert.equal(selectedMarks[0].timeframe, "15m");
    assert.equal(selectedMarks[0].chartType, "footprint");
  } finally {
    pipeline.dispose();
  }
});

test("telemetry marks distinguish empty/placeholder rejections from verified painted frames", () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const ctx = {
    chartId: "chart-244-stages",
    market: MARKET,
    timeframe: "15m",
    chartType: "footprint",
    generation: 2,
    reason: "chart-type-switch",
  };
  recordTelemetryMark("chart:type-selected", ctx, { previousChartType: "candlestick", reusable: false });
  recordTelemetryMark("chart:type-data-requested", ctx, { from: 1000, to: 2000 });
  recordTelemetryMark("chart:first-data-frame-painted", ctx, { elapsedMs: 12.5, visibleBars: 40 });
  recordTelemetryMark("chart:visible-range-ready", ctx, { elapsedMs: 18.2, visibleBars: 40 });

  const snap = snapshotSwitchTelemetry();
  assert.deepEqual(
    snap.marks.map((m) => m.name),
    [
      "chart:type-selected",
      "chart:type-data-requested",
      "chart:first-data-frame-painted",
      "chart:visible-range-ready",
    ],
  );
  assert.ok(snap.marks[2].atMs <= snap.marks[3].atMs);

  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: false });
});
