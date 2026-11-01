import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

function services(fetchHistory) {
  let session;
  return {
    subscribeToTrades: () => () => {},
    subscribeToTradeSessions(cb) { session = cb; return () => { session = null; }; },
    reconnect(generation, boundaryAt) {
      session?.({ generation, epoch: generation, session: `s-${generation}`, boundaryAt });
    },
    fetchHistory,
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
  };
}

test("a failed footprint read is reported as unavailable, an empty one is not", async () => {
  const failing = new ChartDataPipeline({
    market: "M", intervalMs: 60_000, priceStep: 1,
    services: services((q) => {
      q.onMeta?.({ footprint: { available: false }, degraded: true, provenance: [{ error: "query" }] });
      return Promise.resolve([]);
    }),
  });
  failing["handleMeta"]({ footprint: { available: false }, degraded: true, provenance: [{ error: "query" }] });
  assert.equal(failing.activeHistoryFootprintAvailable, false);
  failing.dispose();

  const healthy = new ChartDataPipeline({
    market: "M", intervalMs: 60_000, priceStep: 1,
    services: services((q) => {
      q.onMeta?.({ footprint: { available: true, droppedBars: 0 }, degraded: true });
      return Promise.resolve([]);
    }),
  });
  healthy["handleMeta"]({ footprint: { available: true, droppedBars: 0 }, degraded: true });
  assert.equal(
    healthy.activeHistoryFootprintAvailable,
    true,
    "an empty but healthy response is what an automatic sync is for",
  );
  healthy.dispose();
});

test("automatic sync is not started for a footprint read that failed", () => {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/features/chart/ChartHistoryController.ts",
  );
  const source = fs.readFileSync(file, "utf8");
  assert.match(
    source,
    /if \(footprintSupported && this\.host\.pipeline\.activeHistoryFootprintAvailable && !this\.host\.pipeline\.activeHistoryFootprintCoverageComplete\)/,
  );
  const policySource = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/features/chart/recentCoverageRetryPolicy.ts"), "utf8");
  assert.match(source, /recentCoverageRetryDelayMs/, "history retries must use the shared retry policy");
  assert.match(policySource, /RECENT_COVERAGE_RETRY_DELAYS_MS = \[/, "recent retry must keep the fast warmup sequence");
  const reconnectSource = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/features/chart/LiveTradeRepairController.ts"), "utf8");
  assert.match(reconnectSource, /scheduleRecentCoverageRetry\(/, "reconnect repair must borrow the history retry scheduler");
  assert.doesNotMatch(reconnectSource, /MAX_REPAIR_RETRIES/, "reconnect repair must not retain an immediate private retry loop");
  assert.match(policySource, /RECENT_COVERAGE_RETRY_STEADY_MS = 60_000/, "recent retry steady cadence must stay capped at one minute");
  assert.doesNotMatch(source, /RECENT_FOOTPRINT_RETRY_DELAYS_MS/, "history controller must not retain a private retry table");
  assert.match(source, /scheduleRecentCoverageRetry\(requestedMarket, requestedTimeframe, resolvedIntervalMs\)/);
  assert.match(source, /repairRecentFootprintCoverage\(from, cutoff\)/);
  assert.match(source, /cancelRecentFootprintCoverageRepair\(\)/, "selection\/reload must cancel an in-flight retry");
});
