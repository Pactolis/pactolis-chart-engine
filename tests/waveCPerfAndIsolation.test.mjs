import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.$state ??= (value) => value;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const { View } = await import("../dist/core/engine/view.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const {
  ChartChange,
  ChartSurfaceDirty,
  surfaceDirtyForChanges,
} = await import("../dist/core/render/scene/chartScene.js");
const { calculateOrderFlowProfile } = await import("../dist/core/analysis/orderFlowProfile.js");
const { bollingerBands, seriesOhlcv } = await import("../dist/core/analysis/calc/ta.js");
const { encodeF32LeBase64 } = await import("../dist/core/analysis/liquidationModel.js");
const { configureChartLocale } = await import("../dist/core/chartLocale.js");
const {
  getWebGpuHeatmapModuleReservedBytesForTest,
  WebGpuNativeHeatmapPipeline,
} = await import("../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js");
const { Canvas2dSurface } = await import("../dist/core/gpu/canvas2d/canvas2dSurface.js");
const { WebGpuSurface } = await import("../dist/core/gpu/webgpu/webgpuSurface.js");
const { resetGpuDiagnosticsForTest } = await import("../dist/core/gpu/gpuDiagnostics.js");
const {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
} = await import("../dist/core/performanceTelemetry.js");
const { bollingerIndicatorDefinition } = await import("../dist/features/indicators/builtins/bollinger.js");
const { ichimokuCloudSegments } = await import("../dist/features/indicators/builtins/ichimokuCloud.js");
const {
  drawLiquidationProfileOverlay,
  liquidationProfileIndicatorDefinition,
  prepareLiquidationProfile,
} = await import("../dist/features/indicators/builtins/liquidationProfile.js");
const {
  drawMultiSeries,
  drawMultiSeriesInteraction,
} = await import("../dist/features/indicators/builtins/taShared.js");
const { whaleVsCrowdIndicatorDefinition } = await import("../dist/features/indicators/builtins/whaleVsCrowd.js");
const { barStatsIndicatorDefinition } = await import("../dist/features/indicators/builtins/barStats.js");
const { configureIndicatorDataSource } = await import("../dist/features/indicators/indicatorDataSource.js");
const { createIndicatorInstanceAsync } = await import("../dist/features/indicators/registry.js");
const { createIndicatorPaneHeadersModel } = await import("../dist/features/indicators/indicatorPaneHeaders.js");
const { ChartIndicatorController } = await import("../dist/features/chart/ChartIndicatorController.js");
const { OrderbookHeatmapOverlay } = await import("../dist/features/orderbook/heatmapOverlay.js");
const {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} = await import("../dist/features/orderbook/heatmapSettingsSource.js");
const { ChartWorkerPanelRuntime } = await import("../dist/features/chart/worker/chartWorkerRuntime.js");
const { WorkerChartEndpoint, WorkerChartHostBridge } = await import("../dist/features/chart/worker/workerRuntimeAdapter.js");

configureChartLocale({
  locale: () => "en-US",
  timeZone: () => "UTC",
  translate: (key) => key,
  onLocaleChange: () => () => {},
});

