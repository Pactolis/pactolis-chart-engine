import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";

test("liquidations add separate volume without moving OHLC", () => {
  const activeTime = Date.UTC(2020, 0, 2);
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: "X:p" });
  series.addTrade({ time: activeTime + 1, price: 100, qty: 1, isBuy: true, market: "X:p" });
  series.addTrade({ time: activeTime + 2, price: 1000, qty: 2, isBuy: false, liquidation: true, market: "X:p" });
  const bar = series.at(0);
  assert.equal(bar.high, 100);
  assert.equal(bar.low, 100);
  assert.equal(bar.volume, 1);
  assert.equal(bar.liquidationSellVol, 2);
  assert.equal(bar.delta, 1);
  assert.equal(bar.count, 1);
  assert.equal(bar.cells.get(100).buyVol, 1);
  assert.equal(bar.cells.get(1000).sellVol, 0);
  assert.equal(bar.cells.get(1000).liquidationSellVol, 2);
});
