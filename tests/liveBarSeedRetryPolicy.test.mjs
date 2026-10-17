import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_BAR_SEED_DEADLINE_MS,
  LIVE_BAR_SEED_EMPTY_CONFIRMATIONS,
  LIVE_BAR_SEED_RETRY_DELAYS_MS,
  LIVE_BAR_SEED_RETRY_STEADY_MS,
  liveBarSeedRetryDelayMs,
  shouldRetryLiveBarSeed,
} from "../dist/features/chart/liveBarSeedRetryPolicy.js";

test("backoff climbs through the table and then holds at steady state", () => {
  assert.equal(liveBarSeedRetryDelayMs(0), LIVE_BAR_SEED_RETRY_DELAYS_MS[0]);
  for (let attempt = 0; attempt < LIVE_BAR_SEED_RETRY_DELAYS_MS.length; attempt++) {
    assert.equal(liveBarSeedRetryDelayMs(attempt), LIVE_BAR_SEED_RETRY_DELAYS_MS[attempt]);
  }
  assert.equal(liveBarSeedRetryDelayMs(LIVE_BAR_SEED_RETRY_DELAYS_MS.length), LIVE_BAR_SEED_RETRY_STEADY_MS);
  assert.equal(liveBarSeedRetryDelayMs(999), LIVE_BAR_SEED_RETRY_STEADY_MS);
  assert.equal(liveBarSeedRetryDelayMs(Number.NaN), LIVE_BAR_SEED_RETRY_DELAYS_MS[0]);
  assert.equal(liveBarSeedRetryDelayMs(-3), LIVE_BAR_SEED_RETRY_DELAYS_MS[0]);
});

test("a failing backend is retried on every timeframe until the deadline", () => {
  const failing = { reason: "failed", consecutiveEmpty: 0, hasLiveBar: false };
  assert.equal(shouldRetryLiveBarSeed({ ...failing, elapsedMs: 0 }), true);
  assert.equal(shouldRetryLiveBarSeed({ ...failing, elapsedMs: 60_000 }), true);
  assert.equal(
    shouldRetryLiveBarSeed({ ...failing, elapsedMs: LIVE_BAR_SEED_DEADLINE_MS - 1 }),
    true,
    "a seed inside the deadline stays pending, including on a 15m chart",
  );
});

test("retries stop at the deadline so a chart never polls for the rest of the session", () => {
  for (const reason of ["failed", "empty"]) {
    assert.equal(
      shouldRetryLiveBarSeed({ reason, elapsedMs: LIVE_BAR_SEED_DEADLINE_MS, consecutiveEmpty: 0, hasLiveBar: true }),
      false,
      `${reason} must not retry past the deadline`,
    );
  }
});

test("a single empty answer is treated as a backend that has not built the open bucket yet", () => {
  assert.equal(
    shouldRetryLiveBarSeed({ reason: "empty", elapsedMs: 0, consecutiveEmpty: 1, hasLiveBar: false }),
    true,
    "one empty response must not be mistaken for an untraded bucket",
  );
  assert.ok(LIVE_BAR_SEED_EMPTY_CONFIRMATIONS >= 2);
});

test("repeated empties on an untraded bucket end the seed, but not while live trades exist", () => {
  assert.equal(
    shouldRetryLiveBarSeed({
      reason: "empty",
      elapsedMs: 0,
      consecutiveEmpty: LIVE_BAR_SEED_EMPTY_CONFIRMATIONS,
      hasLiveBar: false,
    }),
    false,
    "both sources agree the bucket is untraded, so the first live trade is its true open",
  );
  assert.equal(
    shouldRetryLiveBarSeed({
      reason: "empty",
      elapsedMs: 0,
      consecutiveEmpty: LIVE_BAR_SEED_EMPTY_CONFIRMATIONS + 5,
      hasLiveBar: true,
    }),
    true,
    "websocket trades with no REST bar mean the backend is behind, and the open still needs seeding",
  );
});
