import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chartLocale, configureChartLocale } from "../dist/core/chartLocale.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { drawPriceAxis, drawPriceMarkers } from "../dist/core/render/priceAxisRenderer.js";
import { drawTimeAxis } from "../dist/core/render/timeAxisRenderer.js";
import { settings } from "../dist/core/settings.js";
import { axisGridLineColor, uiColor } from "../dist/core/ui/seriesPalette.js";

function makeRecordedContext(width = 900, height = 522, ownerDocument = null, initialDpr = 1) {
  const calls = [];
  const stateStack = [];
  let transform = { a: initialDpr, b: 0, c: 0, d: initialDpr, e: 0, f: 0 };
  const canvas = { width, height, clientWidth: Math.round(width / initialDpr), clientHeight: Math.round(height / initialDpr), ownerDocument };

  const ctx = {
    canvas,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    calls,
    save() {
      stateStack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        font: this.font,
        textAlign: this.textAlign,
        textBaseline: this.textBaseline,
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
        transform: { ...transform },
      });
      calls.push({ op: "save" });
    },
    restore() {
      const prev = stateStack.pop();
      if (prev) {
        this.fillStyle = prev.fillStyle;
        this.strokeStyle = prev.strokeStyle;
        this.font = prev.font;
        this.textAlign = prev.textAlign;
        this.textBaseline = prev.textBaseline;
        this.lineWidth = prev.lineWidth;
        this.globalAlpha = prev.globalAlpha;
        transform = prev.transform;
      }
      calls.push({ op: "restore" });
    },
    getTransform() {
      return { ...transform };
    },
    setTransform(a, b, c, d, e, f) {
      transform = { a, b, c, d, e, f };
      calls.push({ op: "setTransform", a, b, c, d, e, f });
    },
    clearRect(x, y, w, h) {
      calls.push({ op: "clearRect", x, y, w, h });
    },
    fillRect(x, y, w, h) {
      calls.push({ op: "fillRect", x, y, w, h, fillStyle: this.fillStyle, transform: { ...transform } });
    },
    strokeRect(x, y, w, h) {
      calls.push({ op: "strokeRect", x, y, w, h, strokeStyle: this.strokeStyle, transform: { ...transform } });
    },
    beginPath() {
      calls.push({ op: "beginPath" });
    },
    rect(x, y, w, h) {
      calls.push({ op: "rect", x, y, w, h });
    },
    clip() {
      calls.push({ op: "clip" });
    },
    moveTo(x, y) {
      calls.push({ op: "moveTo", x, y, transform: { ...transform } });
    },
    lineTo(x, y) {
      calls.push({ op: "lineTo", x, y, transform: { ...transform } });
    },
    roundRect(x, y, w, h, r) {
      calls.push({ op: "roundRect", x, y, w, h, r, fillStyle: this.fillStyle });
    },
    fill() {
      calls.push({ op: "fill", fillStyle: this.fillStyle });
    },
    stroke() {
      calls.push({ op: "stroke", strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha });
    },
    setLineDash(segments) {
      calls.push({ op: "setLineDash", segments: [...segments] });
    },
    fillText(text, x, y) {
      calls.push({ op: "fillText", text, x, y, fillStyle: this.fillStyle, font: this.font, transform: { ...transform } });
    },
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    drawImage(image, dx, dy) {
      calls.push({ op: "drawImage", image, dx, dy, transform: { ...transform } });
    },
  };
  return ctx;
}

function makeMockDocument() {
  const offscreenCanvases = [];
  const doc = {
    offscreenCanvases,
    createElement(tag) {
      assert.equal(tag, "canvas");
      const offCtx = makeRecordedContext(0, 0, null, 1);
      const canvas = offCtx.canvas;
      canvas.getContext = (kind) => (kind === "2d" ? offCtx : null);
      canvas.recordedCtx = offCtx;
      offscreenCanvases.push(canvas);
      return canvas;
    },
  };
  return doc;
}

const BASE_TIME = Date.UTC(2026, 5, 23, 8, 0);

function makeSeries(count = 20, priceStep = 1, pricePrecision = 1) {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep, pricePrecision });
  series.loadBars(Array.from({ length: count }, (_, index) => {
    const startTime = BASE_TIME + index * 60_000;
    const basePrice = 62100 + index * 2;
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
      cells: new Map([
        [basePrice, { priceBin: basePrice, buyVol: 60, sellVol: 40, count: 10, buyCount: 6, sellCount: 4, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      ]),
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
      updatedAt: startTime,
    };
  }));
  return series;
}

