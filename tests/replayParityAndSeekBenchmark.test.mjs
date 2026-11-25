// #117 Research & Parity Audit: deterministic as-of (T_k) oracle parity matrix
// and 1,000 / 100,000-bar seek, #31 clone, timer-drift, and heap benchmarks.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;
globalThis.window ??= { setInterval, clearInterval };
globalThis.performance ??= { now: () => Date.now() };

const { ReplayController, cloneFootprintBarForReplay } = await import("../dist/features/replay/replayController.js");
const { ChartReplayCoordinator } = await import("../dist/features/chart/ChartReplayCoordinator.js");
const { FootprintSeries, MAX_SERIES_BARS } = await import("../dist/core/model/footprint.js");
const { calculateOrderFlowProfile } = await import("../dist/core/analysis/orderFlowProfile.js");
const { calculateVolumeProfile } = await import("../dist/core/analysis/volumeProfile.js");
const { calculateAnchoredVwap } = await import("../dist/core/analysis/anchoredVwap.js");
const { calculateOrderFlowRangeProfile } = await import("../dist/core/analysis/rangeProfile.js");
const {
  aggregateTpoBrackets,
  buildTpoBracketSpans,
  calculateTpoProfile,
  tpoSessionRange,
} = await import("../dist/core/analysis/tpoProfile.js");
const { drawTpo } = await import("../dist/core/render/overlay/tpoPaintHelpers.js");
const { View } = await import("../dist/core/engine/view.js");
const { OrderbookHeatmapOverlay } = await import("../dist/features/orderbook/heatmapOverlay.js");
const {
  configureOrderbookHeatmapSettingsSource,
  orderbookHeatmapSettingsSource,
} = await import("../dist/features/orderbook/heatmapSettingsSource.js");
const { configureIndicatorDataSource, indicatorDataSource } = await import("../dist/features/indicators/indicatorDataSource.js");
const { IndicatorPrepareCache } = await import("../dist/features/indicators/prepareCache.js");
const { volumeProfileIndicatorDefinition } = await import("../dist/features/indicators/builtins/volumeProfile.js");
const { vwapIndicatorDefinition } = await import("../dist/features/indicators/builtins/vwapIndicator.js");
const { cvdIndicatorDefinition } = await import("../dist/features/indicators/builtins/cvd.js");
const { volumeIndicatorDefinition } = await import("../dist/features/indicators/builtins/volume.js");
const { rsiIndicatorDefinition } = await import("../dist/features/indicators/builtins/rsi.js");
const { movingAverageIndicatorDefinition } = await import("../dist/features/indicators/builtins/movingAverage.js");
const { bollingerIndicatorDefinition } = await import("../dist/features/indicators/builtins/bollinger.js");
const { atrIndicatorDefinition } = await import("../dist/features/indicators/builtins/atr.js");
const { macdIndicatorDefinition } = await import("../dist/features/indicators/builtins/macd.js");
const { superTrendIndicatorDefinition } = await import("../dist/features/indicators/builtins/superTrend.js");
const { swingMapIndicatorDefinition } = await import("../dist/features/indicators/builtins/swingMap.js");
const { crossExchangeOpenInterestIndicatorDefinition } = await import("../dist/features/indicators/builtins/crossExchangeOpenInterest.js");
const { fundingRegimeIndicatorDefinition } = await import("../dist/features/indicators/builtins/fundingRegime.js");
const { futuresPositioningIndicatorDefinition } = await import("../dist/features/indicators/builtins/futuresPositioning.js");
const { liquidationsIndicatorDefinition } = await import("../dist/features/indicators/builtins/liquidations.js");
const { optionsGexWallIndicatorDefinition } = await import("../dist/features/indicators/builtins/optionsGexWall.js");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 2, 10, 0, 0, 0);

function buildRichBar(index, intervalMs = MIN, cellCount = 6) {
  const startTime = T0 + index * intervalMs;
  const wave = Math.sin(index / 7) * 20 + ((index % 5) - 2) * 3;
  const open = 50_000 + Math.round(index * 1.5 + wave);
  const close = open + ((index % 2 === 0 ? 1 : -1) * (4 + (index % 7)));
  const low = Math.min(open, close) - 3;
  const high = Math.max(open, close) + 4;
  const cells = new Map();
  let buyTotal = 0;
  let sellTotal = 0;
  for (let c = 0; c < cellCount; c++) {
    const priceBin = low + c;
    const buyVol = 2 + ((index + c) % 6);
    const sellVol = 1 + ((index * 3 + c) % 5);
    buyTotal += buyVol;
    sellTotal += sellVol;
    cells.set(priceBin, {
      priceBin,
      buyVol,
      sellVol,
      count: 2 + (c % 3),
      buyCount: 1 + (c % 2),
      sellCount: 1 + ((c + 1) % 2),
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
    });
  }
  const deltaBySize = Array.from({ length: 10 }, (_, b) => ((index + b) % 2 === 0 ? 1 : -1) * (b + 1));
  return {
    startTime,
    open,
    high,
    low,
    close,
    volume: buyTotal + sellTotal,
    delta: buyTotal - sellTotal,
    deltaBySize,
    count: cellCount * 2,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells,
    hasRef: true,
    cellRevision: 1,
    completeness: "complete",
    sources: ["history"],
    updatedAt: startTime + intervalMs,
  };
}

function buildDataset(count, intervalMs = MIN, cellCount = 6) {
  return Array.from({ length: count }, (_, i) => buildRichBar(i, intervalMs, cellCount));
}

