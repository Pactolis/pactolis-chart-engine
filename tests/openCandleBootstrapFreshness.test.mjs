import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const INTERVAL = 120_000;
const START = Date.UTC(2024, 0, 1, 0, 0, 0);

function snapshotMeta(q) {
  return {
    schemaVersion: 2,
    generatedAt: START + 60_000,
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      authority: "provisional",
      status: "pending",
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom: q.from,
      coveredThrough: START + 60_000,
      durableThroughId: null,
      projectionThroughId: "102",
      authorityToken: "projection-1",
      reasonCode: null,
    },
    repairSnapshot: {
      schemaVersion: 2,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      interval: q.interval,
      priceStep: q.priceStep,
      authority: "provisional",
      authorityToken: "projection-1",
      watermark: "102",
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom: q.from,
      coveredThrough: START + 60_000,
      bucketFrom: START,
      bucketThrough: START,
      coverageProof: {
        kind: "resolver-watermark-contiguous-v2",
        authority: "provisional",
        authorityToken: "projection-1",
        projectionThroughId: "102",
        requestedFrom: q.from,
        requestedTo: q.to,
        coveredFrom: q.from,
        coveredThrough: START + 60_000,
        watermarkComplete: true,
      },
    },
  };
}

function snapshotBar() {
  return {
    startTime: START,
    open: 100, high: 100, low: 100, close: 100,
    volume: 1, delta: 1, count: 1,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([[100, { priceBin: 100, buyVol: 1, sellVol: 0, count: 1, buyCount: 1, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
    hasRef: true, completeness: "complete", sources: ["history"], updatedAt: START + 60_000,
  };
}

test("ACK plus an empty live buffer does not declare a repair healthy", async (t) => {
  useFakeChartDataSource(t);
  let sessionCb;
  const reports = [];
  const services = {
    subscribeToTrades() { return () => {}; },
    subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = undefined; }; },
    fetchHistory(q) { q.onMeta?.(snapshotMeta(q)); return Promise.resolve([snapshotBar()]); },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    acquirePipelineIntegrityReporter() { return { report(state, detail) { reports.push({ state, detail }); }, dispose() {} }; },
  };
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services });
  try {
    sessionCb({ generation: 1, epoch: 1, session: "s1", boundaryAt: START + 60_000 });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.notEqual(reports.at(-1)?.state, "healthy");
    assert.equal(reports.at(-1)?.state, "pending");
    assert.match(reports.at(-1)?.detail ?? "", /liveness evidence/i);
    assert.equal(pipeline.liveBootstrapReconciled, false);
  } finally {
    pipeline.dispose();
  }
});

test("a snapshot that lands before the first post-boundary trade is held, not re-fetched", async (t) => {
  useFakeChartDataSource(t);
  let sessionCb;
  let tradeCb;
  let fetches = 0;
  const reports = [];
  const services = {
    subscribeToTrades(_market, cb) { tradeCb = cb; return () => { tradeCb = undefined; }; },
    subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = undefined; }; },
    fetchHistory(q) { fetches++; q.onMeta?.(snapshotMeta(q)); return Promise.resolve([snapshotBar()]); },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    acquirePipelineIntegrityReporter() { return { report(state, detail) { reports.push({ state, detail }); }, dispose() {} }; },
  };
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services });
  try {
    const boundaryAt = START + 60_000;
    sessionCb({ generation: 1, epoch: 1, session: "s1", boundaryAt });
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);

    // The snapshot is already validated; only the stream's proof of life is missing. Every
    // extra request here would return the same body and spend a backoff step for nothing.
    assert.equal(fetches, 1);
    assert.equal(pipeline.liveBootstrapReconciled, false);
    assert.equal(reports.at(-1)?.state, "pending");
    assert.match(reports.at(-1)?.detail ?? "", /liveness evidence/i);

    // Watermark is "102", so the joinable tail starts at 103.
    tradeCb({ time: boundaryAt + 1, price: 100, qty: 1, isBuy: true, market: "M", id: "103" });
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);

    assert.equal(fetches, 1, "the held snapshot commits without another request");
    assert.equal(pipeline.liveBootstrapReconciled, true);
    assert.equal(reports.at(-1)?.state, "healthy");
  } finally {
    pipeline.dispose();
  }
});

test("live evidence already present commits without waiting", async (t) => {
  useFakeChartDataSource(t);
  let sessionCb;
  let tradeCb;
  const reports = [];
  const services = {
    subscribeToTrades(_market, cb) { tradeCb = cb; return () => { tradeCb = undefined; }; },
    subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = undefined; }; },
    fetchHistory(q) { q.onMeta?.(snapshotMeta(q)); return Promise.resolve([snapshotBar()]); },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    acquirePipelineIntegrityReporter() { return { report(state, detail) { reports.push({ state, detail }); }, dispose() {} }; },
  };
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services });
  try {
    const boundaryAt = START + 60_000;
    sessionCb({ generation: 1, epoch: 1, session: "s1", boundaryAt });
    tradeCb({ time: boundaryAt + 1, price: 100, qty: 1, isBuy: true, market: "M", id: "103" });
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);

    assert.equal(pipeline.liveBootstrapReconciled, true);
    assert.equal(reports.at(-1)?.state, "healthy");
    assert.ok(
      !reports.some((entry) => /liveness evidence/i.test(entry.detail ?? "")),
      "a liquid market never reports a liveness wait",
    );
  } finally {
    pipeline.dispose();
  }
});