function makeMock2dCtx(canvas) {
  const ops = [];
  return {
    ops,
    canvas,
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    beginPath() {},
    moveTo(x, y) { ops.push(["moveTo", x, y]); },
    lineTo(x, y) { ops.push(["lineTo", x, y]); },
    closePath() { ops.push(["closePath"]); },
    stroke() { ops.push(["stroke"]); },
    fill() { ops.push(["fill"]); },
    rect() {},
    clip() {},
    setLineDash() {},
    setTransform() {},
    clearRect() {},
    roundRect() {},
    fillRect(x, y, w, h) { ops.push(["fillRect", x, y, w, h]); },
    strokeRect() {},
    fillText(t, x, y) { ops.push(["fillText", String(t), x, y]); },
    strokeText() {},
    drawImage() {},
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    getImageData(_x, _y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    measureText(text) { return { width: String(text ?? "").length * 6 }; },
  };
}

function makeMockBars(count, intervalMs = 60_000, start = 1_700_000_040_000) {
  return Array.from({ length: count }, (_, i) => {
    const open = 50_000 + Math.sin(i / 4) * 50 + i * 2;
    const close = open + ((i % 2 === 0 ? 1 : -1) * 5);
    const high = Math.max(open, close) + 4;
    const low = Math.min(open, close) - 4;
    return {
      startTime: start + i * intervalMs,
      open,
      high,
      low,
      close,
      volume: 100 + i,
      delta: (i % 2 === 0 ? 1 : -1) * 10,
      count: 20,
      cells: new Map([
        [Math.round(low), { priceBin: Math.round(low), buyVol: 55 + i, sellVol: 45, count: 10, buyCount: 5, sellCount: 5 }],
        [Math.round(high), { priceBin: Math.round(high), buyVol: 25, sellVol: 35, count: 10, buyCount: 4, sellCount: 6 }],
      ]),
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
    };
  });
}

function makePortPair() {
  const listenersA = new Set();
  const listenersB = new Set();
  const make = (own, peer) => ({
    postMessage(data) {
      for (const fn of [...peer]) fn({ data });
    },
    addEventListener(_type, fn) { own.add(fn); },
    removeEventListener(_type, fn) { own.delete(fn); },
    start() {},
    close() { own.clear(); },
  });
  return { portA: make(listenersA, listenersB), portB: make(listenersB, listenersA) };
}

test("#426: hot-path drawSeriesPath, ichimokuCloudSegments, orderFlowProfile, and tailStdDev preserve parity", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  const bars = makeMockBars(40);
  series.loadBars(bars);

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 300 };
  view.colWidth = 16;
  view.setVisibleIndexRange(0, 40);
  view.fitPriceRange(49_950, 50_200, 0.1);

  // 1. drawMultiSeries & drawMultiSeriesInteraction across line, area, histogram + sparse index
  const ctx2d = makeMock2dCtx({});
  const multiPrepared = {
    status: "ok",
    points: [],
    range: { min: -5, max: 140 },
    meta: {
      startIndex: 0,
      endIndex: 40,
      scaleMode: "auto",
      series: [
        {
          key: "a",
          label: "Line",
          color: "#00ffaa",
          style: "line",
          points: bars.map((b, idx) => ({ index: idx, time: b.startTime, value: idx === 5 ? null : 100 + idx })),
        },
        {
          key: "b",
          label: "Area",
          color: "#ffaa00",
          style: "area",
          points: bars.map((b, idx) => ({ index: idx, time: b.startTime, value: idx < 2 ? null : 95 + idx })),
        },
        {
          key: "c",
          label: "Hist",
          color: "#aa88ff",
          style: "histogram",
          points: bars.filter((_, idx) => idx % 2 === 0).map((b, k) => ({ index: k * 2, time: b.startTime, value: k - 5 })),
        },
      ],
    },
  };
  const drawCtx = {
    ctx: ctx2d,
    view,
    series,
    rect: { top: 300, height: 120 },
    range: [0, 40],
    instance: { id: "ms-1", type: "rsi", title: "MS", visible: true, order: 0 },
    settings: { lineWidth: 1.5, showLastValueLabel: true, showReadout: true, showAxisTicks: true },
    chart: { market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000 },
    crosshair: { x: view.xOfIndex(12) + 4, y: 340, visible: true },
    requestRefresh: () => {},
  };
  drawMultiSeries(drawCtx, multiPrepared);
  drawMultiSeriesInteraction(drawCtx, multiPrepared);
  assert.ok(ctx2d.ops.some((op) => op[0] === "fill"), "area path filled");
  assert.ok(ctx2d.ops.some((op) => op[0] === "fillRect"), "histogram bars drawn");
  assert.ok(ctx2d.ops.some((op) => op[0] === "fillText" && op[1].includes("Line 112")), "readout resolved at hoverIndex=12");

  // 2. ichimokuCloudSegments two-pointer + unordered fallback parity
  const ptsA = [
    { index: 2, value: 12 },
    { index: 3, value: 14 },
    { index: 4, value: 7 },
    { index: 6, value: 15 },
  ];
  const ptsB = [
    { index: 2, value: 10 },
    { index: 3, value: 11 },
    { index: 4, value: 12 },
    { index: 5, value: 13 },
  ];
  const orderedSegs = ichimokuCloudSegments(ptsA, ptsB);
  const unorderedSegs = ichimokuCloudSegments(ptsA, [ptsB[2], ptsB[0], ptsB[3], ptsB[1]]);
  assert.deepEqual(orderedSegs, unorderedSegs);
  assert.equal(orderedSegs.length, 2);
  assert.equal(orderedSegs[0].bullish, true);
  assert.equal(orderedSegs[1].bullish, false);

  // 3. calculateOrderFlowProfile monotonic fast path vs unsorted parity
  const orderedProfile = calculateOrderFlowProfile(bars);
  const shuffledProfile = calculateOrderFlowProfile([...bars].reverse());
  assert.equal(orderedProfile.poc, shuffledProfile.poc);
  assert.equal(orderedProfile.vah, shuffledProfile.vah);
  assert.equal(orderedProfile.val, shuffledProfile.val);
  assert.equal(orderedProfile.totalVolume, shuffledProfile.totalVolume);
  assert.deepEqual(orderedProfile.levels, shuffledProfile.levels);

  // 4. Bollinger incremental tailStdDev parity against full bollingerBands
  const incSeries = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  incSeries.loadBars(bars.slice(0, 30));
  const makeBbCtx = () => ({
    ctx: ctx2d,
    view,
    series: incSeries,
    rect: { top: 0, height: 300 },
    range: [0, incSeries.length],
    instance: { id: "bb-1", type: "bollinger-bands", title: "BB", visible: true, order: 0 },
    settings: bollingerIndicatorDefinition.defaultSettings(),
    chart: { market: "BTCUSDT", timeframe: "1m", intervalMs: 60_000 },
    requestRefresh: () => {},
  });
  bollingerIndicatorDefinition.prepareData(makeBbCtx());
  const nextBar = bars[30];
  incSeries.upsertBar(nextBar);
  const incPrepared = bollingerIndicatorDefinition.prepareData(makeBbCtx());
  const fullBands = bollingerBands(seriesOhlcv(incSeries), 20, 2);
  const lastFull = fullBands[fullBands.length - 1];
  const upperLast = incPrepared.meta.series[0].points.at(-1).value;
  const middleLast = incPrepared.meta.series[1].points.at(-1).value;
  const lowerLast = incPrepared.meta.series[2].points.at(-1).value;
  assert.ok(Math.abs(upperLast - lastFull.upper) < 1e-9);
  assert.ok(Math.abs(middleLast - lastFull.middle) < 1e-9);
  assert.ok(Math.abs(lowerLast - lastFull.lower) < 1e-9);
});

