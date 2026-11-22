import test from "node:test";
import assert from "node:assert/strict";

import {
  getGpuDiagnostics,
  recordGpuBackendSelection,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  configureGpuSettingsSource,
  DEFAULT_GPU_SETTINGS,
  resetGpuSettingsForTest,
} from "../dist/core/gpu/gpuSettings.js";
import {
  createGpuSurface,
  createGpuSurfaceAsync,
} from "../dist/core/gpu/selectBackend.js";
import {
  requestWebGpuDevice,
  resetSharedWebGpuDevice,
} from "../dist/core/gpu/webgpu/webgpuDevice.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { ChartChange, ChartSurfaceDirty } from "../dist/core/render/scene/chartScene.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { DEFAULT_VOLUME_PROFILE_SETTINGS } from "../dist/core/analysis/volumeProfile.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";
import { chartHost, configureChartHost } from "../dist/features/chart/chartHost.js";
import { mountChartRuntime } from "../dist/features/chart/ChartRuntime.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { createIndicatorPaneHeadersModel } from "../dist/features/indicators/indicatorPaneHeaders.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

function setMockNavigator(navObj) {
  Object.defineProperty(globalThis, "navigator", {
    value: navObj,
    configurable: true,
    writable: true,
  });
}

function restoreNavigator(descriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, "navigator", descriptor);
  }
}

function makeFakeGpuBuffer(size, usage, overrides = {}) {
  const mappedData = new Uint8Array(size);
  return {
    size,
    usage,
    destroyed: false,
    unmapCalls: 0,
    destroyCalls: 0,
    destroy() {
      this.destroyed = true;
      this.destroyCalls++;
    },
    async mapAsync() {
      if (overrides.mapError) throw overrides.mapError;
      if (overrides.mapPromise) return overrides.mapPromise;
    },
    getMappedRange() {
      if (overrides.getMappedRangeError) throw overrides.getMappedRangeError;
      return mappedData.buffer;
    },
    unmap() {
      this.unmapCalls++;
    },
  };
}

function makeFakeWebGpuDevice(opts = {}) {
  const format = opts.format ?? "rgba8unorm";
  const buffers = [];
  const uncapturedListeners = new Set();
  const removedUncapturedListeners = [];
  const errorScopeStack = [];
  let lostResolve;
  const lostPromise = new Promise((resolve) => {
    lostResolve = resolve;
  });

  const device = {
    format,
    destroyed: false,
    destroyCalls: 0,
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    lost: lostPromise,
    _triggerLost(info = { reason: "destroyed" }) {
      lostResolve(info);
    },
    _uncapturedListenerCount() {
      return uncapturedListeners.size;
    },
    _removedUncapturedCount() {
      return removedUncapturedListeners.length;
    },
    addEventListener(event, cb) {
      if (event === "uncapturederror") uncapturedListeners.add(cb);
    },
    removeEventListener(event, cb) {
      if (event === "uncapturederror") {
        uncapturedListeners.delete(cb);
        removedUncapturedListeners.push(cb);
      }
    },
    _triggerUncapturedError(err) {
      for (const cb of [...uncapturedListeners]) cb({ error: err });
    },
    ...(opts.withErrorScopes ? {
      pushErrorScope(filter) {
        errorScopeStack.push({ filter, error: null });
      },
      async popErrorScope() {
        const entry = errorScopeStack.pop();
        return entry?.error ?? null;
      },
      _injectScopedError(filter, error) {
        for (let i = errorScopeStack.length - 1; i >= 0; i--) {
          if (errorScopeStack[i].filter === filter) {
            errorScopeStack[i].error = error;
            return true;
          }
        }
        return false;
      },
    } : {}),
    createShaderModule(desc) {
      if (opts.scopedInitError && opts.withErrorScopes) {
        const entry = [...errorScopeStack].reverse().find((s) => s.filter === opts.scopedInitError.filter);
        if (entry) entry.error = opts.scopedInitError.error;
      }
      return { label: desc.label, code: desc.code };
    },
    createBuffer(desc) {
      const bufOverrides = desc.label === "WebGpuCaptureStagingBuffer" ? (opts.stagingOverrides ?? {}) : {};
      const buf = makeFakeGpuBuffer(desc.size, desc.usage, bufOverrides);
      buf.label = desc.label;
      buffers.push(buf);
      return buf;
    },
    createBindGroupLayout(desc) { return { label: desc.label }; },
    createBindGroup(desc) { return { label: desc.label }; },
    createPipelineLayout(desc) { return { label: desc.label }; },
    createRenderPipeline(desc) {
      if (opts.throwInPipeline) throw new Error("Pipeline creation failed");
      return { label: desc.label };
    },
    createCommandEncoder(desc) {
      return {
        label: desc.label,
        beginRenderPass() {
          return { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {}, end() {} };
        },
        copyTextureToBuffer() {
          if (opts.scopedCaptureError && opts.withErrorScopes) {
            const entry = [...errorScopeStack].reverse().find((s) => s.filter === opts.scopedCaptureError.filter);
            if (entry) entry.error = opts.scopedCaptureError.error;
          }
        },
        finish() { return {}; },
      };
    },
    queue: {
      writeBuffer() {},
      submit() {
        if (opts.submitError) throw opts.submitError;
      },
    },
    destroy() {
      this.destroyed = true;
      this.destroyCalls++;
    },
  };

  return { device, buffers };
}

function makeFakeWebGpuContext(device, format = "rgba8unorm") {
  let unconfigured = false;
  const tex = { format, createView: () => ({}) };
  return {
    get isUnconfigured() { return unconfigured; },
    configure() { unconfigured = false; },
    unconfigure() { unconfigured = true; },
    getCurrentTexture() { return tex; },
  };
}

function makeFakeGl(overrides = {}) {
  return {
    drawingBufferWidth: 640,
    drawingBufferHeight: 360,
    viewport() {},
    clearColor() {},
    clear() {},
    readPixels(_x, _y, _w, _h, _f, _t, buf) { buf.fill(77); },
    deleteVertexArray() {},
    deleteBuffer() {},
    deleteProgram() {},
    ...overrides,
  };
}

