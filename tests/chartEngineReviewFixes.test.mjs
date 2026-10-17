/**
 * Regressions for the 2026-10-01 chart engine review (frontend a900ca7):
 * render config delivery, replay market isolation, market metadata races,
 * OHLC trade order, liquidation carry-over, day patch queue, footprint
 * cell geometry, stacked imbalance runs, popout DPR and pane auto scale.
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { ChartRenderCoordinator } = await import("../dist/features/chart/ChartRenderCoordinator.js");
const { ChartReplayCoordinator } = await import("../dist/features/chart/ChartReplayCoordinator.js");
const { ChartDataPipeline } = await import("../dist/features/chart/ChartDataPipeline.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { FootprintRenderer } = await import("../dist/core/render/footprintRenderer.js");
const { View } = await import("../dist/core/engine/view.js");
const { executeChartAction } = await import("../dist/features/chart/chartCommands.js");

const MINUTE = 60_000;
const T0 = Date.UTC(2024, 0, 1);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function viewConfig(overrides = {}) {
  return {
    chartType: "footprint",
    tpoMode: "letters",
    tpoProfilePeriod: "session",
    tpoBracketSize: 30,
    clusterCellData: "volume",
    profileCellData: "volume",
    candles: true,
    heat: true,
    cellNumbers: true,
    poc: true,
    stackedImbalance: true,
    ...overrides,
  };
}

function historyBar(startTime, cells, ohlc = {}) {
  return {
    startTime,
    open: 100, high: 101, low: 99, close: 100,
    volume: 5, delta: 5, count: 5,
    liquidationBuyVol: 0, liquidationSellVol: 0,
    cells: new Map(cells.map((cell) => [cell.priceBin, {
      buyVol: 0, sellVol: 0, count: 0, buyCount: 0, sellCount: 0,
      liquidationBuyVol: 0, liquidationSellVol: 0,
      ...cell,
    }])),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime,
    ...ohlc,
  };
}

test("a visibility toggle and a restored renderer both receive the panel config", () => {
  const pushed = [];
  const overlayPushed = [];
  let renderer = { setChartConfig: (config) => pushed.push(["first", config]) };
  const coordinator = new ChartRenderCoordinator({
    session: { invalidate() {} },
    overlay: { setChartConfig: (config) => overlayPushed.push(config) },
    getRenderer: () => renderer,
    listIndicators: () => [],
  });

  coordinator.applyConfig(viewConfig());
  const layers = coordinator.getGpuLayerIds();
  coordinator.applyConfig(viewConfig({ heat: false }));
  assert.equal(pushed.at(-1)[1].heat, false, "heat-only change must reach the renderer");
  assert.equal(overlayPushed.at(-1).heat, false, "heat-only change must reach the overlay");
  assert.equal(coordinator.getGpuLayerIds(), layers, "visibility toggles do not rebuild the layer composition");

  // WebGL restore: a new renderer with the same layer key still gets the panel config.
  renderer = { setChartConfig: (config) => pushed.push(["restored", config]) };
  coordinator.applyConfig(viewConfig({ heat: false }));
  assert.deepEqual(pushed.at(-1)[0], "restored");
  assert.equal(pushed.at(-1)[1].heat, false);
  coordinator.dispose();
});

function replayHarness() {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  for (let index = 0; index < 4; index++) {
    series.upsertBar(historyBar(T0 + index * MINUTE, [{ priceBin: 100, buyVol: 1 }]));
  }
  const host = {
    market: "BINANCE_FUTURES:btcusdt",
    paused: [],
    reloads: 0,
    pipeline: { series, intervalMs: MINUTE, setPaused: (paused) => host.paused.push(paused) },
    session: { invalidate() {} },
    timeViewport: { applyDataUpdate() {}, placeReplayPrefixEnd() {} },
    svc: { updateAnalysisFromSeries() {} },
    isDisposed: () => false,
    getMarket: () => host.market,
    autoFit() {},
    updateHook() {},
    loadHistory: async () => { host.reloads++; },
  };
  const coordinator = new ChartReplayCoordinator(host);
  const snapshots = [];
  coordinator.subscribe((snapshot) => snapshots.push(snapshot));
  return { host, series, coordinator, snapshots };
}

test("leaving the replayed market ends replay without reloading the old market", () => {
  const { host, series, coordinator, snapshots } = replayHarness();
  coordinator.start();
  coordinator.selectFirst();
  assert.equal(series.length, 0);

  host.market = "BINANCE_FUTURES:ethusdt";
  coordinator.exitForMarketChange(host.market);
  assert.equal(coordinator.isActive(), false);
  assert.equal(host.reloads, 0, "the new market loads its own history");
  assert.equal(snapshots.at(-1), null);
  assert.equal(host.paused.at(-1), false);
});

test("a replay step never writes the old market's bar into another market's series", () => {
  const { host, series, coordinator, snapshots } = replayHarness();
  coordinator.start();
  coordinator.selectFirst();
  host.market = "BINANCE_FUTURES:ethusdt";
  coordinator.step();
  assert.equal(series.length, 0, "the BTC bar must not land on the ETH series");
  assert.equal(coordinator.isActive(), false);
  assert.equal(snapshots.at(-1), null, "no stale replay snapshot may follow the exit");
});

test("replay exit reports a failed history reload instead of leaving it unhandled", async () => {
  const { host, coordinator } = replayHarness();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    host.loadHistory = async () => { throw new Error("offline"); };
    coordinator.start();
    coordinator.exit();
    await new Promise(setImmediate);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /replay/);
});

test("a timeframe change during a market switch keeps the new market's price step", async () => {
  const ethStep = deferred();
  const services = {
    subscribeToTrades: () => () => {},
    fetchPriceStepResult: (market) => market.endsWith("ethusdt") ? ethStep.promise : Promise.resolve({ step: 10, resolved: true }),
    fetchPriceStep: async () => 10,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
  };
  const pipeline = new ChartDataPipeline({ market: "BINANCE_FUTURES:btcusdt", intervalMs: MINUTE, priceStep: 10, services });
  const marketSwitch = pipeline.changeConfig({ market: "BINANCE_FUTURES:ethusdt" });
  await new Promise(setImmediate);
  let timeframeDone = false;
  const timeframeSwitch = pipeline.changeConfig({ intervalMs: 5 * MINUTE }).then(() => { timeframeDone = true; });
  await new Promise(setImmediate);
  assert.equal(timeframeDone, false, "the timeframe change waits for the market's step");

  ethStep.resolve({ step: 0.5, resolved: true });
  await Promise.all([marketSwitch, timeframeSwitch]);
  assert.equal(pipeline.series.config.priceStep, 0.5);
  assert.equal(pipeline.intervalMs, 5 * MINUTE);
  pipeline.dispose();
});

test("OHLC maintenance keeps the live trade order, so a delayed trade cannot move the close back", () => {
  const market = "BINANCE_FUTURES:btcusdt";
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1, referenceMarket: market });
  const trade = (time, price, id) => ({ time, price, qty: 1, isBuy: true, market, id: String(id), receivedAt: time });
  series.addTrade(trade(T0 + 1_000, 100, 1));
  series.addTrade(trade(T0 + 3_000, 100.2, 3));
  series.reassertOHLC(T0, 100, 100.2, 100, { close: 100.2, preferIncomingClose: true, observedAt: T0 + 3_500 });
  series.addTrade(trade(T0 + 2_000, 99.9, 2));
  assert.equal(series.at(0).close, 100.2, "a trade older than the close must not replace it");
  assert.equal(series.at(0).low, 99.9);
  series.addTrade(trade(T0 + 4_000, 100.1, 4));
  assert.equal(series.at(0).close, 100.1, "a newer trade still moves the close");
  assert.equal(series.at(0).open, 100, "the reasserted open stays authoritative");
});

function coverageMeta(q) {
  return {
    schemaVersion: 2,
    generatedAt: q.to,
    footprint: { available: true },
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference,
      authority: "provisional",
      status: "complete",
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom: q.from,
      coveredThrough: q.to,
      durableThroughId: null,
      projectionThroughId: "100",
      authorityToken: "token",
      reasonCode: null,
    },
  };
}

test("recent coverage replacement keeps the liquidations the bar already held", async () => {
  const from = T0;
  const to = from + MINUTE;
  let emit = () => {};
  const liquidation = (qty, time) => ({ time, price: 100, qty, isBuy: false, liquidation: true, market: "M", receivedAt: time });
  const services = {
    subscribeToTrades: (_market, cb) => { emit = cb; return () => {}; },
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
    fetchHistory: async (q) => {
      // Arrives while the repair is in flight and is applied live before the snapshot lands.
      emit(liquidation(3, from + 2_000));
      q.onMeta?.(coverageMeta(q));
      return [historyBar(from, [{ priceBin: 101, buyVol: 5, count: 5, buyCount: 5 }])];
    },
  };
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: MINUTE, priceStep: 1, services });
  pipeline.series.upsertBar(historyBar(from, [{ priceBin: 100, buyVol: 1, count: 1, buyCount: 1 }]));
  pipeline.series.addTrade(liquidation(2, from + 1_000));
  assert.equal(pipeline.series.at(0).liquidationSellVol, 2);

  assert.equal(await pipeline.repairRecentFootprintCoverage(from, to), "complete");
  const bar = pipeline.series.at(0);
  assert.equal(bar.cells.get(101)?.buyVol, 5, "the snapshot's cells are applied");
  assert.equal(bar.liquidationSellVol, 5, "earlier and in-flight liquidations each count once");
  assert.equal(bar.cells.get(100)?.liquidationSellVol, 5);
  pipeline.dispose();
});

test("a failed day patch does not stop later day patches", async () => {
  const services = {
    subscribeToTrades: () => () => {},
    fetchPriceStep: async () => 1,
    fetchPricePrecision: async () => undefined,
    triggerAutoSync() {},
  };
  const pipeline = new ChartDataPipeline({ market: "M", intervalMs: MINUTE, priceStep: 1, services });
  const ran = [];
  pipeline._patchDayNow = async (from) => {
    ran.push(from);
    if (ran.length === 1) throw new Error("bad bar");
  };
  const day = 24 * 60 * MINUTE;
  await assert.rejects(pipeline.patchDay(T0), /bad bar/);
  await pipeline.patchDay(T0 + day);
  assert.deepEqual(ran, [T0, T0 + day]);
  pipeline.dispose();
});

function fakeGl(dpr) {
  const canvas = { ownerDocument: { defaultView: { devicePixelRatio: dpr } } };
  return new Proxy({ canvas, drawingBufferWidth: 800 * dpr, drawingBufferHeight: 600 * dpr }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && /^[A-Z_0-9]+$/.test(prop)) return 1;
      return () => ({});
    },
  });
}

function recordingRenderer(dpr = 1) {
  const renderer = new FootprintRenderer(fakeGl(dpr));
  const rects = [];
  const flushes = [];
  renderer.batch = {
    begin() {},
    rect: (x, y, w, h) => rects.push({ x, y, w, h }),
    flush: (w, h) => flushes.push([w, h]),
    dispose() {},
  };
  return { renderer, rects, flushes };
}

function plotView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.priceTop = 120;
  view.pricePerPx = 0.1;
  return view;
}

test("single-price bars and cells on the high's bin edge keep their footprint row", () => {
  const { renderer } = recordingRenderer();
  const view = plotView();
  const flat = historyBar(T0, [{ priceBin: 100, buyVol: 1 }], { open: 100, high: 100, low: 100, close: 100 });
  const flatRect = renderer.clippedCellRect(view, flat, 100, 1);
  assert.ok(flatRect && flatRect.height > 0, "a single-price bar's only cell must be drawn");

  const edge = historyBar(T0, [{ priceBin: 105, buyVol: 1 }], { open: 101, high: 105, low: 101, close: 105 });
  const edgeRect = renderer.clippedCellRect(view, edge, 105, 1);
  assert.ok(edgeRect && edgeRect.height > 0, "the cell holding the high must be drawn");
  assert.equal(renderer.clippedCellRect(view, edge, 107, 1), null, "cells outside the traded range stay hidden");

  const merged = renderer.clipPixelSpanToBar(view, flat, view.yOfPrice(100) - 0.5, 1);
  assert.ok(merged && merged.height > 0, "the pixel-merged path keeps a single-price bar too");
});

test("a price gap ends a stacked imbalance run", () => {
  const { renderer, rects } = recordingRenderer();
  const view = plotView();
  const bins = [100, 101, 103, 104];
  const bar = historyBar(T0, bins.map((priceBin) => ({ priceBin, buyVol: 1 })), { high: 105, low: 100 });
  renderer.markRuns(view, bar, bins.map((priceBin) => ({ priceBin })), 1, [true, true, true, true], 0, 2, { r: 0, g: 1, b: 0, a: 1 });
  assert.equal(rects.length, 0, "two runs of two are not a stack of three");

  const consecutive = [100, 101, 102];
  renderer.markRuns(view, bar, consecutive.map((priceBin) => ({ priceBin })), 1, [true, true, true], 0, 2, { r: 0, g: 1, b: 0, a: 1 });
  assert.equal(rects.length, 3);
});

test("the GPU flush uses the canvas window's DPR, not the main window's", () => {
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const { renderer, flushes } = recordingRenderer(2);
    renderer.setChartConfig(viewConfig());
    const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
    renderer.renderLayers(plotView(), series, new Set());
    assert.deepEqual(flushes.at(-1), [800, 600]);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("the indicator pane menu's auto scale item toggles instead of resetting", () => {
  const calls = [];
  const target = {
    resetIndicatorPaneScale: (id) => { calls.push(["reset", id]); return true; },
    toggleIndicatorPaneAutoScale: (id) => { calls.push(["toggle", id]); return true; },
  };
  executeChartAction({ kind: "indicator-toggle-auto-scale", paneId: "rsi-1" }, target, {});
  executeChartAction({ kind: "indicator-reset-scale", paneId: "rsi-1" }, target, {});
  assert.deepEqual(calls, [["toggle", "rsi-1"], ["reset", "rsi-1"]]);
});
