import test from "node:test";
import assert from "node:assert/strict";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { configureOrderbookHeatmapSettingsSource } from "../dist/features/orderbook/heatmapSettingsSource.js";
import { heatmapTierFor } from "../dist/features/orderbook/heatmapModel.js";

test("OrderbookHeatmapOverlay bounds chunk cache to MAX_CACHED_CHUNKS (12)", async () => {
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      single: { usd: 20_000_000, btc: 240 },
      aggregated: { usd: 50_000_000, btc: 600 },
    }),
    onChange: () => () => {},
  });

  const MINUTE = 60_000;
  const CHUNK_SPAN = 1000 * MINUTE;
  let simulatedTime = 15 * CHUNK_SPAN;

  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => ({
      bars: [
        { t: req.from, cells: [[100, 1, 0]] },
        { t: req.from + MINUTE, cells: [[100, 2, 0]] },
      ],
      complete: true,
    }),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    now: () => simulatedTime,
  });

  // Series spanning 15 chunks
  const series = {
    length: 15_000,
    config: { intervalMs: MINUTE },
    timeOfIndex: (i) => i * MINUTE,
  };

  // 1. Visible range covering older chunks 0 to 4
  const view = {
    area: { left: 0, top: 0, width: 800, height: 600 },
    colWidth: 10,
    xOfIndex: () => 10,
    yOfPrice: () => 100,
    priceOfY: () => 100,
  };

  const fakeCtx = {
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    fillRect() {},
  };

  // Draw over chunks 0..14 sequentially to simulate panning across 15 chunks
  for (let c = 0; c < 15; c++) {
    const fromIdx = c * 1000;
    const toIdx = fromIdx + 100;
    overlay.draw(fakeCtx, view, series, [fromIdx, toIdx]);
  }

  // Allow async fetch resolution
  await new Promise((resolve) => setTimeout(resolve, 50));

  // The total number of cached chunks must not exceed MAX_CACHED_CHUNKS (12)
  assert.ok(
    overlay.cachedChunksCount() <= 12,
    `cachedChunksCount (${overlay.cachedChunksCount()}) should be <= 12`,
  );

  overlay.dispose();
});
