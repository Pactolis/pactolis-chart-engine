import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  createScratchCanvas,
  getCanvasOwnerDocument,
  getScratch2dContext,
  isOffscreenCanvas,
} from "../dist/core/gpu/canvasTarget.js";
import { Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";
import { WebGl2Surface } from "../dist/core/gpu/webgl2/webgl2Surface.js";
import { createGpuSurface, createGpuSurfaceAsync } from "../dist/core/gpu/selectBackend.js";
import { configureChartLocale } from "../dist/core/chartLocale.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { DEFAULT_ORDERBOOK_HEATMAP_SETTINGS } from "../dist/core/orderbookHeatmap/settings.js";
import { AxisLayerCache } from "../dist/core/render/axisLayerCache.js";
import { AnnotationPassCache, annotationPass } from "../dist/core/render/overlay/annotationPassCache.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { resolveChartDisplayOptions } from "../dist/core/model/chartDisplayOptions.js";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import {
  ChartWorkerHostPool,
  ChartWorkerPanelRuntime,
} from "../dist/features/chart/worker/chartWorkerRuntime.js";
import { WorkerChartHostBridge } from "../dist/features/chart/worker/workerRuntimeAdapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const BASE_TIME = 1_700_000_040_000;

configureChartLocale({
  locale: () => "en-US",
  timeZone: () => "UTC",
  translate: (key) => key,
  onLocaleChange: () => () => {},
});

function createMockPortPair() {
  const listeners1 = new Set();
  const listeners2 = new Set();
  const makePort = (ownListeners, peerListeners) => ({
    postMessage(data) {
      queueMicrotask(() => {
        for (const fn of [...peerListeners]) {
          fn({ data });
        }
      });
    },
    addEventListener(type, fn) {
      if (type === "message") ownListeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "message") ownListeners.delete(fn);
    },
    start() {},
    close() {
      ownListeners.clear();
    },
  });
  return {
    port1: makePort(listeners1, listeners2),
    port2: makePort(listeners2, listeners1),
  };
}

function makeMock2dContext(canvas) {
  const tx = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    canvas,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    save() {},
    restore() {},
    setTransform(a, b, c, d, e, f) {
      tx.a = a;
      tx.b = b;
      tx.c = c;
      tx.d = d;
      tx.e = e;
      tx.f = f;
    },
    getTransform() {
      return { ...tx };
    },
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    rect() {},
    clip() {},
    stroke() {},
    fill() {},
    fillText() {},
    measureText(t) {
      return { width: String(t).length * 7 };
    },
    drawImage() {},
    setLineDash() {},
    closePath() {},
    arc() {},
    roundRect() {},
    translate() {},
    scale() {},
    createImageData(w, h) {
      return {
        width: w,
        height: h,
        data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4),
      };
    },
    putImageData() {},
    isContextLost() {
      return false;
    },
    getImageData(_x, _y, w, h) {
      const data = new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4);
      data[0] = 42;
      data[3] = 255;
      return { data, width: w, height: h };
    },
  };
}

function makeMockGlContext(canvas) {
  return {
    canvas,
    COLOR_BUFFER_BIT: 0x4000,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    get drawingBufferWidth() {
      return canvas.width;
    },
    get drawingBufferHeight() {
      return canvas.height;
    },
    viewport() {},
    clearColor() {},
    clear() {},
    readPixels(_x, _y, w, h, _f, _t, out) {
      if (out && out.length >= w * h * 4) {
        out[0] = 11;
        out[1] = 22;
        out[2] = 33;
        out[3] = 255;
      }
    },
  };
}

