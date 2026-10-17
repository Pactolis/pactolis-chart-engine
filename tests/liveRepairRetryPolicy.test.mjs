import test from "node:test";
import assert from "node:assert/strict";
import { liveRepairRetryDelayMs } from "../dist/features/chart/recentCoverageRetryPolicy.js";

test("snapshot/continuity repair retries use a bounded fast window then existing backoff", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((attempt) => liveRepairRetryDelayMs(attempt, "snapshot_pending")), [250, 500, 1000, 1000, 2000]);
  assert.deepEqual([0, 1, 2, 3].map((attempt) => liveRepairRetryDelayMs(attempt, "continuity")), [250, 500, 1000, 1000]);
});

test("transport failures stay on the existing long retry policy", () => {
  assert.deepEqual([0, 1, 2].map((attempt) => liveRepairRetryDelayMs(attempt, "transport")), [1000, 2000, 4000]);
});
