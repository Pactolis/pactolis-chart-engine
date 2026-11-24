import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { settings } from "../dist/core/settings.js";
import { footprintAutoscaleSource, footprintVisiblePriceRange } from "../dist/core/model/footprintAutoscale.js";
import { configurePerformanceTelemetry, incrementPerformanceCounter, isPerformanceTelemetryEnabled, measurePerformance, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";
import { getGpuDiagnostics, resetGpuDiagnostics } from "../dist/core/gpu/gpuDiagnostics.js";
import { configureOrderbookHeatmapSettingsSource, orderbookHeatmapSettingsSource } from "../dist/features/orderbook/heatmapSettingsSource.js";
import { ChartInputController } from "../dist/features/chart/ChartInputController.js";
import { ChartHeatmapGpuCoordinator } from "../dist/features/chart/ChartHeatmapGpuCoordinator.js";
import { HeatmapGpuRenderer } from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";

const MARKET = "BINANCE_FUTURES:btcusdt";
const MINUTE = 60_000;

async function withHeatmapSettings(settingsFor, work) {
  let prev = null;
  try { prev = orderbookHeatmapSettingsSource(); } catch {}
  const listeners = new Set();
  configureOrderbookHeatmapSettingsSource({
    settingsFor,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  try {
    return await work();
  } finally {
    if (prev) configureOrderbookHeatmapSettingsSource(prev);
  }
}

function makeFakeGl() {
  let geomUploadBytes = 0;
  let texUploadBytes = 0;
  const uniform1fCalls = new Map();
  const uniformLocations = new Map();
  let nextLoc = 1;
  const noop = () => {};
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    R32F: 0x822e,
    R8: 0x8229,
    RED: 0x1903,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0x0cf5,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    CULL_FACE: 0x0b44,
    DEPTH_TEST: 0x0b71,
    STENCIL_TEST: 0x0b90,
    RASTERIZER_DISCARD: 0x8c89,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ONE: 1,
    SCISSOR_TEST: 0x0c11,
    TRIANGLES: 0x0004,
    MAX_TEXTURE_SIZE: 0x0d33,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    drawingBufferWidth: 800,
    drawingBufferHeight: 400,
    canvas: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } },
    getParameter: () => 4096,
    createShader: () => ({}),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => true,
    deleteShader: noop,
    deleteProgram: noop,
    getUniformLocation: (_prog, name) => {
      const loc = { id: nextLoc++, name };
      uniformLocations.set(loc, name);
      return loc;
    },
    getAttribLocation: () => 0,
    createVertexArray: () => ({}),
    deleteVertexArray: noop,
    createBuffer: () => ({}),
    deleteBuffer: noop,
    bindVertexArray: noop,
    bindBuffer: noop,
    bufferData: (_target, data) => {
      if (typeof data === "number") geomUploadBytes += data;
      else if (data && typeof data.byteLength === "number") geomUploadBytes += data.byteLength;
    },
    bufferSubData: (_target, _offset, view) => {
      if (view && typeof view.byteLength === "number") geomUploadBytes += view.byteLength;
    },
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    vertexAttribDivisor: noop,
    createTexture: () => ({}),
    deleteTexture: noop,
    bindTexture: noop,
    texParameteri: noop,
    texImage2D: (_t, _lvl, _intFmt, _w, _h, _b, _fmt, _type, data) => {
      if (data && typeof data.byteLength === "number") texUploadBytes += data.byteLength;
    },
    texSubImage2D: (_t, _lvl, _x, _y, _w, _h, _fmt, _type, data) => {
      if (data && typeof data.byteLength === "number") texUploadBytes += data.byteLength;
    },
    pixelStorei: noop,
    viewport: noop,
    useProgram: noop,
    uniform2f: noop,
    uniform1f: (loc, val) => {
      const name = uniformLocations.get(loc);
      if (name) uniform1fCalls.set(name, val);
    },
    uniform1i: noop,
    activeTexture: noop,
    disable: noop,
    enable: noop,
    blendFunc: noop,
    blendFuncSeparate: noop,
    scissor: noop,
    drawArraysInstanced: noop,
  };
  return {
    gl,
    resetUploads() {
      geomUploadBytes = 0;
      texUploadBytes = 0;
      uniform1fCalls.clear();
    },
    getUploads() {
      return { geomUploadBytes, texUploadBytes, panOffsetX: uniform1fCalls.get("u_panOffsetX") };
    },
  };
}

