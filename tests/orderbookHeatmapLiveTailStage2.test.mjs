import test, { mock } from "node:test";
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
  view.colWidth = 10;
  view.priceTop = 50_500;
  view.pricePerPx = 5;
  return view;
}

const mockCtx = {
  save() {},
  restore() {},
  beginPath() {},
  rect() {},
  clip() {},
  fillRect() {},
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

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function withSettings(getSettings, run) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  const listeners = new Set();
  configureOrderbookHeatmapSettingsSource({
    settingsFor: getSettings,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const notifyChange = () => {
    for (const listener of [...listeners]) listener();
  };
  try {
    return await run(notifyChange);
  } finally {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
}

function makeSeries(intervalMs, count, startTime = 1_000 * MINUTE_MS) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(Array.from({ length: count }, (_, i) => ({
    startTime: startTime + i * intervalMs,
    open: 50_000,
    high: 50_200,
    low: 49_800,
    close: 50_100,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  })));
  return series;
}

const grant = () => ({ release() {} });

test("1m WS live-tail pushes for 5 minutes (1/sec) trigger 0 live-chunk REST fetches", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let overlay;
  try {
    await withSettings(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1_000_000, btc: 10 },
      aggregated: { usd: 5_000_000, btc: 50 },
    }), async () => {
      const startTime = 1_000 * MINUTE_MS;
      const barCount = 5;
      const series = makeSeries(MINUTE_MS, barCount, startTime);
      const liveBarTime = startTime + (barCount - 1) * MINUTE_MS;
      let currentTime = liveBarTime + 500;

      const requests = [];
      let listener = null;
      let capturedRequest = null;
      let invalidations = 0;

      overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => {
          requests.push(req);
          return {
            schemaVersion: 1,
            generatedAt: currentTime,
            base: "BTC",
            source: req.source,
            resolution: req.resolution,
            bucketStep: req.bucketStep,
            from: req.from,
            to: req.to,
            bars: [{ t: liveBarTime, cells: [[50_000, 1_000_000, 1_000_000]] }],
          };
        },
        invalidate: () => { invalidations++; },
        getMarket: () => MARKET,
        now: () => currentTime,
        subscribeLiveTail: (cb, req) => {
          listener = cb;
          capturedRequest = req;
          return () => {};
        },
      });

      assert.deepEqual(capturedRequest, {
        market: MARKET,
        base: "BTC",
        bucketStep: 50,
        minQuantityUsd: 1_000_000,
      });

      const view = makeView();
      overlay.draw(mockCtx, view, series, [0, barCount - 1]);
      await flushMicrotasks();
      assert.equal(requests.length, 1, "initial historical/live chunk loads once via REST");

      // Clear request counter: now stream 1 push per second for 5 full minutes
      requests.length = 0;
      const pushStartInvalidations = invalidations;

      for (let sec = 1; sec <= 300; sec++) {
        currentTime += 1_000;
        mock.timers.tick(1_000);
        listener({
          market: MARKET,
          timestamp: currentTime,
          bars: [{ t: liveBarTime, cells: [[50_000, 2_000_000 + sec * 1_000, 1_000_000]] }],
        });
        overlay.draw(mockCtx, view, series, [0, barCount - 1]);
        await flushMicrotasks();
      }

      assert.equal(requests.length, 0, "0 live chunk REST fetches across 5 minutes of healthy 1s WS pushes");
      assert.equal(overlay.isLiveTailHealthyForTest(), true);
      assert.equal(invalidations - pushStartInvalidations, 300);

      const frame = overlay.prepareGpuCells(view, series, [0, barCount - 1], grant);
      assert.ok(frame);
      assert.equal(frame.main.at(-1)?.value, 3_300_000);
    });
  } finally {
    overlay?.dispose();
    mock.timers.reset();
  }
});