function createReplayCoordinatorFor(bars, intervalMs = MIN, market = "BINANCE_FUTURES:btcusdt") {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(bars.map(cloneFootprintBarForReplay));
  const reloads = [];
  const host = {
    pipeline: {
      series,
      intervalMs,
      setPaused() {},
    },
    session: { invalidate() {} },
    timeViewport: { applyDataUpdate() {}, placeReplayPrefixEnd() {} },
    svc: { updateAnalysisFromSeries() {} },
    isDisposed: () => false,
    getMarket: () => market,
    autoFit() {},
    updateHook() {},
    loadHistory: async () => { reloads.push(Date.now()); },
  };
  return { coordinator: new ChartReplayCoordinator(host), series, reloads };
}

test("timeframe replay rebuild consumes source bars and clamps an old virtual time into range", () => {
  const { coordinator, series } = createReplayCoordinatorFor(buildDataset(3, MIN, 4), MIN);
  coordinator.start();
  coordinator.seek(T0 + MIN);
  assert.equal(coordinator.getSnapshot().virtualTime, T0 + MIN);

  withFakeClock(() => {
    coordinator.play();
    coordinator.prepareForTimeframeChange();
    const sourceBars = [100, 101, 102].map((index) => buildRichBar(index, 5 * MIN, 4));

    coordinator.reconfigureAfterTimeframeChange(5 * MIN, sourceBars);

    const snapshot = coordinator.getSnapshot();
    assert.equal(snapshot.rangeStart, sourceBars[0].startTime);
    assert.equal(snapshot.virtualTime, sourceBars[0].startTime);
    assert.equal(snapshot.state, "playing", "a replay playing before refresh resumes after the timeframe rebuild");
    assert.equal(series.length, 0, "no new-timeframe bar is complete at the clamped range start");
    coordinator.exit({ reloadHistory: false });
  });
});

test("replay start cancels history writes and settles deferred day refreshes after replacement history", async () => {
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars([buildRichBar(0), buildRichBar(1)]);
  const calls = { cancelHistory: 0, cancelPatchDay: 0, reloadHistory: 0, replaySettled: 0 };
  const coordinator = new ChartReplayCoordinator({
    pipeline: {
      series,
      intervalMs: MIN,
      cancelHistoryLoad() { calls.cancelHistory++; },
      cancelPatchDay() { calls.cancelPatchDay++; },
      setPaused() {},
    },
    session: { invalidate() {} },
    timeViewport: { applyDataUpdate() {}, placeReplayPrefixEnd() {} },
    svc: { updateAnalysisFromSeries() {} },
    isDisposed: () => false,
    getMarket: () => "TEST:replay-history-guard",
    autoFit() {},
    updateHook() {},
    async loadHistory() { calls.reloadHistory++; },
    onReplaySettled() { calls.replaySettled++; },
  });

  coordinator.start();
  assert.deepEqual(calls, { cancelHistory: 1, cancelPatchDay: 1, reloadHistory: 0, replaySettled: 0 });
  coordinator.exit();
  await new Promise(setImmediate);
  assert.deepEqual(calls, { cancelHistory: 1, cancelPatchDay: 1, reloadHistory: 1, replaySettled: 1 });
});

function createFreshOracleSeries(barsSlice, intervalMs = MIN) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(barsSlice.map(cloneFootprintBarForReplay));
  return series;
}

function makeIndicatorDrawContext(series, def, opts = {}) {
  const settings = { ...def.defaultSettings(), ...(opts.settingsOverrides ?? {}) };
  const range = opts.range ?? [0, series.length];
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 400 };
  view.colWidth = 8;
  view.offsetX = 0;
  return {
    ctx: {},
    view,
    series,
    rect: { top: 0, height: 120 },
    range,
    instance: {
      id: opts.instanceId ?? `replay-test-${def.type}`,
      type: def.type,
      title: def.name,
      visible: true,
      paneId: def.defaultPane === "price" ? "main" : `pane-${def.type}`,
      order: 0,
      settings,
      seq: 1,
    },
    settings,
    chart: {
      asOfTime: opts.asOfTime,
      market: opts.market ?? "BINANCE_FUTURES:btcusdt",
      timeframe: opts.timeframe ?? "1m",
      intervalMs: series.config.intervalMs,
    },
    crosshair: { x: 0, y: 0, visible: false },
    requestRefresh: () => {},
  };
}

function serializeSeriesBars(series) {
  return series.listReadonly().map((b) => ({
    startTime: b.startTime,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    delta: b.delta,
    deltaBySize: b.deltaBySize ?? null,
    count: b.count,
    cells: [...b.cells.entries()].sort((a, b2) => a[0] - b2[0]),
  }));
}

function withMockedIndicatorSource(mock, fn) {
  let prev = null;
  try {
    prev = indicatorDataSource();
  } catch {
    prev = null;
  }
  configureIndicatorDataSource(mock);
  try {
    return fn();
  } finally {
    if (prev !== null) configureIndicatorDataSource(prev);
  }
}

