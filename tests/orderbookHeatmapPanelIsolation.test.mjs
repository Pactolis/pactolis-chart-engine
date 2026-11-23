import test from "node:test";
import assert from "node:assert/strict";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import { DEFAULT_ORDERBOOK_HEATMAP_SETTINGS } from "../dist/core/orderbookHeatmap/settings.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";

const MINUTE = 60_000;
const MARKET = "BINANCE_FUTURES:btcusdt";

function makeTestView(width = 800) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height: 400 };
  view.colWidth = 10;
  view.priceTop = 102_000;
  view.pricePerPx = 20;
  return view;
}

function makeSeries(startTime, count = 5) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 25 });
  series.loadBars(Array.from({ length: count }, (_, i) => ({
    startTime: startTime + i * MINUTE,
    open: 100_000,
    high: 100_500,
    low: 99_500,
    close: 100_200,
    volume: 100,
    delta: 0,
    count: 0,
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
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  font: "",
  textAlign: "",
  textBaseline: "",
};

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

async function withPanelSettingsSource(initialModes, work) {
  let prevSource = null;
  try { prevSource = orderbookHeatmapSettingsSource(); } catch {}
  const modes = new Map(Object.entries(initialModes));
  const listeners = new Set();
  const baseSettings = {
    ...DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
    bucketStep: 50,
    single: { usd: 10_000_000, btc: 100 },
    aggregated: { usd: 20_000_000, btc: 200 },
    custom: { usd: 10_000_000, btc: 100 },
    customSources: ["binance:usd_perp", "bybit:spot"],
  };
  configureOrderbookHeatmapSettingsSource({
    settingsFor(_market, panelId) {
      const mode = (panelId ? modes.get(panelId) : undefined) ?? "off";
      return { ...baseSettings, mode };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const setMode = (panelId, mode) => {
    modes.set(panelId, mode);
    for (const listener of [...listeners]) listener();
  };
  try {
    return await work({ setMode });
  } finally {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
}

test("SCENARIO-CE-HEATMAP-PANEL-ISOLATION: panels sharing a market isolate mode, fetches, live-tail subscriptions, and raster cache", async () => {
  await withPanelSettingsSource({ "panel-a": "off", "panel-b": "off" }, async ({ setMode }) => {
    const startTime = 1_699_999_980_000;
    const series = makeSeries(startTime, 5);
    const view = makeTestView();
    const fetches = [];
    const subscriptions = [];
    let invalidationsA = 0;
    let invalidationsB = 0;

    const makeOverlay = (panelId, onInvalidate) => new OrderbookHeatmapOverlay({
      fetch: async (req) => {
        fetches.push({ panelId, req });
        return {
          schemaVersion: 1,
          generatedAt: startTime + 4 * MINUTE,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: [{ t: startTime + 4 * MINUTE, cells: [[100_000, 15_000_000, 0]] }],
        };
      },
      invalidate: onInvalidate,
      getMarket: () => MARKET,
      getPanelId: () => panelId,
      now: () => startTime + 4 * MINUTE + 1_000,
      subscribeLiveTail: (_listener, request) => {
        const entry = { panelId, request, unsubscribed: false };
        subscriptions.push(entry);
        return () => { entry.unsubscribed = true; };
      },
    });

    const overlayA = makeOverlay("panel-a", () => { invalidationsA++; });
    const overlayB = makeOverlay("panel-b", () => { invalidationsB++; });

    try {
      // Both off: zero subscriptions, zero fetches, zero raster bytes.
      overlayA.draw(mockCtx, view, series, [0, 4]);
      overlayB.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(subscriptions.length, 0);
      assert.equal(fetches.length, 0);
      assert.equal(overlayA.reservedRasterBytes(), 0);
      assert.equal(overlayB.reservedRasterBytes(), 0);

      // Enable panel-a only: panel-b remains off and inactive.
      setMode("panel-a", "single");
      assert.equal(subscriptions.length, 1);
      assert.equal(subscriptions[0].panelId, "panel-a");
      assert.equal(subscriptions[0].request?.panelId, "panel-a");
      assert.equal(invalidationsA, 1);
      assert.equal(invalidationsB, 0);

      overlayA.draw(mockCtx, view, series, [0, 4]);
      overlayB.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(fetches.length, 1);
      assert.equal(fetches[0].panelId, "panel-a");
      assert.equal(fetches[0].req.source, "single");
      assert.equal(overlayB.cachedBarsCount(), 0);
      assert.equal(overlayB.reservedRasterBytes(), 0);

      // Enable panel-b independently with aggregated mode.
      setMode("panel-b", "aggregated");
      assert.equal(subscriptions.length, 2);
      assert.equal(subscriptions[1].panelId, "panel-b");
      assert.equal(subscriptions[1].request?.panelId, "panel-b");
      overlayB.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(fetches.length, 2);
      assert.equal(fetches[1].panelId, "panel-b");
      assert.equal(fetches[1].req.source, "aggregated");

      // Turn panel-a off: panel-a cleans up while panel-b remains active and subscribed.
      setMode("panel-a", "off");
      assert.equal(subscriptions[0].unsubscribed, true);
      assert.equal(subscriptions[1].unsubscribed, false);
      assert.equal(overlayA.reservedRasterBytes(), 0);
      overlayA.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();
      assert.equal(fetches.length, 2);
      assert.equal(overlayA.reservedRasterBytes(), 0);
      assert.equal(overlayB.cachedBarsCount(), 1);
    } finally {
      overlayA.dispose();
      overlayB.dispose();
    }
  });
});

test("SCENARIO-CE-HEATMAP-RUNTIME-STATUS: exposes loading, error, source coverage, and idle reset transitions", async () => {
  await withPanelSettingsSource({ "panel-status": "off" }, async ({ setMode }) => {
    const startTime = 1_699_999_980_000;
    const series = makeSeries(startTime, 5);
    const view = makeTestView();
    let shouldFail = true;

    const overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => {
        if (shouldFail) {
          const err = new Error("Heatmap source must be single or aggregated");
          err.code = "INVALID_ORDERBOOK_HEATMAP_QUERY";
          throw err;
        }
        return {
          schemaVersion: 1,
          generatedAt: startTime + 4 * MINUTE,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: [{ t: startTime + 4 * MINUTE, cells: [[100_000, 15_000_000, 0]] }],
          requestedSources: ["binance:usd_perp", "bybit:spot"],
          observedSources: ["binance:usd_perp"],
          missingSources: ["bybit:spot"],
        };
      },
      invalidate: () => {},
      getMarket: () => MARKET,
      getPanelId: () => "panel-status",
      now: () => startTime + 4 * MINUTE + 1_000,
    });

    const events = [];
    const unsubscribe = overlay.subscribeStatus((status) => events.push(status));

    try {
      assert.deepEqual(overlay.getStatus(), {
        state: "idle",
        requestedSources: [],
        observedSources: [],
        missingSources: [],
        hasBars: false,
      });

      setMode("panel-status", "custom");
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();

      const errorStatus = overlay.getStatus();
      assert.equal(errorStatus.state, "error");
      assert.equal(errorStatus.errorCode, "INVALID_ORDERBOOK_HEATMAP_QUERY");
      assert.equal(errorStatus.errorMessage, "Heatmap source must be single or aggregated");
      assert.equal(errorStatus.hasBars, false);
      assert.ok(events.some((entry) => entry.state === "loading"));
      assert.ok(events.some((entry) => entry.state === "error" && entry.errorCode === "INVALID_ORDERBOOK_HEATMAP_QUERY"));

      shouldFail = false;
      setMode("panel-status", "off");
      assert.equal(overlay.getStatus().state, "idle");

      setMode("panel-status", "custom");
      overlay.draw(mockCtx, view, series, [0, 4]);
      await flushMicrotasks();

      assert.deepEqual(overlay.getStatus(), {
        state: "ready",
        requestedSources: ["binance:usd_perp", "bybit:spot"],
        observedSources: ["binance:usd_perp"],
        missingSources: ["bybit:spot"],
        hasBars: true,
      });
    } finally {
      unsubscribe();
      overlay.dispose();
    }
  });
});
