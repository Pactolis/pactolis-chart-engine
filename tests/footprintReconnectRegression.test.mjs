import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const BASE = Date.UTC(2024, 0, 1);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
const trade = (time, id) => ({
  time,
  price: 100,
  qty: 1,
  isBuy: true,
  liquidation: false,
  market: "M",
  source: "live",
  receivedAt: time,
  id,
});

function reconnectMeta(q, overrides = {}) {
  const projectionThroughId = overrides.projectionThroughId ?? "100";
  const authorityToken = overrides.authorityToken ?? "token";
  const coveredFrom = overrides.coveredFrom ?? q.from;
  const coveredThrough = overrides.coveredThrough ?? q.to;
  const complete = coveredFrom <= q.from && coveredThrough >= q.to;
  const coverage = {
    schemaVersion: 1,
    source: "binance-usdm-aggTrade",
    instrument: q.reference,
    authority: "provisional",
    status: overrides.status ?? "complete",
    requestedFrom: q.from,
    requestedTo: q.to,
    coveredFrom,
    coveredThrough,
    durableThroughId: null,
    projectionThroughId,
    authorityToken,
    reasonCode: overrides.reasonCode ?? null,
  };
  const meta = { schemaVersion: 2, generatedAt: q.to, footprint: { available: true }, footprintCoverage: coverage };
  if (projectionThroughId !== null && authorityToken) {
    meta.repairSnapshot = {
      schemaVersion: 1,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      interval: q.interval,
      priceStep: q.priceStep,
      authority: "provisional",
      authorityToken,
      watermark: projectionThroughId,
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      bucketFrom: Math.floor(q.from / q.interval) * q.interval,
      bucketThrough: Math.floor(q.to / q.interval) * q.interval,
      coverageProof: {
        kind: "resolver-contiguous-v1",
        authority: "provisional",
        requestedFrom: q.from,
        requestedTo: q.to,
        coveredFrom,
        coveredThrough,
        complete,
      },
    };
  }
  return meta;
}

function harness(metaOverrides = {}) {
  let session;
  const tradeSubs = new Set();
  const reporterEvents = [];
  const degraded = [];
  let query;
  const services = {
    subscribeToTrades(_market, cb) { tradeSubs.add(cb); return () => tradeSubs.delete(cb); },
    subscribeToTradeSessions(cb) { session = cb; return () => { session = null; }; },
    fetchHistory: async (q) => {
      query = q;
      q.onMeta?.(reconnectMeta(q, metaOverrides));
      return [];
    },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      return {
        report(state, detail) { reporterEvents.push({ state, detail }); },
        dispose() {},
      };
    },
    emit(value) { for (const cb of tradeSubs) cb(value); },
    reconnect(generation, boundaryAt) {
      session?.({ generation, epoch: generation, session: `s-${generation}`, boundaryAt });
    },
  };
  const pipeline = new ChartDataPipeline({
    market: "M",
    intervalMs: 60_000,
    priceStep: 1,
    services,
    onDataDegraded: (value, detail) => degraded.push({ value, detail }),
  });
  const scheduledRetries = [];
  const retryAttempts = [];
  pipeline.setRecentCoverageRetryScheduler((attempt, retry) => { retryAttempts.push(attempt); scheduledRetries.push(retry); });
  const releaseRetryScheduler = () => pipeline.setRecentCoverageRetryScheduler(null);
  return {
    services, pipeline, reporterEvents, degraded, scheduledRetries, retryAttempts,
    runScheduledRetry() { return scheduledRetries.shift()?.(); },
    dispose() { releaseRetryScheduler(); pipeline.dispose(); },
    get query() { return query; },
  };
}

test("post-cutoff id at or below W is owned by a complete frozen snapshot", async (t) => {
  useFakeChartDataSource(t);
  const h = harness({ projectionThroughId: "100" });
  h.services.reconnect(1, BASE + 60_000);
  h.services.emit(trade(BASE + 60_001, "70"));
  await flush();

  assert.equal(h.query.to, BASE + 119_999, "repair query must include the full selected open bucket");
  assert.equal(h.pipeline.series.listReadonly().reduce((n, bar) => n + bar.count, 0), 0,
    "snapshot-owned id must not be replayed after the repair snapshot takes ownership");
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  assert.equal(h.scheduledRetries.length, 0);
  h.dispose();
});

