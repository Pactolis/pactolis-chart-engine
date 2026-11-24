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

function makeSeries(count, startTime) {
  const series = new FootprintSeries({ intervalMs: MINUTE_MS, priceStep: 1 });
  series.loadBars(Array.from({ length: count }, (_, i) => ({
    startTime: startTime + i * MINUTE_MS,
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

function makeMockCtx() {
  const rects = [];
  return {
    rects,
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, fillStyle: this.fillStyle });
    },
    strokeRect() {},
    fillText() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function withCustomSettings(run) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  const listeners = new Set();
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "custom",
      customSources: ["binance:usd_perp"],
      unit: "usd",
      bucketStep: 25,
      scaleMode: "fixed",
      fixedCeiling: { usd: 2_000_000, btc: 40 },
      single: { usd: 1_000_000, btc: 10 },
      aggregated: { usd: 5_000_000, btc: 50 },
    }),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  try {
    return await run();
  } finally {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
}

test("#317: custom 1m live canonical push before delayed REST history invalidates GPU/resident/cache keys and preserves live priority", async () => {
  await withCustomSettings(async () => {
    const startTime = 1_000 * MINUTE_MS;
    const series = makeSeries(3, startTime);
    const liveBarTime = startTime + 2 * MINUTE_MS;
    const currentTime = liveBarTime + 5_000;
    const view = makeView();

    let resolveRestFetch = null;
    let listener = null;
    let invalidations = 0;

    const overlay = new OrderbookHeatmapOverlay({
      fetch: () => new Promise((resolve) => {
        resolveRestFetch = resolve;
      }),
      invalidate: () => { invalidations++; },
      getMarket: () => MARKET,
      now: () => currentTime,
      subscribeLiveTail: (cb) => {
        listener = cb;
        return () => { listener = null; };
      },
    });

    try {
      // Trigger initial REST history fetch while leaving it pending.
      const initialKey = overlay.getPrepareCacheKey(view, series, [0, 2]);
      assert.ok(initialKey !== null);
      assert.ok(resolveRestFetch !== null, "REST fetch should be pending");

      // Send live canonical bar for the last candle before REST responds.
      listener({
        market: MARKET,
        canonicalBars: [{
          t: liveBarTime,
          sources: ["binance:usd_perp"],
          cells: [[50_025, 0, 600_000, 0]],
        }],
      });

      const keyAfterLive = overlay.getPrepareCacheKey(view, series, [0, 2]);
      assert.notEqual(keyAfterLive, initialKey);
      const gpuBeforeRest = overlay.prepareGpuCells(view, series, [0, 2]);
      assert.equal(gpuBeforeRest.main.length, 1);

      const residentBeforeRest = overlay.prepareResidentGpuScene(view, series, [0, 2]);
      assert.ok(residentBeforeRest !== null);
      assert.equal(residentBeforeRest.readBarCells(0).length, 0);
      assert.equal(residentBeforeRest.readBarCells(2).length, 1);

      const ctxBeforeRest = makeMockCtx();
      overlay.draw(ctxBeforeRest, view, series, [0, 2]);
      assert.equal(ctxBeforeRest.rects.length, 1);

      const invalidationsBeforeRest = invalidations;

      // Delayed REST returns historical bar 0 (800k USD at 50_000) AND an older/different value for live bar 2.
      resolveRestFetch({
        schemaVersion: 1,
        generatedAt: currentTime,
        base: "BTC",
        source: "custom",
        resolution: "1m",
        bucketStep: 25,
        from: startTime,
        to: liveBarTime,
        bars: [
          { t: startTime, cells: [[50_000, 800_000, 0]] },
          { t: liveBarTime, cells: [[50_025, 100_000, 0]] },
        ],
        complete: true,
      });
      await flushMicrotasks();

      assert.ok(invalidations > invalidationsBeforeRest, "overlay must invalidate after delayed REST merges history");

      // Warm cache key must change so stale GPU/raster/resident caches are invalidated.
      const keyAfterRest = overlay.getPrepareCacheKey(view, series, [0, 2]);
      assert.notEqual(keyAfterRest, keyAfterLive, "getPrepareCacheKey must change when historical REST bars arrive");

      const gpuAfterRestWarm = overlay.prepareGpuCells(view, series, [0, 2]);
      assert.equal(gpuAfterRestWarm.main.length, 2, "warm GPU prepare must include both historical and live bars");

      // Resident GPU scene must bump syncGeneration and expose historical bar 0 + live canonical bar 2 (600k, not REST 100k).
      const residentAfterRest = overlay.prepareResidentGpuScene(view, series, [0, 2]);
      assert.ok(residentAfterRest !== null);
      assert.ok(
        residentAfterRest.syncGeneration > residentBeforeRest.syncGeneration,
        "resident syncGeneration must bump when historical bar arrives",
      );
      const bar0Cells = residentAfterRest.readBarCells(0);
      const bar2Cells = residentAfterRest.readBarCells(2);
      assert.equal(bar0Cells.length, 1);
      assert.equal(bar0Cells[0].value, 800_000);
      assert.equal(bar2Cells.length, 1);
      assert.equal(bar2Cells[0].value, 600_000, "live canonical source must take priority over overlapping REST bar");

      const ctxAfterRest = makeMockCtx();
      overlay.draw(ctxAfterRest, view, series, [0, 2]);
      assert.equal(ctxAfterRest.rects.length, 2, "draw must render both historical and live bars");

      // Cold vs warm parity check after resetting only by market change is unnecessary; verify repeating identical canonical bar does not churn key.
      listener({
        market: MARKET,
        canonicalBars: [{
          t: liveBarTime,
          sources: ["binance:usd_perp"],
          cells: [[50_025, 0, 600_000, 0]],
        }],
      });
      const keyAfterIdenticalLive = overlay.getPrepareCacheKey(view, series, [0, 2]);
      assert.equal(keyAfterIdenticalLive, keyAfterRest, "identical canonical push must not churn prepare cache key");
    } finally {
      overlay.dispose();
    }
  });
});

test("#317: REST before live canonical arrival produces identical warm output", async () => {
  await withCustomSettings(async () => {
    const startTime = 1_000 * MINUTE_MS;
    const series = makeSeries(3, startTime);
    const liveBarTime = startTime + 2 * MINUTE_MS;
    const currentTime = liveBarTime + 5_000;
    const view = makeView();

    let listener = null;
    const overlay = new OrderbookHeatmapOverlay({
      fetch: async () => ({
        schemaVersion: 1,
        generatedAt: currentTime,
        base: "BTC",
        source: "custom",
        resolution: "1m",
        bucketStep: 25,
        from: startTime,
        to: liveBarTime,
        bars: [
          { t: startTime, cells: [[50_000, 800_000, 0]] },
        ],
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

    try {
      overlay.getPrepareCacheKey(view, series, [0, 2]);
      await flushMicrotasks();

      listener({
        market: MARKET,
        canonicalBars: [{
          t: liveBarTime,
          sources: ["binance:usd_perp"],
          cells: [[50_025, 0, 600_000, 0]],
        }],
      });

      const gpu = overlay.prepareGpuCells(view, series, [0, 2]);
      assert.equal(gpu.main.length, 2);
      const resident = overlay.prepareResidentGpuScene(view, series, [0, 2]);
      assert.equal(resident.readBarCells(0)[0].value, 800_000);
      assert.equal(resident.readBarCells(2)[0].value, 600_000);
    } finally {
      overlay.dispose();
    }
  });
});
