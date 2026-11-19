import test from "node:test";
import assert from "node:assert/strict";

import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { ChartIndicatorController } from "../dist/features/chart/ChartIndicatorController.js";
import { ChartInputController } from "../dist/features/chart/ChartInputController.js";
import { mountChartRuntime } from "../dist/features/chart/ChartRuntime.js";
import { chartHost, configureChartHost } from "../dist/features/chart/chartHost.js";
import { IndicatorManager } from "../dist/features/indicators/IndicatorManager.js";
import { createIndicatorPaneHeadersModel } from "../dist/features/indicators/indicatorPaneHeaders.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const MARKET = "BINANCE_FUTURES:btcusdt";

function makeRsiInstance(id = "rsi-1", paneScaleFactor = 1) {
  return {
    id,
    type: "rsi",
    title: "RSI",
    visible: true,
    placement: "separate-pane",
    paneHeight: 110,
    collapsed: false,
    order: 0,
    settings: {
      period: 14,
      overbought: 70,
      oversold: 30,
      color: "#38bdf8",
      lineWidth: 1.5,
      showLastValueLabel: true,
      showReadout: true,
      showAxisTicks: true,
      showPlotLabel: true,
      paneScaleAuto: true,
      paneScaleFactor,
    },
  };
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

function createInputHarness(paneId = "rsi-1") {
  const listeners = new Map();
  const captured = new Set();
  const docListeners = new Map();
  const winListeners = new Map();

  const emitMap = (map, type, event) => {
    for (const fn of [...(map.get(type) ?? [])]) fn(event);
  };

  let emitLostCaptureOnRelease = false;
  const ownerDocument = {
    visibilityState: "visible",
    defaultView: null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  };
  const win = {
    performance: { now: () => Date.now() },
    document: ownerDocument,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
  };
  ownerDocument.defaultView = win;

  const canvas = {
    ownerDocument,
    parentElement: null,
    style: { cursor: "" },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    setPointerCapture(id) { captured.add(id); },
    releasePointerCapture(id) {
      if (!captured.delete(id)) return;
      if (emitLostCaptureOnRelease) {
        emitMap(listeners, "lostpointercapture", { pointerId: id, button: 0, pointerType: "mouse", target: canvas, preventDefault() {} });
      }
    },
    hasPointerCapture(id) { return captured.has(id); },
    focus() {},
    dispatchEvent() { return true; },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 400, bottom: 360, width: 400, height: 360, x: 0, y: 0 };
    },
  };

  const invalidations = [];
  const drawings = new DrawingManager(() => {});
  const onChangeCalls = [];
  let serializeCalls = 0;
  let layoutCalls = 0;

  const origSerialize = IndicatorManager.prototype.serialize;
  IndicatorManager.prototype.serialize = function serializeSpy() {
    serializeCalls += 1;
    return origSerialize.call(this);
  };

  const indicatorController = new ChartIndicatorController({
    ownerDocument,
    root: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 360 }) },
    initial: [makeRsiInstance(paneId, 1)],
    onChange(instances) { onChangeCalls.push(instances); },
    onLayoutChange() { layoutCalls += 1; },
    onInvalidate(changes) { invalidations.push(changes); },
    getChartContext: () => ({ market: MARKET, timeframe: "15m", intervalMs: 900_000 }),
    queuePriceLabel() {},
    headers: createIndicatorPaneHeadersModel(),
  });
  let hostDisposed = false;

  const host = {
    svc: { getAnalysisContext: () => ({ drawings }) },
    view: {
      area: { left: 0, top: 0, width: 350, height: 240 },
      priceAxisW: 50,
      subPanesH: 110,
      chartLayoutOptions: { timeAxisHeight: 28 },
      priceTop: 100,
      pricePerPx: 1,
      isPriceAutoScale: () => true,
      setPriceAutoScale() {},
      indexOfX: (x) => x,
      priceOfY: (y) => 500 - y,
      startPriceAxisScale() {},
      scalePriceAxisTo() {},
      endPriceAxisScale() {},
      zoomY() {},
    },
    session: {
      invalidate(changes = ChartChange.All) { invalidations.push(changes); },
      invalidateSurface() {},
    },
    pipeline: { series: { length: 10 } },
    overlay: {
      getIndicatorAxisPaneAt: (cx, cy) => (cx >= 350 && cy >= 240 ? paneId : null),
      getIndicatorScaleControlAt: () => null,
      getPriceScaleControlAt: () => null,
      getMenuButtonAt: () => false,
      getMenuButtonRect: () => null,
    },
    timeViewport: {
      beginPlotPan() {},
      dragPlotPanTo() {},
      endPlotPan() {},
      beginTimeAxisScale() {},
      dragTimeAxisScaleTo() {},
      endTimeAxisScale() {},
    },
    state: { market: MARKET, timeframe: "15m" },
    panelId: "indicator-scale-test",
    applyingExternal: false,
    isDisposed: () => hostDisposed,
    isReplaySelecting: () => false,
    previewReplayStart() {},
    selectReplayStart() {},
    screenToDrawingPoint: (cx, cy) => ({ time: cx * 10, price: 500 - cy }),
    indexToTime: (idx) => idx * 10,
    resolveScreenCrosshair: (cx, cy) => ({ time: cx * 10, price: 500 - cy }),
    notifyCrosshair() {},
    autoFit() {},
    emitVisibleRange() {},
    clearMagnetSnap() {},
    scaleIndicatorPane: (id, factor, persist) => indicatorController.scalePane(id, factor, persist),
    resetIndicatorPaneScale: (id) => indicatorController.resetPaneScale(id),
    toggleIndicatorScaleModeFromControl: () => "linear",
    setPriceAutoScaleFromControl() {},
    togglePriceScaleModeFromControl() { return "linear"; },
    togglePaneMaximizeAt: () => false,
    isChartPaneMaximized: () => false,
    hasIndicatorPanes: () => true,
    resetTimeScale() {},
    resetPriceScale() {},
    resetAllScales() {},
    goLatest() {},
    togglePriceAutoScale: () => true,
    togglePriceScaleMode: () => "linear",
    toggleIndicatorPanes() {},
    togglePanelMaximize() {},
    toggleIndicatorPaneAutoScale: (id) => indicatorController.togglePaneAutoScale(id),
    setChartType() {},
    setCellData() {},
    setTpoMode() {},
    setTpoProfilePeriod() {},
    setTpoBracketSize() {},
  };

  const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false }, host);

  const emit = (type, init = {}) => {
    const event = {
      pointerId: 1,
      button: 0,
      pointerType: "mouse",
      clientX: 375,
      clientY: 280,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      target: canvas,
      preventDefault() {},
      ...init,
    };
    emitMap(listeners, type, event);
    if (type === "pointerup") emitMap(winListeners, "pointerup", event);
  };

  return {
    controller,
    indicatorController,
    canvas,
    captured,
    onChangeCalls,
    invalidations,
    getSerializeCalls: () => serializeCalls,
    getLayoutCalls: () => layoutCalls,
    setEmitLostCaptureOnRelease(value) { emitLostCaptureOnRelease = value; },
    markHostDisposed() { hostDisposed = true; },
    emit,
    readCommittedFactorWithoutSpyBump() {
      const saved = serializeCalls;
      const factor = indicatorController.listInstances()[0].settings.paneScaleFactor;
      serializeCalls = saved;
      return factor;
    },
    disposeAll() {
      IndicatorManager.prototype.serialize = origSerialize;
      controller.dispose();
      indicatorController.dispose();
    },
  };
}

