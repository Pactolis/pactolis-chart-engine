import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const BASE = Date.UTC(2024, 0, 1);
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const trade = (id, time = BASE + 60_001, qty = 1) => ({
  id: String(id), time, price: 10_000, qty, isBuy: true, liquidation: false,
  market: "M", source: "live", receivedAt: time + 1,
});
const bar = (startTime, volume) => ({
  startTime, open: 10_000, high: 10_000, low: 10_000, close: 10_000,
  volume, delta: volume, count: volume, liquidationBuyVol: 0, liquidationSellVol: 0,
  cells: new Map([[10_000, { priceBin: 10_000, buyVol: volume, sellVol: 0, count: volume, buyCount: volume, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
  hasRef: true, completeness: "complete", sources: ["history"], updatedAt: BASE + 60_000,
});
const totalVolume = (series) => series.listReadonly().reduce((sum, item) => sum + item.volume, 0);

function repairMeta(q, overrides = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const watermark = has("watermark") ? overrides.watermark : "100";
  const token = has("authorityToken") ? overrides.authorityToken : "token";
  const coveredFrom = has("coveredFrom") ? overrides.coveredFrom : q.from;
  const coveredThrough = has("coveredThrough") ? overrides.coveredThrough : q.to;
  const status = has("status") ? overrides.status : "complete";
  const authority = overrides.authority ?? "provisional";
  const complete = Number.isFinite(coveredFrom) && Number.isFinite(coveredThrough) && coveredFrom <= q.from && coveredThrough >= q.to;
  const meta = {
    schemaVersion: 2,
    generatedAt: BASE + 60_000,
    degraded: overrides.degraded,
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      authority,
      status,
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      durableThroughId: null,
      projectionThroughId: watermark,
      authorityToken: token,
      reasonCode: overrides.reasonCode ?? null,
    },
  };
  if (overrides.omitRepair !== true && watermark !== null && token && !["gap", "degraded", "error"].includes(status)) {
    meta.repairSnapshot = {
      schemaVersion: 1,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      interval: q.interval,
      priceStep: q.priceStep,
      authority,
      authorityToken: token,
      watermark,
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      bucketFrom: Math.floor(q.from / q.interval) * q.interval,
      bucketThrough: Math.floor(q.to / q.interval) * q.interval,
      coverageProof: {
        kind: "resolver-contiguous-v1",
        authority,
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

function harness(fetchHistory) {
  let session;
  const subs = new Set();
  const reporterEvents = [];
  const degraded = [];
  const services = {
    subscribeToTrades(_market, cb) { subs.add(cb); return () => subs.delete(cb); },
    subscribeToTradeSessions(cb) { session = cb; return () => { session = undefined; }; },
    fetchHistory,
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      return { report(state, detail) { reporterEvents.push({ state, detail }); }, dispose() { reporterEvents.push({ state: "disposed" }); } };
    },
  };
  const pipeline = new ChartDataPipeline({
    market: "M", intervalMs: 60_000, priceStep: 1, services,
    onDataDegraded: (value, detail) => degraded.push({ value, detail }),
  });
  return {
    pipeline, reporterEvents, degraded,
    emit(value) { for (const cb of subs) cb(value); },
    reconnect(generation, boundaryAt = BASE + 60_000) {
      session?.({ generation, epoch: generation, session: `s-${generation}`, boundaryAt });
    },
  };
}

async function successfulRepair(h, pending, historyBars = [bar(BASE, 10)]) {
  h.emit(trade(101));
  pending.resolve(historyBars);
  await tick(5);
}

test("first ACK owns one repair; stale or duplicate generations cannot start another", async (t) => {
  useFakeChartDataSource(t);
  const first = deferred(); const second = deferred(); let calls = 0;
  const h = harness((q) => { q.onMeta?.(repairMeta(q)); return ++calls === 1 ? first.promise : second.promise; });
  h.reconnect(9); h.emit(trade(101));
  assert.equal(calls, 1);
  first.resolve([bar(BASE, 10)]); await tick(5);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  h.reconnect(9); h.reconnect(8);
  assert.equal(calls, 1);
  h.reconnect(10); h.emit(trade(101));
  assert.equal(calls, 2);
  second.resolve([bar(BASE, 10)]); await tick(5);
  h.pipeline.dispose();
});

test("null coveredFrom and null W are never coerced into an applicable snapshot", async (t) => {
  useFakeChartDataSource(t);
  for (const overrides of [{ coveredFrom: null }, { watermark: null }]) {
    const pending = deferred();
    const h = harness((q) => { q.onMeta?.(repairMeta(q, overrides)); return pending.promise; });
    h.reconnect(1); h.emit(trade(101)); pending.resolve([bar(BASE, 999)]); await tick(5);
    assert.equal(h.pipeline.series.listReadonly().some((b) => b.volume === 999), false);
    assert.equal(h.reporterEvents.at(-1)?.state, "pending");
    h.pipeline.dispose();
  }
});

test("older reconnect completion cannot mutate after a newer transport generation supersedes it", async (t) => {
  useFakeChartDataSource(t);
  const first = deferred(); const second = deferred(); let calls = 0;
  const h = harness((q) => { q.onMeta?.(repairMeta(q)); return ++calls === 1 ? first.promise : second.promise; });
  h.reconnect(1); h.emit(trade(101));
  h.reconnect(2); h.emit(trade(102, BASE + 60_002));
  first.resolve([bar(BASE, 999)]); await tick(3);
  assert.equal(h.pipeline.series.listReadonly().some((b) => b.volume === 999), false);
  second.resolve([bar(BASE, 10)]); await tick(5);
  assert.equal(totalVolume(h.pipeline.series), 12, "new snapshot plus unique 101/102 tail owns the complete repair range");
  h.pipeline.dispose();
});

test("repair query selects the complete bucket instead of stopping at reconnect timestamp", async (t) => {
  useFakeChartDataSource(t);
  const pending = deferred(); let query;
  const h = harness((q) => { query = q; q.onMeta?.(repairMeta(q)); return pending.promise; });
  h.reconnect(1, BASE + 60_000); h.emit(trade(101));
  pending.resolve([bar(BASE, 10)]); await tick(5);
  assert.equal(query.from, BASE);
  assert.equal(query.to, BASE + 119_999);
  h.pipeline.dispose();
});

test("BigInt W is exact and duplicate buffered IDs are applied once", async (t) => {
  useFakeChartDataSource(t);
  const W = "9007199254740993";
  const pending = deferred();
  const h = harness((q) => { q.onMeta?.(repairMeta(q, { watermark: W })); return pending.promise; });
  h.reconnect(1);
  h.emit(trade("9007199254740994"));
  h.emit(trade("9007199254740994"));
  pending.resolve([bar(BASE, 10)]); await tick(5);
  assert.equal(totalVolume(h.pipeline.series), 11);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  h.pipeline.dispose();
});

test("forward aggregate-ID jumps apply the snapshot and emit healthy when transport continuity is intact", async (t) => {
  useFakeChartDataSource(t);
  const pending = deferred();
  const h = harness((q) => { q.onMeta?.(repairMeta(q)); return pending.promise; });
  h.reconnect(1);
  h.emit(trade(101)); h.emit(trade(103, BASE + 60_003));
  pending.resolve([bar(BASE, 999)]); await tick(5);
  assert.equal(totalVolume(h.pipeline.series), 1001);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  h.pipeline.dispose();
});

test("watermark regression preserves the last-good repaired state", async (t) => {
  useFakeChartDataSource(t);
  const first = deferred(); const second = deferred(); let calls = 0;
  const h = harness((q) => {
    const watermark = calls++ === 0 ? "100" : "99";
    q.onMeta?.(repairMeta(q, { watermark }));
    return calls === 1 ? first.promise : second.promise;
  });
  h.reconnect(1); h.emit(trade(101)); first.resolve([bar(BASE, 10)]); await tick(5);
  assert.equal(totalVolume(h.pipeline.series), 11);
  h.reconnect(2); h.emit(trade(100)); second.resolve([bar(BASE, 999)]); await tick(5);
  assert.equal(h.pipeline.series.listReadonly().some((b) => b.volume === 999), false);
  assert.equal(h.reporterEvents.at(-1)?.state, "error");
  h.pipeline.dispose();
});

test("gap/degraded/error coverage is not presented as an applicable repair snapshot", async (t) => {
  useFakeChartDataSource(t);
  for (const status of ["gap", "degraded", "error"]) {
    const pending = deferred();
    const h = harness((q) => { q.onMeta?.(repairMeta(q, { status })); return pending.promise; });
    h.reconnect(1); h.emit(trade(101)); pending.resolve([bar(BASE, 999)]); await tick(5);
    assert.equal(h.pipeline.series.listReadonly().some((b) => b.volume === 999), false, status);
    assert.notEqual(h.reporterEvents.at(-1)?.state, "healthy", status);
    h.pipeline.dispose();
  }
});

test("explicit degradation sticks and cannot be cleared by a later clean metadata callback in the same repair", async (t) => {
  useFakeChartDataSource(t);
  const pending = deferred();
  const h = harness((q) => {
    q.onMeta?.({ degraded: true, provenance: [{ error: "projection failed" }] });
    q.onMeta?.(repairMeta(q));
    return pending.promise;
  });
  h.reconnect(1); h.emit(trade(101)); pending.resolve([bar(BASE, 999)]); await tick(5);
  assert.equal(h.pipeline.series.listReadonly().some((b) => b.volume === 999), false);
  assert.equal(h.reporterEvents.at(-1)?.state, "error");
  assert.equal(h.degraded.at(-1)?.value, true);
  h.pipeline.dispose();
});

test("repair buffer overflow starts a bounded resync and fences the late snapshot", async (t) => {
  useFakeChartDataSource(t);
  const first = deferred(); const second = deferred();
  const signals = []; let calls = 0;
  const h = harness((q) => {
    const index = calls++;
    signals.push(q.signal);
    q.onMeta?.(repairMeta(q, { watermark: index === 0 ? "100" : "10100" }));
    return index === 0 ? first.promise : second.promise;
  });
  h.reconnect(1);
  for (let i = 0; i < 10_001; i++) h.emit(trade(101 + i, BASE + 60_001 + i));

  assert.equal(calls, 2, "overflow immediately starts a fresh repair");
  assert.equal(signals[0].aborted, true, "the superseded snapshot is fenced");
  assert.equal(signals[1].aborted, false);
  assert.equal(h.reporterEvents.at(-1)?.state, "pending");
  assert.match(h.reporterEvents.at(-1)?.detail ?? "", /resynchronizing \(1\/4\)/);

  first.resolve([bar(BASE, 999)]); await tick(3);
  assert.equal(h.pipeline.series.listReadonly().some((b) => b.volume === 999), false);

  second.resolve([bar(BASE, 10)]); await tick(5);
  assert.equal(h.reporterEvents.at(-1)?.state, "healthy");
  assert.equal(totalVolume(h.pipeline.series), 11, "snapshot through 10100 joins buffered trade 10101 exactly once");
  h.pipeline.dispose();
});

test("dispose aborts repair and fences all late callbacks", async (t) => {
  useFakeChartDataSource(t);
  const pending = deferred(); let signal;
  const h = harness((q) => { signal = q.signal; q.onMeta?.(repairMeta(q)); return pending.promise; });
  h.reconnect(1); h.emit(trade(101)); h.pipeline.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(h.reporterEvents.at(-1)?.state, "disposed");
  pending.resolve([bar(BASE, 999)]); await tick(3);
  assert.equal(h.pipeline.series.listReadonly().some((b) => b.volume === 999), false);
});