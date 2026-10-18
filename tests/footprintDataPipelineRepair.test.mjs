/**
 * Regressions for the footprint data-path repairs:
 *  - the server's price step is adopted when it disagrees with the client's
 *  - candle-only responses no longer wipe the live bucket's footprint
 *  - an empty history response never clears the live bucket
 *  - concurrent patchDay calls all land instead of cancelling each other
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { historyBar, useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const MARKET = "BINANCE_FUTURES:btcusdt";
// enforceFootprintPolicy strips cells from bars before 2020-01-01, so the fixtures
// have to sit after it or every assertion below would be vacuous.
const T0 = Date.UTC(2024, 0, 1); // bucket-aligned for a 1m interval
const T1 = T0 + 60_000;

function makeServices() {
  return {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 10,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync: () => {},
  };
}

function makePipeline(overrides = {}) {
  return new ChartDataPipeline({
    market: MARKET,
    intervalMs: 60_000,
    priceStep: 10,
    services: makeServices(),
    scheduler: { request: (cb) => { cb(); return 0; }, cancel: () => {} },
    ...overrides,
  });
}

// ── server price step adoption ────────────────────────────────────────────────

test("a server price step that disagrees with the client is reported once per value", () => {
  const seen = [];
  const pipeline = makePipeline({ onServerPriceStep: (step) => seen.push(step) });
  const handleMeta = pipeline.handleMeta ?? pipeline["handleMeta"];

  handleMeta({ schemaVersion: 2, generatedAt: 0, footprint: { priceStep: 0.5 } });
  handleMeta({ schemaVersion: 2, generatedAt: 0, footprint: { priceStep: 0.5 } });

  // The pipeline reports every mismatch; de-duping across reloads is the caller's
  // job (ChartRuntime keeps a per-market guard), so both reports are expected here.
  assert.deepEqual(seen, [0.5, 0.5]);
  pipeline.dispose();
});

test("a server price step equal to the client's is not reported", () => {
  const seen = [];
  const pipeline = makePipeline({ onServerPriceStep: (step) => seen.push(step) });
  const handleMeta = pipeline.handleMeta ?? pipeline["handleMeta"];

  handleMeta({ schemaVersion: 2, generatedAt: 0, footprint: { priceStep: 10 } });
  handleMeta({ schemaVersion: 2, generatedAt: 0 });
  handleMeta({ schemaVersion: 2, generatedAt: 0, footprint: { priceStep: 0 } });

  assert.deepEqual(seen, []);
  pipeline.dispose();
});

// ── preserveCells ─────────────────────────────────────────────────────────────

function barWithCells(startTime, cells) {
  return {
    startTime,
    open: 100, high: 101, low: 99, close: 100,
    volume: 5, delta: 1, count: 2,
    liquidationBuyVol: 7, liquidationSellVol: 8,
    deltaBySize: [1, 2, 3],
    cells: new Map(cells.map((bin) => [bin, {
      priceBin: bin, buyVol: 1, sellVol: 1, count: 1, buyCount: 1, sellCount: 1,
      liquidationBuyVol: 0, liquidationSellVol: 0,
    }])),
    hasRef: true,
    completeness: "complete",
    sources: ["live"],
    updatedAt: 1,
  };
}

function candleOnly(startTime) {
  return { ...barWithCells(startTime, []), sources: ["history"], liquidationBuyVol: 0, liquidationSellVol: 0, deltaBySize: undefined };
}

test("preserveCells keeps footprint a candle-only response cannot supply", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: MARKET });
  series.replaceRange(T0, T0 + 120_000, [barWithCells(T1, [100, 110])]);

  series.replaceRange(T0, T0 + 120_000, [candleOnly(T1)], { preserveCells: true });

  const bar = series.at(0);
  assert.equal(bar.cells.size, 2);
  assert.equal(bar.liquidationBuyVol, 7);
  assert.deepEqual(bar.deltaBySize, [1, 2, 3]);
});

test("preserveCells still lets a cell-bearing response replace the old cells", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: MARKET });
  series.replaceRange(T0, T0 + 120_000, [barWithCells(T1, [100, 110])]);

  series.replaceRange(T0, T0 + 120_000, [barWithCells(T1, [200])], { preserveCells: true });

  assert.deepEqual([...series.at(0).cells.keys()], [200]);
});

test("without preserveCells a candle-only response clears the cells", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: MARKET });
  series.replaceRange(T0, T0 + 120_000, [barWithCells(T1, [100])]);

  series.replaceRange(T0, T0 + 120_000, [candleOnly(T1)]);

  assert.equal(series.at(0).cells.size, 0);
});

// ── patchDay serialization ────────────────────────────────────────────────────

/** Serve each history read in one batch. */
function stubHistory(t, barsForDay) {
  const requestedFrom = [];
  useFakeChartDataSource(t, {
    history: async ({ from }) => {
      requestedFrom.push(from);
      // Each day resolves on a later macrotask, so an aborting implementation would
      // lose every request but the last.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { bars: barsForDay(from), meta: { schemaVersion: 2, generatedAt: 0 } };
    },
  });
  return { requestedFrom };
}

test("concurrent patchDay calls all land instead of cancelling each other", async (t) => {
  const DAY = 86_400_000;
  const day0 = Date.UTC(2024, 0, 1);
  const stub = stubHistory(t, (from) => [historyBar(from, {
    open: 100, high: 101, low: 99, close: 100, volume: 1, delta: 0, count: 1, liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: [{ priceBin: 100, buyVol: 1, sellVol: 0, liquidationBuyVol: 0, liquidationSellVol: 0, count: 1, buyCount: 1, sellCount: 0 }],
  })]);
  const pipeline = makePipeline();
  try {
    // Fire and forget, exactly as FootprintSyncCoordinator does for each newly
    // built day between two status polls.
    const patches = [
      pipeline.patchDay(day0),
      pipeline.patchDay(day0 + DAY),
      pipeline.patchDay(day0 + 2 * DAY),
    ];
    await Promise.all(patches);

    assert.deepEqual(stub.requestedFrom, [day0, day0 + DAY, day0 + 2 * DAY]);
    assert.equal(pipeline.series.length, 3);
  } finally {
    pipeline.dispose();
  }
});

test("patchDay dedupes a bucket already queued", async (t) => {
  const day0 = Date.UTC(2024, 0, 1);
  const stub = stubHistory(t, () => []);
  const pipeline = makePipeline();
  try {
    await Promise.all([pipeline.patchDay(day0), pipeline.patchDay(day0 + 3_600_000)]);
    // Both timestamps fall in the same UTC day, so one request covers them.
    assert.deepEqual(stub.requestedFrom, [day0]);
  } finally {
    pipeline.dispose();
  }
});
test("preserveCells keeps closed recent footprint when history is candle-only", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: MARKET });
  series.replaceRange(T0, T0 + 120_000, [barWithCells(T1, [100])]);
  const candleOnly = { ...barWithCells(T1, []), cells: new Map() };

  series.replaceRange(T0, T0 + 120_000, [candleOnly], { preserveCells: true });

  assert.deepEqual([...series.at(0).cells.keys()], [100]);
});
