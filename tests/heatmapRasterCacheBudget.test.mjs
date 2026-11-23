import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import {
  HEATMAP_CPU_RASTER_QUIET_MS,
  HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES,
  HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES,
  OrderbookHeatmapOverlay,
  getHeatmapCpuRasterModuleReservedBytes,
  heatmapRasterByteSize,
} from "../dist/features/orderbook/heatmapOverlay.js";

function withSettingsSource(settingsFor, work) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  configureOrderbookHeatmapSettingsSource({
    settingsFor,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return Promise.resolve(work(notify)).finally(() => {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  });
}

function makeTestSeries() {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([
    { startTime: 0, open: 100, high: 150, low: 50, close: 120, volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true },
  ]);
  return series;
}

function makeTestView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 250;
  view.pricePerPx = 1;
  view.pixelRatio = 2;
  return view;
}

function makeCanvasHarness(initialWidth, initialHeight, { contextAvailable = true } = {}) {
  let canvasWidth = initialWidth;
  let canvasHeight = initialHeight;
  let createCanvasCalls = 0;
  let offFillRectCalls = 0;
  let mainFillRectCalls = 0;
  const drawImageCalls = [];
  const offscreenCanvases = [];

  const offCtx = {
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform() {},
    clearRect() {},
    fillRect() { offFillRectCalls++; },
  };

  const ctx = {
    canvas: {
      get width() { return canvasWidth; },
      get height() { return canvasHeight; },
      ownerDocument: {
        createElement(tag) {
          assert.equal(tag, "canvas");
          createCanvasCalls++;
          const offscreen = {
            width: 0,
            height: 0,
            getContext(kind) {
              return kind === "2d" && contextAvailable ? offCtx : null;
            },
          };
          offscreenCanvases.push(offscreen);
          return offscreen;
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
    setTransform() {},
    drawImage(img, x, y) { drawImageCalls.push({ img, x, y }); },
    fillRect() { mainFillRectCalls++; },
  };

  return {
    ctx,
    resize(nextWidth, nextHeight) {
      canvasWidth = nextWidth;
      canvasHeight = nextHeight;
    },
    stats() {
      return {
        createCanvasCalls,
        offFillRectCalls,
        mainFillRectCalls,
        drawImageCount: drawImageCalls.length,
        offscreenCanvases,
      };
    },
    resetPaintCounters() {
      offFillRectCalls = 0;
      mainFillRectCalls = 0;
      drawImageCalls.length = 0;
    },
  };
}

async function createWarmOverlay(overlays, { cells = [[100, 1000, 1000], [150, 2000, 2000]], market = "BINANCE_FUTURES:btcusdt" } = {}) {
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => ({
      schemaVersion: 1,
      generatedAt: 60_000,
      base: "BTC",
      source: req.source,
      resolution: req.resolution,
      bucketStep: req.bucketStep,
      from: req.from,
      to: req.to,
      bars: [{ t: 0, cells }],
    }),
    invalidate: () => {},
    getMarket: () => market,
    now: () => 60_000,
  });
  overlays.push(overlay);
  return overlay;
}

async function warmChunk(overlay, ctx, view, series) {
  overlay.draw(ctx, view, series, [0, 0]);
  for (let i = 0; i < 40 && overlay.chunkStatus(0) !== "ready"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(overlay.chunkStatus(0), "ready");
}

test("heatmapRasterByteSize computes exact RGBA bytes and rejects invalid dimensions", () => {
  assert.equal(HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES, 32 * 1024 * 1024);
  assert.equal(HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES, 128 * 1024 * 1024);
  assert.equal(heatmapRasterByteSize(1800, 1000), 7_200_000);
  assert.equal(heatmapRasterByteSize(3600, 2000), 28_800_000);
  assert.equal(heatmapRasterByteSize(0, 1000), null);
  assert.equal(heatmapRasterByteSize(1000, 0), null);
  assert.equal(heatmapRasterByteSize(-10, 100), null);
  assert.equal(heatmapRasterByteSize(100.5, 100), null);
  assert.equal(heatmapRasterByteSize(Number.NaN, 100), null);
  assert.equal(heatmapRasterByteSize(Number.POSITIVE_INFINITY, 100), null);
  assert.equal(heatmapRasterByteSize(Number.MAX_SAFE_INTEGER, 2), null);
});

test("per-chart budget fallback paints directly without caching and releases prior over-budget resize", async () => {
  const overlays = [];
  const wasTelemetryEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });

  try {
    await withSettingsSource(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }), async () => {
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
      const series = makeTestSeries();
      const view = makeTestView();
      const overlay = await createWarmOverlay(overlays);
      // 2900 * 2900 * 4 = 33,640,000 B (> 32 MiB = 33,554,432 B)
      const harness = makeCanvasHarness(2900, 2900);
      await warmChunk(overlay, harness.ctx, view, series);

      harness.resetPaintCounters();
      const beforeCounters = snapshotPerformanceTelemetry().counters;
      overlay.draw(harness.ctx, view, series, [0, 0]);
      const afterCounters = snapshotPerformanceTelemetry().counters;

      const s1 = harness.stats();
      assert.equal(s1.createCanvasCalls, 0, "over-chart-budget frame must not create offscreen canvas");
      assert.equal(s1.drawImageCount, 0);
      assert.equal(s1.offFillRectCalls, 0);
      assert.equal(s1.mainFillRectCalls, 2, "over-budget fallback still draws all cells directly (no right extension)");
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
      assert.equal(
        (afterCounters["chart.cpu.heatmap.raster.budgetFallback"] ?? 0) -
        (beforeCounters["chart.cpu.heatmap.raster.budgetFallback"] ?? 0),
        1,
      );
      assert.equal(
        (afterCounters["chart.cpu.heatmap.raster.direct"] ?? 0) -
        (beforeCounters["chart.cpu.heatmap.raster.direct"] ?? 0),
        1,
      );

      // Resize into budget -> caches cleanly; resize back above per-chart budget -> detaches & zeroes prior canvas.
      harness.resize(1600, 800);
      harness.resetPaintCounters();
      overlay.draw(harness.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), 1600 * 800 * 4);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 1600 * 800 * 4);
      assert.equal(harness.stats().drawImageCount, 1);
      assert.equal(harness.stats().mainFillRectCalls, 0);
      const createdCanvas = harness.stats().offscreenCanvases[0];
      assert.equal(createdCanvas.width, 1600);
      assert.equal(createdCanvas.height, 800);

      harness.resize(2900, 2900);
      harness.resetPaintCounters();
      overlay.draw(harness.ctx, view, series, [0, 0]);
      assert.equal(createdCanvas.width, 0, "over-budget transition zeroes previous canvas width");
      assert.equal(createdCanvas.height, 0, "over-budget transition zeroes previous canvas height");
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
      assert.equal(harness.stats().mainFillRectCalls, 2);
    });
  } finally {
    for (const overlay of overlays) overlay.dispose();
    configurePerformanceTelemetry({ enabled: wasTelemetryEnabled });
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  }
});

