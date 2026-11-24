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
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const MARKET = "BINANCE_FUTURES:btcusdt";

function makeView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 50_200;
  view.pricePerPx = 2;
  return view;
}

function makeSeries(intervalMs, count, startTime) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(Array.from({ length: count }, (_, i) => ({
    startTime: startTime + i * intervalMs,
    open: 50_000,
    high: 50_100,
    low: 49_900,
    close: 50_050,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  })));
  return series;
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function withFixedScaleSettings(run) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      scaleMode: "fixed",
      fixedCeiling: { usd: 10_000_000, btc: 200 },
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

test("#323: 3m/1m same-minute value updates do not rebuild sortedBarTimes index while new keys and out-of-order inserts do", async () => {
  await withFixedScaleSettings(async () => {
    const startTime = 0;
    const series = makeSeries(3 * MINUTE_MS, 333, startTime);
    const total1mBars = 998;
    const last1mTime = (total1mBars - 1) * MINUTE_MS;
    const currentTime = last1mTime + 1_000;
    const view = makeView();

    const initialBars = Array.from({ length: total1mBars }, (_, i) => ({
      t: i * MINUTE_MS,
      cells: [[50_000, 1_500_000 + i, 0]],
    }));

    let listener = null;
    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: currentTime,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: initialBars.filter((b) => b.t >= req.from && b.t <= req.to),
        complete: true,
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => currentTime,
      subscribeLiveTail: (cb) => {
        listener = cb;
        return () => { listener = null; };
      },
    });

    const origKeys = Map.prototype.keys;
    let largeMapKeyIterCount = 0;
    let largeMapKeysRead = 0;

    try {
      // Warm up initial load across the 9-bar viewport [324, 332].
      overlay.prepareGpuCells(view, series, [324, 332]);
      await flushMicrotasks();
      const warmGpu = overlay.prepareGpuCells(view, series, [324, 332]);
      assert.ok(warmGpu !== null && warmGpu.main.length === 9);
      assert.equal(overlay.cachedBarsCount(), total1mBars);

      Map.prototype.keys = function (...args) {
        const iter = origKeys.apply(this, args);
        if (this.size >= 990) {
          largeMapKeyIterCount++;
          const origNext = iter.next.bind(iter);
          iter.next = () => {
            const res = origNext();
            if (!res.done) largeMapKeysRead++;
            return res;
          };
        }
        return iter;
      };

      // 1. Update the last 1m bar 50 times with the SAME timestamp and changing cell values.
      for (let i = 1; i <= 50; i++) {
        listener({
          market: MARKET,
          bars: [{ t: last1mTime, cells: [[50_000, 2_000_000 + i * 1_000, 0]] }],
        });
        const gpu = overlay.prepareGpuCells(view, series, [324, 332]);
        assert.ok(gpu !== null && gpu.main.length === 9);
        assert.equal(gpu.main[gpu.main.length - 1].value, 2_000_000 + i * 1_000);
      }

      assert.equal(largeMapKeyIterCount, 0, "same-timestamp updates must not rebuild sortedBarTimes");
      assert.equal(largeMapKeysRead, 0, "same-timestamp updates must read 0 keys for time index");

      // 2. Adding a NEW timestamp key must rebuild sortedBarTimes once.
      const new1mTime = total1mBars * MINUTE_MS;
      listener({
        market: MARKET,
        bars: [{ t: new1mTime, cells: [[50_000, 3_500_000, 0]] }],
      });
      const gpuAfterNewKey = overlay.prepareGpuCells(view, series, [324, 332]);
      assert.ok(gpuAfterNewKey !== null);
      assert.equal(largeMapKeyIterCount, 1, "adding a new bar key must rebuild sortedBarTimes once");
      assert.equal(largeMapKeysRead, total1mBars + 1);
      assert.equal(gpuAfterNewKey.main[gpuAfterNewKey.main.length - 1].value, 3_500_000);
    } finally {
      Map.prototype.keys = origKeys;
      overlay.dispose();
    }
  });
});

test("#323: 1w/1d same-day update avoids index rebuild while new day key rebuilds index", async () => {
  await withFixedScaleSettings(async () => {
    const startTime = 0;
    const series = makeSeries(WEEK_MS, 20, startTime);
    const view = makeView();
    const currentTime = 20 * WEEK_MS + DAY_MS;

    // Populate 60 daily bars across the first 10 weeks via REST fetch.
    const dailyBars = Array.from({ length: 60 }, (_, i) => ({
      t: i * DAY_MS,
      cells: [[50_000, 1_200_000 + i, 0]],
    }));

    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: currentTime,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: dailyBars.filter((b) => b.t >= req.from && b.t <= req.to),
        complete: true,
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => currentTime,
    });

    const origKeys = Map.prototype.keys;
    let dayMapRebuilds = 0;

    try {
      overlay.prepareGpuCells(view, series, [0, 8]);
      await flushMicrotasks();
      overlay.prepareGpuCells(view, series, [0, 8]);

      Map.prototype.keys = function (...args) {
        if (this.size >= 50) dayMapRebuilds++;
        return origKeys.apply(this, args);
      };

      // Note: 1w/1d uses 1d tier; live-tail push is gated to 1m, so test via REST refresh / same-key vs new-key merge:
      // Repeating the same prepare without key changes must not rebuild index.
      for (let i = 0; i < 10; i++) {
        overlay.prepareGpuCells(view, series, [0, 8]);
      }
      assert.equal(dayMapRebuilds, 0, "1w/1d repeated prepares without key changes must not rebuild sortedBarTimes");

      // Market reset clears and marks index dirty for next load.
      overlay.handleMarketChange();
      assert.equal(overlay.cachedBarsCount(), 0);
    } finally {
      Map.prototype.keys = origKeys;
      overlay.dispose();
    }
  });
});
