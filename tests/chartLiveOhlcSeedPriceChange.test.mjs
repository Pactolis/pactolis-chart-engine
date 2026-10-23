import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { bucketStart } from "../dist/core/time.js";

const MARKET = "BINANCE_FUTURES:btcusdt";
const INTERVAL = 15 * 60_000;
const prices = (bar) => [bar.open, bar.high, bar.low, bar.close];
const cells = (bar) => [...bar.cells.values()].map((cell) => ({ ...cell }));

function bar(startTime, patch = {}) {
  return {
    startTime, open: 100, high: 110, low: 90, close: 105,
    volume: 4, delta: 0, count: 4,
    cells: new Map([[100, {
      priceBin: 100, buyVol: 2, sellVol: 2, count: 4, buyCount: 2, sellCount: 2,
    }]]),
    hasRef: true, completeness: "complete", sources: ["live"], updatedAt: 500,
    ...patch,
  };
}

function setup(t, { existing = true } = {}) {
  const pipeline = new ChartDataPipeline({
    market: MARKET, intervalMs: INTERVAL, priceStep: 1,
    services: {
      subscribeToTrades() { return () => {}; },
      fetchPriceStep: async () => 1,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync() {},
    },
  });
  t.after(() => pipeline.dispose());
  const start = bucketStart(Date.now(), INTERVAL);
  if (existing) pipeline.series.upsertBar(bar(start));
  const events = [], order = [];
  pipeline.onBeforeUpdate = (kind) => {
    order.push(["before", kind, pipeline.series.get(start) ? prices(pipeline.series.get(start)) : null]);
  };
  pipeline.onUpdate = (event) => { order.push(["after", event.kind]); events.push(event); };
  const apply = (incoming, overrides = {}) => pipeline.applyLiveBarSeed([incoming], {
    market: MARKET, intervalMs: INTERVAL, from: start, observedAt: 900, ...overrides,
  });
  return { pipeline, start, events, order, apply };
}

test("identical applicable OHLC seed emits priceChanged:false without confusing financial revision with price", (t) => {
  const { pipeline, start, events, order, apply } = setup(t);
  const series = pipeline.series;
  const trade = {
    id: "101", market: MARKET, time: start + 1, receivedAt: 600,
    price: 105, qty: 1, isBuy: true, liquidation: false, source: "live",
  };
  series.addTrade(trade);
  const actual = series.get(start);
  const beforePrices = prices(actual), beforeCells = cells(actual), footprint = actual.cells;
  const before = {
    revision: series.revision, structure: series.structureRevision, epoch: series.resetEpoch,
    volume: actual.volume, delta: actual.delta, count: actual.count, length: series.length,
    identities: series.recentTrades,
    numericIdentities: series.recentTradeIds,
  };
  const applied = apply(bar(start, {
    open: actual.open, high: actual.high, low: actual.low, close: actual.close,
    cells: new Map(), volume: 999, delta: 999, count: 999,
  }), { observedAt: (actual.updatedAt ?? 0) + 1 });
  assert.deepEqual(applied, [start], "the identical seed is applicable, not skipped to silence autoscale");
  assert.deepEqual(order, [["before", "history-patched", beforePrices], ["after", "history-patched"]]);
  assert.equal(series.get(start), actual, "preserve the actual live bar identity");
  assert.equal(actual.cells, footprint, "OHLC seed does not replace footprint cells");
  assert.deepEqual(cells(actual), beforeCells, "OHLC-only input cannot rewrite actual financial cells");
  assert.deepEqual(prices(actual), beforePrices);
  assert.deepEqual([actual.volume, actual.delta, actual.count], [before.volume, before.delta, before.count]);
  assert.equal(series.length, before.length, "an unchanged seed does not change X/index count");
  assert.equal(series.structureRevision, before.structure);
  assert.equal(series.resetEpoch, before.epoch);
  assert.ok(series.revision > before.revision, "financial/freshness revision is NOT a price-only diff");
  assert.equal(series.recentTrades, before.identities, "live trade identity container survives");
  assert.equal(series.recentTradeIds, before.numericIdentities, "and so does the one that holds the plain numeric IDs");
  series.addTrade(trade);
  assert.deepEqual([actual.volume, actual.delta, actual.count], [before.volume, before.delta, before.count],
    "the same live identity must remain deduplicated after the seed");
  assert.deepEqual(cells(actual), beforeCells);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "history-patched");
  assert.equal(events[0].source, "history");
  assert.equal(events[0].previous.length, events[0].next.length);
  assert.equal(events[0].priceChanged, false,
    "IDENTICAL_OHLC_PRICE_ONLY: identical applicable OHLC must explicitly prevent HC autoscale");
});

