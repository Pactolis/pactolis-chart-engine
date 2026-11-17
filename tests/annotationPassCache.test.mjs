import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationPassCache, annotationPass } from "../dist/core/render/overlay/annotationPassCache.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { configurePerformanceTelemetry, isPerformanceTelemetryEnabled, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { ChartLevelContextController } from "../dist/features/chart/ChartLevelContextController.js";
import { DEFAULT_VOLUME_PROFILE_SETTINGS } from "../dist/core/analysis/volumeProfile.js";
import { normalizePreviousWeekStrategySettings } from "../dist/core/analysis/previousWeekStrategy.js";
import { normalizeMondayRangeSettings } from "../dist/core/analysis/mondayRange.js";

function fixture() {
  const images = [];
  const make = () => {
    const canvas = { width: 64, height: 32, ownerDocument: { createElement: () => make().canvas } };
    const ctx = { canvas, save() {}, restore() {}, clearRect() {}, setTransform() {}, getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }), drawImage: (...args) => images.push(args) };
    canvas.getContext = () => ctx;
    return ctx;
  };
  return { ctx: make(), images };
}

test("pass interests retain closed output through tail frames and invalidate on autoscale", () => {
  const cache = new AnnotationPassCache();
  const { ctx, images } = fixture();
  let paints = 0, effects = 0;
  const draw = () => { paints++; return 7; };
  const paint = (changes, key = "fixed") => {
    cache.begin(changes, key);
    return cache.render(ctx, annotationPass("axis"), "", changes, draw, (value) => { effects += value; });
  };
  assert.equal(paint(ChartChange.All), "miss");
  assert.equal(paint(ChartChange.DataTail), "hit");
  assert.equal(paint(ChartChange.DataTail), "hit");
  assert.equal(paints, 1);
  assert.equal(effects, 14);
  assert.equal(images.length, 3);
  paint(ChartChange.DataTail | ChartChange.Viewport, "expanded-price-range");
  assert.equal(paints, 2);
  paint(ChartChange.DataTail, "new-bar");
  assert.equal(paints, 3);
  cache.clear();
});

test("tail-dependent indicators and last price never reuse a static pass", () => {
  const cache = new AnnotationPassCache();
  const { ctx } = fixture();
  cache.begin(ChartChange.DataTail, "fixed");
  for (const id of ["last-price", "indicators", "indicator:ema", "volume-profile", "tpo", "orderbook-heatmap"]) {
    let called = false;
    assert.equal(cache.render(ctx, annotationPass(id), "", ChartChange.DataTail, () => { called = true; }, () => {}), false);
    assert.equal(called, false);
  }
});

test("cache is bounded and absent canvas capabilities use the direct path", () => {
  const cache = new AnnotationPassCache();
  const { ctx } = fixture();
  ctx.canvas.width = 10000;
  ctx.canvas.height = 10000;
  cache.begin(ChartChange.All, "large");
  assert.equal(cache.render(ctx, annotationPass("drawings"), "", ChartChange.All, () => {}, () => {}), false);
  ctx.canvas.width = 64;
  ctx.canvas.ownerDocument = null;
  assert.equal(cache.render(ctx, annotationPass("drawings"), "", ChartChange.All, () => {}, () => {}), false);
});


test("high-DPR closed text cannot exhaust the later axis pass reservation", () => {
  const cache = new AnnotationPassCache();
  const { ctx } = fixture();
  ctx.canvas.width = 1800;
  ctx.canvas.height = 1040;
  cache.begin(ChartChange.All, "dpr2");
  assert.equal(cache.render(ctx, annotationPass("closed-footprint-text"), "", ChartChange.All, () => {}, () => {}), "miss");
  assert.equal(cache.render(ctx, annotationPass("strategy-levels"), "", ChartChange.All, () => {}, () => {}), false);
  assert.equal(cache.render(ctx, annotationPass("axis"), "", ChartChange.All, () => {}, () => {}), "miss");
  cache.begin(ChartChange.DataTail, "dpr2");
  assert.equal(cache.render(ctx, annotationPass("axis"), "", ChartChange.DataTail, () => {}, () => {}), "hit");
});


test("full-frame invalidation redraws into the same pass backing store", () => {
  const cache = new AnnotationPassCache();
  const { ctx, images } = fixture();
  for (let index = 0; index < 3; index++) {
    cache.begin(ChartChange.DataNonTail, `history-${index}`);
    assert.equal(cache.render(ctx, annotationPass("axis"), "", ChartChange.DataNonTail, () => index, () => {}), "miss");
  }
  assert.equal(images[0][0], images[1][0]);
  assert.equal(images[1][0], images[2][0]);
  cache.clear();
  assert.equal(images[0][0].width, 0);
});