function withFakeClock(run) {
  const origSetInterval = globalThis.window.setInterval;
  const origClearInterval = globalThis.window.clearInterval;
  const origNow = performance.now.bind(performance);
  let now = 0;
  let cb = null;
  globalThis.window.setInterval = (fn) => { cb = fn; return 77; };
  globalThis.window.clearInterval = () => { cb = null; };
  performance.now = () => now;
  try {
    return run({
      advance(ms) {
        now += ms;
        cb?.();
      },
    });
  } finally {
    performance.now = origNow;
    globalThis.window.setInterval = origSetInterval;
    globalThis.window.clearInterval = origClearInterval;
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function summarizeMs(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const r3 = (x) => Math.round(x * 1_000) / 1_000;
  return {
    count: sorted.length,
    minMs: r3(sorted[0] ?? 0),
    p50Ms: r3(percentile(sorted, 50)),
    p95Ms: r3(percentile(sorted, 95)),
    p99Ms: r3(percentile(sorted, 99)),
    maxMs: r3(sorted[sorted.length - 1] ?? 0),
  };
}

// ============================================================================
// 1. FOOTPRINT, TPO (#144), AND CORE DERIVED INDICATORS AS-OF PARITY
// ============================================================================

test("replay as-of parity: footprint bars/cells, volume profile POC/VAH/VAL, and TPO (#144) match fresh oracle across forward, step, and backward seek", () => {
  const fullBars = buildDataset(160, MIN, 8);
  const { coordinator, series } = createReplayCoordinatorFor(fullBars, MIN);

  coordinator.start();
  const checkpoints = [
    { label: "seek-120", k: 120, action: () => coordinator.seek(T0 + 120 * MIN) },
    { label: "step-121", k: 121, action: () => coordinator.step() },
    { label: "back-45", k: 45, action: () => coordinator.seek(T0 + 45 * MIN) },
    { label: "step-46", k: 46, action: () => coordinator.step() },
  ];

  // Shared TPO canvas mock & render host to test drawTpo cache invalidation on backward seek.
  const tpoHost = {
    ctx: {
      save() {},
      restore() {},
      fillRect() {},
      strokeRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fillText() {},
      setLineDash() {},
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      textBaseline: "middle",
      textAlign: "left",
    },
    chartConfig: { chartType: "tpo", tpoProfilePeriod: "visible", tpoBracketSize: "auto", tpoMode: "histogram" },
    tpoCache: null,
    tpoMergeLeftSessionStarts: new Set(),
    getProfileSettings: () => ({ valueAreaPercent: 0.7 }),
    pushTpoProfileHitZone() {},
  };

  for (const cp of checkpoints) {
    cp.action();
    const oracle = createFreshOracleSeries(fullBars.slice(0, cp.k), MIN);

    // 1. Bar + cell bit-identical parity
    assert.deepStrictEqual(serializeSeriesBars(series), serializeSeriesBars(oracle), `${cp.label}: bars & cells`);

    // 2. OrderFlow / Volume Profile POC, VAH, VAL parity
    const ofpReplay = calculateOrderFlowProfile(series.listReadonly(), {
      profileMetric: "volume",
      profileSide: "total",
      valueAreaPercent: 0.7,
      developing: true,
      priceStep: 1,
    });
    const ofpOracle = calculateOrderFlowProfile(oracle.listReadonly(), {
      profileMetric: "volume",
      profileSide: "total",
      valueAreaPercent: 0.7,
      developing: true,
      priceStep: 1,
    });
    assert.deepStrictEqual(ofpReplay, ofpOracle, `${cp.label}: OrderFlowProfile POC/VAH/VAL`);

    const vpReplay = calculateVolumeProfile(series.listReadonly(), 0.7);
    const vpOracle = calculateVolumeProfile(oracle.listReadonly(), 0.7);
    assert.deepStrictEqual(vpReplay, vpOracle, `${cp.label}: calculateVolumeProfile`);

    // 3. TPO Profile (#144 visible range + daily sessions + drawTpo cache key)
    for (const period of ["visible", "daily"]) {
      const rAll = series.listReadonly();
      const oAll = oracle.listReadonly();
      const [rf, rt] = tpoSessionRange(rAll, Math.max(0, rAll.length - 30), rAll.length, period);
      const [of, ot] = tpoSessionRange(oAll, Math.max(0, oAll.length - 30), oAll.length, period);
      const rBrackets = aggregateTpoBrackets(rAll, rf, rt, MIN);
      const oBrackets = aggregateTpoBrackets(oAll, of, ot, MIN);
      assert.deepStrictEqual(
        buildTpoBracketSpans(rBrackets, period),
        buildTpoBracketSpans(oBrackets, period),
        `${cp.label} (${period}): TPO bracket spans`,
      );
      const rTpo = calculateTpoProfile(rBrackets.map((b) => b.bar), 1, 0.7);
      const oTpo = calculateTpoProfile(oBrackets.map((b) => b.bar), 1, 0.7);
      assert.deepStrictEqual(rTpo, oTpo, `${cp.label} (${period}): calculateTpoProfile POC/VAH/VAL`);
    }

    const view = new View();
    view.area = { left: 0, top: 0, width: 800, height: 400 };
    view.colWidth = 8;
    view.offsetX = 0;
    view.fitPriceRange(49_950, 50_150, 0);
    const from = Math.max(0, cp.k - 25);
    drawTpo(tpoHost, view, series, [from, cp.k]);
    const oracleHost = { ...tpoHost, tpoCache: null };
    drawTpo(oracleHost, view, oracle, [from, cp.k]);
    assert.deepStrictEqual(tpoHost.tpoCache.groups, oracleHost.tpoCache.groups, `${cp.label}: drawTpo cache & groups parity`);
  }

  coordinator.exit({ reloadHistory: false });
});

test("replay as-of parity: 11 derived indicators match fresh oracle and reset caches on backward seek", () => {
  const fullBars = buildDataset(160, MIN, 6);
  const { coordinator, series } = createReplayCoordinatorFor(fullBars, MIN);

  const specs = [
    { def: volumeProfileIndicatorDefinition, overrides: { mode: "visible" } },
    { def: vwapIndicatorDefinition },
    { def: cvdIndicatorDefinition, overrides: { bucketMode: "preset" } },
    { def: volumeIndicatorDefinition, overrides: { showMa: true, maPeriod: 10 } },
    { def: rsiIndicatorDefinition },
    { def: movingAverageIndicatorDefinition },
    { def: bollingerIndicatorDefinition },
    { def: atrIndicatorDefinition },
    { def: macdIndicatorDefinition },
    { def: superTrendIndicatorDefinition },
    { def: swingMapIndicatorDefinition, overrides: { left: 3, right: 3, showUnconfirmed: false } },
  ];

  // Reuse IndicatorPrepareCache just like IndicatorManager does to prove no stale cache hit across backward seek.
  const prepareCache = new IndicatorPrepareCache(2);
  const runWithCache = (targetSeries, def, overrides, asOfTime) => {
    const drawCtx = makeIndicatorDrawContext(targetSeries, def, {
      settingsOverrides: overrides,
      range: [0, targetSeries.length],
      asOfTime,
    });
    return prepareCache.resolve(drawCtx.instance.id, {
      definitionType: def.type,
      instance: drawCtx.instance,
      series: targetSeries,
      rangeFrom: 0,
      rangeTo: targetSeries.length,
      market: drawCtx.chart.market,
      timeframe: drawCtx.chart.timeframe,
      intervalMs: targetSeries.config.intervalMs,
      timeBucket: 0,
    }, () => def.prepareData(drawCtx));
  };

  coordinator.start();
  const sequence = [
    { label: "forward-120", k: 120, action: () => coordinator.seek(T0 + 120 * MIN) },
    { label: "step-121", k: 121, action: () => coordinator.step() },
    { label: "backward-40", k: 40, action: () => coordinator.seek(T0 + 40 * MIN) },
    { label: "step-41", k: 41, action: () => coordinator.step() },
  ];

  for (const step of sequence) {
    step.action();
    const vt = coordinator.getSnapshot().virtualTime;
    const oracle = createFreshOracleSeries(fullBars.slice(0, step.k), MIN);

    for (const spec of specs) {
      const replayPrepared = runWithCache(series, spec.def, spec.overrides, vt);
      const oracleDrawCtx = makeIndicatorDrawContext(oracle, spec.def, {
        settingsOverrides: spec.overrides,
        range: [0, oracle.length],
        // Compare as-of at T_k (for swingMap, all closed bars <= T_k match).
        asOfTime: spec.def.type === "swing-map" ? vt : undefined,
      });
      const oraclePrepared = spec.def.prepareData(oracleDrawCtx);

      assert.equal(replayPrepared.status, oraclePrepared.status, `${step.label} ${spec.def.type}: status`);
      assert.deepStrictEqual(replayPrepared.points, oraclePrepared.points, `${step.label} ${spec.def.type}: points parity`);
      if (spec.def.type === "volume-profile") {
        assert.deepStrictEqual(replayPrepared.meta?.result, oraclePrepared.meta?.result, `${step.label} volume-profile result parity`);
      } else {
        assert.deepStrictEqual(replayPrepared.range, oraclePrepared.range, `${step.label} ${spec.def.type}: range parity`);
      }
    }
  }

  coordinator.exit({ reloadHistory: false });
});

test("replay parity matrix row: Options GEX Wall hides cached/live surfaces and fetches once after replay", async () => {
  const fullBars = buildDataset(80, MIN, 4);
  const { coordinator, series } = createReplayCoordinatorFor(fullBars, MIN);
  const settingsOverrides = { base: "HYPE", maxExpiryDays: 7 };
  const paintCalls = [];
  const makeCanvas = () => ({
    save() { paintCalls.push("save"); }, restore() { paintCalls.push("restore"); },
    setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { paintCalls.push("stroke"); },
    fillRect() { paintCalls.push("fillRect"); }, fillText() { paintCalls.push("fillText"); },
    measureText: () => ({ width: 20 }),
  });
  let fetchedLiveOptions = 0;
  const source = {
    requestLiquidationSeries: () => ({ status: "unavailable" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "unavailable" }),
    requestFuturesPositioningSeries: () => ({ status: "unavailable" }),
    fetchOptionsGexSurface: async () => {
      fetchedLiveOptions++;
      return {
        spotPrice: 50_000,
        strikeNetGexCrossing: 50_500,
        maxPain: 50_000,
        callWall: 52_000,
        putWall: 48_000,
        strikes: [],
        timestamp: T0 + 79 * MIN,
      };
    },
  };

  coordinator.start();
  coordinator.seek(T0 + 40 * MIN);
  const virtualTime = coordinator.getSnapshot().virtualTime;
  const replayContext = makeIndicatorDrawContext(series, optionsGexWallIndicatorDefinition, {
    settingsOverrides,
    asOfTime: virtualTime,
  });
  replayContext.view.yOfPrice = () => 100;
  replayContext.ctx = makeCanvas();
  const replayPrepared = withMockedIndicatorSource(source, () => optionsGexWallIndicatorDefinition.prepareData(replayContext));
  optionsGexWallIndicatorDefinition.drawPriceOverlay(replayContext, replayPrepared);
  assert.equal(replayPrepared.status, "no-data", "replay has no historical options surface");
  assert.equal(replayPrepared.meta.surface, undefined, "a live surface is not exposed in replay metadata");
  assert.match(optionsGexWallIndicatorDefinition.getHeaderLabel({
    settings: replayContext.settings,
    chart: replayContext.chart,
    prepared: replayPrepared,
  }), /no-data/, "the indicator header exposes the unavailable replay state");
  assert.equal(fetchedLiveOptions, 0, "replay never requests the live options API");
  assert.deepEqual(paintCalls, [], "replay draws no cached or live options levels/zones/bars");

  coordinator.exit({ reloadHistory: false });
  const liveContext = makeIndicatorDrawContext(series, optionsGexWallIndicatorDefinition, { settingsOverrides });
  liveContext.view.yOfPrice = () => 100;
  liveContext.ctx = makeCanvas();
  const loading = withMockedIndicatorSource(source, () => optionsGexWallIndicatorDefinition.prepareData(liveContext));
  assert.equal(loading.status, "loading");
  assert.equal(fetchedLiveOptions, 1, "leaving replay starts the ordinary live request once");
  await Promise.resolve();
  const livePrepared = withMockedIndicatorSource(source, () => optionsGexWallIndicatorDefinition.prepareData(liveContext));
  assert.equal(livePrepared.status, "ok");
  optionsGexWallIndicatorDefinition.drawPriceOverlay(liveContext, livePrepared);
  assert.ok(paintCalls.length > 0, "live levels resume after replay");
  assert.equal(fetchedLiveOptions, 1, "the resolved cache avoids a duplicate request");

  coordinator.start();
  coordinator.seek(virtualTime);
  const cachedReplayContext = makeIndicatorDrawContext(series, optionsGexWallIndicatorDefinition, {
    settingsOverrides,
    asOfTime: virtualTime,
  });
  cachedReplayContext.view.yOfPrice = () => 100;
  const cachedReplayCanvas = makeCanvas();
  cachedReplayContext.ctx = cachedReplayCanvas;
  const cachedReplayPrepared = withMockedIndicatorSource(source, () => optionsGexWallIndicatorDefinition.prepareData(cachedReplayContext));
  const cachedReplayPaintStart = paintCalls.length;
  optionsGexWallIndicatorDefinition.drawPriceOverlay(cachedReplayContext, cachedReplayPrepared);
  assert.equal(cachedReplayPrepared.status, "no-data");
  assert.equal(cachedReplayPrepared.meta.surface, undefined, "a cached live surface is hidden during replay too");
  assert.equal(fetchedLiveOptions, 1, "replay does not refresh the live options request");
  assert.equal(paintCalls.length, cachedReplayPaintStart, "the cached surface paints nothing during replay");
  coordinator.exit({ reloadHistory: false });
});

test("replay parity matrix row: Orderbook heatmap suppresses the live extension during replay and restores it after exit", async () => {
  let previousHeatmapSource = null;
  try { previousHeatmapSource = orderbookHeatmapSettingsSource(); } catch {}
  configureOrderbookHeatmapSettingsSource({
    settingsFor: () => ({
      mode: "single",
      unit: "usd",
      bucketStep: 50,
      single: { usd: 1, btc: 1 },
      aggregated: { usd: 1, btc: 1 },
    }),
    onChange: () => () => {},
  });

  const fullBars = buildDataset(4, MIN, 4);
  const { coordinator, series } = createReplayCoordinatorFor(fullBars, MIN);
  const currentTime = T0 + fullBars.length * MIN;
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (request) => ({
      schemaVersion: 1,
      generatedAt: currentTime,
      base: "BTC",
      source: request.source,
      resolution: request.resolution,
      bucketStep: request.bucketStep,
      from: request.from,
      to: request.to,
      bars: [],
    }),
    invalidate: () => {},
    getMarket: () => "BINANCE_FUTURES:btcusdt",
    isReplayActive: () => coordinator.isActive(),
    now: () => currentTime,
  });
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 400 };
  view.colWidth = 8;
  view.priceTop = 50_100;
  const lastBar = fullBars.at(-1);
  const liveHeatmapBar = {
    t: lastBar.startTime,
    cells: [[50_000, 1_000, 1_000]],
  };

  try {
    // Resolve the tier before pushing a mocked local tail, then compare the same frame inputs.
    overlay.prepareGpuCells(view, series, [0, series.length - 1]);
    overlay.applyLiveTailBars([liveHeatmapBar]);
    const liveBeforeReplay = overlay.prepareGpuCells(view, series, [0, series.length - 1]);
    assert.equal(liveBeforeReplay.extension.length, 0, "live chart does not draw right-edge extension (#280)");

    coordinator.start();
    assert.equal(coordinator.isActive(), true);
    const replayFrame = overlay.prepareGpuCells(view, series, [0, series.length - 1]);
    const extensionCount = replayFrame.extension.length;
    assert.equal(extensionCount, 0, "replay does not draw a live heatmap extension");
    assert.equal(replayFrame.main.length, liveBeforeReplay.main.length, "historical cells remain visible during replay");

    coordinator.exit({ reloadHistory: false });
    assert.equal(coordinator.isActive(), false);
    const liveAfterReplay = overlay.prepareGpuCells(view, series, [0, series.length - 1]);
    assert.equal(liveAfterReplay.extension.length, 0, "right-edge extension stays disabled after replay (#280)");
  } finally {
    overlay.dispose();
    coordinator.exit({ reloadHistory: false });
    if (previousHeatmapSource) configureOrderbookHeatmapSettingsSource(previousHeatmapSource);
  }
});

