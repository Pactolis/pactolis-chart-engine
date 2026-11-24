import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import {
  LiveTradeQueueCoordinator,
  PENDING_TRADE_BUFFER_CAP,
} from "../dist/features/chart/pipeline/liveTradeQueue.js";

const START = Date.UTC(2026, 0, 1);
const MARKET = "BINANCE_FUTURES:btcusdt";

function makeTrade(seq, overrides = {}) {
  return {
    id: String(seq),
    market: MARKET,
    time: START + seq,
    price: 100 + (seq % 5),
    qty: 1 + (seq % 3),
    isBuy: seq % 2 === 0,
    ...overrides,
  };
}

function withSliceSpy(fn) {
  const origSlice = Array.prototype.slice;
  let sliceCalls = 0;
  Array.prototype.slice = function (...args) {
    sliceCalls++;
    return origSlice.apply(this, args);
  };
  try {
    return fn(() => sliceCalls);
  } finally {
    Array.prototype.slice = origSlice;
  }
}

function createPipelineFixture({ throttled = false } = {}) {
  let deliver;
  let turn = null;
  const degraded = [];
  const integrityReports = [];
  const scheduler = {
    hidden: throttled,
    request(cb) {
      turn = cb;
      return 1;
    },
    cancel() {
      turn = null;
    },
    isThrottled() {
      return scheduler.hidden;
    },
  };
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: 60_000,
    priceStep: 1,
    scheduler,
    services: {
      subscribeToTrades(_market, cb) {
        deliver = cb;
        return () => {};
      },
      fetchHistory: async () => [],
      fetchPriceStep: async () => 1,
      fetchPricePrecision: async () => undefined,
    },
    integrityReporter: {
      report(status, detail) {
        integrityReports.push({ status, detail });
      },
    },
    onDataDegraded(value, detail) {
      degraded.push({ value, detail });
    },
  });
  return {
    pipeline,
    scheduler,
    degraded,
    integrityReports,
    emit(count, startSeq = 1) {
      for (let i = 0; i < count; i++) {
        deliver(makeTrade(startSeq + i));
      }
    },
    runTurn() {
      const cb = turn;
      turn = null;
      cb?.();
    },
  };
}

function createCoordinatorFixture({ throttled = false } = {}) {
  const series = new FootprintSeries(60_000, 1);
  const appliedTimes = [];
  const repairMarked = [];
  const degraded = [];
  const integrityReports = [];
  const lostBatches = [];
  let turn = null;
  const scheduler = {
    hidden: throttled,
    request(cb) {
      turn = cb;
      return 1;
    },
    cancel() {
      turn = null;
    },
    isThrottled() {
      return scheduler.hidden;
    },
  };
  let coordinator;
  const host = {
    services: {
      subscribeToTrades: () => () => {},
    },
    integrityReporter: {
      report(status, detail) {
        integrityReports.push({ status, detail });
      },
    },
    notifyDataDegraded(value, detail) {
      degraded.push({ value, detail });
    },
    isDisposed: () => false,
    getMarket: () => MARKET,
    getIntervalMs: () => 60_000,
    getGeneration: () => 1,
    isBlockingMaintenance: () => false,
    recordRecentRepairTrade: () => false,
    handleRepairTrade: () => {},
    getExplicitHistoryReconcile: () => null,
    shouldDeferExplicitHistoryTrade: () => false,
    abortExplicitHistoryOverflow: () => {},
    cancelRecentFootprintCoverageRepair: () => {},
    recoverDataLoss(dropped) {
      lostBatches.push(dropped);
    },
    markTradeAppliedForRepairs(trade) {
      repairMarked.push(trade.id);
    },
    recordLastAppliedTradeTime(time) {
      appliedTimes.push(time);
    },
    emitBarClose: () => {},
    emitUpdateEvent: () => {},
    _scheduleFlush() {
      coordinator._scheduleFlush();
    },
    _cancelFlush() {
      coordinator._cancelFlush();
    },
    _flushTrades(limit, budgetMs) {
      coordinator._flushTrades(limit, budgetMs);
    },
  };
  coordinator = new LiveTradeQueueCoordinator(host, series, scheduler);
  return {
    coordinator,
    series,
    scheduler,
    appliedTimes,
    repairMarked,
    degraded,
    integrityReports,
    lostBatches,
    runTurn() {
      const cb = turn;
      turn = null;
      cb?.();
    },
  };
}

