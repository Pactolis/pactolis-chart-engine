import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/features/chart/ChartDataPipeline.ts", import.meta.url), "utf8");

test("explicit history records live trades without freezing normal delivery", () => {
  assert.match(source, /private explicitHistoryReconcile: ExplicitHistoryReconcileState \| null = null/);
  assert.match(source, /explicit\.trades\.push\(trade\)/);
  assert.match(source, /this\._enqueuePendingTrade\(trade\)/);
  assert.match(source, /this\.historyController\?\.abort\(\)/);
});

test("explicit history reconciles only overlapping journal trades behind a watermark barrier", () => {
  assert.match(source, /retiredWatermarks: Map<number, bigint>/);
  assert.match(source, /_applyExplicitHistorySnapshot\(/);
  assert.match(source, /const candidates = state\.trades\.filter/);
  assert.match(source, /bucket >= from && bucket < to/);
  assert.match(source, /HISTORY_SNAPSHOT_WATERMARK_REGRESSION/);
  assert.match(source, /liveAfterBarrier: Set<AggTrade>/);
  assert.match(source, /explicit\.liveAfterBarrier\.add\(trade\)/);
  assert.match(source, /candleCoverage: CandleCoverage \| null/);
  assert.match(source, /candleSnapshotOwnsBucket\(state\.candleCoverage/);
  assert.match(source, /CANDLE_COVERAGE_UNKNOWN/);
  assert.match(source, /const cellsPreservedForAppliedTrade = preservedCellBuckets\.has\(bucket\) && state\.applied\.has\(trade\)/);
  assert.match(source, /const footprintSnapshotCoversTrade = watermark !== null && id !== null && id <= watermark/);
  assert.match(source, /this\.series\.addFootprintTrades\(replayFootprint\)/);
  assert.match(source, /this\.series\.replaceRange\(from, to, replacementBars, preserveCells/);
  assert.doesNotMatch(source, /projectionThroughId[^\n]*candle/i);
});

test("normal scheduler turns are bounded and history barriers never force a synchronous full drain", () => {
  assert.match(source, /_flushTrades\(nextLiveTradeFlushBatchSize\(this\.pendingTrades\.length\)\)/);
  assert.match(source, /DEFAULT_LIVE_TRADE_FLUSH_BUDGET_MS/);
  assert.doesNotMatch(source, /overflowRecoveryBatchSize\(this\.pendingTrades\.length, PENDING_TRADE_BUFFER_CAP\)/);
  assert.doesNotMatch(source, /this\._cancelFlush\(\);\s*this\._flushTrades\(\);/);
});