test("replay as-of parity: external OI, Funding, Liquidations, and Futures Positioning align to prefix and ignore future spikes", () => {
  const fullBars = buildDataset(160, MIN, 4);
  const { coordinator, series } = createReplayCoordinatorFor(fullBars, MIN);

  // Source timelines cover ALL 160 bars and inject massive 1,000x spikes after index 60.
  const oiPoints = fullBars.map((b, i) => ({ time: b.startTime, value: i < 60 ? 1_000_000 + i * 100 : 999_000_000 }));
  const fundPoints = fullBars.map((b, i) => ({ time: b.startTime, value: i < 60 ? 0.0001 + i * 1e-6 : 0.99 }));
  const predFundPoints = fullBars.map((b, i) => ({ time: b.startTime, value: i < 60 ? 0.00015 : 1.5 }));
  const liqPoints = fullBars.map((b, i) => ({
    time: b.startTime,
    longLiquidationsUsd: i < 60 ? 10_000 : 500_000_000,
    shortLiquidationsUsd: i < 60 ? 8_000 : 500_000_000,
    totalLiquidationsUsd: i < 60 ? 18_000 : 1_000_000_000,
    liquidationDeltaUsd: i < 60 ? -2_000 : 0,
    components: [],
  }));
  const posPoints = fullBars.map((b, i) => ({
    time: b.startTime,
    openInterest: i < 60 ? 1_000 + i : 9_999_999,
    openInterestUsd: i < 60 ? 50_000_000 + i * 100 : 99_000_000_000,
    topTraderAccountLongShortRatio: i < 60 ? 1.2 : 99.9,
    topTraderPositionLongShortRatio: i < 60 ? 1.1 : 99.9,
    globalLongShortRatio: i < 60 ? 1.05 : 99.9,
    takerLongShortVolumeRatio: i < 60 ? 0.98 : 99.9,
  }));

  const makeMockSource = (cutoffTime) => ({
    requestLiquidationSeries: () => ({
      status: "ready",
      data: {
        interval: "1m",
        from: T0,
        to: cutoffTime ?? T0 + 160 * MIN,
        symbols: ["BTCUSDT"],
        truncated: false,
        points: cutoffTime === null ? liqPoints : liqPoints.filter((p) => p.time < cutoffTime),
      },
    }),
    requestCoinalyzeDerivativeSeries: ({ metric }) => {
      const src = metric === "openInterest" ? oiPoints : metric === "fundingRate" ? fundPoints : predFundPoints;
      return {
        status: "ready",
        data: {
          metric,
          interval: "1m",
          from: T0,
          to: cutoffTime ?? T0 + 160 * MIN,
          symbols: ["BTCUSDT"],
          truncated: false,
          points: cutoffTime === null ? src : src.filter((p) => p.time < cutoffTime),
        },
      };
    },
    requestFuturesPositioningSeries: () => ({
      status: "ready",
      data: {
        symbol: "BTCUSDT",
        interval: "1m",
        from: T0,
        to: cutoffTime ?? T0 + 160 * MIN,
        truncated: false,
        missingDays: [],
        points: cutoffTime === null ? posPoints : posPoints.filter((p) => p.time < cutoffTime),
      },
    }),
    requestVenueFundingSeries: ({ to, venues }) => {
      const limit = cutoffTime ?? to;
      const settled = (cutoffTime === null ? fundPoints : fundPoints.filter((p) => p.time < cutoffTime)).map((p) => ({
        t: p.time,
        rate: p.value,
        intervalHours: 1,
        rate8h: p.value,
      }));
      const predLast = predFundPoints.filter((p) => p.time < limit).at(-1);
      return {
        status: "ready",
        data: {
          market: "BTCUSDT",
          from: T0,
          to: limit,
          venues,
          series: [
            {
              venue: "binancef",
              intervalHours: 1,
              settled,
              current: predLast ? { t: predLast.time, rate: predLast.value, rate8h: predLast.value } : null,
            },
          ],
        },
      };
    },
    fetchOptionsGexSurface: async () => ({ spotPrice: 99_999, callWall: 120_000, putWall: 80_000, strikes: [], timestamp: T0 + 159 * MIN }),
  });

  const extDefs = [
    crossExchangeOpenInterestIndicatorDefinition,
    fundingRegimeIndicatorDefinition,
    liquidationsIndicatorDefinition,
    futuresPositioningIndicatorDefinition,
  ];
  const extOpts = (def) => (def.type === "funding-regime" ? { settingsOverrides: { mode: "fundingRate" } } : {});

  coordinator.start();
  coordinator.seek(T0 + 120 * MIN);
  // Populate caches at T_120 first (in future window containing huge spikes), then seek backward to T_40.
  withMockedIndicatorSource(makeMockSource(null), () => {
    for (const def of extDefs) {
      def.prepareData(makeIndicatorDrawContext(series, def, { asOfTime: T0 + 120 * MIN, ...extOpts(def) }));
    }
  });

  coordinator.seek(T0 + 40 * MIN);
  const oracle = createFreshOracleSeries(fullBars.slice(0, 40), MIN);

  for (const def of extDefs) {
    const replayPrepared = withMockedIndicatorSource(makeMockSource(null), () =>
      def.prepareData(makeIndicatorDrawContext(series, def, { asOfTime: T0 + 40 * MIN, ...extOpts(def) })),
    );
    const oraclePrepared = withMockedIndicatorSource(makeMockSource(T0 + 40 * MIN), () =>
      def.prepareData(makeIndicatorDrawContext(oracle, def, extOpts(def))),
    );
    assert.equal(replayPrepared.status, "ok", `${def.type} should stay ok`);
    assert.deepStrictEqual(replayPrepared.points, oraclePrepared.points, `${def.type}: external replay points must ignore >T_40 future spikes`);
    assert.deepStrictEqual(replayPrepared.range, oraclePrepared.range, `${def.type}: external replay range must ignore >T_40 future spikes`);
  }

  coordinator.exit({ reloadHistory: false });
});

