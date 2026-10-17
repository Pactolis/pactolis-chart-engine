import test from "node:test";
import assert from "node:assert/strict";
import {
  FOOTPRINT_START_TIME,
  enforceFootprintPolicy,
  footprintEnabledAt,
} from "../dist/core/footprintPolicy.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";

function bar(startTime) {
  return {
    startTime,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 2,
    delta: 0,
    count: 2,
    cells: new Map([[100, { priceBin: 100, buyVol: 1, sellVol: 1 }]]),
    liquidationBuyVol: 1,
    liquidationSellVol: 1,
    hasRef: true,
  };
}

test("candles before 1 January 2020 keep OHLC but lose footprint data", () => {
  const original = bar(Date.UTC(2019, 11, 1));
  const safe = enforceFootprintPolicy(original);

  assert.equal(safe.open, original.open);
  assert.equal(safe.close, original.close);
  assert.equal(safe.volume, original.volume);
  assert.equal(safe.cells.size, 0);
  assert.equal(safe.liquidationBuyVol, 0);
  assert.equal(safe.liquidationSellVol, 0);
});

test("footprint starts exactly at 1 January 2020 UTC", () => {
  assert.equal(footprintEnabledAt(FOOTPRINT_START_TIME - 1), false);
  assert.equal(footprintEnabledAt(FOOTPRINT_START_TIME), true);
  assert.equal(enforceFootprintPolicy(bar(FOOTPRINT_START_TIME)).cells.size, 1);
});

test("pre-2020 trades still form a candle without footprint cells", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  series.addTrade({
    time: Date.UTC(2019, 11, 31, 23, 59),
    price: 100,
    qty: 2,
    isBuy: true,
  });

  const candle = series.at(0);
  assert.equal(candle.open, 100);
  assert.equal(candle.volume, 2);
  assert.equal(candle.delta, 2);
  assert.equal(candle.cells.size, 0);
});
