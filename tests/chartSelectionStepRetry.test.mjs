/**
 * A market selection's price step lookup can come back unresolved (the resolver gives up
 * while the Gateway is briefly not online). The mount path retries on its own; the
 * selection correction must retry too, or the chart keeps the fallback grid for good.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

function makePipeline(answers, delays = [10, 10]) {
  const calls = [];
  const pipeline = new ChartDataPipeline({
    market: "BINANCE_FUTURES:btcusdt",
    intervalMs: 15 * 60 * 1000,
    priceStep: 10,
    services: {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 10,
      fetchPriceStepResult: async (market) => {
        calls.push(market);
        return answers[Math.min(calls.length - 1, answers.length - 1)];
      },
      fetchPricePrecision: async () => undefined,
      triggerAutoSync: () => {},
    },
    priceStepResolveTimeoutMs: 20,
    priceStepRetryDelaysMs: delays,
  });
  return { pipeline, calls };
}

test("an unresolved selection step is asked again and the real step is adopted", async () => {
  const { pipeline, calls } = makePipeline([{ step: 10, resolved: false }, { step: 50, resolved: true }]);
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  assert.equal(pipeline.series.config.priceStep, 10, "the switch proceeds on the fallback grid");
  assert.equal(await pipeline.pendingStepCorrection, 50);
  assert.equal(pipeline.series.config.priceStep, 50);
  assert.deepEqual(calls, ["BINANCE_FUTURES:ethusdt", "BINANCE_FUTURES:ethusdt"]);
  pipeline.dispose();
});

test("the selection retry is bounded and keeps the fallback when nothing resolves", async () => {
  const { pipeline, calls } = makePipeline([{ step: 10, resolved: false }]);
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  assert.equal(await pipeline.pendingStepCorrection, null);
  assert.equal(calls.length, 3, "first lookup plus one per retry delay");
  assert.equal(pipeline.series.config.priceStep, 10);
  pipeline.dispose();
});

test("dispose stops a pending selection retry", async () => {
  const { pipeline, calls } = makePipeline([{ step: 10, resolved: false }, { step: 50, resolved: true }], [60_000]);
  await pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  pipeline.dispose();
  assert.equal(await pipeline.pendingStepCorrection, null);
  assert.equal(calls.length, 1);
});
