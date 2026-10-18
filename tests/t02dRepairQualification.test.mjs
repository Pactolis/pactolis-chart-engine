import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

// T02-D (#311) remaining qualification at the public pipeline boundary for the
// trade-id repair path: reentrant callbacks, reconnects, resets, second owners,
// overflow and cancellation. The oracle is always the independent trade set.
const INTERVAL = 120_000;
const START = Date.UTC(2024, 0, 1, 0, 0, 0);
const NOW = START + 90_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function manualScheduler() {
  let next = 1;
  const callbacks = new Map();
  return {
    request(cb) { const id = next++; callbacks.set(id, cb); return id; },
    cancel(id) { callbacks.delete(id); },
    flushAll() {
      for (let guard = 0; callbacks.size && guard < 1_000; guard++) {
        const batch = [...callbacks.entries()];
        callbacks.clear();
        for (const [, cb] of batch) cb();
      }
    },
  };
}

function trade(id, time, price, qty, isBuy, market = "M") {
  return Object.freeze({ id: String(id), time, price, qty, tradeCount: 1, isBuy, liquidation: false, market, source: "live", receivedAt: time + 1 });
}

/** Independent oracle: the candle and footprint of `trades` in bucket START. */
function aggregate(trades, startTime = START) {
  const cells = new Map();
  for (const t of trades) {
    let cell = cells.get(t.price);
    if (!cell) {
      cell = { priceBin: t.price, buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0, liquidationBuyVol: 0, liquidationSellVol: 0 };
      cells.set(t.price, cell);
    }
    cell.count++;
    if (t.isBuy) { cell.buyVol += t.qty; cell.buyCount++; } else { cell.sellVol += t.qty; cell.sellCount++; }
  }
  return {
    startTime,
    open: trades[0].price,
    high: Math.max(...trades.map((t) => t.price)),
    low: Math.min(...trades.map((t) => t.price)),
    close: trades.at(-1).price,
    volume: trades.reduce((n, t) => n + t.qty, 0),
    delta: trades.reduce((n, t) => n + (t.isBuy ? t.qty : -t.qty), 0),
    count: trades.length,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells,
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime + 60_000,
  };
}

function cloneBar(bar) {
  return { ...bar, cells: new Map([...bar.cells].map(([price, cell]) => [price, { ...cell }])) };
}

function summary(bar) {
  assert.ok(bar, "expected a candle");
  const cells = [...bar.cells]
    .filter(([, cell]) => cell.count > 0 || cell.buyVol > 0 || cell.sellVol > 0)
    .sort(([a], [b]) => a - b)
    .map(([price, cell]) => [price, cell.buyVol, cell.sellVol, cell.count]);
  return { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count, cells };
}

function repairMeta(q, watermark) {
  const coveredFrom = q.from;
  const coveredThrough = START + 60_000;
  const proof = {
    authority: "provisional", authorityToken: "projection-1",
    requestedFrom: q.from, requestedTo: q.to, coveredFrom, coveredThrough,
  };
  return {
    schemaVersion: 2,
    generatedAt: START + 60_000,
    footprintCoverage: {
      schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: q.reference, status: "pending",
      durableThroughId: null, projectionThroughId: watermark, reasonCode: null, ...proof,
    },
    repairSnapshot: {
      schemaVersion: 2, mode: "trade-id-v1", source: "binance-usdm-aggTrade", instrument: q.reference,
      interval: q.interval, priceStep: q.priceStep, watermark, bucketFrom: START, bucketThrough: START, ...proof,
      coverageProof: { kind: "resolver-watermark-contiguous-v2", projectionThroughId: watermark, watermarkComplete: true, ...proof },
    },
  };
}

// W = 102 covers these; the snapshot bar is exactly their aggregate.
const PROJECTION = [
  trade(100, START + 10_000, 10_000, 5, true),
  trade(101, START + 20_000, 9_999, 3, false),
  trade(102, START + 50_000, 10_001, 5, true),
];
const TAIL = [
  trade(103, START + 70_000, 10_002, 2, false),
  trade(104, START + 80_000, 9_998, 1, true),
];

/**
 * One public pipeline. `answer(q)` decides each repair request: return
 * { watermark, bars } to resolve, or a deferred to hold it.
 */