test("module budget caps N concurrent charts (8+ realms) and frees slots on hide/dispose", async () => {
  const overlays = [];
  let mode = "single";

  try {
    await withSettingsSource(() => ({
      mode,
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }), async (notifySettingsChange) => {
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
      const series = makeTestSeries();
      const view = makeTestView();

      // Part A: 8 split-screen tiles @ 1600x1000 = 6.4 MB each -> 51.2 MB total (< 128 MiB). All 8 cache simultaneously.
      const splitOverlays = [];
      const splitHarnesses = [];
      for (let i = 0; i < 8; i++) {
        const overlay = await createWarmOverlay(overlays);
        const h = makeCanvasHarness(1600, 1000);
        await warmChunk(overlay, h.ctx, view, series);
        h.resetPaintCounters();
        overlay.draw(h.ctx, view, series, [0, 0]);
        assert.equal(overlay.reservedRasterBytes(), 6_400_000);
        assert.equal(h.stats().drawImageCount, 1);
        splitOverlays.push(overlay);
        splitHarnesses.push(h);
      }
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 8 * 6_400_000);
      assert.ok(getHeatmapCpuRasterModuleReservedBytes() <= HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES);
      for (const overlay of splitOverlays) overlay.dispose();
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);

      // Part B: Exhaust 128 MiB module ceiling (4 charts x 28,672,000 B = 114,688,000 B; 5th..9th exceed 134,217,728 B).
      const chartWidth = 2560;
      const chartHeight = 2800;
      const chartBytes = chartWidth * chartHeight * 4;
      assert.equal(chartBytes, 28_672_000);
      assert.ok(chartBytes <= HEATMAP_CPU_RASTER_CHART_BUDGET_BYTES);
      assert.ok(4 * chartBytes <= HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES);
      assert.ok(5 * chartBytes > HEATMAP_CPU_RASTER_MODULE_BUDGET_BYTES);

      const heavyOverlays = [];
      const heavyHarnesses = [];
      for (let i = 0; i < 9; i++) {
        const overlay = await createWarmOverlay(overlays);
        const h = makeCanvasHarness(chartWidth, chartHeight);
        await warmChunk(overlay, h.ctx, view, series);
        h.resetPaintCounters();
        overlay.draw(h.ctx, view, series, [0, 0]);
        heavyOverlays.push(overlay);
        heavyHarnesses.push(h);
      }

      for (let i = 0; i < 4; i++) {
        assert.equal(heavyOverlays[i].reservedRasterBytes(), chartBytes, `chart ${i} within module cap caches`);
        assert.equal(heavyHarnesses[i].stats().drawImageCount, 1);
        assert.equal(heavyHarnesses[i].stats().mainFillRectCalls, 0);
      }
      for (let i = 4; i < 9; i++) {
        assert.equal(heavyOverlays[i].reservedRasterBytes(), 0, `chart ${i} falls back cleanly past 128 MiB`);
        assert.equal(heavyHarnesses[i].stats().createCanvasCalls, 0);
        assert.equal(heavyHarnesses[i].stats().drawImageCount, 0);
        assert.equal(heavyHarnesses[i].stats().mainFillRectCalls, 2);
      }
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 4 * chartBytes);

      // Disposing chart 0 frees 1 slot -> chart 4 promotes into offscreen cache on next draw!
      heavyOverlays[0].dispose();
      assert.equal(heavyHarnesses[0].stats().offscreenCanvases[0].width, 0);
      assert.equal(heavyHarnesses[0].stats().offscreenCanvases[0].height, 0);
      assert.equal(heavyOverlays[0].reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 3 * chartBytes);

      heavyHarnesses[4].resetPaintCounters();
      heavyOverlays[4].draw(heavyHarnesses[4].ctx, view, series, [0, 0]);
      assert.equal(heavyOverlays[4].reservedRasterBytes(), chartBytes);
      assert.equal(heavyHarnesses[4].stats().drawImageCount, 1);
      assert.equal(heavyHarnesses[4].stats().mainFillRectCalls, 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 4 * chartBytes);

      // Hiding via mode === "off" + onChange synchronously frees ALL active charts BEFORE any draw call!
      mode = "off";
      notifySettingsChange();
      for (let i = 0; i < 9; i++) {
        assert.equal(heavyOverlays[i].reservedRasterBytes(), 0);
      }
      for (const h of heavyHarnesses) {
        for (const c of h.stats().offscreenCanvases) {
          assert.equal(c.width, 0);
          assert.equal(c.height, 0);
        }
      }
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);

      // Re-enabling allows queued chart 5 to reserve cleanly too!
      mode = "single";
      notifySettingsChange();
      heavyHarnesses[5].resetPaintCounters();
      heavyOverlays[5].draw(heavyHarnesses[5].ctx, view, series, [0, 0]);
      assert.equal(heavyOverlays[5].reservedRasterBytes(), chartBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), chartBytes);
    });
  } finally {
    for (const overlay of overlays) overlay.dispose();
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  }
});

