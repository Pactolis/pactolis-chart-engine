import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { getHeatmapThresholdSparseBar } = await import("../dist/features/orderbook/heatmapModel.js");
const { OrderbookHeatmapOverlay } = await import("../dist/features/orderbook/heatmapOverlay.js");
const { vwapIndicatorDefinition } = await import("../dist/features/indicators/builtins/vwapIndicator.js");
const vpMod = await import("../dist/features/indicators/builtins/volumeProfile.js");
const vpDef = Object.values(vpMod).find((v) => v && typeof v.prepareData === "function");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");
const { AnnotationPassCache, annotationPass, isCachePreservingChange } = await import("../dist/core/render/overlay/annotationPassCache.js");
const { ChartChange } = await import("../dist/core/render/scene/chartScene.js");
const { drawHud } = await import("../dist/core/render/overlay/hudRenderer.js");
const { resolveChartDisplayOptions } = await import("../dist/core/model/chartDisplayOptions.js");
const { AxisLayerCache } = await import("../dist/core/render/axisLayerCache.js");
const { drawPriceAxisGridLines } = await import("../dist/core/render/priceAxisRenderer.js");
const { View } = await import("../dist/core/engine/view.js");
const { Canvas2dQuadSink } = await import("../dist/core/gpu/canvas2d/canvas2dSurface.js");
const { calculateUntouchedLevels } = await import("../dist/core/analysis/referenceLevels.js");
const { aggregatePeriodCandles } = await import("../dist/core/analysis/periods.js");
const { settings } = await import("../dist/core/settings.js");

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

function mkFootprintBars(n, from = 0) {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const base = 10_000 + Math.round(Math.sin(i / 5) * 6);
    const cells = new Map();
    for (let c = 0; c < 5; c++) {
      const b = base - 2 + c;
      cells.set(b, {
        priceBin: b,
        buyVol: 0.2 * (1 + ((i + c) % 3)),
        sellVol: 0.2 * (1 + ((i * c) % 4)),
        count: 2,
        buyCount: 1,
        sellCount: 1,
      });
    }
    return {
      startTime: T0 + i * MIN,
      open: base,
      high: base + 2,
      low: base - 2,
      close: base + 1,
      volume: 5 + (i % 3),
      delta: 0.5,
      count: 10,
      cells,
      hasRef: true,
      cellRevision: 1,
      completeness: "complete",
      sources: ["history"],
    };
  });
}

test("#349: getHeatmapThresholdSparseBar zero-copy fast path reuses bar.cells when alreadyFiltered or threshold <= 0", () => {
  const bar = {
    time: T0,
    cells: [
      [100, 1_000],
      [101, 5_000],
      [102, 20_000],
    ],
  };

  const zeroThresh = getHeatmapThresholdSparseBar(bar, "usd", 0, 1);
  assert.equal(zeroThresh.cells, bar.cells);
  assert.equal(zeroThresh.maxValue, 20_000);

  const serverFiltered = getHeatmapThresholdSparseBar(bar, "usd", 500, 1, true);
  assert.equal(serverFiltered.cells, bar.cells);
  assert.equal(serverFiltered.maxValue, 20_000);

  const clientFiltered = getHeatmapThresholdSparseBar(bar, "usd", 4_000, 1, false);
  assert.notEqual(clientFiltered.cells, bar.cells);
  assert.equal(clientFiltered.cells.length, 2);
});

test("#349: OrderbookHeatmapOverlay negative-caches empty historical chunks and suppresses hover during pointer drag", async () => {
  let fetchCount = 0;
  let nowMs = T0 + 100 * 60 * MIN;
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async () => {
      fetchCount++;
      return { bars: [], coverage: null };
    },
    invalidate: () => {},
    getMarket: () => "BTCUSDT",
    getPanelId: () => "panel-1",
    now: () => nowMs,
  });

  try {
    const tier = { name: "1m", periodMs: MIN, chunkMs: 60 * MIN };
    const from = T0;
    const to = T0 + 30 * MIN;
    overlay.ensureChunks(from, to, tier);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(fetchCount, 1);

    // Second request for the same empty historical chunk must hit the negative cache.
    overlay.ensureChunks(from, to, tier);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(fetchCount, 1);

    // Pointer drag must clear any pending hover timer and not schedule hover fetches.
    overlay.setPointerDragging(true);
    assert.equal(overlay.pointerDragging, true);
    overlay.setPointerDragging(false);
    assert.equal(overlay.pointerDragging, false);
  } finally {
    overlay.dispose();
  }
});

