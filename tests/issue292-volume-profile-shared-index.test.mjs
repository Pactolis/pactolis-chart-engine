import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { volumeProfileIndicatorDefinition } from "../dist/features/indicators/builtins/volumeProfile.js";

const INTERVAL = 60_000;
const BASE_TIME = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);

function makeSeries(barCount) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  const bars = [];
  for (let i = 0; i < barCount; i += 1) {
    const p = 100 + (i % 15);
    bars.push({
      startTime: BASE_TIME + i * INTERVAL,
      open: p,
      high: p + 2,
      low: p - 2,
      close: p + 1,
      volume: 20,
      delta: 4,
      count: 2,
      cells: new Map([
        [p, { priceBin: p, buyVol: 12, sellVol: 8, count: 2 }],
        [p + 1, { priceBin: p + 1, buyVol: 6, sellVol: 4, count: 1 }],
      ]),
      completeness: "complete",
    });
  }
  series.loadBars(bars);
  return series;
}

function makeFakeCanvas() {
  const labels = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    fillRect() {},
    fillText() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
  };
  return { ctx, labels };
}

function makeFakeView() {
  return {
    area: { left: 0, top: 0, width: 1000, height: 500 },
    subPanesH: 0,
    colWidth: 4,
    xOfIndex: (i) => i * 4,
    yOfPrice: (p) => 450 - p * 2,
  };
}

function countIndexReads(series, fn) {
  const origListReadonly = series.listReadonly.bind(series);
  let indexReads = 0;
  series.listReadonly = () => {
    const arr = origListReadonly();
    return new Proxy(arr, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) indexReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  try {
    return { result: fn(), indexReads };
  } finally {
    series.listReadonly = origListReadonly;
  }
}

test("#292: Order Flow Profile lookback + developing POC/VAH/VAL avoids full-history scan on 20k bars", () => {
  const series = makeSeries(20_000);
  const view = makeFakeView();
  const { ctx, labels } = makeFakeCanvas();
  const settings = {
    ...volumeProfileIndicatorDefinition.defaultSettings(),
    mode: "lookback",
    lookbackBars: 200,
    pocMode: "developing",
    vahMode: "developing",
    valMode: "developing",
  };
  const instance = {
    id: "vp-292",
    type: "volume-profile",
    title: "Order Flow Profile",
    visible: true,
    collapsed: false,
    paneHeight: 0,
    placement: "chart-overlay",
    order: 0,
    settings,
  };

  const drawCtx = {
    instance,
    settings,
    series,
    range: [19_800, 20_000],
    view,
    ctx,
    queuePriceLabel: (price, text) => labels.push({ price, text }),
  };

  const prep = countIndexReads(series, () => volumeProfileIndicatorDefinition.prepareData(drawCtx));
  assert.equal(prep.result.status, "ok");

  const draw = countIndexReads(series, () => volumeProfileIndicatorDefinition.drawPriceOverlay(drawCtx, prep.result));
  assert.ok(draw.indexReads < 100, `drawPriceOverlay should not scan 20k bars, got ${draw.indexReads} reads`);
  assert.deepEqual(labels.map((l) => l.text), ["dPOC", "dVAH", "dVAL"]);

  // After structureRevision bump (prepend older bar), shared fallback resolves once for all 3 lines
  series.upsertBar({
    startTime: BASE_TIME - INTERVAL,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    volume: 10,
    delta: 2,
    count: 1,
    cells: new Map([[100, { priceBin: 100, buyVol: 6, sellVol: 4, count: 1 }]]),
    completeness: "complete",
  });
  labels.length = 0;
  const drawAfterPrepend = countIndexReads(series, () => volumeProfileIndicatorDefinition.drawPriceOverlay(drawCtx, prep.result));
  assert.ok(drawAfterPrepend.indexReads < 500, `fallback shared index resolution should be O(log N + K), got ${drawAfterPrepend.indexReads}`);
  assert.deepEqual(labels.map((l) => l.text), ["dPOC", "dVAH", "dVAL"]);
});
