import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import {
  OrderbookHeatmapOverlay,
  getHeatmapCpuRasterModuleReservedBytes,
} from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

test("#306: high-DPI over-budget dense heatmap caches cropped occupied region and full-canvas blits tight sub-rect", async () => {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      opacity: 0.85,
      scaleMode: "fixed",
      fixedCeiling: { usd: 10_000, btc: 10 },
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const MINUTE = 60_000;
  const barCount = 60;
  const levels = 200;
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(Array.from({ length: barCount }, (_, i) => ({
    startTime: i * MINUTE,
    open: 50_000, high: 55_000, low: 49_000, close: 50_500,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 1800, height: 1000 };
  view.colWidth = 10; // 60 bars occupy first 600 CSS px
  view.priceTop = 55_000;
  view.pricePerPx = 5;
  view.pixelRatio = 2;

  const makeHarness = (pxW, pxH) => {
    let offFillRects = 0;
    let mainFillRects = 0;
    const drawImageCalls = [];
    const offCtx = {
      fillStyle: "",
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      setTransform() {}, clearRect() {},
      fillRect() { offFillRects++; },
    };
    const offCanvas = { width: 0, height: 0, getContext: () => offCtx };
    const ctx = {
      canvas: { width: pxW, height: pxH, ownerDocument: { createElement: () => offCanvas } },
      fillStyle: "",
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
      setTransform() {},
      drawImage(...args) { drawImageCalls.push(args); },
      fillRect() { mainFillRects++; },
    };
    return {
      ctx,
      offCanvas,
      stats: () => ({ offFillRects, mainFillRects, drawImageCalls }),
      reset: () => { offFillRects = 0; mainFillRects = 0; drawImageCalls.length = 0; },
    };
  };

  let overlay1;
  let overlay2;
  try {
    const fetch = async (req) => ({
      schemaVersion: 1,
      generatedAt: barCount * MINUTE,
      base: "BTC",
      source: req.source,
      resolution: req.resolution,
      bucketStep: req.bucketStep,
      from: req.from,
      to: req.to,
      bars: Array.from({ length: barCount }, (_, i) => ({
        t: i * MINUTE,
        cells: Array.from({ length: levels }, (_, j) => [50_000 + j * 25, 1000, 1000]),
      })),
    });

    // Case A: 1920x1100 @ DPR 2 (3840x2200 = 33.79 MiB > 32 MiB) -> crops to occupied 600x1000 CSS px (1200x2000 = 9.6 MB)
    overlay1 = new OrderbookHeatmapOverlay({ fetch, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => barCount * MINUTE });
    const h1 = makeHarness(3840, 2200);
    overlay1.draw(h1.ctx, view, series, [0, barCount - 1]);
    await new Promise((r) => setTimeout(r, 20));
    h1.reset();
    overlay1.draw(h1.ctx, view, series, [0, barCount - 1]);
    assert.equal(h1.offCanvas.width, 1200);
    assert.equal(h1.offCanvas.height, 2000);
    assert.equal(overlay1.reservedRasterBytes(), 1200 * 2000 * 4);
    h1.reset();
    overlay1.draw(h1.ctx, view, series, [0, barCount - 1]);
    assert.equal(h1.stats().offFillRects, 0, "warm cropped raster must have 0 cell visits");
    assert.equal(h1.stats().mainFillRects, 0);
    assert.equal(h1.stats().drawImageCalls.length, 1);
    overlay1.dispose();
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);

    // Case B: 1920x1080 @ DPR 2 (3840x2160 = 33.17 MiB <= 32 MiB) -> full canvas but tight sub-rect blit (w = 1200 < 3840)
    overlay2 = new OrderbookHeatmapOverlay({ fetch, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => barCount * MINUTE });
    const h2 = makeHarness(3840, 2160);
    overlay2.draw(h2.ctx, view, series, [0, barCount - 1]);
    await new Promise((r) => setTimeout(r, 20));
    h2.reset();
    overlay2.draw(h2.ctx, view, series, [0, barCount - 1]);
    const blitArgs = h2.stats().drawImageCalls[0];
    assert.equal(blitArgs.length, 9, "full canvas with <85% occupied area must blit tight sub-rect");
    assert.equal(blitArgs[3], 1200);
    overlay2.dispose();
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
  } finally {
    overlay1?.dispose();
    overlay2?.dispose();
    assert.equal(getHeatmapCpuRasterModuleReservedBytes(), 0);
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});
