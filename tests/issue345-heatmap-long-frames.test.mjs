import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";
import {
  blendPackedRgbaSourceOver,
  getHeatmapThresholdSparseBar,
  packRgbaToUint32,
} from "../dist/features/orderbook/heatmapModel.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

const MINUTE_MS = 60_000;
const BAR_15M_MS = 15 * MINUTE_MS;
const MARKET = "BINANCE_FUTURES:btcusdt";

const ISSUE345_SETTINGS = {
  mode: "single",
  unit: "btc",
  bucketStep: 25,
  opacity: 0.85,
  palette: "viridis",
  scaleMode: "fixed",
  contrast: "medium",
  fixedCeiling: { usd: 10_000_000, btc: 1_000 },
  single: { usd: 1_000_000, btc: 100 },
  aggregated: { usd: 1_000_000, btc: 100 },
};

async function withSettings(settingsFor, work) {
  let prev = null;
  try {
    prev = orderbookHeatmapSettingsSource();
  } catch {
    // ignore unset default
  }
  const listeners = new Set();
  configureOrderbookHeatmapSettingsSource({
    settingsFor,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  try {
    return await work();
  } finally {
    if (prev) configureOrderbookHeatmapSettingsSource(prev);
  }
}

function make15mSeries(length = 960) {
  const series = new FootprintSeries({ intervalMs: BAR_15M_MS, priceStep: 25 });
  series.loadBars(
    Array.from({ length }, (_, i) => ({
      startTime: (100_000 + i) * BAR_15M_MS,
      open: 90_000,
      high: 91_500,
      low: 88_500,
      close: 90_200,
      volume: 100,
      delta: 0,
      count: 1,
      cells: new Map(),
      hasRef: true,
    })),
  );
  return series;
}

function make15mBars(length = 960) {
  const bars = [];
  for (let i = 0; i < length; i++) {
    const t = (100_000 + i) * BAR_15M_MS;
    const cells = [];
    // 100 buckets of $25 from 88,500 to 90,975
    for (let k = 0; k < 100; k++) {
      const price = 88_500 + k * 25;
      const mid = price + 12.5;
      // Most bars are entirely < 100 BTC; every 16th bar has 2 heavy walls >= 100 BTC.
      const isHeavyBar = i % 16 === 0;
      const isHeavyCell = isHeavyBar && (k === 32 || k === 64);
      const btc = isHeavyCell ? (k === 32 ? 180 : 650) : 2 + ((i + k) % 45);
      const totalUsd = btc * mid;
      cells.push([price, totalUsd * 0.5, totalUsd * 0.5]);
    }
    bars.push({ t, cells });
  }
  return bars;
}

function makeView({ dpr = 1, width = 1200, height = 600, colWidth = 1.25, offsetX = 0, logScale = false } = {}) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height };
  view.colWidth = colWidth;
  view.offsetX = offsetX;
  view.priceTop = 91_200;
  view.pricePerPx = (91_200 - 88_200) / height;
  view.pixelRatio = dpr;
  if (logScale) {
    view.setScaleMode("log");
  }
  return view;
}

