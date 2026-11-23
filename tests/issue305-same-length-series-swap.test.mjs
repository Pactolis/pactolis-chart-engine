import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { ChartHeatmapGpuCoordinator } from "../dist/features/chart/ChartHeatmapGpuCoordinator.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

test("#305: same-length loadBars with shifted timestamps invalidates Canvas2D raster and WebGL2 prepare cache", async () => {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      opacity: 0.85,
      scaleMode: "fixed",
      fixedCeiling: { usd: 500_000, btc: 10 },
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const MINUTE = 60_000;
  const t0 = 1_700_000_040_000;
  const makeBars = (startMs) => Array.from({ length: 20 }, (_, i) => ({
    startTime: startMs + i * MINUTE,
    open: 100, high: 120, low: 90, close: 110,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  }));

  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(makeBars(t0));

  const view = new View();
  view.area = { left: 0, top: 0, width: 400, height: 200 };
  view.colWidth = 20;
  view.priceTop = 150;
  view.pricePerPx = 1;

  const offCtx = {
    fillStyle: "",
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    setTransform() {}, clearRect() {},
    fillRect() {},
  };
  const offCanvas = { width: 0, height: 0, getContext: () => offCtx };
  const ctx = {
    canvas: { width: 400, height: 200, ownerDocument: { createElement: () => offCanvas } },
    fillStyle: "",
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    setTransform() {}, drawImage() {}, fillRect() {},
  };

  let overlay;
  try {
    overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: t0 + 60 * MINUTE,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: [
          ...Array.from({ length: 20 }, (_, i) => ({ t: t0 + i * MINUTE, cells: [[100, 5, 5]] })),
          ...Array.from({ length: 20 }, (_, i) => ({ t: t0 + (40 + i) * MINUTE, cells: [[100, 250_000, 250_000]] })),
        ],
      }),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => t0 + 60 * MINUTE,
    });

    overlay.draw(ctx, view, series, [0, 19]);
    await new Promise((r) => setTimeout(r, 20));
    overlay.draw(ctx, view, series, [0, 19]);
    const keyBefore = overlay.getPrepareCacheKey(view, series, [0, 19]);
    const gpuFrameBefore = overlay.prepareGpuCells(view, series, [0, 19]);
    assert.equal(gpuFrameBefore.main[0].value, 10);

    // Replace with 20 bars 40 minutes later (same length === 20, structureRevision bumped)
    series.loadBars(makeBars(t0 + 40 * MINUTE));
    const keyAfter = overlay.getPrepareCacheKey(view, series, [0, 19]);
    assert.notEqual(keyAfter, keyBefore, "prepare cache key must change on same-length structureRevision bump");

    overlay.draw(ctx, view, series, [0, 19]);
    const gpuFrameAfter = overlay.prepareGpuCells(view, series, [0, 19]);
    assert.equal(gpuFrameAfter.main[0].value, 500_000);

    // Coordinator suppression also rejects stale structureRevision
    const coord = new ChartHeatmapGpuCoordinator({
      backendKind: "webgl2",
      orderbookHeatmap: overlay,
      renderer: { visibleRange: () => [0, 19] },
      renderCoordinator: { getAnnotationLayerOrder: () => ["orderbook-heatmap"] },
      invalidateSession: () => {},
    });
    assert.equal(coord.heatmapGpuSuppressedAnnotation(view, series, [0, 19]), false);
    coord.dispose();
  } finally {
    overlay?.dispose();
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});
