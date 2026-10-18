import test from "node:test";
import assert from "node:assert/strict";
import { buildPixelCandleBuckets, buildPixelCellBuckets, chartLodForSpacing } from "../dist/core/render/chartLod.js";

// Some dist modules read Svelte runes / browser globals at import time (same stubs
// as tests/indicatorMaRsiOracle.test.mjs and tests/replayDeterminism.test.mjs).
globalThis.$state ??= (value) => value;
globalThis.window ??= { setInterval, clearInterval };
globalThis.performance ??= { now: () => Date.now() };

test("chart LOD follows footprint, candlestick and pixel-bucket thresholds", () => {
  assert.equal(chartLodForSpacing(6), "footprint");
  assert.equal(chartLodForSpacing(2), "candlestick");
  assert.equal(chartLodForSpacing(1), "candlestick");
  assert.equal(chartLodForSpacing(0.99), "pixel-bucket");
});

test("pixel buckets preserve ordered OHLC extremes and source indices", () => {
  const bars = [
    { open: 10, high: 13, low: 9, close: 12 },
    { open: 12, high: 15, low: 8, close: 11 },
    { open: 11, high: 14, low: 10, close: 13 },
    { open: 13, high: 16, low: 12, close: 15 },
  ];
  const buckets = buildPixelCandleBuckets(0, bars.length, (index) => bars[index], (index) => index * 0.5);

  assert.deepEqual(buckets, [
    { firstIndex: 0, lastIndex: 1, x: 0, open: 10, high: 15, low: 8, close: 11 },
    { firstIndex: 2, lastIndex: 3, x: 1, open: 11, high: 16, low: 10, close: 15 },
  ]);
});

test("pixel buckets tolerate sparse accessors without inventing bars", () => {
  const bars = new Map([
    [1, { open: 5, high: 7, low: 4, close: 6 }],
    [3, { open: 6, high: 8, low: 5, close: 7 }],
  ]);
  const buckets = buildPixelCandleBuckets(0, 4, (index) => bars.get(index), () => 2.2);
  assert.deepEqual(buckets, [
    { firstIndex: 1, lastIndex: 3, x: 2, open: 5, high: 8, low: 4, close: 7 },
  ]);
});

test("cell text degrades through compact before disappearing", async () => {
  const { cellTextModeFor } = await import("../dist/core/render/chartLod.js");

  // Too short or too narrow for any text.
  assert.equal(cellTextModeFor(8, 200), "none");
  assert.equal(cellTextModeFor(20, 43), "none");
  // The band the heat layer used to shade without ever labelling.
  assert.equal(cellTextModeFor(9, 44), "compact");
  assert.equal(cellTextModeFor(20, 71), "compact");
  // Wide enough for a bid/ask pair.
  assert.equal(cellTextModeFor(20, 72), "full");
  assert.equal(cellTextModeFor(12, 200), "full");
});

test("pixel cell buckets merge sub-pixel rows without losing volume", async () => {
  const { buildPixelCellBuckets } = await import("../dist/core/render/chartLod.js");

  // 1000 price rows squeezed into 200px: 0.2px per row.
  const step = 1;
  const cells = Array.from({ length: 1000 }, (_, index) => ({
    priceBin: index, buyVol: 2, sellVol: 1,
  }));
  const yOfPrice = (price) => 200 - price * 0.2;

  const buckets = buildPixelCellBuckets(cells, step, yOfPrice);

  assert.ok(buckets.length <= 201, `expected at most one bucket per pixel, got ${buckets.length}`);
  assert.ok(buckets.length < cells.length, "must actually merge");
  const buy = buckets.reduce((sum, bucket) => sum + bucket.buyVol, 0);
  const sell = buckets.reduce((sum, bucket) => sum + bucket.sellVol, 0);
  assert.equal(buy, 2000);
  assert.equal(sell, 1000);
  // Sorted top-down, and every row is at least one pixel tall.
  for (let i = 1; i < buckets.length; i++) assert.ok(buckets[i].yTop > buckets[i - 1].yTop);
  for (const bucket of buckets) assert.ok(bucket.height >= 1);
});

test("pixel cell buckets keep rows separate when they are resolvable", async () => {
  const { buildPixelCellBuckets } = await import("../dist/core/render/chartLod.js");

  const cells = [
    { priceBin: 0, buyVol: 1, sellVol: 0 },
    { priceBin: 1, buyVol: 1, sellVol: 0 },
    { priceBin: 2, buyVol: 1, sellVol: 0 },
  ];
  const buckets = buildPixelCellBuckets(cells, 1, (price) => 100 - price * 10);

  assert.equal(buckets.length, 3);
});

