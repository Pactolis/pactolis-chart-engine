import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

test("#299: hidden draw skips cell scanning/fillRect and triggers invalidate once visibility returns", async () => {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([{ startTime: 0, open: 100, high: 150, low: 50, close: 120, volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true }]);
  const view = new View();
  view.area = { left: 0, top: 0, width: 600, height: 300 };
  view.colWidth = 10;
  view.priceTop = 250;
  view.pricePerPx = 1;

  let fillRects = 0;
  let drawImages = 0;
  let invalidations = 0;
  const ctx = {
    canvas: {
      width: 600,
      height: 300,
      ownerDocument: { visibilityState: "visible" },
    },
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    drawImage() { drawImages++; },
    fillRect() { fillRects++; },
  };

  let overlay;
  try {
    overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: 60_000,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: [{ t: 0, cells: [[100, 1000, 1000], [150, 2000, 2000]] }],
      }),
      invalidate: () => { invalidations++; },
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => 60_000,
    });

    overlay.draw(ctx, view, series, [0, 0]);
    await new Promise((r) => setTimeout(r, 20));
    fillRects = 0;
    drawImages = 0;
    invalidations = 0;

    overlay.setVisible(false);
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(fillRects, 0, "hidden draw must not paint any cells directly");
    assert.equal(drawImages, 0, "hidden draw must not blit");

    overlay.setVisible(true);
    assert.equal(invalidations, 1, "restoring visibility after skipped hidden draw requests a fresh frame");
    overlay.draw(ctx, view, series, [0, 0]);
    assert.equal(fillRects, 2, "restored visible draw paints cells normally");
  } finally {
    overlay?.dispose();
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});
