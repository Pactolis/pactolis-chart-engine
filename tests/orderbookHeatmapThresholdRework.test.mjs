import test from "node:test";
import assert from "node:assert/strict";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { configureOrderbookHeatmapSettingsSource } from "../dist/features/orderbook/heatmapSettingsSource.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";

const MINUTE = 60_000;

function setupSeries(length = 1) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(Array.from({ length }, (_, i) => ({
    startTime: i * MINUTE, open: 100, high: 105, low: 95, close: 102,
    volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 10;
  view.priceTop = 200;
  return { series, view };
}

function context() {
  const fills = [];
  return { fills, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillRect(...args) { fills.push(args); }, set fillStyle(_value) {} };
}

function response(req, bars) {
  return { schemaVersion: 1, generatedAt: 60 * MINUTE, base: "BTC", source: req.source,
    resolution: req.resolution, bucketStep: req.bucketStep, from: req.from, to: req.to, bars };
}

test("unit change keeps compatible USD-notional cells visible until replacement data arrives", async () => {
  let unit = "usd";
  let threshold = 10_000_000;
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({ mode: "single", unit, bucketStep: 50,
      single: { usd: threshold, btc: 100 }, aggregated: { usd: threshold, btc: 100 } }),
    onChange: () => () => {},
  });
  const { series, view } = setupSeries();
  let finishBtcRefresh;
  const requests = [];
  const overlay = new OrderbookHeatmapOverlay({
    fetch: (req) => {
      requests.push(req);
      if (requests.length === 1) {
        return Promise.resolve(response(req, [{ t: 0, cells: [[100, 15_000_000, 0]] }]));
      }
      return new Promise((resolve) => {
        finishBtcRefresh = () => resolve(response(req, [{ t: 0, cells: [[100, 20_000_000, 0]] }]));
      });
    }, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => 60 * MINUTE,
  });
  const ctx = context();
  overlay.draw(ctx, view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].minUsd, 10_000_000);
  ctx.fills.length = 0;

  unit = "btc";
  overlay.draw(ctx, view, series, [0, 0]);
  assert.equal(requests.length, 2, "unit change triggers replacement fetch with new unit");
  assert.equal(requests[1].minBtc, 100, "replacement fetch requests minBtc threshold");
  assert.equal(requests[1].from, 0, "replacement fetch re-fetches full chunk");
  assert.ok(ctx.fills.length > 0, "compatible USD-notional cache remains visible while replacement fetch is pending");
  assert.equal(overlay.chunkStatus(0), "loading");

  finishBtcRefresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(overlay.chunkStatus(0), "ready");

  ctx.fills.length = 0;
  overlay.draw(ctx, view, series, [0, 0]);
  assert.ok(ctx.fills.length > 0, "new replacement data is drawn");
  assert.equal(requests.length, 2, "no additional fetch on subsequent frames in same unit");

  overlay.dispose();
});

test("raising then lowering threshold uses full-chunk coverage after a live-tail partial refresh", async () => {
  let threshold = 20;
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({ mode: "single", unit: "usd", bucketStep: 50,
      single: { usd: threshold, btc: 1 }, aggregated: { usd: threshold, btc: 1 } }),
    onChange: () => () => {},
  });
  const { series, view } = setupSeries();
  let now = 60 * MINUTE;
  const requests = [];
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => {
      requests.push(req);
      return response(req, [{ t: req.from, cells: [[100, 30, 0]] }]);
    }, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => now,
  });
  overlay.draw(context(), view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  threshold = 30;
  now += 21_000;
  overlay.draw(context(), view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(requests.length >= 2);
  assert.ok(requests.at(-1).from > 0, "live refresh should only cover the tail");
  threshold = 25;
  overlay.draw(context(), view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.filter((req) => req.from === 0).length, 1,
    "lowering to a threshold still covered by the full fetch must not refetch the whole chunk");
  overlay.dispose();
});

