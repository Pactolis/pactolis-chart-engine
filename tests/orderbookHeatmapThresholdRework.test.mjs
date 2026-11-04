import test from "node:test";
import assert from "node:assert/strict";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { configureOrderbookHeatmapSettingsSource } from "../dist/features/orderbook/heatmapSettingsSource.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";

const MINUTE = 60_000;

function setupSeries(length = 1) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(Array.from({ length }, (_, i) => ({
    startTime: i * MINUTE, open: 100, high: 105, low: 95, close: 102,
    volume: 10, delta: 0, count: 0, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 10;
  view.priceTop = 200;
  return { series, view };
}

function context() {
  const fills = [];
  return { fills, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillRect(...args) { fills.push(args); }, set fillStyle(_value) {} };
}

function response(req, bars) {
  return { schemaVersion: 1, generatedAt: 60 * MINUTE, base: "BTC", source: req.source,
    resolution: req.resolution, bucketStep: req.bucketStep, from: req.from, to: req.to, bars };
}

test("unit change keeps compatible USD-notional cells visible until replacement data arrives", async () => {
  let unit = "usd";
  let threshold = 10_000_000;
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({ mode: "single", unit, bucketStep: 50,
      single: { usd: threshold, btc: 100 }, aggregated: { usd: threshold, btc: 100 } }),
    onChange: () => () => {},
  });
  const { series, view } = setupSeries();
  let finishBtcRefresh;
  const requests = [];
  const overlay = new OrderbookHeatmapOverlay({
    fetch: (req) => {
      requests.push(req);
      if (requests.length === 1) {
        return Promise.resolve(response(req, [{ t: 0, cells: [[100, 15_000_000, 0]] }]));
      }
      return new Promise((resolve) => {
        finishBtcRefresh = () => resolve(response(req, [{ t: 0, cells: [[100, 20_000_000, 0]] }]));
      });
    }, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => 60 * MINUTE,
  });
  const ctx = context();
  overlay.draw(ctx, view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].minUsd, 10_000_000);
  ctx.fills.length = 0;

  unit = "btc";
  overlay.draw(ctx, view, series, [0, 0]);
  assert.equal(requests.length, 2, "unit change triggers replacement fetch with new unit");
  assert.equal(requests[1].minBtc, 100, "replacement fetch requests minBtc threshold");
  assert.equal(requests[1].from, 0, "replacement fetch re-fetches full chunk");
  assert.ok(ctx.fills.length > 0, "compatible USD-notional cache remains visible while replacement fetch is pending");
  assert.equal(overlay.chunkStatus(0), "loading");

  finishBtcRefresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(overlay.chunkStatus(0), "ready");

  ctx.fills.length = 0;
  overlay.draw(ctx, view, series, [0, 0]);
  assert.ok(ctx.fills.length > 0, "new replacement data is drawn");
  assert.equal(requests.length, 2, "no additional fetch on subsequent frames in same unit");

  overlay.dispose();
});

test("raising then lowering threshold uses full-chunk coverage after a live-tail partial refresh", async () => {
  let threshold = 20;
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({ mode: "single", unit: "usd", bucketStep: 50,
      single: { usd: threshold, btc: 1 }, aggregated: { usd: threshold, btc: 1 } }),
    onChange: () => () => {},
  });
  const { series, view } = setupSeries();
  let now = 60 * MINUTE;
  const requests = [];
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (req) => {
      requests.push(req);
      return response(req, [{ t: req.from, cells: [[100, 30, 0]] }]);
    }, invalidate: () => {}, getMarket: () => "BINANCE_FUTURES:btcusdt", now: () => now,
  });
  overlay.draw(context(), view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  threshold = 30;
  now += 21_000;
  overlay.draw(context(), view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(requests.length >= 2);
  assert.ok(requests.at(-1).from > 0, "live refresh should only cover the tail");
  threshold = 25;
  overlay.draw(context(), view, series, [0, 0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.filter((req) => req.from === 0).length, 1,
    "lowering to a threshold still covered by the full fetch must not refetch the whole chunk");
  overlay.dispose();
});
