import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HEATMAP_BUCKET_STEP_MULTIPLIER,
  DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
  ORDERBOOK_HEATMAP_STEPS,
  ORDERBOOK_HEATMAP_STEP_MULTIPLIERS,
  computeRelativeHeatmapBucketStep,
  isOrderbookHeatmapHistoryMarket,
  isOrderbookHeatmapMarket,
  shouldRecalculateRelativeBucketStep,
} from "../dist/core/orderbookHeatmap/settings.js";
import { rebucketHeatmapBars } from "../dist/features/orderbook/heatmapModel.js";
import {
  OrderbookHeatmapOverlay,
  getOrderbookHeatmapBrowserSourceLabel,
} from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import { chartLocale, configureChartLocale, tOr } from "../dist/core/chartLocale.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";

function makeTestView(width = 800) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height: 400 };
  view.colWidth = 10;
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
  roundRect() {},
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  font: "",
  textAlign: "",
  textBaseline: "",
};

async function withHeatmapSettingsSource(settingsFor, work) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor,
    onChange: () => () => {},
  });
  try {
    return await work();
  } finally {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
}

async function withLocale(localeTag, work) {
  let prevLocale = null;
  try { prevLocale = chartLocale(); } catch {}
  configureChartLocale({
    locale: () => localeTag,
    timeZone: () => "UTC",
    translate: (key) => key,
    onLocaleChange: () => () => {},
  });
  try {
    return await work();
  } finally {
    if (prevLocale) configureChartLocale(prevLocale);
  }
}

test("BTC heatmap steps [25, 50, 100, 250] and default 25 remain unchanged", () => {
  assert.deepEqual(ORDERBOOK_HEATMAP_STEPS, [25, 50, 100, 250]);
  assert.deepEqual(ORDERBOOK_HEATMAP_STEP_MULTIPLIERS, [1, 2, 4, 10]);
  assert.equal(DEFAULT_ORDERBOOK_HEATMAP_SETTINGS.bucketStep, 25);
  assert.equal(DEFAULT_ORDERBOOK_HEATMAP_SETTINGS.bucketStepMultiplier, 1);
  assert.equal(DEFAULT_HEATMAP_BUCKET_STEP_MULTIPLIER, 1);
  assert.equal(isOrderbookHeatmapHistoryMarket("BINANCE_FUTURES:btcusdt"), true);
  assert.equal(isOrderbookHeatmapHistoryMarket("BINANCE_FUTURES:ethusdt"), false);
  assert.equal(isOrderbookHeatmapMarket("BINANCE_FUTURES:btcusdt"), true);
  assert.equal(isOrderbookHeatmapMarket("BINANCE_FUTURES:ethusdt"), true);
  assert.equal(isOrderbookHeatmapMarket("invalid"), false);
});

test("computeRelativeHeatmapBucketStep computes priceStep multiples without floating-point drift", () => {
  // ETH ~$3000 with priceStep 0.1 and default pct 0.0002 -> 0.6
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 3000, priceStep: 0.1 }), 0.6);
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 3000, priceStep: 0.1, multiplier: 2 }), 1.2);
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 3000, priceStep: 0.1, multiplier: 4 }), 2.4);
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 3000, priceStep: 0.1, multiplier: 10 }), 6);

  // Tiny altcoin $0.0001 with priceStep 0.000001 -> raw 2e-8 clamps to >= priceStep (1e-6)
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 0.0001, priceStep: 0.000001 }), 0.000001);

  // Tiny altcoin $0.0001 with priceStep 1e-8 -> exact 2e-8, 4e-8, 2e-7 without float drift
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 0.0001, priceStep: 1e-8, multiplier: 1 }), 2e-8);
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 0.0001, priceStep: 1e-8, multiplier: 2 }), 4e-8);
  assert.equal(computeRelativeHeatmapBucketStep({ lastPrice: 0.0001, priceStep: 1e-8, multiplier: 10 }), 2e-7);

  // 0.1 * 3 drift check: lastPrice = 1500, priceStep = 0.1 -> raw 0.3 -> exact 0.3
  const step03 = computeRelativeHeatmapBucketStep({ lastPrice: 1500, priceStep: 0.1 });
  assert.equal(step03, 0.3);
  assert.equal(String(step03), "0.3");
});

