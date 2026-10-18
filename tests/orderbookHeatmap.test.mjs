// Orderbook heatmap model: tiers, chunking, sub-bar selection, units and colors.
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatHeatmapValue,
  heatmapCellColor,
  heatmapChunkEnd,
  heatmapChunkStart,
  heatmapChunksFor,
  heatmapIntensity,
  heatmapTierFor,
  heatmapValueInUnit,
  lastHeatmapSubBar,
  liveHeatmapSubBar,
} from "../dist/features/orderbook/heatmapModel.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("chart intervals read the coarsest tier that nests in one bar", () => {
  const cases = [
    [MINUTE, "1m"], [3 * MINUTE, "1m"], [5 * MINUTE, "5m"], [15 * MINUTE, "15m"], [30 * MINUTE, "30m"],
    [HOUR, "1h"], [2 * HOUR, "2h"], [4 * HOUR, "4h"], [6 * HOUR, "2h"], [8 * HOUR, "4h"], [12 * HOUR, "4h"],
    [DAY, "1d"], [3 * DAY, "1d"], [7 * DAY, "1d"], [30 * DAY, "1d"],
  ];
  for (const [interval, name] of cases) assert.equal(heatmapTierFor(interval).name, name, String(interval));
});

test("chunks are aligned to 1000 tier bars", () => {
  const tier = heatmapTierFor(MINUTE);
  const start = heatmapChunkStart(1_704_153_645_000, tier);
  assert.equal(start % (1000 * MINUTE), 0);
  assert.equal(heatmapChunkEnd(start, tier), start + 999 * MINUTE);
  assert.deepEqual(heatmapChunksFor(start + 10, start + 1000 * MINUTE + 5, tier), [start, start + 1000 * MINUTE]);
});

test("a chart bar shows its newest sub-bar", () => {
  const tier = heatmapTierFor(MINUTE);
  const bars = new Map([
    [0, { t: 0, cells: [[100, 1, 0]] }],
    [MINUTE, { t: MINUTE, cells: [[100, 2, 0]] }],
    [3 * MINUTE, { t: 3 * MINUTE, cells: [[100, 3, 0]] }],
  ]);
  assert.equal(lastHeatmapSubBar(bars, 0, 3 * MINUTE, tier)?.t, MINUTE);
  assert.equal(lastHeatmapSubBar(bars, 3 * MINUTE, 6 * MINUTE, tier)?.t, 3 * MINUTE);
  assert.equal(lastHeatmapSubBar(bars, 6 * MINUTE, 9 * MINUTE, tier), undefined);
});

test("the candle in progress falls back to the previous close until its own data arrives", () => {
  const tier = heatmapTierFor(MINUTE);
  const bars = new Map([[2 * MINUTE, { t: 2 * MINUTE, cells: [[100, 2, 0]] }]]);
  assert.equal(liveHeatmapSubBar(bars, 3 * MINUTE, 6 * MINUTE, tier)?.t, 2 * MINUTE);
  bars.set(4 * MINUTE, { t: 4 * MINUTE, cells: [[100, 4, 0]] });
  assert.equal(liveHeatmapSubBar(bars, 3 * MINUTE, 6 * MINUTE, tier)?.t, 4 * MINUTE);
  assert.equal(liveHeatmapSubBar(new Map(), 3 * MINUTE, 6 * MINUTE, tier), undefined);
});

test("values convert to BTC at the bucket middle and format compactly", () => {
  assert.equal(heatmapValueInUnit(1_000_000, 99_975, 50, "usd"), 1_000_000);
  assert.equal(heatmapValueInUnit(1_000_000, 99_975, 50, "btc"), 10);
  assert.equal(formatHeatmapValue(1740, "btc"), "1.74K");
  assert.equal(formatHeatmapValue(102.934, "btc"), "102.93");
  assert.equal(formatHeatmapValue(20_500_000, "usd"), "20.50M");
  assert.equal(formatHeatmapValue(850_000, "usd"), "850K");
  assert.equal(heatmapIntensity(20, 20), 0);
  assert.equal(heatmapIntensity(200, 20), 1);
});

test("cells deepen with size relative to the largest visible wall", () => {
  // Ceiling = largest visible value: it gets the deepest color, the threshold the lightest.
  assert.equal(heatmapIntensity(80, 20, 80), 1);
  assert.equal(heatmapIntensity(40, 20, 80), 0.5);
  assert.ok(heatmapIntensity(30, 20, 80) < heatmapIntensity(60, 20, 80));
  // A screen of near-threshold walls stays light instead of all turning deep.
  assert.equal(heatmapIntensity(22, 20, 22), Math.log10(1.1) / Math.log10(2));
  assert.equal(heatmapCellColor(0), "rgba(125, 211, 252, 0.280)");
  assert.equal(heatmapCellColor(1), "rgba(29, 78, 216, 0.950)");
  assert.equal(heatmapCellColor(1, 0.5), "rgba(29, 78, 216, 0.475)");
});