test("resize updates net reserved bytes accurately and drops old buffer if resized past module budget", async () => {
  const overlays = [];
  try {
    await withSettingsSource(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }), async () => {
      const series = makeTestSeries();
      const view = makeTestView();

      const overlayA = await createWarmOverlay(overlays);
      const hA = makeCanvasHarness(1000, 1000);
      await warmChunk(overlayA, hA.ctx, view, series);

      overlayA.draw(hA.ctx, view, series, [0, 0]);
      assert.equal(overlayA.reservedRasterBytes(), 4_000_000);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 4_000_000);

      // Grow A: 2000 x 1000 -> 8,000,000 net (NOT 4M + 8M)
      hA.resize(2000, 1000);
      overlayA.draw(hA.ctx, view, series, [0, 0]);
      assert.equal(overlayA.reservedRasterBytes(), 8_000_000);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 8_000_000);

      // Shrink A: 500 x 500 -> 1,000,000 net
      hA.resize(500, 500);
      overlayA.draw(hA.ctx, view, series, [0, 0]);
      assert.equal(overlayA.reservedRasterBytes(), 1_000_000);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 1_000_000);

      // Fill module to 128,000,000 B across 4 other charts (leaving 6,217,728 B headroom under 134,217,728 B)
      for (let i = 0; i < 4; i++) {
        const filler = await createWarmOverlay(overlays);
        const hf = makeCanvasHarness(4000, 2000); // 32,000,000 B <= 32 MiB
        await warmChunk(filler, hf.ctx, view, series);
        filler.draw(hf.ctx, view, series, [0, 0]);
        assert.equal(filler.reservedRasterBytes(), 32_000_000);
      }
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 129_000_000);

      // Grow A to 8,000,000 B (128M + 8M = 136M > 134,217,728 B): A must zero/release old 1M canvas and fall back!
      const canvasA = hA.stats().offscreenCanvases[0];
      assert.equal(canvasA.width, 500);
      hA.resize(2000, 1000);
      hA.resetPaintCounters();
      overlayA.draw(hA.ctx, view, series, [0, 0]);
      assert.equal(canvasA.width, 0);
      assert.equal(canvasA.height, 0);
      assert.equal(overlayA.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 128_000_000);
      assert.equal(hA.stats().mainFillRectCalls, 2);
    });
  } finally {
    for (const overlay of overlays) overlay.dispose();
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  }
});