test("IndicatorManager.scalePane updates in-memory factor without serialize/onChange when persist=false and persists once when persist=true", () => {
  const onChange = [];
  const invalidations = [];
  let serializeCalls = 0;
  class SpyManager extends IndicatorManager {
    serialize() {
      serializeCalls += 1;
      return super.serialize();
    }
  }
  const manager = new SpyManager({
    ownerDocument: {},
    root: {},
    initial: [makeRsiInstance("rsi-1", 1)],
    onChange(instances) { onChange.push(instances); },
    onLayoutChange() {},
    onInvalidate(changes) { invalidations.push(changes); },
    headers: createIndicatorPaneHeadersModel(),
  });

  try {
    const rev0 = manager.getRenderRevision();
    assert.equal(manager.scalePane("rsi-1", Math.exp(0.15), false), true);
    assert.equal(manager.scalePane("rsi-1", Math.exp(-0.05), false), true);

    assert.equal(serializeCalls, 0);
    assert.equal(onChange.length, 0);
    assert.ok(manager.getRenderRevision() > rev0);
    assert.deepEqual(invalidations, [ChartChange.Style, ChartChange.Style]);

    const expected = Math.exp(0.15) * Math.exp(-0.05);
    assert.equal(manager.peekInstances()[0].settings.paneScaleAuto, false);
    assert.equal(manager.peekInstances()[0].settings.paneScaleFactor, expected);

    assert.equal(manager.scalePane("rsi-1", 1, true), true);
    assert.equal(serializeCalls, 1);
    assert.equal(onChange.length, 1);
    assert.equal(onChange[0][0].settings.paneScaleFactor, expected);
  } finally {
    manager.dispose();
  }
});

