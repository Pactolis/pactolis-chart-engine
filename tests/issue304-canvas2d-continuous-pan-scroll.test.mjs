import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

test("#304: continuous 1-bar horizontal pan scrolls raster in-place and paints only newly exposed columns", async () => {
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
  const barCount = 180;
  const levelsPerBar = 50;
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(Array.from({ length: barCount }, (_, i) => ({
    startTime: i * MINUTE,
    open: 50_000, high: 51_500, low: 49_500, close: 50_500,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 300, height: 200 };
  view.colWidth = 10;
  view.offsetX = -600;
  view.priceTop = 51_500;
  view.pricePerPx = 10;

  let offFillRects = 0;
  const offCtx = {
    fillStyle: "",
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    setTransform() {}, clearRect() {}, drawImage() {},
    fillRect() { offFillRects++; },
  };
  const offCanvas = { width: 0, height: 0, getContext: () => offCtx };
  const ctx = {
    canvas: { width: 300, height: 200, ownerDocument: { createElement: () => offCanvas } },
    fillStyle: "",
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    setTransform() {}, drawImage() {}, fillRect() {},
  };

  let now = barCount * MINUTE;
  let overlay;
  try {
    overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: now,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: Array.from({ length: barCount }, (_, i) => ({
          t: i * MINUTE,
          cells: Array.from({ length: levelsPerBar }, (_, j) => [50_000 + j * 25, 1000, 1000]),
        })),
      }),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => now,
    });

    // Warm raster at offsetX = -600
    overlay.draw(ctx, view, series, [60, 89]);
    await new Promise((r) => setTimeout(r, 20));
    overlay.draw(ctx, view, series, [60, 89]);
    offFillRects = 0;

    // Pan 20 steps of 1 bar (10 px) every 16 ms: each step paints ~1-2 new columns, NOT growing with step count
    const perStep = [];
    for (let step = 1; step <= 20; step++) {
      now += 16;
      view.offsetX -= 10;
      const before = offFillRects;
      overlay.draw(ctx, view, series, [60 + step, 89 + step]);
      perStep.push(offFillRects - before);
    }
    // Step 20 must stay bounded (not O(20 * levels))
    assert.ok(perStep[19] <= 200, `step 20 should stay bounded, got ${perStep[19]}`);
    assert.ok(offFillRects <= 4000, `20-step total fillRects should stay O(steps), got ${offFillRects}`);
  } finally {
    overlay?.dispose();
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});
