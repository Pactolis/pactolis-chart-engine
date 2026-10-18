import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

globalThis.$state ??= (value) => value;
const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");

// T02-D (#311) remaining qualification: series-level repair ownership.
const INTERVAL = 60_000;
const START = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);
const MARKET = "BINANCE_FUTURES:btcusdt";

function trade(id, time, price = 100, qty = 1, isBuy = true) {
  return Object.freeze({ id, time, price, qty, tradeCount: 1, isBuy, liquidation: false, market: MARKET, source: "live", receivedAt: time + 1 });
}

function provenBar(start = START) {
  return {
    startTime: start, open: 100, high: 102, low: 99, close: 101,
    volume: 3, delta: 1, count: 3,
    cells: new Map([[100, { priceBin: 100, buyVol: 2, sellVol: 1, count: 3, buyCount: 2, sellCount: 1 }]]),
    hasRef: true, updatedAt: 200,
  };
}

function view(series, start = START) {
  const bar = series.get(start);
  assert.ok(bar, "expected candle at " + start);
  const cells = [...bar.cells.values()].map((cell) => ({ bin: cell.priceBin, buy: cell.buyVol, sell: cell.sellVol, count: cell.count }));
  return { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count, cells };
}

test("T02-D SERIES-SPLIT-TAIL: a tail trade applied as candle then footprint keeps both components exactly once", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.replaceRange(START, START + INTERVAL, [provenBar()]);
  series.commitRepairOwnership([START], 10n, []);
  const tail = [trade("11", START + 5_000, 101, 2, true)];

  series.addCandleTrades(tail);
  series.addFootprintTrades(tail);
  // Oracle: proven bar (V3/D1/N3, cell 100 buy2/sell1) plus one buy of 2 at 101.
  const expected = {
    open: 100, high: 102, low: 99, close: 101, volume: 5, delta: 3, count: 4,
    cells: [{ bin: 100, buy: 2, sell: 1, count: 3 }, { bin: 101, buy: 2, sell: 0, count: 1 }],
  };
  assert.deepEqual(view(series), expected);

  // Re-delivering the same tail, split or whole, adds nothing.
  series.addCandleTrades(tail);
  series.addFootprintTrades(tail);
  series.addTrades(tail, { dedupe: false });
  assert.deepEqual(view(series), expected);
});

test("T02-D SERIES-SPLIT-TAIL: a whole tail trade is not re-applied by a later split replay", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.replaceRange(START, START + INTERVAL, [provenBar()]);
  series.commitRepairOwnership([START], 10n, []);
  const tail = [trade("12", START + 5_000, 99, 1, false)];
  series.addTrades(tail, { dedupe: false });
  const once = view(series);
  assert.equal(once.volume, 4);
  series.addFootprintTrades(tail);
  series.addCandleTrades(tail);
  assert.deepEqual(view(series), once);
});

