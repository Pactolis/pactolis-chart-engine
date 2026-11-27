import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { DEFAULT_ORDERBOOK_HEATMAP_SETTINGS } from "../dist/core/orderbookHeatmap/settings.js";
import {
  HEATMAP_CPU_RASTER_QUIET_MS,
  OrderbookHeatmapOverlay,
} from "../dist/features/orderbook/heatmapOverlay.js";
import {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} from "../dist/features/orderbook/heatmapSettingsSource.js";
import {
  decodeHeatmapBarsFromBuffer,
  encodeHeatmapBarsToBuffer,
} from "../dist/features/chart/worker/workerProtocol.js";
import { ChartWorkerPanelRuntime } from "../dist/features/chart/worker/chartWorkerRuntime.js";
import { WorkerChartHostBridge } from "../dist/features/chart/worker/workerRuntimeAdapter.js";

function withSettingsSource(settingsFor, work) {
  let prevSource = null;
  try {
    prevSource = orderbookHeatmapSettingsSource();
  } catch {
    // No previous settings source configured.
  }
  const listeners = new Set();
  configureOrderbookHeatmapSettingsSource({
    settingsFor,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return Promise.resolve(work()).finally(() => {
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  });
}

function makeMockCanvasAndCtx(width, height, counters) {
  const ctx = {
    canvas: null,
    fillStyle: "",
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform() {},
    clearRect() {},
    fillRect() {
      counters.fillRect++;
    },
    strokeRect() {},
    fillText() {},
    strokeText() {},
    measureText() {
      return { width: 8 };
    },
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    closePath() {},
    setLineDash() {},
    drawImage() {
      counters.drawImage++;
    },
    createImageData(w, h) {
      return {
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      };
    },
    getImageData(_x, _y, w, h) {
      return {
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      };
    },
    putImageData(_img, _dx, _dy, dirtyX, dirtyY, dirtyW, dirtyH) {
      counters.putImageData++;
      if (dirtyW !== undefined && dirtyH !== undefined) {
        counters.dirtyPutImageData++;
        counters.lastDirtyRect = { dirtyX, dirtyY, dirtyW, dirtyH };
      }
    },
  };
  const canvas = {
    width,
    height,
    ownerDocument: null,
    getContext(kind) {
      return kind === "2d" ? ctx : null;
    },
  };
  ctx.canvas = canvas;
  return { canvas, ctx };
}

function makeMockDocument(counters) {
  const doc = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      assert.equal(tag, "canvas");
      const { canvas } = makeMockCanvasAndCtx(400, 200, counters);
      canvas.ownerDocument = doc;
      return canvas;
    },
  };
  return doc;
}

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