test("#425: package.json sideEffects, static graph isolation, and worker lazy heatmap skip when off", async () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.sideEffects, false);

  const webgpuSurfaceSrc = readFileSync(resolve(repoRoot, "src/core/gpu/webgpu/webgpuSurface.ts"), "utf8");
  assert.equal(/__PactolisWebGpuSurface/.test(webgpuSurfaceSrc), false);

  const chartRuntimeSrc = readFileSync(resolve(repoRoot, "src/features/chart/ChartRuntime.ts"), "utf8");
  assert.equal(/import\s*\{[^}]*OrderbookHeatmapOverlay/.test(chartRuntimeSrc), false);

  const workerSrc = readFileSync(resolve(repoRoot, "src/features/chart/worker/chartWorkerRuntime.ts"), "utf8");
  assert.equal(/import\s*\{[^}]*OrderbookHeatmapOverlay/.test(workerSrc), false);

  // ChartWorkerPanelRuntime opened with mode="off" must NOT construct OrderbookHeatmapOverlay
  const prevSource = (() => { try { return orderbookHeatmapSettingsSource(); } catch { return null; } })();
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "off",
      unit: "usd",
      bucketStep: 25,
      scaleMode: "auto",
      fixedCeiling: 500,
      opacity: 0.85,
      palette: "pactolis",
      single: { usd: 50_000, btc: 50 },
      aggregated: { usd: 50_000, btc: 50 },
      customSources: ["binance"],
    }),
    onChange: () => () => {},
  });

  const mainPorts = makePortPair();
  const runtime = new ChartWorkerPanelRuntime({
    panelId: "worker-off-425",
    marketId: "BINANCE_FUTURES:btcusdt",
    backendPreference: "canvas2d",
    createScratchCanvas: () => {
      const canvas = {
        width: 640,
        height: 360,
        getContext(kind) { return kind === "2d" ? makeMock2dCtx(canvas) : null; },
      };
      return canvas;
    },
  });
  try {
    runtime.attachPorts({ mainPort: mainPorts.portB });
    const bridge = new WorkerChartHostBridge({ panelId: "worker-off-425", marketId: "BINANCE_FUTURES:btcusdt" });
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
    assert.equal(runtime.getDiagnostics().heatmapRaster, null, "mode=off must not instantiate OrderbookHeatmapOverlay");

    bridge.sendStateUpdate({ orderbookHeatmapMode: "single" });
    await new Promise((r) => setTimeout(r, 15));
    assert.notEqual(runtime.getDiagnostics().heatmapRaster, null, "switching mode lazily activates OrderbookHeatmapOverlay");
    bridge.dispose();
  } finally {
    runtime.dispose();
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});