function makeOffscreenHarness({ width = 1200, height = 600, dpr = 1, supportImageData = true } = {}) {
  const offFillRects = [];
  let putImageDataCalls = 0;
  let lastImageData = null;
  let currentOffFillStyle = "";
  let offTransform = { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 };
  let offClip = null;
  let offPendingRect = null;

  const offCtx = {
    canvas: { width: 0, height: 0 },
    get fillStyle() {
      return currentOffFillStyle;
    },
    set fillStyle(v) {
      currentOffFillStyle = v;
    },
    save() {},
    restore() {
      offClip = null;
    },
    beginPath() {
      offPendingRect = null;
    },
    rect(x, y, w, h) {
      offPendingRect = { x, y, w, h };
    },
    clip() {
      if (offPendingRect) offClip = { ...offPendingRect };
    },
    getTransform() {
      return { ...offTransform };
    },
    setTransform(a, b, c, d, e, f) {
      offTransform = { a, b, c, d, e, f };
    },
    clearRect() {
      offFillRects.length = 0;
    },
    fillRect(x, y, w, h) {
      offFillRects.push({
        x,
        y,
        w,
        h,
        fillStyle: currentOffFillStyle,
        transform: { ...offTransform },
        clip: offClip ? { ...offClip } : null,
      });
    },
    ...(supportImageData
      ? {
          createImageData(w, h) {
            const data = new Uint8ClampedArray(w * h * 4);
            return { width: w, height: h, data };
          },
          putImageData(img) {
            putImageDataCalls++;
            lastImageData = img;
          },
        }
      : {}),
  };

  const offscreenCanvas = {
    width: 0,
    height: 0,
    getContext(kind) {
      if (kind !== "2d") return null;
      offCtx.canvas = offscreenCanvas;
      return offCtx;
    },
  };

  const mainDrawImages = [];
  const mainCtx = {
    canvas: {
      width: Math.round(width * dpr),
      height: Math.round(height * dpr),
      ownerDocument: {
        createElement() {
          return offscreenCanvas;
        },
      },
    },
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    getTransform() {
      return { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 };
    },
    setTransform() {},
    drawImage(img, ...args) {
      mainDrawImages.push({ img, args });
    },
    fillRect() {},
  };

  return {
    ctx: mainCtx,
    offCtx,
    stats() {
      return {
        offFillRects,
        putImageDataCalls,
        lastImageData,
        mainDrawImages,
      };
    },
  };
}

function parseRgbaCss(css) {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(css);
  if (!m) throw new Error(`Unexpected fillStyle: ${css}`);
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    aByte: Math.round((m[4] !== undefined ? Number(m[4]) : 1) * 255),
  };
}

function rasterizeReferenceFillRects(fillRects, canvasW, canvasH) {
  const buf = new Uint32Array(canvasW * canvasH);
  for (const rect of fillRects) {
    const { a, d, e, f } = rect.transform;
    const clip = rect.clip;
    const clipPxLeft = clip ? Math.max(0, Math.floor(clip.x * a + e)) : 0;
    const clipPxTop = clip ? Math.max(0, Math.floor(clip.y * d + f)) : 0;
    const clipPxRight = clip ? Math.min(canvasW, Math.ceil((clip.x + clip.w) * a + e)) : canvasW;
    const clipPxBottom = clip ? Math.min(canvasH, Math.ceil((clip.y + clip.h) * d + f)) : canvasH;
    const px0 = rect.x * a + e;
    const px1 = (rect.x + rect.w) * a + e;
    const py0 = rect.y * d + f;
    const py1 = (rect.y + rect.h) * d + f;
    let ix0 = Math.round(px0);
    let ix1 = Math.round(px1);
    let iy0 = Math.round(py0);
    let iy1 = Math.round(py1);
    if (ix1 <= ix0 && px1 > px0) ix1 = ix0 + 1;
    if (iy1 <= iy0 && py1 > py0) iy1 = iy0 + 1;
    if (ix0 < clipPxLeft) ix0 = clipPxLeft;
    if (ix1 > clipPxRight) ix1 = clipPxRight;
    if (iy0 < clipPxTop) iy0 = clipPxTop;
    if (iy1 > clipPxBottom) iy1 = clipPxBottom;
    const { r, g, b, aByte } = parseRgbaCss(rect.fillStyle);
    const srcPacked = packRgbaToUint32(r, g, b, aByte);
    for (let py = iy0; py < iy1; py++) {
      const row = py * canvasW;
      for (let px = ix0; px < ix1; px++) {
        const idx = row + px;
        buf[idx] = buf[idx] === 0 ? srcPacked : blendPackedRgbaSourceOver(buf[idx], r, g, b, aByte);
      }
    }
  }
  return buf;
}