function makeHeatmapSeries(length = 20) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(Array.from({ length }, (_, i) => ({
    startTime: (1_000 + i) * MINUTE,
    open: 50_100,
    high: 50_500,
    low: 49_900,
    close: 50_200,
    volume: 10,
    delta: 0,
    count: 1,
    cells: new Map(),
    hasRef: true,
  })));
  return series;
}

function makeHeatmapView(offsetX = 0) {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 20;
  view.offsetX = offsetX;
  view.priceTop = 50_500;
  view.pricePerPx = 2;
  view.pixelRatio = 1;
  return view;
}

test("#356: WebGL2 GPU heatmap pan reuses prepared frame with 0 B geometry/texture upload and updates u_panOffsetX", async () => {
  resetGpuDiagnostics();
  const fake = makeFakeGl();
  let overlay;
  let coordinator;
  let now = 1_020 * MINUTE;

  await withHeatmapSettings(() => ({
    mode: "single",
    unit: "btc",
    bucketStep: 25,
    opacity: 0.65,
    scaleMode: "fixed",
    fixedCeiling: { usd: 100_000_000, btc: 200 },
    single: { usd: 1, btc: 10 },
    aggregated: { usd: 1, btc: 10 },
  }), async () => {
    const series = makeHeatmapSeries(20);
    const view = makeHeatmapView(0);
    overlay = new OrderbookHeatmapOverlay({
      fetch: async (req) => ({
        schemaVersion: 1,
        generatedAt: now,
        base: "BTC",
        source: req.source,
        resolution: req.resolution,
        bucketStep: req.bucketStep,
        from: req.from,
        to: req.to,
        bars: Array.from({ length: 20 }, (_, i) => ({
          t: (1_000 + i) * MINUTE,
          cells: [[50_000, 600_000, 600_000]],
        })),
      }),
      invalidate: () => {},
      getMarket: () => MARKET,
      now: () => now,
    });

    // Warm up chunks
    overlay.getPrepareCacheKey(view, series, [0, 19]);
    await new Promise((r) => setTimeout(r, 20));

    coordinator = new ChartHeatmapGpuCoordinator({
      backendKind: "webgl2",
      orderbookHeatmap: overlay,
      renderCoordinator: { getAnnotationLayerOrder: () => ["orderbook-heatmap"] },
      renderer: {
        visibleRange: (v, len) => [
          Math.max(0, Math.floor(v.indexOfX(v.area.left))),
          Math.min(len, Math.ceil(v.indexOfX(v.area.left + v.area.width))),
        ],
      },
      invalidateSession: () => {},
    });
    coordinator.setHeatmapTexturePrototypeEnabled(true);
    await coordinator.whenHeatmapGpuRendererReady();
    coordinator.setGl(fake.gl);

    // Frame 1: initial anchor at offsetX = 0
    coordinator.beginFrameAttempt();
    const f1 = coordinator.prepareHeatmapGpuCells(view, series);
    assert.ok(f1, "initial GPU frame prepared");
    assert.equal(f1.anchorOffsetX, 0);
    assert.equal(f1.panOffsetX, 0);
    coordinator.renderHeatmapGpuCells(f1, view, series);
    const up1 = fake.getUploads();
    assert.ok(up1.geomUploadBytes > 0, "initial frame uploads geometry");
    assert.ok(up1.texUploadBytes > 0, "initial frame uploads texture");
    assert.equal(up1.panOffsetX, 0);
    assert.equal(getGpuDiagnostics().featurePaths?.heatmap, "webgl2");

    // Frame 2: sub-bar 0.25 px pan within same visible [from, to) range
    fake.resetUploads();
    view.offsetX = 0.25;
    coordinator.beginFrameAttempt();
    const f2 = coordinator.prepareHeatmapGpuCells(view, series);
    assert.ok(f2, "pan frame reuses cached prepared frame");
    assert.equal(f2.panOffsetX, 0.25);
    assert.equal(f2.main, f1.main, "reuses exact prepared main array reference");
    coordinator.renderHeatmapGpuCells(f2, view, series);
    const up2 = fake.getUploads();
    assert.equal(up2.geomUploadBytes, 0, "0 B geometry upload on same-range pan");
    assert.equal(up2.texUploadBytes, 0, "0 B texture upload on same-range pan");
    assert.equal(up2.panOffsetX, 0.25, "u_panOffsetX receives delta 0.25");

    // Frame 3: pan across bar boundary -> visible range changes -> re-prepares & re-uploads
    fake.resetUploads();
    view.offsetX = 25;
    coordinator.beginFrameAttempt();
    const f3 = coordinator.prepareHeatmapGpuCells(view, series);
    assert.ok(f3, "boundary-crossing pan prepares fresh frame");
    assert.notEqual(f3.main, f1.main, "fresh main array on boundary crossing");
    assert.equal(f3.anchorOffsetX, 25);
    assert.equal(f3.panOffsetX, 0);
    coordinator.renderHeatmapGpuCells(f3, view, series);
    const up3 = fake.getUploads();
    assert.ok(up3.geomUploadBytes > 0, "boundary crossing uploads fresh geometry");
  });
  coordinator?.dispose();
  overlay?.dispose();
  resetGpuDiagnostics();
});

