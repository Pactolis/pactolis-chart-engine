import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries, MAX_SERIES_BARS } from "../dist/core/model/footprint.js";

const ACTIVE_TIME = Date.UTC(2020, 0, 2);

test("calendar-aligned 2w bars replace overlapping legacy fixed buckets", () => {
  const intervalMs = 14 * 24 * 60 * 60 * 1000;
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  const makeBar = (startTime, close, count) => ({
    startTime, open: 1785.07, high: 1946.75, low: 1712.45, close,
    volume: count, delta: 0, count, cells: new Map(), hasRef: true,
  });
  series.upsertBar(makeBar(1_782_950_400_000, 1846.04, 100));
  series.upsertBar(makeBar(1_783_296_000_000, 1845.32, 2));
  assert.equal(series.length, 1);
  assert.equal(series.at(0).startTime, 1_783_296_000_000);
});

test("aggregates trades by price step and increments revision", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  const revision = series.revision;
  series.addTrades([
    { time: ACTIVE_TIME + 1, price: 101, qty: 2, isBuy: true },
    { time: ACTIVE_TIME + 2, price: 109, qty: 3, isBuy: false },
  ]);
  const bar = series.at(0);
  assert.equal(bar.cells.get(100).buyVol, 2);
  assert.equal(bar.cells.get(100).sellVol, 3);
  assert.equal(bar.cells.get(100).buyCount, 1);
  assert.equal(bar.cells.get(100).sellCount, 1);
  assert.equal(bar.volume, 5);
  assert.ok(series.revision > revision);
});

test("weights directional counts by raw fills represented by an aggregate trade", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  series.addTrades([
    { time: ACTIVE_TIME + 1, price: 101, qty: 2, tradeCount: 4, isBuy: true },
    { time: ACTIVE_TIME + 2, price: 109, qty: 3, tradeCount: 2, isBuy: false },
  ]);
  const bar = series.at(0);
  const cell = bar.cells.get(100);
  assert.equal(cell.buyCount, 4);
  assert.equal(cell.sellCount, 2);
  assert.equal(cell.count, 6);
  assert.equal(bar.count, 6);
});

test("replaceRange bulk history merge avoids per-bar ordered insertion", () => {
  const intervalMs = 60_000;
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  const makeBar = (startTime) => ({
    startTime, open: 100, high: 101, low: 99, close: 100,
    volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true,
  });

  series.loadBars(Array.from({ length: 2_000 }, (_, index) => makeBar((2_000 + index) * intervalMs)));

  let orderedInsertCalls = 0;
  const originalInsertOrdered = series.insertOrdered.bind(series);
  series.insertOrdered = (start) => {
    orderedInsertCalls++;
    return originalInsertOrdered(start);
  };

  const incoming = Array.from({ length: 400 }, (_, index) => makeBar((1_600 + index) * intervalMs));
  series.replaceRange(incoming[0].startTime, incoming[incoming.length - 1].startTime + intervalMs, incoming);

  assert.equal(orderedInsertCalls, 0, "bulk history replacement must merge ordered timestamps in one pass");
  assert.equal(series.length, 2_400);
  assert.equal(series.at(0).startTime, 1_600 * intervalMs);
  assert.equal(series.at(series.length - 1).startTime, 3_999 * intervalMs);
});

test("listReadonly keeps the ordered snapshot across same-bar mutations", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.addTrade({ time: ACTIVE_TIME + 1, price: 100, qty: 1, isBuy: true });

  const first = series.listReadonly();
  const firstStructureRevision = series.structureRevision;
  series.addTrade({ time: ACTIVE_TIME + 2, price: 101, qty: 1, isBuy: true });
  const afterSameBarUpdate = series.listReadonly();

  assert.equal(afterSameBarUpdate, first, "same-bar data updates must reuse the ordered array");
  assert.equal(series.structureRevision, firstStructureRevision, "same-bar updates must not bump structural revision");
  assert.equal(afterSameBarUpdate[0].volume, 2, "snapshot entries still expose the mutated bar object");

  series.addTrade({ time: ACTIVE_TIME + 60_001, price: 102, qty: 1, isBuy: true });
  const afterAppend = series.listReadonly();
  assert.notEqual(afterAppend, first, "new logical bars must invalidate the ordered snapshot");
  assert.ok(series.structureRevision > firstStructureRevision);
  assert.equal(afterAppend.length, 2);
});

test("changing price step clears stale aggregation", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  series.addTrade({ time: ACTIVE_TIME + 1, price: 101, qty: 1, isBuy: true });
  series.setPriceStep(5);
  assert.equal(series.length, 0);
  assert.equal(series.config.priceStep, 5);
});