test("#345 sparse positive-threshold index shrinks scanned cells while preserving <100 BTC hover cells", async () => {
  const bars = make15mBars(960);
  const series = make15mSeries(960);

  let nonEmptySparseBars = 0;
  let totalRawCells = 0;
  let totalSparseCells = 0;
  for (const bar of bars) {
    totalRawCells += bar.cells.length;
    const sparse = getHeatmapThresholdSparseBar(bar, "btc", 100, 25);
    if (sparse.cells.length > 0) nonEmptySparseBars++;
    totalSparseCells += sparse.cells.length;
    assert.equal(bar.cells.length, 100, "bar.cells must never be mutated");
  }
  assert.equal(totalRawCells, 96_000);
  assert.equal(nonEmptySparseBars, 60);
  assert.equal(totalSparseCells, 120);

  await withSettings(() => ISSUE345_SETTINGS, async () => {
    let now = 101_000 * BAR_15M_MS;
    const view = makeView({ dpr: 1, width: 1200, height: 600, colWidth: 1.25 });
    const harness = makeOffscreenHarness({ width: 1200, height: 600, dpr: 1, supportImageData: true });
    let hoverFetchCount = 0;

    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => {
        if (req.threshold === 0) hoverFetchCount++;
        return {
          schemaVersion: 1,
          generatedAt: now,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars,
        };
      },
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => now,
    });

    overlay.draw(harness.ctx, view, series, [0, 959]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    overlay.draw(harness.ctx, view, series, [0, 959]);

    const stats = harness.stats();
    assert.equal(stats.putImageDataCalls, 1, "expected single putImageData call for offscreen raster");
    assert.equal(stats.offFillRects.length, 0, "expected zero offscreen fillRect calls with ImageData fast path");

    // Verify < 100 BTC cells remain intact for hover lookup
    const hoverCtx = {
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      roundRect() {},
      clip() {},
      fill() {},
      stroke() {},
      fillRect() {},
      fillText() {},
      measureText(t) {
        return { width: String(t).length * 6 };
      },
      set font(_) {},
      set fillStyle(_) {},
      set strokeStyle(_) {},
      set lineWidth(_) {},
      set textAlign(_) {},
      set textBaseline(_) {},
    };
    overlay.drawHover(hoverCtx, view, series, { visible: true, x: 100, y: 300 });
    await new Promise((resolve) => setTimeout(resolve, 140));
    overlay.drawHover(hoverCtx, view, series, { visible: true, x: 100, y: 300 });
    assert.ok(hoverFetchCount >= 1, "hover lookup should request unthresholded bars");
    for (const bar of bars) {
      assert.ok(bar.cells.some((c) => c[1] + c[2] < 100 * (c[0] + 12.5)), "<100 BTC cells stay in bar.cells");
    }

    overlay.dispose();
  });
});

for (const cfg of [
  { name: "linear dpr=1", dpr: 1, logScale: false },
  { name: "linear dpr=2", dpr: 2, logScale: false },
  { name: "linear dpr=1.25", dpr: 1.25, logScale: false },
  { name: "log dpr=1", dpr: 1, logScale: true },
  { name: "log dpr=1.25", dpr: 1.25, logScale: true },
]) {
  test(`#345 packed ImageData rasterizer matches reference fillRect pixel-for-pixel (${cfg.name})`, async () => {
    const bars = make15mBars(128);
    const series = make15mSeries(128);

    await withSettings(() => ISSUE345_SETTINGS, async () => {
      const now = 101_000 * BAR_15M_MS;
      const view = makeView({ dpr: cfg.dpr, width: 400, height: 240, colWidth: 3, logScale: cfg.logScale });
      const fastHarness = makeOffscreenHarness({
        width: 400,
        height: 240,
        dpr: cfg.dpr,
        supportImageData: true,
      });
      const refHarness = makeOffscreenHarness({
        width: 400,
        height: 240,
        dpr: cfg.dpr,
        supportImageData: false,
      });

      const makeOverlay = () =>
        new OrderbookHeatmapOverlay({
          fetch: async (req) => ({
            schemaVersion: 1,
            generatedAt: now,
            base: "BTC",
            source: req.source,
            resolution: req.resolution,
            bucketStep: req.bucketStep,
            from: req.from,
            to: req.to,
            bars,
          }),
          invalidate: () => {},
          getMarket: () => MARKET,
          now: () => now,
        });

      const fastOverlay = makeOverlay();
      const refOverlay = makeOverlay();

      fastOverlay.draw(fastHarness.ctx, view, series, [0, 127]);
      refOverlay.draw(refHarness.ctx, view, series, [0, 127]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      fastOverlay.draw(fastHarness.ctx, view, series, [0, 127]);
      refOverlay.draw(refHarness.ctx, view, series, [0, 127]);

      const fastStats = fastHarness.stats();
      const refStats = refHarness.stats();
      assert.equal(fastStats.putImageDataCalls, 1);
      assert.equal(fastStats.offFillRects.length, 0);
      assert.ok(refStats.offFillRects.length > 0);

      const img = fastStats.lastImageData;
      const fastU32 = new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.byteLength >>> 2);
      const refU32 = rasterizeReferenceFillRects(refStats.offFillRects, img.width, img.height);
      assert.deepEqual(Array.from(fastU32), Array.from(refU32));

      fastOverlay.dispose();
      refOverlay.dispose();
    });
  });
}