test("OrderbookHeatmapOverlay uses dirty-strip ImageData + putImageData with zero fillRect in motion reuse and live tail patch", async () => {
  await withSettingsSource(
    () => ({
      ...DEFAULT_ORDERBOOK_HEATMAP_SETTINGS,
      mode: "single",
      unit: "usd",
      bucketStep: 1,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
      scaleMode: "fixed",
      fixedCeiling: { usd: 1000, btc: 10 },
    }),
    async () => {
      let nowMs = 1_025 * 60_000;
      const counters = {
        fillRect: 0,
        putImageData: 0,
        dirtyPutImageData: 0,
        drawImage: 0,
        lastDirtyRect: null,
      };
      const doc = makeMockDocument(counters);
      const { canvas: mainCanvas, ctx: mainCtx } = makeMockCanvasAndCtx(400, 200, counters);
      mainCanvas.ownerDocument = doc;

      const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
      const bars = Array.from({ length: 20 }, (_, i) => ({
        startTime: (1_000 + i) * 60_000,
        open: 100,
        high: 115,
        low: 95,
        close: 105,
        volume: 10,
        delta: 0,
        count: 1,
        cells: new Map(),
        hasRef: true,
      }));
      series.loadBars(bars);

      const view = new View();
      view.area = { left: 0, top: 0, width: 400, height: 200 };
      view.colWidth = 20;
      view.offsetX = -20;
      view.fitPriceRange(85, 125);

      const overlay = new OrderbookHeatmapOverlay({
        fetch: async (req) => ({
          schemaVersion: 1,
          generatedAt: nowMs,
          base: "BTC",
          source: req.source,
          resolution: req.resolution,
          bucketStep: req.bucketStep,
          from: req.from,
          to: req.to,
          bars: bars.map((b) => ({
            t: b.startTime,
            cells: [[102, 500, 300]],
          })),
        }),
        invalidate: () => {},
        getMarket: () => "BINANCE_FUTURES:btcusdt",
        now: () => nowMs,
      });

      // 1) Initial frame schedules chunk fetch; wait for fetch to settle then draw full cached frame.
      overlay.draw(mainCtx, view, series, [0, 19]);
      await new Promise((r) => setTimeout(r, 20));

      nowMs += HEATMAP_CPU_RASTER_QUIET_MS + 100;
      overlay.draw(mainCtx, view, series, [0, 19]);
      const afterMiss = overlay.getRasterDiagnostics();
      assert.equal(counters.fillRect, 0, "initial raster build must not call fillRect");
      assert.ok(counters.putImageData > 0, "initial raster build must use putImageData");
      assert.equal(afterMiss.cacheMisses, 1);

      // 2) Live tail patch on quiet viewport uses dirty-strip putImageData with zero fillRect.
      overlay.ingestWorkerHeatmapTail({
        market: "BINANCE_FUTURES:btcusdt",
        bars: [{ t: (1_000 + 19) * 60_000, cells: [[104, 900, 700]] }],
      });
      const prevPutCount = counters.putImageData;
      overlay.draw(mainCtx, view, series, [0, 19]);
      const afterTail = overlay.getRasterDiagnostics();
      assert.equal(counters.fillRect, 0, "tryStaticLiveTailPatch must not call fillRect");
      assert.ok(counters.putImageData > prevPutCount, "tryStaticLiveTailPatch must call putImageData");
      assert.ok(counters.dirtyPutImageData > 0, "tryStaticLiveTailPatch must pass dirty rect to putImageData");
      assert.equal(afterTail.tailPatches, 1);

      // 3) Integer pan brings bar 0 into [0, 20] and triggers tryMotionRasterReuse with dirty-strip putImageData.
      view.offsetX += 20;
      nowMs += 16;
      const prevDirtyPutCount = counters.dirtyPutImageData;
      overlay.draw(mainCtx, view, series, [0, 19]);
      const afterMotion = overlay.getRasterDiagnostics();
      assert.equal(counters.fillRect, 0, "tryMotionRasterReuse must not call fillRect");
      assert.ok(counters.dirtyPutImageData > prevDirtyPutCount, "tryMotionRasterReuse must use dirty-strip putImageData");
      assert.equal(afterMotion.motionReuses, 1);
      assert.equal(afterMotion.lastFillRectCalls, 0);

      overlay.dispose();
    },
  );
});

test("ChartWorkerPanelRuntime achieves shared-core parity for footprint cells, sendStateUpdate, and heatmap diagnostics", async () => {
  const mainPorts = makePortPair();
  const historyPorts = makePortPair();
  const ingressPorts = makePortPair();

  const runtime = new ChartWorkerPanelRuntime({
    panelId: "worker-panel-1",
    marketId: "BINANCE_FUTURES:btcusdt",
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvasAndCtx(640, 360, {
      fillRect: 0,
      putImageData: 0,
      dirtyPutImageData: 0,
      drawImage: 0,
      lastDirtyRect: null,
    }).canvas,
  });

  runtime.attachPorts({
    mainPort: mainPorts.portB,
    historyPort: historyPorts.portB,
    ingressPort: ingressPorts.portB,
  });

  const bridge = new WorkerChartHostBridge({
    panelId: "worker-panel-1",
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

  // Send history bar with real footprint cells.
  historyPorts.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "worker-panel-1",
    marketId: "BINANCE_FUTURES:btcusdt",
    generation: 0,
    seq: 1,
    revision: 1,
    payload: {
      timeframe: "1m",
      hasMore: false,
      chunkIndex: 0,
      bars: [
        {
          time: 1_700_000_000_000,
          open: 100,
          high: 104,
          low: 99,
          close: 103,
          volume: 40,
          delta: 8,
          count: 4,
          cells: [
            [100, 12, 8],
            [101, 14, 6],
          ],
        },
      ],
    },
  });

  // Update chart state parity via bridge.sendStateUpdate.
  bridge.sendStateUpdate({
    chartType: "footprintProfile",
    cellData: "delta",
    scaleMode: "log",
    orderbookHeatmapMode: "aggregated",
    residentHeatmap: true,
  });
  await new Promise((r) => setTimeout(r, 0));

  // Send heatmap chunk directly over history port.
  historyPorts.portA.postMessage({
    channel: "history",
    kind: "history:heatmap-chunk",
    panelId: "worker-panel-1",
    marketId: "BINANCE_FUTURES:btcusdt",
    generation: 0,
    seq: 2,
    revision: 2,
    payload: {
      resolution: "1m",
      bucketStep: 1,
      bars: [
        {
          t: 1_700_000_000_000,
          cells: [[100, 500, 400]],
        },
      ],
    },
  });

  const rendered = runtime.renderNow();
  assert.equal(rendered, true);

  const diag = runtime.getDiagnostics();
  assert.equal(diag.renderMode, "worker");
  assert.equal(diag.chartType, "footprintProfile");
  assert.equal(diag.scaleMode, "log");
  assert.equal(diag.barCount, 1);
  assert.equal(diag.cellCount, 2, "footprint cells must be populated from WorkerHistoryBar.cells");
  assert.ok(diag.heatmap !== null, "ChartHeatmapGpuCoordinator diagnostics must be present");
  assert.equal(diag.heatmap.enabled, true);
  assert.equal(diag.heatmap.heatmapPath, "cpu");
  assert.equal(diag.heatmap.fallbackReason, "backend_unsupported");
  assert.ok(diag.heatmapRaster !== null, "OrderbookHeatmapOverlay raster diagnostics must be present");

  runtime.dispose();
  bridge.dispose();
});