function makeOverlayMockDocument() {
  const created = [];
  const makeCtx = (width = 900, height = 520) => {
    const calls = [];
    let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const stack = [];
    const canvas = { width, height, ownerDocument: doc };
    const ctx = {
      canvas,
      calls,
      fillStyle: "",
      strokeStyle: "",
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      lineWidth: 1,
      globalAlpha: 1,
      save() {
        stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, transform: { ...transform } });
      },
      restore() {
        const prev = stack.pop();
        if (prev) Object.assign(this, prev), (transform = prev.transform);
      },
      getTransform() { return { ...transform }; },
      setTransform(a, b, c, d, e, f) { transform = { a, b, c, d, e, f }; },
      clearRect(x, y, w, h) { calls.push({ op: "clearRect", x, y, w, h }); },
      fillRect(x, y, w, h) { calls.push({ op: "fillRect", x, y, w, h, fillStyle: this.fillStyle }); },
      strokeRect(x, y, w, h) { calls.push({ op: "strokeRect", x, y, w, h }); },
      beginPath() {},
      rect() {},
      clip() {},
      moveTo(x, y) { calls.push({ op: "moveTo", x, y }); },
      lineTo(x, y) { calls.push({ op: "lineTo", x, y }); },
      roundRect() {},
      fill() {},
      stroke() { calls.push({ op: "stroke", strokeStyle: this.strokeStyle }); },
      setLineDash() {},
      fillText(text, x, y) { calls.push({ op: "fillText", text: String(text), x, y }); },
      measureText(text) { return { width: String(text).length * 7 }; },
      drawImage(image, dx, dy) { calls.push({ op: "drawImage", image, dx, dy }); },
    };
    canvas.getContext = (kind) => (kind === "2d" ? ctx : null);
    canvas.recordedCtx = ctx;
    return ctx;
  };
  const doc = {
    created,
    createElement(tag) {
      assert.equal(tag, "canvas");
      const offCtx = makeCtx(0, 0);
      created.push(offCtx.canvas);
      return offCtx.canvas;
    },
  };
  return { mainCtx: makeCtx(900, 520), created };
}