test("#357: ChartInputController caches getBoundingClientRect when ResizeObserver exists and invalidates on resize/scroll/observer/zero-width", () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;
  const observerInstances = [];
  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      observerInstances.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  };

  try {
    const canvasListeners = new Map();
    const winListeners = new Map();
    let rect = { left: 10, top: 20, width: 400, height: 300 };
    let rectCalls = 0;

    const ownerWindow = {
      addEventListener(type, fn, opts) {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add({ fn, capture: Boolean(opts && typeof opts === "object" ? opts.capture : opts) });
      },
      removeEventListener(type, fn, opts) {
        const set = winListeners.get(type);
        if (!set) return;
        const capture = Boolean(opts && typeof opts === "object" ? opts.capture : opts);
        for (const entry of set) {
          if (entry.fn === fn && entry.capture === capture) set.delete(entry);
        }
      },
      document: { addEventListener() {}, removeEventListener() {} },
    };

    const canvas = {
      ownerDocument: { defaultView: ownerWindow },
      parentElement: null,
      style: { cursor: "" },
      addEventListener(type, fn) {
        if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
        canvasListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { canvasListeners.get(type)?.delete(fn); },
      setPointerCapture() {},
      releasePointerCapture() {},
      hasPointerCapture() { return false; },
      focus() {},
      dispatchEvent() { return true; },
      getBoundingClientRect() {
        rectCalls += 1;
        return { x: rect.left, y: rect.top, ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
      },
    };

    const emitCanvas = (type, init = {}) => {
      const event = {
        pointerId: 1, button: 0, pointerType: "mouse", clientX: 50, clientY: 60,
        deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
        target: canvas, preventDefault() {}, ...init,
      };
      for (const fn of canvasListeners.get(type) ?? []) fn(event);
    };
    const emitWin = (type) => {
      for (const entry of winListeners.get(type) ?? []) entry.fn();
    };

    const view = {
      area: { left: 0, top: 0, width: 350, height: 250 },
      priceAxisW: 50, subPanesH: 0, chartLayoutOptions: { timeAxisHeight: 50 },
      priceTop: 100, pricePerPx: 1,
      isPriceAutoScale: () => false, setPriceAutoScale() {},
      indexOfX: (x) => x, priceOfY: (y) => 500 - y,
      startPriceAxisScale() {}, scalePriceAxisTo() {}, endPriceAxisScale() {}, zoomY() {},
    };
    const host = {
      svc: { getAnalysisContext: () => ({ drawings: { activeTool: null, setMarket() {}, hasDraft: () => false, isPointerDragActive: () => false, peekAt: () => null, pointerDown: () => false, pointerMove: () => true, pointerUp: () => true } }) },
      view,
      session: { invalidate() {}, invalidateSurface() {} },
      pipeline: { series: { length: 100 } },
      overlay: { getIndicatorAxisPaneAt: () => null, getIndicatorScaleControlAt: () => null, getPriceScaleControlAt: () => null, getMenuButtonAt: () => null, getMenuButtonRect: () => null, getTpoProfileAt: () => null },
      timeViewport: { beginPlotPan() {}, dragPlotPanTo() {}, endPlotPan() {}, beginTimeAxisScale() {}, dragTimeAxisScaleTo() {}, endTimeAxisScale() {}, zoomPlot() {}, panPlot() {} },
      state: { market: MARKET, timeframe: "15m" },
      panelId: "rect-cache-unit",
      applyingExternal: false,
      isReplaySelecting: () => false,
      previewReplayStart() {},
      screenToDrawingPoint: (cx, cy) => ({ time: cx, price: cy }),
      indexToTime: (idx) => idx,
      resolveScreenCrosshair: (cx, cy) => ({ time: cx, price: cy }),
      notifyCrosshair() {},
      autoFit() {},
      emitVisibleRange() {},
      clearMagnetSnap() {},
      scaleIndicatorPane: () => false,
      setPriceAutoScaleFromControl() {},
      togglePriceScaleModeFromControl() {},
      resetIndicatorPaneScale() {},
      toggleIndicatorScaleModeFromControl() {},
    };

    const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false, touch: false }, host);
    assert.equal(observerInstances.length, 1);

    emitCanvas("pointermove", { clientX: 50, clientY: 60 });
    emitCanvas("pointermove", { clientX: 55, clientY: 65 });
    emitCanvas("pointerdown", { clientX: 55, clientY: 65 });
    emitCanvas("wheel", { clientX: 55, clientY: 65, deltaY: 10 });
    assert.equal(rectCalls, 1, "pointermove/pointerdown/wheel reuse cached rect");

    observerInstances[0].cb();
    emitCanvas("pointermove", { clientX: 60, clientY: 70 });
    assert.equal(rectCalls, 2, "ResizeObserver invalidates cached rect");

    emitWin("resize");
    emitCanvas("pointermove", { clientX: 61, clientY: 71 });
    assert.equal(rectCalls, 3, "window resize invalidates cached rect");

    emitWin("scroll");
    emitCanvas("pointermove", { clientX: 62, clientY: 72 });
    assert.equal(rectCalls, 4, "window scroll invalidates cached rect");

    rect = { left: 0, top: 0, width: 0, height: 0 };
    emitWin("resize");
    emitCanvas("pointermove", { clientX: 63, clientY: 73 });
    assert.equal(rectCalls, 5);
    rect = { left: 0, top: 0, width: 400, height: 300 };
    emitCanvas("pointermove", { clientX: 64, clientY: 74 });
    assert.equal(rectCalls, 6, "zero-width rect is not retained");

    controller.dispose();
    assert.equal(observerInstances[0].disconnected, true, "dispose disconnects ResizeObserver");
    assert.equal(winListeners.get("resize")?.size ?? 0, 0, "dispose removes resize listener");
    assert.equal(winListeners.get("scroll")?.size ?? 0, 0, "dispose removes scroll listener");
  } finally {
    globalThis.ResizeObserver = OriginalResizeObserver;
  }
});