test("#345 WebGL2 prepareGpuCells uses sparse threshold index and preserves parity", async () => {
  const bars = make15mBars(960);
  const series = make15mSeries(960);

  await withSettings(() => ISSUE345_SETTINGS, async () => {
    const now = 101_000 * BAR_15M_MS;
    const view = makeView({ dpr: 1, width: 1200, height: 600, colWidth: 1.25 });
    let released = false;

    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: now,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars,
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => now,
    });

    overlay.prepareGpuCells(view, series, [0, 959], () => ({ release() { released = true; } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const gpuFrame = overlay.prepareGpuCells(view, series, [0, 959], () => ({
      release() {
        released = true;
      },
    }));

    assert.ok(gpuFrame, "expected prepared GPU frame");
    assert.equal(gpuFrame.main.length, 120, "expected only >= 100 BTC sparse cells");
    assert.equal(gpuFrame.floor, 100);
    assert.equal(gpuFrame.ceiling, 1_000);
    assert.equal(gpuFrame.threshold, 100);
    assert.equal(gpuFrame.palette, "viridis");
    assert.equal(gpuFrame.opacity, 0.85);
    assert.equal(released, false);
    gpuFrame.preparedLease?.release();
    assert.equal(released, true);

    overlay.dispose();
  });
});

test("#345 tryMotionRasterReuse stays stable when bar 0 is visible at left history boundary", async () => {
  const bars = make15mBars(960);
  const series = make15mSeries(960);

  await withSettings(() => ISSUE345_SETTINGS, async () => {
    let now = 101_000 * BAR_15M_MS;
    const view = makeView({ dpr: 1, width: 1200, height: 600, colWidth: 1.25, offsetX: 120 });
    const harness = makeOffscreenHarness({ width: 1200, height: 600, dpr: 1, supportImageData: true });

    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: now,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars,
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => now,
    });

    overlay.draw(harness.ctx, view, series, [0, 959]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    overlay.draw(harness.ctx, view, series, [0, 959]);

    const before = snapshotPerformanceTelemetry().counters;
    for (let step = 0; step < 4; step++) {
      now += 16;
      view.offsetX += 10;
      overlay.draw(harness.ctx, view, series, [0, 959]);
    }
    const after = snapshotPerformanceTelemetry().counters;

    assert.equal(
      (after["chart.cpu.heatmap.raster.motionReuse"] ?? 0) - (before["chart.cpu.heatmap.raster.motionReuse"] ?? 0),
      4,
      "left-boundary pan with bar 0 visible should reuse raster cache on every frame",
    );
    assert.equal(
      (after["chart.cpu.heatmap.raster.miss"] ?? 0) - (before["chart.cpu.heatmap.raster.miss"] ?? 0),
      0,
      "left-boundary pan with bar 0 visible should not trigger unnecessary cache misses",
    );

    overlay.dispose();
  });
});
