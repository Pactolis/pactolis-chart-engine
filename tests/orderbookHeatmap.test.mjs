import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
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
  assert.equal(heatmapCellColor(0), "rgba(18, 38, 84, 0.220)");
  assert.equal(heatmapCellColor(1), "rgba(254, 240, 178, 0.680)");
  assert.equal(heatmapCellColor(1, 0.5), "rgba(254, 240, 178, 0.340)");
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

async function withHeatmapSettingsSource(settingsFor, work) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor,
    onChange: () => () => {},
  });
  try {
    return await work();
  } finally {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
}

test("preserves historical chunks while live-tail invalidation updates only the live tail", async () => {
  await withHeatmapSettingsSource(() => ({
    mode: "single", unit: "usd", bucketStep: 50,
    single: { usd: 1, btc: 1 }, aggregated: { usd: 1, btc: 1 },
  }), async () => {
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

    try {
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
    } finally {
      overlay.dispose();
    }
  });
});

test("raising the threshold reuses cached data without a blank frame or refetch", async () => {
  let threshold = 20_000_000;
  await withHeatmapSettingsSource(() => ({
    mode: "single", unit: "usd", bucketStep: 50,
    single: { usd: threshold, btc: 1 }, aggregated: { usd: threshold, btc: 1 },
  }), async () => {
    const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
    series.loadBars([{ startTime: 0, open: 100, high: 105, low: 95, close: 102, volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true }]);
    const requests = [];
    const now = 60_000;
    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => {
        requests.push(req);
        return { schemaVersion: 1, generatedAt: now, base: "BTC", source: req.source,
          resolution: req.resolution, bucketStep: req.bucketStep, from: req.from, to: req.to,
          bars: [{ t: 0, cells: [[100, 30_000_000, 30_000_000]] }] };
      }, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => now,
    });
    try {
      const view = makeTestView();
      overlay.draw(mockCtx, view, series, [0, 0]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const initialRequests = requests.length;
      assert.ok(initialRequests > 0);
      assert.ok(overlay.cachedBarsCount() > 0);

      for (threshold = 21_000_000; threshold <= 50_000_000; threshold += 1_000_000) {
        overlay.draw(mockCtx, view, series, [0, 0]);
        assert.ok(overlay.cachedBarsCount() > 0, `cache remains populated at ${threshold}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(requests.length, initialRequests, `no request at ${threshold}`);
      }
    } finally {
      overlay.dispose();
    }
  });
});

test("lowering the threshold keeps compatible cached bars visible during revalidation", async () => {
  let threshold = 20_000_000;
  await withHeatmapSettingsSource(() => ({
    mode: "single", unit: "usd", bucketStep: 50,
    single: { usd: threshold, btc: 1 }, aggregated: { usd: threshold, btc: 1 },
  }), async () => {
    const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
    series.loadBars([{ startTime: 0, open: 100, high: 105, low: 95, close: 102, volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true }]);
    let finishRefresh;
    const requests = [];
    const now = 60_000;
    const overlay = new OrderbookHeatmapOverlay({
      fetch: (req) => {
        requests.push(req);
        if (requests.length === 1) return Promise.resolve({ schemaVersion: 1, generatedAt: now, base: "BTC", source: req.source,
          resolution: req.resolution, bucketStep: req.bucketStep, from: req.from, to: req.to,
          bars: [{ t: 0, cells: [[100, 25_000_000, 25_000_000]] }] });
        return new Promise((resolve) => { finishRefresh = () => resolve({ schemaVersion: 1, generatedAt: now, base: "BTC", source: req.source,
          resolution: req.resolution, bucketStep: req.bucketStep, from: req.from, to: req.to,
          bars: [{ t: 0, cells: [[100, 15_000_000, 15_000_000]] }] }); });
      }, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => now,
    });
    try {
      const view = makeTestView();
      overlay.draw(mockCtx, view, series, [0, 0]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(overlay.cachedBarsCount(), 1);
      threshold = 10_000_000;
      overlay.draw(mockCtx, view, series, [0, 0]);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].minUsd, threshold);
      assert.equal(overlay.cachedBarsCount(), 1, "old compatible data remains while refresh is pending");
      assert.equal(overlay.chunkStatus(0), "loading");
      finishRefresh();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(overlay.cachedBarsCount(), 1);
    } finally {
      overlay.dispose();
    }
  });
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

test("live-tail stays healthy between 60s samples and falls back after 90s idle", () => {
  let currentTime = 1_000_000;
  let eventListener = null;
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async () => ({
      schemaVersion: 1, generatedAt: currentTime, base: "BTC", source: "single", resolution: "1m",
      bucketStep: 50, from: 0, to: 0, bars: [],
    }),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => currentTime,
    subscribeLiveTail: (listener) => { eventListener = listener; return () => {}; },
  });

  eventListener();
  currentTime += 60_000;
  assert.equal(overlay.isLiveTailHealthyForTest(), true, "60s sampler interval must not trigger REST fallback");
  eventListener();
  currentTime += 89_999;
  assert.equal(overlay.isLiveTailHealthyForTest(), true, "tail remains healthy before the idle threshold");
  currentTime += 1;
  assert.equal(overlay.isLiveTailHealthyForTest(), false, "fallback activates at 90s idle");
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

test("CPU raster cache skips cell fillRect loop when data and viewport stay unchanged and refreshes on change", async () => {
  await withHeatmapSettingsSource(() => ({
    mode: "single", unit: "usd", bucketStep: 50,
    single: { usd: 1, btc: 1 }, aggregated: { usd: 1, btc: 1 },
  }), async () => {

  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([
    { startTime: 0, open: 100, high: 150, low: 50, close: 120, volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true },
  ]);

  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => ({
      schemaVersion: 1, generatedAt: 60_000, base: "BTC", source: req.source,
      resolution: req.resolution, bucketStep: req.bucketStep, from: req.from, to: req.to,
      bars: [{ t: 0, cells: [[100, 1000, 1000], [150, 2000, 2000]] }],
    }),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => 60_000,
  });

  const view = makeTestView();
  view.priceTop = 250;
  view.pricePerPx = 1;
  view.pixelRatio = 2;

  let createCanvasCalls = 0;
  let offFillRectCalls = 0;
  let offClearRectCalls = 0;
  const offSetTransforms = [];
  const offCtx = {
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform(...args) { offSetTransforms.push(args); },
    clearRect() { offClearRectCalls++; },
    fillRect() { offFillRectCalls++; },
  };
  const offscreenCanvas = {
    width: 0,
    height: 0,
    getContext(kind) { return kind === "2d" ? offCtx : null; },
  };

  let mainFillRectCalls = 0;
  const mainSetTransforms = [];
  const drawImageCalls = [];
  const ctx = {
    canvas: {
      width: 1600,
      height: 800,
      ownerDocument: {
        createElement(tag) {
          assert.equal(tag, "canvas");
          createCanvasCalls++;
          return offscreenCanvas;
        },
      },
    },
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    getTransform() { return { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }; },
    setTransform(...args) { mainSetTransforms.push(args); },
    drawImage(img, x, y) { drawImageCalls.push({ img, x, y }); },
    fillRect() { mainFillRectCalls++; },
  };

  try {
    // Warm chunk fetch
    overlay.draw(ctx, view, series, [0, 0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(offFillRectCalls, 0);

    // 1. First draw with ready data: cache MISS -> rasterizes cells into offscreen canvas and blits
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(createCanvasCalls, 1);
    assert.equal(offscreenCanvas.width, 1600);
    assert.equal(offscreenCanvas.height, 800);
    assert.equal(offClearRectCalls, 1);
    assert.equal(offFillRectCalls, 2, "two cells in live bar (no right extension)");
    assert.equal(mainFillRectCalls, 0, "main ctx uses blitted raster cache");
    assert.equal(drawImageCalls.length, 1);
    assert.equal(drawImageCalls[0].img, offscreenCanvas);
    assert.deepEqual(offSetTransforms.at(-1), [2, 0, 0, 2, 0, 0]);
    assert.deepEqual(mainSetTransforms.at(-1), [1, 0, 0, 1, 0, 0]);

    // 2. Second draw with identical data & viewport: cache HIT -> skips fillRect loop
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(createCanvasCalls, 1);
    assert.equal(offClearRectCalls, 1);
    assert.equal(offFillRectCalls, 2, "fillRect loop is skipped on raster cache hit");
    assert.equal(drawImageCalls.length, 2);

    // 3. barsRevision bump via live-tail push invalidates raster cache
    overlay.applyLiveTailBars([{ t: 0, cells: [[100, 1500, 1500], [150, 2500, 2500]] }]);
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(offClearRectCalls, 2);
    assert.equal(offFillRectCalls, 4, "barsRevision change refreshes raster cache");
    assert.equal(drawImageCalls.length, 3);

    // 4. Viewport change invalidates raster cache
    view.offsetX += 16;
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(offClearRectCalls, 2, "moving viewport paints directly");
    assert.equal(mainFillRectCalls, 2);
    overlay.now = () => 60_150;
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(offClearRectCalls, 3);
    assert.equal(offFillRectCalls, 6, "viewport change refreshes raster cache");
    assert.equal(drawImageCalls.length, 4);

    // 5. Canvas dimension change invalidates raster cache
    ctx.canvas.width = 1200;
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(offscreenCanvas.width, 1200);
    assert.equal(offClearRectCalls, 4);
    assert.equal(offFillRectCalls, 8);
    assert.equal(drawImageCalls.length, 5);
    } finally {
      overlay.dispose();
      assert.equal(overlay.rasterCacheCanvas, null);
      assert.equal(overlay.lastRasterKey, "");
    }
  });
});