function makeFake2dContext(opts = {}) {
  const transforms = [];
  let lost = Boolean(opts.lost);
  return {
    transforms,
    fillStyle: "",
    canvas: null,
    isContextLost() { return lost; },
    _setLost(v) { lost = v; },
    save() {},
    restore() {},
    clearRect() {},
    setTransform(...args) { transforms.push(args); },
    getTransform() {
      const last = transforms.at(-1) ?? [1, 0, 0, 1, 0, 0];
      return { a: last[0], b: last[1], c: last[2], d: last[3], e: last[4], f: last[5] };
    },
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    rect() {},
    clip() {},
    setLineDash() {},
    drawImage() {},
    measureText() { return { width: 10 }; },
    fillText() {},
    strokeRect() {},
    getImageData(_x, _y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
  };
}

/**
 * WHATWG-compliant fake canvas: first non-null getContext(kind) locks the canvas
 * to that context mode; any subsequent getContext(otherKind) returns null.
 */
function makeWhatwgCanvas({ contexts = {}, ownerDocument = null, failOnOtherMode = false } = {}) {
  const listeners = new Map();
  const listenerOps = { add: 0, remove: 0 };
  const attrs = new Map();
  let lockedKind = null;
  let removed = false;
  const requestedKinds = [];

  const canvas = {
    ownerDocument,
    dataset: {},
    style: { cssText: "position:absolute;inset:0;z-index:1;width:100%;height:100%;" },
    width: 640,
    height: 360,
    parentNode: { replaceChild() {} },
    get lockedKind() { return lockedKind; },
    get removed() { return removed; },
    get requestedKinds() { return requestedKinds; },
    listenerOps,
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    setAttribute(k, v) { attrs.set(k, v); },
    getAttribute(k) { return attrs.get(k) ?? null; },
    remove() { removed = true; },
    replaceWith(next) {
      this.replacedWith = next;
      removed = true;
    },
    getContext(kind) {
      requestedKinds.push(kind);
      if (lockedKind !== null && lockedKind !== kind) {
        if (failOnOtherMode) throw new Error(`Canvas locked to ${lockedKind}`);
        return null;
      }
      const ctx = typeof contexts[kind] === "function" ? contexts[kind](this) : (contexts[kind] ?? null);
      if (ctx) {
        lockedKind = kind;
        if (typeof ctx === "object" && "canvas" in ctx && ctx.canvas === null) {
          ctx.canvas = this;
        }
      }
      return ctx;
    },
    addEventListener(type, cb) {
      listenerOps.add++;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      listenerOps.remove++;
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent(type, event = { preventDefault() {}, defaultPrevented: false }) {
      const ev = {
        ...event,
        preventDefault() {
          this.defaultPrevented = true;
          event.preventDefault?.();
        },
      };
      for (const cb of [...(listeners.get(type) ?? [])]) cb(ev);
      return ev;
    },
  };
  return canvas;
}

// ---------------------------------------------------------------------------
// Issue #251: New canvas fallback, mount fallback, settings swap & race/retry
// ---------------------------------------------------------------------------

test("#251: WHATWG-locked canvas cascades WebGPU construct failure -> fresh WebGL2 -> fresh Canvas2D", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  const createdCanvases = [];
  const { device } = makeFakeWebGpuDevice({ throwInPipeline: true });
  const webgpuCtx = makeFakeWebGpuContext(device);
  const fakeGl = makeFakeGl();
  const fake2d = makeFake2dContext();

  // Canvas 0: WebGPU succeeds getContext -> WebGpuSurface constructor throws
  const canvas0 = makeWhatwgCanvas({
    contexts: { webgpu: webgpuCtx, webgl2: fakeGl, "2d": fake2d },
    failOnOtherMode: true,
  });

  // Canvas 1 (WebGL2): succeeds getContext("webgl2") -> throw in WebGl2Surface via broken gl.createShader
  const brokenGl = makeFakeGl({
    createShader() { throw new Error("WebGL2 shader init error"); },
    createProgram() { return {}; },
    getShaderParameter() { return true; },
    createTexture() { return {}; },
    createVertexArray() { return {}; },
  });
  const canvas1 = makeWhatwgCanvas({
    contexts: { webgl2: brokenGl, "2d": fake2d },
    failOnOtherMode: true,
  });

  // Canvas 2 (Canvas2D): succeeds
  const canvas2 = makeWhatwgCanvas({
    contexts: { "2d": fake2d },
    failOnOtherMode: true,
  });

  const pool = [canvas1, canvas2];
  const createCanvas = () => {
    const next = pool.shift();
    createdCanvases.push(next);
    return next;
  };

  try {
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => device }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });

    const surface = await createGpuSurfaceAsync(canvas0, "webgpu", undefined, undefined, { createCanvas });
    assert.equal(surface.kind, "canvas2d");
    assert.equal(surface.canvas, canvas2);
    assert.equal(canvas0.requestedKinds.includes("webgl2"), false, "never probes webgl2 on WebGPU-locked canvas");
    assert.equal(canvas0.requestedKinds.includes("2d"), false, "never probes 2d on WebGPU-locked canvas");
    assert.equal(webgpuCtx.isUnconfigured, true);
    assert.equal(canvas0.width, 0);
    assert.equal(canvas0.height, 0);
    assert.equal(canvas0.removed, false, "caller-owned canvas0 must not be removed from DOM before replaceWith");

    assert.deepEqual(canvas1.requestedKinds, ["webgl2"], "never probes 2d on WebGL2-locked canvas");
    assert.equal(canvas1.width, 0);
    assert.equal(canvas1.height, 0);
    assert.equal(canvas1.removed, true);

    const diag = getGpuDiagnostics();
    assert.equal(diag.active, "canvas2d");
    assert.deepEqual(diag.fallbacks.map((f) => [f.from, f.to, f.reason]), [
      ["webgpu", "webgl2", "surface_init_failed"],
      ["webgl2", "canvas2d", "surface_init_failed"],
    ]);
    surface.dispose();
  } finally {
    restoreNavigator(originalNav);
    resetSharedWebGpuDevice();
  }
});