test("transient reconnect repair keeps the candle live, preserves range, and heals", async (t) => {
  useFakeChartDataSource(t);
  const h = harness();
  let attempts = 0;
  const ranges = [];
  h.services.fetchHistory = async (q) => {
    attempts++;
    ranges.push([q.from, q.to]);
    if (attempts === 1) throw new Error("temporary history failure");
    q.onMeta?.(reconnectMeta(q));
    return [];
  };

  h.services.reconnect(1, BASE + 60_000);
  h.services.emit(trade(BASE + 60_001, "101"));
  await flush();

  assert.equal(attempts, 1, "retry must not run again in the same event-loop turn");
  assert.deepEqual(h.retryAttempts, [0]);
  assert.equal(h.scheduledRetries.length, 1);
  assert.equal(h.pipeline.series.listReadonly().reduce((n, bar) => n + bar.count, 0), 1,
    "live candle must remain visible and update while footprint repair is pending");
  assert.equal(h.pipeline.series.get(BASE + 60_000)?.cells.size, 0,
    "unproven footprint cells must remain hidden while repair is pending");

  assert.equal(h.runScheduledRetry(), true);
  await flush();
  assert.equal(attempts, 2);
  assert.deepEqual(ranges[1], ranges[0], "retry must preserve the original gap range");
  assert.equal(h.pipeline.series.listReadonly().reduce((n, bar) => n + bar.count, 0), 1);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  assert.equal(h.degraded.some((event) => event.value === true), false);
  h.dispose();
});

test("forward aggregate-ID jump keeps candle and footprint live when transport continuity is intact", async (t) => {
  useFakeChartDataSource(t);
  const h = harness({ projectionThroughId: "100" });
  h.services.reconnect(1, BASE + 60_000);
  h.services.emit(trade(BASE + 60_001, "101"));
  h.services.emit(trade(BASE + 60_003, "103"));
  await flush();

  assert.equal(h.pipeline.series.listReadonly().reduce((n, bar) => n + bar.count, 0), 2);
  assert.ok(h.pipeline.series.get(BASE + 60_000)?.cells.size > 0,
    "numeric aggregate-ID sparsity alone must not hide a transport-contiguous footprint tail");
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  assert.equal(h.scheduledRetries.length, 0);
  assert.equal(h.degraded.some((event) => event.value === true), false);
  h.dispose();
});

test("projection ending before the requested range leaves candle live and footprint pending", async (t) => {
  useFakeChartDataSource(t);
  const h = harness({ coveredThrough: BASE + 59_999 });
  h.services.reconnect(1, BASE + 60_000);
  h.services.emit(trade(BASE + 60_001, "101"));
  await flush();

  assert.equal(h.pipeline.series.listReadonly().reduce((n, bar) => n + bar.count, 0), 1);
  assert.equal(h.pipeline.series.get(BASE + 60_000)?.cells.size, 0);
  assert.equal(h.reporterEvents.at(-1)?.state, "pending");
  assert.equal(h.scheduledRetries.length, 1);
  assert.equal(h.degraded.some((event) => event.value === true), false);
  h.dispose();
});

test("pending provisional status is usable only with complete explicit range proof", async (t) => {
  useFakeChartDataSource(t);
  const h = harness({ status: "pending" });
  h.services.reconnect(1, BASE + 60_000);
  h.services.emit(trade(BASE + 60_001, "101"));
  await flush();

  assert.equal(h.pipeline.series.listReadonly().reduce((n, bar) => n + bar.count, 0), 1);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  assert.equal(h.degraded.some((event) => event.value === true), false);
  h.dispose();
});

function historyBar(startTime, priceBin = 200, count = 1) {
  return {
    startTime,
    open: 100, high: 101, low: 99, close: 100,
    volume: count, delta: count, count,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([[priceBin, {
      priceBin, buyVol: count, sellVol: 0, count, buyCount: count, sellCount: 0,
      liquidationBuyVol: 0, liquidationSellVol: 0,
    }]]),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime,
  };
}