test("indicator axis drag defers serialize/onChange across N pointermoves and commits exact cumulative factor once on pointerup", () => {
  const h = createInputHarness();
  try {
    const deltas = [14, -6, 22, 9, -15, 11, 8, -4];
    let expectedFactor = 1;
    for (const dy of deltas) {
      expectedFactor = Math.max(0.05, Math.min(20, expectedFactor * Math.exp(dy * 0.01)));
    }

    let y = 280;
    h.emit("pointerdown", { clientX: 375, clientY: y });
    assert.equal(h.captured.has(1), true);

    const beforeInvalidations = h.invalidations.length;
    for (const dy of deltas) {
      y += dy;
      h.emit("pointermove", { clientX: 375, clientY: y });
      assert.equal(h.getSerializeCalls(), 0, "serialize must not run during pointermove");
      assert.equal(h.onChangeCalls.length, 0, "onChange must not run during pointermove");
    }
    assert.ok(h.invalidations.length > beforeInvalidations, "drag preview still invalidates canvas");

    h.emit("pointerup", { clientX: 375, clientY: y });
    assert.equal(h.getSerializeCalls(), 1, "serialize runs once on pointerup");
    assert.equal(h.onChangeCalls.length, 1, "onChange fires once on pointerup");
    assert.equal(h.onChangeCalls[0][0].settings.paneScaleFactor, expectedFactor);
    assert.equal(h.onChangeCalls[0][0].settings.paneScaleAuto, false);
    assert.equal(h.readCommittedFactorWithoutSpyBump(), expectedFactor, "committed factor matches cumulative multiplication bit-for-bit");
    assert.equal(h.captured.has(1), false);
  } finally {
    h.disposeAll();
  }
});

test("indicator axis drag with dy = 0 triggers zero serialize/onChange on moves and on pointerup", () => {
  const h = createInputHarness();
  try {
    h.emit("pointerdown", { clientX: 375, clientY: 280 });
    h.emit("pointermove", { clientX: 376, clientY: 280 });
    h.emit("pointermove", { clientX: 379, clientY: 280 });
    h.emit("pointermove", { clientX: 374, clientY: 280 });
    h.emit("pointerup", { clientX: 374, clientY: 280 });

    assert.equal(h.getSerializeCalls(), 0);
    assert.equal(h.onChangeCalls.length, 0);
    assert.equal(h.readCommittedFactorWithoutSpyBump(), 1);
    assert.equal(h.captured.has(1), false);
  } finally {
    h.disposeAll();
  }
});