test("#251: total backend failure does not pollute activeBackend and avoids duplicate device_unavailable", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    recordGpuBackendSelection("canvas2d", "canvas2d");

    // 1. All attempts fail -> activeBackend remains "canvas2d"
    setMockNavigator({
      gpu: {
        requestAdapter: async () => null,
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const emptyCanvas = makeWhatwgCanvas({ contexts: {} });
    await assert.rejects(
      () => createGpuSurfaceAsync(emptyCanvas, "webgpu", undefined, undefined, { createCanvas: () => makeWhatwgCanvas({ contexts: {} }) }),
      /failed to acquire WebGPU, WebGL2 and Canvas2D/,
    );
    let diag = getGpuDiagnostics();
    assert.equal(diag.active, "canvas2d", "failed selection must not overwrite activeBackend");
    assert.equal(diag.fallbacks.length, 0, "failed selection must not commit partial fallbacks");

    // 2. requestWebGpuDevice records adapter_request_failed -> no duplicate device_unavailable when WebGL2 succeeds
    const glCanvas = makeWhatwgCanvas({ contexts: { webgl2: makeFakeGl() } });
    const surface = await createGpuSurfaceAsync(glCanvas, "webgpu");
    assert.equal(surface.kind, "webgl2");
    diag = getGpuDiagnostics();
    assert.deepEqual(diag.fallbacks.map((f) => f.reason), ["adapter_request_failed"]);
    surface.dispose();
  } finally {
    restoreNavigator(originalNav);
    resetSharedWebGpuDevice();
  }
});

test("#251: ChartRuntime initial mount falls back to Canvas2D and onGpuSettingsChange preserves working chart on error & race", async (t) => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  resetGpuSettingsForTest();

  let prevHost = null;
  try { prevHost = chartHost(); } catch { prevHost = null; }
  t.after(() => configureChartHost(prevHost));
  useFakeChartDataSource(t, { history: [] });

  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalWindow = globalThis.window;

  function makeDomHarness(initialMode = "webgl2", deviceOpts = {}) {
    let settingsState = { ...DEFAULT_GPU_SETTINGS, backend: initialMode };
    const settingsListeners = new Set();
    let webglAvailable = false;
    let canvasFactoryOverride = null;

    const fakeGl = makeFakeGl();
    const { device } = makeFakeWebGpuDevice(deviceOpts);
    const fakeWebGpuCtx = makeFakeWebGpuContext(device);

    const docListeners = new Map();
    let doc;
    const win = {
      devicePixelRatio: 1,
      location: { search: "" },
      performance: { now: () => Date.now() },
      get document() { return doc; },
      ResizeObserver: class { observe() {} disconnect() {} },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    };
    globalThis.window = win;

    const makeDomNode = (tag) => {
      const attrs = new Map();
      const classes = new Set();
      const listeners = new Map();
      const children = [];
      let lockedKind = null;
      let removed = false;
      const el = {
        tagName: String(tag).toUpperCase(),
        id: "",
        dataset: {},
        className: "",
        tabIndex: -1,
        textContent: "",
        width: tag === "canvas" ? 123 : 0,
        height: tag === "canvas" ? 45 : 0,
        parentNode: null,
        parentElement: null,
        children,
        style: { cssText: "", width: "", height: "", cursor: "" },
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
        },
        get ownerDocument() { return doc; },
        get removed() { return removed; },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
        removeAttribute(k) { attrs.delete(k); },
        appendChild(child) {
          child.parentNode = el;
          child.parentElement = el;
          children.push(child);
          return child;
        },
        append(...nodes) { for (const n of nodes) el.appendChild(n); },
        insertBefore(child, refNode) {
          child.parentNode = el;
          child.parentElement = el;
          const idx = refNode ? children.indexOf(refNode) : -1;
          if (idx >= 0) children.splice(idx, 0, child);
          else children.push(child);
          return child;
        },
        replaceWith(next) {
          if (el.parentNode) {
            const idx = el.parentNode.children.indexOf(el);
            if (idx >= 0) el.parentNode.children[idx] = next;
            next.parentNode = el.parentNode;
            next.parentElement = el.parentElement;
            el.parentNode = null;
            el.parentElement = null;
          }
          removed = true;
        },
        remove() {
          if (el.parentNode) {
            const idx = el.parentNode.children.indexOf(el);
            if (idx >= 0) el.parentNode.children.splice(idx, 1);
            el.parentNode = null;
            el.parentElement = null;
          }
          removed = true;
        },
        contains(target) { return target === el || children.some((c) => c === target || c.contains?.(target)); },
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
        setPointerCapture() {},
        releasePointerCapture() {},
        hasPointerCapture: () => false,
        focus() {},
        addEventListener(type, cb) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(cb);
        },
        removeEventListener(type, cb) { listeners.get(type)?.delete(cb); },
        getContext(kind) {
          if (lockedKind !== null && lockedKind !== kind) return null;
          let ctx = null;
          if (kind === "webgpu") ctx = fakeWebGpuCtx;
          else if (kind === "webgl2") ctx = webglAvailable ? fakeGl : null;
          else if (kind === "2d") {
            const c2d = makeFake2dContext();
            c2d.canvas = el;
            ctx = c2d;
          }
          if (ctx) lockedKind = kind;
          return ctx;
        },
      };
      return el;
    };

    const createdCanvases = [];
    doc = {
      visibilityState: "visible",
      defaultView: win,
      head: null,
      createElement(tag) {
        if (tag === "canvas" && canvasFactoryOverride) {
          const custom = canvasFactoryOverride(makeDomNode("canvas"));
          createdCanvases.push(custom);
          return custom;
        }
        const node = makeDomNode(tag);
        if (tag === "canvas") createdCanvases.push(node);
        return node;
      },
      getElementById: (id) => doc.head.children.find((n) => n.id === id) ?? null,
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
    };
    doc.head = makeDomNode("head");

    const panelRoot = makeDomNode("div");
    const drawings = new DrawingManager(() => {});

    configureChartHost({
      registerRuntime() {},
      unregisterRuntime() {},
      indicatorsChanged() {},
      setDataDegraded() {},
      isFootprintAutoFillEnabled: () => false,
      getPairChartType: () => undefined,
      setPairChartType() {},
      exposeDebugGlobals: () => false,
      displayOptions: () => ({}),
    });
    configureGpuSettingsSource({
      read: () => settingsState,
      onChange: (cb) => {
        settingsListeners.add(cb);
        return () => settingsListeners.delete(cb);
      },
    });

    const services = {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 10,
      fetchPriceStepResult: async () => ({ step: 10, resolved: true }),
      fetchPricePrecision: async () => 1,
      getAnalysisContext: () => ({
        market: "BINANCE_FUTURES:btcusdt",
        profileSettings: { enabled: false },
        previousWeekStrategySettings: { enabled: false },
        previousWeekStrategyLevels: [],
        mondayRangeSettings: { enabled: false },
        mondayRangeLevels: [],
        nakedPocs: [],
        referenceLevels: [],
        drawings,
      }),
      notify() {},
      getAnalysisRevisionSnapshot: () => ({
        market: "BINANCE_FUTURES:btcusdt",
        revision: 1,
        canonical: { status: "complete", market: "BINANCE_FUTURES:btcusdt", runKey: "BINANCE_FUTURES:btcusdt|10", generation: 1, revision: 1, failedPeriods: [] },
      }),
      subscribeAnalysis: () => () => {},
      subscribeAnalysisRevision: () => () => {},
      updateAnalysisFromSeries() {},
      fetchNpocSnapshot: () => Promise.resolve({ levels: [] }),
      notifyActiveMarket() {},
      notifyInteractiveCandlesReady() {},
      notifyInteractiveHistorySettled() {},
      triggerAutoSync() {},
      isFootprintSyncBusy: () => false,
      notifyBarClose() {},
    };

    return {
      doc,
      panelRoot,
      createdCanvases,
      services,
      device,
      setWebglAvailable(v) { webglAvailable = v; },
      setCanvasFactoryOverride(fn) { canvasFactoryOverride = fn; },
      emitBackend(backend) {
        settingsState = { ...settingsState, backend };
        for (const cb of [...settingsListeners]) cb();
      },
    };
  }

  try {
    // 1. backend="auto" without WebGPU and with null WebGL2 mounts cleanly on Canvas2D
    setMockNavigator({});
    const envAuto = makeDomHarness("auto");
    const surfaceAuto = {
      status: "loading",
      historyOverlay: false,
      historyBackground: false,
      indicatorHeaders: createIndicatorPaneHeadersModel(),
    };
    const handleAuto = mountChartRuntime(
      envAuto.panelRoot,
      { type: "chart", market: "BINANCE_FUTURES:btcusdt", timeframe: "15m", scaleMode: "linear", chartType: "candlestick", candles: true },
      envAuto.services,
      "panel-251-auto",
      surfaceAuto,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(surfaceAuto.status, "ready");
    assert.equal(envAuto.panelRoot.children[0].getAttribute("data-gpu-backend"), "canvas2d");
    handleAuto.dispose();

    // 1b. backend="webgl2" with null WebGL2 on initial mount falls back to Canvas2D in Node unit test
    const envWebglNull = makeDomHarness("webgl2");
    const surfaceWebglNull = {
      status: "loading",
      historyOverlay: false,
      historyBackground: false,
      indicatorHeaders: createIndicatorPaneHeadersModel(),
    };
    const handleWebglNull = mountChartRuntime(
      envWebglNull.panelRoot,
      { type: "chart", market: "BINANCE_FUTURES:btcusdt", timeframe: "15m", scaleMode: "linear", chartType: "candlestick", candles: true },
      envWebglNull.services,
      "panel-251-webgl-null",
      surfaceWebglNull,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(surfaceWebglNull.status, "ready", "initial mount with backend='webgl2' and null WebGL2 must fall back to Canvas2D");
    assert.equal(envWebglNull.panelRoot.children[0].getAttribute("data-gpu-backend"), "canvas2d");
    handleWebglNull.dispose();

    // 2. backend="canvas2d" -> failed switch to "webgl2" preserves chart, retry "webgl2" succeeds, race cleans up stale canvas
    const env = makeDomHarness("canvas2d");
    const surfaceModel = {
      status: "loading",
      historyOverlay: false,
      historyBackground: false,
      indicatorHeaders: createIndicatorPaneHeadersModel(),
    };
    const handle = mountChartRuntime(
      env.panelRoot,
      { type: "chart", market: "BINANCE_FUTURES:btcusdt", timeframe: "15m", scaleMode: "linear", chartType: "candlestick", candles: true },
      env.services,
      "panel-251",
      surfaceModel,
    );

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(surfaceModel.status, "ready", "initial mount with null WebGL2 must fall back to Canvas2D");
    const hook = env.panelRoot.children[0];
    assert.equal(hook.getAttribute("data-gpu-backend"), "canvas2d");

    // Failed settings switch keeps current surface and allows retry
    env.setCanvasFactoryOverride((el) => {
      el.getContext = () => null;
      return el;
    });
    env.emitBackend("webgl2");
    await new Promise((r) => setTimeout(r, 30));
    env.setCanvasFactoryOverride(null);
    assert.equal(hook.getAttribute("data-gpu-backend"), "canvas2d", "failed swap preserves running surface");

    // Retry same preference ("webgl2") now succeeds
    env.setWebglAvailable(true);
    env.emitBackend("webgl2");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hook.getAttribute("data-gpu-backend"), "webgl2", "retry of failed preference succeeds");

    // Race test: start async WebGPU switch, supersede with canvas2d before adapter resolves -> stale WebGPU canvas cleaned up
    let resolveAdapter;
    const deferredAdapter = new Promise((resolve) => { resolveAdapter = resolve; });
    setMockNavigator({
      gpu: {
        requestAdapter: () => deferredAdapter,
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const canvasesBeforeRace = env.createdCanvases.length;
    env.emitBackend("webgpu");
    const staleWebGpuCanvas = env.createdCanvases[canvasesBeforeRace];
    assert.ok(staleWebGpuCanvas);

    env.emitBackend("canvas2d");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hook.getAttribute("data-gpu-backend"), "canvas2d");

    resolveAdapter({ requestDevice: async () => env.device });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hook.getAttribute("data-gpu-backend"), "canvas2d", "superseded async WebGPU swap must not overwrite canvas2d");
    assert.equal(staleWebGpuCanvas.width, 0, "stale async canvas width zeroed");
    assert.equal(staleWebGpuCanvas.height, 0, "stale async canvas height zeroed");
    assert.equal(staleWebGpuCanvas.removed, true, "stale async canvas removed");

    handle.dispose();

    // 3. backend="webgpu" initial mount with verifyInit scoped error keeps connected WebGL2 gpu-scene before annotation
    resetSharedWebGpuDevice();
    const envMountFallback = makeDomHarness("webgpu", {
      withErrorScopes: true,
      scopedInitError: { filter: "validation", error: { message: "Mock WebGPU init validation failure" } },
    });
    envMountFallback.setWebglAvailable(true);
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => envMountFallback.device }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const surfaceMountFallback = {
      status: "loading",
      historyOverlay: false,
      historyBackground: false,
      indicatorHeaders: createIndicatorPaneHeadersModel(),
    };
    const handleMountFallback = mountChartRuntime(
      envMountFallback.panelRoot,
      { type: "chart", market: "BINANCE_FUTURES:btcusdt", timeframe: "15m", scaleMode: "linear", chartType: "candlestick", candles: true },
      envMountFallback.services,
      "panel-251-webgpu-mount-fallback",
      surfaceMountFallback,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(surfaceMountFallback.status, "ready");
    assert.equal(envMountFallback.panelRoot.children[0].getAttribute("data-gpu-backend"), "webgl2");
    const sceneCanvases = envMountFallback.panelRoot.children.filter((c) => c.dataset?.chartSurface === "gpu-scene");
    assert.equal(sceneCanvases.length, 1, "panelRoot must contain exactly one connected gpu-scene canvas");
    assert.equal(sceneCanvases[0].parentNode, envMountFallback.panelRoot);
    assert.equal(envMountFallback.panelRoot.children[1], sceneCanvases[0], "fallback gpu-scene canvas stays connected before annotation");
    assert.equal(envMountFallback.panelRoot.children[2].dataset?.chartSurface, "annotation");
    assert.equal(envMountFallback.createdCanvases[0].width, 0);
    assert.equal(envMountFallback.createdCanvases[0].height, 0);
    handleMountFallback.dispose();
  } finally {
    restoreNavigator(originalNav);
    globalThis.window = originalWindow;
    resetGpuSettingsForTest();
    resetSharedWebGpuDevice();
  }
});