test("#358A: _autoFit skips redundant _fitToData on sub-bar horizontal pan and re-runs on boundary crossing", async () => {
  const source = await readFile(new URL("../dist/features/chart/ChartRuntime.js", import.meta.url), "utf8");
  const extract = (name) => {
    const start = source.indexOf(`${name}() {`);
    assert.notEqual(start, -1, `found ${name}`);
    let depth = 0;
    let open = false;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") { depth++; open = true; }
      else if (source[i] === "}" && open) {
        depth--;
        if (depth === 0) return `function ${source.slice(start, i + 1)}`;
      }
    }
    throw new Error(`unclosed ${name}`);
  };
  const bindings = { settings, footprintVisiblePriceRange, footprintAutoscaleSource, incrementPerformanceCounter, measurePerformance };
  const _fitToData = new Function(...Object.keys(bindings), `return ${extract("_fitToData")};`)(...Object.values(bindings));
  const _autoFit = new Function(...Object.keys(bindings), `return ${extract("_autoFit")};`)(...Object.values(bindings));

  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(Array.from({ length: 10 }, (_, i) => ({
    startTime: (1_000 + i) * MINUTE,
    open: 100 + i, high: 200 + i, low: 90 + i, close: 150 + i,
    volume: 10, delta: 0, count: 1, cells: new Map(), hasRef: true,
  })));
  const view = new View();
  view.area = { left: 0, top: 0, width: 100, height: 200 };
  view.colWidth = 20;
  view.offsetX = 0;

  let reads = 0;
  let scaleCalls = 0;
  const realAt = series.at.bind(series);
  series.at = (idx) => { reads++; return realAt(idx); };
  const realSetScaleRange = view.setScaleRange.bind(view);
  view.setScaleRange = (r) => { scaleCalls++; realSetScaleRange(r); };

  const host = {
    _fitToData,
    _autoFit,
    view,
    pipeline: { series },
    renderer: {
      autoscaleRange: (v, total) => [
        Math.max(0, Math.floor(v.indexOfX(v.area.left))),
        Math.min(total, Math.ceil(v.indexOfX(v.area.left + v.area.width))),
      ],
    },
    lastAutoFitSnapshot: null,
    lastAutoFitCache: null,
  };

  host._autoFit();
  assert.ok(reads > 0, "initial _autoFit scans visible bars");
  assert.equal(scaleCalls, 1);

  reads = 0;
  scaleCalls = 0;
  view.offsetX = 0.25; // sub-bar pan, [0, 5) unchanged
  host._autoFit();
  assert.equal(reads, 0, "sub-bar pan skips _fitToData bar scan");
  assert.equal(scaleCalls, 0, "sub-bar pan skips setScaleRange");

  view.offsetX = -25; // crosses bar boundary -> [1, 7)
  host._autoFit();
  assert.ok(reads > 0, "boundary crossing re-runs _fitToData");
  assert.equal(scaleCalls, 1);
});