test("new bucket, changed open/extrema and accepted close retain normal price autoscale and correct OHLC", (t) => {
  const scenarios = [
    { label: "new bucket", existing: false, patch: {}, expected: [100, 110, 90, 105] },
    { label: "open", patch: { open: 99 }, expected: [99, 110, 90, 105] },
    { label: "high", patch: { high: 120 }, expected: [100, 120, 90, 105] },
    { label: "low", patch: { low: 80 }, expected: [100, 110, 80, 105] },
    { label: "accepted close", patch: { close: 108 }, expected: [100, 110, 90, 108] },
  ];
  for (const scenario of scenarios) {
    const { pipeline, start, events, order, apply } = setup(t, { existing: scenario.existing !== false });
    const prior = pipeline.series.get(start);
    const footprint = prior?.cells, priorCells = prior && cells(prior), priorPrices = prior && prices(prior);
    const epoch = pipeline.series.resetEpoch, revision = pipeline.series.revision;
    assert.deepEqual(apply(bar(start, { ...scenario.patch, cells: new Map() })), [start], scenario.label);
    const actual = pipeline.series.get(start);
    assert.deepEqual(prices(actual), scenario.expected, scenario.label);
    assert.deepEqual(order[0], ["before", "history-patched", priorPrices ?? null], scenario.label);
    assert.deepEqual(order[1], ["after", "history-patched"], scenario.label);
    assert.equal(pipeline.series.resetEpoch, epoch, scenario.label);
    assert.ok(pipeline.series.revision > revision, scenario.label);
    if (prior) {
      assert.equal(actual, prior, scenario.label);
      assert.equal(actual.cells, footprint, scenario.label);
      assert.deepEqual(cells(actual), priorCells, scenario.label);
    }
    assert.equal(events.length, 1, scenario.label);
    assert.equal(events[0].kind, "history-patched", scenario.label);
    // HC's existing contract autoscales unless priceChanged is explicitly false.
    assert.notEqual(events[0].priceChanged, false, scenario.label + " must allow normal autoscale");
  }
});

test("stale selection, fillMissingOnly and beforeUpdate invalidation retain seed ownership guards", (t) => {
  for (const overrides of [
    { market: "BINANCE_FUTURES:ethusdt" },
    { intervalMs: 60_000 },
    { fillMissingOnly: true },
  ]) {
    const { pipeline, start, events, order, apply } = setup(t);
    const revision = pipeline.series.revision, actual = pipeline.series.get(start);
    assert.deepEqual(apply(bar(start, { high: 120 }), overrides), []);
    assert.equal(pipeline.series.get(start), actual);
    assert.equal(pipeline.series.revision, revision);
    assert.deepEqual(events, []);
    assert.deepEqual(order, []);
  }
  const { pipeline, start, events, apply } = setup(t);
  const actual = pipeline.series.get(start), beforePrices = prices(actual);
  pipeline.onBeforeUpdate = () => pipeline.dispose();
  assert.deepEqual(apply(bar(start, { high: 120 })), []);
  assert.deepEqual(prices(actual), beforePrices, "beforeUpdate disposal prevents even a partial OHLC write");
  assert.deepEqual(events, []);
});
