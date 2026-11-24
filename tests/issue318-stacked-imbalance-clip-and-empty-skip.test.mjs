import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state = (value) => value;

const { FootprintRenderer } = await import("../dist/core/render/footprintRenderer.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { View } = await import("../dist/core/engine/view.js");
const { settings } = await import("../dist/core/settings.js");

const T0 = Date.UTC(2024, 0, 1);

function makeSpySurface() {
  const quads = [];
  const sink = {
    rect(x, y, w, h, color) {
      quads.push({ x, y, w, h, r: color.r, g: color.g, b: color.b, a: color.a });
    },
  };
  const surface = {
    kind: "canvas2d",
    canvas: { width: 240, height: 180 },
    beginFrame() {
      quads.length = 0;
      return {
        quads: sink,
        flushQuads() {},
        end() {},
      };
    },
    resize() {},
    requestCapture: async () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
    onLost: () => () => {},
    dispose() {},
  };
  return { surface, quads };
}

function makeImbalanceSeries() {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  const cells = new Map([
    [100, { priceBin: 100, buyVol: 0, sellVol: 10, count: 1, buyCount: 0, sellCount: 1 }],
    [110, { priceBin: 110, buyVol: 100, sellVol: 1, count: 2, buyCount: 1, sellCount: 1 }],
    [120, { priceBin: 120, buyVol: 100, sellVol: 1, count: 2, buyCount: 1, sellCount: 1 }],
    [130, { priceBin: 130, buyVol: 100, sellVol: 1, count: 2, buyCount: 1, sellCount: 1 }],
    [140, { priceBin: 140, buyVol: 100, sellVol: 1, count: 2, buyCount: 1, sellCount: 1 }],
    [150, { priceBin: 150, buyVol: 100, sellVol: 1, count: 2, buyCount: 1, sellCount: 1 }],
  ]);
  series.loadBars([{
    startTime: T0,
    open: 100,
    high: 160,
    low: 100,
    close: 155,
    volume: 515,
    delta: 495,
    count: 12,
    cells,
    hasRef: true,
    cellRevision: 1,
  }]);
  return series;
}

function makeView({ top = 50, height = 100, priceTop = 145, pricePerPx = 0.5, dpr = 1 } = {}) {
  const view = new View();
  view.area = { left: 0, top, width: 400, height };
  view.colWidth = 80;
  view.offsetX = 20;
  view.priceTop = priceTop;
  view.pricePerPx = pricePerPx;
  view.pixelRatio = dpr;
  return view;
}

function makeConfig(overrides = {}) {
  return {
    ...settings,
    chartType: "footprint",
    candles: false,
    heat: false,
    poc: false,
    stackedImbalance: false,
    cellNumbers: false,
    ...overrides,
  };
}

test("#318: empty footprint output visits 0 cells and emits 0 quads while keeping text layer independent", () => {
  const prevGrid = settings.grid;
  settings.grid = false;
  try {
    const series = makeImbalanceSeries();
    const bar = series.at(0);
    let cellVisits = 0;
    const origValues = bar.cells.values.bind(bar.cells);
    bar.cells.values = () => {
      cellVisits++;
      return origValues();
    };

    const { surface, quads } = makeSpySurface();
    const renderer = new FootprintRenderer(surface);
    renderer.setChartConfig(makeConfig({
      candles: false,
      heat: false,
      poc: false,
      stackedImbalance: false,
      cellNumbers: true,
    }));

    const view = makeView({ top: 0, height: 300, priceTop: 200, pricePerPx: 0.5 });
    renderer.render(view, series);

    assert.equal(cellVisits, 0, "empty output must visit 0 cells");
    assert.equal(quads.length, 0, "empty output must emit 0 quads");
  } finally {
    settings.grid = prevGrid;
  }
});

test("#318: stackedImbalance-only skips heat/POC cell loop and clips strips to plot vertical bounds", () => {
  const prevGrid = settings.grid;
  settings.grid = false;
  try {
    const series = makeImbalanceSeries();
    const { surface, quads } = makeSpySurface();
    const renderer = new FootprintRenderer(surface);
    renderer.setChartConfig(makeConfig({
      candles: false,
      heat: false,
      poc: false,
      stackedImbalance: true,
    }));

    // View area [50, 150], priceTop=145, pricePerPx=0.5:
    // bin 150 ([150, 160]): y = 50 + (145 - 160)/0.5 = 20 .. 40 (completely above top=50 -> skipped)
    // bin 140 ([140, 150]): y = 50 + (145 - 150)/0.5 = 40 .. 60 (partially clipped to [50, 59])
    // bin 130 ([130, 140]): y = 60 .. 80 (inside)
    // bin 120 ([120, 130]): y = 80 .. 100 (inside)
    // bin 110 ([110, 120]): y = 100 .. 120 (inside)
    const view = makeView({ top: 50, height: 100, priceTop: 145, pricePerPx: 0.5 });
    renderer.render(view, series);

    // Only stacked imbalance strips should be emitted (4 visible/partial bins out of 5-bin stack)
    assert.equal(quads.length, 4, "off-screen stack cell must be skipped while preserving stack membership");
    for (const q of quads) {
      assert.ok(q.y >= view.area.top, `quad y=${q.y} must be >= area.top=${view.area.top}`);
      assert.ok(q.y + q.h <= view.area.top + view.area.height, `quad bottom=${q.y + q.h} must be <= area.bottom`);
      assert.ok(q.h > 0, "emitted quad must have positive height");
    }
    assert.equal(Math.min(...quads.map((q) => q.y)), 50, "partially off-top bin must clip exactly at view.area.top");
  } finally {
    settings.grid = prevGrid;
  }
});

test("#318: stacked imbalance clipping holds under fractional DPR, vertical pan, and log scale", () => {
  const prevGrid = settings.grid;
  settings.grid = false;
  try {
    const series = makeImbalanceSeries();
    const { surface, quads } = makeSpySurface();
    const renderer = new FootprintRenderer(surface);
    renderer.setChartConfig(makeConfig({
      candles: false,
      heat: false,
      poc: false,
      stackedImbalance: true,
    }));

    // Fractional DPR + vertical pan clipping bottom edge
    const panView = makeView({ top: 40, height: 80, priceTop: 180, pricePerPx: 0.5, dpr: 1.25 });
    renderer.render(panView, series);
    assert.ok(quads.length > 0);
    for (const q of quads) {
      assert.ok(q.y >= panView.area.top);
      assert.ok(q.y + q.h <= panView.area.top + panView.area.height);
    }

    // Log scale clipping
    const logView = makeView({ top: 50, height: 70, priceTop: 145, pricePerPx: 0.5, dpr: 1.5 });
    logView.setScaleMode("log");
    renderer.render(logView, series);
    assert.ok(quads.length > 0);
    for (const q of quads) {
      assert.ok(q.y >= logView.area.top);
      assert.ok(q.y + q.h <= logView.area.top + logView.area.height);
    }
  } finally {
    settings.grid = prevGrid;
  }
});
