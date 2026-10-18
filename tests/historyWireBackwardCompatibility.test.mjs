/**
 * T15-B-FE (#338) - history backward-compatibility guard, chart engine side.
 *
 * How the pipeline reconciles the history snapshots older/current backends send
 * (sparse, empty, degraded, pending or foreign-market coverage) against the day
 * already on the chart and the live trades queued for it, and the FootprintSeries
 * invariants behind that. Snapshots arrive through the ChartDataSource port as
 * parsed bars; decoding the wire formats is the host's job and is tested there.
 *
 * Independent oracle (hand-derived arithmetic, NOT producer output parity):
 *   a replacement bucket at t with open p carries O/H/L/C = p/p+1/p-1/p, V 7,
 *   D 1, N 7 and one cell at p = { buyVol 4, sellVol 3, count 7, buyCount 4,
 *   sellCount 3 }; seeded chart bars are O/H/L/C 100/101/99/100, V 5, D 1, N 5
 *   with no cells.
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { historyBar, useFakeChartDataSource } = await import("./support/fakeChartDataSource.mjs");

const MARKET = "BINANCE_FUTURES:btcusdt";
const MINUTE = 60_000;
const T0 = 1767225600000; // Date.UTC(2026, 0, 1): interval-aligned, >= footprint policy cutoff

// ---------------------------------------------------------------------------
// Pipeline reconcile fixtures (pattern reused from chartHistoryContractGuards).
// ---------------------------------------------------------------------------
function makePipeline(overrides = {}) {
  return new ChartDataPipeline({
    market: MARKET,
    intervalMs: MINUTE,
    priceStep: 10,
    services: {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 10,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync: () => {},
    },
    scheduler: { request: () => 0, cancel: () => {} },
    ...overrides,
  });
}

function seedBar(startTime) {
  return {
    startTime,
    open: 100, high: 101, low: 99, close: 100,
    volume: 5, delta: 1, count: 5,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map(),
    hasRef: true,
  };
}

function replacementBar(t, open) {
  return historyBar(t, {
    open, high: open + 1, low: open - 1, close: open, volume: 7, delta: 1, count: 7,
    liquidationBuyVol: 0, liquidationSellVol: 0, completeness: "complete", updatedAt: t + 500,
    cells: [{ priceBin: open, buyVol: 4, sellVol: 3, liquidationBuyVol: 0, liquidationSellVol: 0, count: 7, buyCount: 4, sellCount: 3 }],
  });
}

// ---------------------------------------------------------------------------
// 1) Pipeline day-patch reconcile (public patchDay hook; patterns reused from
//    tests/chartHistoryContractGuards.test.mjs without editing it).
// ---------------------------------------------------------------------------
test("T15-B-FE patchDay keeps a healthy day when a degraded sparse response arrives", async (t) => {
  // Given a chart holding two healthy bars for the day and a patch response
  // that is sparse (one bar) and degraded (provenance error + footprint
  // coverage status "degraded");
  // When patchDay applies it;
  // Then the existing healthy bars survive untouched (a degraded sparse
  // response says nothing about the day already on the chart).
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200)],
    meta: {
      schemaVersion: 2, generatedAt: 1, degraded: true,
      provenance: [{ source: "footprint-cache", error: "store 503" }],
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "provisional", status: "degraded",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        coveredFrom: null, coveredThrough: null,
        durableThroughId: null, projectionThroughId: null,
        authorityToken: null, reasonCode: "store_unavailable",
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 2, "the day already on the chart is kept");
    assert.equal(pipeline.series.at(0).close, 100);
    assert.equal(pipeline.series.at(1).close, 100);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE patchDay keeps a healthy day when candle coverage reports an error", async (t) => {
  // Given the same healthy chart and a sparse patch response whose envelope
  // reports candleCoverage status "error" (kline source failed) without a
  // degraded flag;
  // When patchDay applies it;
  // Then the existing healthy bars survive (genuine contract keeps the day).
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200)],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: MARKET,
        ownership: null, status: "error",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        snapshotAt: null, closedThrough: null, reasonCode: "source_unavailable",
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 2);
    assert.equal(pipeline.series.at(0).close, 100);
    assert.equal(pipeline.series.at(1).close, 100);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE patchDay replaces the day for a healthy verified-canonical response (positive control)", async (t) => {
  // Given a healthy chart and a full non-degraded patch response with verified
  // canonical footprint coverage and new OHLC;
  // When patchDay applies it;
  // Then the canonical replacement really happens (the keep-day guard must not
  // block genuine full-day updates).
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200), replacementBar(T0 + MINUTE, 201)],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "canonical", status: "verified",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        coveredFrom: T0, coveredThrough: T0 + MINUTE,
        durableThroughId: "900", projectionThroughId: "900",
        authorityToken: "token", reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 2);
    assert.equal(pipeline.series.at(0).open, 200);
    assert.equal(pipeline.series.at(1).open, 201);
    assert.equal(pipeline.series.at(0).completeness, "complete");
    assert.equal(pipeline.series.at(0).cells.get(200).buyVol, 4);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE patchDay still replaces a fully re-provided day when footprint coverage is merely pending", async (t) => {
  // Given a full-day patch response (every seeded bucket re-provided) whose
  // footprint coverage is pending with no covered range;
  // When patchDay applies it;
  // Then the kline-owned day patch proceeds (pending footprint coverage alone
  // is not a degraded candle response). Sparse-non-degraded clearing behavior
  // is deliberately NOT asserted here: it is an open DECISION_REQUEST.
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200), replacementBar(T0 + MINUTE, 201)],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "provisional", status: "pending",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        coveredFrom: null, coveredThrough: null,
        durableThroughId: null, projectionThroughId: "100",
        authorityToken: "token", reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 2);
    assert.equal(pipeline.series.at(0).open, 200);
    assert.equal(pipeline.series.at(1).open, 201);
  } finally {
    pipeline.dispose();
  }
});

// ---------------------------------------------------------------------------
test("T15-B-FE RED: sparse non-degraded patchDay applies returned bars but keeps unowned omitted candles", async (t) => {
  // Given a chart holding two healthy bars for the actual UTC day of T0 and a
  // sparse (one-bar) non-degraded patch response whose footprint coverage is
  // normal pending and whose requested range spans the whole actual UTC day
  // (from = T0, to = T0 + 86_400_000 - 1) with NO candleCoverage block;
  // When the public patchDay applies it;
  // Then the returned replacement bar is applied bucket-by-bucket (open 200 /
  // high 201 / low 199 / close 200 / volume 7 / delta 1 / count 7, cell
  // buyVol 4 / sellVol 3 — manual independent oracle), while the second,
  // unowned omitted seed bar keeps ALL its candle fields intact (an
  // unreturned bucket is not an instruction to delete it).
  // EXPECTED_RED: current main replaces the whole day without ownership
  // authority, so the omitted bar is deleted and the intactness assertion
  // fails on the missing bar (not on parsing or fixture shape).
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200)],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "provisional", status: "pending",
        requestedFrom: T0, requestedTo: T0 + 86_400_000 - 1,
        coveredFrom: null, coveredThrough: null,
        durableThroughId: null, projectionThroughId: "100",
        authorityToken: "token", reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    // Returned replacement applies (manual independent oracle) FIRST, so an
    // early length/omission miss can never mask a finance regression.
    const replaced = pipeline.series.at(0);
    assert.equal(replaced.startTime, T0);
    assert.equal(replaced.open, 200);
    assert.equal(replaced.high, 201);
    assert.equal(replaced.low, 199);
    assert.equal(replaced.close, 200);
    assert.equal(replaced.volume, 7);
    assert.equal(replaced.delta, 1);
    assert.equal(replaced.count, 7);
    assert.equal(replaced.cells.get(200).buyVol, 4);
    assert.equal(replaced.cells.get(200).sellVol, 3);
    // Presence/length guard for the omitted unowned candle bucket before any
    // intactness field comparison runs.
    const omitted = pipeline.series.at(1);
    assert.ok(omitted !== undefined, "the omitted unowned candle must survive: bucket at index 1 must be present");
    assert.equal(pipeline.series.length, 2, "the omitted unowned candle must survive: expected the seed bar plus the returned replacement");
    // The omitted, unowned seed bar keeps ALL candle fields intact.
    assert.equal(omitted.startTime, T0 + MINUTE);
    assert.equal(omitted.open, 100);
    assert.equal(omitted.high, 101);
    assert.equal(omitted.low, 99);
    assert.equal(omitted.close, 100);
    assert.equal(omitted.volume, 5);
    assert.equal(omitted.delta, 1);
    assert.equal(omitted.count, 5);
    assert.equal(omitted.liquidationBuyVol, 0);
    assert.equal(omitted.liquidationSellVol, 0);
    assert.equal(omitted.hasRef, true);
    assert.equal(omitted.cells.size, 0);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE patchDay deletes an omitted candle only when the verified snapshot owns its bucket", async (t) => {
  // Given a sparse (one-bar) non-degraded patch response whose candleCoverage is
  // a verified snapshot that verifiably owns both seeded buckets (requested range
  // and closedThrough cover them);
  // When patchDay applies it;
  // Then the returned bucket is replaced and the owned omitted bucket is
  // legitimately cleared: an owned omission is an authoritative "no candle".
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200)],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "provisional", status: "pending",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        coveredFrom: null, coveredThrough: null,
        durableThroughId: null, projectionThroughId: "100",
        authorityToken: "token", reasonCode: null,
      },
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: MARKET,
        ownership: "snapshot", status: "verified",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        snapshotAt: T0 + 2 * MINUTE + 1000, closedThrough: T0 + 2 * MINUTE,
        reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 1, "an owned verified omission is a legitimate delete");
    assert.equal(pipeline.series.at(0).startTime, T0);
    assert.equal(pipeline.series.at(0).open, 200);
    assert.equal(pipeline.series.at(0).cells.get(200).buyVol, 4);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE patchDay keeps an omitted candle when the verified snapshot belongs to another market", async (t) => {
  // Given the same sparse response whose candleCoverage is verified but bound to
  // a different instrument (the ownership boundary must bind to this market);
  // When patchDay applies it;
  // Then the unowned omitted seed bar survives intact while the returned bucket
  // is replaced (a foreign-market snapshot may not delete local candles).
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200)],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "provisional", status: "pending",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        coveredFrom: null, coveredThrough: null,
        durableThroughId: null, projectionThroughId: "100",
        authorityToken: "token", reasonCode: null,
      },
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: "BINANCE_FUTURES:ethusdt",
        ownership: "snapshot", status: "verified",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        snapshotAt: T0 + 2 * MINUTE + 1000, closedThrough: T0 + 2 * MINUTE,
        reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 2, "a foreign-market snapshot owns nothing here");
    assert.equal(pipeline.series.at(0).startTime, T0);
    assert.equal(pipeline.series.at(0).open, 200);
    const omitted = pipeline.series.at(1);
    assert.ok(omitted !== undefined, "the omitted unowned candle must survive");
    assert.equal(omitted.startTime, T0 + MINUTE);
    assert.equal(omitted.close, 100);
    assert.equal(omitted.volume, 5);
    assert.equal(omitted.hasRef, true);
  } finally {
    pipeline.dispose();
  }
});
test("T15-B-FE RED: verified+closed empty snapshot owns the day and deletes its candles", async (t) => {
  // Given a chart holding two healthy bars for the actual UTC day of T0 and a
  // fully EMPTY (zero bars) non-degraded patch response whose candleCoverage is
  // a verified snapshot that verifiably owns both seeded buckets (requested
  // range and closedThrough cover them);
  // When the public patchDay applies it;
  // Then the empty response deletes exactly the verified, owned, closed range
  // it covers -- here both seeded buckets -- and claims nothing about the day
  // beyond that coverage.
  useFakeChartDataSource(t, { history: () => ({
    bars: [],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "provisional", status: "pending",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        coveredFrom: null, coveredThrough: null,
        durableThroughId: null, projectionThroughId: "100",
        authorityToken: "token", reasonCode: null,
      },
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: MARKET,
        ownership: "snapshot", status: "verified",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        snapshotAt: T0 + 2 * MINUTE + 1000, closedThrough: T0 + 2 * MINUTE,
        reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 0, "an owned verified+closed empty snapshot is a legitimate whole-day delete");
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE empty response without verified closed ownership preserves the prior day", async (t) => {
  // Given the same two healthy bars and a fully EMPTY patch response, for each
  // ownership failure mode: (a) no candleCoverage at all, (b) a snapshot that
  // is not verified, (c) a degraded envelope even with verified coverage,
  // (d) a verified+closed snapshot bound to another market;
  // When the public patchDay applies it;
  // Then the prior bars survive intact in every case: an empty response only
  // deletes what a verified closed snapshot verifiably owns.
  const pendingFootprintCoverage = {
    schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
    authority: "provisional", status: "pending",
    requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
    coveredFrom: null, coveredThrough: null,
    durableThroughId: null, projectionThroughId: "100",
    authorityToken: "token", reasonCode: null,
  };
  const verifiedCandleCoverage = (instrument) => ({
    schemaVersion: 1, source: "binance-klines", instrument,
    ownership: "snapshot", status: "verified",
    requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
    snapshotAt: T0 + 2 * MINUTE + 1000, closedThrough: T0 + 2 * MINUTE,
    reasonCode: null,
  });
  const cases = [
    ["absent candleCoverage", { schemaVersion: 2, generatedAt: 1, footprintCoverage: pendingFootprintCoverage }],
    ["unverified snapshot", {
      schemaVersion: 2, generatedAt: 1, footprintCoverage: pendingFootprintCoverage,
      candleCoverage: { ...verifiedCandleCoverage(MARKET), status: "pending" },
    }],
    ["degraded envelope", {
      schemaVersion: 2, generatedAt: 1, degraded: true,
      provenance: [{ source: "footprint-cache", error: "store 503" }],
      footprintCoverage: pendingFootprintCoverage,
      candleCoverage: verifiedCandleCoverage(MARKET),
    }],
    ["foreign-market snapshot", {
      schemaVersion: 2, generatedAt: 1, footprintCoverage: pendingFootprintCoverage,
      candleCoverage: verifiedCandleCoverage("BINANCE_FUTURES:ethusdt"),
    }],
  ];
  for (const [label, meta] of cases) {
    useFakeChartDataSource(t, { history: () => ({ bars: [], meta }) });
    const pipeline = makePipeline();
    try {
      pipeline.series.upsertBar(seedBar(T0));
      pipeline.series.upsertBar(seedBar(T0 + MINUTE));
      const bar0 = pipeline.series.at(0);
      const bar1 = pipeline.series.at(1);
      assert.ok(bar0 !== undefined && bar1 !== undefined, label);
      const revisionBefore = pipeline.series.revision;
      const structureRevisionBefore = pipeline.series.structureRevision;
      let beforeUpdateCount = 0;
      let updateCount = 0;
      let historyPatchedBefore = 0;
      let historyPatchedUpdate = 0;
      pipeline.onBeforeUpdate = (kind) => {
        beforeUpdateCount++;
        if (kind === "history-patched") historyPatchedBefore++;
      };
      pipeline.onUpdate = (event) => {
        updateCount++;
        if (event.kind === "history-patched") historyPatchedUpdate++;
      };
      await pipeline.patchDay(T0);
      assert.equal(pipeline.series.length, 2, label + ": the prior day must survive an unowned empty response");
      const first = pipeline.series.at(0);
      const second = pipeline.series.at(1);
      assert.ok(first === bar0, label + ": the first bar keeps its original public stored reference");
      assert.ok(second === bar1, label + ": the second bar keeps its original public stored reference");
      assert.equal(first.startTime, T0, label);
      assert.equal(first.open, 100, label);
      assert.equal(first.high, 101, label);
      assert.equal(first.low, 99, label);
      assert.equal(first.close, 100, label);
      assert.equal(first.volume, 5, label);
      assert.equal(first.delta, 1, label);
      assert.equal(first.count, 5, label);
      assert.equal(first.cells.size, 0, label);
      assert.equal(first.hasRef, true, label);
      assert.equal(second.startTime, T0 + MINUTE, label);
      assert.equal(second.open, 100, label);
      assert.equal(second.high, 101, label);
      assert.equal(second.low, 99, label);
      assert.equal(second.close, 100, label);
      assert.equal(second.volume, 5, label);
      assert.equal(second.delta, 1, label);
      assert.equal(second.count, 5, label);
      assert.equal(second.cells.size, 0, label);
      assert.equal(second.hasRef, true, label);
      assert.equal(beforeUpdateCount, 0, label + ": an unowned empty response must not fire public onBeforeUpdate");
      assert.equal(historyPatchedBefore, 0, label + ": no history-patched beforeUpdate may be emitted");
      assert.equal(updateCount, 0, label + ": an unowned empty response must not fire public onUpdate");
      assert.equal(historyPatchedUpdate, 0, label + ": no history-patched update event may be emitted");
      assert.equal(pipeline.series.revision, revisionBefore, label + ": an unowned empty response must not bump the public revision");
      assert.equal(pipeline.series.structureRevision, structureRevisionBefore, label + ": an unowned empty response must not bump the public structureRevision");
    } finally {
      pipeline.dispose();
    }
  }
});

test("T15-B-FE bounded positive control: an owned empty bucket with no existing bar consumes its queued trade", async (t) => {
  // Given a verified EMPTY snapshot that owns ONLY the first closed bucket T0
  // (requestedTo and closedThrough both end at T0 + MINUTE - 1), no existing
  // bar in that owned bucket, one unowned same-day bar at T0 + 2 * MINUTE,
  // and one canonical trade (id 778, time T0 + 30s, price 100.1, qty 2,
  // isBuy true, MARKET) queued through the PUBLIC services.subscribeToTrades
  // port with a scheduler that parks the flush callback;
  // When the public patchDay applies the empty response and the parked public
  // scheduler callback is flushed manually;
  // Then no phantom owned T0 candle or trade appears: the owned bucket is
  // legitimately empty, so its queued closed trade is consumed by the patch,
  // and the sole unowned existing bar keeps its original public stored
  // reference with O 100 / H 101 / L 99 / C 100, V 5, D 1, N 5 and empty
  // cells. A future guard that only trusts owned EXISTING bars would keep
  // the T0 trade pending and grow a phantom candle here.
  let tradeSink = null;
  let parkedFlush = null;
  useFakeChartDataSource(t, { history: () => ({
    bars: [],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: MARKET,
        ownership: "snapshot", status: "verified",
        requestedFrom: T0, requestedTo: T0 + MINUTE - 1,
        snapshotAt: T0 + MINUTE, closedThrough: T0 + MINUTE - 1,
        reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline({
    services: {
      subscribeToTrades: (_market, onTrade) => { tradeSink = onTrade; return () => {}; },
      fetchPriceStep: async () => 10,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync: () => {},
    },
    scheduler: { request: (cb) => { parkedFlush = cb; return 1; }, cancel: () => {} },
  });
  try {
    pipeline.series.upsertBar(seedBar(T0 + 2 * MINUTE));
    const keptRef = pipeline.series.at(0);
    assert.ok(keptRef !== undefined, "the unowned same-day bar must be seeded");
    assert.ok(tradeSink !== null, "the public subscribeToTrades port must deliver the trade sink at construction");
    tradeSink({ id: "778", time: T0 + 30_000, price: 100.1, qty: 2, isBuy: true, market: MARKET });
    assert.ok(parkedFlush !== null, "the public scheduler must have received the flush request");
    await pipeline.patchDay(T0);
    assert.ok(parkedFlush !== null, "the public scheduler must still hold the parked flush after the patch");
    parkedFlush();
    assert.equal(pipeline.series.length, 1, "no phantom owned T0 candle or trade may appear after the flush");
    const sole = pipeline.series.at(0);
    assert.ok(sole !== undefined, "the sole unowned existing bar must survive");
    assert.ok(sole === keptRef, "the unowned bar keeps its original public stored reference");
    assert.equal(sole.startTime, T0 + 2 * MINUTE);
    assert.equal(sole.open, 100);
    assert.equal(sole.high, 101);
    assert.equal(sole.low, 99);
    assert.equal(sole.close, 100);
    assert.equal(sole.volume, 5);
    assert.equal(sole.delta, 1);
    assert.equal(sole.count, 5);
    assert.equal(sole.cells.size, 0, "the kept bar keeps its empty cells");
    assert.equal(sole.hasRef, true);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE bounded empty control: ownership stops at the requested range boundary", async (t) => {
  // Given two healthy bars in the actual UTC day of T0 and a fully EMPTY
  // (zero bars) non-degraded patch response whose verified snapshot requested
  // range covers only the first bucket (requestedTo bucket-starts at T0)
  // while closedThrough covers both;
  // When patchDay applies it;
  // Then only the first (owned) bar is deleted; the second keeps its original
  // reference with open/high/low/close/volume/delta/count and empty cells
  // unchanged -- the snapshot owns nothing beyond its requested range.
  useFakeChartDataSource(t, { history: () => ({
    bars: [],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: MARKET,
        ownership: "snapshot", status: "verified",
        requestedFrom: T0, requestedTo: T0 + MINUTE - 1,
        snapshotAt: T0 + 2 * MINUTE + 1000, closedThrough: T0 + 2 * MINUTE,
        reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 1, "only the bucket inside the requested range is deleted");
    const kept = pipeline.series.at(0);
    assert.ok(kept !== undefined, "the out-of-range bucket must survive");
    assert.equal(kept.startTime, T0 + MINUTE);
    assert.equal(kept.open, 100);
    assert.equal(kept.high, 101);
    assert.equal(kept.low, 99);
    assert.equal(kept.close, 100);
    assert.equal(kept.volume, 5);
    assert.equal(kept.delta, 1);
    assert.equal(kept.count, 5);
    assert.equal(kept.cells.size, 0, "the kept bar keeps its empty cells");
    assert.equal(kept.hasRef, true);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE bounded empty control: ownership stops at the closedThrough boundary", async (t) => {
  // Given the same two healthy bars and a fully EMPTY non-degraded response
  // whose verified snapshot requested range covers both buckets but whose
  // closedThrough only closes the first (the second bucket was still open at
  // snapshot time);
  // When patchDay applies it;
  // Then only the first (owned+closed) bar is deleted; the not-yet-closed
  // second keeps its original reference with all scalars and empty cells
  // unchanged.
  useFakeChartDataSource(t, { history: () => ({
    bars: [],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: MARKET,
        ownership: "snapshot", status: "verified",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        snapshotAt: T0 + MINUTE + 1000, closedThrough: T0 + MINUTE - 1,
        reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline();
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 1, "only the closed bucket is deleted");
    const kept = pipeline.series.at(0);
    assert.ok(kept !== undefined, "the not-yet-closed bucket must survive");
    assert.equal(kept.startTime, T0 + MINUTE);
    assert.equal(kept.open, 100);
    assert.equal(kept.high, 101);
    assert.equal(kept.low, 99);
    assert.equal(kept.close, 100);
    assert.equal(kept.volume, 5);
    assert.equal(kept.delta, 1);
    assert.equal(kept.count, 5);
    assert.equal(kept.cells.size, 0, "the kept bar keeps its empty cells");
    assert.equal(kept.hasRef, true);
  } finally {
    pipeline.dispose();
  }
});

test("T15-B-FE patchDay conserves a queued live trade against an unowned omitted bucket", async (t) => {
  // Given a chart holding two healthy bars, one live trade queued through the
  // PUBLIC services.subscribeToTrades port into a bucket the patch response
  // omits and does not own (no candleCoverage), and a scheduler that parks the
  // flush callback instead of running it;
  // When patchDay applies the sparse response (returned bar replaces its
  // bucket, the unowned omitted bar is kept);
  // Then the queued trade is still pending afterwards: the kept bar is
  // untouched before the flush (close 100, volume 5, delta 1, count 5, empty
  // cells -- no fake queued seed), and firing the parked public scheduler
  // flush exactly once applies it to the kept bar: O 100, H 101, L 99,
  // C 100.1 (inside the 0.1% reference-deviation policy around the seed ref
  // 100; priceStep 10 quantizes the cell to bin 100), V 7, D 3, N 6, hasRef
  // true, cell buyVol 2 / sellVol 0 / count 1 / buyCount 1 / sellCount 0.
  // Dropping the trade from the pending queue during the patch would leave
  // the bar untouched and fail these assertions.
  let tradeSink = null;
  let parkedFlush = null;
  useFakeChartDataSource(t, { history: () => ({
    bars: [replacementBar(T0, 200)],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      footprintCoverage: {
        schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: MARKET,
        authority: "provisional", status: "pending",
        requestedFrom: T0, requestedTo: T0 + 2 * MINUTE,
        coveredFrom: null, coveredThrough: null,
        durableThroughId: null, projectionThroughId: "100",
        authorityToken: "token", reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline({
    services: {
      subscribeToTrades: (_market, onTrade) => { tradeSink = onTrade; return () => {}; },
      fetchPriceStep: async () => 10,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync: () => {},
    },
    scheduler: { request: (cb) => { parkedFlush = cb; return 1; }, cancel: () => {} },
  });
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + MINUTE));
    assert.ok(tradeSink !== null, "the public subscribeToTrades port must deliver the trade sink at construction");
    tradeSink({ id: "777", time: T0 + MINUTE + 30_000, price: 100.1, qty: 2, isBuy: true, market: MARKET });
    await pipeline.patchDay(T0);
    assert.equal(pipeline.series.length, 2, "the unowned omitted candle must survive");
    assert.equal(pipeline.series.at(0).startTime, T0);
    assert.equal(pipeline.series.at(0).open, 200);
    assert.equal(pipeline.series.at(0).cells.get(200).buyVol, 4, "the returned T0 replacement keeps its cells");
    const kept = pipeline.series.at(1);
    assert.equal(kept.startTime, T0 + MINUTE);
    assert.equal(kept.close, 100, "the kept bar is untouched until the conserved trade flushes");
    assert.equal(kept.volume, 5, "no fake queued seed: volume is still the seed value before the flush");
    assert.equal(kept.delta, 1);
    assert.equal(kept.count, 5);
    assert.equal(kept.cells.size, 0, "no fake queued seed: the kept bar still has empty cells before the flush");
    assert.ok(parkedFlush !== null, "the public scheduler must have received the flush request");
    parkedFlush();
    const patched = pipeline.series.at(1);
    assert.ok(patched !== undefined, "the conserved trade must still be applied to its bucket");
    assert.equal(patched.open, 100);
    assert.equal(patched.high, 101);
    assert.equal(patched.low, 99);
    assert.equal(patched.close, 100.1);
    assert.equal(patched.volume, 7);
    assert.equal(patched.delta, 3);
    assert.equal(patched.count, 6);
    assert.equal(patched.hasRef, true);
    const cell = patched.cells.get(100);
    assert.ok(cell !== undefined, "priceStep 10 quantizes the 100.1 trade into bin 100");
    assert.equal(cell.buyVol, 2);
    assert.equal(cell.sellVol, 0);
    assert.equal(cell.count, 1);
    assert.equal(cell.buyCount, 1);
    assert.equal(cell.sellCount, 0);
  } finally {
    pipeline.dispose();
  }
});

// ---------------------------------------------------------------------------
// FE-338 (#338 scope): same-generation live trade vs the pre-built replacement
// map. Static risk under test: replacementByStart is frozen before the public
// onBeforeUpdate("history-patched") callback runs, so a bar the callback
// legitimately creates through the PUBLIC trade port cannot be in that map and
// the later series.replaceRange may erase it.
// ---------------------------------------------------------------------------
test("T15-B-FE RED: same-generation live trade applied inside history-patched onBeforeUpdate survives the day replaceRange", async (t) => {
  // Given a chart holding one snapshot-owned bar at T0 and one unowned
  // same-day bar at T0 + 2 * MINUTE (seed finance O 100 / H 101 / L 99 /
  // C 100, V 5, D 1, N 5, empty cells), a verified EMPTY candle snapshot that
  // owns only [T0, T0 + MINUTE) (requestedTo and closedThrough both end at
  // T0 + MINUTE - 1, snapshotAt T0 + MINUTE + 1000), the PUBLIC
  // services.subscribeToTrades port and a scheduler that parks the flush
  // callback;
  // When the public patchDay applies the empty response and the public
  // onBeforeUpdate("history-patched") callback (one-shot, no recursion, no
  // direct series mutation, no private flush or pending seed) emits the
  // canonical live trade (id 779, time T0 + MINUTE + 30s, price 100.1,
  // qty 2, isBuy true, MARKET) through the trade sink and then runs the
  // actual parked public scheduler callback exactly once;
  // Then inside the callback the newly applied T0 + MINUTE bar exists with
  // the independent literal single-trade arithmetic (one buy @100.1 qty 2:
  // O/H/L/C 100.1, V 2, D 2, N 1, cell bin 100 buyVol 2 / sellVol 0 /
  // count 1 / buyCount 1 / sellCount 0, hasRef true) and its stored reference
  // is captured; after patchDay the owned T0 bar is absent, the old unowned
  // bar keeps its original public stored reference and finance unchanged, and
  // the new unowned T0 + MINUTE bar still exists with the same captured
  // reference and full fields.
  // EXPECTED_RED: on current main the replacement map is built before the
  // public onBeforeUpdate fires, the same-generation live bar is absent from
  // it, and the later replaceRange erases the newly applied bar.
  let tradeSink = null;
  let parkedFlush = null;
  useFakeChartDataSource(t, { history: () => ({
    bars: [],
    meta: {
      schemaVersion: 2, generatedAt: 1,
      candleCoverage: {
        schemaVersion: 1, source: "binance-klines", instrument: MARKET,
        ownership: "snapshot", status: "verified",
        requestedFrom: T0, requestedTo: T0 + MINUTE - 1,
        snapshotAt: T0 + MINUTE + 1000, closedThrough: T0 + MINUTE - 1,
        reasonCode: null,
      },
    },
  }) });
  const pipeline = makePipeline({
    services: {
      subscribeToTrades: (_market, onTrade) => { tradeSink = onTrade; return () => {}; },
      fetchPriceStep: async () => 10,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync: () => {},
    },
    scheduler: { request: (cb) => { parkedFlush = cb; return 1; }, cancel: () => {} },
  });
  try {
    pipeline.series.upsertBar(seedBar(T0));
    pipeline.series.upsertBar(seedBar(T0 + 2 * MINUTE));
    const oldUnownedRef = pipeline.series.at(1);
    assert.ok(oldUnownedRef !== undefined, "the unowned old bar must be seeded");
    assert.ok(tradeSink !== null, "the public subscribeToTrades port must deliver the trade sink at construction");
    let capturedNewBar = null;
    let historyPatchedCallbacks = 0;
    pipeline.onBeforeUpdate = (kind) => {
      if (kind !== "history-patched") return;
      historyPatchedCallbacks++;
      assert.equal(historyPatchedCallbacks, 1, "the history-patched onBeforeUpdate must fire once (one-shot, no recursion)");
      tradeSink({ id: "779", time: T0 + MINUTE + 30_000, price: 100.1, qty: 2, isBuy: true, market: MARKET });
      const flush = parkedFlush;
      assert.ok(flush !== null, "the public scheduler must have parked the live-trade flush inside the callback");
      flush();
      // Positive oracle FIRST, inside the callback, from literal arithmetic
      // for a single buy @100.1 qty 2 -- no producer helper as oracle.
      const applied = pipeline.series.at(1);
      assert.ok(applied !== undefined, "the newly applied live bar must exist inside the callback");
      assert.equal(applied.startTime, T0 + MINUTE);
      assert.equal(applied.open, 100.1);
      assert.equal(applied.high, 100.1);
      assert.equal(applied.low, 100.1);
      assert.equal(applied.close, 100.1);
      assert.equal(applied.volume, 2);
      assert.equal(applied.delta, 2);
      assert.equal(applied.count, 1);
      assert.equal(applied.hasRef, true);
      const liveCell = applied.cells.get(100);
      assert.ok(liveCell !== undefined, "priceStep 10 quantizes the 100.1 trade into bin 100");
      assert.equal(liveCell.buyVol, 2);
      assert.equal(liveCell.sellVol, 0);
      assert.equal(liveCell.count, 1);
      assert.equal(liveCell.buyCount, 1);
      assert.equal(liveCell.sellCount, 0);
      capturedNewBar = applied;
    };
    await pipeline.patchDay(T0);
    assert.equal(historyPatchedCallbacks, 1, "patchDay fired the history-patched onBeforeUpdate exactly once");
    let ownedPresent = false;
    let oldKept;
    let newKept;
    for (let i = 0; i < pipeline.series.length; i++) {
      const bar = pipeline.series.at(i);
      if (bar.startTime === T0) ownedPresent = true;
      if (bar.startTime === T0 + 2 * MINUTE) oldKept = bar;
      if (bar.startTime === T0 + MINUTE) newKept = bar;
    }
    assert.ok(!ownedPresent, "the snapshot-owned T0 bar must be deleted by the empty patch");
    assert.ok(oldKept !== undefined, "the old unowned bar must survive the patch");
    assert.ok(oldKept === oldUnownedRef, "the old unowned bar keeps its original public stored reference and finance");
    assert.equal(oldKept.open, 100);
    assert.equal(oldKept.high, 101);
    assert.equal(oldKept.low, 99);
    assert.equal(oldKept.close, 100);
    assert.equal(oldKept.volume, 5);
    assert.equal(oldKept.delta, 1);
    assert.equal(oldKept.count, 5);
    assert.equal(oldKept.cells.size, 0, "the kept old bar keeps its empty cells");
    assert.equal(oldKept.hasRef, true);
    assert.ok(newKept !== undefined, "EXPECTED_RED: the same-generation live bar must survive the day replaceRange (current main erases it through the pre-built replacement map)");
    assert.ok(newKept === capturedNewBar, "the surviving live bar keeps the reference captured inside the callback");
    assert.equal(newKept.startTime, T0 + MINUTE);
    assert.equal(newKept.open, 100.1);
    assert.equal(newKept.high, 100.1);
    assert.equal(newKept.low, 100.1);
    assert.equal(newKept.close, 100.1);
    assert.equal(newKept.volume, 2);
    assert.equal(newKept.delta, 2);
    assert.equal(newKept.count, 1);
    assert.equal(newKept.hasRef, true);
    const keptCell = newKept.cells.get(100);
    assert.ok(keptCell !== undefined, "priceStep 10 keeps the 100.1 trade in bin 100 after the patch");
    assert.equal(keptCell.buyVol, 2);
    assert.equal(keptCell.sellVol, 0);
    assert.equal(keptCell.count, 1);
    assert.equal(keptCell.buyCount, 1);
    assert.equal(keptCell.sellCount, 0);
    // FE-338 follow-up (chronology hypothesis): Given the successfully patched
    // state above (existing post-patch positives already run), When the public
    // tradeSink delivers an earlier NEW trade (id 778, T0 + MINUTE + 20s, buy
    // 100 qty 1 -- earlier id and time than 779 per Binance ordering, reordered
    // arrival permitted; no 50k floor exists, price 100 is within 0.1% of the
    // bucket open so it is not a MAX_TICK_DEV outlier) and the actual new
    // public scheduler callback runs once, Then the same actual stored bucket
    // keeps hasRef finance V 3 / D 3 / N 2, H 100.1, L 100, a single cell bin
    // 100 buy 3 / sell 0 / count 2 / buyCount 2 / sellCount 0, and the literal
    // chronological oracle holds: the earlier trade opens (O 100) and the
    // newer trade closes (C 100.1).
    parkedFlush = null;
    tradeSink({ id: "778", time: T0 + MINUTE + 20_000, price: 100, qty: 1, isBuy: true, market: MARKET });
    const followUpFlush = parkedFlush;
    assert.ok(followUpFlush !== null, "the actual public scheduler must have parked a new flush for the follow-up trade");
    followUpFlush();
    assert.equal(historyPatchedCallbacks, 1, "the live-kind follow-up trade must not re-fire the history-patched onBeforeUpdate");
    let followedBar = null;
    let followedOwnedPresent = false;
    let followedOld;
    for (let i = 0; i < pipeline.series.length; i++) {
      const bar = pipeline.series.at(i);
      if (bar.startTime === T0) followedOwnedPresent = true;
      if (bar.startTime === T0 + 2 * MINUTE) followedOld = bar;
      if (bar.startTime === T0 + MINUTE) followedBar = bar;
    }
    assert.ok(!followedOwnedPresent, "the snapshot-owned T0 bar stays absent after the follow-up trade");
    assert.ok(followedOld === oldUnownedRef, "the old unowned 2-minute bar keeps its stored reference after the follow-up trade");
    assert.equal(followedOld.open, 100);
    assert.equal(followedOld.high, 101);
    assert.equal(followedOld.low, 99);
    assert.equal(followedOld.close, 100);
    assert.equal(followedOld.volume, 5);
    assert.equal(followedOld.delta, 1);
    assert.equal(followedOld.count, 5);
    assert.equal(followedOld.cells.size, 0, "the old unowned bar keeps its empty cells after the follow-up trade");
    assert.ok(followedBar !== null, "the actual T0 + MINUTE bucket must still exist after the follow-up trade");
    assert.equal(followedBar.startTime, T0 + MINUTE);
    assert.ok(followedBar === capturedNewBar, "the follow-up trade updates the same actual stored bucket reference captured inside the callback");
    assert.equal(followedBar.volume, 3);
    assert.equal(followedBar.delta, 3);
    assert.equal(followedBar.count, 2);
    assert.equal(followedBar.hasRef, true);
    assert.equal(followedBar.high, 100.1);
    assert.equal(followedBar.low, 100);
    assert.equal(followedBar.cells.size, 1);
    const followedCell = followedBar.cells.get(100);
    assert.ok(followedCell !== undefined, "both trades quantize into the single bin 100 cell");
    assert.equal(followedCell.buyVol, 3);
    assert.equal(followedCell.sellVol, 0);
    assert.equal(followedCell.count, 2);
    assert.equal(followedCell.buyCount, 2);
    assert.equal(followedCell.sellCount, 0);
    // EXPECTED_RED (independent literal chronological oracle): earlier trade
    // 100 @ +20s qty 1 then newer trade 100.1 @ +30s qty 2 => O 100, H 100.1,
    // L 100, C 100.1, V 3, D 3, N 2, cell 100 buy 3 / sell 0 / count 2.
    // Root cause confirmed: replaceRange drops the retained live bar's private
    // trade-order bounds, so the earlier 778 print takes the bounds-absent
    // branch (absent bounds mean the history open/close stays authoritative)
    // instead of moving the open; expected open 100 vs actual 100.1 is the
    // first proper RED; the close 100.1 expectation is kept for GREEN after
    // the real fix.
    assert.equal(followedBar.open, 100, "EXPECTED_RED: the earlier trade (100 @ +20s) must set the bucket open");
    assert.equal(followedBar.close, 100.1, "the newer trade (100.1 @ +30s) must set the bucket close (GREEN after the real fix)");
  } finally {
    pipeline.dispose();
  }
});

// ---------------------------------------------------------------------------
// FE-338 bounded regression controls (public compiled FootprintSeries only):
// the retained-instance chronology invariant behind the RED case above, plus
// a fresh canonical negative control proving the fix does not leak live
// trade-order bounds onto a new bar instance at the same timestamp.
// ---------------------------------------------------------------------------
test("FE-338 regression: a protected live bar keeps its live trade-order bounds across a public replaceRange", () => {
  // Given a restorable Date.now stub pinned at T0 + MINUTE + 40s so the
  // protected-live bucket is deterministically T0 + MINUTE, and a public
  // FootprintSeries (interval MINUTE, priceStep 10, reference MARKET)
  // holding the canonical live print id 779 @ T0 + MINUTE + 30s buy 100.1
  // qty 2 (O/H/L/C 100.1, V 2, D 2, N 1, cell bin 100 buy 2 / sell 0 /
  // count 1 / buyCount 1 / sellCount 0, hasRef true) with its actual stored
  // reference captured;
  // When the public replaceRange(T0 + MINUTE, T0 + 2 * MINUTE, []) runs and
  // then an earlier NEW print id 778 @ +20s buy 100 qty 1 arrives through
  // the public addTrade;
  // Then the same actual stored bar reference survives the replaceRange with
  // its finance unchanged, and the follow-up keeps the literal chronology:
  // O 100 (earlier trade opens), H 100.1, L 100, C 100.1 (newer trade
  // closes), V 3, D 3, N 2, one cell bin 100 buy 3 / sell 0 / count 2 /
  // buyCount 2 / sellCount 0. Same retained-instance invariant, no new
  // product threshold, no private bounds access.
  const realDateNow = Date.now;
  const pinnedNow = T0 + MINUTE + 40_000;
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 10, referenceMarket: MARKET });
  try {
    Date.now = () => pinnedNow;
    series.addTrade({ id: "779", time: T0 + MINUTE + 30_000, price: 100.1, qty: 2, isBuy: true, market: MARKET });
    const stored = series.get(T0 + MINUTE);
    assert.ok(stored !== undefined, "the live print must create the T0 + MINUTE bucket");
    assert.equal(stored.open, 100.1);
    assert.equal(stored.high, 100.1);
    assert.equal(stored.low, 100.1);
    assert.equal(stored.close, 100.1);
    assert.equal(stored.volume, 2);
    assert.equal(stored.delta, 2);
    assert.equal(stored.count, 1);
    assert.equal(stored.hasRef, true);
    series.replaceRange(T0 + MINUTE, T0 + 2 * MINUTE, []);
    const kept = series.get(T0 + MINUTE);
    assert.ok(kept === stored, "the protected live bar keeps its actual stored reference");
    assert.equal(kept.open, 100.1);
    assert.equal(kept.high, 100.1);
    assert.equal(kept.low, 100.1);
    assert.equal(kept.close, 100.1);
    assert.equal(kept.volume, 2);
    assert.equal(kept.delta, 2);
    assert.equal(kept.count, 1);
    assert.equal(kept.hasRef, true);
    series.addTrade({ id: "778", time: T0 + MINUTE + 20_000, price: 100, qty: 1, isBuy: true, market: MARKET });
    const followed = series.get(T0 + MINUTE);
    assert.ok(followed === stored, "the earlier trade updates the same actual stored bucket reference");
    assert.equal(followed.open, 100, "the earlier trade (100 @ +20s) must set the bucket open");
    assert.equal(followed.high, 100.1);
    assert.equal(followed.low, 100);
    assert.equal(followed.close, 100.1, "the newer trade (100.1 @ +30s) must keep the bucket close");
    assert.equal(followed.volume, 3);
    assert.equal(followed.delta, 3);
    assert.equal(followed.count, 2);
    assert.equal(followed.hasRef, true);
    assert.equal(followed.cells.size, 1);
    const followedCell = followed.cells.get(100);
    assert.ok(followedCell !== undefined, "priceStep 10 quantizes both trades into bin 100");
    assert.equal(followedCell.buyVol, 3);
    assert.equal(followedCell.sellVol, 0);
    assert.equal(followedCell.count, 2);
    assert.equal(followedCell.buyCount, 2);
    assert.equal(followedCell.sellCount, 0);
  } finally {
    Date.now = realDateNow;
  }
});

test("FE-338 regression: a fresh canonical bar instance at the same timestamp does not inherit the prior live bounds", () => {
  // Given a public FootprintSeries whose live print id 779 @ +30s buy 100.1
  // qty 2 sits in the long-closed T0 + MINUTE bucket (real current time is
  // far outside it, so no protected-live branch applies);
  // When the public replaceRange(T0 + MINUTE, T0 + 2 * MINUTE, [seed])
  // stores an independent NEW seed object (O 100 / H 101 / L 99 / C 100,
  // V 5, D 1, N 5, empty cells, hasRef true) at that timestamp and then an
  // earlier NEW print id 778 @ +20s buy 100.05 qty 1 arrives (0.05 % off
  // the seed open: not a MAX_TICK_DEV outlier);
  // Then the stored bar is the new canonical instance (not the old live
  // object), the seed finance is intact before the follow-up, and the
  // follow-up anchors only the close: O 100 preserved, H 101, L 99,
  // C 100.05, V 6, D 2, N 6, single cell bin 100 buy 1 / sell 0 /
  // count 1 / buyCount 1 / sellCount 0. The prior live first/last order
  // and authoritativeOpen must NOT leak onto the new instance.
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 10, referenceMarket: MARKET });
  series.addTrade({ id: "779", time: T0 + MINUTE + 30_000, price: 100.1, qty: 2, isBuy: true, market: MARKET });
  const liveBar = series.get(T0 + MINUTE);
  assert.ok(liveBar !== undefined, "the live print must create the T0 + MINUTE bucket");
  assert.equal(liveBar.open, 100.1);
  assert.equal(liveBar.close, 100.1);
  series.replaceRange(T0 + MINUTE, T0 + 2 * MINUTE, [seedBar(T0 + MINUTE)]);
  const canonical = series.get(T0 + MINUTE);
  assert.ok(canonical !== undefined, "the replacement seed bar must be stored");
  assert.ok(canonical !== liveBar, "the stored bar is the new canonical instance, not the old live object");
  assert.equal(canonical.open, 100);
  assert.equal(canonical.high, 101);
  assert.equal(canonical.low, 99);
  assert.equal(canonical.close, 100);
  assert.equal(canonical.volume, 5);
  assert.equal(canonical.delta, 1);
  assert.equal(canonical.count, 5);
  assert.equal(canonical.cells.size, 0, "the seed bar keeps its empty cells");
  assert.equal(canonical.hasRef, true);
  series.addTrade({ id: "778", time: T0 + MINUTE + 20_000, price: 100.05, qty: 1, isBuy: true, market: MARKET });
  const anchored = series.get(T0 + MINUTE);
  assert.ok(anchored === canonical, "the follow-up updates the new canonical instance");
  assert.equal(anchored.open, 100, "the canonical seed open stays authoritative for the new instance");
  assert.equal(anchored.high, 101);
  assert.equal(anchored.low, 99);
  assert.equal(anchored.close, 100.05, "the first new live print anchors the close");
  assert.equal(anchored.volume, 6);
  assert.equal(anchored.delta, 2);
  assert.equal(anchored.count, 6);
  assert.equal(anchored.cells.size, 1);
  const anchoredCell = anchored.cells.get(100);
  assert.ok(anchoredCell !== undefined, "priceStep 10 quantizes 100.05 into bin 100");
  assert.equal(anchoredCell.buyVol, 1);
  assert.equal(anchoredCell.sellVol, 0);
  assert.equal(anchoredCell.count, 1);
  assert.equal(anchoredCell.buyCount, 1);
  assert.equal(anchoredCell.sellCount, 0);
});
// ---------------------------------------------------------------------------
// FE-338 (#338 scope): isolated repair-ownership preflight (RED). Static risk
// under test: replaceRange clears the committed repair-ownership fence for its
// range even when the caller passes back the SAME actual stored bar reference,
// so an already-covered watermark trade (id <= W) becomes re-applicable and
// double-counts finance. Public FootprintSeries surface only.
// ---------------------------------------------------------------------------
test("FE-338 RED: a repair-owned bucket survives a same-reference replaceRange and keeps rejecting its covered watermark trade", () => {
  // Given a pinned wall clock far outside every bucket below (no protected
  // live bar interferes), a public FootprintSeries (interval MINUTE,
  // priceStep 1, reference MARKET), a hand-authored canonical five-print bar
  // at bucket = T0 + MINUTE (prints ids 774..778 at +0/+5/+10/+15/+20s:
  // 100 BUY 1, 101 BUY 1, 99 SELL 1, 100 BUY 1, 100 SELL 1) stored through
  // the public upsertBar with the independent hand oracle
  // O 100 / H 101 / L 99 / C 100 / V 5 / D 1 / N 5, cells 99 sell 1 /
  // count 1, 100 buy 2 / sell 1 / count 3 / buyCount 2 / sellCount 1,
  // 101 buy 1 / count 1, no liquidation, and the public
  // commitRepairOwnership([bucket], 778n, []) representing the
  // already-committed snapshot;
  // When the covered watermark trade id 778 (bucket + 20s, 100 SELL 1) is
  // delivered through the public addTrade, then the actual tail id 779
  // (bucket + 30s, 100.1 BUY 2) through addTrade, then the public
  // replaceRange covering the bucket passes back the SAME actual stored bar
  // reference, the covered 778 is delivered again, the already-consumed tail
  // 779 is replayed through addCandleTrades/addFootprintTrades, and finally
  // a genuinely NEW hand-authored canonical bar replaces the bucket;
  // Then every finance number below is the literal hand-derived oracle, with
  // the covered-trade volume as the first intended RED after the identity
  // and pre-delivery finance gates.
  const realDateNow = Date.now;
  const pinnedNow = T0 + 10 * MINUTE;
  const bucket = T0 + MINUTE;
  const handCell = (priceBin, buyVol, sellVol, count, buyCount, sellCount) => ({
    priceBin, buyVol, sellVol, count, buyCount, sellCount,
    liquidationBuyVol: 0, liquidationSellVol: 0,
  });
  // Each call returns a genuinely fresh object graph (new bar, new Map, new
  // cell objects) so the final replacement is a new identity, not the stored one.
  const canonicalBar = () => ({
    startTime: bucket,
    open: 100, high: 101, low: 99, close: 100,
    volume: 5, delta: 1, count: 5,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([
      [99, handCell(99, 0, 1, 1, 0, 1)],
      [100, handCell(100, 2, 1, 3, 2, 1)],
      [101, handCell(101, 1, 0, 1, 1, 0)],
    ]),
    hasRef: true,
  });
  const covered778 = { id: "778", time: bucket + 20_000, price: 100, qty: 1, isBuy: false, market: MARKET };
  const tail779 = { id: "779", time: bucket + 30_000, price: 100.1, qty: 2, isBuy: true, market: MARKET };
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1, referenceMarket: MARKET });
  try {
    Date.now = () => pinnedNow;
    assert.equal(series.upsertBar(canonicalBar()), true, "the independent baseline bar must be stored");
    series.commitRepairOwnership([bucket], 778n, []);
    const baseline = series.get(bucket);
    assert.ok(baseline !== undefined, "the baseline bucket must exist");
    assert.equal(series.isRepairOwned(bucket), true, "commitRepairOwnership must own the bucket");
    // Independent baseline oracle (hand math: buys 1+1+1, sells 1+1).
    assert.equal(baseline.open, 100);
    assert.equal(baseline.high, 101);
    assert.equal(baseline.low, 99);
    assert.equal(baseline.close, 100);
    assert.equal(baseline.volume, 5);
    assert.equal(baseline.delta, 1);
    assert.equal(baseline.count, 5);
    assert.equal(baseline.hasRef, true);
    assert.equal(baseline.cells.size, 3);
    assert.deepEqual(baseline.cells.get(99), handCell(99, 0, 1, 1, 0, 1));
    assert.deepEqual(baseline.cells.get(100), handCell(100, 2, 1, 3, 2, 1));
    assert.deepEqual(baseline.cells.get(101), handCell(101, 1, 0, 1, 1, 0));
    // Covered watermark trade (id <= 778n) must be rejected wholesale: the
    // ownership gate returns before any recentTrades seed can happen.
    series.addTrade(covered778);
    assert.equal(baseline.volume, 5, "the covered watermark trade must not change volume");
    assert.equal(baseline.delta, 1);
    assert.equal(baseline.count, 5);
    assert.equal(baseline.cells.get(100).sellVol, 1);
    assert.equal(series.isRepairOwned(bucket), true, "a rejected covered trade does not disturb ownership");
    // Actual tail above the watermark is applied exactly once (hand math:
    // one buy @100.1 qty 2 on top of the five-print baseline).
    series.addTrade(tail779);
    assert.equal(baseline.open, 100);
    assert.equal(baseline.high, 101);
    assert.equal(baseline.low, 99);
    assert.equal(baseline.close, 100.1);
    assert.equal(baseline.volume, 7);
    assert.equal(baseline.delta, 3);
    assert.equal(baseline.count, 6);
    assert.deepEqual(baseline.cells.get(99), handCell(99, 0, 1, 1, 0, 1));
    assert.deepEqual(baseline.cells.get(100), handCell(100, 4, 1, 4, 3, 1));
    assert.deepEqual(baseline.cells.get(101), handCell(101, 1, 0, 1, 1, 0));
    assert.equal(series.isRepairOwned(bucket), true);
    // The public replaceRange covering the bucket passes back the SAME
    // actual stored bar reference; identity and full finance hold BEFORE the
    // covered trade is triggered.
    series.replaceRange(bucket, bucket + MINUTE, [baseline]);
    const stored = series.get(bucket);
    assert.ok(stored === baseline, "the same actual stored bar reference must survive the replaceRange");
    assert.equal(stored.open, 100);
    assert.equal(stored.high, 101);
    assert.equal(stored.low, 99);
    assert.equal(stored.close, 100.1);
    assert.equal(stored.volume, 7);
    assert.equal(stored.delta, 3);
    assert.equal(stored.count, 6);
    assert.deepEqual(stored.cells.get(99), handCell(99, 0, 1, 1, 0, 1));
    assert.deepEqual(stored.cells.get(100), handCell(100, 4, 1, 4, 3, 1));
    assert.deepEqual(stored.cells.get(101), handCell(101, 1, 0, 1, 1, 0));
    // The covered watermark trade must STILL be rejected after the
    // same-reference replaceRange. Volume is the first intended RED: on the
    // current source the fence was cleared, so the covered print re-applies
    // (hypothesis: V 8 / D 2 / N 7, bin 100 buy 4 / sell 2 / count 5).
    series.addTrade(covered778);
    assert.equal(stored.volume, 7, "EXPECTED_RED: the already-covered watermark trade must not double-count volume after a same-reference replaceRange");
    assert.equal(stored.delta, 3);
    assert.equal(stored.count, 6);
    assert.deepEqual(stored.cells.get(100), handCell(100, 4, 1, 4, 3, 1));
    assert.equal(series.isRepairOwned(bucket), true, "EXPECTED_RED: the ownership fence must survive a same-reference replaceRange");
    // The already-consumed tail halves (> W) must not replay through the
    // split candle/footprint ports.
    series.addCandleTrades([tail779]);
    series.addFootprintTrades([tail779]);
    assert.equal(stored.volume, 7);
    assert.equal(stored.delta, 3);
    assert.equal(stored.count, 6);
    assert.deepEqual(stored.cells.get(100), handCell(100, 4, 1, 4, 3, 1));
    // Negative control: a genuinely NEW canonical bar instance resets the old
    // ownership as existing API behavior, and the covered 778 is accepted as
    // a fresh live print (hand math: baseline plus one sell @100 qty 1).
    series.replaceRange(bucket, bucket + MINUTE, [canonicalBar()]);
    const fresh = series.get(bucket);
    assert.ok(fresh !== undefined, "the replacement bar must be stored");
    assert.ok(fresh !== baseline, "the stored bar is a genuinely new canonical instance");
    assert.equal(series.isRepairOwned(bucket), false, "a new canonical replacement resets the old ownership");
    assert.equal(fresh.open, 100);
    assert.equal(fresh.high, 101);
    assert.equal(fresh.low, 99);
    assert.equal(fresh.close, 100);
    assert.equal(fresh.volume, 5);
    assert.equal(fresh.delta, 1);
    assert.equal(fresh.count, 5);
    series.addTrade(covered778);
    assert.equal(fresh.open, 100);
    assert.equal(fresh.high, 101);
    assert.equal(fresh.low, 99);
    assert.equal(fresh.close, 100);
    assert.equal(fresh.volume, 6);
    assert.equal(fresh.delta, 0);
    assert.equal(fresh.count, 6);
    assert.deepEqual(fresh.cells.get(99), handCell(99, 0, 1, 1, 0, 1));
    assert.deepEqual(fresh.cells.get(100), handCell(100, 2, 2, 4, 2, 2));
    assert.deepEqual(fresh.cells.get(101), handCell(101, 1, 0, 1, 1, 0));
  } finally {
    Date.now = realDateNow;
  }
});
// ---------------------------------------------------------------------------
// FE-338 follow-up (#338 scope): the retained-identity repair-ownership fix
// must not depend on live trade-order bounds existing, and duplicate incoming
// bars must resolve ownership by the FINAL last-wins stored identity. Public
// FootprintSeries surface only, fresh series per variant.
// ---------------------------------------------------------------------------
test("FE-338 GREEN control: retained repair ownership works without live bounds and follows the final winning duplicate identity", () => {
  // Given a pinned wall clock far outside every bucket below (no protected
  // live bar interferes), a public FootprintSeries (interval MINUTE,
  // priceStep 1, reference MARKET) seeded per variant with the hand-authored
  // canonical five-print bar at bucket = T0 + 2 * MINUTE (prints ids
  // 774..778 at +0/+5/+10/+15/+20s: 100 BUY 1, 101 BUY 1, 99 SELL 1,
  // 100 BUY 1, 100 SELL 1) stored through the public upsertBar (hand oracle
  // O 100 / H 101 / L 99 / C 100 / V 5 / D 1 / N 5, cells 99 sell 1 /
  // count 1, 100 buy 2 / sell 1 / count 3, 101 buy 1 / count 1) and the
  // public commitRepairOwnership([bucket], 778n, []) with NO post-snapshot
  // live tail print before the replacement -- so owned metadata exists
  // WITHOUT any refTradeBounds entry for the bucket;
  // When the public replaceRange covering the bucket is given [stored],
  // [newCanonical, stored] or [stored, newCanonical], and the covered
  // watermark trade id 778 (bucket + 20s, 100 SELL 1, market MARKET) is
  // delivered through the public addTrade;
  // Then the same-instance and [new, stored] variants keep the original
  // stored reference and the ownership fence and reject the covered print
  // (V 5 / D 1 / N 5, every cell unchanged), while [stored, new] stores the
  // new canonical reference, resets ownership and accepts the covered print
  // as a fresh live sell (V 6 / D 0 / N 6, cell 100 buy 2 / sell 2 /
  // count 4, cells 99 and 101 and OHLC unchanged).
  const realDateNow = Date.now;
  const pinnedNow = T0 + 10 * MINUTE;
  const bucket = T0 + 2 * MINUTE;
  const handCell = (priceBin, buyVol, sellVol, count, buyCount, sellCount) => ({
    priceBin, buyVol, sellVol, count, buyCount, sellCount,
    liquidationBuyVol: 0, liquidationSellVol: 0,
  });
  const canonicalBar = () => ({
    startTime: bucket,
    open: 100, high: 101, low: 99, close: 100,
    volume: 5, delta: 1, count: 5,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([
      [99, handCell(99, 0, 1, 1, 0, 1)],
      [100, handCell(100, 2, 1, 3, 2, 1)],
      [101, handCell(101, 1, 0, 1, 1, 0)],
    ]),
    hasRef: true,
  });
  const covered778 = { id: "778", time: bucket + 20_000, price: 100, qty: 1, isBuy: false, market: MARKET };
  const variants = [
    ["same stored instance", (baseline) => [baseline], true],
    ["[newCanonical, stored] final winner", (baseline) => [canonicalBar(), baseline], true],
    ["[stored, newCanonical] final winner", (baseline) => [baseline, canonicalBar()], false],
  ];
  try {
    Date.now = () => pinnedNow;
    for (const [label, replacement, keepsOwnership] of variants) {
      const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1, referenceMarket: MARKET });
      assert.equal(series.upsertBar(canonicalBar()), true, label + ": the independent baseline bar must be stored");
      series.commitRepairOwnership([bucket], 778n, []);
      const baseline = series.get(bucket);
      assert.ok(baseline !== undefined, label + ": the baseline bucket must exist");
      assert.equal(series.isRepairOwned(bucket), true, label + ": commitRepairOwnership must own the bucket");
      // Independent baseline oracle (hand math) BEFORE the replacement.
      assert.equal(baseline.volume, 5);
      assert.equal(baseline.delta, 1);
      assert.equal(baseline.count, 5);
      series.replaceRange(bucket, bucket + MINUTE, replacement(baseline));
      const stored = series.get(bucket);
      assert.ok(stored !== undefined, label + ": the replacement must store a bar");
      // Exact FINAL winner and ownership gate BEFORE the covered delivery.
      if (keepsOwnership) {
        assert.ok(stored === baseline, label + ": the original stored bar reference must be the final winner");
        assert.equal(series.isRepairOwned(bucket), true, label + ": retained ownership must not depend on live bounds");
      } else {
        assert.ok(stored !== baseline, label + ": the new canonical bar reference must be the final winner");
        assert.equal(series.isRepairOwned(bucket), false, label + ": a new final winner resets ownership");
      }
      // Pre-delivery finance gate (hand oracle).
      assert.equal(stored.open, 100);
      assert.equal(stored.high, 101);
      assert.equal(stored.low, 99);
      assert.equal(stored.close, 100);
      assert.equal(stored.volume, 5);
      assert.equal(stored.delta, 1);
      assert.equal(stored.count, 5);
      assert.deepEqual(stored.cells.get(99), handCell(99, 0, 1, 1, 0, 1));
      assert.deepEqual(stored.cells.get(100), handCell(100, 2, 1, 3, 2, 1));
      assert.deepEqual(stored.cells.get(101), handCell(101, 1, 0, 1, 1, 0));
      series.addTrade(covered778);
      // Literal finance after the covered delivery (hand oracle).
      assert.equal(stored.open, 100);
      assert.equal(stored.high, 101);
      assert.equal(stored.low, 99);
      assert.equal(stored.close, 100);
      if (keepsOwnership) {
        assert.equal(stored.volume, 5, label + ": the covered watermark trade must stay rejected without live bounds");
        assert.equal(stored.delta, 1);
        assert.equal(stored.count, 5);
        assert.deepEqual(stored.cells.get(99), handCell(99, 0, 1, 1, 0, 1));
        assert.deepEqual(stored.cells.get(100), handCell(100, 2, 1, 3, 2, 1));
        assert.deepEqual(stored.cells.get(101), handCell(101, 1, 0, 1, 1, 0));
        assert.equal(series.isRepairOwned(bucket), true, label + ": ownership holds after the rejected covered trade");
      } else {
        assert.equal(stored.volume, 6, label + ": the covered trade is a fresh live print after the reset");
        assert.equal(stored.delta, 0);
        assert.equal(stored.count, 6);
        assert.deepEqual(stored.cells.get(99), handCell(99, 0, 1, 1, 0, 1));
        assert.deepEqual(stored.cells.get(100), handCell(100, 2, 2, 4, 2, 2));
        assert.deepEqual(stored.cells.get(101), handCell(101, 1, 0, 1, 1, 0));
        assert.equal(series.isRepairOwned(bucket), false, label + ": ownership stays reset after the accepted covered trade");
      }
    }
  } finally {
    Date.now = realDateNow;
  }
});