test("empty visible cells, pull-mode off, failed 2d context, and repeated release/dispose never double-release", async () => {
  const overlays = [];
  let mode = "single";

  try {
    await withSettingsSource(() => ({
      mode,
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }), async () => {
      const series = makeTestSeries();
      const view = makeTestView();

      const anchor = await createWarmOverlay(overlays);
      const hAnchor = makeCanvasHarness(1000, 1000);
      await warmChunk(anchor, hAnchor.ctx, view, series);
      anchor.draw(hAnchor.ctx, view, series, [0, 0]);
      const anchorBytes = 4_000_000;
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);

      const overlay = await createWarmOverlay(overlays);
      const h = makeCanvasHarness(1200, 800);
      const expectedBytes = 1200 * 800 * 4;
      await warmChunk(overlay, h.ctx, view, series);
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);
      const canvas = h.stats().offscreenCanvases[0];

      // 1. cells === 0 via vertical pan outside loaded buckets releases offscreen canvas & keeps 0 bytes
      view.priceTop = 10_000;
      h.resetPaintCounters();
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(canvas.width, 0);
      assert.equal(canvas.height, 0);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);
      // Fast empty hit path keeps 0 bytes
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);

      // 2. Restore visible cells -> caches again, then repeated release/mode-off/dispose must NOT double-release anchor!
      view.priceTop = 250;
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);

      overlay.releaseRasterCache();
      overlay.releaseRasterCache();
      mode = "off";
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);

      mode = "single";
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);

      overlay.dispose();
      overlay.dispose();
      overlay.releaseRasterCache();
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes, "double-dispose must never undercount other charts");

      // 3. Failed getContext("2d") drops canvas cleanly and paints directly without reserving bytes
      const brokenOverlay = await createWarmOverlay(overlays);
      const hBroken = makeCanvasHarness(1000, 1000, { contextAvailable: false });
      await warmChunk(brokenOverlay, hBroken.ctx, view, series);
      hBroken.resetPaintCounters();
      brokenOverlay.draw(hBroken.ctx, view, series, [0, 0]);
      assert.equal(brokenOverlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);
      assert.equal(hBroken.stats().offscreenCanvases[0].width, 0);
      assert.equal(hBroken.stats().offscreenCanvases[0].height, 0);
      assert.equal(hBroken.stats().mainFillRectCalls, 2);

      // Clean up remaining anchor + broken
      brokenOverlay.dispose();
      anchor.dispose();
      anchor.dispose();
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
    });
  } finally {
    for (const overlay of overlays) overlay.dispose();
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  }
});