// ---------------------------------------------------------------------------
// T08-A (issue #322) — LOD raw unchanged, extremes and totals property oracle.
//
// BDD scenario mapping (task type: financial/visual regression coverage;
// development mode: BDD + test-only independent properties; platform: shared):
//   S1 Given hand-authored raw FootprintBars with dense Map cells, When candle
//      and cell bucketing run at several spacings/y mappings, Then raw bars
//      (all nested objects and Map entries) and cell Map identities are
//      unchanged.
//   S2 [from,to) half-open edges, holes, empty/all-holes ranges and
//      negative/offscreen CSS x positions, with hand-computed expectations.
//   S3 PixelCellBucket buy/sell volume conservation from literal fixtures.
//   S4 Visual bucket OHLC is not the raw close series: indicator/replay
//      consumers must read retained canonical raw values, not visual buckets.
//   S5 Physical->CSS normalisation is explicit (dpr=2) and deterministic.
//   S6 FootprintSeries raw bars stay canonical and object-identical.
//   S7 Dense bounded seeded property suite: bucket coverage/order/boundaries,
//      global independent extrema and volume totals, determinism.
//
// The bucket API works in CSS pixels; full GPU/DPR visual rendering
// verification is intentionally NOT_RUN in this unit-only file.
// ---------------------------------------------------------------------------

// Given: hand-authored raw FootprintBar literals (dense cells, Map keyed by price bin).
// cellEntries tuples are [priceBin, buyVol, sellVol, count, buyCount]; sellCount is
// count - buyCount so the side counts always sum to count. Documented side counts:
// sell-only (buy 0) -> buyCount 0; buy-only -> buyCount = count; mixed buy/sell ->
// count >= 2 with at least one trade per traded side.
function rawFootprintBar(startTime, open, high, low, close, cellEntries) {
  const cells = new Map();
  let buyVol = 0;
  let sellVol = 0;
  let count = 0;
  for (const [priceBin, buy, sell, n, buyCount] of cellEntries) {
    assert.ok(buyCount >= (buy > 0 ? 1 : 0) && buyCount <= n - (sell > 0 ? 1 : 0),
      `cell ${priceBin}: side counts must be consistent with volumes`);
    cells.set(priceBin, { priceBin, buyVol: buy, sellVol: sell, count: n, buyCount, sellCount: n - buyCount, liquidationBuyVol: 0, liquidationSellVol: 0 });
    buyVol += buy;
    sellVol += sell;
    count += n;
  }
  return {
    startTime,
    open,
    high,
    low,
    close,
    volume: buyVol + sellVol,
    delta: buyVol - sellVol,
    deltaBySize: undefined,
    count,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells,
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime,
    cellRevision: 1,
  };
}

test("visual bucketing leaves raw FootprintBars deep-equal unchanged", async () => {
  const { buildPixelCellBuckets } = await import("../dist/core/render/chartLod.js");
  const bars = [
    rawFootprintBar(1800000600000, 100, 110, 95, 105, [[100, 3, 1, 2, 1], [104, 2, 2, 2, 1]]),
    rawFootprintBar(1800000660000, 105, 108, 96, 98, [[104, 5, 0, 3, 3]]),
    rawFootprintBar(1800000720000, 98, 112, 97, 111, [[98, 0, 4, 1, 0], [108, 6, 1, 4, 3]]),
  ];
  const frozen = structuredClone(bars);
  const barIds = bars.slice();
  const cellMaps = bars.map((bar) => bar.cells);
  const cellEntries = bars.map((bar) => [...bar.cells.entries()]);
  for (const spacing of [9, 1.5, 0.4]) {
    buildPixelCandleBuckets(0, bars.length, (i) => bars[i], (i) => i * spacing);
    for (const slope of [10, -10, 0.2]) {
      for (const bar of bars) buildPixelCellBuckets(bar.cells.values(), 1, (p) => 500 - p * slope);
    }
  }
  assert.deepEqual(bars, frozen);
  for (let i = 0; i < bars.length; i++) {
    assert.equal(bars[i], barIds[i]);
    assert.equal(bars[i].cells, cellMaps[i]);
  }
  assert.deepEqual(bars.map((bar) => [...bar.cells.keys()]), cellEntries.map((entries) => entries.map(([priceBin]) => priceBin)));
  for (let b = 0; b < bars.length; b++) for (const [priceBin, cell] of cellEntries[b]) assert.equal(bars[b].cells.get(priceBin), cell, `bar${b} cell ${priceBin}`);
});