test("T02-D SERIES-OWNED-UPSERT: upsertBar cannot overwrite a repair-owned or fenced bucket without a proof", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.replaceRange(START, START + 2 * INTERVAL, [provenBar(), provenBar(START + INTERVAL)]);
  series.commitRepairOwnership([START], 10n, []);
  series.beginRepairFence([START + INTERVAL], 10n, []);
  const owned = view(series);
  const fenced = view(series, START + INTERVAL);
  const unproven = { ...provenBar(), open: 50, high: 500, low: 40, close: 450, volume: 99, delta: -99, count: 99, cells: new Map() };

  series.upsertBar(unproven);
  series.upsertBar({ ...unproven, startTime: START + INTERVAL });
  assert.deepEqual(view(series), owned);
  assert.deepEqual(view(series, START + INTERVAL), fenced);
  assert.equal(series.isRepairOwned(START), true, "the proven owner is kept");

  // A watermark-covered live trade is still rejected afterwards, so ownership stayed consistent.
  series.addTrades([trade("5", START + 1_000, 100, 7)], { dedupe: false });
  assert.deepEqual(view(series), owned);

  // An unowned bucket still accepts upsertBar.
  series.upsertBar({ ...unproven, startTime: START + 2 * INTERVAL });
  assert.equal(series.get(START + 2 * INTERVAL).volume, 99);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function recentCoverageMeta(q, overrides = {}) {
  return {
    schemaVersion: 2,
    generatedAt: q.to,
    footprint: { available: true },
    footprintCoverage: {
      schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: q.reference,
      authority: "provisional", status: "pending",
      requestedFrom: q.from, requestedTo: q.to, coveredFrom: null, coveredThrough: null,
      durableThroughId: null, projectionThroughId: "100", authorityToken: "token", reasonCode: null,
      ...overrides,
    },
  };
}

/** Public pipeline with a manual scheduler and history requests the test resolves itself. */
function makePipelineFixture({ synchronous = false } = {}) {
  const subscribers = new Set();
  const reports = [];
  const degraded = [];
  const updates = [];
  const before = [];
  const requests = [];
  let pending = null;
  const services = {
    subscribeToTrades(_market, cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter: () => ({ report: (state, detail = "") => reports.push([state, detail]), dispose() {} }),
    fetchHistory(q) {
      const request = { q, ...deferred() };
      requests.push(request);
      return request.promise;
    },
  };
  const pipeline = new ChartDataPipeline({
    market: MARKET, intervalMs: INTERVAL, priceStep: 1, services,
    // `synchronous` mirrors the built-in fallback scheduler when requestAnimationFrame is missing.
    scheduler: synchronous
      ? { request(cb) { cb(); return 0; }, cancel() {} }
      : { request(cb) { pending = cb; return 1; }, cancel() { pending = null; } },
    onDataDegraded: (value, detail) => degraded.push([value, detail]),
  });
  pipeline.onUpdate = (event) => updates.push(event);
  pipeline.onBeforeUpdate = (kind) => before.push([kind, pipeline.series.revision]);
  return {
    pipeline, reports, degraded, updates, before, requests,
    emit(event) { for (const cb of subscribers) cb(event); },
    drain() { for (let i = 0; i < 1_000 && pending; i++) { const cb = pending; pending = null; cb(); } },
  };
}

test("T02-D PIPELINE-A-01: a recent-coverage repair that retries on an unidentified trade leaves series and queue untouched", async () => {
  const fixture = makePipelineFixture();
  try {
    const outcome = fixture.pipeline.repairRecentFootprintCoverage(START, START + INTERVAL);
    await Promise.resolve();
    assert.equal(fixture.requests.length, 1);
    // Live trades arrive while the snapshot is in flight and are not flushed yet.
    fixture.emit(Object.freeze({ time: START + 1_000, price: 100, qty: 4, tradeCount: 1, isBuy: true, liquidation: false, market: MARKET, source: "live", receivedAt: START + 1_001 }));
    fixture.emit(trade("150", START + 2_000, 101, 2, false));
    const request = fixture.requests[0];
    request.q.onMeta?.(recentCoverageMeta(request.q));
    request.resolve([{ ...provenBar(), volume: 50, count: 50, cells: new Map([[100, { priceBin: 100, buyVol: 50, sellVol: 0, count: 50, buyCount: 50, sellCount: 0 }]]) }]);
    assert.equal(await outcome, "retry");
    assert.equal(fixture.pipeline.series.get(START), undefined, "an unproven snapshot must not land before identities are validated");
    assert.deepEqual(fixture.before, [], "no before-update without an applied change");

    // Oracle: the two live trades, exactly once (V6, D2, N2), once the queue drains.
    fixture.drain();
    const bar = view(fixture.pipeline.series);
    assert.deepEqual({ volume: bar.volume, delta: bar.delta, count: bar.count }, { volume: 6, delta: 2, count: 2 });
  } finally {
    fixture.pipeline.dispose();
  }
});

test("T02-D PIPELINE-A-02: a superseded history load cannot write its metadata into the current load", async (t) => {
  const startTime = Math.floor(Date.now() / INTERVAL) * INTERVAL - 3 * INTERVAL;
  const fastResponses = [];
  // This read ignores AbortSignal on purpose, so a superseded response really arrives.
  useFakeChartDataSource(t, {
    history: async (query) => {
      if (query.includeFootprint === false) {
        const gate = deferred();
        fastResponses.push(gate);
        return gate.promise;
      }
      return [];
    },
  });
  const respond = (detail) => ({
    bars: [],
    meta: { degraded: true, provenance: [{ source: "klines", error: detail }] },
  });
  const fixture = makePipelineFixture();
  try {
    const first = fixture.pipeline.loadHistory({ from: startTime, to: startTime + INTERVAL - 1, twoPhase: true });
    for (let i = 0; i < 20 && fastResponses.length < 1; i++) await new Promise((r) => setTimeout(r, 0));
    const second = fixture.pipeline.loadHistory({ from: startTime, to: startTime + INTERVAL - 1, twoPhase: true });
    for (let i = 0; i < 20 && fastResponses.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(fastResponses.length, 2);
    const current = fixture.pipeline.explicitHistoryReconcile;
    fastResponses[0].resolve(respond("STALE_FIRST_LOAD"));
    await first;
    assert.equal(fixture.pipeline.explicitHistoryReconcile, current);
    assert.equal(fixture.degraded.some(([, detail]) => detail === "STALE_FIRST_LOAD"), false, "superseded metadata reached the panel");
    fastResponses[1].resolve(respond("CURRENT_LOAD"));
    await second;
    assert.equal(fixture.degraded.some(([, detail]) => detail === "CURRENT_LOAD"), true, "positive guard: the current load still reports");
  } finally {
    fixture.pipeline.dispose();
  }
});

function sourceBar(start, volume) {
  return historyBar(start, { open: 100, high: 101, low: 99, close: 100, volume, delta: 0, count: volume, liquidationBuyVol: 0, liquidationSellVol: 0 });
}

async function withHistory(t, history, run) {
  useFakeChartDataSource(t, { history });
  return run();
}

test("T02-D PIPELINE-B-01: a history snapshot is dropped when the public before-update callback resets the pipeline", async (t) => {
  const startTime = Math.floor(Date.now() / INTERVAL) * INTERVAL - 3 * INTERVAL;
  await withHistory(t, async (query) => {
    if (query.includeFootprint === false) return [];
    return [sourceBar(startTime, 10)];
  }, async () => {
    const fixture = makePipelineFixture();
    try {
      let resets = 0;
      fixture.pipeline.onBeforeUpdate = (kind) => {
        if (kind === "history-patched" && resets++ === 0) fixture.pipeline.setPriceStep(2);
      };
      await fixture.pipeline.loadHistory({ from: startTime, to: startTime + INTERVAL - 1, twoPhase: true });
      assert.equal(resets, 1, "precondition: the callback ran");
      assert.equal(fixture.pipeline.series.config.priceStep, 2);
      assert.equal(fixture.pipeline.series.get(startTime), undefined, "the stale snapshot was applied to the reset series");
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D PIPELINE-B-01: a day patch is dropped when the public before-update callback disposes the pipeline", async (t) => {
  const day = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 2 * 86_400_000;
  await withHistory(t, async () => [sourceBar(day, 10)], async () => {
    const fixture = makePipelineFixture();
    let calls = 0;
    fixture.pipeline.onBeforeUpdate = () => { calls++; fixture.pipeline.dispose(); };
    await fixture.pipeline.patchDay(day);
    assert.equal(calls, 1, "precondition: the callback ran");
    assert.equal(fixture.pipeline.series.get(day), undefined, "a disposed pipeline was still patched");
    assert.equal(fixture.updates.length, 0, "a disposed pipeline still emitted an update");
  });
});

test("T02-D PIPELINE-B-01: a live bar seed stops when the public before-update callback disposes the pipeline", () => {
  const fixture = makePipelineFixture();
  const liveStart = Math.floor(Date.now() / INTERVAL) * INTERVAL;
  fixture.pipeline.onBeforeUpdate = () => fixture.pipeline.dispose();
  const applied = fixture.pipeline.applyLiveBarSeed([{ ...provenBar(liveStart) }], {
    market: MARKET, intervalMs: INTERVAL, from: liveStart, observedAt: Date.now(),
  });
  assert.deepEqual(applied, []);
  assert.equal(fixture.pipeline.series.get(liveStart), undefined);
  assert.equal(fixture.updates.length, 0);
});

test("T02-D PIPELINE-B-02: an invalid history snapshot does not dequeue the live trades it would have reconciled", async (t) => {
  const startTime = Math.floor(Date.now() / INTERVAL) * INTERVAL - 3 * INTERVAL;
  const fastGate = deferred();
  let fastRequested = false;
  await withHistory(t, async (query) => {
    if (query.includeFootprint === false) {
      fastRequested = true;
      await fastGate.promise;
      return [];
    }
    // OHLC invariants broken (high below low), under a candle snapshot that owns the bucket.
    return {
      bars: [{ ...sourceBar(startTime, 10), high: 90, low: 99 }],
      meta: {
        candleCoverage: {
          schemaVersion: 1, source: "binance-klines", instrument: MARKET, ownership: "snapshot", status: "verified",
          requestedFrom: startTime, requestedTo: startTime + INTERVAL - 1,
          snapshotAt: startTime + 2 * INTERVAL, closedThrough: startTime + 2 * INTERVAL - 1, reasonCode: null,
        },
      },
    };
  }, async () => {
    const fixture = makePipelineFixture();
    try {
      fixture.pipeline.series.replaceRange(startTime, startTime + INTERVAL, [provenBar(startTime)]);
      const load = fixture.pipeline.loadHistory({ from: startTime, to: startTime + INTERVAL - 1, twoPhase: true });
      for (let i = 0; i < 20 && !fastRequested; i++) await new Promise((r) => setTimeout(r, 0));
      fixture.emit(trade("901", startTime + 2_000, 101, 2, true));
      fastGate.resolve();
      await load.catch(() => undefined);
      fixture.drain();
      // Oracle: proven bar V3/D1/N3 plus the live buy of 2, exactly once.
      const bar = view(fixture.pipeline.series, startTime);
      assert.deepEqual({ volume: bar.volume, delta: bar.delta, count: bar.count }, { volume: 5, delta: 3, count: 4 });
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D PIPELINE-B-02: an invalid recent-coverage snapshot keeps the queue, the series and the repair slot intact", async () => {
  const fixture = makePipelineFixture();
  try {
    const outcome = fixture.pipeline.repairRecentFootprintCoverage(START, START + 2 * INTERVAL);
    await Promise.resolve();
    fixture.emit(trade("150", START + 2_000, 101, 2, false));
    const request = fixture.requests[0];
    request.q.onMeta?.(recentCoverageMeta(request.q));
    const cells = new Map([[100, { priceBin: 100, buyVol: 5, sellVol: 0, count: 5, buyCount: 5, sellCount: 0 }]]);
    const valid = { ...provenBar(START), volume: 5, count: 5, cells };
    const invalid = { ...provenBar(START + INTERVAL), high: 90, low: 99, cells: new Map(cells) };
    request.resolve([valid, invalid]);
    assert.equal(await outcome.catch((error) => error?.code ?? "threw"), "retry");
    assert.equal(fixture.pipeline.series.get(START), undefined, "a partly applied snapshot");
    // The slot is free again: the next attempt makes a new request instead of waiting forever.
    fixture.drain();
    const next = fixture.pipeline.repairRecentFootprintCoverage(START, START + 2 * INTERVAL);
    await Promise.resolve();
    assert.equal(fixture.requests.length, 2);
    fixture.pipeline.cancelRecentFootprintCoverageRepair();
    fixture.requests[1].reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    assert.equal(await next, "stop");
    const bar = view(fixture.pipeline.series);
    assert.deepEqual({ volume: bar.volume, delta: bar.delta, count: bar.count }, { volume: 2, delta: -2, count: 1 });
  } finally {
    fixture.pipeline.dispose();
  }
});

function candleCoverage(from, toInclusive, status = "verified") {
  return {
    schemaVersion: 1, source: "binance-klines", instrument: MARKET, ownership: "snapshot", status,
    requestedFrom: from, requestedTo: toInclusive,
    snapshotAt: toInclusive + 1, closedThrough: toInclusive, reasonCode: null,
  };
}

test("T02-D canonical history: returned buckets take the source bar, omitted owned buckets go, omitted unowned ones stay", async (t) => {
  const b0 = Math.floor(Date.now() / INTERVAL) * INTERVAL - 7 * INTERVAL;
  const [b1, b2, b3, b4] = [1, 2, 3, 4].map((n) => b0 + n * INTERVAL);
  const source = (start, o) => historyBar(start, { open: o, high: o + 5, low: o - 5, close: o + 1, volume: 40, delta: -4, count: 12, liquidationBuyVol: 0, liquidationSellVol: 0 });
  const cases = [];
  for (const twoPhase of [false, true]) {
    for (const status of ["verified", "error", null]) cases.push({ twoPhase, status });
  }
  for (const { twoPhase, status } of cases) {
    // The candle snapshot owns b0..b1 only and returns b0 and b3; b1 and b2 are omitted.
    await withHistory(t, async () => ({
      bars: [source(b0, 200), source(b3, 300)],
      meta: status ? { candleCoverage: candleCoverage(b0, b1 + INTERVAL - 1, status) } : {},
    }), async () => {
      const fixture = makePipelineFixture();
      const label = `twoPhase=${twoPhase} coverage=${status}`;
      try {
        fixture.pipeline.series.loadBars([b0, b1, b2, b3, b4].map((start) => provenBar(start)));
        const before = Object.fromEntries([b1, b2, b4].map((start) => [start, view(fixture.pipeline.series, start)]));
        await fixture.pipeline.loadHistory({ from: b0, to: b3 + INTERVAL - 1, twoPhase });
        for (const [start, open] of [[b0, 200], [b3, 300]]) {
          const returned = view(fixture.pipeline.series, start);
          assert.deepEqual({ open: returned.open, high: returned.high, low: returned.low, close: returned.close, volume: returned.volume, delta: returned.delta, count: returned.count },
            { open, high: open + 5, low: open - 5, close: open + 1, volume: 40, delta: -4, count: 12 }, label + ": returned " + start);
        }
        if (status === "verified") assert.equal(fixture.pipeline.series.get(b1), undefined, label + ": omitted owned bucket");
        else assert.deepEqual(view(fixture.pipeline.series, b1), before[b1], label + ": unverified omission keeps the bucket");
        assert.deepEqual(view(fixture.pipeline.series, b2), before[b2], label + ": omitted unowned bucket");
        assert.deepEqual(view(fixture.pipeline.series, b4), before[b4], label + ": bucket outside the request");
      } finally {
        fixture.pipeline.dispose();
      }
    });
  }
});

test("T02-D cancellation: cancelling an explicit history load re-queues the live trades it deferred, applied once", async (t) => {
  const b0 = Math.floor(Date.now() / INTERVAL) * INTERVAL - 4 * INTERVAL;
  let requested = false;
  await withHistory(t, ({ signal }) => new Promise((_resolve, reject) => {
    requested = true;
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }), async () => {
    const fixture = makePipelineFixture();
    try {
      const load = fixture.pipeline.loadHistory({ from: b0, to: b0 + 2 * INTERVAL - 1, twoPhase: true });
      for (let i = 0; i < 20 && !requested; i++) await new Promise((r) => setTimeout(r, 0));
      // No candle exists for b0 yet, so the load defers this trade until history arrives.
      const live = trade("71", b0 + 1_000, 100, 3, true);
      fixture.emit(live);
      fixture.emit(live);
      fixture.drain();
      assert.equal(fixture.pipeline.series.get(b0), undefined, "precondition: the trade is deferred");
      fixture.pipeline.cancelHistoryLoad();
      await load.catch(() => undefined);
      fixture.drain();
      const bar = view(fixture.pipeline.series, b0);
      assert.deepEqual({ volume: bar.volume, delta: bar.delta, count: bar.count }, { volume: 3, delta: 3, count: 1 });
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D PIPELINE-B-01: a trade delivered from inside the before-update callback voids a recent-coverage plan instead of being dropped", async () => {
  const fixture = makePipelineFixture();
  try {
    const outcome = fixture.pipeline.repairRecentFootprintCoverage(START, START + INTERVAL);
    await Promise.resolve();
    fixture.emit(trade("150", START + 2_000, 101, 2, false));
    let delivered = 0;
    fixture.pipeline.onBeforeUpdate = () => {
      if (delivered++ === 0) fixture.emit(trade("151", START + 3_000, 100, 4, true));
    };
    const request = fixture.requests[0];
    request.q.onMeta?.(recentCoverageMeta(request.q));
    const cells = new Map([[100, { priceBin: 100, buyVol: 50, sellVol: 0, count: 50, buyCount: 50, sellCount: 0 }]]);
    request.resolve([{ ...provenBar(), volume: 50, count: 50, cells }]);
    assert.equal(await outcome, "retry");
    assert.equal(delivered, 1, "precondition: the callback delivered a trade");
    assert.equal(fixture.pipeline.series.get(START), undefined);
    fixture.drain();
    const bar = view(fixture.pipeline.series);
    // Oracle: both live trades exactly once (sell 2 + buy 4).
    assert.deepEqual({ volume: bar.volume, delta: bar.delta, count: bar.count }, { volume: 6, delta: 2, count: 2 });
  } finally {
    fixture.pipeline.dispose();
  }
});

test("T02-D PIPELINE-B-01: a trade delivered from inside the before-update callback is reconciled by the history snapshot, not added on top", async (t) => {
  const startTime = Math.floor(Date.now() / INTERVAL) * INTERVAL - 3 * INTERVAL;
  const coverage = candleCoverage(startTime, startTime + INTERVAL - 1);
  await withHistory(t, async (query) => {
    if (query.includeFootprint === false) return [];
    return ({ bars: [sourceBar(startTime, 10)], meta: { candleCoverage: coverage } });
  }, async () => {
    const fixture = makePipelineFixture();
    try {
      fixture.pipeline.series.replaceRange(startTime, startTime + INTERVAL, [provenBar(startTime)]);
      let delivered = 0;
      fixture.pipeline.onBeforeUpdate = (kind) => {
        if (kind === "history-patched" && delivered++ === 0) fixture.emit(trade("951", startTime + 2_000, 100, 4, true));
      };
      await fixture.pipeline.loadHistory({ from: startTime, to: startTime + INTERVAL - 1, twoPhase: true });
      fixture.drain();
      assert.equal(delivered, 1, "precondition: the callback delivered a trade");
      // The candle snapshot owns this closed bucket, so its candle (V10, N10) already contains the trade.
      const bar = view(fixture.pipeline.series, startTime);
      assert.equal(bar.volume, 10);
      assert.equal(bar.count, 10);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D PIPELINE-B-01: a closed-bucket trade delivered from the day-patch callback is already in the built day, so it is not added on top", async (t) => {
  const DAY = 86_400_000;
  const day = Math.floor(Date.now() / DAY) * DAY - 2 * DAY;
  await withHistory(t, async () => [sourceBar(day, 10)], async () => {
    const fixture = makePipelineFixture();
    try {
      let delivered = 0;
      fixture.pipeline.onBeforeUpdate = () => {
        if (delivered++ === 0) fixture.emit(trade("961", day + 2_000, 100, 4, true));
      };
      await fixture.pipeline.patchDay(day);
      fixture.drain();
      assert.equal(delivered, 1, "precondition: the callback delivered a trade");
      // The day was built from the exchange's complete record of its closed buckets (V10, N10).
      assert.equal(fixture.pipeline.series.get(day).volume, 10);
      assert.equal(fixture.pipeline.series.get(day).count, 10);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D PIPELINE-B-01: with a synchronous scheduler, trades flushed from the before-update callback do not abort history or day patches", async (t) => {
  const startTime = Math.floor(Date.now() / INTERVAL) * INTERVAL - 3 * INTERVAL;
  const coverage = candleCoverage(startTime, startTime + INTERVAL - 1);
  await withHistory(t, async (query) => {
    if (query.includeFootprint === false) return [];
    return ({ bars: [sourceBar(startTime, 10)], meta: { candleCoverage: coverage } });
  }, async () => {
    const fixture = makePipelineFixture({ synchronous: true });
    try {
      fixture.pipeline.series.replaceRange(startTime, startTime + INTERVAL, [provenBar(startTime)]);
      let delivered = 0;
      fixture.pipeline.onBeforeUpdate = (kind) => {
        if (kind === "history-patched" && delivered++ === 0) fixture.emit(trade("971", startTime + 2_000, 100, 4, true));
      };
      await fixture.pipeline.loadHistory({ from: startTime, to: startTime + INTERVAL - 1, twoPhase: true });
      assert.equal(delivered, 1, "precondition: the callback delivered a trade");
      // The owned closed candle is the source's (V10, N10), not the proven seed (V3) or seed + trade.
      const bar = view(fixture.pipeline.series, startTime);
      assert.equal(bar.volume, 10);
      assert.equal(bar.count, 10);
    } finally {
      fixture.pipeline.dispose();
    }
  });

  const DAY = 86_400_000;
  const day = Math.floor(Date.now() / DAY) * DAY - 2 * DAY;
  await withHistory(t, async () => [sourceBar(day, 10)], async () => {
    const fixture = makePipelineFixture({ synchronous: true });
    try {
      let delivered = 0;
      fixture.pipeline.onBeforeUpdate = () => {
        if (delivered++ === 0) fixture.emit(trade("972", day + 2_000, 100, 4, true));
      };
      await fixture.pipeline.patchDay(day);
      assert.equal(delivered, 1);
      assert.equal(fixture.pipeline.series.get(day)?.volume, 10, "the built day was skipped");
    } finally {
      fixture.pipeline.dispose();
    }
  });
});

test("T02-D SERIES-OWNED-UPSERT: a live bar seed rejected by a repair-owned bucket is not reported as applied", () => {
  const fixture = makePipelineFixture();
  try {
    const liveStart = Math.floor(Date.now() / INTERVAL) * INTERVAL;
    // A proven snapshot owned this bucket without a bar in it.
    fixture.pipeline.series.commitRepairOwnership([liveStart], 10n, []);
    const applied = fixture.pipeline.applyLiveBarSeed([{ ...provenBar(liveStart) }], {
      market: MARKET, intervalMs: INTERVAL, from: liveStart, observedAt: Date.now(),
    });
    assert.deepEqual(applied, [], "the caller would stop retrying a seed that never landed");
    assert.equal(fixture.pipeline.series.get(liveStart), undefined);
  } finally {
    fixture.pipeline.dispose();
  }
});

test("T02-D PIPELINE-B-01: a reset raised from the coverage-unknown degraded callback drops the rest of that history snapshot", async (t) => {
  const b0 = Math.floor(Date.now() / INTERVAL) * INTERVAL - 5 * INTERVAL;
  const b1 = b0 + INTERVAL;
  const fastGate = deferred();
  let fastRequested = false;
  await withHistory(t, async (query) => {
    if (query.includeFootprint === false) {
      fastRequested = true;
      await fastGate.promise;
      // The candle snapshot returns and owns b1 only, so the b0 live trade's bucket stays unverified.
      return ({ bars: [sourceBar(b1, 10)], meta: { candleCoverage: candleCoverage(b1, b1 + INTERVAL - 1) } });
    }
    return [];
  }, async () => {
    const fixture = makePipelineFixture();
    try {
      fixture.pipeline.series.loadBars([provenBar(b0), provenBar(b1)]);
      const load = fixture.pipeline.loadHistory({ from: b0, to: b1 + INTERVAL - 1, twoPhase: true });
      for (let i = 0; i < 20 && !fastRequested; i++) await new Promise((r) => setTimeout(r, 0));
      fixture.emit(trade("5", b0 + 1_000, 100, 1, true));
      fixture.emit(trade("6", b1 + 1_000, 100, 3, true));
      let resets = 0;
      fixture.pipeline.onDataDegraded = (value, detail) => {
        if (value && /^CANDLE_COVERAGE_UNKNOWN/.test(detail) && resets++ === 0) fixture.pipeline.setPriceStep(2);
      };
      fastGate.resolve();
      await load.catch(() => undefined);
      assert.equal(resets, 1, "precondition: the degraded callback reset the pipeline");
      assert.equal(fixture.pipeline.series.get(b1), undefined, "the old snapshot reached the reset series");
      const reset = fixture.updates.findIndex((event) => event.kind === "price-step-reset");
      assert.ok(reset >= 0);
      assert.deepEqual(fixture.updates.slice(reset + 1).map((event) => event.kind).filter((kind) => kind.startsWith("history")), []);
    } finally {
      fixture.pipeline.dispose();
    }
  });
});
