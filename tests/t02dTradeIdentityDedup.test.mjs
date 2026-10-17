import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { joinedTail } from "../dist/features/chart/LiveTradeRepairController.js";

// T02-D (#311) identity dedup qualification at the series layer, where live
// normal trades are deduplicated by market + trade ID.
const INTERVAL = 60_000;
const START = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);
// More identified trades than the dedup memory keeps once it starts pruning.
const FLOOD = 50_002;
// Binance aggTrade IDs only grow; the pruned-ID floor applies to these markets only.
const MARKET = "BINANCE_FUTURES:btcusdt";

function trade(id, time, price = 100, qty = 1, isBuy = true, market = MARKET) {
  return Object.freeze({ id, time, price, qty, tradeCount: 1, isBuy, liquidation: false, market, source: "live", receivedAt: time + 1 });
}

function totals(series, start) {
  const bar = series.get(start);
  assert.ok(bar, "expected candle at " + start);
  return { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, delta: bar.delta, count: bar.count };
}

test("T02-D D1: a late re-delivered identified trade is not counted twice after dedup memory pruning", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.addTrade(trade("1", START + 1_000));
  // Independent oracle: IDs 2..FLOOD+1 are distinct trades 10 ms apart, so the
  // first candle owns exactly the trades whose time falls inside it.
  let firstBucketTrades = 1;
  for (let id = 2; id <= FLOOD + 1; id++) {
    const time = START + 1_000 + id * 10;
    if (time < START + INTERVAL) firstBucketTrades++;
    series.addTrade(trade(String(id), time));
  }
  const expected = { open: 100, high: 100, low: 100, close: 100, volume: firstBucketTrades, delta: firstBucketTrades, count: firstBucketTrades };
  assert.deepEqual(totals(series, START), expected);

  // The upstream re-sends trade 1 (e.g. after a reconnect) long after it was applied.
  series.addTrade(trade("1", START + 1_000));
  assert.deepEqual(totals(series, START), expected);
});

test("T02-D D2: the pruned-ID floor only rejects re-deliveries, never newer trades, other markets or anonymous trades", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  for (let id = 1; id <= FLOOD; id++) series.addTrade(trade(String(id), START + id * 10));
  const last = FLOOD * 10;
  const lastBucket = START + Math.floor(last / INTERVAL) * INTERVAL;
  const before = totals(series, lastBucket);
  // Newer ID on the same market, an equal ID on another market, and an anonymous trade all apply.
  series.addTrade(trade(String(FLOOD + 1), START + last + 1, 101, 2));
  series.addTrade(Object.freeze({ ...trade("1", START + last + 2, 101, 3), market: "OTHER" }));
  series.addTrade(Object.freeze({ time: START + last + 3, price: 101, qty: 4, tradeCount: 1, isBuy: true, liquidation: false, market: MARKET, source: "live", receivedAt: START + last + 4 }));
  const after = totals(series, lastBucket);
  assert.equal(after.volume, before.volume + 2 + 3 + 4);
  assert.equal(after.count, before.count + 3);
  assert.equal(after.high, 101);
  assert.equal(series.identityConflictCount, 0);
});

test("T02-D D3: same ID with a different payload keeps the first delivery and is counted as a conflict", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.addTrade(trade("301", START + 1_000, 100, 2));
  series.addTrade(trade("301", START + 1_000, 100, 2));
  assert.equal(series.identityConflictCount, 0, "an identical repeat is a plain duplicate");
  series.addTrade(trade("301", START + 1_000, 105, 7, false));
  assert.deepEqual(totals(series, START), { open: 100, high: 100, low: 100, close: 100, volume: 2, delta: 2, count: 1 });
  assert.equal(series.identityConflictCount, 1);
});