function makeOffscreenLikeCanvas(width = 300, height = 200, options = {}) {
  const { allow2d = true, allowWebGl2 = false } = options;
  const listeners = new Map();
  let ctx2d = null;
  let gl2 = null;

  const canvas = {
    width,
    height,
    convertToBlob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
    getContext(kind) {
      if (kind === "2d" && allow2d) {
        if (!ctx2d) ctx2d = makeMock2dContext(canvas);
        return ctx2d;
      }
      if (kind === "webgl2" && allowWebGl2) {
        if (!gl2) gl2 = makeMockGlContext(canvas);
        return gl2;
      }
      return null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  return canvas;
}

class MockOffscreenCanvas {
  constructor(width, height) {
    const inner = makeOffscreenLikeCanvas(width, height, { allow2d: true, allowWebGl2: true });
    Object.assign(this, inner);
  }
}

test("canvasTarget helpers detect OffscreenCanvas-like targets and create DOM-free scratch canvases", () => {
  const offscreenLike = makeOffscreenLikeCanvas(120, 80);
  assert.equal(isOffscreenCanvas(offscreenLike), true);
  assert.equal(getCanvasOwnerDocument(offscreenLike), null);

  const ctx2d = getScratch2dContext(offscreenLike);
  assert.ok(ctx2d);

  const prevOffscreen = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = MockOffscreenCanvas;
  try {
    const scratch = createScratchCanvas(64, 32, null);
    assert.ok(scratch);
    assert.equal(scratch.width, 64);
    assert.equal(scratch.height, 32);
    assert.equal(isOffscreenCanvas(scratch), true);
    assert.ok(getScratch2dContext(scratch));
  } finally {
    globalThis.OffscreenCanvas = prevOffscreen;
  }
});

test("Canvas2dSurface, WebGl2Surface, and selectBackend operate on DOM-free OffscreenCanvas targets", async () => {
  const c2dTarget = makeOffscreenLikeCanvas(320, 180, { allow2d: true });
  const c2dSurface = new Canvas2dSurface(c2dTarget);
  c2dSurface.resize(320, 180, 1);
  const c2dFrame = c2dSurface.beginFrame({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
  c2dFrame.quads.rect(4, 4, 20, 20, { r: 1, g: 0, b: 0, a: 1 });
  c2dFrame.flushQuads();
  c2dFrame.end();
  const c2dCap = await c2dSurface.requestCapture();
  assert.equal(c2dCap.width, 320);
  assert.equal(c2dCap.height, 180);
  c2dSurface.dispose();

  const glTarget = makeOffscreenLikeCanvas(320, 180, { allowWebGl2: true });
  const glSurface = new WebGl2Surface(glTarget, glTarget.getContext("webgl2"));
  glSurface.resize(320, 180, 1);
  const glFrame = glSurface.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
  glFrame.flushQuads(320, 180);
  glFrame.end();
  const glCap = await glSurface.requestCapture();
  assert.equal(glCap.width, 320);
  assert.equal(glCap.height, 180);
  glSurface.dispose();

  const syncSurface = createGpuSurface(makeOffscreenLikeCanvas(200, 100, { allow2d: true }), "canvas2d");
  assert.equal(syncSurface.kind, "canvas2d");
  syncSurface.dispose();

  const asyncAuto = await createGpuSurfaceAsync(
    makeOffscreenLikeCanvas(200, 100, { allow2d: true, allowWebGl2: true }),
    "auto",
    undefined,
    undefined,
    { webgpuKillSwitch: true },
  );
  assert.equal(asyncAuto.kind, "webgl2");
  asyncAuto.dispose();

  const asyncFallback = await createGpuSurfaceAsync(
    makeOffscreenLikeCanvas(200, 100, { allow2d: true, allowWebGl2: false }),
    "auto",
    undefined,
    undefined,
    { webgpuKillSwitch: true },
  );
  assert.equal(asyncFallback.kind, "canvas2d");
  asyncFallback.dispose();
});

test("AxisLayerCache, AnnotationPassCache, and OrderbookHeatmapOverlay work without ownerDocument using OffscreenCanvas", () => {
  const prevOffscreen = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = MockOffscreenCanvas;
  try {
    const mainCanvas = makeOffscreenLikeCanvas(800, 500, { allow2d: true });
    const mainCtx = mainCanvas.getContext("2d");
    const view = new View();
    view.area = { left: 0, top: 0, width: 720, height: 476 };
    view.pixelRatio = 1;
    view.fitPriceRange(99, 101);

    const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, pricePrecision: 2 });
    series.loadBars([
      {
        startTime: BASE_TIME,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 12,
        delta: 2,
        count: 3,
        cells: new Map(),
        hasRef: true,
      },
    ]);

    const axisCache = new AxisLayerCache();
    const displayOptions = resolveChartDisplayOptions();
    axisCache.renderPriceAxis(mainCtx, view, series, [], displayOptions);
    axisCache.renderTimeAxis(mainCtx, view, series, []);
    axisCache.dispose();

    const passCache = new AnnotationPassCache();
    const pass = annotationPass("drawings");
    passCache.begin(ChartChange.All, "frame-1");
    const first = passCache.render(
      mainCtx,
      pass,
      "k1",
      ChartChange.All,
      () => ({ drawn: true }),
      () => {},
    );
    assert.equal(first, "miss");
    passCache.begin(ChartChange.DataTail, "frame-1");
    const second = passCache.render(
      mainCtx,
      pass,
      "k1",
      ChartChange.DataTail,
      () => ({ drawn: false }),
      () => {},
    );
    assert.equal(second, "hit");
    passCache.clear();

    let prevHeatmapSettingsSource = null;
    try {
      prevHeatmapSettingsSource = orderbookHeatmapSettingsSource();
    } catch {
      prevHeatmapSettingsSource = null;
    }
    configureOrderbookHeatmapSettingsSource({
      settingsFor: () => DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
      onChange: () => () => {},
    });
    const heatmap = new OrderbookHeatmapOverlay({
      fetch: async () => ({
        schemaVersion: 1,
        generatedAt: BASE_TIME,
        base: "BTC",
        source: "single",
        resolution: "1m",
        bucketStep: 25,
        from: BASE_TIME,
        to: BASE_TIME + 60_000,
        bars: [],
      }),
      invalidate: () => {},
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => BASE_TIME,
    });
    try {
      heatmap.setVisible(true);
      heatmap.draw(mainCtx, view, series, [0, 0]);
    } finally {
      heatmap.dispose();
      if (prevHeatmapSettingsSource) {
        configureOrderbookHeatmapSettingsSource(prevHeatmapSettingsSource);
      }
    }
  } finally {
    globalThis.OffscreenCanvas = prevOffscreen;
  }
});

test("ChartWorkerPanelRuntime + WorkerChartHostBridge end-to-end over MessageChannel (all backends, binary history, input, hit-test, tooltip, capture, lifecycle)", async () => {
  const prevOffscreen = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = MockOffscreenCanvas;
  try {
    for (const backendPreference of ["canvas2d", "webgl2", "auto"]) {
      const mainChannel = createMockPortPair();
      const historyChannel = new MessageChannel();
      const ingressChannel = new MessageChannel();

      const recycled = [];
      const bridge = new WorkerChartHostBridge({
        panelId: `panel-${backendPreference}`,
        marketId: "BINANCE_FUTURES:btcusdt",
        onRecycleBuffer: (p) => recycled.push(p.buffer.byteLength),
      });
      bridge.attachPorts({ mainPort: mainChannel.port1 });

      const runtime = new ChartWorkerPanelRuntime({
        panelId: `panel-${backendPreference}`,
        marketId: "BINANCE_FUTURES:btcusdt",
        backendPreference,
        createScratchCanvas: () => makeOffscreenLikeCanvas(640, 360, { allow2d: true, allowWebGl2: true }),
      });
      runtime.attachPorts({
        mainPort: mainChannel.port2,
        historyPort: historyChannel.port2,
        ingressPort: ingressChannel.port2,
      });

      const offscreenCanvases = {
        "gpu-scene": makeOffscreenLikeCanvas(640, 360, { allow2d: true, allowWebGl2: backendPreference !== "canvas2d" }),
        annotation: makeOffscreenLikeCanvas(640, 360, { allow2d: true }),
        interaction: makeOffscreenLikeCanvas(640, 360, { allow2d: true }),
      };

      bridge.sendInit(
        [
          { role: "gpu-scene", zIndex: 0, width: 640, height: 360, dpr: 1 },
          { role: "annotation", zIndex: 1, width: 640, height: 360, dpr: 1 },
          { role: "interaction", zIndex: 2, width: 640, height: 360, dpr: 1 },
        ],
        { width: 640, height: 360, dpr: 1 },
        { backendPreference, offscreenCanvases },
      );

      // Direct history chunk (object array + packed Float64Array) without main-thread relay
      historyChannel.port1.postMessage({
        channel: "history",
        kind: "history:chunk",
        panelId: `panel-${backendPreference}`,
        marketId: "BINANCE_FUTURES:btcusdt",
        generation: 0,
        seq: 1,
        revision: 1,
        payload: {
          timeframe: "1m",
          bars: [
            { time: BASE_TIME, open: 100, high: 105, low: 98, close: 103, volume: 50 },
            { time: BASE_TIME + 60_000, open: 103, high: 108, low: 101, close: 107, volume: 75 },
          ],
          hasMore: true,
          chunkIndex: 0,
        },
      });

      const packed = new Float64Array([BASE_TIME + 120_000, 107, 110, 105, 109, 90]);
      historyChannel.port1.postMessage(
        {
          channel: "history",
          kind: "history:chunk",
          panelId: `panel-${backendPreference}`,
          marketId: "BINANCE_FUTURES:btcusdt",
          generation: 0,
          seq: 2,
          revision: 2,
          payload: {
            timeframe: "1m",
            bars: packed.buffer,
            hasMore: false,
            chunkIndex: 1,
          },
        },
        [packed.buffer],
      );

      // Direct ingress tick & bar
      ingressChannel.port1.postMessage({
        channel: "ingress",
        kind: "ingress:tick",
        panelId: `panel-${backendPreference}`,
        marketId: "BINANCE_FUTURES:btcusdt",
        generation: 0,
        seq: 1,
        revision: 1,
        payload: { price: 109.5, size: 1.5, timestamp: BASE_TIME + 130_000, side: "buy", tradeId: "t-1" },
      });

      ingressChannel.port1.postMessage({
        channel: "ingress",
        kind: "ingress:bar",
        panelId: `panel-${backendPreference}`,
        marketId: "BINANCE_FUTURES:btcusdt",
        generation: 0,
        seq: 2,
        revision: 2,
        payload: { time: BASE_TIME + 180_000, open: 109, high: 112, low: 108, close: 111, volume: 40 },
      });

      await new Promise((r) => setTimeout(r, 25));
      await runtime.waitUntilReady();

      const offsetBefore = runtime.view.offsetX;
      const colWidthBefore = runtime.view.colWidth;
      bridge.sendInput({ type: "pointerdown", x: 300, y: 150, button: 0, timestamp: 10 });
      bridge.sendInput({ type: "pointermove", x: 260, y: 150, buttons: 1, timestamp: 20 });
      bridge.sendInput({ type: "pointerup", x: 260, y: 150, button: 0, timestamp: 30 });
      bridge.sendInput({ type: "wheel", x: 260, y: 150, deltaX: 0, deltaY: -120, timestamp: 40 });
      bridge.sendInput({ type: "blur", timestamp: 50 });

      await new Promise((r) => setTimeout(r, 25));
      assert.equal(runtime.renderNow(), true);
      assert.notEqual(runtime.view.offsetX, offsetBefore);
      assert.ok(runtime.view.colWidth > colWidthBefore);

      const barX = runtime.view.xOfIndex(1) + runtime.view.colWidth / 2;
      const hit = await bridge.requestHitTest(barX, 120);
      assert.equal(hit.hit, true);
      assert.equal(hit.targetKind, "bar");

      const tooltip = await bridge.requestTooltip(barX, 120);
      assert.equal(tooltip.visible, true);
      assert.equal(tooltip.title, "BINANCE_FUTURES:btcusdt");
      assert.ok(tooltip.lines && tooltip.lines.length === 5);

      const cap = await bridge.requestCapture({ format: "bitmap" });
      assert.equal(cap.ok, true);
      assert.equal(cap.width, 640);
      assert.equal(cap.height, 360);
      assert.ok(cap.buffer instanceof ArrayBuffer);
      assert.ok(recycled.length >= 1);

      bridge.sendLifecycle("pause");
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(runtime.getDiagnostics().paused, true);

      bridge.sendLifecycle("resume");
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(runtime.getDiagnostics().paused, false);

      bridge.sendLifecycle("rehome", "popout", {
        surfaces: [{ role: "gpu-scene", zIndex: 0, width: 800, height: 480, dpr: 2 }],
        offscreenCanvases: {
          "gpu-scene": makeOffscreenLikeCanvas(800, 480, { allow2d: true, allowWebGl2: backendPreference !== "canvas2d" }),
          annotation: makeOffscreenLikeCanvas(800, 480, { allow2d: true }),
          interaction: makeOffscreenLikeCanvas(800, 480, { allow2d: true }),
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      await runtime.waitUntilReady();
      assert.equal(runtime.getDiagnostics().width, 800);
      assert.equal(runtime.getDiagnostics().height, 480);

      const diag = runtime.getDiagnostics();
      assert.equal(diag.barCount, 4);
      assert.ok(diag.frameCount >= 1);

      bridge.dispose();
      runtime.dispose();
      mainChannel.port1.close();
      mainChannel.port2.close();
      historyChannel.port1.close();
      historyChannel.port2.close();
      ingressChannel.port1.close();
      ingressChannel.port2.close();
    }
  } finally {
    globalThis.OffscreenCanvas = prevOffscreen;
  }
});

test("ChartWorkerHostPool manages 4 independent panels in one worker runtime", () => {
  const pool = new ChartWorkerHostPool();
  for (let i = 0; i < 4; i++) {
    pool.createPanel({ panelId: `p-${i}`, marketId: `BINANCE_FUTURES:market${i}` });
  }
  assert.deepEqual(pool.listPanelIds(), ["p-0", "p-1", "p-2", "p-3"]);
  assert.equal(pool.removePanel("p-1"), true);
  assert.deepEqual(pool.listPanelIds(), ["p-0", "p-2", "p-3"]);
  pool.disposeAll();
  assert.deepEqual(pool.listPanelIds(), []);
});

test("chartWorkerRuntime.ts and canvasTarget.ts remain strictly DOM-free (no window/document identifiers)", () => {
  const runtimeSrc = readFileSync(
    resolve(repoRoot, "src/features/chart/worker/chartWorkerRuntime.ts"),
    "utf8",
  );
  assert.equal(/\b(window|document)\b/.test(runtimeSrc), false);
});