test("10,000 live trades drain in 1,000-trade turns with zero Array.prototype.slice backlog copies and FIFO order", () => {
  const f = createCoordinatorFixture();
  const trades = Array.from({ length: 10_000 }, (_, i) => makeTrade(i + 1));
  f.coordinator._enqueuePendingTrades(trades);
  assert.equal(f.coordinator.getPendingCount(), 10_000);

  const sliceCalls = withSliceSpy((getCalls) => {
    for (let turn = 0; turn < 10; turn++) {
      f.coordinator._flushTrades(1_000, 10_000);
    }
    return getCalls();
  });

  assert.equal(sliceCalls, 0, "draining 10,000 trades must not copy backlog via Array.prototype.slice");
  assert.equal(f.coordinator.getPendingCount(), 0);
  assert.equal(f.series.at(0).count, 10_000);
  assert.equal(f.appliedTimes.length, 10_000);
  for (let i = 0; i < 10_000; i++) {
    assert.equal(f.appliedTimes[i], START + i + 1, "trades must be applied in strict FIFO order");
  }
});

test("10,000 live trades drain in 100-trade sub-batch turns with zero Array.prototype.slice backlog copies", () => {
  const f = createCoordinatorFixture();
  for (let i = 1; i <= 10_000; i++) {
    assert.equal(f.coordinator._enqueuePendingTrade(makeTrade(i)), false);
  }

  const sliceCalls = withSliceSpy((getCalls) => {
    for (let turn = 0; turn < 100; turn++) {
      f.coordinator._flushTrades(100, 10_000);
    }
    return getCalls();
  });

  assert.equal(sliceCalls, 0, "100-trade turns must not slice the remaining backlog");
  assert.equal(f.coordinator.getPendingCount(), 0);
  assert.equal(f.series.at(0).count, 10_000);
  assert.equal(f.repairMarked[0], "1");
  assert.equal(f.repairMarked[9_999], "10000");
});

test("consumed queue slots release object references immediately while preserving pendingHead", () => {
  const f = createCoordinatorFixture();
  const trades = Array.from({ length: 500 }, (_, i) => makeTrade(i + 1));
  f.coordinator._enqueuePendingTrades(trades);
  f.coordinator._flushTrades(150, 10_000);

  assert.equal(f.coordinator.getPendingCount(), 350);
  assert.equal(f.coordinator.pendingHead, 150);
  for (let i = 0; i < 150; i++) {
    assert.equal(f.coordinator.pendingQueue[i], undefined, `consumed slot ${i} must be cleared`);
  }
  assert.equal(f.coordinator.pendingQueue[150]?.id, "151");
});