function makeVisibilityAwareHarness(initialWidth, initialHeight) {
  const base = makeCanvasHarness(initialWidth, initialHeight);
  let visibilityState = "visible";
  let isConnected = true;
  const listeners = new Map();
  let addedVisibilityListeners = 0;
  let removedVisibilityListeners = 0;
  const observerRecords = [];

  class MockIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.disconnected = false;
      observerRecords.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }
  }

  const ownerDocument = {
    get visibilityState() {
      return visibilityState;
    },
    defaultView: {
      IntersectionObserver: MockIntersectionObserver,
    },
    createElement(tag) {
      return base.ctx.canvas.ownerDocument.createElement(tag);
    },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      if (!set.has(listener)) {
        set.add(listener);
        if (type === "visibilitychange") addedVisibilityListeners++;
      }
    },
    removeEventListener(type, listener) {
      const set = listeners.get(type);
      if (set && set.delete(listener) && type === "visibilitychange") {
        removedVisibilityListeners++;
      }
    },
  };

  const ctx = {
    ...base.ctx,
    canvas: {
      get width() { return base.ctx.canvas.width; },
      get height() { return base.ctx.canvas.height; },
      get isConnected() { return isConnected; },
      ownerDocument,
    },
  };

  return {
    ctx,
    stats: base.stats,
    resetPaintCounters: base.resetPaintCounters,
    dispatchVisibility(nextState) {
      visibilityState = nextState;
      for (const listener of [...(listeners.get("visibilitychange") ?? [])]) {
        listener();
      }
    },
    triggerIntersection(isIntersecting) {
      for (const record of observerRecords) {
        if (!record.disconnected && record.targets.has(ctx.canvas)) {
          record.callback([{ target: ctx.canvas, isIntersecting }]);
        }
      }
    },
    setConnected(nextConnected) {
      isConnected = nextConnected;
    },
    observerStats() {
      return {
        addedVisibilityListeners,
        removedVisibilityListeners,
        activeVisibilityListeners: listeners.get("visibilitychange")?.size ?? 0,
        createdObservers: observerRecords.length,
        activeObservers: observerRecords.filter((record) => !record.disconnected).length,
      };
    },
  };
}

test("hidden panel/tab visibility transitions release rasterCache without double-release and restore on next draw", async () => {
  const overlays = [];
  const wasTelemetryEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });

  try {
    await withSettingsSource(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }), async () => {
      const series = makeTestSeries();
      const view = makeTestView();

      const anchor = await createWarmOverlay(overlays);
      const hAnchor = makeVisibilityAwareHarness(1000, 1000);
      await warmChunk(anchor, hAnchor.ctx, view, series);
      anchor.draw(hAnchor.ctx, view, series, [0, 0]);
      const anchorBytes = 4_000_000;
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);

      const overlay = await createWarmOverlay(overlays);
      const h = makeVisibilityAwareHarness(1200, 800);
      const expectedBytes = 1200 * 800 * 4;
      await warmChunk(overlay, h.ctx, view, series);
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);

      // 1. document visibilitychange -> hidden releases immediately; drawing while hidden paints directly without caching; restore rebuilds cleanly
      h.dispatchVisibility("hidden");
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);
      assert.equal(h.stats().offscreenCanvases[0].width, 0);
      assert.equal(h.stats().offscreenCanvases[0].height, 0);

      h.resetPaintCounters();
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(h.stats().drawImageCount, 0);
      assert.equal(h.stats().mainFillRectCalls, 2);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);

      h.dispatchVisibility("visible");
      h.resetPaintCounters();
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);
      assert.equal(h.stats().drawImageCount, 1);
      assert.equal(h.stats().mainFillRectCalls, 0);

      // 2. IntersectionObserver !isIntersecting releases immediately; restore rebuilds cleanly
      h.triggerIntersection(false);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);

      h.resetPaintCounters();
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(h.stats().mainFillRectCalls, 2);

      h.triggerIntersection(true);
      h.resetPaintCounters();
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);
      assert.equal(h.stats().drawImageCount, 1);

      // 3. Disconnected canvas (isConnected === false) releases & skips cache until reconnected
      h.setConnected(false);
      h.resetPaintCounters();
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);
      assert.equal(h.stats().mainFillRectCalls, 2);

      h.setConnected(true);
      h.resetPaintCounters();
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);

      // 4. Direct test bypass toggle cleanly routes to direct paint & re-enables cache
      overlay.setRasterCacheDisabledForTest(true);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);
      h.resetPaintCounters();
      const beforeDirect = snapshotPerformanceTelemetry().counters;
      overlay.draw(h.ctx, view, series, [0, 0]);
      const afterDirect = snapshotPerformanceTelemetry().counters;
      assert.equal(
        (afterDirect["chart.cpu.heatmap.raster.direct"] ?? 0) - (beforeDirect["chart.cpu.heatmap.raster.direct"] ?? 0),
        1,
      );
      assert.equal(h.stats().mainFillRectCalls, 2);
      assert.equal(h.stats().drawImageCount, 0);

      overlay.setRasterCacheDisabledForTest(false);
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);

      // 5. setVisible(false/true), stacked hide events, and double dispose never double-release anchor or leak observers
      overlay.setVisible(false);
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes);

      h.dispatchVisibility("hidden");
      h.triggerIntersection(false);
      overlay.releaseRasterCache();
      overlay.setVisible(true);
      h.dispatchVisibility("visible");
      h.triggerIntersection(true);
      overlay.draw(h.ctx, view, series, [0, 0]);
      assert.equal(overlay.reservedRasterBytes(), expectedBytes);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes + expectedBytes);

      overlay.setVisible(false);
      h.dispatchVisibility("hidden");
      overlay.dispose();
      overlay.dispose();
      assert.equal(overlay.reservedRasterBytes(), 0);
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), anchorBytes, "stacked hide + dispose must never undercount open charts");
      assert.deepEqual(h.observerStats(), {
        addedVisibilityListeners: 1,
        removedVisibilityListeners: 1,
        activeVisibilityListeners: 0,
        createdObservers: 1,
        activeObservers: 0,
      });

      anchor.dispose();
      assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
      assert.deepEqual(hAnchor.observerStats(), {
        addedVisibilityListeners: 1,
        removedVisibilityListeners: 1,
        activeVisibilityListeners: 0,
        createdObservers: 1,
        activeObservers: 0,
      });
    });
  } finally {
    for (const overlay of overlays) overlay.dispose();
    configurePerformanceTelemetry({ enabled: wasTelemetryEnabled });
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  }
});


