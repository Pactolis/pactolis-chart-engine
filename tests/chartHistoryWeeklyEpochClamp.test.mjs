import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { ChartHistoryController } = await import("../dist/features/chart/ChartHistoryController.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { bucketStart, WEEK_MS } = await import("../dist/core/time.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createFixture(timeframe = "1w", intervalMs = WEEK_MS) {
  let disposed = false;
  const state = { type: "chart", market: "BINANCE_FUTURES:btcusdt", timeframe, scaleMode: "linear" };
  const historyCalls = [];
  const loads = [];

  const pipeline = {
    series: new FootprintSeries({ intervalMs, priceStep: 10 }),
    intervalMs,
    pendingStepCorrection: Promise.resolve(null),
    activeHistoryFootprintReceived: false,
    activeHistoryFootprintAvailable: false,
    activeHistoryCandleSourceGap: null,
    cancelHistoryLoad() {},
    cancelRecentFootprintCoverageRepair() {},
    cancelLiveBarOHLCRefresh() {},
    loadHistory(query) {
      historyCalls.push(query);
      const load = deferred();
      loads.push(load);
      load.resolve({ bars: [], meta: { schemaVersion: 2, generatedAt: query.to } });
      return load.promise;
    },
  };

  const host = {
    pipeline,
    session: { invalidate() {} },
    view: { area: { left: 0, width: 0 }, resetPriceScale() {} },
    timeViewport: { followsLatest: () => true, userViewportRevision: () => 0 },
    svc: {
      notifyActiveMarket() {},
      notifyInteractiveHistorySettled() {},
      updateAnalysisFromSeries() {},
      triggerAutoSync() {},
    },
    capture: {
      beginHistoryLoad: () => 1,
      settleHistoryLoad: () => true,
      failHistoryLoad() {},
    },
    replay: { isActive: () => true, getSnapshot: () => null },
    isDisposed: () => disposed,
    getState: () => state,
    autoFit() {},
    shouldAutoFitSameBarLiveUpdate: () => false,
    setLoading: () => {},
    revealCandles() {},
    setFootprintAvailable() {},
    notifyHistorySettled() {},
  };

  const controller = new ChartHistoryController(host);

  return {
    controller,
    historyCalls,
    dispose() {
      disposed = true;
      controller.dispose();
    },
  };
}

test("bucketStart at unix epoch zero rounds backward to previous Monday", () => {
  // 1970-01-01 is Thursday; rounding backward to Monday produces negative epoch timestamps.
  assert.equal(bucketStart(0, WEEK_MS), -259_200_000);
  assert.equal(bucketStart(0, 2 * WEEK_MS), -864_000_000);
  assert.equal(Math.max(0, bucketStart(0, WEEK_MS)), 0);
  assert.equal(Math.max(0, bucketStart(0, 2 * WEEK_MS)), 0);
});

test("ChartHistoryController.loadHistory clamps from to non-negative timestamp on 1w timeframe", async () => {
  const { controller, historyCalls, dispose } = createFixture("1w", WEEK_MS);
  try {
    await controller.loadHistory();
    assert.equal(historyCalls.length, 1);
    assert.ok(
      historyCalls[0].from >= 0,
      `from timestamp must be >= 0 (epoch boundary), got: ${historyCalls[0].from}`,
    );
    assert.equal(historyCalls[0].from, 0);
  } finally {
    dispose();
  }
});

test("ChartHistoryController.loadHistory clamps from to non-negative timestamp on 2w timeframe", async () => {
  const { controller, historyCalls, dispose } = createFixture("2w", 2 * WEEK_MS);
  try {
    await controller.loadHistory();
    assert.equal(historyCalls.length, 1);
    assert.ok(
      historyCalls[0].from >= 0,
      `from timestamp must be >= 0 (epoch boundary), got: ${historyCalls[0].from}`,
    );
    assert.equal(historyCalls[0].from, 0);
  } finally {
    dispose();
  }
});
