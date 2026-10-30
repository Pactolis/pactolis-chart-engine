import test from "node:test";
import assert from "node:assert/strict";

import {
  copyGpuDiagnosticsJson,
  getGpuDiagnostics,
  recordGpuBackendSelection,
  recordGpuContextEvent,
  recordGpuFallback,
  recordGpuFrame,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  configureGpuSettingsSource,
  DEFAULT_GPU_SETTINGS,
  readGpuSettings,
  resetGpuSettingsForTest,
} from "../dist/core/gpu/gpuSettings.js";
import { createGpuSurface } from "../dist/core/gpu/selectBackend.js";
import { Canvas2dQuadSink, Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";
import { WebGl2Surface } from "../dist/core/gpu/webgl2/webgl2Surface.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";

function makeFakeCanvas(contextMap = {}) {
  const listeners = new Map();
  const canvas = {
    dataset: {},
    style: { cssText: "position:absolute;width:100%;height:100%;" },
    width: 640,
    height: 360,
    parentNode: {
      replaceChild: () => {},
    },
    replaceWith(next) {
      this.replacedWith = next;
    },
    getContext(kind) {
      return contextMap[kind] ?? null;
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent(type, event = { preventDefault() {} }) {
      for (const cb of listeners.get(type) ?? []) cb(event);
    },
  };
  return canvas;
}

function makeFake2dContext() {
  const operations = [];
  return {
    operations,
    fillStyle: "",
    save() { operations.push({ op: "save" }); },
    restore() { operations.push({ op: "restore" }); },
    setTransform(...args) { operations.push({ op: "setTransform", args }); },
    fillRect(x, y, w, h) { operations.push({ op: "fillRect", x, y, w, h, fillStyle: this.fillStyle }); },
    getImageData(x, y, w, h) {
      return {
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      };
    },
  };
}

function makeFakeGl() {
  return {
    drawingBufferWidth: 640,
    drawingBufferHeight: 360,
    viewport() {},
    clearColor() {},
    clear() {},
    readPixels(_x, _y, w, h, _format, _type, buffer) {
      buffer.fill(42);
    },
    deleteVertexArray() {},
    deleteBuffer() {},
    deleteProgram() {},
  };
}

test("selectBackend creates WebGl2Surface when WebGL2 context is available", () => {
  resetGpuDiagnosticsForTest();
  const fakeGl = makeFakeGl();
  const canvas = makeFakeCanvas({ webgl2: fakeGl });

  const surface = createGpuSurface(canvas, "webgl2", fakeGl);
  assert.equal(surface.kind, "webgl2");
  assert.equal(surface.canvas, canvas);
  assert.equal(surface.heatmap, null);

  const diag = getGpuDiagnostics();
  assert.equal(diag.active, "webgl2");
});

test("selectBackend falls back to Canvas2dSurface when WebGL2 context is unavailable", () => {
  resetGpuDiagnosticsForTest();
  const ctx2d = makeFake2dContext();
  const canvas = makeFakeCanvas({ webgl2: null, "2d": ctx2d });

  const surface = createGpuSurface(canvas, "webgl2", null);
  assert.equal(surface.kind, "canvas2d");
  assert.equal(surface.canvas, canvas);

  const diag = getGpuDiagnostics();
  assert.equal(diag.requested, "webgl2");
  assert.equal(diag.active, "canvas2d");
  assert.equal(diag.counters["chart.gpu.contextCreateFailed"], 1);
  assert.equal(diag.counters["gpu.fallback.webgl2.context_unavailable"], 1);
  assert.equal(diag.fallbacks.length, 1);
  assert.equal(diag.fallbacks[0].reason, "context_unavailable");
});

test("selectBackend creates Canvas2dSurface directly when requested", () => {
  resetGpuDiagnosticsForTest();
  const ctx2d = makeFake2dContext();
  const canvas = makeFakeCanvas({ "2d": ctx2d });

  const surface = createGpuSurface(canvas, "canvas2d");
  assert.equal(surface.kind, "canvas2d");
  const diag = getGpuDiagnostics();
  assert.equal(diag.requested, "canvas2d");
  assert.equal(diag.active, "canvas2d");
});

test("readGpuSettings respects ?gpu= URL parameter override", () => {
  resetGpuSettingsForTest();
  const defaultSettings = readGpuSettings(null);
  assert.equal(defaultSettings.backend, "webgl2");

  const overrideWin = { location: { search: "?gpu=canvas2d" } };
  const overridden = readGpuSettings(overrideWin);
  assert.equal(overridden.backend, "canvas2d");

  const autoWin = { location: { search: "?foo=1&gpu=auto" } };
  assert.equal(readGpuSettings(autoWin).backend, "auto");
});

test("readGpuSettings caches source.read() results and invalidates on onChange", () => {
  resetGpuSettingsForTest();
  let readCount = 0;
  let listenerCb = null;
  const mockSource = {
    read() {
      readCount++;
      return { ...DEFAULT_GPU_SETTINGS, backend: readCount > 1 ? "canvas2d" : "webgl2" };
    },
    onChange(cb) {
      listenerCb = cb;
      return () => { listenerCb = null; };
    },
  };

  configureGpuSettingsSource(mockSource);
  assert.equal(readCount, 0);

  // First read queries source
  const first = readGpuSettings(null);
  assert.equal(first.backend, "webgl2");
  assert.equal(readCount, 1);

  // Subsequent reads use cache without calling source.read()
  const second = readGpuSettings(null);
  assert.equal(second.backend, "webgl2");
  assert.equal(readCount, 1);

  // Triggering onChange invalidates cache
  assert.ok(typeof listenerCb === "function");
  listenerCb({ ...DEFAULT_GPU_SETTINGS, backend: "canvas2d" });

  // Next read after onChange queries source again
  const third = readGpuSettings(null);
  assert.equal(third.backend, "canvas2d");
  assert.equal(readCount, 2);

  resetGpuSettingsForTest();
});

test("Canvas2dQuadSink queues and paints rects in order with cached CSS color", () => {
  const ctx2d = makeFake2dContext();
  const sink = new Canvas2dQuadSink(ctx2d);

  const color1 = { r: 1, g: 0, b: 0, a: 1 };
  const color2 = { r: 0, g: 1, b: 0, a: 0.5 };

  sink.rect(10, 20, 30, 40, color1);
  sink.rect(50, 60, 70, 80, color2);

  assert.equal(ctx2d.operations.length, 2);
  assert.deepEqual(ctx2d.operations[0], {
    op: "fillRect",
    x: 10,
    y: 20,
    w: 30,
    h: 40,
    fillStyle: "rgba(255, 0, 0, 1)",
  });
  assert.deepEqual(ctx2d.operations[1], {
    op: "fillRect",
    x: 50,
    y: 60,
    w: 70,
    h: 80,
    fillStyle: "rgba(0, 255, 0, 0.5)",
  });
});

test("Canvas2dSurface frame execution applies transform and clears background", async () => {
  const ctx2d = makeFake2dContext();
  const canvas = makeFakeCanvas({ "2d": ctx2d });
  const surface = new Canvas2dSurface(canvas, ctx2d);

  surface.resize(800, 600, 2);

  const clearColor = { r: 0.07, g: 0.08, b: 0.1, a: 1 };
  const frame = surface.beginFrame(clearColor);
  frame.quads.rect(5, 10, 100, 20, { r: 1, g: 1, b: 1, a: 1 });
  frame.flushQuads();
  frame.end();

  const ops = ctx2d.operations.map((o) => o.op);
  assert.ok(ops.includes("save"));
  assert.ok(ops.includes("setTransform"));
  assert.ok(ops.includes("fillRect"));
  assert.ok(ops.includes("restore"));

  const capture = await surface.requestCapture();
  assert.equal(capture.width, 800);
  assert.equal(capture.height, 600);
  assert.ok(capture.data instanceof Uint8ClampedArray);
});

test("GpuDiagnostics snapshot records frames and exports valid JSON", () => {
  resetGpuDiagnosticsForTest();
  recordGpuBackendSelection("webgl2", "webgl2");
  recordGpuFrame("webgl2", 1.2, 16.6);
  recordGpuFrame("webgl2", 0.8, 16.7);
  recordGpuContextEvent("lost");
  recordGpuContextEvent("restored");

  const snapshot = getGpuDiagnostics();
  assert.equal(snapshot.engine, "0.2.3");
  assert.equal(snapshot.counters["gpu.backend.webgl2.frames"], 2);
  assert.equal(snapshot.counters["chart.gpu.contextLost"], 1);
  assert.equal(snapshot.counters["chart.gpu.contextRestored"], 1);
  assert.ok(snapshot.frame);
  assert.ok(typeof snapshot.frame.renderP50Ms === "number");

  const jsonStr = copyGpuDiagnosticsJson();
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.engine, "0.2.3");
  assert.equal(parsed.counters["gpu.backend.webgl2.frames"], 2);
});

test("ChartSession.replaceSurface transfers surface attributes and updates canvas", () => {
  resetGpuDiagnosticsForTest();
  const win = {
    devicePixelRatio: 2,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  };
  const doc = { defaultView: win, createElement: () => makeFakeCanvas({ "2d": makeFake2dContext() }) };

  const initialCanvas = makeFakeCanvas();
  initialCanvas.dataset.chartSurface = "gpu-scene";
  initialCanvas.style.cssText = "position:absolute;z-index:1;";

  const fakeGl = makeFakeGl();
  const fakeBatch = { begin() {}, rect() {}, flush() {}, dispose() {} };
  const initialSurface = new WebGl2Surface(initialCanvas, fakeGl, fakeBatch);

  const container = {
    ownerDocument: doc,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  };

  let replacedCanvas = null;
  const renderer = {
    render() {},
    visibleRange() { return [0, 10]; },
    setSurface(s) { this.surface = s; },
  };

  const session = new ChartSession({
    container,
    gpuCanvas: initialCanvas,
    gpuSurface: initialSurface,
    annotationCanvas: makeFakeCanvas(),
    interactionCanvas: makeFakeCanvas(),
    ownerDocument: doc,
    annotationCtx2d: makeFake2dContext(),
    interactionCtx2d: makeFake2dContext(),
    renderer,
    annotation: { render() {} },
    interaction: { render() {} },
    view: { area: { left: 0, top: 0, width: 800, height: 600 } },
    series: { length: 10 },
    crosshair: { x: 0, y: 0, visible: false },
    onRestoreContext: () => {},
  });

  const nextCanvas = makeFakeCanvas({ "2d": makeFake2dContext() });
  const nextSurface = new Canvas2dSurface(nextCanvas);

  session.replaceSurface(nextSurface, (next, prev) => {
    replacedCanvas = next;
  });

  assert.equal(session.getSurface(), nextSurface);
  assert.equal(nextCanvas.dataset.chartSurface, "gpu-scene");
  assert.equal(nextCanvas.style.cssText, "position:absolute;z-index:1;");
  assert.equal(replacedCanvas, nextCanvas);
  assert.equal(renderer.surface, nextSurface);
});