test("#350: VWAP incremental reuse survives visible range changes without full fallback", () => {
  const prevTelemetry = configurePerformanceTelemetry({ enabled: true });
  try {
    const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
    series.loadBars(mkFootprintBars(40));
    const settingsObj = vwapIndicatorDefinition.defaultSettings();
    const instance = { id: "vwap-pan", type: "vwap", title: "VWAP", visible: true, paneId: "p", order: 0, settings: settingsObj };
    const makeCtx = (range) => ({
      ctx: {},
      view: { colWidth: 6, xOfIndex: (i) => i * 6, indexOfX: (x) => x / 6 },
      series,
      rect: { top: 0, height: 100 },
      range,
      instance,
      settings: settingsObj,
      requestRefresh() {},
    });

    vwapIndicatorDefinition.prepareData(makeCtx([10, 30]));
    const before = snapshotPerformanceTelemetry().counters;

    // Pan range + tail tick must reuse cached resultPoints without full rebuild.
    series.addTrades([{ time: T0 + 39 * MIN + 1000, price: 10_005, qty: 0.5, isBuy: true, id: "t1" }]);
    vwapIndicatorDefinition.prepareData(makeCtx([12, 32]));
    const after = snapshotPerformanceTelemetry().counters;

    assert.equal((after["indicator.incremental.full.vwap"] ?? 0) - (before["indicator.incremental.full.vwap"] ?? 0), 0);
    assert.equal((after["indicator.incremental.fallback.vwap.range"] ?? 0) - (before["indicator.incremental.fallback.vwap.range"] ?? 0), 0);
    assert.ok((after["indicator.incremental.hit.vwap"] ?? 0) > (before["indicator.incremental.hit.vwap"] ?? 0));
  } finally {
    configurePerformanceTelemetry(prevTelemetry);
  }
});

test("#350: Volume Profile visible-mode pan uses delta accumulator instead of full rebuild", () => {
  const prevTelemetry = configurePerformanceTelemetry({ enabled: true });
  try {
    const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
    series.loadBars(mkFootprintBars(60));
    const settingsObj = { ...vpDef.defaultSettings(), mode: "visible", pocMode: "static", vahMode: "static", valMode: "static" };
    const instance = { id: "vp-pan", type: vpDef.type, title: vpDef.type, visible: true, paneId: "p", order: 0, settings: settingsObj };
    const makeCtx = (range) => ({
      ctx: {},
      view: { colWidth: 6, xOfIndex: (i) => i * 6, indexOfX: (x) => x / 6 },
      series,
      rect: { top: 0, height: 100 },
      range,
      instance,
      settings: settingsObj,
      requestRefresh() {},
    });

    vpDef.prepareData(makeCtx([10, 40]));
    const before = snapshotPerformanceTelemetry().counters;

    // Small pan shift (< half window) should use delta accumulator.
    const deltaRes = vpDef.prepareData(makeCtx([12, 42]));
    const after = snapshotPerformanceTelemetry().counters;

    assert.equal(deltaRes.status, "ok");
    assert.equal((after["indicator.incremental.full.volumeProfile"] ?? 0) - (before["indicator.incremental.full.volumeProfile"] ?? 0), 0);
    assert.equal((after["indicator.incremental.delta.volumeProfile"] ?? 0) - (before["indicator.incremental.delta.volumeProfile"] ?? 0), 1);
  } finally {
    configurePerformanceTelemetry(prevTelemetry);
  }
});

test("#351: AnnotationPassCache preserves static passes across ChartChange.Interaction", () => {
  assert.equal(isCachePreservingChange(ChartChange.Interaction), true);
  assert.equal(isCachePreservingChange(ChartChange.DataTail), true);
  assert.equal(isCachePreservingChange(ChartChange.DataTail | ChartChange.Interaction), true);
  assert.equal(isCachePreservingChange(ChartChange.Viewport), false);

  const cache = new AnnotationPassCache();
  const canvas = {
    width: 64,
    height: 32,
    ownerDocument: {
      createElement: () => {
        const c = { width: 64, height: 32, getContext: () => ctx };
        return c;
      },
    },
  };
  const ctx = {
    canvas,
    save() {},
    restore() {},
    clearRect() {},
    setTransform() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    drawImage() {},
  };

  let paints = 0;
  const pass = annotationPass("drawings");
  cache.begin(ChartChange.All, "k1");
  assert.equal(cache.render(ctx, pass, "k1", ChartChange.All, () => { paints++; return 1; }, () => {}), "miss");
  cache.begin(ChartChange.Interaction, "k1");
  assert.equal(cache.canHit(pass, "k1", ChartChange.Interaction), true);
  assert.equal(cache.render(ctx, pass, "k1", ChartChange.Interaction, () => { paints++; return 1; }, () => {}), "hit");
  assert.equal(paints, 1);
  cache.clear();
});

test("#351: drawHud memoizes measureText across identical crosshair sweeps", () => {
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars(mkFootprintBars(5));
  const view = new View();
  view.setArea({ left: 0, top: 0, width: 1000, height: 400 });
  view.setPriceRange(9_990, 10_010);

  let measureCalls = 0;
  let lastHudText = null;
  const ctx = {
    font: "",
    textAlign: "left",
    textBaseline: "top",
    fillStyle: "",
    strokeStyle: "",
    measureText(text) {
      measureCalls++;
      return { width: text.length * 7 };
    },
    fillText() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    stroke() {},
  };
  const deps = {
    showNotional: false,
    displayOptions: resolveChartDisplayOptions({}),
    onHudText: (t) => { lastHudText = t; },
  };
  const crosshair = { visible: true, x: 10, y: 50, touch: false };

  drawHud(ctx, view, series, crosshair, [0, 5], deps);
  const firstMeasureCalls = measureCalls;
  const firstText = lastHudText;

  drawHud(ctx, view, series, { ...crosshair, x: 11 }, [0, 5], deps);
  assert.equal(measureCalls, firstMeasureCalls);
  assert.equal(lastHudText, firstText);
});

