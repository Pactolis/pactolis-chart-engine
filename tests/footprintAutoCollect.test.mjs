/**
 * Regressions for automatic footprint collection:
 *  - a fill asks the data source to build a day, and waits for it
 *  - a failed day is retried after a cooldown instead of being skipped forever
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const DAY_MS = 86_400_000;

function recentElapsedDayStart(daysAgo = 7) {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return todayStart - daysAgo * DAY_MS;
}

// ── the fill drives a real build ──────────────────────────────────────────────

const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");

function makeServices() {
  return {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 10,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync: () => {},
  };
}

function stubBackend(t, { runningPolls = 0 } = {}) {
  let polls = 0;
  const source = useFakeChartDataSource(t, {
    history: () => [],
    refreshStatus: () => {
      polls += 1;
      return { state: polls <= runningPolls ? "running" : "idle" };
    },
  });
  return { calls: () => source.queries.map((call) => call.kind), reset: () => { source.queries.length = 0; } };
}

function seedCellLessDay(pipeline, dayStart) {
  pipeline.series.upsertBar({
    startTime: dayStart, open: 1, high: 2, low: 1, close: 2,
    volume: 10, delta: 4, count: 3, cells: new Map(), hasRef: true,
  });
}

test("a fill asks for a build, then waits for the job before merging", async (t) => {
  const dayStart = recentElapsedDayStart();
  const stub = stubBackend(t);
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: makeServices(),
  });
  try {
    seedCellLessDay(pipeline, dayStart);
    stub.reset();
    pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A history read only returns what the base store has, so it could never fill a
    // day the store does not have; startRefresh is the call that builds one.
    assert.ok(stub.calls().includes("startRefresh"), "must not only read the store");
    assert.equal(stub.calls()[0], "startRefresh");
    assert.ok(stub.calls().includes("refreshStatus"), "must wait for the build to finish");
  } finally {
    pipeline.dispose();
  }
});

test("a day is retried only after the cooldown elapses", async (t) => {
  const dayStart = recentElapsedDayStart();
  const stub = stubBackend(t);
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: makeServices(),
  });
  try {
    seedCellLessDay(pipeline, dayStart);
    pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterFirst = stub.calls().filter((kind) => kind === "startRefresh").length;
    assert.equal(afterFirst, 1);

    // Still inside the cooldown: no second build request.
    pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stub.calls().filter((kind) => kind === "startRefresh").length, 1);

    // Past the cooldown, a still-empty day is attempted again instead of being
    // written off for the rest of the session. Re-seed the candle first: the
    // empty-response patchDay above cleared the day, and in the real flow a later
    // /history load supplies the cell-less candle again.
    seedCellLessDay(pipeline, dayStart);
    pipeline.fillCellsAttempted.set(dayStart, Date.now() - 10 * 60_000);
    pipeline.fillMissingCells(dayStart, dayStart + 15 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stub.calls().filter((kind) => kind === "startRefresh").length, 2);
  } finally {
    pipeline.dispose();
  }
});
