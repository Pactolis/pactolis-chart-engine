import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { recordFootprintSupport, resetFootprintSupport } from "../dist/core/syncAllowlist.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
const trade = (time, id, qty = 1, price = 100) => ({
  time, price, qty, isBuy: true, liquidation: false, market: "M", source: "live", receivedAt: time, id,
});
const bar = (startTime, { volume = 0, count = 0 } = {}) => ({
  startTime, open: 100, high: 100, low: 100, close: 100, volume, delta: volume, count,
  liquidationBuyVol: 0, liquidationSellVol: 0, cells: new Map(), hasRef: true,
  completeness: "complete", sources: ["kline"], updatedAt: startTime, cellRevision: 0,
});

function repairMeta(q, overrides = {}) {
  const coveredFrom = overrides.coveredFrom ?? q.from;
  const coveredThrough = overrides.coveredThrough ?? q.to;
  const watermark = overrides.watermark ?? "101";
  const authorityToken = "frozen-token";
  const meta = {
    schemaVersion: 2,
    generatedAt: q.to,
    footprint: { available: true, ...(overrides.allowed === undefined ? {} : { allowed: overrides.allowed }) },
    footprintCoverage: {
      schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: q.reference,
      authority: overrides.authority ?? "provisional", status: overrides.status ?? "pending",
      requestedFrom: q.from, requestedTo: q.to, coveredFrom, coveredThrough,
      durableThroughId: null, projectionThroughId: overrides.projectionThroughId ?? watermark,
      authorityToken: overrides.authorityToken === undefined ? authorityToken : overrides.authorityToken,
      reasonCode: overrides.reasonCode ?? null,
    },
  };
  if (overrides.snapshot !== false) {
    const prefixProof = overrides.prefixProof ?? {
      kind: "event-time-prefix-v1", requestedFrom: q.from, firstEventTime: coveredFrom,
    };
    meta.repairSnapshot = {
      schemaVersion: 3, mode: "trade-id-v1", source: "binance-usdm-aggTrade", instrument: q.reference,
      interval: q.interval, priceStep: q.priceStep, authority: "provisional", authorityToken,
      watermark, requestedFrom: q.from, requestedTo: q.to, coveredFrom, coveredThrough,
      bucketFrom: Math.floor(q.from / q.interval) * q.interval,
      bucketThrough: Math.floor(q.to / q.interval) * q.interval,
      coverageProof: {
        kind: "resolver-watermark-prefix-v3", authority: "provisional", authorityToken,
        projectionThroughId: watermark, requestedFrom: q.from, requestedTo: q.to,
        coveredFrom, coveredThrough, watermarkComplete: true, prefixProof,
      },
    };
  }
  return meta;
}

function harness(metaFactory) {
  resetFootprintSupport();
  let session;
  const tradeSubs = new Set();
  const reporterEvents = [];
  const scheduledRetries = [];
  const services = {
    subscribeToTrades(_market, cb) { tradeSubs.add(cb); return () => tradeSubs.delete(cb); },
    subscribeToTradeSessions(cb) { session = cb; return () => { session = null; }; },
    fetchHistory: async (q) => { q.onMeta?.(metaFactory(q)); return []; },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() { return { report(state, detail) { reporterEvents.push({ state, detail }); }, dispose() {} }; },
    emit(value) { for (const cb of tradeSubs) cb(value); },
    reconnect(generation, boundaryAt) { session?.({ generation, epoch: generation, session: `s-${generation}`, boundaryAt }); },
  };
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: 60_000, priceStep: 1, services });
  pipeline.setRecentCoverageRetryScheduler((_attempt, retry) => scheduledRetries.push(retry));
  const release = () => pipeline.setRecentCoverageRetryScheduler(null);
  return { services, pipeline, reporterEvents, scheduledRetries, dispose() { release(); pipeline.dispose(); resetFootprintSupport(); } };
}