test("10,000 buffer cap, overflow drop, and recovery use live pending count rather than backing array length", () => {
  const f = createCoordinatorFixture();
  const initial = Array.from({ length: PENDING_TRADE_BUFFER_CAP - 1 }, (_, i) => makeTrade(i + 1));
  assert.equal(f.coordinator._enqueuePendingTrades(initial), false);
  assert.equal(f.coordinator.getPendingCount(), 9_999);

  // Consume 2,000 trades without triggering compaction if possible, or leaving live count at 7,999
  f.coordinator._flushTrades(2_000, 10_000);
  assert.equal(f.coordinator.getPendingCount(), 7_999);

  // Adding 2,000 more brings live count to 9,999: must NOT overflow or lose data
  const refill = Array.from({ length: 2_000 }, (_, i) => makeTrade(10_000 + i + 1));
  assert.equal(f.coordinator._enqueuePendingTrades(refill), false);
  assert.equal(f.coordinator.getPendingCount(), 9_999);
  assert.equal(f.coordinator.pendingTradeOverloaded, false);
  assert.equal(f.coordinator.pendingTradeDataLoss, false);

  // Reaching 10,000 marks overloaded without data loss, and flushing recovers it
  assert.equal(f.coordinator._enqueuePendingTrade(makeTrade(20_001)), true);
  assert.equal(f.coordinator.getPendingCount(), 10_000);
  assert.equal(f.coordinator.pendingTradeOverloaded, true);
  assert.equal(f.coordinator.pendingTradeDataLoss, false);

  f.coordinator._flushTrades(100, 10_000);
  assert.equal(f.coordinator.getPendingCount(), 9_900);
  assert.equal(f.coordinator.pendingTradeOverloaded, false, "flush below cap must recover overloaded flag");
  assert.equal(f.integrityReports.at(-1)?.status, "healthy");

  // Exceeding 10,000 live items drops excess and reports data loss
  const overflowBatch = Array.from({ length: 150 }, (_, i) => makeTrade(30_000 + i + 1));
  assert.equal(f.coordinator._enqueuePendingTrades(overflowBatch), true);
  assert.equal(f.coordinator.getPendingCount(), 10_000);
  assert.equal(f.coordinator.pendingTradeDataLoss, true);
  assert.equal(f.lostBatches.length, 1);
  assert.equal(f.lostBatches[0].length, 50);
  assert.equal(f.degraded.at(-1)?.value, true);
});

test("throttled background drain bounds live queue size and delivers all trades without loss", () => {
  const f = createPipelineFixture({ throttled: true });
  try {
    f.emit(12_000);
    assert.ok(f.pipeline.pendingTrades.length <= 1_000, "throttled drain must keep live queue bounded");
    assert.equal(f.pipeline.pendingTradeDataLoss, false);
    assert.equal(f.degraded.length, 0);

    f.scheduler.hidden = false;
    for (let turns = 0; turns < 100 && f.pipeline.pendingTrades.length > 0; turns++) {
      f.runTurn();
    }
    assert.equal(f.pipeline.pendingTrades.length, 0);
    let totalCount = 0;
    for (let i = 0; i < f.pipeline.series.length; i++) {
      totalCount += f.pipeline.series.at(i).count;
    }
    assert.equal(totalCount, 12_000);
  } finally {
    f.pipeline.dispose();
  }
});

test("duplicate trade IDs and identity conflicts are reported accurately", () => {
  const f = createCoordinatorFixture();
  const original = makeTrade(42, { price: 100, qty: 2, isBuy: true });
  const duplicate = makeTrade(42, { price: 100, qty: 2, isBuy: true });
  const conflicting = makeTrade(42, { price: 105, qty: 9, isBuy: false });

  f.coordinator._enqueuePendingTrades([original, duplicate, conflicting]);
  f.coordinator._flushTrades(10, 10_000);

  assert.equal(f.series.at(0).count, 1, "first delivery stays applied");
  assert.equal(f.coordinator.conflictHeld(), true);
  assert.equal(f.integrityReports.at(-1)?.status, "error");
  assert.match(f.integrityReports.at(-1)?.detail ?? "", /TRADE_IDENTITY_CONFLICT/);
  assert.equal(f.degraded.at(-1)?.value, true);
});

test("getPendingTrades and filterPendingTrades operate strictly on live [pendingHead..length) items", () => {
  const f = createCoordinatorFixture();
  const trades = Array.from({ length: 10 }, (_, i) => makeTrade(i + 1));
  f.coordinator._enqueuePendingTrades(trades);
  f.coordinator._flushTrades(4, 10_000);

  assert.equal(f.coordinator.getPendingCount(), 6);
  const liveBefore = f.coordinator.getPendingTrades();
  assert.deepEqual(
    liveBefore.map((t) => t.id),
    ["5", "6", "7", "8", "9", "10"],
  );

  f.coordinator.filterPendingTrades((t) => Number(t.id) % 2 === 0);
  assert.equal(f.coordinator.pendingHead, 0);
  assert.equal(f.coordinator.getPendingCount(), 3);
  assert.deepEqual(
    f.coordinator.getPendingTrades().map((t) => t.id),
    ["6", "8", "10"],
  );
});
