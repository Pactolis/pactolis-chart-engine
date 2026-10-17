import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

const MARKET = "BINANCE_FUTURES:btcusdt";

function makeServices() {
  const subscribers = new Set();
  return {
    subscribeToTrades(_market, cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    emit(time) {
      const trade = {
        time,
        price: 100,
        qty: 1,
        isBuy: true,
        liquidation: false,
        market: MARKET,
        source: "live",
        receivedAt: time,
      };
      for (const cb of subscribers) cb(trade);
    },
  };
}

function makeManualScheduler() {
  let pending = null;
  return {
    scheduler: {
      request(cb) { pending = cb; return 1; },
      cancel() { pending = null; },
    },
    flush() {
      const cb = pending;
      pending = null;
      cb?.();
    },
  };
}

test("bar-close callbacks fire once and in order across separate live flushes", () => {
  const services = makeServices();
  const scheduler = makeManualScheduler();
  const closed = [];
  const pipeline = new ChartDataPipeline({
    market: MARKET,
    intervalMs: 60_000,
    priceStep: 1,
    services,
    scheduler: scheduler.scheduler,
  });
  pipeline.onBarClose = (bar) => closed.push(bar.startTime);

  services.emit(1_000);
  scheduler.flush();
  assert.deepEqual(closed, []);

  services.emit(60_001);
  services.emit(60_002);
  scheduler.flush();
  assert.deepEqual(closed, [0]);

  services.emit(120_001);
  scheduler.flush();
  assert.deepEqual(closed, [0, 60_000]);

  services.emit(120_002);
  scheduler.flush();
  assert.deepEqual(closed, [0, 60_000]);

  pipeline.dispose();
});