test("viewport motion skips raster misses until an injected quiet interval, then rebuilds once and hits", async () => {
  const overlays = [];
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    await withSettingsSource(() => ({ mode: "single", unit: "usd", bucketStep: 50,
      single: { usd: 1, btc: 1 }, aggregated: { usd: 1, btc: 1 } }), async () => {
      const overlay = await createWarmOverlay(overlays);
      let now = 60_000;
      overlay.now = () => now;
      const view = makeTestView();
      const series = makeTestSeries();
      const h = makeCanvasHarness(1600, 800);
      await warmChunk(overlay, h.ctx, view, series);
      const before = snapshotPerformanceTelemetry().counters;
      overlay.draw(h.ctx, view, series, [0, 0]);
      overlay.draw(h.ctx, view, series, [0, 0]);
      for (let index = 0; index < 5; index++) {
        now += 16;
        view.offsetX += 0.25;
        overlay.draw(h.ctx, view, series, [0, 0]);
      }
      now += HEATMAP_CPU_RASTER_QUIET_MS - 1;
      overlay.draw(h.ctx, view, series, [0, 0]);
      const moving = snapshotPerformanceTelemetry().counters;
      assert.equal((moving["chart.cpu.heatmap.raster.skip"] ?? 0) - (before["chart.cpu.heatmap.raster.skip"] ?? 0), 6);
      assert.equal((moving["chart.cpu.heatmap.raster.miss"] ?? 0) - (before["chart.cpu.heatmap.raster.miss"] ?? 0), 1);
      assert.equal((moving["chart.cpu.heatmap.raster.hit"] ?? 0) - (before["chart.cpu.heatmap.raster.hit"] ?? 0), 1);
      now++;
      overlay.draw(h.ctx, view, series, [0, 0]);
      overlay.draw(h.ctx, view, series, [0, 0]);
      const quiet = snapshotPerformanceTelemetry().counters;
      assert.equal((quiet["chart.cpu.heatmap.raster.miss"] ?? 0) - (moving["chart.cpu.heatmap.raster.miss"] ?? 0), 1);
      assert.equal((quiet["chart.cpu.heatmap.raster.hit"] ?? 0) - (moving["chart.cpu.heatmap.raster.hit"] ?? 0), 1);
      assert.equal(overlay.reservedRasterBytes(), 1600 * 800 * 4);
      overlay.setVisible(false);
      assert.equal(overlay.reservedRasterBytes(), 0);
    });
  } finally {
    for (const overlay of overlays) overlay.dispose();
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
});
