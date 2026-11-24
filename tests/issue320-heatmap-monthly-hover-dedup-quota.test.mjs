import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";

const DAY_MS = 24 * 60 * 60_000;
const MONTH_MS = 30 * DAY_MS;
const MINUTE_MS = 60_000;
const MARKET_BTC = "BINANCE_FUTURES:btcusdt";
const MARKET_ETH = "BINANCE_FUTURES:ethusdt";

function makeView(colWidth = 40) {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = colWidth;
  view.offsetX = 0;
  view.priceTop = 50_500;
  view.pricePerPx = 5;
  return view;
}

function makeSeries(intervalMs, count, startTime = 0) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(Array.from({ length: count }, (_, i) => ({
    startTime: startTime + i * intervalMs,
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
  return series;
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
  roundRect() {},
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  font: "",
  textAlign: "",
  textBaseline: "",
};

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function withSettings(run) {
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

test("#320: monthly hover shares overlapping ranges, aborts unshared old requests, and leaves main history 2-request quota intact", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let overlay;
  try {
    await withSettings(async () => {
      const series = makeSeries(MONTH_MS, 40, 0);
      const view = makeView(40);
      const currentTime = 40 * MONTH_MS + DAY_MS;

      const hoverRequests = [];
      const historyRequests = [];
      const abortedHoverRequests = [];

      overlay = new OrderbookHeatmapOverlay({
        fetch: (req, signal) => new Promise((resolve, reject) => {
          const isHover = req.priceFrom !== undefined && req.priceTo !== undefined;
          const entry = { req, signal, resolve, reject };
          if (isHover) {
            hoverRequests.push(entry);
            signal?.addEventListener("abort", () => {
              abortedHoverRequests.push(entry);
              reject(new DOMException("Aborted", "AbortError"));
            });
          } else {
            historyRequests.push(entry);
          }
        }),
        invalidate: () => {},
        getMarket: () => MARKET_BTC,
        now: () => currentTime,
      });

      // Move cursor across 4 adjacent monthly bars (indices 4, 5, 6, 7), holding 145ms each (> 120ms debounce).
      for (const centerIdx of [4, 5, 6, 7]) {
        const x = centerIdx * view.colWidth + view.colWidth / 2;
        overlay.drawHover(mockCtx, view, series, { visible: true, x, y: 100 });
        mock.timers.tick(145);
        await flushMicrotasks();
      }

      // 4 adjacent 5-month windows cover 8 distinct months total (not 20 duplicate requests).
      assert.equal(hoverRequests.length, 8, `expected 8 deduplicated hover requests, got ${hoverRequests.length}`);
      // Windows [2..6], [3..7], [4..8], [5..9] -> months 2, 3, 4 are unshared as cursor advances and must be aborted.
      assert.equal(abortedHoverRequests.length, 3, "unshared older hover month requests must be aborted");

      // While hover requests are still pending, main history must immediately start using its own 2-request quota.
      overlay.getPrepareCacheKey(view, series, [0, 39]);
      await flushMicrotasks();
      assert.equal(
        historyRequests.length,
        2,
        `main history must start 2 requests immediately despite pending hover requests (got ${historyRequests.length})`,
      );

      // Resolve remaining hover requests and verify hover table renders values cleanly.
      for (const entry of hoverRequests) {
        if (entry.signal?.aborted) continue;
        entry.resolve({
          schemaVersion: 1,
          generatedAt: currentTime,
          base: "BTC",
          source: entry.req.source,
          resolution: entry.req.resolution,
          bucketStep: entry.req.bucketStep,
          from: entry.req.from,
          to: entry.req.to,
          bars: [{ t: entry.req.from, cells: [[50_000, 2_500_000, 0]] }],
          complete: true,
        });
      }
      await flushMicrotasks();

      // Resolve main history requests too.
      for (const entry of historyRequests) {
        entry.resolve({
          schemaVersion: 1,
          generatedAt: currentTime,
          base: "BTC",
          source: entry.req.source,
          resolution: entry.req.resolution,
          bucketStep: entry.req.bucketStep,
          from: entry.req.from,
          to: entry.req.to,
          bars: [],
          complete: true,
        });
      }
      await flushMicrotasks();
    });
  } finally {
    overlay?.dispose();
    mock.timers.reset();
  }
});

test("#320: market switch aborts pending hover requests and ignores stale responses; 1m hover uses single range", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let overlay;
  try {
    await withSettings(async () => {
      let market = MARKET_BTC;
      const series1m = makeSeries(MINUTE_MS, 20, 1_000 * MINUTE_MS);
      const view = makeView(20);
      const currentTime = 1_025 * MINUTE_MS;

      const hoverRequests = [];
      let abortedCount = 0;

      overlay = new OrderbookHeatmapOverlay({
        fetch: (req, signal) => new Promise((resolve, reject) => {
          if (req.priceFrom !== undefined) {
            const entry = { req, signal, resolve, reject };
            hoverRequests.push(entry);
            signal?.addEventListener("abort", () => {
              abortedCount++;
              reject(new DOMException("Aborted", "AbortError"));
            });
          } else {
            resolve({
              schemaVersion: 1,
              generatedAt: currentTime,
              base: "BTC",
              source: req.source,
              resolution: req.resolution,
              bucketStep: req.bucketStep,
              from: req.from,
              to: req.to,
              bars: [],
              complete: true,
            });
          }
        }),
        invalidate: () => {},
        getMarket: () => market,
        now: () => currentTime,
      });

      const x = 10 * view.colWidth + 5;
      overlay.drawHover(mockCtx, view, series1m, { visible: true, x, y: 100 });
      mock.timers.tick(130);
      await flushMicrotasks();

      assert.equal(hoverRequests.length, 1, "1m hover should coalesce into a single range request");

      // Switch market before slow hover responds.
      market = MARKET_ETH;
      overlay.handleMarketChange();
      assert.equal(abortedCount, 1, "market switch must abort pending hover request");

      // Stale response resolving after market switch must not throw or corrupt new market state.
      hoverRequests[0].resolve({
        schemaVersion: 1,
        generatedAt: currentTime,
        base: "BTC",
        source: "single",
        resolution: "1m",
        bucketStep: 25,
        from: hoverRequests[0].req.from,
        to: hoverRequests[0].req.to,
        bars: [{ t: 1_010 * MINUTE_MS, cells: [[50_000, 9_999_999, 0]] }],
        complete: true,
      });
      await flushMicrotasks();
      assert.equal(overlay.cachedBarsCount(), 0);
    });
  } finally {
    overlay?.dispose();
    mock.timers.reset();
  }
});