function makeOverlay(ctx, { drawForeground, getDisplayOptions } = {}) {
  return new Overlay(
    ctx,
    drawForeground,
    undefined, // getProfileSettings
    undefined, // getPreviousWeekStrategySettings
    undefined, // getPreviousWeekStrategyLevels
    undefined, // getMondayRangeSettings
    undefined, // getMondayRangeLevels
    undefined, // getNakedPocs
    undefined, // getReferenceLevels
    undefined, // getIndicatorPanes
    undefined, // getIndicatorPriceOverlays
    undefined, // getSyncCrosshairTime
    undefined, // onHudText
    undefined, // drawIndicatorPaneBackgroundFn
    undefined, // isMainChartSuppressed
    undefined, // interactionCtx
    undefined, // drawInteractionForeground
    undefined, // drawOrderbookHeatmap
    undefined, // drawOrderbookHover
    getDisplayOptions,
  );
}

function makeView(width = 838, height = 500, dpr = 1) {
  const view = new View();
  view.pixelRatio = dpr;
  view.area = { left: 0, top: 0, width, height };
  view.priceAxisW = view.chartLayoutOptions.priceAxisWidth;
  view.colWidth = 20;
  view.scrollToIndex(19, 2);
  view.fitPriceRange(62080, 62220);
  return view;
}

function counterDelta(before, after) {
  const delta = {};
  for (const [k, v] of Object.entries(after)) {
    const diff = v - (before[k] ?? 0);
    if (diff !== 0) delta[k] = diff;
  }
  return delta;
}

function withTelemetryEnabled(fn) {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    return fn();
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
}

function withSettingsSnapshot(fn) {
  const originalGrid = settings.grid;
  const originalLastPrice = settings.lastPrice;
  try {
    return fn();
  } finally {
    settings.grid = originalGrid;
    settings.lastPrice = originalLastPrice;
  }
}

test("axis layer hits offscreen caches across repeated frames and live last-price tail ticks", () => {
  withSettingsSnapshot(() => withTelemetryEnabled(() => {
    settings.grid = true;
    settings.lastPrice = true;

    const doc = makeMockDocument();
    const ctx = makeRecordedContext(900, 522, doc, 1);
    const series = makeSeries();
    const view = makeView(838, 500, 1);
    const overlay = new Overlay(ctx);
    const crosshair = { x: 0, y: 0, visible: false };
    const layerOrder = ["last-price", "axis"];

    try {
      const c0 = snapshotPerformanceTelemetry().counters;
      overlay.renderAnnotations(view, series, crosshair, [0, series.length], layerOrder);
      const d1 = counterDelta(c0, snapshotPerformanceTelemetry().counters);
      assert.equal(d1["chart.annotation.axis.price.cache.miss"], 1);
      assert.equal(d1["chart.annotation.axis.time.cache.miss"], 1);
      assert.equal(d1["chart.annotation.axis.price.cache.hit"], undefined);
      assert.equal(d1["chart.annotation.axis.time.cache.hit"], undefined);
      assert.equal(doc.offscreenCanvases.length, 2, "one offscreen canvas per axis strip");
      assert.equal(ctx.calls.filter((c) => c.op === "drawImage").length, 2);

      const priceOffCallsAfterBuild = doc.offscreenCanvases[0].recordedCtx.calls.length;
      const timeOffCallsAfterBuild = doc.offscreenCanvases[1].recordedCtx.calls.length;
      assert.ok(doc.offscreenCanvases[0].recordedCtx.calls.some((c) => c.op === "fillText"), "price labels painted offscreen");
      assert.ok(doc.offscreenCanvases[1].recordedCtx.calls.some((c) => c.op === "fillText"), "time labels painted offscreen");

      // Simulate high-frequency live tail trade ticks modifying only the latest bar's price/volume.
      for (const [stepIdx, nextPrice] of [62155, 62162, 62148].entries()) {
        ctx.calls.length = 0;
        series.addTrade({ price: nextPrice, qty: 2, isBuy: true, time: BASE_TIME + 19 * 60_000 + (stepIdx + 1) * 1_000 });
        const before = snapshotPerformanceTelemetry().counters;
        overlay.renderAnnotations(view, series, crosshair, [0, series.length], layerOrder);
        const delta = counterDelta(before, snapshotPerformanceTelemetry().counters);

        assert.equal(delta["chart.annotation.axis.price.cache.hit"], 1, "live last-price tick reuses price axis bitmap");
        assert.equal(delta["chart.annotation.axis.time.cache.hit"], 1, "live last-price tick reuses time axis bitmap");
        assert.equal(delta["chart.annotation.axis.price.cache.miss"], undefined);
        assert.equal(delta["chart.annotation.axis.time.cache.miss"], undefined);
        assert.equal(doc.offscreenCanvases[0].recordedCtx.calls.length, priceOffCallsAfterBuild, "no offscreen price redraw");
        assert.equal(doc.offscreenCanvases[1].recordedCtx.calls.length, timeOffCallsAfterBuild, "no offscreen time redraw");

        const drawImages = ctx.calls.filter((c) => c.op === "drawImage");
        assert.equal(drawImages.length, 2, "cached axis strips blitted onto main ctx");
        const liveMarkerText = ctx.calls.filter(
          (c) => c.op === "fillText" && c.font === "11px ui-monospace, monospace" && c.text === `Price ${nextPrice.toFixed(1)}`,
        );
        assert.equal(liveMarkerText.length, 1, `live last-price marker for ${nextPrice} must still render live`);
      }
    } finally {
      overlay.dispose();
    }
  }));
});

