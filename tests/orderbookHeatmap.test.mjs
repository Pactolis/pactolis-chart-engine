import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { configureOrderbookHeatmapSettingsSource } from "../dist/features/orderbook/heatmapSettingsSource.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
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

function makeTestView(width = 800) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height: 400 };
  view.colWidth = 10;
  return view;
}

const mockCtx = {
  save() {},
  restore() {},
  beginPath() {},
  rect() {},
  clip() {},
  fillRect() {},
  strokeRect() {},
  fillText() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  fill() {},
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  font: "",
  textAlign: "",
  textBaseline: "",
};

test("preserves historical chunks while live-tail invalidation updates only the live tail", async () => {
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single", unit: "usd", bucketStep: 50,
      single: { usd: 1, btc: 1 }, aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(Array.from({ length: 1050 }, (_, i) => ({
    startTime: i * 60_000,
    open: 100, high: 105, low: 95, close: 102, volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true,
  })));

  const fetchedRequests = [];
  let currentTime = 1050 * 60_000;

  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => {
      fetchedRequests.push(req);
      return {
        schemaVersion: 1,
        generatedAt: currentTime,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: [{ t: req.from, cells: [[50000, 1000, 1000]] }],
      };
    },
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => currentTime,
    liveDebounceMs: 10,
  });

  const view = makeTestView();
  overlay.draw(mockCtx, view, series, [0, 1049]);

  // Wait for initial REST chunks
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetchedRequests.length, 2);
  assert.equal(fetchedRequests[0].from, 0); // historical chunk
  assert.equal(fetchedRequests[1].from, 1000 * 60_000); // live chunk
  assert.equal(overlay.chunkStatus(0), "ready");
  assert.equal(overlay.chunkStatus(1000 * 60_000), "ready");

  // Clear request log to track live-tail invalidation
  fetchedRequests.length = 0;

  // Trigger live tail invalidation signal
  overlay.invalidateLiveTail();

  // Wait for bounded debounce
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Historical chunk (from: 0) is NEVER requested again!
  assert.ok(fetchedRequests.every((req) => req.from >= 1000 * 60_000), "historical chunks are never re-fetched");
  assert.equal(overlay.chunkStatus(0), "ready", "historical chunk remains ready");

  // Direct live-tail push merges bars without REST fetch
  const beforePushCount = fetchedRequests.length;
  overlay.applyLiveTailBars([{ t: 1050 * 60_000, cells: [[50050, 5000, 5000]] }]);
  assert.equal(fetchedRequests.length, beforePushCount, "direct push does not issue REST requests");

  overlay.dispose();
});

test("falls back to timer refresh when no live-tail source is provided or when idle", () => {
  let currentTime = 1_000_000;
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async () => ({
      schemaVersion: 1, generatedAt: currentTime, base: "BTC", source: "single", resolution: "1m",
      bucketStep: 50, from: 0, to: 0, bars: [],
    }),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => currentTime,
  });

  // Without subscribeLiveTail, isLiveTailHealthy is false (timer fallback active)
  assert.equal(overlay.isLiveTailHealthyForTest(), false);

  overlay.dispose();
});

test("subscribes to live-tail and performs proper cleanup on dispose", () => {
  let unsubscribed = false;
  let eventListener = null;

  const overlay = new OrderbookHeatmapOverlay({
    fetch: async () => ({
      schemaVersion: 1, generatedAt: 0, base: "BTC", source: "single", resolution: "1m",
      bucketStep: 50, from: 0, to: 0, bars: [],
    }),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    subscribeLiveTail: (listener) => {
      eventListener = listener;
      return () => { unsubscribed = true; };
    },
  });

  assert.equal(typeof eventListener, "function");
  assert.equal(unsubscribed, false);

  overlay.dispose();
  assert.equal(unsubscribed, true, "unsubscribe was called on dispose");
});