test("falls back to REST refresh after 90s idle timeout when 1m live-tail pushes stop", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let overlay;
  try {
    await withSettings(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1_000_000, btc: 10 },
      aggregated: { usd: 5_000_000, btc: 50 },
    }), async () => {
      const startTime = 1_000 * MINUTE_MS;
      const series = makeSeries(MINUTE_MS, 5, startTime);
      const liveBarTime = startTime + 4 * MINUTE_MS;
      let currentTime = liveBarTime + 1_000;

      const requests = [];
      let listener = null;
      let invalidations = 0;

      overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => {
          requests.push(req);
          return {
            schemaVersion: 1,
            generatedAt: currentTime,
            base: "BTC",
            source: req.source,
            resolution: req.resolution,
            bucketStep: req.bucketStep,
            from: req.from,
            to: req.to,
            bars: [{ t: liveBarTime, cells: [[50_000, 1_500_000, 1_500_000]] }],
          };
        },
        invalidate: () => { invalidations++; },
        getMarket: () => MARKET,
        now: () => currentTime,
        subscribeLiveTail: (cb) => {
          listener = cb;
          return () => {};
        },
      });

      const view = makeView();
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(requests.length, 1);
      requests.length = 0;

      listener({ market: MARKET, timestamp: currentTime, bars: [{ t: liveBarTime, cells: [[50_000, 2_000_000, 2_000_000]] }] });
      assert.equal(overlay.isLiveTailHealthyForTest(), true);

      // Advance 89s (< 90s): live timer stays suppressed and REST remains silent
      const invBeforeIdle = invalidations;
      currentTime += 89_000;
      mock.timers.tick(89_000);
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(overlay.isLiveTailHealthyForTest(), true);
      assert.equal(requests.length, 0);
      assert.equal(invalidations, invBeforeIdle);

      // Cross 90s idle fallback: liveTimer invalidates and next draw triggers REST tail fallback
      currentTime += 1_000;
      assert.equal(overlay.isLiveTailHealthyForTest(), false);
      mock.timers.tick(5_000);
      currentTime += 5_000;
      assert.ok(invalidations > invBeforeIdle, "liveTimer resumes invalidations after 90s idle");
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(requests.length, 1, "REST fallback triggers after 90s idle");
    });
  } finally {
    overlay?.dispose();
    mock.timers.reset();
  }
});

test("coarse tiers (>= 5m) reject 1m WS tail bars without polluting cache and retain REST refresh", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let overlay;
  try {
    await withSettings(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1_000_000, btc: 10 },
      aggregated: { usd: 5_000_000, btc: 50 },
    }), async () => {
      const fiveMin = 5 * MINUTE_MS;
      const startTime = 1_000 * fiveMin;
      const series = makeSeries(fiveMin, 4, startTime);
      const lastFiveMinStart = startTime + 3 * fiveMin;
      let currentTime = lastFiveMinStart + MINUTE_MS;

      const requests = [];
      let listener = null;
      let invalidations = 0;

      overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => {
          requests.push(req);
          return {
            schemaVersion: 1,
            generatedAt: currentTime,
            base: "BTC",
            source: req.source,
            resolution: req.resolution,
            bucketStep: req.bucketStep,
            from: req.from,
            to: req.to,
            bars: [{ t: lastFiveMinStart, cells: [[50_000, 1_200_000, 800_000]] }],
          };
        },
        invalidate: () => { invalidations++; },
        getMarket: () => MARKET,
        now: () => currentTime,
        subscribeLiveTail: (cb) => {
          listener = cb;
          return () => {};
        },
      });

      const view = makeView();
      overlay.draw(mockCtx, view, series, [0, 3]);
      await flushMicrotasks();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].resolution, "5m");
      assert.equal(overlay.cachedBarsCount(), 1);

      const invBeforePush = invalidations;
      // Push 1m tail bars including both a colliding boundary timestamp and intermediate 1m timestamps
      listener({
        market: MARKET,
        timestamp: currentTime,
        bars: [
          { t: lastFiveMinStart, cells: [[50_100, 99_000_000, 0]] },
          { t: lastFiveMinStart + MINUTE_MS, cells: [[50_150, 88_000_000, 0]] },
        ],
      });

      assert.equal(invalidations, invBeforePush, "1m bars push must not invalidate or merge on 5m tier");
      assert.equal(overlay.cachedBarsCount(), 1, "intermediate 1m bar must not enter coarse-tier bars cache");
      assert.equal(overlay.isLiveTailHealthyForTest(), false, "5m tier keeps REST live polling active");

      const frame = overlay.prepareGpuCells(view, series, [0, 3], grant);
      assert.ok(frame);
      assert.equal(frame.main.length, 1, "5m bar cells remain intact without 1m wall");
      assert.equal(frame.extension.length, 0, "right extension is disabled (#280)");
      assert.equal(frame.main[0].value, 2_000_000);

      // Advance past LIVE_REFRESH_MS (20s): 5m REST refresh still runs cleanly
      currentTime += 25_000;
      mock.timers.tick(25_000);
      overlay.draw(mockCtx, view, series, [0, 3]);
      await flushMicrotasks();
      assert.equal(requests.length, 2);
      assert.equal(requests[1].resolution, "5m");
    });
  } finally {
    overlay?.dispose();
    mock.timers.reset();
  }
});