test("replay as-of parity: analysis drawings (Anchored VWAP & Fixed-Range Volume Profile), timeframe 1m->5m->15m->1m, linked vs unlinked chart, and out-of-order repair", () => {
  const full1m = buildDataset(90, MIN, 4);
  const { coordinator, series } = createReplayCoordinatorFor(full1m, MIN);

  // 1. Anchored VWAP & FRVP analysis calculations during forward & backward seek
  coordinator.start();
  coordinator.seek(T0 + 60 * MIN);
  coordinator.seek(T0 + 35 * MIN);
  const oracle35 = createFreshOracleSeries(full1m.slice(0, 35), MIN);
  const anchor = T0 + 10 * MIN;
  assert.deepStrictEqual(
    calculateAnchoredVwap(series.listReadonly(), anchor),
    calculateAnchoredVwap(oracle35.listReadonly(), anchor),
    "Anchored VWAP matches oracle at backward seek T_35",
  );
  const frvpReplay = calculateOrderFlowRangeProfile(series.listReadonly().filter((b) => b.startTime >= T0 + 10 * MIN && b.startTime <= T0 + 80 * MIN), T0 + 10 * MIN, T0 + 80 * MIN, {
    profileMetric: "volume",
    profileSide: "total",
    valueAreaPercent: 0.7,
    developing: false,
  });
  const frvpOracle = calculateOrderFlowRangeProfile(oracle35.listReadonly().filter((b) => b.startTime >= T0 + 10 * MIN && b.startTime <= T0 + 80 * MIN), T0 + 10 * MIN, T0 + 80 * MIN, {
    profileMetric: "volume",
    profileSide: "total",
    valueAreaPercent: 0.7,
    developing: false,
  });
  assert.deepStrictEqual(frvpReplay, frvpOracle, "FRVP spanning past virtualTime sees strictly <= T_35 bars");

  // 2. Timeframe round-trip: 1m -> 5m -> 15m -> 1m while paused mid-15m/5m candle (T0 + 37m)
  const buildCoarse = (mult) =>
    Array.from({ length: Math.floor(full1m.length / mult) }, (_, i) => buildRichBar(i, mult * MIN, 4));
  const bars5m = buildCoarse(5);
  const bars15m = buildCoarse(15);

  const vtMid = T0 + 37 * MIN; // completes 7x5m (0..30m, 7th ends at 35m; [35,40) incomplete) and 2x15m (0..15, 15..30; [30,45) incomplete)
  const ctl = new ReplayController(() => {}, () => {});
  ctl.loadForSelection(full1m.map(cloneFootprintBarForReplay), MIN);
  ctl.seek(vtMid);
  assert.equal(ctl.snapshot().visibleBars, 37);

  const res5m = ctl.reconfigure(bars5m.map(cloneFootprintBarForReplay), 5 * MIN);
  assert.equal(ctl.snapshot().virtualTime, vtMid);
  assert.equal(res5m.visibleBars.length, 7);
  assert.ok(res5m.visibleBars.every((b) => b.startTime + 5 * MIN <= vtMid));

  const res15m = ctl.reconfigure(bars15m.map(cloneFootprintBarForReplay), 15 * MIN);
  assert.equal(ctl.snapshot().virtualTime, vtMid);
  assert.equal(res15m.visibleBars.length, 2);
  assert.ok(res15m.visibleBars.every((b) => b.startTime + 15 * MIN <= vtMid));

  const resBack1m = ctl.reconfigure(full1m.map(cloneFootprintBarForReplay), MIN);
  assert.equal(ctl.snapshot().virtualTime, vtMid);
  assert.equal(resBack1m.visibleBars.length, 37);
  ctl.dispose();

  // 3. Linked follower + unlinked live chart staying live with out-of-order history repair
  const chartA = createReplayCoordinatorFor(full1m, MIN, "BINANCE_FUTURES:btcusdt");
  const chartB = createReplayCoordinatorFor(full1m, MIN, "BINANCE_FUTURES:btcusdt");
  const liveCSeries = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  liveCSeries.loadBars(full1m.slice(0, 50).map(cloneFootprintBarForReplay));
  chartA.coordinator.subscribe((snap) => chartB.coordinator.applyExternal(snap));

  chartA.coordinator.start();
  chartA.coordinator.seek(T0 + 25 * MIN);
  chartA.coordinator.step();
  assert.equal(chartB.series.length, 26, "linked follower mirrors owner step");
  assert.deepStrictEqual(serializeSeriesBars(chartB.series), serializeSeriesBars(chartA.series));

  // Unlinked Chart C receives out-of-order history repair & live updates unaffected by A/B replay.
  const outOfOrderRepair = [buildRichBar(52, MIN, 4), buildRichBar(50, MIN, 4), buildRichBar(51, MIN, 4)];
  for (const bar of outOfOrderRepair) liveCSeries.upsertBar(cloneFootprintBarForReplay(bar));
  assert.equal(liveCSeries.length, 53);
  assert.equal(liveCSeries.at(50).startTime, T0 + 50 * MIN);
  assert.equal(liveCSeries.at(52).startTime, T0 + 52 * MIN);
  assert.equal(chartA.series.length, 26, "independent Chart C updates do not leak into Chart A replay");

  chartA.coordinator.exit({ reloadHistory: false });
  coordinator.exit({ reloadHistory: false });
});