function makeRepairFixture({ market = "M", answer } = {}) {
  const scheduler = manualScheduler();
  const hooks = {};
  const subscribers = new Set();
  const sessions = new Set();
  const reports = [];
  const degraded = [];
  const updates = [];
  const queries = [];
  const services = {
    subscribeToTrades(_market, cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
    subscribeToTradeSessions(cb) { sessions.add(cb); return () => sessions.delete(cb); },
    fetchHistory(q) {
      queries.push(q);
      const reply = answer?.(q, queries.length) ?? { watermark: "102", bars: [cloneBar(aggregate(PROJECTION))] };
      if (reply.promise) return reply.promise;
      q.onMeta?.(repairMeta(q, reply.watermark));
      return Promise.resolve(reply.bars);
    },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      return { report(state, detail = "") { reports.push([state, detail]); hooks.onReport?.(state, detail); }, dispose() {} };
    },
  };
  const pipeline = new ChartDataPipeline({
    market, intervalMs: INTERVAL, priceStep: 1, services, scheduler,
    onDataDegraded: (value, detail) => { degraded.push([value, detail]); hooks.onDegraded?.(value, detail); },
  });
  pipeline.onUpdate = (event) => updates.push(event.kind);
  const fixture = {
    hooks, pipeline, scheduler, reports, degraded, updates, queries,
    emit(value) { for (const cb of subscribers) cb(value); },
    session(generation, boundaryAt = START + 60_000) {
      for (const cb of sessions) cb({ generation, epoch: 1, session: "s" + generation, boundaryAt });
    },
    async settle() {
      for (let i = 0; i < 8; i++) await new Promise(setImmediate);
      scheduler.flushAll();
    },
  };
  return fixture;
}

async function withClock(run) {
  const previousNow = Date.now;
  Date.now = () => NOW;
  try { return await run(); } finally { Date.now = previousNow; }
}

test("T02-D REPAIR-REENTRANT: a reset inside the repair's degraded callback suppresses the stale history event", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const fixture = makeRepairFixture();
    try {
      let resets = 0;
      fixture.hooks.onDegraded = (value) => {
        if (value === false && resets === 0 && fixture.reports.at(-1)?.[0] === "healthy") {
          resets++;
          fixture.pipeline.setPriceStep(2);
        }
      };
      fixture.session(1);
      for (const t of TAIL) fixture.emit(t);
      await fixture.settle();
      assert.equal(resets, 1, "precondition: the callback reset the pipeline during the repair commit");
      const reset = fixture.updates.lastIndexOf("price-step-reset");
      assert.ok(reset >= 0);
      assert.deepEqual(fixture.updates.slice(reset + 1).filter((kind) => kind === "history-patched"), [],
        "the old repair published a history event for the series it no longer owns");
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D REPAIR-REENTRANT: a reconnect raised from the healthy report keeps the new repair pending", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const held = deferred();
    const fixture = makeRepairFixture({ answer: (_q, n) => (n === 1 ? undefined : held) });
    try {
      let reconnects = 0;
      let degradedAtReconnect = -1;
      fixture.hooks.onReport = (state) => {
        if (state === "healthy" && reconnects === 0) {
          reconnects++;
          fixture.session(2, START + 85_000);
          degradedAtReconnect = fixture.degraded.length;
        }
      };
      fixture.session(1);
      for (const t of TAIL) fixture.emit(t);
      await fixture.settle();
      assert.equal(reconnects, 1, "precondition: the reconnect happened inside the healthy report");
      assert.equal(fixture.queries.length, 2, "the reconnect started its own repair");
      assert.notEqual(fixture.reports.at(-1)?.[0], "healthy", "the old repair overwrote the new repair's pending state");
      // The old repair must not clear the degraded state on the new repair's behalf either.
      assert.deepEqual(fixture.degraded.slice(degradedAtReconnect), [], "the old repair kept writing after the reconnect");
    } finally {
      held.resolve([]);
      fixture.pipeline.dispose();
    }
  });
});

async function repairedFixture(options) {
  const fixture = makeRepairFixture(options);
  fixture.session(1);
  for (const t of TAIL) fixture.emit(t);
  await fixture.settle();
  assert.equal(fixture.reports.at(-1)?.[0], "healthy", "precondition: the first repair committed");
  assert.deepEqual(summary(fixture.pipeline.series.get(START)), summary(aggregate([...PROJECTION, ...TAIL])));
  return fixture;
}

