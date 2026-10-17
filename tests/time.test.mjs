import test from "node:test";
import assert from "node:assert/strict";
import { bucketStart, bucketEnd, DAY_MS, WEEK_MS, MONTH_TOKEN_MS } from "../dist/core/time.js";

test("fixed intervals use epoch buckets", () => {
  const t = Date.UTC(2026, 5, 19, 12, 34, 56);
  assert.equal(bucketStart(t, 15 * 60_000), Date.UTC(2026, 5, 19, 12, 30));
});

test("weeks begin on Monday UTC", () => {
  assert.equal(bucketStart(Date.UTC(2026, 5, 19, 12), WEEK_MS), Date.UTC(2026, 5, 15));
});

test("calendar month tokens use calendar arithmetic", () => {
  const start = bucketStart(Date.UTC(2026, 5, 19), 3 * MONTH_TOKEN_MS);
  assert.equal(start, Date.UTC(2026, 3, 1));
  assert.equal(bucketEnd(start, 3 * MONTH_TOKEN_MS), Date.UTC(2026, 6, 1));
});

test("January 2020 monthly bucket covers the complete calendar month", () => {
  const start = bucketStart(Date.UTC(2020, 0, 20), MONTH_TOKEN_MS);
  assert.equal(start, Date.UTC(2020, 0, 1));
  assert.equal(bucketEnd(start, MONTH_TOKEN_MS), Date.UTC(2020, 1, 1));
});

test("daily interval remains fixed", () => {
  assert.equal(bucketStart(Date.UTC(2026, 5, 19, 17), DAY_MS), Date.UTC(2026, 5, 19));
});
