import test from "node:test";
import assert from "node:assert/strict";
import { resetGpuDiagnosticsForTest } from "../dist/core/gpu/gpuDiagnostics.js";
import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import { ChartWorkerPanelRuntime } from "../dist/features/chart/worker/chartWorkerRuntime.js";
import { WorkerChartHostBridge } from "../dist/features/chart/worker/workerRuntimeAdapter.js";

function makePortPair() {
  const listenersA = new Set();
  const listenersB = new Set();
  const portA = {
    postMessage(data) {
      for (const fn of [...listenersB]) fn({ data });
    },
    addEventListener(_type, fn) {
      listenersA.add(fn);
    },
    removeEventListener(_type, fn) {
      listenersA.delete(fn);
    },
    start() {},
    close() {},
  };
  const portB = {
    postMessage(data) {
      for (const fn of [...listenersA]) fn({ data });
    },
    addEventListener(_type, fn) {
      listenersB.add(fn);
    },
    removeEventListener(_type, fn) {
      listenersB.delete(fn);
    },
    start() {},
    close() {},
  };
  return { portA, portB };
}

function makeMock2dContext(canvas) {
  return {
    canvas,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    strokeText() {},
    measureText(text) {
      return { width: String(text ?? "").length * 6 };
    },
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    closePath() {},
    setLineDash() {},
    drawImage() {},
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    getImageData(_x, _y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData() {},
  };
}

function makeMockWebGl2Context() {
  return {
    drawingBufferWidth: 640,
    drawingBufferHeight: 360,
    COLOR_BUFFER_BIT: 0x4000,
    viewport() {},
    clearColor() {},
    clear() {},
    readPixels(_x, _y, w, h, _format, _type, buffer) {
      buffer.fill(42);
    },
    getExtension(name) {
      if (name === "WEBGL_debug_renderer_info") {
        return { UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      return null;
    },
    getParameter(pname) {
      if (pname === 0x9246) return "Mock WebGL2 GPU";
      return null;
    },
    deleteVertexArray() {},
    deleteBuffer() {},
    deleteProgram() {},
  };
}

function makeMockCanvas(width = 640, height = 360, withWebGl2 = false) {
  const gl = withWebGl2 ? makeMockWebGl2Context() : null;
  const canvas = {
    width,
    height,
    getContext(kind) {
      if (kind === "2d") return makeMock2dContext(canvas);
      if (kind === "webgl2") return gl;
      return null;
    },
  };
  return canvas;
}

function withRestoredSettingsSource(work) {
  let prevSource = null;
  try {
    prevSource = orderbookHeatmapSettingsSource();
  } catch {
    // No previous settings source configured.
  }
  return Promise.resolve(work()).finally(() => {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  });
}

test("ChartWorkerPanelRuntime passes GL via WebGl2Surface.getGlContext() when custom getWebGl2Context is omitted", async () => {
  resetGpuDiagnosticsForTest();
  const mainPorts = makePortPair();
  const runtime = new ChartWorkerPanelRuntime({
    panelId: "worker-gl-1",
    marketId: "BINANCE_FUTURES:btcusdt",
    backendPreference: "webgl2",
    createScratchCanvas: () => makeMockCanvas(640, 360, true),
  });
  runtime.attachPorts({ mainPort: mainPorts.portB });

  const bridge = new WorkerChartHostBridge({
    panelId: "worker-gl-1",
    marketId: "BINANCE_FUTURES:btcusdt",
  });
  bridge.attachPorts({ mainPort: mainPorts.portA });

  bridge.sendInit(
    [
      { role: "gpu-scene", zIndex: 0, width: 640, height: 360, dpr: 1 },
      { role: "annotation", zIndex: 1, width: 640, height: 360, dpr: 1 },
      { role: "interaction", zIndex: 2, width: 640, height: 360, dpr: 1 },
    ],
    { width: 640, height: 360, dpr: 1 },
    { backendPreference: "webgl2" },
  );
  await runtime.waitUntilReady();

  const diag = runtime.getDiagnostics();
  assert.equal(diag.activeBackend, "webgl2");
  assert.ok(diag.heatmap !== null);
  assert.equal(diag.heatmap.backend, "webgl2");
  assert.equal(diag.heatmap.renderer, "Mock WebGL2 GPU");

  runtime.dispose();
  bridge.dispose();
});

test("ChartWorkerPanelRuntime wires custom fetchOrderbookHeatmap and orderbookHeatmapSettings patch", async () => {
  await withRestoredSettingsSource(async () => {
    const mainPorts = makePortPair();
    const historyPorts = makePortPair();
    const fetchCalls = [];

    const runtime = new ChartWorkerPanelRuntime({
      panelId: "worker-hm-1",
      marketId: "BINANCE_FUTURES:btcusdt",
      timeframe: "5m",
      backendPreference: "canvas2d",
      createScratchCanvas: () => makeMockCanvas(640, 360, false),
      fetchOrderbookHeatmap: async (req) => {
        fetchCalls.push(req);
        return {
          schemaVersion: 1,
          generatedAt: Date.now(),
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: [
            { t: 1_700_000_000_000, cells: [[100, 1200, 800]] },
          ],
        };
      },
    });
    runtime.attachPorts({
      mainPort: mainPorts.portB,
      historyPort: historyPorts.portB,
    });

    const bridge = new WorkerChartHostBridge({
      panelId: "worker-hm-1",
      marketId: "BINANCE_FUTURES:btcusdt",
    });
    bridge.attachPorts({ mainPort: mainPorts.portA });

    bridge.sendInit(
      [
        { role: "gpu-scene", zIndex: 0, width: 640, height: 360, dpr: 1 },
        { role: "annotation", zIndex: 1, width: 640, height: 360, dpr: 1 },
        { role: "interaction", zIndex: 2, width: 640, height: 360, dpr: 1 },
      ],
      { width: 640, height: 360, dpr: 1 },
      { backendPreference: "canvas2d" },
    );
    await runtime.waitUntilReady();

    historyPorts.portA.postMessage({
      channel: "history",
      kind: "history:chunk",
      panelId: "worker-hm-1",
      marketId: "BINANCE_FUTURES:btcusdt",
      generation: 0,
      seq: 1,
      revision: 1,
      payload: {
        timeframe: "5m",
        hasMore: false,
        chunkIndex: 0,
        bars: [
          { time: 1_700_000_000_000, open: 100, high: 105, low: 98, close: 103, volume: 50 },
        ],
      },
    });

    bridge.sendStateUpdate({
      orderbookHeatmapMode: "custom",
      orderbookHeatmapSettings: {
        bucketStep: 50,
        unit: "btc",
        opacity: 0.7,
        palette: "viridis",
        customSources: ["binance", "bybit"],
      },
      residentHeatmap: true,
      residentHeatmapExplicit: true,
    });
    await new Promise((r) => setTimeout(r, 0));

    const resolved = orderbookHeatmapSettingsSource().settingsFor("BINANCE_FUTURES:btcusdt", "worker-hm-1");
    assert.equal(resolved.mode, "custom");
    assert.equal(resolved.bucketStep, 50);
    assert.equal(resolved.unit, "btc");
    assert.equal(resolved.opacity, 0.7);
    assert.equal(resolved.palette, "viridis");
    assert.deepEqual(resolved.customSources, ["binance", "bybit"]);

    assert.equal(runtime.renderNow(), true);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(fetchCalls.length >= 1, "custom fetchOrderbookHeatmap must be invoked when heatmap is active");
    assert.equal(fetchCalls[0].source, "custom");
    assert.equal(fetchCalls[0].bucketStep, 50);

    runtime.dispose();
    bridge.dispose();
  });
});

test("ChartWorkerPanelRuntime runs real IndicatorManager, priceStep/precision, diagnostics, and telemetry", async () => {
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: false });

  const mainPorts = makePortPair();
  const historyPorts = makePortPair();
  const runtime = new ChartWorkerPanelRuntime({
    panelId: "worker-ind-1",
    marketId: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    intervalMs: 60_000,
    priceStep: 1,
    pricePrecision: 2,
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvas(640, 360, false),
  });
  runtime.attachPorts({
    mainPort: mainPorts.portB,
    historyPort: historyPorts.portB,
  });

  const bridge = new WorkerChartHostBridge({
    panelId: "worker-ind-1",
    marketId: "BINANCE_FUTURES:btcusdt",
  });
  bridge.attachPorts({ mainPort: mainPorts.portA });

  bridge.sendInit(
    [
      { role: "gpu-scene", zIndex: 0, width: 640, height: 360, dpr: 1 },
      { role: "annotation", zIndex: 1, width: 640, height: 360, dpr: 1 },
      { role: "interaction", zIndex: 2, width: 640, height: 360, dpr: 1 },
    ],
    { width: 640, height: 360, dpr: 1 },
    { backendPreference: "canvas2d" },
  );
  await runtime.waitUntilReady();

  bridge.sendStateUpdate({
    priceStep: 2.5,
    pricePrecision: 1,
    telemetryEnabled: true,
    indicators: [
      {
        id: "ma-1",
        type: "moving-average",
        title: "MA",
        visible: true,
        paneId: "main",
        order: 0,
        settings: { period: 2, source: "close", kind: "sma", color: "#ffaa00" },
        placement: "price-overlay",
      },
      {
        id: "vwap-1",
        type: "vwap",
        title: "VWAP",
        visible: true,
        paneId: "main",
        order: 1,
        settings: {},
        placement: "price-overlay",
      },
      {
        id: "vp-1",
        type: "volume-profile",
        title: "VP",
        visible: true,
        paneId: "main",
        order: 2,
        settings: {},
        placement: "price-overlay",
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 0));

  historyPorts.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "worker-ind-1",
    marketId: "BINANCE_FUTURES:btcusdt",
    generation: 0,
    seq: 1,
    revision: 1,
    payload: {
      timeframe: "1m",
      hasMore: false,
      chunkIndex: 0,
      bars: [
        { time: 1_700_000_000_000, open: 100, high: 105, low: 98, close: 103, volume: 40 },
        { time: 1_700_000_060_000, open: 103, high: 108, low: 101, close: 106, volume: 60 },
      ],
    },
  });

  assert.equal(runtime.renderNow(), true);

  const diag = runtime.getDiagnostics();
  assert.equal(diag.intervalMs, 60_000);
  assert.equal(diag.priceStep, 2.5);
  assert.equal(diag.pricePrecision, 1);
  assert.equal(diag.oldestBarTime, 1_700_000_000_000);
  assert.equal(diag.indicatorCount, 3);
  assert.ok(Array.isArray(diag.visibleRange) && diag.visibleRange.length === 2);
  assert.ok(diag.telemetry !== undefined, "diagnostics.telemetry must be populated when telemetryEnabled is true");
  assert.equal(diag.telemetry.enabled, true);
  assert.ok(diag.telemetry.metrics["chart.frame.render.ms"]?.count >= 1);
  assert.ok(diag.telemetry.metrics["chart.surface.gpu.draw.ms"]?.count >= 1);
  assert.ok(diag.telemetry.metrics["chart.surface.annotation.draw.ms"]?.count >= 1);
  assert.ok(diag.telemetry.metrics["chart.surface.interaction.draw.ms"]?.count >= 1);
  assert.ok((diag.telemetry.counters["chart.raf.frames"] ?? 0) >= 1);

  configurePerformanceTelemetry({ enabled: false });
  resetPerformanceTelemetry();
  runtime.dispose();
  bridge.dispose();
});