test("#251: ChartSession WebGPU loss fallback creates separate Canvas2D canvas when WebGl2Surface throws", () => {
  resetGpuDiagnosticsForTest();
  const { device } = makeFakeWebGpuDevice();
  const webgpuCtx = makeFakeWebGpuContext(device);
  const brokenGl = makeFakeGl({
    createShader() { throw new Error("broken gl"); },
    createProgram() { return {}; },
    getShaderParameter() { return true; },
    createTexture() { return {}; },
    createVertexArray() { return {}; },
  });
  const fake2d = makeFake2dContext();
  const created = [];
  const win = {
    devicePixelRatio: 1,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  };
  const doc = {
    defaultView: win,
    createElement() {
      const c = makeWhatwgCanvas({
        ownerDocument: doc,
        contexts: created.length === 0 ? { webgl2: brokenGl, "2d": fake2d } : { "2d": fake2d },
      });
      created.push(c);
      return c;
    },
  };

  let lostCb;
  const webgpuCanvas = makeWhatwgCanvas({ ownerDocument: doc, contexts: { webgpu: webgpuCtx } });
  const webgpuSurface = new WebGpuSurface(webgpuCanvas, {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: (cb) => { lostCb = cb; return () => {}; },
    dispose: () => {},
  });

  const session = new ChartSession({
    container: { ownerDocument: doc, getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    gpuCanvas: webgpuCanvas,
    gpuSurface: webgpuSurface,
    annotationCanvas: makeWhatwgCanvas({ ownerDocument: doc }),
    interactionCanvas: makeWhatwgCanvas({ ownerDocument: doc }),
    ownerDocument: doc,
    annotationCtx2d: makeFake2dContext(),
    interactionCtx2d: makeFake2dContext(),
    renderer: { render() {}, visibleRange: () => [0, 0], setSurface() {} },
    annotation: { render() {} },
    interaction: { render() {} },
    view: {},
    series: [],
    crosshair: {},
    onRestoreContext: () => {},
  });

  lostCb("device-lost");
  assert.equal(created.length, 2);
  assert.equal(created[0].width, 0);
  assert.equal(created[0].height, 0);
  assert.equal(created[0].removed, true);
  assert.equal(session.getSurface().kind, "canvas2d");
  assert.equal(session.getSurface().canvas, created[1]);
  session.destroy();
});

// ---------------------------------------------------------------------------
// Issue #252: GPUAdapter.info, isFallbackAdapter, legacy fallback & stale leak
// ---------------------------------------------------------------------------

test("#252: adapter.info primary source, isFallbackAdapter preservation, legacy fallback and stale cleanup", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    const { device } = makeFakeWebGpuDevice();

    // 1. Modern adapter.info takes precedence over legacy requestAdapterInfo & adapter.isFallbackAdapter
    let legacyCalls = 0;
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: "amd", architecture: "rdna-4", description: "Radeon", isFallbackAdapter: false },
          isFallbackAdapter: true,
          async requestAdapterInfo() {
            legacyCalls++;
            return { vendor: "wrong" };
          },
          requestDevice: async () => device,
        }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const h1 = await requestWebGpuDevice({ forceNew: true });
    assert.ok(h1);
    assert.equal(legacyCalls, 0, "requestAdapterInfo must not be called when adapter.info exists");
    assert.deepEqual(getGpuDiagnostics().adapter, {
      vendor: "amd",
      architecture: "rdna-4",
      description: "Radeon",
      isFallbackAdapter: false,
    });

    // 2. isFallbackAdapter: true from info, and unknown stays undefined (software text does not fabricate flag)
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: "google", architecture: "swiftshader", description: "SwiftShader" },
          requestDevice: async () => device,
        }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const h2 = await requestWebGpuDevice({ forceNew: true });
    assert.ok(h2);
    assert.equal(getGpuDiagnostics().adapter.isFallbackAdapter, undefined, "unknown flag must remain undefined");

    // 3. Legacy requestAdapterInfo used only when adapter.info is absent; error does not break requestDevice
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({
          async requestAdapterInfo() {
            throw new Error("legacy metadata unavailable");
          },
          requestDevice: async () => device,
        }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const h3 = await requestWebGpuDevice({ forceNew: true });
    assert.ok(h3, "metadata error must not break requestDevice()");
    assert.equal(getGpuDiagnostics().adapter, undefined, "empty metadata clears adapter to undefined");

    // 4. Stale adapter info cleared on subsequent failure (!adapter / !device / exception)
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: "nvidia", isFallbackAdapter: true },
          requestDevice: async () => device,
        }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    await requestWebGpuDevice({ forceNew: true });
    assert.equal(getGpuDiagnostics().adapter?.vendor, "nvidia");
    assert.equal(getGpuDiagnostics().adapter?.isFallbackAdapter, true);

    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: "intel", isFallbackAdapter: false },
          requestDevice: async () => null,
        }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const failed = await requestWebGpuDevice({ forceNew: true });
    assert.equal(failed, null);
    assert.equal(getGpuDiagnostics().adapter, undefined, "failed selection must clear previous adapter info");
  } finally {
    restoreNavigator(originalNav);
    resetSharedWebGpuDevice();
  }
});