function makeOverlaySeries(count = 20) {
  const baseTime = Date.UTC(2026, 5, 23, 8, 0);
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, pricePrecision: 1 });
  series.loadBars(Array.from({ length: count }, (_, index) => {
    const startTime = baseTime + index * 60_000;
    const basePrice = 62_100 + index * 2;
    return {
      startTime,
      open: basePrice,
      high: basePrice + 10,
      low: basePrice - 5,
      close: basePrice + 4,
      volume: 100 + index,
      delta: 12,
      count: 10,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
      cells: new Map([[basePrice, { priceBin: basePrice, buyVol: 60, sellVol: 40, count: 10, buyCount: 6, sellCount: 4, liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
      updatedAt: startTime,
    };
  }));
  return { baseTime, series };
}

function makeOverlayView() {
  const view = new View();
  view.pixelRatio = 1;
  view.area = { left: 0, top: 0, width: 838, height: 500 };
  view.priceAxisW = view.chartLayoutOptions.priceAxisWidth;
  view.colWidth = 20;
  view.scrollToIndex(19, 2);
  view.fitPriceRange(62_080, 62_220);
  return view;
}

test("live series drawing pass interest tracks active visible drawings and never reuses stale DataTail output", () => {
  const manager = new DrawingManager(() => {});
  const market = "BINANCE_FUTURES:btcusdt";
  manager.setMarket(market);
  assert.equal(manager.hasLiveSeriesDrawings(market), false);

  manager.replace([{ id: "h1", type: "horizontal", points: [{ time: 1, price: 100 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market }]);
  assert.equal(manager.hasLiveSeriesDrawings(market), false);

  manager.replace([{ id: "a-hidden", type: "anchored-vwap", points: [{ time: 1, price: 100 }], color: "#fff", lineWidth: 1, locked: false, visible: false, market }]);
  assert.equal(manager.hasLiveSeriesDrawings(market), false);

  manager.replace([{ id: "a-other", type: "anchored-vwap", points: [{ time: 1, price: 100 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "OKX:ethusdt" }]);
  assert.equal(manager.hasLiveSeriesDrawings(market), false);

  manager.replace([{ id: "a-live", type: "anchored-vwap", points: [{ time: 1, price: 100 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market }]);
  assert.equal(manager.hasLiveSeriesDrawings(market), true);

  manager.replace([{ id: "frvp-live", type: "fixed-range-volume-profile", points: [{ time: 1, price: 100 }, { time: 2, price: 110 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market }]);
  assert.equal(manager.hasLiveSeriesDrawings(market), true);

  const cache = new AnnotationPassCache();
  const { ctx } = fixture();
  cache.begin(ChartChange.All, "fixed");
  assert.equal(cache.render(ctx, annotationPass("drawings", false), "", ChartChange.All, () => "v1", () => {}), "miss");
  assert.equal(cache.render(ctx, annotationPass("drawings", false), "", ChartChange.DataTail, () => "v1", () => {}), "hit");
  assert.equal(cache.render(ctx, annotationPass("drawings", true), "", ChartChange.DataTail, () => "v2", () => {}), false);
  assert.equal(cache.render(ctx, annotationPass("drawings", false), "", ChartChange.DataTail, () => "v3", () => {}), "miss");

  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const { mainCtx } = makeOverlayMockDocument();
    const { series } = makeOverlaySeries();
    const view = makeOverlayView();
    const crosshair = { x: 0, y: 0, visible: false };
    let drawCalls = 0;
    let live = false;
    const overlay = new Overlay(
      mainCtx,
      () => { drawCalls++; },
      () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => live,
    );
    const layers = ["drawings", "axis"];
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All);
    assert.equal(drawCalls, 1);

    const beforeStaticTail = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    const afterStaticTail = snapshotPerformanceTelemetry().counters;
    assert.equal(drawCalls, 1);
    assert.equal((afterStaticTail["chart.annotation.pass.drawings.reuse"] ?? 0) - (beforeStaticTail["chart.annotation.pass.drawings.reuse"] ?? 0), 1);

    live = true;
    const beforeLiveTail = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    const afterLiveTail = snapshotPerformanceTelemetry().counters;
    assert.equal(drawCalls, 3);
    assert.equal((afterLiveTail["chart.annotation.pass.drawings.reuse"] ?? 0) - (beforeLiveTail["chart.annotation.pass.drawings.reuse"] ?? 0), 0);
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
});

test("replay as-of changes invalidate retained annotation output", () => {
  const { mainCtx } = makeOverlayMockDocument();
  const { baseTime, series } = makeOverlaySeries();
  const view = makeOverlayView();
  const crosshair = { x: 0, y: 0, visible: false };
  let drawingPassCalls = 0;
  const overlay = new Overlay(
    mainCtx,
    () => { drawingPassCalls++; },
    () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
  );
  const layers = ["drawings", "axis"];

  overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All, undefined);
  overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail, undefined);
  assert.equal(drawingPassCalls, 1, "unchanged live frames reuse the prior drawing pass");

  const firstSeek = baseTime + 10 * 60_000;
  overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail, firstSeek);
  overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail, firstSeek);
  assert.equal(drawingPassCalls, 2, "entering replay redraws, then repeating the same seek reuses it");

  const secondSeek = baseTime + 11 * 60_000;
  overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail, secondSeek);
  assert.equal(drawingPassCalls, 3, "a replay seek invalidates the previous time's retained drawing frame");
});

test("naked-poc, strategy-levels, and reference-levels redraw updated levels on a DataTail frame while reusing unchanged levels", () => {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const { mainCtx } = makeOverlayMockDocument();
    const { baseTime, series } = makeOverlaySeries();
    const view = makeOverlayView();
    const crosshair = { x: 0, y: 0, visible: false };
    const pwSettings = normalizePreviousWeekStrategySettings({ enabled: true, visible: { "pw-1": true, "pw-2": true } });
    const mrSettings = normalizeMondayRangeSettings({ enabled: true, visible: { "mr-1": true } });
    let pwLevels = [{ id: "pw-1", kind: "line", price: 62_140, label: "PW-1", color: "#fbbf24", sourceStart: baseTime, sourceEnd: baseTime + 60_000 }];
    let mrLevels = [{ id: "mr-1", kind: "line", price: 62_150, label: "MON-1", color: "#a855f7", sourceStart: baseTime, sourceEnd: baseTime + 60_000 }];
    let nakedPocs = [{ id: "np-1", market: "BTCUSDT", period: "daily", periodStart: baseTime, periodEnd: baseTime + 60_000, price: 62_120, age: 1, complete: true }];
    let refLevels = [{ id: "ref-1", family: "level", period: "daily", label: "REF-1", price: 62_130, color: "#38bdf8", sourceStart: baseTime, sourceEnd: baseTime + 60_000 }];

    const overlay = new Overlay(
      mainCtx,
      undefined,
      () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
      () => pwSettings,
      () => pwLevels,
      () => mrSettings,
      () => mrLevels,
      () => nakedPocs,
      () => refLevels,
    );
    const layers = ["strategy-levels", "naked-poc", "reference-levels", "axis"];

    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All);

    const beforeReuse = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    const afterReuse = snapshotPerformanceTelemetry().counters;
    for (const id of layers) {
      assert.equal((afterReuse[`chart.annotation.pass.${id}.reuse`] ?? 0) - (beforeReuse[`chart.annotation.pass.${id}.reuse`] ?? 0), 1, `${id} should hit when unchanged`);
    }

    const axisCanvasBefore = mainCtx.calls.filter((call) => call.op === "drawImage").at(-1)?.image;
    const mainCallsStart = mainCtx.calls.length;
    const axisCallsStart = axisCanvasBefore?.recordedCtx?.calls.length ?? 0;

    nakedPocs = [{ id: "np-2", market: "BTCUSDT", period: "daily", periodStart: baseTime, periodEnd: baseTime + 120_000, price: 62_165, age: 3, complete: true }];
    refLevels = [{ id: "ref-2", family: "level", period: "daily", label: "REF-2", price: 62_175, color: "#38bdf8", sourceStart: baseTime, sourceEnd: baseTime + 120_000 }];
    pwLevels = [{ id: "pw-2", kind: "line", price: 62_185, label: "PW-2", color: "#fbbf24", sourceStart: baseTime, sourceEnd: baseTime + 120_000 }];

    const beforeUpdatedTail = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    const afterUpdatedTail = snapshotPerformanceTelemetry().counters;
    for (const id of layers) {
      assert.equal((afterUpdatedTail[`chart.annotation.pass.${id}.reuse`] ?? 0) - (beforeUpdatedTail[`chart.annotation.pass.${id}.reuse`] ?? 0), 0, `${id} must miss when level data changes before a DataTail frame`);
    }

    const drawnTexts = mainCtx.calls.slice(mainCallsStart).filter((call) => call.op === "fillText").map((call) => call.text);
    const axisCanvasAfter = mainCtx.calls.slice(mainCallsStart).filter((call) => call.op === "drawImage").at(-1)?.image;
    const axisTexts = axisCanvasAfter?.recordedCtx?.calls.slice(axisCallsStart).filter((call) => call.op === "fillText").map((call) => call.text) ?? [];
    const allTexts = [...drawnTexts, ...axisTexts];
    assert.ok(allTexts.some((text) => text.includes("REF-2")));
    assert.ok(allTexts.some((text) => text.includes("PW-2")));
    assert.ok(allTexts.some((text) => text.startsWith("D-NPOC · 3 ")));
    assert.equal(allTexts.some((text) => text.includes("REF-1") || text.includes("PW-1") || text.startsWith("D-NPOC · 1 ")), false);

    const beforeSecondTail = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    const afterSecondTail = snapshotPerformanceTelemetry().counters;
    for (const id of layers) {
      assert.equal((afterSecondTail[`chart.annotation.pass.${id}.reuse`] ?? 0) - (beforeSecondTail[`chart.annotation.pass.${id}.reuse`] ?? 0), 1, `${id} should hit after caching updated levels`);
    }
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
});

test("ChartLevelContextController.maybeApplyNpoc emits a non-tail invalidation", async () => {
  const invalidateArgs = [];
  const baseTime = Date.UTC(2026, 5, 23, 8, 0);
  const { series } = makeOverlaySeries();
  const view = makeOverlayView();
  const controller = new ChartLevelContextController({
    state: { type: "chart", market: "BTCUSDT", timeframe: "1m", scaleMode: "linear", indicators: [] },
    pipeline: { series },
    view,
    svc: {
      fetchNpocSnapshot: async () => ({
        schemaVersion: 3,
        market: "BTCUSDT",
        levels: [{ period: "daily", periodStart: baseTime, pocLower: 62_140, age: 2 }],
      }),
      getAnalysisContext: () => ({}),
      getAnalysisRevisionSnapshot: () => ({ revision: 1, market: "BTCUSDT" }),
    },
    session: { invalidate: (...args) => invalidateArgs.push(args) },
    replayCoordinator: { isActive: () => false, getSnapshot: () => null },
    isDisposed: () => false,
    updateHook: () => {},
  });

  controller.beginNpocRequest("BTCUSDT");
  await new Promise((resolve) => setTimeout(resolve, 0));
  invalidateArgs.length = 0;
  controller.notifyNpocHistorySettled("BTCUSDT", "1m");
  assert.equal(invalidateArgs.length, 1);
  assert.deepEqual(invalidateArgs[0], [], "maybeApplyNpoc emits bare non-tail session.invalidate()");
  assert.equal(controller.getNpocLevels().length, 1);
  assert.equal(controller.getNpocLevels()[0].price, 62_140);
  controller.dispose();
});