test("#424: hidden liveTimer suppresses invalidate and GPU-owned heatmap dirties only GpuScene", async () => {
  const prevSource = (() => { try { return orderbookHeatmapSettingsSource(); } catch { return null; } })();
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 25,
      scaleMode: "auto",
      fixedCeiling: 500,
      opacity: 0.85,
      palette: "pactolis",
      single: { usd: 50_000, btc: 50 },
      aggregated: { usd: 50_000, btc: 50 },
      customSources: ["binance"],
    }),
    onChange: () => () => {},
  });

  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  let capturedTimerFn = null;
  globalThis.setInterval = (fn) => {
    capturedTimerFn = fn;
    return 9991;
  };
  globalThis.clearInterval = () => {};

  let invalidations = 0;
  let visibilityState = "hidden";
  const fakeDoc = {
    get visibilityState() { return visibilityState; },
    addEventListener() {},
    removeEventListener() {},
  };
  const fakeCanvas = { ownerDocument: fakeDoc };

  let overlay;
  try {
    overlay = new OrderbookHeatmapOverlay({
      fetch: async () => ({
        schemaVersion: 1,
        generatedAt: Date.now(),
        base: "BTC",
        source: "binance",
        resolution: "1m",
        bucketStep: 25,
        from: 0,
        to: 60_000,
        bars: [],
      }),
      invalidate: () => { invalidations++; },
      getMarket: () => "BINANCE_FUTURES:btcusdt",
      now: () => 1_700_000_060_000,
    });
    const hmView = new View();
    hmView.area = { left: 0, top: 0, width: 400, height: 200 };
    const hmSeries = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
    overlay.draw(makeMock2dCtx(fakeCanvas), hmView, hmSeries, [0, 0]);
    assert.ok(capturedTimerFn, "liveTimer registered");
    capturedTimerFn();
    assert.equal(invalidations, 0, "hidden document must suppress liveTimer invalidate()");

    visibilityState = "visible";
    capturedTimerFn();
    assert.equal(invalidations, 1, "visible document resumes liveTimer invalidate()");

    // Verify GPU-owned GpuContext invalidation never dirties Annotation or Interaction
    const gpuDirty = surfaceDirtyForChanges(ChartChange.GpuContext);
    assert.equal(gpuDirty, ChartSurfaceDirty.GpuScene);
    assert.equal(gpuDirty & ChartSurfaceDirty.Annotation, 0);
    assert.equal(gpuDirty & ChartSurfaceDirty.Interaction, 0);
  } finally {
    overlay?.dispose();
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    if (prevSource) configureOrderbookHeatmapSettingsSource(prevSource);
  }
});

