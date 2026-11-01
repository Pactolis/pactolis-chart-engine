import assert from "node:assert/strict";
import test, { mock } from "node:test";

// #315 (T04-B): a chart shown again after a hidden tab runs its already-armed repair
// retries at once, instead of waiting out a timer the hidden page held back.

globalThis.$state ??= (value) => value;

const { ChartHistoryController } = await import("../dist/features/chart/ChartHistoryController.js");

const MARKET = "BINANCE_FUTURES:btcusdt";
const INTERVAL = 60_000;

class FakeDocument extends EventTarget {
  visibilityState = "visible";
  set(state) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function setup() {
  const doc = new FakeDocument();
  globalThis.document = doc;
  mock.timers.enable({ apis: ["setTimeout"] });
  const repairs = [];
  let retryScheduler = null;
  const pipeline = {
    series: { length: 0, config: { priceStep: 1 } },
    intervalMs: INTERVAL,
    activeHistoryCandleSourceGap: null,
    setRecentCoverageRetryScheduler(scheduler) { retryScheduler = scheduler; },
    cancelRecentFootprintCoverageRepair() {},
    cancelLiveBarOHLCRefresh() {},
    repairRecentFootprintCoverage: async (from, to) => { repairs.push({ from, to }); return "retry"; },
  };
  const host = {
    pipeline,
    view: {},
    replay: { isActive: () => false },
    isDisposed: () => false,
    getState: () => ({ market: MARKET, timeframe: "1m" }),
    svc: { updateAnalysisFromSeries() {} },
    session: { invalidate() {} },
  };
  const controller = new ChartHistoryController(host);
  return {
    doc, controller, pipeline, repairs,
    requestRetry(attempt, retry, reason = "transport") {
      if (!retryScheduler) return false;
      retryScheduler(attempt, retry, reason);
      return true;
    },
    teardown() {
      controller.dispose();
      mock.timers.reset();
      delete globalThis.document;
    },
  };
}

const flush = () => new Promise(setImmediate);

test("an armed live repair retry runs on return from a hidden tab, once, at its own attempt", () => {
  const h = setup();
  try {
    let retries = 0;
    // Attempt 12 of a transport retry: the ladder's 60 s steady delay.
    assert.equal(h.requestRetry(12, () => { retries++; return true; }, "transport"), true);
    h.doc.set("hidden");
    mock.timers.tick(30_000);
    assert.equal(retries, 0, "hidden: the timer is still the only trigger");
    h.doc.set("visible");
    assert.equal(retries, 1, "shown again: the due repair runs now");
    mock.timers.tick(60_000);
    assert.equal(retries, 1, "the held-back timer does not run it a second time");
    h.doc.set("hidden");
    h.doc.set("visible");
    assert.equal(retries, 1, "with nothing armed, showing the tab starts nothing");
  } finally {
    h.teardown();
  }
});

test("a disposed chart ignores the return to visible", () => {
  const h = setup();
  try {
    let retries = 0;
    h.requestRetry(12, () => { retries++; return true; }, "transport");
    h.controller.dispose();
    h.doc.set("hidden");
    h.doc.set("visible");
    mock.timers.tick(120_000);
    assert.equal(retries, 0);
  } finally {
    h.teardown();
  }
});

test("a hidden tab does not advance the recent-coverage ladder, and the return runs it at once", async () => {
  const h = setup();
  try {
    h.doc.set("hidden");
    h.controller.scheduleRecentCoverageRetry(MARKET, "1m", INTERVAL);
    for (let i = 0; i < 20; i++) {
      mock.timers.tick(60_000);
      await flush();
    }
    assert.equal(h.repairs.length, 0, "nothing is fetched while hidden");
    assert.equal(h.controller.recentCoverageRetryPending, true, "still within the fast ladder: it was never tried");
    h.doc.set("visible");
    await flush();
    assert.equal(h.repairs.length, 1, "shown again: the repair runs without waiting for the timer");
  } finally {
    h.teardown();
  }
});