test("#262 raising threshold filters cached below-threshold cells on draw, live extension, and reserved GPU prepare (including Auto P96) without refetching", async () => {
  let threshold = 10;
  let unit = "btc";
  let scaleMode = "auto";
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit,
      bucketStep: 50,
      scaleMode,
      contrast: "medium",
      fixedCeiling: { usd: 50_000_000, btc: 500 },
      single: { usd: threshold, btc: threshold },
      aggregated: { usd: threshold, btc: threshold },
    }),
    onChange: () => () => {},
  });

  const { series, view } = setupSeries(3);
  view.priceTop = 300;
  view.pricePerPx = 1;
  const requests = [];
  // Middle prices: 100->125, 150->175, 200->225.
  // Cell 100: 10 BTC (1250 USD) - exact threshold 10
  // Cell 150: 50 BTC (8750 USD)
  // Cell 200: 100_000 BTC (22_500_000 USD)
  const cells = [
    [100, 625, 625],
    [150, 4375, 4375],
    [200, 11_250_000, 11_250_000],
  ];
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => {
      requests.push(req);
      return response(req, [
        { t: 0, cells },
        { t: MINUTE, cells },
        { t: 2 * MINUTE, cells },
      ]);
    },
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => 2 * MINUTE + 500,
  });

  try {
    const ctx = context();
    overlay.draw(ctx, view, series, [0, 2]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.length, 1);

    // Threshold = 10 BTC: all 3 levels (including exact value === 10) render (3 bars * 3 = 9 rects, no extension)
    ctx.fills.length = 0;
    overlay.draw(ctx, view, series, [0, 2]);
    assert.equal(ctx.fills.length, 9, "exact threshold cell (10 BTC) is included");

    const gpuAt10 = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
    assert.ok(gpuAt10);
    assert.equal(gpuAt10.main.length, 9);
    assert.equal(gpuAt10.extension.length, 0);
    assert.equal(gpuAt10.floor, 10);

    // Raise threshold to 99_999 BTC without refetching: 10 BTC & 50 BTC disappear in the same frame!
    threshold = 99_999;
    ctx.fills.length = 0;
    overlay.draw(ctx, view, series, [0, 2]);
    assert.equal(requests.length, 1, "raising threshold must not trigger any refetch");
    assert.equal(ctx.fills.length, 3, "only the 100_000 BTC cell (3 bars, no extension) remains");

    // Reserved GPU path (both auto and fixed scaleMode) also excludes below-threshold cells
    const gpuAt99999Auto = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
    assert.ok(gpuAt99999Auto);
    assert.equal(gpuAt99999Auto.main.length, 3);
    assert.equal(gpuAt99999Auto.extension.length, 0);
    assert.ok(gpuAt99999Auto.main.every((c) => c.value >= 99_999));

    scaleMode = "fixed";
    const gpuAt99999Fixed = overlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
    assert.ok(gpuAt99999Fixed);
    assert.equal(gpuAt99999Fixed.main.length, 3);
    assert.equal(gpuAt99999Fixed.extension.length, 0);

    // Fresh overlay loaded directly at 99_999 BTC produces identical GPU frame geometry/ceiling as hot cache
    const freshOverlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => response(req, [
        { t: 0, cells: [[200, 11_250_000, 11_250_000]] },
        { t: MINUTE, cells: [[200, 11_250_000, 11_250_000]] },
        { t: 2 * MINUTE, cells: [[200, 11_250_000, 11_250_000]] },
      ]),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => 2 * MINUTE + 500,
    });
    freshOverlay.draw(context(), view, series, [0, 2]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const freshGpu = freshOverlay.prepareGpuCells(view, series, [0, 2], () => ({ release() {} }));
    assert.deepEqual(
      { main: gpuAt99999Fixed.main, extension: gpuAt99999Fixed.extension, floor: gpuAt99999Fixed.floor, ceiling: gpuAt99999Fixed.ceiling },
      { main: freshGpu.main, extension: freshGpu.extension, floor: freshGpu.floor, ceiling: freshGpu.ceiling },
    );
    freshOverlay.dispose();

    // Lowering threshold back to 10 BTC (still covered by fullThreshold=10) restores cached cells immediately with 0 refetch
    scaleMode = "auto";
    threshold = 10;
    ctx.fills.length = 0;
    overlay.draw(ctx, view, series, [0, 2]);
    assert.equal(requests.length, 1, "lowering back to fullThreshold=10 must not refetch");
    assert.equal(ctx.fills.length, 9, "cached 10 BTC and 50 BTC cells return immediately");
  } finally {
    overlay.dispose();
  }
});

test("#262 threshold=0 preserves zero-intensity cells and hover shows raw below-threshold amounts without coloring them", async () => {
  let threshold = 0;
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: threshold, btc: threshold },
      aggregated: { usd: threshold, btc: threshold },
    }),
    onChange: () => () => {},
  });

  const { series, view } = setupSeries(1);
  view.priceTop = 300;
  view.pricePerPx = 1;
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => response(req, [{
      t: 0,
      cells: [[100, 0, 0], [150, 500, 500], [200, 5_000, 5_000]],
    }]),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => 500,
  });

  try {
    const ctx = context();
    overlay.draw(ctx, view, series, [0, 0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.fills.length = 0;
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(ctx.fills.length, 3, "threshold=0 keeps 0-intensity cell (3 cells, no extension)");

    threshold = 5_000;
    const texts = [];
    const hoverColoredRects = [];
    const hoverCtx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "",
      textBaseline: "",
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      strokeRect() {},
      fillRect(x, y, w, h) {
        if (this.fillStyle.startsWith("rgba(") && this.fillStyle !== "rgba(11, 16, 24, 0.95)") {
          hoverColoredRects.push({ x, y, w, h, fillStyle: this.fillStyle });
        }
      },
      fillText(text) { texts.push(text); },
    };
    overlay.drawHover(hoverCtx, view, series, { x: 5, y: 150, visible: true });
    await new Promise((resolve) => setTimeout(resolve, 160));
    texts.length = 0;
    hoverColoredRects.length = 0;
    overlay.drawHover(hoverCtx, view, series, { x: 5, y: 150, visible: true });
    assert.ok(texts.includes("1.00K") || texts.includes("1K"), "below-threshold raw amount is shown in hover text");
    assert.ok(texts.includes("10K"), "above-threshold raw amount is shown in hover text");
    assert.equal(hoverColoredRects.length, 1, "hover only colors cells >= threshold (5_000)");
  } finally {
    overlay.dispose();
  }
});