test("#352: AxisLayerCache bypasses offscreen bitmap after 3 consecutive price-axis moves and drawPriceAxisGridLines batches strokes", () => {
  const prevTelemetry = configurePerformanceTelemetry({ enabled: true });
  const prevGrid = settings.grid;
  settings.grid = true;
  try {
    const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
    series.loadBars(mkFootprintBars(5));
    const view = new View();
    view.setArea({ left: 0, top: 0, width: 600, height: 400 });

    const makeCtx = () => ({
      canvas: {
        width: 660,
        height: 430,
        ownerDocument: {
          createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => makeCtx(),
          }),
        },
      },
      font: "",
      fillStyle: "",
      strokeStyle: "",
      textAlign: "left",
      textBaseline: "middle",
      save() {},
      restore() {},
      clearRect() {},
      setTransform() {},
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      drawImage() {},
      fillRect() {},
      fillText() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
    });

    const ctx = makeCtx();
    const cache = new AxisLayerCache();
    const displayOptions = resolveChartDisplayOptions({});

    view.setPriceRange(9_900, 10_100);
    cache.renderPriceAxis(ctx, view, series, [], displayOptions);
    view.setPriceRange(9_905, 10_105);
    cache.renderPriceAxis(ctx, view, series, [], displayOptions);
    view.setPriceRange(9_910, 10_110);
    cache.renderPriceAxis(ctx, view, series, [], displayOptions);
    view.setPriceRange(9_915, 10_115);
    cache.renderPriceAxis(ctx, view, series, [], displayOptions);

    const counters = snapshotPerformanceTelemetry().counters;
    assert.ok((counters["chart.annotation.axis.price.cache.bypass"] ?? 0) >= 1);

    let beginPaths = 0;
    let strokes = 0;
    const gridCtx = {
      strokeStyle: "",
      beginPath() { beginPaths++; },
      moveTo() {},
      lineTo() {},
      stroke() { strokes++; },
    };
    drawPriceAxisGridLines(gridCtx, view, [100, 150, 200, 250]);
    assert.equal(beginPaths, 1);
    assert.equal(strokes, 1);
  } finally {
    settings.grid = prevGrid;
    configurePerformanceTelemetry(prevTelemetry);
  }
});

test("#353: Canvas2dQuadSink skips redundant fillStyle assignments for identical quantized RGBA", () => {
  let fillStyleSets = 0;
  let fillRects = 0;
  let currentFill = "";
  const ctx = {
    get fillStyle() { return currentFill; },
    set fillStyle(v) { fillStyleSets++; currentFill = v; },
    fillRect() { fillRects++; },
  };
  const sink = new Canvas2dQuadSink(ctx);
  sink.rect(0, 0, 10, 10, { r: 0.1, g: 0.8, b: 0.3, a: 0.5 });
  sink.rect(10, 0, 10, 10, { r: 0.1, g: 0.8, b: 0.3, a: 0.5 });
  assert.equal(fillRects, 2);
  assert.equal(fillStyleSets, 1);

  sink.rect(20, 0, 10, 10, { r: 0.9, g: 0.2, b: 0.2, a: 0.5 });
  assert.equal(fillRects, 3);
  assert.equal(fillStyleSets, 2);
});

test("analysis: calculateUntouchedLevels and aggregatePeriodCandles preserve exact parity", () => {
  const dayMs = 86_400_000;
  const baseDay = Date.UTC(2026, 0, 1);
  const bars = [
    { startTime: baseDay, open: 100, high: 110, low: 95, close: 108, volume: 10, delta: 1, count: 5, cells: new Map(), hasRef: true, completeness: "complete" },
    { startTime: baseDay + dayMs, open: 115, high: 118, low: 108, close: 108, volume: 12, delta: -1, count: 6, cells: new Map(), hasRef: true, completeness: "complete" },
    { startTime: baseDay + 2 * dayMs, open: 112, high: 120, low: 110, close: 119, volume: 11, delta: 2, count: 4, cells: new Map(), hasRef: true, completeness: "complete" },
  ];

  const daily = aggregatePeriodCandles(bars, "daily", baseDay + 5 * dayMs, dayMs);
  assert.equal(daily.length, 3);
  assert.equal(daily[0].high, 110);
  assert.equal(daily[0].low, 95);

  const untouched = calculateUntouchedLevels(bars, "BTCUSDT", 1, baseDay + 5 * dayMs, dayMs, ["daily"]);
  assert.equal(untouched.length, 1);
  assert.equal(untouched[0].price, 108);
});