// ---------------------------------------------------------------------------
// Issue #253: Shared device multi-chart error classification, dispose & error scopes
// ---------------------------------------------------------------------------

function makeSessionForSharedWebGpu(handle, doc, fakeGl, fake2d) {
  const { device } = { device: handle.device };
  const webgpuCtx = makeFakeWebGpuContext(device);
  const canvas = makeWhatwgCanvas({ ownerDocument: doc, contexts: { webgpu: webgpuCtx } });
  const surface = new WebGpuSurface(canvas, handle);
  return new ChartSession({
    container: { ownerDocument: doc, getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    gpuCanvas: canvas,
    gpuSurface: surface,
    annotationCanvas: makeWhatwgCanvas({ ownerDocument: doc }),
    interactionCanvas: makeWhatwgCanvas({ ownerDocument: doc }),
    ownerDocument: doc,
    annotationCtx2d: fake2d,
    interactionCtx2d: fake2d,
    renderer: { render() {}, visibleRange: () => [0, 0], setSurface() {} },
    annotation: { render() {} },
    interaction: { render() {} },
    view: {},
    series: [],
    crosshair: {},
    onRestoreContext: () => {},
  });
}

test("#253: two charts sharing one WebGpuDeviceHandle isolate validation errors, handle OOM/internal without gpu.device.lost, and deduplicate dispose vs device.lost", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  const win = {
    devicePixelRatio: 1,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  };
  const fakeGl = makeFakeGl();
  const fake2d = makeFake2dContext();
  const doc = {
    defaultView: win,
    createElement: () => makeWhatwgCanvas({ ownerDocument: doc, contexts: { webgl2: fakeGl, "2d": fake2d } }),
  };

  try {
    // Part A: Validation error leaves device & both charts alive; OOM falls back both without gpu.device.lost
    const { device: devA } = makeFakeWebGpuDevice();
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => devA }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const handleA = await requestWebGpuDevice();
    const chart1 = makeSessionForSharedWebGpu(handleA, doc, fakeGl, fake2d);
    const chart2 = makeSessionForSharedWebGpu(handleA, doc, fakeGl, fake2d);

    const valErr = Object.assign(new Error("Validation mismatch"), { name: "GPUValidationError" });
    devA._triggerUncapturedError(valErr);
    assert.equal(handleA.isLost(), false);
    assert.equal(chart1.getSurface().kind, "webgpu");
    assert.equal(chart2.getSurface().kind, "webgpu");
    let diag = getGpuDiagnostics();
    assert.equal(diag.counters["gpu.webgpu.error.validation"], 1);
    assert.equal(diag.counters["gpu.renderError"], 1);
    assert.equal(diag.counters["gpu.device.lost"], undefined);

    const oomErr = Object.assign(new Error("Out of GPU memory"), { name: "GPUOutOfMemoryError" });
    devA._triggerUncapturedError(oomErr);
    assert.equal(handleA.isLost(), true);
    assert.equal(devA.destroyed, true, "OOM must destroy the WebGPU device");
    assert.equal(devA.destroyCalls, 1);
    devA._triggerLost({ reason: "destroyed" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(chart1.getSurface().kind, "webgl2");
    assert.equal(chart2.getSurface().kind, "webgl2");
    diag = getGpuDiagnostics();
    assert.equal(diag.counters["gpu.webgpu.error.out-of-memory"], 1);
    assert.equal(diag.counters["gpu.device.lost"], undefined, "OOM + destroyed settle must not increment gpu.device.lost");
    assert.equal(diag.counters["chart.gpu.contextLost"], undefined, "OOM must not inflate chart.gpu.contextLost");
    chart1.destroy();
    chart2.destroy();

    // Part B: Real device.lost with 2 charts -> gpu.device.lost=1, chart.gpu.contextLost=2
    resetGpuDiagnosticsForTest();
    resetSharedWebGpuDevice();
    const { device: devB } = makeFakeWebGpuDevice();
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => devB }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const handleB = await requestWebGpuDevice();
    const chart3 = makeSessionForSharedWebGpu(handleB, doc, fakeGl, fake2d);
    const chart4 = makeSessionForSharedWebGpu(handleB, doc, fakeGl, fake2d);

    devB._triggerLost({ reason: "unknown" });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(chart3.getSurface().kind, "webgl2");
    assert.equal(chart4.getSurface().kind, "webgl2");
    diag = getGpuDiagnostics();
    assert.equal(diag.counters["gpu.device.lost"], 1);
    assert.equal(diag.counters["chart.gpu.contextLost"], 2);
    chart3.destroy();
    chart4.destroy();

    // Part C: handle.dispose() increments gpu.device.destroyed=1, removes listener, ignores later device.lost({reason:"destroyed"})
    resetGpuDiagnosticsForTest();
    resetSharedWebGpuDevice();
    const { device: devC } = makeFakeWebGpuDevice();
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => devC }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const handleC = await requestWebGpuDevice();
    let listenerFired = false;
    handleC.onLost(() => { listenerFired = true; });
    assert.equal(devC._uncapturedListenerCount(), 1);

    handleC.dispose();
    assert.equal(devC.destroyed, true);
    assert.equal(devC._uncapturedListenerCount(), 0);
    assert.equal(devC._removedUncapturedCount(), 1);

    devC._triggerLost({ reason: "destroyed" });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(listenerFired, false);
    diag = getGpuDiagnostics();
    assert.equal(diag.counters["gpu.device.destroyed"], 1);
    assert.equal(diag.counters["gpu.device.lost"], undefined);

    // Part D: GPUInternalError with 2 shared charts -> internal error counter + "internal-error" fallback without gpu.device.lost
    resetGpuDiagnosticsForTest();
    resetSharedWebGpuDevice();
    const { device: devD } = makeFakeWebGpuDevice();
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => devD }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });
    const handleD = await requestWebGpuDevice();
    const chart5 = makeSessionForSharedWebGpu(handleD, doc, fakeGl, fake2d);
    const chart6 = makeSessionForSharedWebGpu(handleD, doc, fakeGl, fake2d);

    const internalErr = Object.assign(new Error("Driver internal error"), { name: "GPUInternalError" });
    devD._triggerUncapturedError(internalErr);
    assert.equal(handleD.isLost(), true);
    assert.equal(devD.destroyed, true, "internal error must destroy the WebGPU device");
    assert.equal(devD.destroyCalls, 1);
    devD._triggerLost({ reason: "destroyed" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(chart5.getSurface().kind, "webgl2");
    assert.equal(chart6.getSurface().kind, "webgl2");
    diag = getGpuDiagnostics();
    assert.equal(diag.counters["gpu.webgpu.error.internal"], 1);
    assert.equal(diag.counters["gpu.renderError"], 1);
    assert.equal(diag.counters["gpu.device.lost"], undefined, "internal error + destroyed settle must not increment gpu.device.lost");
    assert.equal(diag.counters["chart.gpu.contextLost"], undefined, "internal error must not inflate chart.gpu.contextLost");
    assert.ok(diag.fallbacks.some((f) => f.from === "webgpu" && f.to === "webgl2" && f.reason === "internal-error"));
    chart5.destroy();
    chart6.destroy();
  } finally {
    restoreNavigator(originalNav);
    resetSharedWebGpuDevice();
  }
});