test("[from,to) edges, holes, empty ranges and negative CSS x positions", () => {
  const bars = [
    { open: 10, high: 12, low: 9, close: 11 },
    { open: 11, high: 15, low: 10, close: 14 },
    { open: 14, high: 14, low: 13, close: 13 },
    { open: 13, high: 16, low: 12, close: 15 },
    { open: 15, high: 17, low: 14, close: 16 },
  ];
  // Hand-computed: x(i)=floor(i*0.4) for i in [1,4) -> pixels 0,0,1.
  assert.deepEqual(buildPixelCandleBuckets(1, 4, (i) => bars[i], (i) => i * 0.4), [
    { firstIndex: 1, lastIndex: 2, x: 0, open: 11, high: 15, low: 10, close: 13 },
    { firstIndex: 3, lastIndex: 3, x: 1, open: 13, high: 16, low: 12, close: 15 },
  ]);
  // Constant x: the whole half-open range [1,4) merges into one bucket.
  assert.deepEqual(buildPixelCandleBuckets(1, 4, (i) => bars[i], () => 0), [
    { firstIndex: 1, lastIndex: 3, x: 0, open: 11, high: 16, low: 10, close: 15 },
  ]);
  // Empty range and all-holes range invent no bars.
  assert.deepEqual(buildPixelCandleBuckets(2, 2, (i) => bars[i], (i) => i), []);
  assert.deepEqual(buildPixelCandleBuckets(0, 3, () => undefined, (i) => i), []);
  // Negative/offscreen CSS x coordinates floor (not clamp) and still merge.
  assert.deepEqual(buildPixelCandleBuckets(0, 2, (i) => bars[i], (i) => -2.6 + i * 0.5), [
    { firstIndex: 0, lastIndex: 1, x: -3, open: 10, high: 15, low: 9, close: 14 },
  ]);
  // A hole between two bars of one bucket must not split it.
  const sparse = [bars[0], undefined, bars[2]];
  assert.deepEqual(buildPixelCandleBuckets(0, 3, (i) => sparse[i], () => 7), [
    { firstIndex: 0, lastIndex: 2, x: 7, open: 10, high: 14, low: 9, close: 13 },
  ]);
});

test("pixel cell buckets conserve buy/sell volumes (literal oracle)", async () => {
  const { buildPixelCellBuckets } = await import("../dist/core/render/chartLod.js");
  const cells = [
    { priceBin: 100, buyVol: 2, sellVol: 5 },
    { priceBin: 101, buyVol: 7, sellVol: 1 },
    { priceBin: 104, buyVol: 4, sellVol: 4 },
    { priceBin: 108, buyVol: 0, sellVol: 9 },
  ];
  const frozen = structuredClone(cells);
  // y = 300 - 0.4*price floors the cell's upper bin edge priceBin + step
  // (hand-computed): 108+1 -> 256.4 -> 256; 104+1 -> 258; 100+1 -> 259.6 and
  // 101+1 -> 259.2 merge into 259. Ascending yTop = top of the chart first.
  const buckets = buildPixelCellBuckets(cells, 1, (p) => 300 - p * 0.4);
  assert.deepEqual(buckets, [
    { yTop: 256, height: 1, buyVol: 0, sellVol: 9 },
    { yTop: 258, height: 1, buyVol: 4, sellVol: 4 },
    { yTop: 259, height: 1, buyVol: 9, sellVol: 6 },
  ]);
  assert.deepEqual(cells, frozen);
  // Independent totals, not production-grouping parity.
  const buy = buckets.reduce((s, b) => s + b.buyVol, 0);
  const sell = buckets.reduce((s, b) => s + b.sellVol, 0);
  assert.equal(buy, 13);
  assert.equal(sell, 19);
  assert.equal(buy + sell, 32);
  assert.equal(buy - sell, -6);
});