test("pointercancel followed by lostpointercapture (and reverse order) emits at most one persist", () => {
  const h = createInputHarness();
  try {
    h.setEmitLostCaptureOnRelease(true);
    h.emit("pointerdown", { clientX: 375, clientY: 280 });
    h.emit("pointermove", { clientX: 375, clientY: 300 });
    h.emit("pointermove", { clientX: 375, clientY: 315 });
    assert.equal(h.onChangeCalls.length, 0);

    // pointercancel releases pointer capture -> synchronously fires lostpointercapture
    h.emit("pointercancel", { clientX: 375, clientY: 315 });
    // Explicit trailing lostpointercapture must also remain a no-op
    h.emit("lostpointercapture", { clientX: 375, clientY: 315 });

    assert.equal(h.getSerializeCalls(), 1);
    assert.equal(h.onChangeCalls.length, 1);

    // Reverse order: lostpointercapture fires before pointerup
    h.emit("pointerdown", { clientX: 375, clientY: 280 });
    h.emit("pointermove", { clientX: 375, clientY: 260 });
    h.emit("lostpointercapture", { clientX: 375, clientY: 260 });
    h.emit("pointerup", { clientX: 375, clientY: 260 });

    assert.equal(h.getSerializeCalls(), 2);
    assert.equal(h.onChangeCalls.length, 2);
  } finally {
    h.disposeAll();
  }
});

test("wheel scaling over indicator axis still commits once per wheel step", () => {
  const h = createInputHarness();
  try {
    const wheelDeltas = [120, -80, 40];
    let expected = 1;
    for (const deltaY of wheelDeltas) {
      expected = Math.max(0.05, Math.min(20, expected * Math.exp(deltaY * 0.0015)));
    }

    for (let i = 0; i < wheelDeltas.length; i++) {
      h.emit("wheel", { clientX: 375, clientY: 280, deltaY: wheelDeltas[i] });
      assert.equal(h.getSerializeCalls(), i + 1);
      assert.equal(h.onChangeCalls.length, i + 1);
    }
    assert.equal(h.readCommittedFactorWithoutSpyBump(), expected);
  } finally {
    h.disposeAll();
  }
});

test("dispose mid-drag cleans up active gesture without persisting, leaking capture, or throwing", () => {
  const h = createInputHarness();
  try {
    h.setEmitLostCaptureOnRelease(true);
    h.emit("pointerdown", { clientX: 375, clientY: 280 });
    h.emit("pointermove", { clientX: 375, clientY: 305 });
    h.emit("pointermove", { clientX: 375, clientY: 325 });
    assert.equal(h.onChangeCalls.length, 0);

    h.markHostDisposed();
    h.disposeAll();
    assert.equal(h.captured.size, 0);
    assert.equal(h.getSerializeCalls(), 0);
    assert.equal(h.onChangeCalls.length, 0);

    // Post-dispose stray pointer events are ignored safely
    h.emit("pointermove", { clientX: 375, clientY: 340 });
    h.emit("pointerup", { clientX: 375, clientY: 340 });
    h.emit("lostpointercapture", { clientX: 375, clientY: 340 });
    assert.equal(h.getSerializeCalls(), 0);
    assert.equal(h.onChangeCalls.length, 0);
  } finally {
    h.disposeAll();
  }
});

