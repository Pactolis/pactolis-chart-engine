import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import {
  configurePerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { macdIndicatorDefinition } from "../dist/features/indicators/builtins/macd.js";
import { atrIndicatorDefinition } from "../dist/features/indicators/builtins/atr.js";

const INTERVAL = 60_000;
const BASE_TIME = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);

function makeSeries(barCount) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  const bars = [];
  for (let i = 0; i < barCount; i += 1) {
    const price = 100 + Math.sin(i * 0.05) * 15 + (i % 7) * 0.25;
    bars.push({
      startTime: BASE_TIME + i * INTERVAL,
      open: price,
      high: price + 2.5,
      low: price - 2.5,
      close: price + 0.5,
      volume: 10,
      delta: 1,
      count: 1,
      cells: new Map(),
      completeness: "complete",
    });
  }
  series.loadBars(bars);
  return series;
}

function makeFakeView() {
  return {
    area: { left: 0, top: 0, width: 800, height: 400 },
    subPanesH: 120,
    colWidth: 4,
    xOfIndex: (i) => i * 4,
    yOfPrice: (p) => 400 - p,
  };
}

test("#289: panning 20 steps on 20,000 bars performs 0 full-series MACD/ATR recomputes and matches reference", () => {
  const series = makeSeries(20_000);
  const view = makeFakeView();
  const macdInstance = {
    id: "macd-pan-test",
    type: "macd",
    title: "MACD",
    visible: true,
    collapsed: false,
    paneHeight: 124,
    placement: "separate-pane",
    order: 0,
    settings: macdIndicatorDefinition.defaultSettings(),
  };
  const atrInstance = {
    id: "atr-pan-test",
    type: "atr",
    title: "ATR",
    visible: true,
    collapsed: false,
    paneHeight: 104,
    placement: "separate-pane",
    order: 1,
    settings: atrIndicatorDefinition.defaultSettings(),
  };

  // Warmup prepare at [19800, 20000]
  macdIndicatorDefinition.prepareData({ instance: macdInstance, settings: macdInstance.settings, series, range: [19_800, 20_000], view, ctx: {} });
  atrIndicatorDefinition.prepareData({ instance: atrInstance, settings: atrInstance.settings, series, range: [19_800, 20_000], view, ctx: {} });

  configurePerformanceTelemetry({ enabled: true, reset: true });
  try {
    let lastMacd = null;
    let lastAtr = null;
    for (let step = 1; step <= 20; step += 1) {
      const range = [19_800 - step, 20_000 - step];
      lastMacd = macdIndicatorDefinition.prepareData({ instance: macdInstance, settings: macdInstance.settings, series, range, view, ctx: {} });
      lastAtr = atrIndicatorDefinition.prepareData({ instance: atrInstance, settings: atrInstance.settings, series, range, view, ctx: {} });
    }
    const counters = snapshotPerformanceTelemetry().counters;
    assert.equal(counters["indicator.incremental.full.macd"] ?? 0, 0, "MACD must perform 0 full recomputes during pan");
    assert.equal(counters["indicator.incremental.full.atr"] ?? 0, 0, "ATR must perform 0 full recomputes during pan");
    assert.ok((counters["indicator.incremental.hit.macd"] ?? 0) >= 20);
    assert.ok((counters["indicator.incremental.hit.atr"] ?? 0) >= 20);

    // Parity against fresh full computation on the final panned window [19780, 19980]
    const freshMacd = macdIndicatorDefinition.prepareData({
      instance: { ...macdInstance, id: "macd-fresh" },
      settings: macdInstance.settings,
      series,
      range: [19_780, 19_980],
      view,
      ctx: {},
    });
    const freshAtr = atrIndicatorDefinition.prepareData({
      instance: { ...atrInstance, id: "atr-fresh" },
      settings: atrInstance.settings,
      series,
      range: [19_780, 19_980],
      view,
      ctx: {},
    });
    assert.deepEqual(lastMacd.range, freshMacd.range);
    assert.deepEqual(lastMacd.meta, freshMacd.meta);
    assert.deepEqual(lastAtr.range, freshAtr.range);
    assert.deepEqual(lastAtr.meta, freshAtr.meta);

    // Live tail trade still updates accurately
    series.addTrade({
      id: "pan-tail-1",
      time: BASE_TIME + 19_999 * INTERVAL + 1_000,
      price: 180,
      qty: 2,
      isBuy: true,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
    });
    const afterTradeMacd = macdIndicatorDefinition.prepareData({ instance: macdInstance, settings: macdInstance.settings, series, range: [19_800, 20_000], view, ctx: {} });
    const freshAfterTradeMacd = macdIndicatorDefinition.prepareData({ instance: { ...macdInstance, id: "macd-fresh-2" }, settings: macdInstance.settings, series, range: [19_800, 20_000], view, ctx: {} });
    assert.deepEqual(afterTradeMacd.meta, freshAfterTradeMacd.meta);
  } finally {
    configurePerformanceTelemetry({ enabled: false, reset: true });
  }
});
