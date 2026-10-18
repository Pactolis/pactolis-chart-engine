/**
 * Regressions for the 2026-10-02 /history contract review:
 *  - a degraded or empty day patch keeps the day already on the chart
 *  - an unproven recent-coverage snapshot cannot rewrite a repair-owned bucket
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");
const { useFakeChartDataSource } = await import("./support/fakeChartDataSource.mjs");

const MARKET = "BINANCE_FUTURES:btcusdt";
const MINUTE = 60_000;
const T0 = Date.UTC(2024, 0, 1);

function makePipeline(overrides = {}) {
  return new ChartDataPipeline({
    market: MARKET,
    intervalMs: MINUTE,
    priceStep: 10,
    services: {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 10,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync: () => {},
    },
    scheduler: { request: () => 0, cancel: () => {} },
    ...overrides,
  });
}

function bar(startTime, cells = []) {
  return {
    startTime,
    open: 100, high: 101, low: 99, close: 100,
    volume: 5, delta: 1, count: 5,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map(cells.map((cell) => [cell.priceBin, {
      buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0,
      liquidationBuyVol: 0, liquidationSellVol: 0, ...cell,
    }])),
    hasRef: true,
  };
}

for (const [name, answer] of [
  ["a kline source failure", {
    bars: [],
    meta: {
      schemaVersion: 2, generatedAt: 0, degraded: true,
      provenance: [{ source: "binance-klines", error: "429" }],
      candleCoverage: { schemaVersion: 1, status: "error", reasonCode: "source_unavailable" },
    },
  }],
  ["an empty clean response", { bars: [], meta: { schemaVersion: 2, generatedAt: 0 } }],
]) {
  test(`patchDay keeps the day on the chart after ${name}`, async (t) => {
    useFakeChartDataSource(t, { history: () => answer });
    const pipeline = makePipeline();
    try {
      pipeline.series.upsertBar(bar(T0));
      pipeline.series.upsertBar(bar(T0 + MINUTE));
      await pipeline.patchDay(T0);
      assert.equal(pipeline.series.length, 2);
    } finally {
      pipeline.dispose();
    }
  });
}

test("an unproven recent-coverage snapshot does not rewrite a repair-owned bucket", async () => {
  const from = T0;
  const to = from + MINUTE;
  const pipeline = makePipeline({
    market: "M",
    services: {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 1,
      fetchPricePrecision: async () => undefined,
      triggerAutoSync() {},
      fetchHistory: async (q) => {
        q.onMeta?.({
          schemaVersion: 2,
          generatedAt: q.to,
          footprint: { available: true },
          footprintCoverage: {
            schemaVersion: 1, source: "binance-usdm-aggTrade", instrument: q.reference,
            authority: "provisional", status: "pending",
            requestedFrom: q.from, requestedTo: q.to, coveredFrom: null, coveredThrough: null,
            durableThroughId: null, projectionThroughId: "100", authorityToken: "token", reasonCode: null,
          },
        });
        return [bar(from, [{ priceBin: 100, buyVol: 9, count: 9, buyCount: 9 }])];
      },
    },
  });
  try {
    pipeline.series.upsertBar(bar(from));
    pipeline.series.commitRepairOwnership([from], 50n, []);
    await pipeline.repairRecentFootprintCoverage(from, to);
    assert.equal(pipeline.series.at(0).cells.size, 0, "the owned bucket keeps its proven data");
  } finally {
    pipeline.dispose();
  }
});
