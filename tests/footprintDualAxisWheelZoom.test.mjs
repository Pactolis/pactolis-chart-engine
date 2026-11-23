import test from "node:test";
import assert from "node:assert/strict";

import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { cellTextModeFor } from "../dist/core/render/chartLod.js";
import { resolveFootprintWheelZoomMode, settings } from "../dist/core/settings.js";
import { ChartInputController } from "../dist/features/chart/ChartInputController.js";
import { TimeScaleViewportController } from "../dist/features/controllers/timeScaleViewportController.js";

const WEEK_MS = 7 * 24 * 60 * 60_000;
const JAN_12_2026_UTC = Date.UTC(2026, 0, 12, 0, 0, 0);

function makeCanvasHarness(width = 1200, height = 700) {
  const listeners = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const ownerWindow = {
    devicePixelRatio: 1,
    performance: { now: () => 0 },
    addEventListener: (t, fn) => {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t).add(fn);
    },
    removeEventListener: (t, fn) => winListeners.get(t)?.delete(fn),
    matchMedia: () => ({ matches: false }),
  };
  const ownerDocument = {
    defaultView: ownerWindow,
    addEventListener: (t, fn) => {
      if (!docListeners.has(t)) docListeners.set(t, new Set());
      docListeners.get(t).add(fn);
    },
    removeEventListener: (t, fn) => docListeners.get(t)?.delete(fn),
  };
  const canvas = {
    style: { cursor: "default" },
    width,
    height,
    ownerDocument,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: (t, fn) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t).add(fn);
    },
    removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  };
  return {
    canvas,
    dispatchWheel(opts) {
      const event = {
        deltaX: 0,
        deltaY: -120,
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        deltaMode: 0,
        clientX: 600,
        clientY: 320,
        preventDefault() {},
        ...opts,
      };
      for (const fn of listeners.get("wheel") ?? []) fn(event);
    },
  };
}

function setupController(panelOverrides = {}) {
  const view = new View();
  view.setLayout(1200, 700);
  view.priceAxisW = 72;
  view.area = { left: 0, top: 0, width: 1128, height: 670 };
  view.subPanesH = 0;

  // 100 weekly bars ending around Jan 12, 2026 (90,066 - 97,932 USD, $50 step)
  const series = new FootprintSeries({ intervalMs: WEEK_MS, priceStep: 50 });
  const bars = Array.from({ length: 100 }, (_, i) => {
    const startTime = JAN_12_2026_UTC - (90 - i) * WEEK_MS;
    const isTarget = startTime === JAN_12_2026_UTC;
    return {
      startTime,
      open: isTarget ? 91_200 : 88_000,
      high: isTarget ? 97_932 : 98_500,
      low: isTarget ? 90_066 : 86_000,
      close: isTarget ? 95_400 : 92_000,
      volume: 1000,
      delta: 50,
      count: 100,
      cells: new Map(),
      hasRef: true,
    };
  });
  series.loadBars(bars);
  view.resetTimeScale(bars.length);
  view.fitPriceRange(86_000, 98_500, 0.1);

  const timeViewport = new TimeScaleViewportController(view);
  const { canvas, dispatchWheel } = makeCanvasHarness(1200, 700);
  const state = {
    type: "chart",
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1w",
    scaleMode: "linear",
    chartType: "footprint",
    footprintWheelZoomMode: "dual",
    ...panelOverrides,
  };

  let autoFitCalls = 0;
  let invalidations = 0;
  const host = {
    svc: { getAnalysisContext: () => ({ drawings: { activeTool: null, hasDraft: () => false } }) },
    view,
    session: { invalidate: () => { invalidations++; }, invalidateSurface: () => {} },
    pipeline: { series },
    overlay: { getIndicatorAxisPaneAt: () => null },
    timeViewport,
    state,
    panelId: "test-1w",
    applyingExternal: false,
    getReplaySnapshot: () => null,
    screenToDrawingPoint: () => ({ time: 0, price: 0 }),
    indexToTime: (idx) => series.timeOfIndex(idx),
    resolveScreenCrosshair: () => ({ time: null, price: null }),
    setPriceAutoScaleFromControl: (v) => view.setPriceAutoScale(v),
    togglePriceScaleModeFromControl: () => "linear",
    scaleIndicatorPane: () => false,
    autoFit: () => { autoFitCalls++; },
    emitVisibleRange: () => {},
    notifyCrosshair: () => {},
    isReplaySelecting: () => false,
    previewReplayStart: () => {},
    selectReplayStart: () => {},
    togglePaneMaximizeAt: () => false,
    isChartPaneMaximized: () => false,
    hasIndicatorPanes: () => false,
    applyChartAction: () => {},
    getChartCommandState: () => ({}),
  };

  const crosshair = { x: 0, y: 0, visible: false };
  const controller = new ChartInputController(canvas, crosshair, host);
  return {
    view,
    series,
    state,
    dispatchWheel,
    getAutoFitCalls: () => autoFitCalls,
    getInvalidations: () => invalidations,
    dispose: () => controller.dispose(),
  };
}