test("#253: narrow pushErrorScope catches WebGPU init error for #251 fallback and isolates requestCapture error", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    // 1. Scoped init error rejects verifyInit -> falls back to WebGL2 without losing device
    const { device } = makeFakeWebGpuDevice({
      withErrorScopes: true,
      scopedInitError: { filter: "validation", error: { message: "WGSL validation failed" } },
    });
    const webgpuCtx = makeFakeWebGpuContext(device);
    const fakeGl = makeFakeGl();
    setMockNavigator({
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => device }),
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });

    const canvas0 = makeWhatwgCanvas({ contexts: { webgpu: webgpuCtx } });
    const canvas1 = makeWhatwgCanvas({ contexts: { webgl2: fakeGl } });
    const surface = await createGpuSurfaceAsync(canvas0, "webgpu", undefined, undefined, { createCanvas: () => canvas1 });
    assert.equal(surface.kind, "webgl2");
    assert.equal(getGpuDiagnostics().fallbacks[0].reason, "surface_init_failed");
    assert.equal(getGpuDiagnostics().counters["gpu.device.lost"], undefined);
    surface.dispose();

    // 2. Scoped capture error rejects only that capture promise and cleans up stagingBuffer
    resetSharedWebGpuDevice();
    const { device: capDevice, buffers } = makeFakeWebGpuDevice({
      withErrorScopes: true,
      scopedCaptureError: { filter: "out-of-memory", error: { message: "Staging OOM" } },
    });
    const capCtx = makeFakeWebGpuContext(capDevice);
    const capCanvas = makeWhatwgCanvas({ contexts: { webgpu: capCtx } });
    const capSurface = new WebGpuSurface(capCanvas, {
      adapter: {},
      device: capDevice,
      format: "rgba8unorm",
      limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
      isLost: () => false,
      onLost: () => () => {},
      dispose: () => {},
    });
    await capSurface.verifyInit();
    await assert.rejects(() => capSurface.requestCapture(), /Staging OOM/);
    const staging = buffers.find((b) => b.label === "WebGpuCaptureStagingBuffer");
    assert.ok(staging);
    assert.equal(staging.destroyed, true);
    assert.equal(staging.unmapCalls, 0);
    capSurface.dispose();
  } finally {
    restoreNavigator(originalNav);
    resetSharedWebGpuDevice();
  }
});

// ---------------------------------------------------------------------------
// Issue #254 (WebGPU stagingBuffer): deterministic cleanup on errors and loss
// ---------------------------------------------------------------------------

