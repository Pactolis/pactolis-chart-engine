import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function trade(market, time, price = 100) {
  return { time, price, qty: 1, isBuy: true, liquidation: false, market, source: "live", receivedAt: time, id: String(time) };
}

test("market switch remains subscribed to the desired market when timeframe changes during metadata resolution", async () => {
  const subscribers = new Map();
  const ethStep = deferred();
  const services = {
    subscribeToTrades(market, cb) {
      if (!subscribers.has(market)) subscribers.set(market, new Set());
      subscribers.get(market).add(cb);
      return () => subscribers.get(market)?.delete(cb);
    },
    fetchPriceStepResult: (market) => market.endsWith("ethusdt") ? ethStep.promise : Promise.resolve({ step: 1, resolved: true }),
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
  };
  const count = (market) => subscribers.get(market)?.size ?? 0;
  const emit = (market, value) => { for (const cb of subscribers.get(market) ?? []) cb(value); };

  const btc = "BINANCE_FUTURES:btcusdt";
  const eth = "BINANCE_FUTURES:ethusdt";
  const pipeline = new ChartDataPipeline({ market: btc, intervalMs: 60_000, priceStep: 1, services });
  assert.equal(count(btc), 1);

  const marketSwitch = pipeline.changeConfig({ market: eth });
  await new Promise(setImmediate);
  const timeframeSwitch = pipeline.changeConfig({ intervalMs: 300_000 });
  await timeframeSwitch;

  assert.equal(count(btc), 0, "timeframe change must reconcile the already-selected ETH target subscription");
  assert.equal(count(eth), 1);

  ethStep.resolve({ step: 1, resolved: true });
  await marketSwitch;
  assert.equal(count(btc), 0);
  assert.equal(count(eth), 1, "stale market metadata completion must not restore the old subscription");

  emit(btc, trade(btc, 1_000));
  assert.equal(pipeline.series.length, 0, "old-market trades must not reach the chart");
  emit(eth, trade(eth, 1_000));
  assert.equal(pipeline.series.length, 1, "desired-market trades must reach the chart");
  pipeline.dispose();
});