test("explicit market_not_allowed ends reconnect repair and keeps candle-only flow live", async (t) => {
  useFakeChartDataSource(t);
  const h = harness((q) => repairMeta(q, { allowed: false, authority: null, reasonCode: "market_not_allowed", projectionThroughId: null, authorityToken: null, snapshot: false }));
  const start = 60_000;
  h.pipeline.series.upsertBar(bar(start));
  h.services.reconnect(1, start);
  await flush();
  assert.equal(h.scheduledRetries.length, 0, "unsupported market must not retry repair forever");
  assert.equal(h.pipeline.series.length, 1, "repair barrier must not hide an existing candle");
  h.services.emit(trade(start + 2_000, "102", 3, 100.2));
  await flush();
  const live = h.pipeline.series.get(start);
  assert.equal(live.volume, 3);
  assert.equal(live.count, 1);
  assert.equal(live.close, 100.2);
  assert.equal(live.cells.size, 0, "unsupported market stays candle-only");
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  h.dispose();
});

test("unknown support is not treated as unsupported", async (t) => {
  useFakeChartDataSource(t);
  const h = harness((q) => repairMeta(q, { snapshot: false }));
  h.services.reconnect(1, 60_000);
  await flush();
  assert.equal(h.scheduledRetries.length, 1, "missing support information must retain normal retry behavior");
  assert.equal(h.reporterEvents.at(-1)?.state, "pending");
  h.dispose();
});

test("repair barrier preserves candle visibility and OHLC maintenance", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, referenceMarket: "M" });
  series.upsertBar(bar(60_000));
  series.beginRepairBarrier([60_000]);
  assert.equal(series.length, 1);
  assert.equal(series.at(0)?.startTime, 60_000);
  series.reassertOHLC(60_000, 99, 105, 98, { close: 103, preferIncomingClose: true, observedAt: 70_000 });
  assert.deepEqual(
    { open: series.get(60_000).open, high: series.get(60_000).high, low: series.get(60_000).low, close: series.get(60_000).close },
    { open: 99, high: 105, low: 98, close: 103 },
  );
});

test("daily first trade milliseconds after midnight is accepted with monotonic aggregate-ID prefix proof", async (t) => {
  useFakeChartDataSource(t);
  const day = Date.UTC(2026, 8, 9);
  const firstEvent = day + 123;
  const h = harness((q) => repairMeta(q, {
    coveredFrom: firstEvent,
    prefixProof: {
      kind: "adjacent-agg-id-prefix-v1", requestedFrom: q.from, firstEventTime: firstEvent,
      previousProjectionId: "100", firstAggregateId: "101",
    },
  }));
  h.services.reconnect(1, day + 1);
  h.services.emit(trade(day + 2, "102"));
  await flush();
  assert.equal(h.scheduledRetries.length, 0);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  h.dispose();
});

test("forward aggregate-ID jump in prefix proof remains valid when IDs are monotonic", async (t) => {
  useFakeChartDataSource(t);
  const day = Date.UTC(2026, 8, 9);
  const firstEvent = day + 123;
  const h = harness((q) => repairMeta(q, {
    coveredFrom: firstEvent,
    prefixProof: {
      kind: "adjacent-agg-id-prefix-v1", requestedFrom: q.from, firstEventTime: firstEvent,
      previousProjectionId: "99", firstAggregateId: "101",
    },
  }));
  h.services.reconnect(1, day + 1);
  h.services.emit(trade(day + 2, "102"));
  await flush();
  assert.equal(h.scheduledRetries.length, 0);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  h.dispose();
});

test("explicit unsupported support disables cells without disabling candle totals", () => {
  resetFootprintSupport();
  recordFootprintSupport("M", false);
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, referenceMarket: "M" });
  const now = Date.now();
  series.addTrade(trade(now, "1", 2, 123));
  const live = series.get(Math.floor(now / 60_000) * 60_000);
  assert.equal(live.volume, 2);
  assert.equal(live.count, 1);
  assert.equal(live.cells.size, 0);
  resetFootprintSupport();
});