test("#283 Footprint dual-axis wheel zooms X+Y anchored at pointer without autoFit override and reaches legible Bid/Ask text", () => {
  const prevMode = settings.footprintWheelZoomMode;
  try {
    assert.equal(resolveFootprintWheelZoomMode(undefined), "dual");
    assert.equal(resolveFootprintWheelZoomMode("horizontal"), "horizontal");
    assert.equal(settings.footprintWheelZoomMode, "dual");

    const h = setupController({ footprintWheelZoomMode: "dual" });
    const targetBarIdx = 90; // Jan 12, 2026 bar
    const anchorX = h.view.xOfIndex(targetBarIdx) + h.view.colWidth * 0.5;
    const anchorY = h.view.yOfPrice(94_000);
    const initialColWidth = h.view.colWidth;
    const initialPricePerPx = h.view.pricePerPx;
    const initialIndex = h.view.indexOfX(anchorX);
    const initialPrice = h.view.priceOfY(anchorY);

    // 18 wheel-up notches over the candle
    for (let i = 0; i < 18; i++) {
      h.dispatchWheel({ clientX: anchorX, clientY: anchorY, deltaY: -120 });
    }

    assert.equal(h.getAutoFitCalls(), 0, "dual-axis wheel must not call autoFit on the same frame");
    assert.equal(h.view.isPriceAutoScale(), false, "dual-axis wheel disables price auto-scale");
    assert.ok(h.view.colWidth > initialColWidth * 3, "columns widen horizontally");
    assert.ok(h.view.pricePerPx < initialPricePerPx * 0.15, "price range narrows vertically");
    assert.ok(Math.abs(h.view.indexOfX(anchorX) - initialIndex) < 1e-6, "bar index under cursor stays anchored");
    assert.ok(Math.abs(h.view.priceOfY(anchorY) - initialPrice) < 1e-3, "price under cursor stays anchored");

    const cellHeightPx = 50 / h.view.pricePerPx;
    assert.ok(cellHeightPx >= 9, `expected $50 cell height >= 9px, got ${cellHeightPx}`);
    assert.ok(h.view.colWidth >= 72, `expected colWidth >= 72px, got ${h.view.colWidth}`);
    assert.equal(cellTextModeFor(cellHeightPx, h.view.colWidth), "full");

    // Equal number of wheel-down notches restores original X & Y scales symmetrically
    for (let i = 0; i < 18; i++) {
      h.dispatchWheel({ clientX: anchorX, clientY: anchorY, deltaY: 120 });
    }
    assert.ok(Math.abs(h.view.colWidth - initialColWidth) < 1e-6);
    assert.ok(Math.abs(h.view.pricePerPx - initialPricePerPx) < 1e-6);
    h.dispose();
  } finally {
    settings.footprintWheelZoomMode = prevMode;
  }
});

test("#283 horizontal preference, non-footprint chart types, axis targets, sub-panes, and clamp bounds behave cleanly", () => {
  // 1. Horizontal mode keeps Y scale untouched
  const horiz = setupController({ footprintWheelZoomMode: "horizontal" });
  const p0 = horiz.view.pricePerPx;
  const c0 = horiz.view.colWidth;
  horiz.dispatchWheel({ clientX: 500, clientY: 300, deltaY: -120 });
  assert.ok(horiz.view.colWidth > c0);
  assert.equal(horiz.view.pricePerPx, p0);
  horiz.dispose();

  // 2. Candlestick / footprintProfile / tpo keep X-only wheel even when dual is set
  for (const chartType of ["candlestick", "footprintProfile", "tpo"]) {
    const other = setupController({ chartType, footprintWheelZoomMode: "dual" });
    const baseP = other.view.pricePerPx;
    other.dispatchWheel({ clientX: 500, clientY: 300, deltaY: -120 });
    assert.equal(other.view.pricePerPx, baseP, `${chartType} must not dual-zoom Y`);
    other.dispose();
  }

  // 3. Price axis wheel zooms Y only; sub-pane Y (> area.top + area.height) zooms X only
  const axes = setupController({ footprintWheelZoomMode: "dual" });
  const colBeforeAxis = axes.view.colWidth;
  const pxBeforeAxis = axes.view.pricePerPx;
  axes.dispatchWheel({ clientX: 1160, clientY: 300, deltaY: -120 }); // over right price axis
  assert.equal(axes.view.colWidth, colBeforeAxis);
  assert.ok(axes.view.pricePerPx > pxBeforeAxis);
  axes.dispose();

  const subpane = setupController({ footprintWheelZoomMode: "dual" });
  subpane.view.area = { left: 0, top: 0, width: 1128, height: 500 };
  subpane.view.subPanesH = 170;
  const colBeforeSub = subpane.view.colWidth;
  const pxBeforeSub = subpane.view.pricePerPx;
  subpane.dispatchWheel({ clientX: 500, clientY: 580, deltaY: -120 });
  assert.ok(subpane.view.colWidth > colBeforeSub);
  assert.equal(subpane.view.pricePerPx, pxBeforeSub);
  subpane.dispose();

  // 4. Extreme zoom-in hits clamp cleanly and immediately reverses on wheel-out without jumping
  const bounds = setupController({ footprintWheelZoomMode: "dual" });
  for (let i = 0; i < 200; i++) bounds.dispatchWheel({ clientX: 500, clientY: 300, deltaY: -120 });
  const clampedPricePerPx = bounds.view.pricePerPx;
  const clampedColWidth = bounds.view.colWidth;
  bounds.dispatchWheel({ clientX: 500, clientY: 300, deltaY: 120 });
  assert.ok(bounds.view.colWidth < clampedColWidth);
  assert.ok(bounds.view.pricePerPx > clampedPricePerPx);
  bounds.dispose();
});
