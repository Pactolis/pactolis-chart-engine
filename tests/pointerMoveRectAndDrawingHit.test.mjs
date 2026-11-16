import test from "node:test";
import assert from "node:assert/strict";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { ChartInputController } from "../dist/features/chart/ChartInputController.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";

const MARKET = "BINANCE_FUTURES:btcusdt";

function createCanvasHarness(initialRect) {
  const listeners = new Map();
  let rect = { ...initialRect };
  let rectCalls = 0;
  const canvas = {
    ownerDocument: { defaultView: null },
    parentElement: null,
    style: { cursor: "" },
    addEventListener(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() { return false; },
    focus() {},
    dispatchEvent() { return true; },
    getBoundingClientRect() {
      rectCalls += 1;
      return {
        x: rect.left,
        y: rect.top,
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
        toJSON: () => ({}),
      };
    },
  };
  return {
    canvas,
    setRect(next) { rect = { ...next }; },
    getRectCalls() { return rectCalls; },
    resetRectCalls() { rectCalls = 0; },
    emit(type, init = {}) {
      const event = {
        pointerId: 1,
        button: 0,
        pointerType: "mouse",
        clientX: 0,
        clientY: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: canvas,
        preventDefault() {},
        ...init,
      };
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function createMockHost() {
  const crosshairEvents = [];
  const replayPreviews = [];
  const priceScales = [];
  const timeScales = [];
  const drawingPointCalls = [];
  let replaySelecting = false;
  let hasDraft = false;
  let drawingDragActive = false;

  const drawings = {
    activeTool: null,
    setMarket() {},
    hasDraft: () => hasDraft,
    isPointerDragActive: () => drawingDragActive,
    peekAt: () => null,
    pointerDown: () => false,
    pointerMove: () => true,
    pointerUp: () => true,
  };

  const view = {
    area: { left: 0, top: 0, width: 350, height: 250 },
    priceAxisW: 50,
    subPanesH: 0,
    chartLayoutOptions: { timeAxisHeight: 50 },
    priceTop: 100,
    pricePerPx: 1,
    isPriceAutoScale: () => false,
    setPriceAutoScale() {},
    indexOfX: (x) => x,
    priceOfY: (y) => 500 - y,
    startPriceAxisScale() {},
    scalePriceAxisTo(y) { priceScales.push(y); },
    endPriceAxisScale() {},
    zoomY() {},
  };

  const host = {
    svc: { getAnalysisContext: () => ({ drawings }) },
    view,
    session: {
      invalidate() {},
      invalidateSurface() {},
    },
    pipeline: { series: { length: 100 } },
    overlay: {
      getIndicatorAxisPaneAt: () => null,
      getIndicatorScaleControlAt: () => null,
      getPriceScaleControlAt: () => null,
      getMenuButtonAt: () => null,
      getMenuButtonRect: () => null,
      getTpoProfileAt: () => null,
    },
    timeViewport: {
      beginPlotPan() {},
      dragPlotPanTo() {},
      endPlotPan() {},
      beginTimeAxisScale() {},
      dragTimeAxisScaleTo(x) { timeScales.push(x); },
      endTimeAxisScale() {},
    },
    state: { market: MARKET, timeframe: "15m" },
    panelId: "pointermove-unit",
    applyingExternal: false,
    isReplaySelecting: () => replaySelecting,
    previewReplayStart(time) { replayPreviews.push(time); },
    screenToDrawingPoint(cx, cy) {
      drawingPointCalls.push([cx, cy]);
      return { time: cx * 10, price: 500 - cy };
    },
    indexToTime: (idx) => idx * 10,
    resolveScreenCrosshair: (cx, cy) => ({ time: cx * 10, price: 500 - cy }),
    notifyCrosshair(event) { crosshairEvents.push(event); },
    autoFit() {},
    emitVisibleRange() {},
    clearMagnetSnap() {},
    scaleIndicatorPane() { return false; },
    setPriceAutoScaleFromControl() {},
    togglePriceScaleModeFromControl() {},
    resetIndicatorPaneScale() {},
    toggleIndicatorScaleModeFromControl() {},
  };

  return {
    host,
    drawings,
    crosshairEvents,
    replayPreviews,
    priceScales,
    timeScales,
    drawingPointCalls,
    setReplaySelecting(value) { replaySelecting = value; },
    setDrawingState(next) {
      if (next.hasDraft !== undefined) hasDraft = next.hasDraft;
      if (next.drawingDragActive !== undefined) drawingDragActive = next.drawingDragActive;
    },
  };
}

test("pointermove calls getBoundingClientRect at most once per event across hover, replay, drag and touch", () => {
  const harness = createCanvasHarness({ left: 40, top: 20, width: 400, height: 300 });
  const {
    host,
    drawings,
    crosshairEvents,
    replayPreviews,
    priceScales,
    timeScales,
    drawingPointCalls,
    setReplaySelecting,
    setDrawingState,
  } = createMockHost();
  const crosshair = { x: 0, y: 0, visible: false, touch: false };
  const controller = new ChartInputController(harness.canvas, crosshair, host);

  try {
    // 1. Normal hover + container shift between pointermove events
    harness.resetRectCalls();
    harness.emit("pointermove", { clientX: 160, clientY: 110 });
    assert.equal(harness.getRectCalls(), 1, "hover pointermove measures rect once");
    assert.equal(crosshair.x, 120);
    assert.equal(crosshair.y, 90);
    assert.deepEqual(crosshairEvents.at(-1), { time: 1200, price: 410 });

    harness.setRect({ left: 140, top: 75, width: 400, height: 300 });
    harness.resetRectCalls();
    harness.emit("pointermove", { clientX: 260, clientY: 165 });
    assert.equal(harness.getRectCalls(), 1, "shifted hover picks up new container rect in one call");
    assert.equal(crosshair.x, 120);
    assert.equal(crosshair.y, 90);

    // 2. Replay selection preview on plot
    setReplaySelecting(true);
    harness.resetRectCalls();
    harness.emit("pointermove", { clientX: 290, clientY: 155 });
    assert.equal(harness.getRectCalls(), 1, "replay selection pointermove measures rect once");
    assert.equal(replayPreviews.at(-1), 1500);
    setReplaySelecting(false);

    // 3. Price-axis drag (local x in [350..400], y in [0..250])
    harness.emit("pointerdown", { clientX: 140 + 375, clientY: 75 + 100 });
    harness.resetRectCalls();
    harness.emit("pointermove", { clientX: 140 + 375, clientY: 75 + 145 });
    assert.equal(harness.getRectCalls(), 1, "price-axis drag pointermove measures rect once");
    assert.equal(priceScales.at(-1), 145);
    harness.emit("pointerup", { clientX: 140 + 375, clientY: 75 + 145 });

    // 4. Time-axis drag (local x in [0..350], y in [250..300])
    harness.emit("pointerdown", { clientX: 140 + 180, clientY: 75 + 275 });
    harness.resetRectCalls();
    harness.emit("pointermove", { clientX: 140 + 230, clientY: 75 + 275 });
    assert.equal(harness.getRectCalls(), 1, "time-axis drag pointermove measures rect once");
    assert.equal(timeScales.at(-1), 230);
    harness.emit("pointerup", { clientX: 140 + 230, clientY: 75 + 275 });

    // 5. Draft drawing move
    drawings.activeTool = "trend";
    setDrawingState({ hasDraft: true });
    harness.resetRectCalls();
    harness.emit("pointermove", { clientX: 140 + 110, clientY: 75 + 85 });
    assert.equal(harness.getRectCalls(), 1, "drawing draft pointermove measures rect once");
    assert.deepEqual(drawingPointCalls.at(-1), [110, 85]);
    drawings.activeTool = null;
    setDrawingState({ hasDraft: false });

    // 6. Touch pan move
    harness.emit("pointerdown", { pointerId: 9, pointerType: "touch", clientX: 140 + 120, clientY: 75 + 120 });
    harness.resetRectCalls();
    harness.emit("pointermove", { pointerId: 9, pointerType: "touch", clientX: 140 + 150, clientY: 75 + 135 });
    assert.equal(harness.getRectCalls(), 1, "touch pointermove measures rect once");
    harness.emit("pointerup", { pointerId: 9, pointerType: "touch", clientX: 140 + 150, clientY: 75 + 135 });
    void ChartChange;
  } finally {
    controller.dispose();
  }
});

test("DrawingManager hitTestAt and peekAt select topmost visible market drawing without reversing arrays", () => {
  const view = {
    area: { left: 0, top: 0, width: 800, height: 600 },
    colWidth: 8,
    offsetX: 0,
    priceTop: 600,
    pricePerPx: 1,
    xOfIndex(index) { return this.area.left + this.offsetX + index * this.colWidth; },
    yOfPrice(price) { return this.area.top + (this.priceTop - price) / this.pricePerPx; },
  };
  const timeCtx = { indexForTime: (t) => t, timeForIndex: (i) => i };
  const FAR = { time: 5_000, price: 5_000 };
  const HIT_SCREEN = { x: 284, y: 452 };
  const makeTrend = (id, extra = {}) => ({
    schemaVersion: 2,
    id,
    type: "trend",
    points: [{ time: 10, price: 100 }, { time: 60, price: 200 }],
    color: "#ffffff",
    lineWidth: 1.5,
    locked: false,
    visible: true,
    market: MARKET,
    ...extra,
  });

  const manager = new DrawingManager(() => {});
  manager.setMarket(MARKET);
  manager.setHitTestContext(view, timeCtx);
  manager.replace([
    makeTrend("bottom"),
    makeTrend("top"),
    makeTrend("hidden-on-top", { visible: false }),
    makeTrend("other-market-on-top", { market: "BINANCE_FUTURES:ethusdt" }),
  ]);

  const originalReverse = Array.prototype.reverse;
  const originalClone = globalThis.structuredClone;
  let reverseCalls = 0;
  let cloneCalls = 0;
  Array.prototype.reverse = function () {
    reverseCalls += 1;
    return originalReverse.apply(this, arguments);
  };
  globalThis.structuredClone = function (value) {
    cloneCalls += 1;
    return originalClone(value);
  };

  try {
    assert.deepEqual(manager.peekAt(FAR, HIT_SCREEN), { id: "top", selected: false });
    assert.equal(reverseCalls, 0, "peekAt avoids copying and reversing the drawing list");
    assert.equal(cloneCalls, 0, "peekAt avoids cloning");

    const hit = manager.hitTestAt(FAR, HIT_SCREEN);
    assert.equal(hit?.id, "top", "hitTestAt picks the topmost visible drawing for current market");
    assert.equal(reverseCalls, 0, "hitTestAt avoids copying and reversing the drawing list");
    assert.equal(cloneCalls, 1, "hitTestAt only clones the single matched drawing on return");

    // Once "top" is hidden, fallback selects "bottom" while preserving list order
    manager.replace([
      makeTrend("bottom"),
      makeTrend("top", { visible: false }),
      makeTrend("hidden-on-top", { visible: false }),
      makeTrend("other-market-on-top", { market: "BINANCE_FUTURES:ethusdt" }),
    ]);
    assert.deepEqual(manager.peekAt(FAR, HIT_SCREEN), { id: "bottom", selected: false });
    assert.equal(manager.hitTestAt(FAR, HIT_SCREEN)?.id, "bottom");
    assert.deepEqual(
      manager.list().map((d) => d.id),
      ["bottom", "top", "hidden-on-top", "other-market-on-top"],
    );
  } finally {
    Array.prototype.reverse = originalReverse;
    globalThis.structuredClone = originalClone;
  }
});
