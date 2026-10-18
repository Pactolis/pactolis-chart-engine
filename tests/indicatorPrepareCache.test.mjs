import test from "node:test";
import assert from "node:assert/strict";
import { IndicatorPrepareCache } from "../dist/features/indicators/prepareCache.js";

function key(overrides = {}) {
  return {
    definitionType: "rsi",
    instance: { id: "rsi-1" },
    series: { revision: 7 },
    rangeFrom: 10,
    rangeTo: 100,
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    intervalMs: 60_000,
    ...overrides,
  };
}

test("indicator prepare cache reuses pure prepared data for the same series revision and range", () => {
  const cache = new IndicatorPrepareCache();
  let computes = 0;
  const input = key();

  const first = cache.resolve("rsi-1", input, () => ({ value: ++computes }));
  const second = cache.resolve("rsi-1", input, () => ({ value: ++computes }));

  assert.equal(second, first);
  assert.equal(computes, 1);
});

test("indicator prepare cache invalidates on data, range, chart, or instance changes", () => {
  const cache = new IndicatorPrepareCache();
  const base = key();
  let computes = 0;
  const resolve = (input) => cache.resolve("rsi-1", input, () => ({ value: ++computes }));

  resolve(base);
  resolve({ ...base, series: { revision: 8 } });
  resolve({ ...base, rangeFrom: 11 });
  resolve({ ...base, timeframe: "5m" });
  resolve({ ...base, instance: { id: "rsi-1" } });

  assert.equal(computes, 5);
});

test("indicator prepare cache can evict one instance or clear all entries", () => {
  const cache = new IndicatorPrepareCache();
  let computes = 0;
  const input = key();
  const compute = () => ({ value: ++computes });

  cache.resolve("rsi-1", input, compute);
  cache.delete("rsi-1");
  cache.resolve("rsi-1", input, compute);
  cache.clear();
  cache.resolve("rsi-1", input, compute);

  assert.equal(computes, 3);
});

test("indicator prepare cache invalidates time-sensitive policies when their time bucket changes", () => {
  const cache = new IndicatorPrepareCache();
  let computes = 0;
  const base = { ...key(), timeBucket: 10 };
  cache.resolve("ma-1", base, () => ({ value: ++computes }));
  cache.resolve("ma-1", base, () => ({ value: ++computes }));
  cache.resolve("ma-1", { ...base, timeBucket: 11 }, () => ({ value: ++computes }));
  assert.equal(computes, 2);
});

// --- owner-local invalidation with real series ---
import { FootprintSeries } from "../dist/core/model/footprint.js";

test("primed prepare caches keep owner-local invalidation", () => {
  const intervalMs = 60_000;
  const baseStart = Date.UTC(2026, 0, 1);
  const historyBars = () => [0, 1, 2].map((index) => {
    const startTime = baseStart + index * intervalMs;
    const close = 100 + index * 2;
    return {
      startTime,
      open: 100,
      high: close + 1,
      low: 99,
      close,
      volume: 10,
      delta: 2,
      count: 5,
      cells: new Map([[100, { priceBin: 100, buyVol: 6, sellVol: 4, count: 5, buyCount: 3, sellCount: 2 }]]),
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
      updatedAt: startTime + intervalMs - 1,
      cellRevision: 1,
    };
  });
  const qualifierTrade = (seq) => ({
    id: 9000n + BigInt(seq),
    time: baseStart + 30_000 + seq * 1_000,
    price: 102.5,
    qty: 0.5,
    isBuy: true,
    tradeCount: 1,
    liquidation: false,
    market: "BINANCE_FUTURES:btcusdt",
    source: "t02b-qualifier",
    receivedAt: baseStart + 30_500 + seq * 1_000,
  });

  const seriesA = new FootprintSeries({ intervalMs, priceStep: 0.5 });
  const seriesB = new FootprintSeries({ intervalMs, priceStep: 0.5 });
  seriesA.loadBars(historyBars());
  seriesB.loadBars(historyBars());
  assert.ok(seriesA.length === 3 && seriesB.length === 3);
  assert.ok(seriesA.revision >= 1 && seriesB.revision >= 1);

  const cacheA = new IndicatorPrepareCache();
  const cacheB = new IndicatorPrepareCache();
  const instanceA = { id: "ma-owner" };
  const instanceB = { id: "ma-owner" };
  const instanceAReplacement = { id: "ma-owner" };
  const keyFor = (series, instance) => ({
    definitionType: "moving-average",
    instance,
    series,
    rangeFrom: 0,
    rangeTo: 2,
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    intervalMs,
  });
  let computesA = 0;
  let computesB = 0;
  const computeA = () => ({ revision: seriesA.revision, lastClose: seriesA.at(seriesA.length - 1)?.close, tag: ++computesA });
  const computeB = () => ({ revision: seriesB.revision, lastClose: seriesB.at(seriesB.length - 1)?.close, tag: ++computesB });
  const localId = "t02b-ma-local";

  const preparedA1 = cacheA.resolve(localId, keyFor(seriesA, instanceA), computeA);
  assert.equal(cacheA.resolve(localId, keyFor(seriesA, instanceA), computeA), preparedA1);
  assert.equal(computesA, 1);
  assert.equal(preparedA1.revision, seriesA.revision);
  const preparedB1 = cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB);
  assert.equal(cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB), preparedB1);
  assert.equal(computesB, 1);
  assert.equal(preparedB1.revision, seriesB.revision);
  assert.notEqual(preparedA1, preparedB1);
  assert.equal(keyFor(seriesB, instanceB).series, seriesB);

  seriesA.addTrade(qualifierTrade(1));
  assert.ok(seriesA.revision > preparedA1.revision);
  const preparedA2 = cacheA.resolve(localId, keyFor(seriesA, instanceA), computeA);
  assert.notEqual(preparedA2, preparedA1);
  assert.equal(computesA, 2);
  assert.equal(preparedA2.revision, seriesA.revision);
  assert.equal(cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB), preparedB1);
  assert.equal(computesB, 1);

  const preparedA3 = cacheA.resolve(localId, keyFor(seriesA, instanceAReplacement), computeA);
  assert.notEqual(preparedA3, preparedA2);
  assert.equal(computesA, 3);
  assert.equal(cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB), preparedB1);
  assert.equal(computesB, 1);

  cacheA.delete(localId);
  const preparedA4 = cacheA.resolve(localId, keyFor(seriesA, instanceAReplacement), computeA);
  assert.notEqual(preparedA4, preparedA3);
  assert.equal(computesA, 4);
  assert.equal(cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB), preparedB1);
  assert.equal(computesB, 1);

  cacheA.clear();
  const preparedA5 = cacheA.resolve(localId, keyFor(seriesA, instanceAReplacement), computeA);
  assert.notEqual(preparedA5, preparedA4);
  assert.equal(computesA, 5);
  assert.equal(cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB), preparedB1);
  assert.equal(computesB, 1);

  seriesB.addTrade(qualifierTrade(1));
  assert.ok(seriesB.revision > preparedB1.revision);
  const preparedB2 = cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB);
  assert.notEqual(preparedB2, preparedB1);
  assert.equal(computesB, 2);
  assert.equal(preparedB2.revision, seriesB.revision);
  assert.equal(cacheA.resolve(localId, keyFor(seriesA, instanceAReplacement), computeA), preparedA5);
  assert.equal(computesA, 5);
  assert.equal(cacheB.resolve(localId, keyFor(seriesB, instanceB), computeB), preparedB2);
  assert.equal(computesB, 2);
});