import assert from "node:assert/strict";
import test from "node:test";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

// #315 (T04-B): a hidden page's flush timer may not fire for a minute or more, but its
// live trades keep arriving. Synthetic-scheduler proof; the real Chromium lifecycle
// is tests/browser/chart-hidden-tab-recovery.spec.ts.

const START = Date.UTC(2026, 0, 1);
const MARKET = "BINANCE_FUTURES:btcusdt";

function fixture({ throttled }) {
  let deliver;
  let turn = null;
  const degraded = [];
  const scheduler = {
    hidden: throttled,
    request(cb) { turn = cb; return 1; },
    cancel() { turn = null; },
    isThrottled() { return scheduler.hidden; },
  };
  const pipeline = new ChartDataPipeline({
    market: MARKET, intervalMs: 60_000, priceStep: 1, scheduler,
    services: {
      subscribeToTrades(_market, cb) { deliver = cb; return () => {}; },
      fetchHistory: async () => [],
      fetchPriceStep: async () => 1,
      fetchPricePrecision: async () => undefined,
    },
    onDataDegraded(value, detail) { degraded.push({ value, detail }); },
  });
  let delivered = 0;
  let volume = 0;
  let maxQueue = 0;
  return {
    pipeline, scheduler, degraded,
    emit(count) {
      for (let i = 0; i < count; i++) {
        const id = ++delivered;
        const qty = 1 + (id % 3);
        volume += qty;
        deliver({ id: String(id), market: MARKET, time: START + id, price: 100, qty, isBuy: id % 5 < 3 });
        maxQueue = Math.max(maxQueue, pipeline.pendingTrades.length);
      }
    },
    /** One scheduler turn, as a throttled timer would eventually run it. */
    runTurn() { const cb = turn; turn = null; cb?.(); },
    get delivered() { return delivered; },
    get volume() { return volume; },
    get maxQueue() { return maxQueue; },
    applied() {
      let count = 0;
      let applied = 0;
      for (let index = 0; index < pipeline.series.length; index++) {
        const bar = pipeline.series.at(index);
        count += bar.count;
        applied += bar.volume;
      }
      return { count, volume: applied };
    },
  };
}

test("a hidden page's queue stays within one drain turn when its timer never fires", () => {
  const f = fixture({ throttled: true });
  try {
    f.emit(50_000);
    assert.ok(f.maxQueue <= 1_000, `queue reached ${f.maxQueue}`);
    assert.equal(f.pipeline.pendingTradeDataLoss, false);
    assert.equal(f.degraded.length, 0, "nothing was dropped, so nothing is reported lost");
    f.scheduler.hidden = false;
    f.runTurn();
    assert.equal(f.pipeline.pendingTrades.length, 0);
    assert.deepEqual(f.applied(), { count: f.delivered, volume: f.volume });
  } finally {
    f.pipeline.dispose();
  }
});

test("a visible page keeps draining on its frames: the queue cap and loss report are unchanged", () => {
  const f = fixture({ throttled: false });
  try {
    f.emit(10_500);
    assert.equal(f.maxQueue, 10_000);
    assert.equal(f.pipeline.pendingTradeDataLoss, true, "a full visible queue still drops and reports it");
    assert.equal(f.degraded.at(-1)?.value, true);
  } finally {
    f.pipeline.dispose();
  }
});