test("re-subscribes on settings/market changes, filters stale events, and triggers full refetch when minQuantityUsd lowers", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let overlay;
  try {
    let currentSettings = {
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 20_000_000, btc: 200 },
      aggregated: { usd: 50_000_000, btc: 500 },
    };
    let currentMarket = MARKET;

    await withSettings(() => currentSettings, async (notifyChange) => {
      const startTime = 1_000 * MINUTE_MS;
      const series = makeSeries(MINUTE_MS, 5, startTime);
      const liveBarTime = startTime + 4 * MINUTE_MS;
      let currentTime = liveBarTime + 1_000;

      const requests = [];
      const subscriptions = [];
      let invalidations = 0;

      overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => {
          requests.push(req);
          return {
            schemaVersion: 1,
            generatedAt: currentTime,
            base: "BTC",
            source: req.source,
            resolution: req.resolution,
            bucketStep: req.bucketStep,
            from: req.from,
            to: req.to,
            bars: [{ t: liveBarTime, cells: [[50_000, 15_000_000, 15_000_000]] }],
          };
        },
        invalidate: () => { invalidations++; },
        getMarket: () => currentMarket,
        now: () => currentTime,
        subscribeLiveTail: (listener, request) => {
          const entry = { listener, request, unsubscribed: false };
          subscriptions.push(entry);
          return () => { entry.unsubscribed = true; };
        },
      });

      assert.equal(subscriptions.length, 1);
      assert.deepEqual(subscriptions[0].request, {
        market: MARKET,
        base: "BTC",
        bucketStep: 50,
        minQuantityUsd: 20_000_000,
      });

      const view = makeView();
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(requests.length, 1);
      subscriptions[0].listener({ market: MARKET, bars: [{ t: liveBarTime, cells: [[50_000, 25_000_000, 0]] }] });
      assert.equal(overlay.isLiveTailHealthyForTest(), true);

      // Lower minQuantityUsd: must unsubscribe old, re-subscribe with lower threshold, reset healthy state, and full-refetch
      currentSettings = {
        ...currentSettings,
        single: { usd: 10_000_000, btc: 200 },
      };
      notifyChange();

      assert.equal(subscriptions[0].unsubscribed, true);
      assert.equal(subscriptions.length, 2);
      assert.deepEqual(subscriptions[1].request, {
        market: MARKET,
        base: "BTC",
        bucketStep: 50,
        minQuantityUsd: 10_000_000,
      });
      assert.equal(overlay.isLiveTailHealthyForTest(), false);

      // Late event arriving on closed subscription[0] must be ignored
      const invBeforeStale = invalidations;
      subscriptions[0].listener({ market: MARKET, bars: [{ t: liveBarTime, cells: [[50_000, 99_000_000, 0]] }] });
      assert.equal(invalidations, invBeforeStale, "stale listener events must be filtered out");
      assert.equal(overlay.isLiveTailHealthyForTest(), false);

      // Next draw triggers full chunk REST refetch with lower minUsd
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(requests.length, 2);
      assert.equal(requests[1].from, 1_000 * MINUTE_MS, "lowered threshold requires full chunk refetch");
      assert.equal(requests[1].minUsd, 10_000_000);

      // BucketStep change re-subscribes cleanly
      currentSettings = { ...currentSettings, bucketStep: 100 };
      notifyChange();
      assert.equal(subscriptions[1].unsubscribed, true);
      assert.equal(subscriptions.length, 3);
      assert.equal(subscriptions[2].request.bucketStep, 100);

      // Market switch cleans up previous subscription & cache and subscribes with new market/base
      currentMarket = "BINANCE_FUTURES:ethusdt";
      overlay.handleMarketChange();
      assert.equal(subscriptions[2].unsubscribed, true);
      assert.equal(subscriptions.length, 4);
      assert.deepEqual(subscriptions[3].request, {
        market: "BINANCE_FUTURES:ethusdt",
        base: "ETH",
        bucketStep: 100,
        minQuantityUsd: 10_000_000,
      });
      assert.equal(overlay.cachedBarsCount(), 0);

      // Cross-market event delivered to current listener is ignored
      const invBeforeWrongMarket = invalidations;
      subscriptions[3].listener({ market: MARKET, bars: [{ t: liveBarTime, cells: [[50_000, 20_000_000, 0]] }] });
      assert.equal(invalidations, invBeforeWrongMarket);

      overlay.dispose();
      assert.equal(subscriptions[3].unsubscribed, true);

      // Post-dispose event must be ignored
      subscriptions[3].listener({ market: "BINANCE_FUTURES:ethusdt", bars: [{ t: liveBarTime, cells: [[50_000, 20_000_000, 0]] }] });
      assert.equal(overlay.cachedBarsCount(), 0);
    });
  } finally {
    overlay?.dispose();
    mock.timers.reset();
  }
});

