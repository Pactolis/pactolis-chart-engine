import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_COVERAGE_PROGRESS_RETRY_MAX_MS,
  RECENT_COVERAGE_RETRY_DELAYS_MS,
  RECENT_COVERAGE_RETRY_STEADY_MS,
  recentCoverageRetryDelayMs,
} from "../dist/features/chart/recentCoverageRetryPolicy.js";

test("recent coverage retry policy preserves warmup cadence", () => {
  assert.deepEqual([...RECENT_COVERAGE_RETRY_DELAYS_MS], [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000]);
  for (let attempt = 0; attempt < RECENT_COVERAGE_RETRY_DELAYS_MS.length; attempt++) {
    assert.equal(recentCoverageRetryDelayMs(attempt), RECENT_COVERAGE_RETRY_DELAYS_MS[attempt]);
  }
});

test("recent coverage retry policy never exceeds one-minute steady cadence", () => {
  assert.equal(RECENT_COVERAGE_RETRY_STEADY_MS, 60_000);
  assert.equal(recentCoverageRetryDelayMs(9), 60_000);
  assert.equal(recentCoverageRetryDelayMs(100), 60_000);
});

test("progress-aware retries also remain capped at one minute", () => {
  assert.equal(RECENT_COVERAGE_PROGRESS_RETRY_MAX_MS, 60_000);
  assert.equal(recentCoverageRetryDelayMs(9, "progress"), 60_000);
  assert.equal(recentCoverageRetryDelayMs(100, "progress"), 60_000);
});

test("invalid attempts fall back to first retry", () => {
  assert.equal(recentCoverageRetryDelayMs(-1), 1_000);
  assert.equal(recentCoverageRetryDelayMs(Number.NaN), 1_000);
});
