import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.$state ??= (value) => value;

const {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} = await import("../dist/core/performanceTelemetry.js");
const { FootprintRenderer } = await import("../dist/core/render/footprintRenderer.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { View } = await import("../dist/core/engine/view.js");
const { ChartSurfaceDirty } = await import("../dist/core/render/scene/chartScene.js");
const { ChartSession } = await import("../dist/features/chart/ChartSession.js");
const { settings } = await import("../dist/core/settings.js");

function fakeGl(dpr = 1) {
  const canvas = { ownerDocument: { defaultView: { devicePixelRatio: dpr } } };
  return new Proxy({ canvas, drawingBufferWidth: 800 * dpr, drawingBufferHeight: 600 * dpr }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && /^[A-Z_0-9]+$/.test(prop)) return 1;
      return () => ({});
    },
  });
}

function makeFootprintRenderer(dpr = 1) {
  const renderer = new FootprintRenderer(fakeGl(dpr));
  renderer.batch = {
    begin() {},
    rect() {},
    flush() {},
    dispose() {},
  };
  return renderer;
}

function makeSeries() {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  const BASE_TIME = 1_699_999_980_000; // 1699999980000 % 60000 === 0
  series.loadBars(Array.from({ length: 10 }, (_, index) => {
    const startTime = BASE_TIME + index * 60_000;
    const open = 100 + index;
    return {
      startTime,
      open,
      high: open + 5,
      low: open - 2,
      close: open + 3,
      volume: 50,
      delta: 10,
      count: 20,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
      cells: new Map([
        [open, { priceBin: open, buyVol: 30, sellVol: 20, count: 20, buyCount: 12, sellCount: 8, liquidationBuyVol: 0, liquidationSellVol: 0 }],
      ]),
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
      updatedAt: startTime,
    };
  }));
  return series;
}

function makeView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 120;
  view.pricePerPx = 0.1;
  return view;
}

function withTelemetry(enabled, work) {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled });
  try {
    return work();
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
}

function makeFakeSession() {
  let rafCallback = null;
  const win = {
    devicePixelRatio: 1,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(cb) {
      rafCallback = cb;
      return 1;
    },
    cancelAnimationFrame() {
      rafCallback = null;
    },
    runNextFrame() {
      const cb = rafCallback;
      rafCallback = null;
      cb?.(0);
    },
    matchMedia() {
      return { addEventListener() {}, removeEventListener() {} };
    },
  };
  const ownerDocument = { defaultView: win };
  const makeCanvas = () => ({
    ownerDocument,
    style: {},
    width: 800,
    height: 600,
    getContext() { return null; },
    addEventListener() {},
    removeEventListener() {},
  });
  const gpuCanvas = makeCanvas();
  const annotationCanvas = makeCanvas();
  const interactionCanvas = makeCanvas();
  const ctx2d = { setTransform() {} };
  const container = {
    ownerDocument,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  };
  const counts = { gpu: 0, annotation: 0, interaction: 0 };
  const renderer = {
    render() { counts.gpu++; },
    visibleRange() { return [0, 10]; },
  };
  const annotation = {
    render() { counts.annotation++; },
    requiresInteractionRedraw() { return false; },
  };
  const interaction = {
    render() { counts.interaction++; },
  };
  const view = makeView();
  const series = makeSeries();
  const crosshair = { visible: false, x: 0, y: 0 };

  const session = new ChartSession({
    container,
    gpuCanvas,
    annotationCanvas,
    interactionCanvas,
    ownerDocument,
    gl: {},
    annotationCtx2d: ctx2d,
    interactionCtx2d: ctx2d,
    renderer,
    annotation,
    interaction,
    view,
    series,
    crosshair,
    onRestoreContext() {},
  });

  return { session, win, counts };
}