test("non-BTC overlay accepts live tail without REST history fetch and exposes localized browser badge", async () => {
  await withLocale("tr-TR", async () => {
    assert.equal(tOr("orderbook.heatmap.browserLiveSource"), "uygulama açıldığından beri");
    assert.equal(getOrderbookHeatmapBrowserSourceLabel(), "uygulama açıldığından beri");
  });

  await withLocale("en-US", async () => {
    assert.equal(tOr("orderbook.heatmap.browserLiveSource"), "since app opened");
    assert.equal(getOrderbookHeatmapBrowserSourceLabel(), "since app opened");

    let fetchCount = 0;
    const subscribedRequests = [];
    const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 0.1 });
    series.loadBars([{
      startTime: 60_000,
      open: 3000,
      high: 3005,
      low: 2995,
      close: 3000,
      volume: 10,
      delta: 0,
      count: 1,
      cells: new Map(),
      hasRef: true,
    }]);

    await withHeatmapSettingsSource(() => ({
      mode: "single",
      unit: "usd",
      bucketStep: 0.6,
      bucketStepMultiplier: 1,
      single: { usd: 1_000, btc: 1 },
      aggregated: { usd: 1_000, btc: 1 },
    }), async () => {
      const overlay = new OrderbookHeatmapOverlay({
        fetch: async () => {
          fetchCount++;
          throw new Error("REST fetch must not be called for non-BTC market");
        },
        invalidate: () => {},
        getMarket: () => "BINANCE_FUTURES:ethusdt",
        subscribeLiveTail: (_listener, request) => {
          subscribedRequests.push(request);
          return () => {};
        },
      });

      try {
        const view = makeTestView();
        overlay.draw(mockCtx, view, series, [0, 0]);
        assert.equal(fetchCount, 0);
        assert.equal(subscribedRequests.length, 1);
        assert.equal(subscribedRequests[0].bucketStep, 0.6);

        overlay.applyLiveTailBars([{ t: 60_000, cells: [[3000, 50_000, 50_000]] }]);
        assert.equal(overlay.cachedBarsCount(), 1);
        assert.equal(fetchCount, 0);

        // Hover on non-BTC also must not trigger REST fetch
        overlay.drawHover(mockCtx, view, series, { visible: true, x: 100, y: 200 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(fetchCount, 0);

        const status = overlay.getStatus();
        assert.equal(status.state, "ready");
        assert.equal(status.hasBars, true);
        assert.equal(status.sourceKind, "browser");
        assert.equal(status.sourceLabel, "since app opened");
      } finally {
        overlay.dispose();
      }
    });
  });
});

test("re-buckets live tail buffer cleanly when price moves >= +-20% and relative bucketStep recalculates", async () => {
  assert.equal(shouldRecalculateRelativeBucketStep(100, 119), false);
  assert.equal(shouldRecalculateRelativeBucketStep(100, 120), true);
  assert.equal(shouldRecalculateRelativeBucketStep(100, 80), true);

  const rebucketed = rebucketHeatmapBars(
    [{ t: 60_000, cells: [[0.000100, 500, 0], [0.000101, 0, 700], [0.000102, 300, 200]] }],
    0.000002,
  );
  assert.deepEqual(rebucketed, [
    { t: 60_000, cells: [[0.000100, 500, 700], [0.000102, 300, 200]] },
  ]);

  let currentPrice = 3000;
  let currentStep = 0.6;
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 0.1 });
  series.loadBars([{
    startTime: 60_000,
    open: 3000,
    high: 3010,
    low: 2990,
    close: 3000,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  }]);

  await withHeatmapSettingsSource(() => ({
    mode: "single",
    unit: "usd",
    bucketStep: 0,
    bucketStepMultiplier: 1,
    single: { usd: 100, btc: 1 },
    aggregated: { usd: 100, btc: 1 },
  }), async () => {
    const overlay = new OrderbookHeatmapOverlay({
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:ethusdt",
    });
    try {
      const view = makeTestView();
      overlay.draw(mockCtx, view, series, [0, 0]);
      overlay.applyLiveTailBars([{
        t: 60_000,
        cells: [[2999.4, 1_000, 0], [3000.0, 2_000, 500], [3000.6, 0, 1_500]],
      }]);
      assert.equal(overlay.cachedBarsCount(), 1);

      // Simulate +20% jump: 3000 -> 3600 (relative step recalculates from 0.6 to 0.72)
      currentPrice = 3600;
      currentStep = computeRelativeHeatmapBucketStep({ lastPrice: currentPrice, priceStep: 0.1 });
      assert.equal(currentStep, 0.7);
      series.loadBars([{
        startTime: 60_000,
        open: 3000,
        high: 3610,
        low: 2990,
        close: currentPrice,
        volume: 20,
        delta: 0,
        count: 2,
        cells: new Map(),
        hasRef: true,
      }]);
      overlay.draw(mockCtx, view, series, [0, 0]);
      // Browser-sourced live tail bars are preserved and re-bucketed instead of wiped
      assert.equal(overlay.cachedBarsCount(), 1);
    } finally {
      overlay.dispose();
    }
  });
});

test("numeric bucketStep works in cache keys across fractional altcoin steps", async () => {
  let step = 0.000002;
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 0.000001 });
  series.loadBars([{
    startTime: 60_000,
    open: 0.0001,
    high: 0.00011,
    low: 0.00009,
    close: 0.0001,
    volume: 100,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  }]);

  await withHeatmapSettingsSource(() => ({
    mode: "single",
    unit: "usd",
    bucketStep: step,
    single: { usd: 100, btc: 1 },
    aggregated: { usd: 100, btc: 1 },
  }), async () => {
    const subKeys = [];
    const overlay = new OrderbookHeatmapOverlay({
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:pepeusdt",
      subscribeLiveTail: (_listener, req) => {
        subKeys.push(req?.bucketStep);
        return () => {};
      },
    });
    try {
      const view = makeTestView();
      overlay.draw(mockCtx, view, series, [0, 0]);
      overlay.applyLiveTailBars([{ t: 60_000, cells: [[0.0001, 500, 500]] }]);
      assert.deepEqual(subKeys, [0.000002]);

      step = 0.000004;
      overlay.draw(mockCtx, view, series, [0, 0]);
      assert.equal(overlay.cachedBarsCount(), 1);
      assert.deepEqual(subKeys, [0.000002, 0.000004]);
    } finally {
      overlay.dispose();
    }
  });
});
