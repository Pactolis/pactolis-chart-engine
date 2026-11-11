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

const sampleCount = (metric) => snapshotPerformanceTelemetry().metrics[metric]?.count ?? 0;

test("footprintRenderer records telemetry metrics only when enabled", () => {
  const renderer = makeFootprintRenderer();
  const view = makeView();
  const series = makeSeries();
  const layers = new Set(["grid", "candles", "footprint"]);
  const prevGrid = settings.grid;
  settings.grid = true;

  try {
    renderer.setChartConfig({ chartType: "footprint", candles: true });

    const beforeOff = {
      candles: sampleCount("chart.gpu.candles.ms"),
      clear: sampleCount("chart.gpu.clear.ms"),
      grid: sampleCount("chart.gpu.grid.ms"),
      flush: sampleCount("chart.gpu.flush.ms"),
      footprint: sampleCount("chart.gpu.footprint.ms"),
    };

    withTelemetry(false, () => {
      renderer.renderLayers(view, series, layers);
    });

    assert.equal(sampleCount("chart.gpu.candles.ms") - beforeOff.candles, 0);
    assert.equal(sampleCount("chart.gpu.clear.ms") - beforeOff.clear, 0);
    assert.equal(sampleCount("chart.gpu.grid.ms") - beforeOff.grid, 0);
    assert.equal(sampleCount("chart.gpu.flush.ms") - beforeOff.flush, 0);
    assert.equal(sampleCount("chart.gpu.footprint.ms") - beforeOff.footprint, 0);

    const beforeOn = {
      candles: sampleCount("chart.gpu.candles.ms"),
      clear: sampleCount("chart.gpu.clear.ms"),
      grid: sampleCount("chart.gpu.grid.ms"),
      flush: sampleCount("chart.gpu.flush.ms"),
      footprint: sampleCount("chart.gpu.footprint.ms"),
    };

    withTelemetry(true, () => {
      renderer.renderLayers(view, series, layers);
    });

    assert.ok(sampleCount("chart.gpu.candles.ms") - beforeOn.candles >= 1, "chart.gpu.candles.ms recorded");
    assert.ok(sampleCount("chart.gpu.clear.ms") - beforeOn.clear >= 1, "chart.gpu.clear.ms recorded");
    assert.ok(sampleCount("chart.gpu.grid.ms") - beforeOn.grid >= 1, "chart.gpu.grid.ms recorded");
    assert.ok(sampleCount("chart.gpu.flush.ms") - beforeOn.flush >= 1, "chart.gpu.flush.ms recorded");
    assert.ok(sampleCount("chart.gpu.footprint.ms") - beforeOn.footprint >= 1, "chart.gpu.footprint.ms recorded");
  } finally {
    settings.grid = prevGrid;
  }
});

test("ChartSession renderDirtySurfaces records surface metrics only when telemetry enabled", () => {
  const { session, win, counts } = makeFakeSession();

  try {
    const beforeOff = {
      gpu: sampleCount("chart.surface.gpu.draw.ms"),
      annotation: sampleCount("chart.surface.annotation.draw.ms"),
      interaction: sampleCount("chart.surface.interaction.draw.ms"),
    };

    withTelemetry(false, () => {
      session.activate();
      win.runNextFrame();
    });

    assert.equal(sampleCount("chart.surface.gpu.draw.ms") - beforeOff.gpu, 0);
    assert.equal(sampleCount("chart.surface.annotation.draw.ms") - beforeOff.annotation, 0);
    assert.equal(sampleCount("chart.surface.interaction.draw.ms") - beforeOff.interaction, 0);
    assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });

    const beforeOn = {
      gpu: sampleCount("chart.surface.gpu.draw.ms"),
      annotation: sampleCount("chart.surface.annotation.draw.ms"),
      interaction: sampleCount("chart.surface.interaction.draw.ms"),
    };

    withTelemetry(true, () => {
      session.invalidateSurface(ChartSurfaceDirty.All);
      win.runNextFrame();
    });

    assert.ok(sampleCount("chart.surface.gpu.draw.ms") - beforeOn.gpu >= 1, "chart.surface.gpu.draw.ms recorded");
    assert.ok(sampleCount("chart.surface.annotation.draw.ms") - beforeOn.annotation >= 1, "chart.surface.annotation.draw.ms recorded");
    assert.ok(sampleCount("chart.surface.interaction.draw.ms") - beforeOn.interaction >= 1, "chart.surface.interaction.draw.ms recorded");
    assert.deepEqual(counts, { gpu: 2, annotation: 2, interaction: 2 });
  } finally {
    session.destroy();
  }
});