test("#254: WebGpuSurface.requestCapture deterministically unmaps/destroys stagingBuffer across submit, mapAsync, getMappedRange and onLost", async () => {
  const makeSurfaceWith = (deviceOpts) => {
    const { device, buffers } = makeFakeWebGpuDevice(deviceOpts);
    const ctx = makeFakeWebGpuContext(device);
    const canvas = makeWhatwgCanvas({ contexts: { webgpu: ctx } });
    let lostCb = null;
    let lost = false;
    let unsubCalls = 0;
    const handle = {
      adapter: {},
      device,
      format: "rgba8unorm",
      limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
      isLost: () => lost,
      onLost: (cb) => {
        lostCb = cb;
        return () => { unsubCalls++; lostCb = null; };
      },
      dispose: () => {},
    };
    const surface = new WebGpuSurface(canvas, handle);
    return {
      surface,
      buffers,
      triggerLost(reason = "device-lost") {
        lost = true;
        lostCb?.(reason);
      },
      getUnsubCalls: () => unsubCalls,
    };
  };

  // 1. submit throws -> destroy called, unmap NOT called
  {
    const { surface, buffers } = makeSurfaceWith({ submitError: new Error("submit failed") });
    await assert.rejects(() => surface.requestCapture(), /submit failed/);
    const staging = buffers.find((b) => b.label === "WebGpuCaptureStagingBuffer");
    assert.equal(staging.destroyed, true);
    assert.equal(staging.unmapCalls, 0);
    surface.dispose();
  }

  // 2. mapAsync rejects -> destroy called, unmap NOT called
  {
    const { surface, buffers } = makeSurfaceWith({ stagingOverrides: { mapError: new Error("map rejected") } });
    await assert.rejects(() => surface.requestCapture(), /map rejected/);
    const staging = buffers.find((b) => b.label === "WebGpuCaptureStagingBuffer");
    assert.equal(staging.destroyed, true);
    assert.equal(staging.unmapCalls, 0);
    surface.dispose();
  }

  // 3. getMappedRange throws -> unmap AND destroy called
  {
    const { surface, buffers } = makeSurfaceWith({ stagingOverrides: { getMappedRangeError: new Error("mapped range failed") } });
    await assert.rejects(() => surface.requestCapture(), /mapped range failed/);
    const staging = buffers.find((b) => b.label === "WebGpuCaptureStagingBuffer");
    assert.equal(staging.destroyed, true);
    assert.equal(staging.unmapCalls, 1);
    surface.dispose();
  }

  // 4. handle.onLost during pending mapAsync -> immediate rejection, subscription cleaned up, staging destroyed
  {
    let resolveMap;
    const pendingMap = new Promise((resolve) => { resolveMap = resolve; });
    const { surface, buffers, triggerLost, getUnsubCalls } = makeSurfaceWith({
      stagingOverrides: { mapPromise: pendingMap },
    });
    const capturePromise = surface.requestCapture();
    await new Promise((r) => setTimeout(r, 0));
    triggerLost("device-lost");
    await assert.rejects(() => capturePromise, /device lost during capture/);
    const staging = buffers.find((b) => b.label === "WebGpuCaptureStagingBuffer");
    assert.equal(staging.destroyed, true);
    assert.equal(staging.unmapCalls, 0);
    assert.equal(getUnsubCalls(), 1);
    resolveMap();
    surface.dispose();
    assert.equal(getUnsubCalls(), 2);
  }

  // 5. surface.dispose() during pending mapAsync -> immediate rejection, staging destroyed
  {
    let resolveMap;
    const pendingMap = new Promise((resolve) => { resolveMap = resolve; });
    const { surface, buffers, getUnsubCalls } = makeSurfaceWith({
      stagingOverrides: { mapPromise: pendingMap },
    });
    const capturePromise = surface.requestCapture();
    await new Promise((r) => setTimeout(r, 0));
    surface.dispose();
    await assert.rejects(() => capturePromise, /disposed during capture/);
    const staging = buffers.find((b) => b.label === "WebGpuCaptureStagingBuffer");
    assert.equal(staging.destroyed, true);
    assert.equal(staging.unmapCalls, 0);
    assert.equal(getUnsubCalls(), 2);
    resolveMap();
  }
});

// ---------------------------------------------------------------------------
// Issue #255: Canvas2D contextlost / contextrestored (scene + overlays)
// ---------------------------------------------------------------------------

test("#255: Canvas2dSurface handles contextlost, beginFrame/requestCapture guard, restoreCanvas2dContext and listener cleanup", async () => {
  const ctxA = makeFake2dContext();
  let ctxBFillCalls = 0;
  const ctxB = {
    ...makeFake2dContext(),
    fillRect() { ctxBFillCalls++; },
  };
  let activeCtx = ctxA;
  const canvas = makeWhatwgCanvas({ contexts: { "2d": () => activeCtx } });
  const surface = new Canvas2dSurface(canvas, ctxA);

  const reasons = [];
  const unbind = surface.onLost((reason) => reasons.push(reason));
  assert.equal(canvas.listenerCount("contextlost"), 1);

  const ev = canvas.dispatchEvent("contextlost");
  assert.equal(ev.defaultPrevented, false, "Canvas2D contextlost must NOT call preventDefault (WHATWG spec)");
  assert.deepEqual(reasons, ["context-lost"]);
  await assert.rejects(() => surface.requestCapture(), /context is lost/);

  const lostFrame = surface.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
  lostFrame.quads.rect(0, 0, 10, 10, { r: 1, g: 0, b: 0, a: 1 });
  lostFrame.flushQuads();
  lostFrame.end();
  assert.equal(ctxA.transforms.length, 0, "beginFrame is a no-op while context is lost");

  activeCtx = ctxB;
  assert.equal(surface.restoreCanvas2dContext(), true);
  const restoredFrame = surface.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
  restoredFrame.flushQuads();
  restoredFrame.end();
  assert.equal(ctxBFillCalls, 1, "restored context renders normally");
  const frame = await surface.requestCapture();
  assert.equal(frame.width, 640);

  unbind();
  assert.equal(canvas.listenerCount("contextlost"), 0);
  surface.dispose();
});

test("#255: Overlay.invalidateWarmCaches and updateContext refresh retained caches", () => {
  const createBitmapCanvas = () => {
    const c = makeWhatwgCanvas({ contexts: { "2d": makeFake2dContext() } });
    return c;
  };
  const doc = { createElement: createBitmapCanvas };
  const ctx1 = makeFake2dContext();
  ctx1.canvas = { width: 800, height: 600, ownerDocument: doc };
  const ctx2 = makeFake2dContext();
  ctx2.canvas = { width: 800, height: 600, ownerDocument: doc };

  let drawCalls = 0;
  const overlay = new Overlay(
    ctx1,
    () => { drawCalls++; },
    () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
  );
  const view = new View();
  view.area = { left: 0, top: 0, width: 700, height: 550 };
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars([{ startTime: 1_699_999_980_000, open: 100, high: 105, low: 95, close: 102, volume: 10, delta: 2, count: 5, cells: new Map(), hasRef: true }]);
  const crosshair = { x: 0, y: 0, visible: false };

  overlay.renderAnnotations(view, series, crosshair, [0, 1], ["drawings"], ChartChange.All);
  overlay.renderAnnotations(view, series, crosshair, [0, 1], ["drawings"], ChartChange.DataTail);
  assert.equal(drawCalls, 1, "warm cache reuses retained static pass before loss");

  overlay.updateContext(ctx2);
  overlay.renderAnnotations(view, series, crosshair, [0, 1], ["drawings"], ChartChange.DataTail);
  assert.equal(drawCalls, 2, "updateContext invalidates warm caches so restored context redraws");
  overlay.dispose();
});