test("axis cache invalidates independently on scale, viewport, DPR, locale, settings, timeMarkers, context-loss and dispose", () => {
  const prevLocale = chartLocale();
  let activeLocale = "en-US";
  let activeTz = "UTC";
  configureChartLocale({
    locale: () => activeLocale,
    timeZone: () => activeTz,
    translate: prevLocale.translate,
    onLocaleChange: prevLocale.onLocaleChange,
  });

  try {
    withSettingsSnapshot(() => withTelemetryEnabled(() => {
      settings.grid = true;
      settings.lastPrice = false;

      let customLocale = "en-US";
      let activeTimeMarker = null;
      const doc = makeMockDocument();
      const ctx = makeRecordedContext(900, 522, doc, 1);
      const series = makeSeries();
      const view = makeView(838, 500, 1);
      const overlay = makeOverlay(ctx, {
        drawForeground: () => {
          if (activeTimeMarker) {
            overlay.queueTimeObject(activeTimeMarker.time, activeTimeMarker.text, activeTimeMarker.color);
          }
        },
        getDisplayOptions: () => ({
          labels: { trades: "Trades", range: "Range", change: "Chg", volume: "Vol", price: "Price" },
          numberLocale: customLocale,
          layout: view.chartLayoutOptions,
          timeScale: {},
          maxDevicePixelRatio: null,
          webgl: { antialias: true, powerPreference: "default" },
        }),
      });
      const layerOrder = ["drawings", "axis"];

      const renderDelta = (crosshair = { x: 0, y: 0, visible: false }) => {
        ctx.calls.length = 0;
        const before = snapshotPerformanceTelemetry().counters;
        overlay.renderAnnotations(view, series, crosshair, [0, series.length], layerOrder);
        return counterDelta(before, snapshotPerformanceTelemetry().counters);
      };

      try {
        // Initial miss
        let d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);

        // 1. Price autoscale widen / zoomY -> price misses, time hits
        view.fitPriceRange(62000, 62400);
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);

        // 2. Price scale mode switch linear <-> log -> price misses, time hits
        view.setScaleMode("log");
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);

        // 3. Number locale change -> price misses, time hits
        customLocale = "de-DE";
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);

        // 4. Touch keepOut toggle -> price misses, time hits
        d = renderDelta({ x: 0, y: 0, visible: false, touch: true });
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);
        d = renderDelta({ x: 0, y: 0, visible: false, touch: false });
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);

        // 5. series.config.pricePrecision / priceStep change -> price misses, time hits
        series.config.pricePrecision = 2;
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);

        // 6. settings.grid toggle -> NEITHER rebuilds offscreen bitmap, grid lines toggle directly on main ctx
        settings.grid = false;
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);
        assert.equal(ctx.calls.filter((c) => c.op === "stroke" && c.strokeStyle === axisGridLineColor).length, 0);

        settings.grid = true;
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);
        assert.ok(ctx.calls.filter((c) => c.op === "stroke" && c.strokeStyle === axisGridLineColor).length > 0);

        // 7. Horizontal pan/zoom -> short jumps cache, active pan (>= 3 consecutive moves) bypasses offscreen time cache, price hits
        view.panX(-20);
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.bypass"], undefined);

        view.panX(-20);
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.bypass"], undefined);

        view.panX(-40);
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.bypass"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], undefined);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], undefined);

        // 8. New bar append (structureRevision / length change) -> time misses, price hits
        series.addTrade({ price: 62180, qty: 1, isBuy: true, time: BASE_TIME + 20 * 60_000 });
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);

        // 9. Time marker added/moved -> time misses, unchanged marker -> time hits
        activeTimeMarker = { time: BASE_TIME + 10 * 60_000, text: "T1", color: "#ff0000" };
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.hit"], 1);
        activeTimeMarker = { time: BASE_TIME + 12 * 60_000, text: "T1", color: "#ff0000" };
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);

        // 10. Timezone change -> time misses, price hits
        activeTz = "Europe/Istanbul";
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);

        // 11. Viewport resize -> both miss and resize offscreen canvases
        ctx.canvas.width = 1000;
        ctx.canvas.height = 600;
        view.area = { left: 0, top: 0, width: 938, height: 578 };
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);

        // 12. DPR / canvas transform change (including fractional DPR) -> both miss and scale bitmaps
        const prevTimeH = doc.offscreenCanvases[1].height;
        ctx.canvas.width = 1500;
        ctx.canvas.height = 900;
        ctx.setTransform(1.5, 0, 0, 1.5, 0, 0);
        view.pixelRatio = 1.5;
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);
        assert.ok(doc.offscreenCanvases[1].height > prevTimeH, "offscreen canvas grew with fractional DPR 1.5");

        // 13. Context-loss / explicit invalidation -> both miss cleanly on next render without allocating new DOM nodes
        const canvasCountBeforeReset = doc.offscreenCanvases.length;
        overlay.invalidateAxisCache();
        d = renderDelta();
        assert.equal(d["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(d["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(doc.offscreenCanvases.length, canvasCountBeforeReset, "reuses offscreen canvases across reset");

        // 14. dispose() drops offscreen canvas dimensions and releases backing memory
        overlay.dispose();
        assert.equal(doc.offscreenCanvases[0].width, 0);
        assert.equal(doc.offscreenCanvases[0].height, 0);
        assert.equal(doc.offscreenCanvases[1].width, 0);
        assert.equal(doc.offscreenCanvases[1].height, 0);
      } finally {
        overlay.dispose();
      }
    }));
  } finally {
    configureChartLocale(prevLocale);
  }
});