test("#410: transferable ArrayBuffer heatmap protocol round-trips identically and ingests cleanly in worker runtime", async () => {
  const sampleBars = [
    {
      t: 1_700_000_000_000,
      cells: [
        [100.25, 250.5, 10],
        [101.5, 0, 420.75],
      ],
    },
    {
      t: 1_700_000_060_000,
      cells: [
        [99.75, 512, 32.25],
      ],
    },
  ];
  const encoded = encodeHeatmapBarsToBuffer(sampleBars);
  assert.ok(encoded instanceof ArrayBuffer);
  assert.deepEqual(decodeHeatmapBarsFromBuffer(encoded), sampleBars);

  const mainPorts = createMockMessageChannel();
  const ingressPorts = createMockMessageChannel();
  const historyPorts = createMockMessageChannel();

  const runtime = new ChartWorkerPanelRuntime({
    panelId: "worker-panel-binary-hm",
    marketId: "BINANCE_FUTURES:btcusdt",
    ports: {
      mainPort: mainPorts.portB,
      ingressPort: ingressPorts.portB,
      historyPort: historyPorts.portB,
    },
  });

  const bridge = new WorkerChartHostBridge({
    panelId: "worker-panel-binary-hm",
    marketId: "BINANCE_FUTURES:btcusdt",
  });
  bridge.attachPorts({ mainPort: mainPorts.portA });
  bridge.init({
    viewport: { width: 640, height: 360, dpr: 1 },
    surfaces: [
      { role: "gpu-scene", zIndex: 0, width: 640, height: 360, dpr: 1 },
      { role: "annotation", zIndex: 1, width: 640, height: 360, dpr: 1 },
      { role: "interaction", zIndex: 2, width: 640, height: 360, dpr: 1 },
    ],
    backendPreference: "canvas2d",
  });
  bridge.sendStateUpdate({ orderbookHeatmapMode: "aggregated" });
  await new Promise((r) => setTimeout(r, 0));

  const chunkBuf = encodeHeatmapBarsToBuffer([sampleBars[0]]);
  historyPorts.portA.postMessage({
    channel: "history",
    kind: "history:heatmap-chunk",
    panelId: "worker-panel-binary-hm",
    marketId: "BINANCE_FUTURES:btcusdt",
    generation: 0,
    seq: 1,
    revision: 1,
    payload: {
      resolution: "1m",
      bucketStep: 0.25,
      bars: chunkBuf,
    },
  }, [chunkBuf]);

  const tailBuf = encodeHeatmapBarsToBuffer([sampleBars[1]]);
  ingressPorts.portA.postMessage({
    channel: "ingress",
    kind: "ingress:heatmap-tail",
    panelId: "worker-panel-binary-hm",
    marketId: "BINANCE_FUTURES:btcusdt",
    generation: 0,
    seq: 1,
    revision: 2,
    payload: {
      market: "BINANCE_FUTURES:btcusdt",
      timestamp: 1_700_000_060_000,
      bars: tailBuf,
    },
  }, [tailBuf]);

  const diag = runtime.getDiagnostics();
  assert.ok(diag.heatmapRaster !== null);

  runtime.dispose();
  bridge.dispose();
});