test("#255: ChartSession Canvas2D main scene + annotation + interaction contextlost/restored lifecycle and cleanup", async () => {
  resetGpuDiagnosticsForTest();
  let nextRaf = 1;
  const rafs = new Map();
  const win = {
    devicePixelRatio: 2,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(cb) { const id = nextRaf++; rafs.set(id, cb); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    runNextFrame() {
      const first = rafs.entries().next().value;
      assert.ok(first);
      rafs.delete(first[0]);
      first[1](0);
    },
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  };

  let sceneCtx = makeFake2dContext();
  let annCtx = makeFake2dContext();
  let intCtx = makeFake2dContext();
  const doc = { defaultView: win, createElement: () => makeWhatwgCanvas({ ownerDocument: doc }) };

  const gpuCanvas = makeWhatwgCanvas({ ownerDocument: doc, contexts: { "2d": () => sceneCtx } });
  const annotationCanvas = makeWhatwgCanvas({ ownerDocument: doc, contexts: { "2d": () => annCtx } });
  const interactionCanvas = makeWhatwgCanvas({ ownerDocument: doc, contexts: { "2d": () => intCtx } });

  const c2dSurface = new Canvas2dSurface(gpuCanvas, sceneCtx);
  let counts = { gpu: 0, ann: 0, int: 0 };
  let lostCallbacks = 0;
  let onResizeCalls = 0;
  const restoredAnnContexts = [];
  const restoredIntContexts = [];
  let warmCacheInvalidations = 0;
  const renderedFrames = [];

  const session = new ChartSession({
    container: { ownerDocument: doc, getBoundingClientRect: () => ({ width: 640, height: 360 }) },
    gpuCanvas,
    gpuSurface: c2dSurface,
    annotationCanvas,
    interactionCanvas,
    ownerDocument: doc,
    annotationCtx2d: annCtx,
    interactionCtx2d: intCtx,
    renderer: { render() { counts.gpu++; }, visibleRange: () => [0, 0] },
    annotation: { render() { counts.ann++; } },
    interaction: { render() { counts.int++; } },
    view: {},
    series: { length: 0 },
    crosshair: { x: 0, y: 0, visible: false },
    onRestoreContext: () => {},
    onLostContext: () => { lostCallbacks++; },
    onResize: () => { onResizeCalls++; },
    onRestoreCanvas2dContext: () => { warmCacheInvalidations++; },
    onRestoreAnnotationContext: (ctx) => { restoredAnnContexts.push(ctx); },
    onRestoreInteractionContext: (ctx) => { restoredIntContexts.push(ctx); },
    onRendered: (surfaces, changes) => renderedFrames.push({ surfaces, changes }),
  });

  session.activate();
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, ann: 1, int: 1 });
  const initialResizeCalls = onResizeCalls;

  // 1. Main scene Canvas2D contextlost -> cancels RAF, rejects pending capture, blocks new capture
  const pendingSceneCapture = session.captureCompositePng();
  assert.equal(rafs.size, 1);
  const sceneLostEv = gpuCanvas.dispatchEvent("contextlost");
  assert.equal(sceneLostEv.defaultPrevented, false, "scene Canvas2D contextlost must NOT call preventDefault");
  assert.equal(rafs.size, 0);
  assert.equal(lostCallbacks, 1);
  await assert.rejects(() => pendingSceneCapture, /Canvas2D context was lost/);
  await assert.rejects(() => session.captureCompositePng(), /not renderable/);

  // Main scene Canvas2D contextrestored at unchanged size -> forces DPR/transform without spurious onResize + warm caches + ONE full invalidation
  const freshSceneCtx = makeFake2dContext();
  sceneCtx = freshSceneCtx;
  annCtx.transforms.length = 0;
  intCtx.transforms.length = 0;
  gpuCanvas.dispatchEvent("contextrestored");
  assert.equal(warmCacheInvalidations, 1);
  assert.equal(onResizeCalls, initialResizeCalls, "unchanged-size contextrestored must not fire onResize");
  assert.deepEqual(annCtx.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(intCtx.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
  assert.equal(rafs.size, 1);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 2, ann: 2, int: 2 });
  assert.deepEqual(renderedFrames.at(-1), { surfaces: ChartSurfaceDirty.All, changes: ChartChange.All });

  // 2. Annotation contextlost -> rejects pending capture, blocks capture, skips annotation draw
  const pendingAnnCapture = session.captureCompositePng();
  const annLostEv = annotationCanvas.dispatchEvent("contextlost");
  assert.equal(annLostEv.defaultPrevented, false, "annotation Canvas2D contextlost must NOT call preventDefault");
  await assert.rejects(() => pendingAnnCapture, /annotation Canvas2D context was lost/);
  await assert.rejects(() => session.captureCompositePng(), /not renderable/);
  session.invalidate(ChartChange.All);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 3, ann: 2, int: 3 }, "annotation render skipped while annotation context lost");

  // Annotation contextrestored -> fresh ctx, DPR transform without spurious onResize, ONE full invalidation
  const freshAnnCtx = makeFake2dContext();
  annCtx = freshAnnCtx;
  annotationCanvas.dispatchEvent("contextrestored");
  assert.deepEqual(restoredAnnContexts, [freshAnnCtx]);
  assert.equal(onResizeCalls, initialResizeCalls, "unchanged-size annotation restore must not fire onResize");
  assert.deepEqual(freshAnnCtx.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
  assert.equal(rafs.size, 1);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 4, ann: 3, int: 4 });

  // 3. Interaction contextlost / contextrestored
  const intLostEv = interactionCanvas.dispatchEvent("contextlost");
  assert.equal(intLostEv.defaultPrevented, false, "interaction Canvas2D contextlost must NOT call preventDefault");
  session.invalidate(ChartChange.All);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 5, ann: 4, int: 4 }, "interaction render skipped while interaction context lost");

  const freshIntCtx = makeFake2dContext();
  intCtx = freshIntCtx;
  interactionCanvas.dispatchEvent("contextrestored");
  assert.deepEqual(restoredIntContexts, [freshIntCtx]);
  assert.equal(onResizeCalls, initialResizeCalls, "unchanged-size interaction restore must not fire onResize");
  assert.deepEqual(freshIntCtx.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
  assert.equal(rafs.size, 1);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 6, ann: 5, int: 5 });

  // 4. replaceSurface cleans up old Canvas2D context listeners
  const replacementCanvas = makeWhatwgCanvas({ ownerDocument: doc, contexts: { "2d": () => freshSceneCtx } });
  session.replaceSurface(new Canvas2dSurface(replacementCanvas, freshSceneCtx));
  assert.equal(gpuCanvas.listenerCount("contextlost"), 0, "replaceSurface removes contextlost from previous Canvas2D canvas");
  assert.equal(gpuCanvas.listenerCount("contextrestored"), 0, "replaceSurface removes contextrestored from previous Canvas2D canvas");
  assert.equal(gpuCanvas.listenerOps.add, gpuCanvas.listenerOps.remove);
  assert.equal(replacementCanvas.listenerCount("contextlost"), 1);
  assert.equal(replacementCanvas.listenerCount("contextrestored"), 1);

  const diag = getGpuDiagnostics();
  assert.equal(diag.counters["chart.canvas2d.contextLost"], 3);
  assert.equal(diag.counters["chart.canvas2d.contextRestored"], 3);
  assert.equal(diag.counters["chart.canvas2d.scene.contextLost"], 1);
  assert.equal(diag.counters["chart.canvas2d.scene.contextRestored"], 1);
  assert.equal(diag.counters["chart.canvas2d.annotation.contextLost"], 1);
  assert.equal(diag.counters["chart.canvas2d.annotation.contextRestored"], 1);
  assert.equal(diag.counters["chart.canvas2d.interaction.contextLost"], 1);
  assert.equal(diag.counters["chart.canvas2d.interaction.contextRestored"], 1);

  session.destroy();
  for (const c of [gpuCanvas, replacementCanvas, annotationCanvas, interactionCanvas]) {
    assert.equal(c.listenerOps.add, c.listenerOps.remove, "all context listeners cleaned up on destroy");
  }
});
