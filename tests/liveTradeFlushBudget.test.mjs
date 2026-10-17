import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT,
  DEFAULT_LIVE_TRADE_OVERFLOW_HEADROOM,
  DEFAULT_LIVE_TRADE_PENDING_BUFFER_CAP,
  nextLiveTradeFlushBatchSize,
  overflowRecoveryBatchSize,
} from "../dist/features/chart/liveTradeFlushBudget.js";

test("live trade flush budget caps normal scheduler work", () => {
  assert.equal(DEFAULT_LIVE_TRADE_FLUSH_BATCH_LIMIT, 1_000);
  assert.equal(nextLiveTradeFlushBatchSize(0), 0);
  assert.equal(nextLiveTradeFlushBatchSize(250), 250);
  assert.equal(nextLiveTradeFlushBatchSize(1_000), 1_000);
  assert.equal(nextLiveTradeFlushBatchSize(10_000), 1_000);
});

test("live trade flush budget accepts explicit limits and rejects invalid values", () => {
  assert.equal(nextLiveTradeFlushBatchSize(10_000, 512), 512);
  assert.equal(nextLiveTradeFlushBatchSize(100, 512), 100);
  assert.equal(nextLiveTradeFlushBatchSize(100, 0), 0);
  assert.equal(nextLiveTradeFlushBatchSize(Number.NaN, 512), 0);
});

test("overflow recovery restores bounded headroom instead of draining everything", () => {
  assert.equal(DEFAULT_LIVE_TRADE_PENDING_BUFFER_CAP, 10_000);
  assert.equal(DEFAULT_LIVE_TRADE_OVERFLOW_HEADROOM, 1_000);
  assert.equal(overflowRecoveryBatchSize(9_000), 0);
  assert.equal(overflowRecoveryBatchSize(9_001), 1);
  assert.equal(overflowRecoveryBatchSize(10_000), 1_000);
  assert.equal(overflowRecoveryBatchSize(10_500), 1_500);
});
