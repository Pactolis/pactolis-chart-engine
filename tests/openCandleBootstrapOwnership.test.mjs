import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const INTERVAL = 120_000;
const START = Date.UTC(2024, 0, 1, 0, 0, 0);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function servicesHarness() {
  let sessionCb;
  const repairRequests = [];
  const pending = [];
  const services = {
    subscribeToTrades() { return () => {}; },
    subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = undefined; }; },
    fetchHistory(query) {
      repairRequests.push(query);
      const wait = deferred();
      pending.push(wait);
      return wait.promise;
    },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    acquirePipelineIntegrityReporter() { return { report() {}, dispose() {} }; },
  };
  return { services, session: (value) => sessionCb?.(value), repairRequests, pending };
}

async function tick() {
  await Promise.resolve();
  await new Promise(setImmediate);
}

test("disjoint explicit history does not block an open-candle repair", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const harness = servicesHarness();
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services: harness.services });
  try {
    const token = pipeline.repair.beginExplicitHistory({
      from: START - INTERVAL,
      toExclusive: START,
    });
    harness.session({ generation: 1, epoch: 1, session: "s1", boundaryAt: START + 60_000 });
    await tick();
    assert.equal(harness.repairRequests.length, 1, "disjoint live bootstrap must start while history is active");
    pipeline.repair.finishExplicitHistory(token);
  } finally {
    pipeline.dispose();
    Date.now = previousNow;
  }
});

test("overlapping explicit history preserves repair ordering until history releases ownership", async (t) => {
  useFakeChartDataSource(t);
  const previousNow = Date.now;
  Date.now = () => START + 90_000;
  const harness = servicesHarness();
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services: harness.services });
  try {
    const token = pipeline.repair.beginExplicitHistory({
      from: START,
      toExclusive: START + INTERVAL,
    });
    harness.session({ generation: 1, epoch: 1, session: "s1", boundaryAt: START + 60_000 });
    await tick();
    assert.equal(harness.repairRequests.length, 0, "overlapping repair must remain behind history ownership");
    pipeline.repair.finishExplicitHistory(token);
    await tick();
    assert.equal(harness.repairRequests.length, 1, "repair must resume after overlapping history finishes");
  } finally {
    pipeline.dispose();
    Date.now = previousNow;
  }
});