test("visual bucket OHLC is not the raw close series (no semantic leak)", () => {
  const bars = [
    { open: 50, high: 52, low: 49, close: 51 },
    { open: 51, high: 55, low: 48, close: 49 },
    { open: 49, high: 50, low: 47, close: 48 },
  ];
  const [bucket] = buildPixelCandleBuckets(0, 3, (i) => bars[i], () => 1.25);
  // Hand-computed bucket OHLC 50/55/47/48: close tracks the last bar only.
  assert.deepEqual(bucket, { firstIndex: 0, lastIndex: 2, x: 1, open: 50, high: 55, low: 47, close: 48 });
  // Independent literals: the raw close minimum and the raw wick minimum are
  // genuinely different numbers, so this is not a parity fake.
  const rawCloses = bars.map((bar) => bar.close);
  assert.deepEqual(rawCloses, [51, 49, 48]);
  assert.equal(Math.min(...rawCloses), 48);
  assert.equal(Math.min(...bars.map((bar) => bar.low)), 47);
  assert.notEqual(Math.min(...rawCloses), Math.min(...bars.map((bar) => bar.low)));
  assert.equal(bucket.low, 47);
});

test("real MA and replay consumers read the raw series, not visual buckets", async () => {
  const { FootprintSeries } = await import("../dist/core/model/footprint.js");
  const { movingAverageIndicatorDefinition } = await import("../dist/features/indicators/builtins/movingAverage.js");
  const { ChartReplayCoordinator } = await import("../dist/features/chart/ChartReplayCoordinator.js");
  const T0 = 1_800_000_000_000;
  const MIN = 60_000;
  // Canonical raw bars: closes 51, 49, 48 with valid side counts per cell.
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars([
    rawFootprintBar(T0, 50, 52, 49, 51, [[51, 3, 1, 2, 1]]),
    rawFootprintBar(T0 + MIN, 51, 55, 48, 49, [[49, 2, 2, 2, 1]]),
    rawFootprintBar(T0 + 2 * MIN, 49, 50, 47, 48, [[48, 0, 4, 1, 0]]),
  ]);
  const canonical = structuredClone(series.listReadonly());
  // Hand-computed from the consistent cells: volume 4/4/4, delta 2/0/-4, count 2/2/1.
  const rawTotals = (list) => list.map((bar) => [bar.volume, bar.delta, bar.count]);
  assert.deepEqual(rawTotals(series.listReadonly()), [[4, 2, 2], [4, 0, 2], [4, -4, 1]]);

  // Real indicator on the actual series.
  const settings = { ...movingAverageIndicatorDefinition.defaultSettings(), lines: [
    { id: "sma2", method: "sma", period: 2, timeframe: "chart", color: "#44aaff", enabled: true },
    { id: "sma3", method: "sma", period: 3, timeframe: "chart", color: "#ffaa44", enabled: true },
  ] };
  const ctx = { ctx: {}, view: {}, series, rect: { top: 0, height: 100 }, range: [0, series.length],
    instance: { id: "lod-ma", type: movingAverageIndicatorDefinition.type, title: "MA", visible: true, paneId: "p", order: 0, settings, seq: 1 },
    settings, requestRefresh() {} };
  // Hand oracle on the raw closes: SMA2 -> null, 50, 48.5; SMA3 -> null, null, 148/3.
  const maOracle = (prepared) => {
    assert.equal(prepared.status, "ok");
    // Shape pinned to the real API (prepareOverlayData/makeOverlayPoints):
    // meta.series -> PlotSeries { key: `ma-${id}`, label, chartLabel }, in line order.
    assert.equal(prepared.meta.series.length, 2);
    assert.deepEqual(prepared.meta.series.map((line) => line.key), ["ma-sma2", "ma-sma3"]);
    assert.deepEqual(prepared.meta.series.map((line) => line.label), ["SMA 2", "SMA 3"]);
    assert.deepEqual(prepared.meta.series.map((line) => line.chartLabel), ["2 MA", "3 MA"]);
    const expected = [[null, 50, 48.5], [null, null, 148 / 3]];
    prepared.meta.series.forEach((line, li) => {
      assert.equal(line.points.length, 3, `line${li} point count`);
      line.points.forEach((point, i) => {
        assert.equal(point.index, i, `line${li}[${i}] index`);
        assert.equal(point.time, T0 + i * MIN, `line${li}[${i}] time`);
        if (expected[li][i] === null) assert.equal(point.value, null, `line${li}[${i}]`);
        else assert.ok(Math.abs(point.value - expected[li][i]) < 1e-9, `line${li}[${i}]: ${point.value}`);
      });
    });
  };
  maOracle(movingAverageIndicatorDefinition.prepareData(ctx));
  // After the bars shrink visually into one bucket, the same raw values feed the MA.
  buildPixelCandleBuckets(0, series.length, (i) => series.at(i), () => 1.25);
  for (const bar of series.listReadonly()) buildPixelCellBuckets(bar.cells.values(), 1, (p) => 500 - p);
  maOracle(movingAverageIndicatorDefinition.prepareData(ctx));
  assert.deepEqual(series.listReadonly(), canonical);

  // Real replay coordinator (host shape mirrors tests/replayDeterminism.test.mjs).
  const host = {
    pipeline: { series, intervalMs: MIN, setPaused() {} },
    session: { invalidate() {} },
    timeViewport: { applyDataUpdate() {}, placeReplayPrefixEnd() {} },
    svc: { updateAnalysisFromSeries() {} },
    isDisposed: () => false,
    getMarket: () => "TEST:FIXTURE",
    autoFit() {},
    updateHook() {},
    loadHistory: async () => {},
  };
  const coordinator = new ChartReplayCoordinator(host);
  coordinator.start();
  coordinator.seek(T0 + 2 * MIN);
  // Seek leaves exactly the completed raw prefix: closes [51, 49].
  assert.deepEqual(series.listReadonly().map((bar) => [bar.startTime, bar.close]), [[T0, 51], [T0 + MIN, 49]]);
  coordinator.step();
  // Step releases the third bar: raw closes [51, 49, 48] again.
  assert.deepEqual(series.listReadonly().map((bar) => bar.startTime), [T0, T0 + MIN, T0 + 2 * MIN]);
  assert.deepEqual(series.listReadonly().map((bar) => bar.close), [51, 49, 48]);
  assert.deepEqual(series.listReadonly(), canonical, "canonical series unchanged through LOD + replay");
  assert.deepEqual(rawTotals(series.listReadonly()), [[4, 2, 2], [4, 0, 2], [4, -4, 1]]);
  for (const bar of series.listReadonly()) assert.ok(bar.cells instanceof Map && bar.cells.size === 1);
  coordinator.exit({ reloadHistory: false });
  assert.equal(coordinator.isActive(), false);
});