function makePipelineFixture() {
  const subscribers = new Set();
  const reports = [];
  const degraded = [];
  let pending = null;
  const services = {
    subscribeToTrades(_market, cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter: () => ({ report: (state, detail = "") => reports.push([state, detail]), dispose() {} }),
  };
  const pipeline = new ChartDataPipeline({
    market: MARKET, intervalMs: INTERVAL, priceStep: 1, services,
    scheduler: { request(cb) { pending = cb; return 1; }, cancel() { pending = null; } },
    onDataDegraded: (value, detail) => degraded.push([value, detail]),
  });
  return {
    pipeline, reports, degraded,
    emit(event) { for (const cb of subscribers) cb(event); },
    flush() { const cb = pending; pending = null; cb?.(); },
  };
}

test("T02-D D4: a live identity conflict stops the owner reporting healthy; identical repeats do not", () => {
  const fixture = makePipelineFixture();
  try {
    fixture.emit(trade("401", START + 1_000, 100, 2));
    fixture.emit(trade("401", START + 1_000, 100, 2));
    fixture.flush();
    assert.equal(fixture.reports.some(([state]) => state === "error"), false);
    assert.equal(fixture.degraded.some(([value]) => value === true), false);

    fixture.emit(trade("401", START + 1_000, 104, 9, false));
    fixture.flush();
    assert.deepEqual(totals(fixture.pipeline.series, START), { open: 100, high: 100, low: 100, close: 100, volume: 2, delta: 2, count: 1 });
    assert.deepEqual(fixture.reports.at(-1)?.[0], "error");
    assert.match(fixture.reports.at(-1)?.[1] ?? "", /^TRADE_IDENTITY_CONFLICT: 1 /);
    assert.deepEqual(fixture.degraded.at(-1)?.[0], true);
    assert.match(fixture.degraded.at(-1)?.[1] ?? "", /^TRADE_IDENTITY_CONFLICT: 1 /);
  } finally {
    fixture.pipeline.dispose();
  }
});

test("T02-D D5: on markets without ordered trade IDs, pruning never drops a new trade delivered out of order", () => {
  // Opaque and venue-specific decimal IDs carry no order, so no floor may be inferred
  // from them or from event time; a late new trade must still be applied.
  for (const [market, idOf] of [["OKX:btc-usdt", (n) => "okx-" + n], ["HYPERLIQUID:btc", (n) => String(9_000_000_000 - n)]]) {
    const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
    let firstBucketTrades = 0;
    for (let n = 1; n <= FLOOD; n++) {
      const time = START + 1_000 + n * 10;
      if (time < START + INTERVAL) firstBucketTrades++;
      series.addTrade(trade(idOf(n), time, 100, 1, true, market));
    }
    assert.equal(totals(series, START).count, firstBucketTrades, market);
    series.addTrade(trade("late-new", START + 1_000, 100, 3, true, market));
    series.addTrade(trade(String(1), START + 1_001, 100, 4, true, market));
    const after = totals(series, START);
    assert.equal(after.count, firstBucketTrades + 2, market);
    assert.equal(after.volume, firstBucketTrades + 7, market);
  }
});

test("T02-D D6: an identity conflict stays reported until the series is reset", () => {
  const fixture = makePipelineFixture();
  try {
    fixture.emit(trade("601", START + 1_000, 100, 2));
    fixture.emit(trade("601", START + 1_000, 103, 2));
    fixture.flush();
    assert.equal(fixture.reports.at(-1)?.[0], "error");
    const reports = fixture.reports.length;
    const degraded = fixture.degraded.length;
    // Unrelated successes (a repair completing, a clean history response) must not clear it.
    fixture.pipeline.integrityReporter.report("healthy");
    fixture.pipeline.integrityReporter.report("pending", "Trade stream repair pending");
    fixture.pipeline.handleMeta({ degraded: false });
    assert.equal(fixture.reports.length, reports);
    assert.equal(fixture.degraded.length, degraded);
    // Resetting the series re-derives everything, so the conflict no longer applies.
    fixture.pipeline.setPriceStep(2);
    assert.deepEqual(fixture.reports.at(-1), ["healthy", ""]);
    assert.deepEqual(fixture.degraded.at(-1), [false, ""]);
  } finally {
    fixture.pipeline.dispose();
  }
});

test("T02-D D7: the repair tail keeps the first delivery of an ID and counts a conflicting repeat", () => {
  const first = trade("702", START + 1_000, 100, 2);
  const conflicting = trade("702", START + 1_000, 109, 8, false);
  const identical = trade("703", START + 2_000, 101, 1);
  const joined = joinedTail([first, identical, conflicting, identical], MARKET, 701n);
  assert.equal(joined.rejection, null);
  assert.deepEqual(joined.tail, [first, identical]);
  assert.equal(joined.conflicts, 1);
});

test("T02-D D8: a held conflict is released when the series itself is reset (async price-step correction)", () => {
  const fixture = makePipelineFixture();
  try {
    fixture.emit(trade("801", START + 1_000, 100, 2));
    fixture.emit(trade("801", START + 1_000, 107, 2));
    fixture.flush();
    assert.equal(fixture.reports.at(-1)?.[0], "error");
    fixture.pipeline.integrityReporter.report("healthy");
    assert.equal(fixture.reports.at(-1)?.[0], "error");
    // The fallback-step correction path rebuilds the series directly.
    fixture.pipeline.series.setPriceStep(5);
    fixture.pipeline.integrityReporter.report("healthy");
    fixture.pipeline.handleMeta({ degraded: false });
    assert.deepEqual(fixture.reports.at(-1), ["healthy", ""]);
    assert.deepEqual(fixture.degraded.at(-1), [false, ""]);
  } finally {
    fixture.pipeline.dispose();
  }
});
