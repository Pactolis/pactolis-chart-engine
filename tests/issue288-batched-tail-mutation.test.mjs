import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import {
  indicatorPriceSeriesMutation,
  indicatorSeriesMutation,
} from "../dist/features/indicators/seriesMutationSummary.js";

const INTERVAL = 60_000;
const BASE_TIME = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);

function makeSeries(barCount) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  const bars = [];
  for (let i = 0; i < barCount; i += 1) {
    const startTime = BASE_TIME + i * INTERVAL;
    const price = 100 + (i % 20);
    bars.push({
      startTime,
      open: price,
      high: price + 2,
      low: price - 2,
      close: price + 1,
      volume: 10,
      delta: 2,
      count: 1,
      cells: new Map(),
      completeness: "complete",
    });
  }
  series.loadBars(bars);
  return series;
}

function countIndexReads(series, fn) {
  const origListReadonly = series.listReadonly.bind(series);
  let indexReads = 0;
  series.listReadonly = () => {
    const arr = origListReadonly();
    return new Proxy(arr, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) indexReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  try {
    return { result: fn(), indexReads };
  } finally {
    series.listReadonly = origListReadonly;
  }
}

test("#288: batched trades on the tail bar keep O(1) bar reads independent of history length", () => {
  for (const barCount of [2_000, 20_000]) {
    const series = makeSeries(barCount);
    indicatorPriceSeriesMutation(series);
    indicatorSeriesMutation(series);

    const tailTime = BASE_TIME + (barCount - 1) * INTERVAL;
    let tradeSeq = 1;

    for (const batchSize of [1, 2, 25]) {
      for (let i = 0; i < batchSize; i += 1) {
        series.addTrade({
          id: `t-${tradeSeq++}`,
          time: tailTime + 1_000 + tradeSeq,
          price: 120 + (tradeSeq % 5),
          qty: 1,
          isBuy: true,
          market: "BINANCE_FUTURES:btcusdt",
          source: "live",
        });
      }
      const priceCheck = countIndexReads(series, () => indicatorPriceSeriesMutation(series));
      const fullCheck = countIndexReads(series, () => indicatorSeriesMutation(series));
      assert.equal(priceCheck.result.kind, "tail", `barCount=${barCount} batch=${batchSize}`);
      assert.equal(fullCheck.result.kind, "tail", `barCount=${barCount} batch=${batchSize}`);
      assert.ok(priceCheck.indexReads <= 2, `expected O(1) reads, got ${priceCheck.indexReads} on ${barCount} bars`);
      assert.ok(fullCheck.indexReads <= 2, `expected O(1) reads, got ${fullCheck.indexReads} on ${barCount} bars`);
    }
  }
});

test("#288: old-bar trade in batch, metadata-only update, backfill, and reset classify accurately", () => {
  const series = makeSeries(200);
  indicatorPriceSeriesMutation(series);

  // Old-bar trade + tail trade in same batch => non-tail
  series.addTrade({
    id: "old-1",
    time: BASE_TIME + 5 * INTERVAL + 1_000,
    price: 250,
    qty: 5,
    isBuy: true,
    market: "BINANCE_FUTURES:btcusdt",
    source: "live",
  });
  series.addTrade({
    id: "tail-1",
    time: BASE_TIME + 199 * INTERVAL + 1_000,
    price: 130,
    qty: 1,
    isBuy: true,
    market: "BINANCE_FUTURES:btcusdt",
    source: "live",
  });
  assert.equal(indicatorPriceSeriesMutation(series).kind, "non-tail");

  // Metadata-only update (precision change) => metadata in O(1)
  series.setPricePrecision(4);
  const metaCheck = countIndexReads(series, () => indicatorPriceSeriesMutation(series));
  assert.equal(metaCheck.result.kind, "metadata");
  assert.ok(metaCheck.indexReads <= 2);

  // Reset => structure
  series.clear();
  assert.equal(indicatorPriceSeriesMutation(series).kind, "structure");
});