test("physical->CSS normalisation is explicit (dpr=2) and deterministic", () => {
  const bars = [
    { open: 1, high: 3, low: 0, close: 2 },
    { open: 2, high: 5, low: 1, close: 4 },
    { open: 4, high: 4, low: 2, close: 3 },
  ];
  const cssDirect = buildPixelCandleBuckets(0, 3, (i) => bars[i], (i) => 12.5 + i * 0.9);
  // Same geometry expressed in dpr=2 device pixels, normalised to CSS pixels.
  const fromPhysical = buildPixelCandleBuckets(0, 3, (i) => bars[i], (i) => (25 + i * 1.8) / 2);
  assert.deepEqual(fromPhysical, cssDirect);
  assert.deepEqual(cssDirect, [
    { firstIndex: 0, lastIndex: 0, x: 12, open: 1, high: 3, low: 0, close: 2 },
    { firstIndex: 1, lastIndex: 1, x: 13, open: 2, high: 5, low: 1, close: 4 },
    { firstIndex: 2, lastIndex: 2, x: 14, open: 4, high: 4, low: 2, close: 3 },
  ]);
  // Determinism: identical inputs give identical buckets.
  assert.deepEqual(buildPixelCandleBuckets(0, 3, (i) => bars[i], (i) => 12.5 + i * 0.9), cssDirect);
  // Full GPU/DPR visual rendering verification: NOT_RUN (unit scope only).
});

test("FootprintSeries raw bars stay canonical through visual aggregation", async () => {
  const { FootprintSeries } = await import("../dist/core/model/footprint.js");
  const { buildPixelCellBuckets } = await import("../dist/core/render/chartLod.js");
  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  series.loadBars([
    rawFootprintBar(1800000600000, 100, 110, 95, 105, [[100, 3, 1, 2, 1], [104, 2, 2, 2, 1]]),
    rawFootprintBar(1800000660000, 105, 108, 96, 98, [[104, 5, 0, 3, 3]]),
    rawFootprintBar(1800000720000, 98, 112, 97, 111, [[98, 0, 4, 1, 0], [108, 6, 1, 4, 3]]),
  ]);
  const snapshot = structuredClone(series.listReadonly());
  const identities = series.listReadonly().slice();
  const cellIdentities = series.listReadonly().map((bar) => bar.cells);
  const cellEntries = series.listReadonly().map((bar) => [...bar.cells.entries()]);
  const revision = series.revision;
  const structureRevision = series.structureRevision;
  buildPixelCandleBuckets(0, series.length, (i) => series.at(i), (i) => i * 0.35);
  for (const bar of series.listReadonly()) buildPixelCellBuckets(bar.cells.values(), 1, (p) => 400 - p);
  assert.deepEqual(series.listReadonly(), snapshot);
  for (let i = 0; i < identities.length; i++) {
    assert.equal(series.at(i), identities[i]);
    assert.equal(series.at(i).cells, cellIdentities[i]);
  }
  assert.deepEqual(series.listReadonly().map((bar) => [...bar.cells.keys()]), cellEntries.map((entries) => entries.map(([priceBin]) => priceBin)));
  for (let b = 0; b < cellEntries.length; b++) for (const [priceBin, cell] of cellEntries[b]) assert.equal(series.at(b).cells.get(priceBin), cell, `bar${b} cell ${priceBin}`);
  assert.equal(series.revision, revision);
  assert.equal(series.structureRevision, structureRevision);
});