test("history prices infer display precision when exchange metadata is unavailable", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([{
    startTime: 0,
    open: 1845.51,
    high: 1845.94,
    low: 1845.14,
    close: 1845.14,
    volume: 1,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  }]);
  assert.equal(series.config.pricePrecision, 2,
    "footprint priceStep=1 must not round two-decimal ETH OHLC to integers");
});

test("exchange precision remains authoritative over inferred history precision", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, pricePrecision: 3 });
  series.loadBars([{
    startTime: 0,
    open: 1845.51,
    high: 1845.94,
    low: 1845.14,
    close: 1845.14,
    volume: 1,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  }]);
  assert.equal(series.config.pricePrecision, 3);
});

test("duplicate and out-of-order trades are deterministic", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  const newest = { id: "2", time: ACTIVE_TIME + 61_000, price: 110, qty: 2, isBuy: true, market: "X:Y" };
  const oldest = { id: "1", time: ACTIVE_TIME + 1_000, price: 100, qty: 1, isBuy: false, market: "X:Y" };
  series.addTrade(newest);
  series.addTrade(oldest);
  series.addTrade(oldest);
  assert.equal(series.length, 2);
  assert.equal(series.at(0).volume, 1);
  assert.equal(series.at(1).volume, 2);
});

test("periodic history refresh does not re-stall live OHLC (TASK-018)", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  const bar = (close, vol = 1, count = 1) => ({
    startTime: 0, open: 100, high: Math.max(100, close), low: Math.min(100, close), close,
    volume: vol, delta: 0, count, cells: new Map(), hasRef: true,
  });
  series.replaceRange(0, 60_000, [bar(100)]);
  for (let i = 0; i < 4; i++) series.addTrade({ time: 1000 * (i + 1), price: 105, qty: 1, isBuy: true, source: "live" });
  assert.equal(series.at(0).close, 105, "live OHLC recovers from a stale seed");
  series.replaceRange(0, 60_000, [bar(100, 5, 5)]);
  series.addTrade({ time: 9_000, price: 105, qty: 1, isBuy: true, source: "live" });
  assert.equal(series.at(0).close, 105, "history refresh must not re-stall live OHLC");
});

test("reference-market trades drive OHLC; a stale referenceMarket basis-shifts them (TASK-035)", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, referenceMarket: "OLD:x" });
  const bar = (close) => ({
    startTime: 0, open: close, high: close, low: close, close,
    volume: 0, delta: 0, count: 0, cells: new Map(), hasRef: true,
  });
  series.replaceRange(0, 60_000, [bar(1647)]);
  for (let i = 0; i < 4; i++) {
    series.addTrade({ time: 1000 * (i + 1), price: 1651, qty: 1, isBuy: true, market: "BINANCE:ethusdt", source: "live" });
  }
  assert.ok(series.at(0).close < 1648, "stale referenceMarket basis-shifts real trades (the bug)");
  series.setReferenceMarket("BINANCE:ethusdt");
  for (let i = 0; i < 4; i++) {
    series.addTrade({ time: 5000 + 1000 * i, price: 1651, qty: 1, isBuy: true, market: "BINANCE:ethusdt", source: "live" });
  }
  assert.equal(series.at(0).close, 1651, "with the matching referenceMarket, live OHLC tracks the real price");
});

test("live inserts cap an open chart's bar map and keep the newest bars", () => {
  const intervalMs = 60_000;
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  const extra = 25;
  const total = MAX_SERIES_BARS + extra;
  for (let i = 0; i < total; i++) {
    series.addTrade({ time: ACTIVE_TIME + i * intervalMs, price: 100 + (i % 7), qty: 1, isBuy: i % 2 === 0, id: String(i + 1) });
    if (i === total - 2) assert.ok(series.length <= MAX_SERIES_BARS);
  }
  assert.equal(series.length, MAX_SERIES_BARS);
  assert.equal(series.at(0).startTime, ACTIVE_TIME + extra * intervalMs, "only the oldest bars are dropped");
  assert.equal(series.at(series.length - 1).startTime, ACTIVE_TIME + (total - 1) * intervalMs);
  assert.equal(series.get(ACTIVE_TIME + (extra - 1) * intervalMs), undefined);
  assert.equal(series.list().length, MAX_SERIES_BARS);

  series.upsertBar({
    startTime: ACTIVE_TIME + total * intervalMs, open: 1, high: 1, low: 1, close: 1,
    volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true,
  });
  assert.equal(series.length, MAX_SERIES_BARS);
  assert.equal(series.at(0).startTime, ACTIVE_TIME + (extra + 1) * intervalMs);
});
