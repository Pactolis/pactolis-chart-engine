import test from "node:test";
import assert from "node:assert/strict";

import { Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";
import { mountChartRuntime } from "../dist/features/chart/ChartRuntime.js";
import { chartHost, configureChartHost } from "../dist/features/chart/chartHost.js";
import { CHART_CANVAS_ARIA_KEYSHORTCUTS } from "../dist/features/chart/chartCanvasAccessibility.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { createIndicatorPaneHeadersModel } from "../dist/features/indicators/indicatorPaneHeaders.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const MARKET = "BINANCE_FUTURES:btcusdt";

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function makeFake2dContext(canvas) {
  let tx = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    canvas,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    rect() {},
    roundRect() {},
    arc() {},
    clip() {},
    fill() {},
    stroke() {},
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    setLineDash() {},
    fillText() {},
    measureText(text) { return { width: String(text).length * 7 }; },
    setTransform(a, b, c, d, e, f) {
      if (typeof a === "number") tx = { a, b, c, d, e, f };
    },
    getTransform() { return { ...tx }; },
    drawImage() {},
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    getImageData(_x, _y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
  };
}

function makeFakeDomEnv(dpr = 2) {
  let nextRafId = 1;
  const rafs = new Map();
  const scheduledRafIds = [];
  const cancelledRafIds = [];
  const capturedCallbacks = new Map();
  const mediaListeners = new Set();
  const mediaOps = { add: 0, remove: 0 };
  const docListeners = new Map();
  let doc;

  const makeNode = (tag) => {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    const children = [];
    const el = {
      tagName: String(tag).toUpperCase(),
      id: "",
      dataset: {},
      className: "",
      tabIndex: -1,
      textContent: "",
      width: 0,
      height: 0,
      get ownerDocument() { return doc; },
      parentNode: null,
      parentElement: null,
      children,
      style: { cssText: "", width: "", height: "", cursor: "" },
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      removeAttribute(name) { attrs.delete(name); },
      appendChild(child) {
        child.parentNode = el;
        child.parentElement = el;
        children.push(child);
        return child;
      },
      append(...nodes) { for (const n of nodes) el.appendChild(n); },
      replaceWith(next) {
        if (!el.parentNode) return;
        const idx = el.parentNode.children.indexOf(el);
        if (idx >= 0) el.parentNode.children[idx] = next;
        next.parentNode = el.parentNode;
        next.parentElement = el.parentElement;
        el.parentNode = null;
        el.parentElement = null;
      },
      remove() {
        if (!el.parentNode) return;
        const idx = el.parentNode.children.indexOf(el);
        if (idx >= 0) el.parentNode.children.splice(idx, 1);
        el.parentNode = null;
        el.parentElement = null;
      },
      contains(target) { return target === el || children.some((c) => c === target || c.contains?.(target)); },
      getContext(kind) { return kind === "2d" ? makeFake2dContext(el) : null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0 }; },
      setPointerCapture() {},
      releasePointerCapture() {},
      hasPointerCapture() { return false; },
      focus() {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatchEvent(ev) {
        for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
    };
    return el;
  };

  doc = {
    visibilityState: "visible",
    defaultView: null,
    head: null,
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => doc.head.children.find((n) => n.id === id) ?? null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  };
  doc.head = makeNode("head");

  const win = {
    devicePixelRatio: dpr,
    location: { search: "?gpu=canvas2d" },
    performance: { now: () => Date.now() },
    document: doc,
    ResizeObserver: FakeResizeObserver,
    mediaOps,
    mediaListenerCount: () => mediaListeners.size,
    matchMedia() {
      return {
        addEventListener(_type, cb) { mediaOps.add += 1; mediaListeners.add(cb); },
        removeEventListener(_type, cb) { mediaOps.remove += 1; mediaListeners.delete(cb); },
      };
    },
    requestAnimationFrame(cb) {
      const id = nextRafId++;
      scheduledRafIds.push(id);
      capturedCallbacks.set(id, cb);
      rafs.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledRafIds.push(id);
      rafs.delete(id);
    },
    queuedRafCount: () => rafs.size,
    scheduledRafIds,
    cancelledRafIds,
    capturedCallbacks,
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = win;

  const makeContainer = () => makeNode("div");
  return { doc, win, makeContainer };
}

test("ChartSession.updateContainer does not accumulate DPR cleanup closures on LifecycleController", () => {
  const env = makeFakeDomEnv(2);
  const container = env.makeContainer();
  const gpuCanvas = env.doc.createElement("canvas");
  const annotationCanvas = env.doc.createElement("canvas");
  const interactionCanvas = env.doc.createElement("canvas");

  const session = new ChartSession({
    container,
    gpuCanvas,
    gpuSurface: new Canvas2dSurface(gpuCanvas),
    annotationCanvas,
    interactionCanvas,
    ownerDocument: env.doc,
    annotationCtx2d: makeFake2dContext(annotationCanvas),
    interactionCtx2d: makeFake2dContext(interactionCanvas),
    renderer: { render() {}, visibleRange() { return [0, 0]; } },
    annotation: { render() {} },
    interaction: { render() {} },
    view: { area: { left: 0, top: 0, width: 640, height: 360 } },
    series: { length: 0 },
    crosshair: { x: 0, y: 0, visible: false },
    onRestoreContext() {},
  });

  assert.equal(env.win.mediaOps.add, 1);
  assert.equal(env.win.mediaOps.remove, 0);
  assert.equal(env.win.mediaListenerCount(), 1);

  for (let i = 0; i < 10; i++) {
    session.updateContainer(env.makeContainer());
    assert.equal(env.win.mediaListenerCount(), 1, `exactly one active DPR listener after updateContainer #${i + 1}`);
  }
  assert.equal(env.win.mediaOps.add, 11);
  assert.equal(env.win.mediaOps.remove, 10);

  session.destroy();
  assert.equal(env.win.mediaListenerCount(), 0, "no DPR listener retained after destroy");
  assert.equal(env.win.mediaOps.remove, 11, "destroy removes the single active listener without re-invoking stale closures");
});

test("ChartRuntime cancels pending mount initialPlacement requestAnimationFrame on immediate dispose and applies aria-hidden attributes", async (t) => {
  let prevHost = null;
  try { prevHost = chartHost(); } catch { prevHost = null; }
  t.after(() => configureChartHost(prevHost));
  useFakeChartDataSource(t, { history: [] });

  let registeredRuntime = null;
  configureChartHost({
    registerRuntime(_id, rt) { registeredRuntime = rt; },
    unregisterRuntime(_id, rt) { if (registeredRuntime === rt) registeredRuntime = null; },
    indicatorsChanged() {},
    setDataDegraded() {},
    isFootprintAutoFillEnabled: () => false,
    getPairChartType: () => undefined,
    setPairChartType() {},
    exposeDebugGlobals: () => false,
  });

  const env = makeFakeDomEnv(1);
  const panelRoot = env.makeContainer();
  const drawings = new DrawingManager(() => {});
  const services = {
    subscribeToTrades(_market, cb) {
      // Emit a trade during ChartDataPipeline construction while global requestAnimationFrame is unset
      // so pipeline.series.length > 0 when new ChartRuntimeImpl(...) schedules initialPlacementRafId.
      cb({ time: 1_700_000_000_000, price: 100, qty: 2, isBuyerMaker: false, id: "t-1" });
      return () => {};
    },
    fetchPriceStep: async () => 10,
    fetchPriceStepResult: async () => ({ step: 10, resolved: true }),
    fetchPricePrecision: async () => 1,
    getAnalysisContext: () => ({
      market: MARKET,
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
      market: MARKET,
      revision: 1,
      canonical: { status: "complete", market: MARKET, runKey: `${MARKET}|10`, generation: 1, revision: 1, failedPeriods: [] },
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

  const surface = {
    status: "loading",
    historyOverlay: false,
    historyBackground: false,
    indicatorHeaders: createIndicatorPaneHeadersModel(),
  };

  const handle = mountChartRuntime(
    panelRoot,
    {
      type: "chart",
      market: MARKET,
      timeframe: "15m",
      scaleMode: "linear",
      chartType: "footprint",
      candles: true,
    },
    services,
    "mount-raf-a11y-test",
    surface,
  );

  try {
    for (let i = 0; i < 20 && surface.status === "loading"; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(surface.status, "ready");
    assert.ok(registeredRuntime);

    // Verify initial mount scheduled both ChartSession RAF and initialPlacementRafId (2 queued callbacks).
    assert.ok(env.win.scheduledRafIds.length >= 2, "expected session RAF and initialPlacement RAF to be queued");
    assert.equal(env.win.queuedRafCount(), env.win.scheduledRafIds.length);

    // Check accessibility attributes immediately after mount, before dispose removes elements.
    const hook = panelRoot.children.find((el) => el.getAttribute("data-testid") === "chart-hook");
    const gpuCanvas = panelRoot.children.find((el) => el.dataset.chartSurface === "gpu-scene");
    const annotationCanvas = panelRoot.children.find((el) => el.dataset.chartSurface === "annotation");
    const interactionCanvas = panelRoot.children.find((el) => el.dataset.chartSurface === "interaction");
    assert.equal(hook?.getAttribute("aria-hidden"), "true");
    assert.equal(gpuCanvas?.getAttribute("aria-hidden"), "true");
    assert.equal(annotationCanvas?.getAttribute("aria-hidden"), "true");
    assert.equal(interactionCanvas?.getAttribute("aria-hidden"), null);
    assert.equal(interactionCanvas?.tabIndex, 0);
    assert.equal(interactionCanvas?.getAttribute("role"), "application");
    assert.equal(interactionCanvas?.getAttribute("aria-keyshortcuts"), CHART_CANVAS_ARIA_KEYSHORTCUTS);

    // replaceSurface preserves aria-hidden="true" on replacement gpuCanvas.
    const replacementGpuCanvas = env.doc.createElement("canvas");
    registeredRuntime.session.replaceSurface(new Canvas2dSurface(replacementGpuCanvas));
    assert.equal(replacementGpuCanvas.dataset.chartSurface, "gpu-scene");
    assert.equal(replacementGpuCanvas.getAttribute("aria-hidden"), "true");
    assert.equal(interactionCanvas?.getAttribute("aria-hidden"), null);

    // Immediate dispose cancels every pending RAF including initialPlacementRafId.
    handle.dispose();
    assert.equal(env.win.queuedRafCount(), 0, "all mount RAFs cancelled by dispose()");
    for (const id of env.win.scheduledRafIds) {
      assert.ok(env.win.cancelledRafIds.includes(id), `expected cancelAnimationFrame(${id})`);
    }

    // Invoking stale captured callbacks post-dispose must remain a safe no-op without scheduling new RAFs.
    for (const cb of env.win.capturedCallbacks.values()) cb(0);
    assert.equal(env.win.queuedRafCount(), 0);
  } finally {
    handle.dispose();
  }
});