test("mounted ChartRuntime defers chartHost.indicatorsChanged and onStateChange during indicator drag moves and commits once on release", async (t) => {
  let prevHost = null;
  try { prevHost = chartHost(); } catch { prevHost = null; }
  t.after(() => configureChartHost(prevHost));
  useFakeChartDataSource(t, { history: [] });

  let indicatorsChangedCount = 0;
  let registeredRuntime = null;
  configureChartHost({
    registerRuntime(_id, rt) { registeredRuntime = rt; },
    unregisterRuntime(_id, rt) { if (registeredRuntime === rt) registeredRuntime = null; },
    indicatorsChanged() { indicatorsChangedCount += 1; },
    setDataDegraded() {},
    isFootprintAutoFillEnabled: () => false,
    getPairChartType: () => undefined,
    setPairChartType() {},
    exposeDebugGlobals: () => false,
  });

  const rafQueue = new Map();
  let nextRafId = 1;
  const FakeResizeObserver = class {
    observe() {}
    disconnect() {}
  };

  const docListeners = new Map();
  let doc;
  const makeNode = (tag) => {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    const captured = new Set();
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
      setPointerCapture(id) { captured.add(id); },
      releasePointerCapture(id) { captured.delete(id); },
      hasPointerCapture(id) { return captured.has(id); },
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
  doc.head.ownerDocument = doc;
  const win = {
    devicePixelRatio: 1,
    location: { search: "?gpu=canvas2d" },
    performance: { now: () => Date.now() },
    document: doc,
    ResizeObserver: FakeResizeObserver,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame(cb) {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) { rafQueue.delete(id); },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = win;

  const panelRoot = makeNode("div");
  const drawings = new DrawingManager(() => {});
  const services = {
    subscribeToTrades: () => () => {},
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

  const stateChanges = [];
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
      indicators: [makeRsiInstance("rsi-1", 1)],
    },
    services,
    "runtime-drag-test",
    surface,
    (next) => stateChanges.push(next),
  );

  try {
    for (let i = 0; i < 20 && surface.status === "loading"; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(surface.status, "ready");
    assert.ok(registeredRuntime);

    // Flush the first RAF so Annotation draws and populates overlay.indicatorAxisRects.
    while (rafQueue.size > 0) {
      const [id, cb] = rafQueue.entries().next().value;
      rafQueue.delete(id);
      cb(0);
    }

    const interactionCanvas = panelRoot.children.find((el) => el.dataset.chartSurface === "interaction");
    assert.ok(interactionCanvas);

    const startX = registeredRuntime.view.area.left + registeredRuntime.view.area.width + registeredRuntime.view.priceAxisW / 2;
    let y = registeredRuntime.view.area.top + registeredRuntime.view.area.height + 40;
    assert.equal(registeredRuntime.overlay.getIndicatorAxisPaneAt(startX, y), "rsi-1");

    const deltas = [12, -5, 18, 7, -9];
    let expectedFactor = 1;
    for (const dy of deltas) {
      expectedFactor = Math.max(0.05, Math.min(20, expectedFactor * Math.exp(dy * 0.01)));
    }

    indicatorsChangedCount = 0;
    stateChanges.length = 0;
    const emitPointer = (type, clientY) => interactionCanvas.dispatchEvent({
      type,
      pointerId: 7,
      button: 0,
      pointerType: "mouse",
      clientX: startX,
      clientY,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: interactionCanvas,
      preventDefault() {},
    });

    emitPointer("pointerdown", y);
    for (const dy of deltas) {
      y += dy;
      emitPointer("pointermove", y);
      assert.equal(indicatorsChangedCount, 0, "indicatorsChanged must not fire during pointermove");
      assert.equal(stateChanges.length, 0, "onStateChange must not fire during pointermove");
    }

    emitPointer("pointerup", y);
    assert.equal(indicatorsChangedCount, 1, "indicatorsChanged fires once on pointerup");
    assert.equal(stateChanges.length, 1, "onStateChange fires once on pointerup");
    assert.equal(stateChanges[0].indicators[0].settings.paneScaleFactor, expectedFactor);
    assert.equal(registeredRuntime.listIndicators()[0].settings.paneScaleFactor, expectedFactor);

    // Mid-drag dispose must not emit or throw.
    indicatorsChangedCount = 0;
    stateChanges.length = 0;
    emitPointer("pointerdown", registeredRuntime.view.area.top + registeredRuntime.view.area.height + 40);
    emitPointer("pointermove", registeredRuntime.view.area.top + registeredRuntime.view.area.height + 60);
    handle.dispose();
    assert.equal(indicatorsChangedCount, 0);
    assert.equal(stateChanges.length, 0);
  } finally {
    handle.dispose();
  }
});