test("dense bounded property suite — coverage, extrema, totals, determinism", async () => {
  const { buildPixelCellBuckets } = await import("../dist/core/render/chartLod.js");
  let seed = 0x5eed;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let sample = 0; sample < 25; sample++) {
    const n = 2 + Math.floor(rnd() * 39); // 2..40 bars
    const bars = [];
    for (let i = 0; i < n; i++) {
      const open = Math.floor(rnd() * 200) - 100; // safe integers, negatives allowed
      const close = Math.floor(rnd() * 200) - 100;
      const high = Math.max(open, close) + Math.floor(rnd() * 5);
      const low = Math.min(open, close) - Math.floor(rnd() * 5);
      bars.push({ open, high, low, close });
    }
    const spacing = [0.25, 0.5, 0.9, 1, 3.7][sample % 5];
    const x0 = Math.floor(rnd() * 100) - 50;
    const xOfIndex = (i) => x0 + i * spacing; // monotonic CSS mapping
    const present = bars.map((bar, i) => (rnd() < 0.15 && i > 0 && i < n - 1 ? undefined : bar));
    const buckets = buildPixelCandleBuckets(0, n, (i) => present[i], xOfIndex);
    // Independent spec-derived grouping (Math.floor of the CSS x), not a second
    // call into the production grouping algorithm.
    const expected = new Map();
    for (let i = 0; i < n; i++) {
      const bar = present[i];
      if (!bar) continue;
      const x = Math.floor(xOfIndex(i));
      const b = expected.get(x);
      if (!b) expected.set(x, { firstIndex: i, lastIndex: i, x, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      else {
        b.lastIndex = i;
        b.high = Math.max(b.high, bar.high);
        b.low = Math.min(b.low, bar.low);
        b.close = bar.close;
      }
    }
    assert.deepEqual(buckets, [...expected.values()]);
    // Global independent extrema over the defined range.
    const defined = present.filter(Boolean);
    assert.equal(Math.max(...buckets.map((b) => b.high)), Math.max(...defined.map((b) => b.high)));
    assert.equal(Math.min(...buckets.map((b) => b.low)), Math.min(...defined.map((b) => b.low)));
    // Every defined index is owned by exactly one bucket; buckets ordered by x.
    for (let i = 0; i < n; i++) {
      if (!present[i]) continue;
      const owners = buckets.filter((b) => b.firstIndex <= i && i <= b.lastIndex);
      assert.equal(owners.length, 1, `index ${i} owned by ${owners.length} buckets`);
    }
    for (let k = 1; k < buckets.length; k++) assert.ok(buckets[k].x > buckets[k - 1].x);
    // Determinism: a second identical run deep-equals the first.
    assert.deepEqual(buildPixelCandleBuckets(0, n, (i) => present[i], xOfIndex), buckets);
    // Cell volume conservation under a merging negative-slope CSS y mapping.
    const cells = [];
    let buyTotal = 0;
    let sellTotal = 0;
    for (let i = 0; i < 10; i++) {
      const buy = Math.floor(rnd() * 50);
      const sell = Math.floor(rnd() * 50);
      cells.push({ priceBin: 500 + i * 3, buyVol: buy, sellVol: sell });
      buyTotal += buy;
      sellTotal += sell;
    }
    const cellBuckets = buildPixelCellBuckets(cells, 3, (p) => 600 - (p - 500) * 0.2);
    assert.equal(cellBuckets.reduce((s, b) => s + b.buyVol, 0), buyTotal);
    assert.equal(cellBuckets.reduce((s, b) => s + b.sellVol, 0), sellTotal);
    for (let k = 1; k < cellBuckets.length; k++) assert.ok(cellBuckets[k].yTop > cellBuckets[k - 1].yTop);
  }
});
