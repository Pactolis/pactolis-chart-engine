import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";

function historyBar(startTime, priceBin, count) {
  return {
    startTime,
    open: 100, high: 101, low: 99, close: 100,
    volume: count, delta: count, count,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map([[priceBin, {
      priceBin, buyVol: count, sellVol: 0, count, buyCount: count, sellCount: 0,
      liquidationBuyVol: 0, liquidationSellVol: 0,
    }]]),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime,
  };
}

function meta(q, overrides = {}) {
  return {
    schemaVersion: 2,
    generatedAt: q.to,
    footprint: { available: true },
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      authority: "provisional",
      status: "complete",
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom: q.from,
      coveredThrough: q.to,
      durableThroughId: null,
      projectionThroughId: "100",
      authorityToken: "token",
      reasonCode: null,
      ...overrides,
    },
  };
}

test("complete repair replaces cells left by an earlier partial response", async () => {
  const from = Date.UTC(2024, 0, 1);
  const to = from + 60_000;
  let attempt = 0;
  const services = {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    fetchHistory: async (q) => {
      attempt++;
      if (attempt === 1) {
        q.onMeta?.(meta(q, {
          status: "pending",
          coveredFrom: q.from + 1,
          coveredThrough: q.to - 1,
        }));
        return [historyBar(from, 77, 2)];
      }
      q.onMeta?.(meta(q));
      return [historyBar(from, 88, 5)];
    },
  };

  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: 60_000, priceStep: 1, services });
  assert.equal(await pipeline.repairRecentFootprintCoverage(from, to), "retry");
  assert.deepEqual([...pipeline.series.at(0).cells.keys()], [77]);
  assert.equal(pipeline.series.at(0).count, 2);

  assert.equal(await pipeline.repairRecentFootprintCoverage(from, to), "complete");
  assert.deepEqual([...pipeline.series.at(0).cells.keys()], [88], "complete snapshot must replace partial cells");
  assert.equal(pipeline.series.at(0).count, 5);
  pipeline.dispose();
});