// ============================================================================
// 2. SCALE BENCHMARK: 1,000 & 100,000 BAR SEEK, #31 CLONE, DRIFT, HEAP
// ============================================================================

test("benchmark: 1,000 and 100,000 bar replay seek p50/p95/p99, cloneFootprintBarForReplay vs #31, timer drift, and heap delta", () => {
  // 1) Compare cloneFootprintBarForReplay vs structuredClone on 1,000 bars x 60 cells (#31 comparison)
  const bars1k60 = buildDataset(1_000, MIN, 60);
  const t0Clone1k = performance.now();
  const fast1k = bars1k60.map(cloneFootprintBarForReplay);
  const fastClone1kMs = performance.now() - t0Clone1k;

  const t0Struct1k = performance.now();
  const struct1k = bars1k60.map((b) => structuredClone(b));
  const structuredClone1kMs = performance.now() - t0Struct1k;
  assert.equal(fast1k.length, 1_000);
  assert.equal(struct1k.length, 1_000);

  // Seek p50/p95/p99 on 1,000 bars (controller vs full coordinator rebuild)
  const ctrl1k = new ReplayController(() => {}, () => {});
  ctrl1k.loadForSelection(fast1k, MIN);
  const targets1k = [200, 850, 120, 640, 40, 950, 310, 770, 500, 999];
  const ctrlSeek1kMs = [];
  for (let round = 0; round < 4; round++) {
    for (const idx of targets1k) {
      const t0 = performance.now();
      const res = ctrl1k.seek(T0 + idx * MIN);
      ctrlSeek1kMs.push(performance.now() - t0);
      assert.equal(res.length, idx);
    }
  }
  ctrl1k.dispose();

  const coord1k = createReplayCoordinatorFor(bars1k60, MIN);
  coord1k.coordinator.start();
  const coordSeek1kMs = [];
  for (const idx of targets1k) {
    const t0 = performance.now();
    coord1k.coordinator.seek(T0 + idx * MIN);
    coordSeek1kMs.push(performance.now() - t0);
    assert.equal(coord1k.series.length, idx);
  }
  coord1k.coordinator.exit({ reloadHistory: false });

  // 2) 100,000-bar dataset (10 cells/bar = 1,000,000 cells) — clone, controller seek, coordinator rebuild, heap
  const heapBefore100k = process.memoryUsage().heapUsed;
  const bars100k = buildDataset(100_000, MIN, 10);
  const t0Clone100k = performance.now();
  const cloned100k = bars100k.map(cloneFootprintBarForReplay);
  const fastClone100kMs = performance.now() - t0Clone100k;
  const heapAfter100k = process.memoryUsage().heapUsed;

  const ctrl100k = new ReplayController(() => {}, () => {});
  ctrl100k.loadForSelection(cloned100k, MIN);
  const targets100k = [10_000, 90_000, 25_000, 75_000, 50_000, 95_000, 5_000, 60_000, 80_000, 40_000];
  const ctrlSeek100kMs = [];
  for (const idx of targets100k) {
    const t0 = performance.now();
    const res = ctrl100k.seek(T0 + idx * MIN);
    ctrlSeek100kMs.push(performance.now() - t0);
    assert.equal(res.length, idx);
  }
  ctrl100k.dispose();

  const coord100k = createReplayCoordinatorFor(bars100k, MIN);
  coord100k.coordinator.start();
  const coordSeek100kMs = [];
  for (const idx of [10_000, 90_000, 25_000, 75_000, 50_000, 95_000]) {
    const t0 = performance.now();
    coord100k.coordinator.seek(T0 + idx * MIN);
    coordSeek100kMs.push(performance.now() - t0);
    assert.equal(coord100k.series.length, Math.min(idx, MAX_SERIES_BARS));
    const firstVisibleIndex = Math.max(0, idx - MAX_SERIES_BARS);
    assert.equal(
      coord100k.series.at(0)?.startTime,
      T0 + firstVisibleIndex * MIN,
      "a capped replay rebuild keeps the newest MAX_SERIES_BARS bars",
    );
    assert.equal(
      coord100k.series.at(coord100k.series.length - 1)?.startTime,
      T0 + (idx - 1) * MIN,
      "a capped replay rebuild keeps the latest completed replay bar",
    );
  }
  coord100k.coordinator.exit({ reloadHistory: false });

  // 3) Timer drift benchmark at 1x and 20x speeds (including jittered 50ms ticks & catch-up cap = 20)
  const driftReport = {};
  for (const speed of [1, 20]) {
    const released = [];
    const ctrl = new ReplayController((b) => released.push(b.startTime), () => {});
    ctrl.loadForSelection(bars1k60.slice(0, 400), MIN);
    ctrl.seek(T0 + 10 * MIN);
    ctrl.setSpeed(speed);
    withFakeClock((clock) => {
      ctrl.play();
      // 20 ticks of 50ms with +/-7ms deterministic jitter, net 1,000ms virtual wall time.
      const jitters = [50, 43, 57, 46, 54, 50, 44, 56, 48, 52, 50, 45, 55, 49, 51, 50, 43, 57, 47, 53];
      for (const dt of jitters) clock.advance(dt);
      ctrl.pause();
    });
    const expectedReleased = speed; // 1.000s * speed bars/sec
    assert.equal(released.length, expectedReleased, `speed=${speed}x zero cumulative drift across 1,000ms`);
    driftReport[`speed${speed}x`] = { expectedBars: expectedReleased, actualBars: released.length, driftBars: released.length - expectedReleased };
    ctrl.dispose();
  }

  const benchmark = {
    clone1k60Cells: {
      fastCloneMs: Math.round(fastClone1kMs * 1_000) / 1_000,
      structuredCloneMs: Math.round(structuredClone1kMs * 1_000) / 1_000,
      speedupX: Math.round((structuredClone1kMs / Math.max(0.001, fastClone1kMs)) * 100) / 100,
    },
    seek1k: {
      controller: summarizeMs(ctrlSeek1kMs),
      coordinatorRebuild: summarizeMs(coordSeek1kMs),
    },
    clone100k10Cells: {
      fastCloneMs: Math.round(fastClone100kMs * 1_000) / 1_000,
      heapDeltaMb: Math.round(((heapAfter100k - heapBefore100k) / (1024 * 1024)) * 100) / 100,
    },
    seek100k: {
      controller: summarizeMs(ctrlSeek100kMs),
      coordinatorRebuild: summarizeMs(coordSeek100kMs),
      seriesCap: MAX_SERIES_BARS,
    },
    timerDrift: driftReport,
  };
  console.log("REPLAY_PARITY_BENCHMARK_SUMMARY", JSON.stringify(benchmark));
  assert.ok(benchmark.clone1k60Cells.speedupX > 1, "cloneFootprintBarForReplay should stay faster than structuredClone");
});