test("cached axis draw produces identical grid lines, tick labels, markers and sub-pane separators to direct draw", () => {
  withSettingsSnapshot(() => {
    settings.grid = true;
    settings.lastPrice = true;

    const doc = makeMockDocument();
    const cachedCtx = makeRecordedContext(900, 522, doc, 1);
    const directCtx = makeRecordedContext(900, 522, null, 1);
    const series = makeSeries();
    const view = makeView(838, 400, 1);
    view.subPanesH = 100; // Verify sub-pane separator segment between plot bottom and corner top

    const overlay = new Overlay(cachedCtx);
    try {
      overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, series.length], ["last-price", "axis"]);

      // Direct uncached baseline sequence matching renderAnnotations "last-price" + "axis"
      const lastBar = series.at(series.length - 1);
      drawPriceAxis(directCtx, view, series.config.priceStep, series.config.pricePrecision, []);
      drawPriceMarkers(directCtx, view, [{ price: lastBar.close, color: uiColor.buy, priority: 100 }], series.config.priceStep, series.config.pricePrecision);
      drawTimeAxis(directCtx, view, series, undefined, []);

      // Plot grid line y positions & colors match identically
      const gridStrokes = (ctx) => ctx.calls
        .map((call, idx, arr) => ({ call, prev: arr[idx - 1], prev2: arr[idx - 2] }))
        .filter((item) => item.call.op === "stroke" && item.call.strokeStyle === axisGridLineColor)
        .map((item) => ({ x1: item.prev2.x, y1: item.prev2.y, x2: item.prev.x, y2: item.prev.y }));
      assert.deepEqual(gridStrokes(cachedCtx), gridStrokes(directCtx));

      // Sub-pane separator stroke [gutterFillH .. cornerRect.top] is emitted directly on main ctx
      const subPaneSep = cachedCtx.calls
        .map((call, idx, arr) => ({ call, lineTo: arr[idx - 1], moveTo: arr[idx - 2] }))
        .filter((item) => item.call.op === "stroke" && item.call.strokeStyle === uiColor.separator);
      assert.equal(subPaneSep.length, 1);
      assert.equal(subPaneSep[0].moveTo.y, 400);
      assert.equal(subPaneSep[0].lineTo.y, 500);

      // Price-axis labels rendered in offscreen strip match direct price-axis fillText calls
      const priceLabels = (calls) => calls
        .filter((c) => c.op === "fillText" && c.font === "12px ui-monospace, monospace")
        .map((c) => ({ text: c.text, x: c.x, y: c.y }));
      assert.deepEqual(priceLabels(doc.offscreenCanvases[0].recordedCtx.calls), priceLabels(directCtx.calls));

      // Live price marker rendered directly on main ctx matches direct drawPriceMarkers output
      const markerLabels = (calls) => calls
        .filter((c) => c.op === "fillText" && c.font === "11px ui-monospace, monospace" && c.y <= 400)
        .map((c) => ({ text: c.text, x: c.x, y: c.y }));
      assert.equal(markerLabels(cachedCtx.calls).length, 1);
      assert.deepEqual(markerLabels(cachedCtx.calls), markerLabels(directCtx.calls));

      // Time-axis labels rendered in offscreen strip match direct time-axis fillText calls
      const timeLabels = (calls) => calls
        .filter((c) => c.op === "fillText" && c.font === "11px ui-monospace, monospace" && c.y >= 500)
        .map((c) => ({ text: c.text, x: c.x, y: c.y }));
      assert.ok(timeLabels(directCtx.calls).length > 0);
      assert.deepEqual(timeLabels(doc.offscreenCanvases[1].recordedCtx.calls), timeLabels(directCtx.calls));
    } finally {
      overlay.dispose();
    }
  });
});