test("#423: WebGPU heatmap lazy immediate pipeline, deduplicated prewarm, zero-alloc sync, and single submit", async () => {
  resetGpuDiagnosticsForTest();
  resetPerformanceTelemetry();

  const shaderLabels = [];
  let asyncPipelineCalls = 0;
  let asyncResolve;
  const asyncPending = new Promise((res) => { asyncResolve = res; });
  let bufferCalls = 0;
  let submitCalls = 0;
  const loadOps = [];
  const draws = [];

  const mockDevice = {
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    features: new Set(),
    queue: {
      writeBuffer() {},
      writeTexture() {},
      submit(cmds) { submitCalls += cmds.length; },
    },
    createShaderModule(desc) {
      shaderLabels.push(desc.label);
      return { label: desc.label };
    },
    createBuffer(desc) {
      bufferCalls++;
      return { label: desc.label, size: desc.size, destroy() {} };
    },
    createTexture() { return { createView: () => ({}), destroy() {} }; },
    createSampler() { return {}; },
    createBindGroupLayout() { return {}; },
    createBindGroup() { return {}; },
    createPipelineLayout() { return {}; },
    createComputePipeline(desc) { return { label: desc?.label }; },
    createRenderPipeline(desc) { return { label: desc.label }; },
    async createRenderPipelineAsync(desc) {
      asyncPipelineCalls++;
      await asyncPending;
      return { label: desc.label };
    },
    createCommandEncoder() {
      return {
        beginRenderPass(desc) {
          for (const att of desc.colorAttachments ?? []) loadOps.push(att.loadOp);
          return {
            setPipeline() {},
            setBindGroup() {},
            setVertexBuffer() {},
            setScissorRect() {},
            draw(v, inst) { draws.push({ v, inst }); },
            end() {},
          };
        },
        beginComputePass() {
          return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        finish() { return {}; },
      };
    },
  };

  // 1. Constructor must NOT compile immediate WGSL or allocate buffers eagerly
  const pipeline = new WebGpuNativeHeatmapPipeline(mockDevice, "rgba8unorm");
  assert.equal(shaderLabels.length, 0);
  assert.equal(bufferCalls, 0);

  // 2. Concurrent prewarmResidentPipelineAsync calls share 1 createRenderPipelineAsync
  const p1 = pipeline.prewarmResidentPipelineAsync();
  const p2 = pipeline.prewarmResidentPipelineAsync();
  assert.equal(p1, p2);
  asyncResolve();
  const [ok1, ok2] = await Promise.all([p1, p2]);
  assert.equal(ok1, true);
  assert.equal(ok2, true);
  assert.equal(asyncPipelineCalls, 1);
  assert.equal(shaderLabels.includes("NativeHeatmapShader"), false, "resident path must not compile immediate shader");

  // 3. Zero-alloc forEachBarCell sync skips readBarCells completely
  let readBarCellsCalls = 0;
  let forEachCalls = 0;
  const targetTex = { createView: () => ({}) };
  const plot = { left: 0, top: 0, width: 800, height: 600, pixelRatio: 1 };
  const residentFrame = {
    syncGeneration: 1,
    tailSyncRevision: 1,
    barCount: 2,
    priceOrigin: 50_000,
    bucketStep: 50,
    liveBarIndex: 1,
    dataKey: "k-423",
    view: { offsetX: 0, colWidth: 20, priceTop: 50_500, pricePerPx: 1 },
    floor: 10,
    ceiling: 500,
    threshold: 10,
    opacity: 0.85,
    visibleRange: [0, 1],
    readBarCells() {
      readBarCellsCalls++;
      return [];
    },
    forEachBarCell(b, visit) {
      forEachCalls++;
      visit(50_000 + b * 50, 100 + b * 50, b === 1);
      return 1;
    },
  };
  assert.equal(pipeline.renderResidentFrame(targetTex, 800, 600, 1, residentFrame, plot), true);
  assert.equal(readBarCellsCalls, 0, "forEachBarCell must avoid readBarCells allocations");
  assert.equal(forEachCalls, 2);

  pipeline.dispose();
  assert.equal(getWebGpuHeatmapModuleReservedBytesForTest(), 0);

  // 4. WebGpuSurface composited native scene + resident heatmap emits 1 submit & 0 loadOp='load'
  const mockCtx = { getCurrentTexture: () => targetTex };
  const canvas = { width: 800, height: 600, getContext: (k) => (k === "webgpu" ? mockCtx : null) };
  const handle = {
    adapter: {},
    device: mockDevice,
    format: "rgba8unorm",
    limits: mockDevice.limits,
    isLost: () => false,
    onLost: () => () => {},
    dispose() {},
  };
  const surface = new WebGpuSurface(canvas, handle);
  submitCalls = 0;
  loadOps.length = 0;
  draws.length = 0;
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.priceTop = 50_500;
  view.pricePerPx = 1;

  surface.beginNativeComposite();
  try {
    const okScene = surface.renderNativeScene(
      { r: 0, g: 0, b: 0, a: 1 },
      800,
      600,
      { view, series: new FootprintSeries({ intervalMs: 60_000, priceStep: 1 }), drawFootprint: false, generation: 1, tailRevision: 1, candleTotalCount: 0, cellTotalCount: 0, chartType: "candlestick", readCandle: () => null, readCell: () => null },
    );
    assert.equal(okScene, true);
    assert.equal(submitCalls, 0, "renderNativeScene defers submit during beginNativeComposite");
    const okHm = surface.renderNativeResidentHeatmap(residentFrame, plot);
    assert.equal(okHm, true);
    assert.equal(submitCalls, 0, "heatmap pass merges into deferred pass without extra submit");
  } finally {
    surface.flushNativeComposite();
  }
  assert.equal(submitCalls, 1, "composited frame emits exactly 1 queue.submit");
  assert.deepEqual(loadOps, ["clear"], "single render pass uses loadOp='clear' and zero loadOp='load'");
  assert.ok(draws.some((d) => d.inst === 2), "resident heatmap draw recorded in shared pass");
  surface.dispose();
  assert.equal(getWebGpuHeatmapModuleReservedBytesForTest(), 0);
});

test("#422: LiquidationProfile caches model decode/replay across series revisions and merges pixel rows once per Y scale", () => {
  const origAtob = globalThis.atob;
  let atobCalls = 0;
  globalThis.atob = (str) => {
    atobCalls++;
    return origAtob(str);
  };

  try {
    const now = Date.now();
    const nbk = 100;
    const zeros = new Array(nbk).fill(0);
    const modelState = {
      schemaVersion: 1,
      modelVersion: 1,
      symbol: "BTCUSDT",
      params: { lev: [10, 25, 50, 100], lw: [0.25, 0.35, 0.25, 0.15], mmr: 0.004, bw: 0.002, p0: 65_000, nbk },
      asOf: now - 300_000,
      lastOi: 1000,
      longb: encodeF32LeBase64(zeros),
      shortb: encodeF32LeBase64(zeros),
      v1: { passed: true, tested: true, fallingBp: 12, risingBp: 11, bestPlaceboBp: 2, days: 190 },
      seam: [{ t: now - 300_000, h: 74_500, l: 74_300, c: 74_400, v: 1000, tb: 500, oi: 1000 }],
    };
    const response = {
      status: "ready",
      state: modelState,
      bars: [
        modelState.seam[0],
        { t: now - 60_000, h: 74_600, l: 74_200, c: 74_430, v: 1200, tb: 700, oi: 1200 },
      ],
    };

    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      fetchOptionsGexSurface: async () => { throw new Error("unused"); },
      requestLiquidationClusters: () => ({ status: "unsupported" }),
      requestLiquidationModel: () => ({ status: "ready", data: response }),
    });

    atobCalls = 0;
    const view = new View();
    view.area = { left: 10, top: 20, width: 600, height: 300 };
    view.priceTop = 80_000;
    view.pricePerPx = 10_000 / 300;
    let yCalls = 0;
    const origYOfPrice = view.yOfPrice.bind(view);
    view.yOfPrice = (p) => {
      yCalls++;
      return origYOfPrice(p);
    };

    const canvas = makeMock2dCtx({});
    let firstPrepared = null;
    for (let i = 0; i < 100; i++) {
      const ctx = {
        ctx: canvas,
        view,
        series: { revision: i + 1, listReadonly: () => [{ close: 74_430 }] },
        rect: { top: 20, height: 300 },
        range: [i, i + 50],
        instance: { id: "lp-422", type: "liquidation-profile", title: "LP", visible: true, paneId: "p1", order: 0 },
        settings: { ...liquidationProfileIndicatorDefinition.defaultSettings(), source: "model", rangePct: 100 },
        chart: { market: "BINANCE_FUTURES:btcusdt", timeframe: "5m", intervalMs: 300_000 },
        requestRefresh: () => {},
      };
      const prepared = prepareLiquidationProfile(ctx);
      if (i === 0) firstPrepared = prepared;
      assert.equal(prepared.meta.clusters, firstPrepared.meta.clusters);

      // Horizontal pan changes offsetX without changing vertical scale -> pixel merge must hit cache
      view.offsetX = -i * 5;
      drawLiquidationProfileOverlay(ctx, prepared);
    }

    assert.equal(atobCalls, 2, "longb + shortb decoded only once across 100 revisions (2 atob calls total)");
    assert.ok(yCalls <= firstPrepared.meta.clusters.length, "yOfPrice pixel-row merge cached across 99 horizontal pan frames");
  } finally {
    globalThis.atob = origAtob;
  }
});