test("#358B & Diagnostics: tryMotionRasterReuse < 0.72 triggers ImageData re-anchor and heatmap sets cpu-raster/off path", async () => {
  resetGpuDiagnostics();
  const wasTelemetry = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  let overlay;
  try {
    await withHeatmapSettings(() => ({
      mode: "single",
      unit: "btc",
      bucketStep: 25,
      opacity: 0.65,
      scaleMode: "fixed",
      fixedCeiling: { usd: 100_000_000, btc: 200 },
      single: { usd: 1, btc: 10 },
      aggregated: { usd: 1, btc: 10 },
    }), async () => {
      let now = 1_020 * MINUTE;
      const series = makeHeatmapSeries(20);
      const view = makeHeatmapView(0);
      let putImageDataCalls = 0;
      const offCtx = {
        fillStyle: "",
        save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setTransform() {}, clearRect() {}, fillRect() {},
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => { putImageDataCalls++; },
      };
      const offCanvas = { width: 0, height: 0, getContext: (k) => (k === "2d" ? offCtx : null) };
      const mainCtx = {
        fillStyle: "",
        canvas: { width: 800, height: 400, ownerDocument: { createElement: () => offCanvas } },
        save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, drawImage() {}, fillRect() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      };

      overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => ({
          schemaVersion: 1,
          generatedAt: now,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: Array.from({ length: 20 }, (_, i) => ({
            t: (1_000 + i) * MINUTE,
            cells: [[50_000, 600_000, 600_000]],
          })),
        }),
        invalidate: () => {},
        getMarket: () => MARKET,
        now: () => now,
      });

      overlay.draw(mainCtx, view, series, [0, 19]);
      await new Promise((r) => setTimeout(r, 20));
      overlay.draw(mainCtx, view, series, [0, 19]);
      assert.equal(getGpuDiagnostics().featurePaths?.heatmap, "cpu-raster");

      const before = snapshotPerformanceTelemetry().counters;
      putImageDataCalls = 0;
      now += 16;
      // 20 bars * 20px = 400px out of 800px -> retainedAreaRatio = 0.5 < 0.72, fractional offsetX -> !canScrollInPlace
      view.offsetX = 10.25;
      overlay.draw(mainCtx, view, series, [0, 19]);
      const after = snapshotPerformanceTelemetry().counters;
      assert.equal((after["chart.cpu.heatmap.raster.motionReuse"] ?? 0) - (before["chart.cpu.heatmap.raster.motionReuse"] ?? 0), 0,
        "retainedAreaRatio < 0.72 skips motionReuse");
      assert.ok(putImageDataCalls >= 1, "falls through to packed ImageData re-anchor");

      // Inactive overlay sets featurePaths.heatmap to "off"
      await withHeatmapSettings(() => ({
        mode: "off",
        unit: "btc",
        bucketStep: 25,
        opacity: 0.65,
        scaleMode: "auto",
        contrast: "medium",
        single: { usd: 1, btc: 10 },
        aggregated: { usd: 1, btc: 10 },
      }), async () => {
        overlay.draw(mainCtx, view, series, [0, 19]);
        assert.equal(getGpuDiagnostics().featurePaths?.heatmap, "off");
      });
    });
  } finally {
    overlay?.dispose();
    configurePerformanceTelemetry({ enabled: wasTelemetry });
    resetGpuDiagnostics();
  }
});