test("T02-D I1: an immutable reconnect replay under a higher transport generation changes nothing", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const all = [...PROJECTION, ...TAIL];
    const fixture = await repairedFixture({
      // The reconnect snapshot proves everything through 104 (inclusive).
      answer: (_q, n) => (n === 1 ? undefined : { watermark: "104", bars: [cloneBar(aggregate(all))] }),
    });
    try {
      fixture.session(2, START + 85_000);
      // Same market/id/payload re-delivered after the reconnect, plus live evidence past the boundary.
      for (const t of TAIL) fixture.emit(t);
      const next = trade(105, START + 88_000, 10_003, 4, false);
      fixture.emit(next);
      for (const t of [...TAIL, next]) fixture.emit(t);
      await fixture.settle();
      assert.equal(fixture.queries.length, 2, "the reconnect ran its own repair");
      assert.equal(fixture.reports.at(-1)?.[0], "healthy");
      assert.deepEqual(summary(fixture.pipeline.series.get(START)), summary(aggregate([...all, next])));
      assert.equal(fixture.pipeline.series.identityConflictCount, 0);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D I1: a stale-generation session after the reconnect is ignored", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const fixture = await repairedFixture();
    try {
      const requests = fixture.queries.length;
      fixture.session(0, START + 85_000);
      await fixture.settle();
      assert.equal(fixture.queries.length, requests);
      assert.equal(fixture.reports.at(-1)?.[0], "healthy");
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D older event time above W: a late trade with id > W lands once in the closed snapshot bucket, id <= W never", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const fixture = await repairedFixture();
    try {
      // Event time inside the snapshot's own range, but the id is newer than W.
      const late = trade(106, START + 30_000, 10_000, 7, false);
      fixture.emit(late);
      fixture.emit(late);
      fixture.emit(trade(99, START + 5_000, 10_000, 9, true));
      fixture.emit(trade(102, START + 50_000, 10_001, 5, true));
      fixture.scheduler.flushAll();
      const expected = aggregate([...PROJECTION, ...TAIL]);
      const bar = summary(fixture.pipeline.series.get(START));
      assert.equal(bar.volume, expected.volume + 7);
      assert.equal(bar.delta, expected.delta - 7);
      assert.equal(bar.count, expected.count + 1);
      // Event-time order: a late trade never moves the close or open.
      assert.equal(bar.open, expected.open);
      assert.equal(bar.close, expected.close);
      const cell = fixture.pipeline.series.get(START).cells.get(10_000);
      assert.equal(cell.sellVol, 7);
      assert.equal(cell.buyVol, 5);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D P1: a sessionless series reset applies the same immutable events once in the new series", async () => {
  await withClock(async () => {
    const events = [trade(1, START + 1_000, 10_000, 2, true), trade(2, START + 2_000, 10_001, 3, false)];
    const resets = {
      "same-step setPriceStep": async (pipeline) => pipeline.setPriceStep(1),
      "timeframe change": async (pipeline) => pipeline.changeConfig({ intervalMs: 60_000 }),
      "market clear": async (pipeline) => {
        await pipeline.changeConfig({ market: "N" });
        await pipeline.changeConfig({ market: "M" });
      },
    };
    for (const [name, reset] of Object.entries(resets)) {
      const fixture = makeRepairFixture();
      try {
        for (const t of events) fixture.emit(t);
        fixture.scheduler.flushAll();
        assert.deepEqual(summary(fixture.pipeline.series.get(START)), summary(aggregate(events)), name);
        await reset(fixture.pipeline);
        // Replay after the reset: each immutable event twice.
        for (const t of [...events, ...events]) fixture.emit(t);
        fixture.scheduler.flushAll();
        assert.deepEqual(summary(fixture.pipeline.series.get(START)), summary(aggregate(events)), name);
        assert.equal(fixture.pipeline.series.identityConflictCount, 0, name);
        assert.equal(fixture.queries.length, 0, name + ": sessionless resets start no repair");
      } finally {
        fixture.pipeline.dispose();
      }
    }
  });
});

test("T02-D session-active reset: a reset during a repair drops the old snapshot and old watermark", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const held = deferred();
    const fixture = makeRepairFixture({ answer: (_q, n) => (n === 1 ? held : undefined) });
    try {
      fixture.session(1);
      for (const t of TAIL) fixture.emit(t);
      await fixture.settle();
      assert.equal(fixture.queries.length, 1);
      fixture.pipeline.setPriceStep(1);
      // The superseded response arrives with its proof; it must not reach the new series.
      const q = fixture.queries[0];
      q.onMeta?.(repairMeta(q, "102"));
      held.resolve([cloneBar(aggregate(PROJECTION))]);
      await fixture.settle();
      assert.equal(fixture.pipeline.series.get(START), undefined, "the old snapshot reached the reset series");
      assert.equal(fixture.reports.at(-1)?.[0], "healthy", "the reset itself reports healthy");
      const afterReset = fixture.reports.length;
      // The old W (102) no longer fences anything: ids <= 102 apply once in the new series.
      const replay = [...PROJECTION, ...TAIL];
      for (const t of [...replay, ...replay]) fixture.emit(t);
      fixture.scheduler.flushAll();
      assert.deepEqual(summary(fixture.pipeline.series.get(START)), summary(aggregate(replay)));
      assert.deepEqual(fixture.reports.slice(afterReset), []);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D cancellation: a repair cancelled by a timeframe change never reports healthy from its late response", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const held = deferred();
    const fixture = makeRepairFixture({ answer: (_q, n) => (n === 1 ? held : undefined) });
    try {
      fixture.session(1);
      for (const t of TAIL) fixture.emit(t);
      await fixture.settle();
      assert.equal(fixture.queries[0].signal.aborted, false);
      await fixture.pipeline.changeConfig({ intervalMs: 60_000 });
      assert.equal(fixture.queries[0].signal.aborted, true, "the cancelled repair's request is aborted");
      const reports = fixture.reports.length;
      const updates = fixture.updates.length;
      const q = fixture.queries[0];
      q.onMeta?.(repairMeta(q, "102"));
      held.resolve([cloneBar(aggregate(PROJECTION))]);
      await fixture.settle();
      assert.deepEqual(fixture.reports.slice(reports), []);
      assert.deepEqual(fixture.updates.slice(updates), []);
      assert.equal(fixture.pipeline.series.length, 0);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D second owner: another pipeline on the same market is unaffected by the first one's repair and resets", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const fixture = makeRepairFixture();
    const servicesB = {
      subscribeToTrades(_market, cb) { fixture.hooks.b = cb; return () => { fixture.hooks.b = null; }; },
      fetchPriceStep: async () => 1,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync() {},
    };
    const schedulerB = manualScheduler();
    const b = new ChartDataPipeline({ market: "M", intervalMs: INTERVAL, priceStep: 1, services: servicesB, scheduler: schedulerB });
    const updatesB = [];
    b.onUpdate = (event) => updatesB.push(event.kind);
    const emitBoth = (t) => { fixture.emit(t); fixture.hooks.b?.(t); };
    try {
      const own = [trade(201, START + 1_000, 10_000, 2, true), trade(202, START + 2_000, 10_001, 3, false)];
      for (const t of own) emitBoth(t);
      schedulerB.flushAll();
      // A runs a repair and two resets; B never sees any of it.
      fixture.session(1);
      for (const t of TAIL) fixture.emit(t);
      await fixture.settle();
      fixture.pipeline.setPriceStep(2);
      await fixture.pipeline.changeConfig({ intervalMs: 60_000 });
      for (const t of own) fixture.emit(t);
      fixture.scheduler.flushAll();
      // Oracle for B: buy 2 + sell 3 → OHLC 10000/10001/10000/10001, V5, D-1, N2.
      assert.deepEqual(summary(b.series.get(START)), {
        open: 10_000, high: 10_001, low: 10_000, close: 10_001, volume: 5, delta: -1, count: 2,
        cells: [[10_000, 2, 0, 1], [10_001, 0, 3, 1]],
      });
      // Positive guard: B still owns its own updates.
      const before = updatesB.length;
      emitBoth(trade(203, START + 3_000, 10_002, 1, true));
      schedulerB.flushAll();
      assert.ok(updatesB.length > before, "B's next update arrives");
      assert.equal(b.series.get(START).volume, 6);
    } finally {
      b.dispose();
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D repeated overflow: resyncs stop at the limit with an error, never a false healthy, and a new session recovers", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const helds = [];
    let recover = null;
    const fixture = makeRepairFixture({
      answer: () => {
        if (recover) return recover;
        const held = deferred();
        helds.push(held);
        return held;
      },
    });
    try {
      fixture.session(1);
      await fixture.settle();
      assert.equal(fixture.queries.length, 1);
      // Five buffers' worth of distinct trades while every repair request hangs. The
      // queue is drained as it goes so only the repair buffer can overflow.
      const CAP = 10_000;
      const LIMIT = 4;
      const trades = [];
      for (let n = 0; n < (LIMIT + 1) * CAP + 1; n++) {
        const t = trade(1_000 + n, START + 60_000 + Math.floor(n / 2), 10_000 + (n % 2), 1, n % 2 === 0);
        trades.push(t);
        fixture.emit(t);
        if (n % 1_000 === 999) fixture.scheduler.flushAll();
      }
      fixture.scheduler.flushAll();
      await fixture.settle();
      assert.equal(fixture.queries.length, 1 + LIMIT, "one request plus one per allowed resync");
      assert.ok(fixture.queries.slice(0, LIMIT).every((q) => q.signal.aborted), "every superseded request is aborted");
      const resyncs = fixture.reports.filter(([, detail]) => /resynchronizing \(\d\/4\)/.test(detail)).map(([, detail]) => detail.match(/\((\d)\/4\)/)[1]);
      assert.deepEqual(resyncs, ["1", "2", "3", "4"]);
      assert.deepEqual(fixture.reports.at(-1), ["error", "Trade stream repair buffer overflow"]);
      assert.deepEqual(fixture.degraded.at(-1), [true, "Trade stream repair buffer overflow"]);
      // The first entry is the reporter's construction baseline, before any repair existed.
      const firstPending = fixture.reports.findIndex(([state]) => state === "pending");
      assert.equal(fixture.reports.slice(firstPending).some(([state]) => state === "healthy"), false, "no false healthy at any point");
      // Late answers to the abandoned requests change nothing.
      for (const [i, held] of helds.entries()) {
        const q = fixture.queries[i];
        q.onMeta?.(repairMeta(q, "102"));
        held.resolve([cloneBar(aggregate(PROJECTION))]);
      }
      await fixture.settle();
      assert.deepEqual(fixture.reports.at(-1), ["error", "Trade stream repair buffer overflow"]);

      // A new transport session repairs from a proof covering everything so far.
      const all = [...PROJECTION, ...trades];
      const watermark = String(1_000 + (LIMIT + 1) * CAP);
      recover = { watermark, bars: [cloneBar(aggregate(all))] };
      fixture.session(2, START + 85_000);
      fixture.emit(trade(1_000 + (LIMIT + 1) * CAP + 1, START + 86_000, 10_000, 1, true));
      await fixture.settle();
      assert.equal(fixture.reports.at(-1)?.[0], "healthy");
      const final = summary(fixture.pipeline.series.get(START));
      const oracle = summary(aggregate([...all, trade(1_000 + (LIMIT + 1) * CAP + 1, START + 86_000, 10_000, 1, true)]));
      assert.equal(final.volume, oracle.volume);
      assert.equal(final.delta, oracle.delta);
      assert.equal(final.count, oracle.count);
      assert.deepEqual(final.cells, oracle.cells);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

// PR421 regressions: metadata validation and stream liveness are independent gates.
test("T02-D REPAIR-MISSING-METADATA: missing repairSnapshot stays pending; valid metadata is accepted", async () => {
  const { repairSnapshotReason } = await import("../dist/features/chart/LiveTradeRepairController.js");
  const q = { reference: "M", from: START, to: START + INTERVAL - 1, interval: INTERVAL, priceStep: 1 };
  const reason = (meta) => repairSnapshotReason(meta, "M", q.from, q.to, INTERVAL, 1, null);
  const valid = repairMeta(q, "102");
  const { repairSnapshot: _snapshot, ...ordinary } = valid;
  assert.deepEqual(reason(ordinary), { state: "pending", detail: "Trade-id repair snapshot contract unavailable" });
  assert.equal(reason(valid), null, "independent positive: the same range with valid repair metadata");
});

test("T02-D REPAIR-WRONG-IDENTITY: another instrument stays pending; matching identity is accepted", async () => {
  const { repairSnapshotReason } = await import("../dist/features/chart/LiveTradeRepairController.js");
  const q = { reference: "M", from: START, to: START + INTERVAL - 1, interval: INTERVAL, priceStep: 1 };
  const valid = repairMeta(q, "102");
  const wrong = { ...valid, repairSnapshot: { ...valid.repairSnapshot, instrument: "N" } };
  const reason = (meta) => repairSnapshotReason(meta, "M", q.from, q.to, INTERVAL, 1, null);
  assert.deepEqual(reason(wrong), { state: "pending", detail: "Trade-id repair snapshot identity mismatch" });
  assert.equal(reason(valid), null, "independent positive: matching instrument");
});

test("T02-D REPAIR-INCOMPLETE-PROOF: an unproven watermark stays pending; complete V2 proof is accepted", async () => {
  const { repairSnapshotReason } = await import("../dist/features/chart/LiveTradeRepairController.js");
  const q = { reference: "M", from: START, to: START + INTERVAL - 1, interval: INTERVAL, priceStep: 1 };
  const valid = repairMeta(q, "102");
  const invalid = { ...valid, repairSnapshot: { ...valid.repairSnapshot,
    coverageProof: { ...valid.repairSnapshot.coverageProof, watermarkComplete: false } } };
  const reason = (meta) => repairSnapshotReason(meta, "M", q.from, q.to, INTERVAL, 1, null);
  assert.deepEqual(reason(invalid), { state: "pending",
    detail: "Trade-id repair snapshot does not prove the requested prefix through its watermark" });
  assert.equal(reason(valid), null, "independent positive: complete resolver watermark proof");
});

test("T02-D REPAIR-WATERMARK-REGRESSION: a lower watermark errors; equal and advancing watermarks are accepted", async () => {
  const { repairSnapshotReason } = await import("../dist/features/chart/LiveTradeRepairController.js");
  const q = { reference: "M", from: START, to: START + INTERVAL - 1, interval: INTERVAL, priceStep: 1 };
  const reason = (watermark) => repairSnapshotReason(repairMeta(q, watermark), "M", q.from, q.to, INTERVAL, 1, 102n);
  assert.deepEqual(reason("101"), { state: "error", detail: "Trade-id repair snapshot watermark regressed" });
  assert.equal(reason("102"), null, "independent positive: equal watermark");
  assert.equal(reason("103"), null, "independent positive: advancing watermark");
});

test("T02-D REPAIR-NO-LIVE-EVIDENCE: valid metadata alone cannot publish; genuine post-ACK TAIL settles exactly once", async (t) => {
  useFakeChartDataSource(t);
  await withClock(async () => {
    const fixture = makeRepairFixture();
    try {
      fixture.session(1);
      await fixture.settle();
      assert.equal(fixture.queries.length, 1, "a real repair request received the default valid metadata");
      assert.deepEqual(fixture.reports.at(-1), ["pending",
        "Trade stream liveness evidence unavailable after subscription boundary"]);
      const firstPending = fixture.reports.findIndex(([state]) => state === "pending");
      assert.ok(firstPending >= 0);
      assert.equal(fixture.reports.slice(firstPending).some(([state]) => state === "healthy"), false);
      assert.equal(fixture.pipeline.series.get(START), undefined, "snapshot is not published without live evidence");
      assert.equal(fixture.updates.includes("history-patched"), false);
      for (const t of TAIL) fixture.emit(t);
      await fixture.settle();
      assert.equal(fixture.reports.at(-1)?.[0], "healthy", "positive control: actual post-boundary trades unlock repair");
      assert.deepEqual(summary(fixture.pipeline.series.get(START)), summary(aggregate([...PROJECTION, ...TAIL])));
      assert.equal(fixture.updates.filter((kind) => kind === "history-patched").length, 1);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});


test("PR421 wide-price guard skips OHLC, not volume/cells; full W103 snapshot owns all four", async () => {
  const { FootprintSeries } = await import("../dist/core/model/footprint.js");
  const events = [trade(100, START + 1, 1500, 1, true),
    trade(101, START + 2, 500, 1, false), trade(102, START + 3, 3500, 1, true),
    trade(103, START + 4, 1550, 1, false)];
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 25, referenceMarket: "M" });
  series.loadBars([aggregate([trade(99, START - 1, 1550, 1, true)], START - INTERVAL)]);
  series.addTrades(events);
  const totals = { volume: 4, delta: 0, count: 4,
    cells: [[500, 0, 1, 1], [1500, 1, 0, 1], [1550, 0, 1, 1], [3500, 1, 0, 1]] };
  assert.deepEqual(summary(series.get(START)),
    { open: 3500, high: 3500, low: 3500, close: 3500, ...totals },
    "three wide reference outliers confirm 3500; final 1550 skips OHLC only");
  series.beginRepairBarrier([START]);
  series.replaceRange(START, START + INTERVAL, [aggregate(events)]);
  series.commitRepairOwnership([START], 103n, []);
  const expected = { open: 1500, high: 3500, low: 500, close: 1550, ...totals };
  assert.deepEqual(summary(series.get(START)), expected, "full authoritative four-event snapshot");
  series.addTrades(events, { dedupe: false });
  assert.deepEqual(summary(series.get(START)), expected, "W103 ownership rejects duplicate/tail replay");
});