function coverageMeta(q, overrides = {}) {
  return {
    schemaVersion: 2,
    generatedAt: q.to,
    footprint: { available: true },
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      authority: "provisional",
      status: "complete",
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom: q.from,
      coveredThrough: q.to,
      durableThroughId: null,
      projectionThroughId: "100",
      authorityToken: "recent-token",
      reasonCode: null,
      ...overrides,
    },
  };
}

test("recent coverage repair reconciles buffered live trades against the projection watermark", async () => {
  const h = harness();
  const from = Date.UTC(2024, 0, 1);
  const to = from + 60_000;
  let release;
  h.services.fetchHistory = (q) => new Promise((resolve) => {
    q.onMeta?.(coverageMeta(q));
    release = () => resolve([historyBar(from, 99, 1)]);
  });

  const repairing = h.pipeline.repairRecentFootprintCoverage(from, to);
  await new Promise(setImmediate);
  h.services.emit(trade(from + 30_000, "100"));
  h.services.emit(trade(to + 1, "101"));
  release();

  assert.equal(await repairing, "complete");
  assert.equal(h.pipeline.series.listReadonly().reduce((n, bar) => n + bar.count, 0), 2,
    "snapshot trade + next-bucket live trade, without double-counting id 100");
  assert.deepEqual([...h.pipeline.series.at(0).cells.keys()], [99]);
  assert.deepEqual([...h.pipeline.series.at(1).cells.keys()], [100]);
  h.pipeline.dispose();
});

test("partial pending coverage may apply cells but cannot close integrity", async () => {
  const h = harness();
  const from = Date.UTC(2024, 0, 1);
  const to = from + 60_000;
  h.services.fetchHistory = async (q) => {
    q.onMeta?.(coverageMeta(q, {
      status: "pending",
      coveredFrom: q.from + 5_000,
      coveredThrough: q.to - 5_000,
      projectionThroughId: "100",
    }));
    return [historyBar(from, 77, 3)];
  };

  const healthyBefore = h.reporterEvents.filter((event) => event.state === "healthy").length;
  assert.equal(await h.pipeline.repairRecentFootprintCoverage(from, to), "retry");
  const bar = h.pipeline.series.at(0);
  assert.equal(bar.count, 3);
  assert.deepEqual([...bar.cells.keys()], [77]);
  assert.equal(
    h.reporterEvents.filter((event) => event.state === "healthy").length,
    healthyBefore,
    "partial range proof must not emit a new healthy transition",
  );
  h.dispose();
});

test("pending recent coverage without a watermark releases buffered trades without applying the snapshot", async () => {
  const h = harness();
  const from = Date.UTC(2024, 0, 1);
  const to = from + 30_000;
  let release;
  h.services.fetchHistory = (q) => new Promise((resolve) => {
    q.onMeta?.(coverageMeta(q, { status: "pending", coveredThrough: q.to - 1, projectionThroughId: null }));
    release = () => resolve([historyBar(from, 99, 7)]);
  });

  const repairing = h.pipeline.repairRecentFootprintCoverage(from, to);
  await new Promise(setImmediate);
  h.services.emit(trade(to + 1, "101"));
  release();

  assert.equal(await repairing, "retry");
  await flush();
  const bar = h.pipeline.series.at(0);
  assert.equal(bar.count, 1, "the live trade must remain in the normal pipeline");
  assert.deepEqual([...bar.cells.keys()], [100], "the unusable history snapshot must not replace live data");
  h.pipeline.dispose();
});

test("recent coverage repair does not replay an already-applied liquidation in an untouched open bucket", async () => {
  const h = harness();
  const from = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
  const to = from + 60_000;
  let release;
  h.services.fetchHistory = (q) => new Promise((resolve) => {
    q.onMeta?.(coverageMeta(q));
    release = () => resolve([historyBar(from, 99, 1)]);
  });

  const repairing = h.pipeline.repairRecentFootprintCoverage(from, to);
  await new Promise(setImmediate);
  h.services.emit({ ...trade(to + 1, "101"), qty: 7, liquidation: true });
  assert.equal(h.pipeline.series.get(to)?.liquidationBuyVol, 7, "live liquidation must apply while repair is pending");
  release();

  assert.equal(await repairing, "complete");
  assert.equal(h.pipeline.series.get(to)?.liquidationBuyVol, 7,
    "an untouched open bucket must not replay the already-applied liquidation (7 must not become 14)");
  h.dispose();
});