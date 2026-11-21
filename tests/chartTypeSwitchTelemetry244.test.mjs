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

test("changeConfig aborts in-flight fillMissingCells work and telemetry records attributed jobs", async (t) => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();
  t.after(() => {
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: false });
  });

  const intervalMs = 15 * 60_000;
  const base = Math.floor((Date.now() - 2 * 86_400_000) / intervalMs) * intervalMs;
  const fillGate = deferred();
  const refreshSignals = [];

  useFakeChartDataSource(t, {
    history: async () => [
      historyBar(base, {
        open: 60000, high: 60200, low: 59900, close: 60100, volume: 10, delta: 2, count: 5,
        cells: [{ priceBin: 60000, buyVol: 6, sellVol: 4, liquidationBuyVol: 0, liquidationSellVol: 0, count: 5, buyCount: 3, sellCount: 2 }],
      }),
    ],
    startRefresh: async (req) => {
      refreshSignals.push(req.signal);
      return fillGate.promise;
    },
  });

  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs,
    priceStep: 10,
    services: {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 10,
      fetchPriceStepResult: async () => ({ step: 10, resolved: true }),
      fetchPricePrecision: async () => 1,
    },
  });

  try {
    pipeline.series.loadBars([
      historyBar(base, { open: 60000, high: 60200, low: 59900, close: 60100, volume: 10, delta: 2, count: 5 }),
    ]);

    pipeline.fillMissingCells(base, base + intervalMs);
    assert.equal(refreshSignals.length, 1);
    assert.equal(refreshSignals[0]?.aborted, false);

    // Record reusable & selection marks via core telemetry
    recordTelemetryMark("chart:type-selected", {
      market: MARKET,
      timeframe: "15m",
      chartType: "footprint",
      generation: pipeline.currentGeneration,
      reason: "chart-type-switch",
    }, { reusable: false });
    recordTelemetryJob("history", "reused", {
      market: MARKET,
      timeframe: "15m",
      chartType: "tpo",
      generation: pipeline.currentGeneration,
      reason: "chart-type-switch",
    }, { bars: pipeline.series.length, reusable: true });

    // Trigger timeframe change while fillMissingCells is in-flight -> abort signal must trip
    await pipeline.changeConfig({ intervalMs: 5 * 60_000 });
    assert.equal(refreshSignals[0]?.aborted, true);
    fillGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    const switchSnap = snapshotSwitchTelemetry();
    const reused = switchSnap.jobs.filter((job) => job.phase === "reused");
    const selectedMarks = switchSnap.marks.filter((mark) => mark.name === "chart:type-selected");

    assert.equal(reused.length, 1);
    assert.equal(reused[0].chartType, "tpo");
    assert.equal(reused[0].reusable, true);
    assert.equal(selectedMarks.length, 1);
    assert.equal(selectedMarks[0].market, MARKET);
    assert.equal(selectedMarks[0].timeframe, "15m");
    assert.equal(selectedMarks[0].chartType, "footprint");
  } finally {
    pipeline.dispose();
  }
});

test("telemetry marks preserve monotonic ordering when enabled and are no-ops when disabled", () => {
  configurePerformanceTelemetry({ enabled: false });
  resetPerformanceTelemetry();

  const ctx = {
    market: MARKET,
    timeframe: "15m",
    chartType: "footprint",
    generation: 2,
    reason: "chart-type-switch",
  };
  recordTelemetryMark("chart:type-selected", ctx);
  recordTelemetryJob("history", "started", ctx);
  assert.equal(snapshotSwitchTelemetry().marks.length, 0);
  assert.equal(snapshotSwitchTelemetry().jobs.length, 0);

  configurePerformanceTelemetry({ enabled: true });
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
