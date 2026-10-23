import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";

// A bucket that a repair fence or committed repair ownership covers only takes the part of a normal
// trade that was not applied yet: ID at or below the watermark or without an exact ID is dropped,
// and the candle half and the footprint half of an ID are consumed separately. These pin that
// answer for every way `repairOwnedRemainder` can return.
const INTERVAL = 60_000;
const START = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);
const MARKET = "BINANCE_FUTURES:btcusdt";
const WATERMARK = 100n;

function trade(id, qty, isBuy, extra = {}) {
  const base = { time: START + 1_000, price: 1000, qty, tradeCount: 1, isBuy, liquidation: false, market: MARKET, source: "live", receivedAt: START + 1_001, ...extra };
  return Object.freeze(id === undefined ? base : { id, ...base });
}

function owned() {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  series.commitRepairOwnership([START], WATERMARK, []);
  return series;
}

function state(series) {
  const bar = series.get(START);
  if (!bar) return null;
  let cellBuy = 0;
  let cellSell = 0;
  for (const cell of bar.cells.values()) {
    cellBuy += cell.buyVol;
    cellSell += cell.sellVol;
  }
  return {
    volume: bar.volume, delta: bar.delta, count: bar.count, cells: bar.cells.size, cellBuy, cellSell,
    liquidationBuy: bar.liquidationBuyVol ?? 0, liquidationSell: bar.liquidationSellVol ?? 0,
  };
}

test("trades at or below the watermark and trades without an exact ID are dropped from an owned bucket", () => {
  const series = owned();
  for (const id of ["100", "50", "0", "abc", "0101", "1e3", "", undefined]) {
    series.addTrade(trade(id, 1, true));
    series.addCandleTrades([trade(id, 1, true)]);
    series.addFootprintTrades([trade(id, 1, true)]);
  }
  assert.equal(series.get(START), undefined, "no candle was opened by a dropped trade");
  series.addTrade(trade("101", 1, true));
  assert.deepEqual(state(series), { volume: 1, delta: 1, count: 1, cells: 1, cellBuy: 1, cellSell: 0, liquidationBuy: 0, liquidationSell: 0 });
});

test("the candle half and the footprint half of an ID are consumed separately", () => {
  const series = owned();
  const t = trade("101", 2, true);

  series.addCandleTrades([t]);
  assert.deepEqual(state(series), { volume: 2, delta: 2, count: 1, cells: 0, cellBuy: 0, cellSell: 0, liquidationBuy: 0, liquidationSell: 0 }, "candle half only");

  series.addCandleTrades([t]);
  assert.equal(state(series).volume, 2, "the candle half is not applied twice");

  series.addFootprintTrades([t]);
  assert.deepEqual(state(series), { volume: 2, delta: 2, count: 1, cells: 1, cellBuy: 2, cellSell: 0, liquidationBuy: 0, liquidationSell: 0 }, "footprint half completes it");

  series.addFootprintTrades([t]);
  series.addCandleTrades([t]);
  series.addTrade(t);
  assert.deepEqual(state(series), { volume: 2, delta: 2, count: 1, cells: 1, cellBuy: 2, cellSell: 0, liquidationBuy: 0, liquidationSell: 0 }, "both halves consumed: nothing more applies");
});

test("a trade delivered whole is consumed whole, and one delivered by halves completes through addTrade", () => {
  const series = owned();
  series.addTrade(trade("102", 3, false));
  series.addTrade(trade("102", 3, false));
  series.addCandleTrades([trade("102", 3, false)]);
  series.addFootprintTrades([trade("102", 3, false)]);
  assert.deepEqual(state(series), { volume: 3, delta: -3, count: 1, cells: 1, cellBuy: 0, cellSell: 3, liquidationBuy: 0, liquidationSell: 0 });

  const t = trade("103", 4, true);
  series.addCandleTrades([t]);
  assert.equal(state(series).volume, 7);
  assert.equal(state(series).cellBuy, 0, "the footprint half of 103 is still open");
  series.addTrade(t);
  assert.deepEqual(state(series), { volume: 7, delta: 1, count: 2, cells: 1, cellBuy: 4, cellSell: 3, liquidationBuy: 0, liquidationSell: 0 }, "addTrade applies only the footprint half");

  const f = trade("104", 5, true);
  series.addFootprintTrades([f]);
  assert.equal(state(series).cellBuy, 9);
  assert.equal(state(series).volume, 7, "a footprint-only delivery leaves the candle alone");
  series.addTrade(f);
  assert.deepEqual(state(series), { volume: 12, delta: 6, count: 3, cells: 1, cellBuy: 9, cellSell: 3, liquidationBuy: 0, liquidationSell: 0 }, "addTrade applies only the candle half");
});

test("liquidations and trades from another market bypass the owned-bucket filter", () => {
  const series = owned();
  series.addTrade(trade("101", 1, true));
  series.addFootprintTrades([trade("5", 2, true, { liquidation: true })]);
  series.addFootprintTrades([trade("5", 3, false, { liquidation: true })]);
  assert.deepEqual(
    { buy: state(series).liquidationBuy, sell: state(series).liquidationSell },
    { buy: 2, sell: 3 },
    "liquidations are never filtered by the watermark",
  );
  series.addTrade(trade("7", 4, true, { market: "COINBASE:btc-usd" }));
  assert.equal(state(series).volume, 1 + 4, "another market's trade is not filtered by this market's watermark");
});

test("a repair fence filters like ownership and counts the blocked tail as already consumed", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  series.beginRepairFence([START], WATERMARK, [trade("105", 1, true), trade("5", 1, true), trade("9", 1, true, { liquidation: true })]);
  series.addTrade(trade("105", 1, true));
  series.addTrade(trade("99", 1, true));
  assert.equal(series.get(START), undefined, "the blocked tail ID and an ID below the watermark are dropped");
  series.addTrade(trade("106", 6, true));
  assert.deepEqual(state(series), { volume: 6, delta: 6, count: 1, cells: 1, cellBuy: 6, cellSell: 0, liquidationBuy: 0, liquidationSell: 0 });
  series.releaseRepairFence([START]);
  series.addTrade(trade("99", 1, true));
  assert.equal(state(series).volume, 7, "without the fence an ID below the old watermark is an ordinary trade");
});

test("a bucket without ownership applies every trade whole", () => {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1, referenceMarket: MARKET });
  series.addTrade(trade("1", 1, true));
  series.addCandleTrades([trade("2", 2, true)]);
  series.addFootprintTrades([trade("3", 3, false)]);
  series.addCandleTrades([trade("3", 3, false)]);
  assert.deepEqual(state(series), { volume: 6, delta: 0, count: 3, cells: 1, cellBuy: 1, cellSell: 3, liquidationBuy: 0, liquidationSell: 0 });
});