test("#421: ChartIndicatorController shares Annotation cache and avoids re-running prepareData on 100 pointermoves", async () => {
  const prevWhalePrepare = whaleVsCrowdIndicatorDefinition.prepareData;
  const prevBarStatsPrepare = barStatsIndicatorDefinition.prepareData;
  let whalePrepares = 0;
  let barStatsPrepares = 0;

  whaleVsCrowdIndicatorDefinition.prepareData = (ctx) => {
    whalePrepares++;
    return prevWhalePrepare(ctx);
  };
  barStatsIndicatorDefinition.prepareData = (ctx) => {
    barStatsPrepares++;
    return prevBarStatsPrepare(ctx);
  };

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    requestWhaleCrowdSeries: () => ({ status: "idle" }),
  });

  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(makeMockBars(20));
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 300 };
  view.setVisibleIndexRange(0, 20);
  view.fitPriceRange(49_950, 50_100, 0.1);

  const whaleInst = await createIndicatorInstanceAsync("whale-vs-crowd", 0);
  const barStatsInst = await createIndicatorInstanceAsync("bar-stats", 1);
  const controller = new ChartIndicatorController({
    ownerDocument: {
      defaultView: null,
      createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
      dispatchEvent: () => true,
    },
    root: { appendChild() {} },
    initial: [whaleInst, barStatsInst],
    onChange: () => {},
    onLayoutChange: () => {},
    onInvalidate: () => {},
    getChartContext: () => ({ market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: 60_000 }),
    queuePriceLabel: () => {},
    headers: createIndicatorPaneHeadersModel(),
  });

  try {
    const ctx2d = makeMock2dCtx({});
    // 1. Annotation draw + Interaction draw in the same frame -> <= 1 prepareData per indicator
    for (const pane of controller.getPaneRenders()) {
      pane.draw(ctx2d, view, series, { top: 300, height: 100 }, [0, 20]);
    }
    controller.renderInteraction(ctx2d, view, series, [0, 20], { x: 100, y: 340, visible: true });
    assert.equal(whalePrepares, 1);
    assert.equal(barStatsPrepares, 1);

    // 2. 100 consecutive pointermove interactions with unchanged data/range -> 0 additional prepares
    for (let i = 0; i < 100; i++) {
      controller.renderInteraction(ctx2d, view, series, [0, 20], { x: 100 + i, y: 340, visible: true });
    }
    assert.equal(whalePrepares, 1);
    assert.equal(barStatsPrepares, 1);
  } finally {
    whaleVsCrowdIndicatorDefinition.prepareData = prevWhalePrepare;
    barStatsIndicatorDefinition.prepareData = prevBarStatsPrepare;
    controller.dispose();
  }
});

