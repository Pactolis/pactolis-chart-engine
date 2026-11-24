import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

const MINUTE_MS = 60_000;
const MARKET_BTC = "BINANCE_FUTURES:btcusdt";
const MARKET_ETH = "BINANCE_FUTURES:ethusdt";

function makeView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 10;
  view.priceTop = 50_500;
  view.pricePerPx = 5;
  return view;
}

function makeCells(count, basePrice = 50_000) {
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push([basePrice + i * 25, 2_000_000, 0]);
  }
  return cells;
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function withSingleSettings(run) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      single: { usd: 1_000_000, btc: 10 },
      aggregated: { usd: 5_000_000, btc: 50 },
    }),
    onChange: () => () => {},
  });
  try {
    return await run();
  } finally {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
}

test("#319: pinned historical viewport evicts old live-pushed bars, supports re-fetch on pan, same-t update, return to live, and market switch", async () => {
  await withSingleSettings(async () => {
    const startTime = 0;
    const totalMinutes = 3_500;
    const series = new FootprintSeries({ intervalMs: MINUTE_MS, priceStep: 1 });
    series.loadBars(Array.from({ length: totalMinutes + 10 }, (_, i) => ({
      startTime: startTime + i * MINUTE_MS,
      open: 50_000,
      high: 50_500,
      low: 49_500,
      close: 50_100,
      volume: 10,
      delta: 0,
      count: 1,
      cells: new Map(),
      hasRef: true,
    })));

    let market = MARKET_BTC;
    let currentTime = 5 * MINUTE_MS;
    let listener = null;
    const fetchedRanges = [];

    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => {
        fetchedRanges.push([req.from, req.to]);
        return {
          schemaVersion: 1,
          generatedAt: currentTime,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: [
            { t: Math.max(startTime, req.from), cells: makeCells(20) },
          ],
          complete: true,
        };
      },
      invalidate: () => {},
      getMarket: () => market,
      now: () => currentTime,
      subscribeLiveTail: (cb) => {
        listener = cb;
        return () => { listener = null; };
      },
    });

    try {
      const view = makeView();
      // Pin viewport on the first 3 historical candles [0, 2].
      overlay.getPrepareCacheKey(view, series, [0, 2]);
      await flushMicrotasks();
      assert.equal(overlay.cachedChunksCount(), 1);
      assert.equal(overlay.cachedBarsCount(), 1);

      // Advance simulated clock minute by minute and push 20-level live bars.
      for (let m = 10; m <= totalMinutes; m++) {
        currentTime = m * MINUTE_MS + 500;
        listener({
          market: MARKET_BTC,
          bars: [{ t: m * MINUTE_MS, cells: makeCells(20) }],
        });
        if (m % 1_000 === 0) {
          overlay.getPrepareCacheKey(view, series, [0, 2]);
        }
      }

      // Live bars must be bounded (1 historical + <= 1000 live tail bars), never growing to 3,500+.
      assert.ok(
        overlay.cachedBarsCount() <= 1_005,
        `cachedBarsCount (${overlay.cachedBarsCount()}) should remain bounded <= 1005`,
      );
      assert.equal(overlay.cachedChunksCount(), 1);

      // Historical bar 0 must still be preserved in the pinned viewport.
      const pinnedGpu = overlay.prepareGpuCells(view, series, [0, 2]);
      assert.ok(pinnedGpu !== null && pinnedGpu.main.length === 20, "pinned historical bar must stay cached");

      // Same-timestamp correction must update in place without growing bar count.
      const countBeforeCorrection = overlay.cachedBarsCount();
      listener({
        market: MARKET_BTC,
        bars: [{ t: totalMinutes * MINUTE_MS, cells: makeCells(20, 50_100) }],
      });
      assert.equal(overlay.cachedBarsCount(), countBeforeCorrection);

      // Returning to live tail uses cached live bars without needing a REST fetch.
      const fetchesBeforeLiveReturn = fetchedRanges.length;
      const liveGpu = overlay.prepareGpuCells(view, series, [totalMinutes - 2, totalMinutes]);
      await flushMicrotasks();
      assert.ok(liveGpu !== null && liveGpu.main.length === 60, "live tail bars should still be cached");
      assert.equal(fetchedRanges.length, fetchesBeforeLiveReturn);

      // Panning to an evicted chunk time (e.g. minute 1500 in chunk 1000..1999) triggers a REST re-fetch.
      const fetchesBeforePan = fetchedRanges.length;
      overlay.getPrepareCacheKey(view, series, [1_500, 1_502]);
      await flushMicrotasks();
      assert.ok(
        fetchedRanges.length > fetchesBeforePan,
        "panning to evicted live-tail range must re-fetch from REST provider",
      );

      // Market switch resets cached bars and chunks cleanly.
      market = MARKET_ETH;
      overlay.handleMarketChange();
      assert.equal(overlay.cachedBarsCount(), 0);
      assert.equal(overlay.cachedChunksCount(), 0);
    } finally {
      overlay.dispose();
    }
  });
});