test("falls back directly to main ctx when offscreen canvas creation is unavailable", () => {
  withSettingsSnapshot(() => withTelemetryEnabled(() => {
    settings.grid = true;
    settings.lastPrice = true;

    const ctx = makeRecordedContext(900, 522, null, 1);
    const series = makeSeries();
    const view = makeView(838, 500, 1);
    const overlay = makeOverlay(ctx);
    try {
      const before = snapshotPerformanceTelemetry().counters;
      overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, series.length], ["last-price", "axis"]);
      const delta = counterDelta(before, snapshotPerformanceTelemetry().counters);

      assert.equal(delta["chart.annotation.axis.price.cache.hit"], undefined);
      assert.equal(delta["chart.annotation.axis.time.cache.hit"], undefined);
      assert.equal(ctx.calls.filter((c) => c.op === "drawImage").length, 0);
      assert.ok(ctx.calls.some((c) => c.op === "fillText" && c.font === "12px ui-monospace, monospace"));
    } finally {
      overlay.dispose();
    }
  }));
});

test("time axis bypasses offscreen cache during active pan/zoom and resumes caching once stationary", () => {
  const prevLocale = chartLocale();
  let activeTz = "UTC";
  configureChartLocale({
    locale: () => "en-US",
    timeZone: () => activeTz,
    translate: prevLocale.translate,
    onLocaleChange: prevLocale.onLocaleChange,
  });

  try {
    withSettingsSnapshot(() => withTelemetryEnabled(() => {
      settings.grid = true;
      settings.lastPrice = true;

      const doc = makeMockDocument();
      const ctx = makeRecordedContext(900, 522, doc, 1);
      const series = makeSeries();
      const view = makeView(838, 500, 1);
      const initialOffsetX = view.offsetX;
      const initialColWidth = view.colWidth;
      let activeTimeMarker = null;

      const overlay = makeOverlay(ctx, {
        drawForeground: () => {
          if (activeTimeMarker) {
            overlay.queueTimeObject(activeTimeMarker.time, activeTimeMarker.text, activeTimeMarker.color);
          }
        },
      });
      const layerOrder = ["drawings", "last-price", "axis"];
      const crosshair = { x: 0, y: 0, visible: false };

      const renderStep = () => {
        ctx.calls.length = 0;
        const before = snapshotPerformanceTelemetry().counters;
        overlay.renderAnnotations(view, series, crosshair, [0, series.length], layerOrder);
        const delta = counterDelta(before, snapshotPerformanceTelemetry().counters);
        return {
          delta,
          drawImages: ctx.calls.filter((c) => c.op === "drawImage").length,
        };
      };

      const timeLabelsInCalls = (calls, activeView) => {
        const axisTop = activeView.area.top + activeView.area.height + activeView.subPanesH;
        return calls
          .filter((c) => c.op === "fillText" && c.font === "11px ui-monospace, monospace" && c.y >= axisTop)
          .map((c) => ({ text: c.text, x: c.x, y: c.y, fillStyle: c.fillStyle }));
      };

      try {
        // 1. Cold start fills both offscreen caches; next stationary frame hits both.
        const cold = renderStep();
        assert.equal(cold.delta["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(cold.delta["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(cold.drawImages, 2);

        const warm = renderStep();
        assert.equal(warm.delta["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(warm.delta["chart.annotation.axis.time.cache.hit"], 1);
        assert.equal(warm.drawImages, 2);

        let offTimeCalls = doc.offscreenCanvases[1].recordedCtx.calls.length;

        // 2a. A single one-shot jump stays cached (and immediately hits if stationary on the next frame).
        view.panX(-15);
        const singleJump = renderStep();
        assert.equal(singleJump.delta["chart.annotation.axis.price.cache.hit"], 1);
        assert.equal(singleJump.delta["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(singleJump.delta["chart.annotation.axis.time.cache.bypass"], undefined);
        assert.equal(singleJump.drawImages, 2);

        const stationaryAfterJump = renderStep();
        assert.equal(stationaryAfterJump.delta["chart.annotation.axis.time.cache.hit"], 1);
        assert.equal(stationaryAfterJump.delta["chart.annotation.axis.time.cache.bypass"], undefined);

        // 2b. Active horizontal pan across consecutive frames warms frames 1-2 then bypasses offscreen time cache from frame 3.
        view.panX(-12);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.panX(-12);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        offTimeCalls = doc.offscreenCanvases[1].recordedCtx.calls.length;

        for (const dx of [-20, -18]) {
          view.panX(dx);
          const p = renderStep();
          assert.equal(p.delta["chart.annotation.axis.price.cache.hit"], 1);
          assert.equal(p.delta["chart.annotation.axis.time.cache.bypass"], 1);
          assert.equal(p.delta["chart.annotation.axis.time.cache.miss"], undefined);
          assert.equal(p.delta["chart.annotation.axis.time.cache.hit"], undefined);
          assert.equal(p.drawImages, 1, "only price axis is blitted during time-axis pan bypass");
          assert.equal(doc.offscreenCanvases[1].recordedCtx.calls.length, offTimeCalls, "time offscreen canvas untouched while panning");

          const direct = makeRecordedContext(ctx.canvas.width, ctx.canvas.height, null, view.pixelRatio ?? 1);
          drawTimeAxis(direct, view, series, undefined, []);
          assert.deepEqual(timeLabelsInCalls(ctx.calls, view), timeLabelsInCalls(direct.calls, view));
        }

        // 3. Changing only colWidth (zoom) during consecutive motion also triggers bypass without offscreen draw/blit.
        view.colWidth = 26;
        const zoomed = renderStep();
        assert.equal(zoomed.delta["chart.annotation.axis.time.cache.bypass"], 1);
        assert.equal(zoomed.drawImages, 1);
        assert.equal(doc.offscreenCanvases[1].recordedCtx.calls.length, offTimeCalls);

        // 4. Stopping pan/zoom rebuilds offscreen time cache on first stationary frame, then hits on live tail ticks.
        const stopped = renderStep();
        assert.equal(stopped.delta["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(stopped.delta["chart.annotation.axis.time.cache.bypass"], undefined);
        assert.equal(stopped.drawImages, 2);
        offTimeCalls = doc.offscreenCanvases[1].recordedCtx.calls.length;

        for (const [idx, price] of [62151, 62159].entries()) {
          series.addTrade({ price, qty: 1, isBuy: true, time: BASE_TIME + 19 * 60_000 + (idx + 1) * 1_000 });
          const burst = renderStep();
          assert.equal(burst.delta["chart.annotation.axis.price.cache.hit"], 1);
          assert.equal(burst.delta["chart.annotation.axis.time.cache.hit"], 1);
          assert.equal(burst.delta["chart.annotation.axis.time.cache.bypass"], undefined);
          assert.equal(burst.drawImages, 2);
          assert.equal(doc.offscreenCanvases[1].recordedCtx.calls.length, offTimeCalls);
        }

        // 5. Panning back to exact initial (offsetX, colWidth) during active pan bypasses without reusing stale entry.
        view.offsetX = initialOffsetX + 16;
        view.colWidth = initialColWidth;
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.offsetX = initialOffsetX + 8;
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.offsetX = initialOffsetX;
        const returned = renderStep();
        assert.equal(returned.delta["chart.annotation.axis.time.cache.bypass"], 1);
        assert.equal(returned.delta["chart.annotation.axis.time.cache.hit"], undefined);
        assert.equal(returned.drawImages, 1);

        // Settle once, verify stationary hit, then verify resize/DPR/marker/timezone invalidations stay accurate.
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.hit"], 1);

        ctx.canvas.width = 1500;
        ctx.canvas.height = 900;
        ctx.setTransform(1.5, 0, 0, 1.5, 0, 0);
        view.pixelRatio = 1.5;
        view.area = { left: 0, top: 0, width: 938, height: 578 };
        const dprMiss = renderStep();
        assert.equal(dprMiss.delta["chart.annotation.axis.price.cache.miss"], 1);
        assert.equal(dprMiss.delta["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.hit"], 1);

        // Active marker while panning draws directly on main ctx matching drawTimeAxis output, then caches when stopped.
        activeTimeMarker = { time: BASE_TIME + 12 * 60_000, text: "M1", color: "#00ff00" };
        view.panX(-10);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.panX(-10);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.panX(-10);
        const markerPan = renderStep();
        assert.equal(markerPan.delta["chart.annotation.axis.time.cache.bypass"], 1);
        const directWithMarker = makeRecordedContext(1500, 900, null, 1.5);
        drawTimeAxis(directWithMarker, view, series, undefined, [activeTimeMarker]);
        assert.deepEqual(timeLabelsInCalls(ctx.calls, view), timeLabelsInCalls(directWithMarker.calls, view));

        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.hit"], 1);

        // Timezone change when stationary invalidates offscreen cache cleanly.
        activeTz = "Asia/Tokyo";
        doc.offscreenCanvases[1].recordedCtx.calls.length = 0;
        const tzMiss = renderStep();
        assert.equal(tzMiss.delta["chart.annotation.axis.time.cache.miss"], 1);
        const directTz = makeRecordedContext(1500, 900, null, 1.5);
        drawTimeAxis(directTz, view, series, undefined, [activeTimeMarker]);
        assert.deepEqual(timeLabelsInCalls(doc.offscreenCanvases[1].recordedCtx.calls, view), timeLabelsInCalls(directTz.calls, view));

        // Explicit invalidateAxisCache resets pan streak so full 3-move ramp is required after reset.
        view.panX(-5);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.panX(-5);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        overlay.invalidateAxisCache();
        const afterReset = renderStep();
        assert.equal(afterReset.delta["chart.annotation.axis.time.cache.miss"], 1);
        assert.equal(afterReset.delta["chart.annotation.axis.time.cache.bypass"], undefined);
        view.panX(-5);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.panX(-5);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.miss"], 1);
        view.panX(-5);
        assert.equal(renderStep().delta["chart.annotation.axis.time.cache.bypass"], 1);
      } finally {
        overlay.dispose();
      }
    }));
  } finally {
    configureChartLocale(prevLocale);
  }
});

test("ChartRuntime wires overlay axis cache invalidation on context loss/restore and overlay disposal on teardown", () => {
  const source = readFileSync(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /onLostContext:[\s\S]*?this\.overlay\.invalidateAxisCache\(\)/);
  assert.match(source, /onRestoreContext:[\s\S]*?this\.overlay\.invalidateAxisCache\(\)/);
  assert.match(source, /dispose\(\):\s*void[\s\S]*?this\.overlay\.dispose\(\)/);
});