test("#420: ChartWorkerPanelRuntime isolates Interaction frames, recycles buffers, bounds bar revisions, and guards setupSurfaces race", async () => {
  // 1. WorkerChartEndpoint bounded lastBarRevisionByKey + epoch-bump clear
  const endpoint = new WorkerChartEndpoint({
    panelId: "p-420",
    marketId: "BINANCE_FUTURES:btcusdt",
    maxSeenTradeIds: 64, // maxTrackedBarRevisions = 256
  });
  for (let i = 0; i < 400; i++) {
    endpoint.handleEnvelope({
      channel: "ingress",
      kind: "ingress:bar",
      panelId: "p-420",
      marketId: "BINANCE_FUTURES:btcusdt",
      generation: 0,
      seq: i + 1,
      revision: i + 1,
      payload: { timeframe: "1m", time: i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    });
  }
  assert.ok(endpoint.lastBarRevisionByKey.size <= 256, "lastBarRevisionByKey must stay bounded");

  endpoint.handleEnvelope({
    channel: "main",
    kind: "main:lifecycle",
    panelId: "p-420",
    marketId: "BINANCE_FUTURES:btcusdt",
    generation: 1,
    seq: 1,
    revision: 1,
    payload: { action: "epoch-bump" },
  });
  assert.equal(endpoint.lastBarRevisionByKey.size, 0, "epoch-bump must clear lastBarRevisionByKey");
  endpoint.dispose();

  // 2. ChartWorkerPanelRuntime: pointermove skips gpuSurface/annotations, setupSurfaces disposes stale surface, heatmap ArrayBuffer recycles
  const mainPorts = makePortPair();
  const historyPorts = makePortPair();
  const ingressPorts = makePortPair();
  const recycled = [];
  mainPorts.portA.addEventListener("message", ({ data }) => {
    if (data?.kind === "main:recycle-buffer") recycled.push(data.payload.buffer);
  });

  const canvasDrawCounts = { gpu: 0, ann: 0, inter: 0 };
  const makeTrackedCanvas = () => {
    const c = {
      width: 640,
      height: 360,
      getContext(kind) {
        if (kind !== "2d") return null;
        const ctx = makeMock2dCtx(c);
        const origFillRect = ctx.fillRect;
        ctx.fillRect = (x, y, w, h) => {
          canvasDrawCounts.gpu++;
          origFillRect.call(ctx, x, y, w, h);
        };
        return ctx;
      },
    };
    return c;
  };

  const runtime = new ChartWorkerPanelRuntime({
    panelId: "w-420",
    marketId: "BINANCE_FUTURES:btcusdt",
    backendPreference: "canvas2d",
    createScratchCanvas: makeTrackedCanvas,
  });
  runtime.attachPorts({
    mainPort: mainPorts.portB,
    historyPort: historyPorts.portB,
    ingressPort: ingressPorts.portB,
  });

  const bridge = new WorkerChartHostBridge({ panelId: "w-420", marketId: "BINANCE_FUTURES:btcusdt" });
  bridge.attachPorts({ mainPort: mainPorts.portA });

  try {
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

    // Concurrent setupSurfaces race guard: start 2 overlapping setupSurfaces and ensure only latest remains
    let gpuRenderCalls = 0;
    let annotationRenderCalls = 0;
    let interactionRenderCalls = 0;
    const origBeginFrame = runtime.gpuSurface.beginFrame.bind(runtime.gpuSurface);
    runtime.gpuSurface.beginFrame = (c) => {
      gpuRenderCalls++;
      return origBeginFrame(c);
    };
    const origAnn = runtime.overlay.renderAnnotations.bind(runtime.overlay);
    runtime.overlay.renderAnnotations = (...args) => {
      annotationRenderCalls++;
      return origAnn(...args);
    };
    const origInter = runtime.overlay.renderInteraction.bind(runtime.overlay);
    runtime.overlay.renderInteraction = (...args) => {
      interactionRenderCalls++;
      return origInter(...args);
    };

    // Binary history chunk + binary heatmap chunk/tail -> bulk load & recycleBuffer
    const packedHistory = new Float64Array([1_700_000_040_000, 100, 102, 99, 101, 25]).buffer;
    historyPorts.portA.postMessage({
      channel: "history",
      kind: "history:chunk",
      panelId: "w-420",
      marketId: "BINANCE_FUTURES:btcusdt",
      generation: 0,
      seq: 1,
      revision: 1,
      payload: { timeframe: "1m", hasMore: false, chunkIndex: 0, bars: packedHistory },
    });
    const hmChunkBuf = new ArrayBuffer(16);
    historyPorts.portA.postMessage({
      channel: "history",
      kind: "history:heatmap-chunk",
      panelId: "w-420",
      marketId: "BINANCE_FUTURES:btcusdt",
      generation: 0,
      seq: 2,
      revision: 2,
      payload: { resolution: "1m", bucketStep: 25, bars: hmChunkBuf },
    });
    const hmTailBuf = new ArrayBuffer(16);
    ingressPorts.portA.postMessage({
      channel: "ingress",
      kind: "ingress:heatmap-tail",
      panelId: "w-420",
      marketId: "BINANCE_FUTURES:btcusdt",
      generation: 0,
      seq: 1,
      revision: 1,
      payload: { market: "BINANCE_FUTURES:btcusdt", bars: hmTailBuf },
    });
    assert.equal(recycled.length, 3, "history, heatmap-chunk, and heatmap-tail buffers must recycle");

    assert.equal(runtime.renderNow(), true);
    // Enter hover once so crosshair visibility transitions false -> true on annotation HUD
    bridge.sendInput({ type: "pointermove", x: 120, y: 110, timestamp: 90 });
    assert.equal(runtime.renderNow(), true);
    gpuRenderCalls = 0;
    annotationRenderCalls = 0;
    interactionRenderCalls = 0;

    // Steady-state non-dragging pointermove -> ChartChange.Interaction ONLY
    bridge.sendInput({ type: "pointermove", x: 150, y: 120, timestamp: 100 });
    assert.equal(runtime.renderNow(), true);
    assert.equal(gpuRenderCalls, 0, "Interaction-only frame must not run gpuSurface render");
    assert.equal(annotationRenderCalls, 0, "Interaction-only frame must not run renderAnnotations");
    assert.equal(interactionRenderCalls, 1, "Interaction-only frame runs renderInteraction");

    // Concurrent setupSurfaces race guard: earlier slow setup must dispose its superseded surface
    let surfaceDisposals = 0;
    const origProtoDispose = Canvas2dSurface.prototype.dispose;
    Canvas2dSurface.prototype.dispose = function () {
      surfaceDisposals++;
      return origProtoDispose.call(this);
    };
    try {
      const pSlow = runtime.setupSurfaces(640, 360, 1);
      const pFast = runtime.setupSurfaces(800, 480, 1);
      await Promise.all([pSlow, pFast]);
      // Expect 2 disposals: previous surface + superseded surface created by pSlow.
      assert.equal(surfaceDisposals, 2, "concurrent setupSurfaces must dispose old surface and superseded racing surface");
      assert.equal(runtime.getDiagnostics().width, 800);
    } finally {
      Canvas2dSurface.prototype.dispose = origProtoDispose;
    }
  } finally {
    bridge.dispose();
    runtime.dispose();
  }
});