test("verify render paths avoid measurePerformance closures in footprintRenderer and ChartSession", () => {
  const footprintSrc = readFileSync(new URL("../src/core/render/footprintRenderer.ts", import.meta.url), "utf8");
  const chartSessionSrc = readFileSync(new URL("../src/features/chart/ChartSession.ts", import.meta.url), "utf8");

  assert.doesNotMatch(
    footprintSrc,
    /\bmeasurePerformance\s*\(/,
    "footprintRenderer must avoid measurePerformance closures on hot render paths (#78)",
  );
  assert.doesNotMatch(
    chartSessionSrc,
    /\bmeasurePerformance\s*\(/,
    "ChartSession must avoid measurePerformance closures on hot render paths (#78)",
  );
});

test("footprintRenderer records telemetry metrics only when enabled", () => {
  const renderer = makeFootprintRenderer();
  const view = makeView();
  const series = makeSeries();
  const layers = new Set(["grid", "candles", "footprint"]);
  const prevGrid = settings.grid;
  settings.grid = true;

  try {
    renderer.setChartConfig({ chartType: "footprint", candles: true });

    withTelemetry(false, () => {
      renderer.renderLayers(view, series, layers);
    });

    const offSnapshot = snapshotPerformanceTelemetry().metrics;
    assert.equal(offSnapshot["chart.gpu.candles.ms"], undefined);
    assert.equal(offSnapshot["chart.gpu.clear.ms"], undefined);
    assert.equal(offSnapshot["chart.gpu.grid.ms"], undefined);
    assert.equal(offSnapshot["chart.gpu.flush.ms"], undefined);
    assert.equal(offSnapshot["chart.gpu.footprint.ms"], undefined);

    withTelemetry(true, () => {
      renderer.renderLayers(view, series, layers);
    });

    const onSnapshot = snapshotPerformanceTelemetry().metrics;
    assert.ok(onSnapshot["chart.gpu.candles.ms"]?.count >= 1, "chart.gpu.candles.ms recorded");
    assert.ok(onSnapshot["chart.gpu.clear.ms"]?.count >= 1, "chart.gpu.clear.ms recorded");
    assert.ok(onSnapshot["chart.gpu.grid.ms"]?.count >= 1, "chart.gpu.grid.ms recorded");
    assert.ok(onSnapshot["chart.gpu.flush.ms"]?.count >= 1, "chart.gpu.flush.ms recorded");
    assert.ok(onSnapshot["chart.gpu.footprint.ms"]?.count >= 1, "chart.gpu.footprint.ms recorded");
  } finally {
    settings.grid = prevGrid;
  }
});

test("ChartSession renderDirtySurfaces records surface metrics only when telemetry enabled", () => {
  const { session, win, counts } = makeFakeSession();

  try {
    withTelemetry(false, () => {
      session.activate();
      win.runNextFrame();
    });

    const offSnapshot = snapshotPerformanceTelemetry().metrics;
    assert.equal(offSnapshot["chart.surface.gpu.draw.ms"], undefined);
    assert.equal(offSnapshot["chart.surface.annotation.draw.ms"], undefined);
    assert.equal(offSnapshot["chart.surface.interaction.draw.ms"], undefined);
    assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });

    withTelemetry(true, () => {
      session.invalidateSurface(ChartSurfaceDirty.All);
      win.runNextFrame();
    });

    const onSnapshot = snapshotPerformanceTelemetry().metrics;
    assert.ok(onSnapshot["chart.surface.gpu.draw.ms"]?.count >= 1, "chart.surface.gpu.draw.ms recorded");
    assert.ok(onSnapshot["chart.surface.annotation.draw.ms"]?.count >= 1, "chart.surface.annotation.draw.ms recorded");
    assert.ok(onSnapshot["chart.surface.interaction.draw.ms"]?.count >= 1, "chart.surface.interaction.draw.ms recorded");
    assert.deepEqual(counts, { gpu: 2, annotation: 2, interaction: 2 });
  } finally {
    session.destroy();
  }
});