test("remains backward-compatible with legacy single-argument subscribeLiveTail(listener) health ping adapters", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let overlay;
  try {
    await withSettings(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1_000_000, btc: 10 },
      aggregated: { usd: 5_000_000, btc: 50 },
    }), async () => {
      const startTime = 1_000 * MINUTE_MS;
      const series = makeSeries(MINUTE_MS, 5, startTime);
      const liveBarTime = startTime + 4 * MINUTE_MS;
      let currentTime = liveBarTime + 1_000;

      const requests = [];
      let legacyListener = null;
      let unsubscribed = false;

      // Single-argument adapter ignoring the second request argument and emitting health pings without bars
      const legacySubscribeLiveTail = (listener) => {
        assert.equal(typeof listener, "function");
        legacyListener = listener;
        return () => { unsubscribed = true; };
      };

      overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => {
          requests.push(req);
          return {
            schemaVersion: 1,
            generatedAt: currentTime,
            base: "BTC",
            source: req.source,
            resolution: req.resolution,
            bucketStep: req.bucketStep,
            from: req.from,
            to: req.to,
            bars: [{ t: liveBarTime, cells: [[50_000, 2_000_000, 1_000_000]] }],
          };
        },
        invalidate: () => {},
        getMarket: () => MARKET,
        now: () => currentTime,
        liveDebounceMs: 100,
        subscribeLiveTail: legacySubscribeLiveTail,
      });

      const view = makeView();
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(requests.length, 1);
      requests.length = 0;

      // Stage 1 health ping (no bars): debounces and refreshes live tail via REST
      legacyListener({ timestamp: currentTime });
      assert.equal(overlay.isLiveTailHealthyForTest(), true);
      mock.timers.tick(100);
      await flushMicrotasks();
      assert.equal(requests.length, 1, "health-only ping still refreshes live tail via REST");

      overlay.dispose();
      assert.equal(unsubscribed, true);
    });
  } finally {
    overlay?.dispose();
    mock.timers.reset();
  }
});
