import assert from "node:assert/strict";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { IndicatorManager } from "../dist/features/indicators/IndicatorManager.js";
import { IndicatorPrepareCache } from "../dist/features/indicators/prepareCache.js";
import {
  IndicatorPrepareScheduler,
  isCompatibleIndicatorPrepareRevisionStamp,
} from "../dist/features/indicators/prepareScheduler.js";
import { getIndicatorDefinition } from "../dist/features/indicators/registry.js";

const INTERVAL = 60_000;
const BASE_TIME = 1_700_000_040_000 - (1_700_000_040_000 % INTERVAL);

function makeSeries(barCount) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  const bars = [];
  for (let i = 0; i < barCount; i += 1) {
    const price = 100 + Math.sin(i * 0.15) * 10;
    bars.push({
      startTime: BASE_TIME + i * INTERVAL,
      open: price,
      high: price + 2,
      low: price - 2,
      close: price + 0.5,
      volume: 20 + (i % 5),
      delta: 1,
      count: 1,
      cells: new Map([[Math.round(price), { priceBin: Math.round(price), buyVol: 11, sellVol: 9, count: 1 }]]),
      completeness: "complete",
    });
  }
  series.loadBars(bars);
  return series;
}

function makeFakeView() {
  return {
    area: { left: 0, top: 0, width: 800, height: 400 },
    subPanesH: 180,
    colWidth: 8,
    priceTop: 120,
    pricePerPx: 0.1,
    chartLayoutOptions: { timeAxisHeight: 24 },
    xOfIndex: (i) => i * 8,
    yOfPrice: (p) => 400 - p,
  };
}

function makeFakeCtx() {
  const noop = () => {};
  const base = {
    canvas: { width: 800, height: 600 },
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    rect: noop,
    clip: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    setLineDash: noop,
    arc: noop,
    measureText: (text) => ({ width: String(text).length * 6 }),
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noop;
    },
  });
}

function makeInstances(types) {
  return types.map((type, idx) => {
    const def = getIndicatorDefinition(type);
    return {
      id: `${type}-${idx}`,
      type,
      title: def.name,
      visible: true,
      collapsed: false,
      paneHeight: def.paneHeight,
      placement: def.defaultPlacement,
      order: idx,
      settings: def.defaultSettings(),
    };
  });
}

function makeStamp(overrides = {}) {
  return {
    generation: 0,
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    intervalMs: INTERVAL,
    seriesRevision: 10,
    nonTailRevision: 2,
    resetEpoch: 0,
    settingsRevision: 1,
    rangeFrom: 0,
    rangeTo: 100,
    timeBucket: 0,
    ...overrides,
  };
}

test("#295: IndicatorPrepareCache supports peek/store and classifies hit, tail, non-tail, and cold invalidations", () => {
  const cache = new IndicatorPrepareCache();
  const instance = { id: "rsi-1" };
  const series = { revision: 10, nonTailRevision: 2, resetEpoch: 0 };
  const baseKey = {
    definitionType: "rsi",
    instance,
    series,
    rangeFrom: 0,
    rangeTo: 100,
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    intervalMs: INTERVAL,
    generation: 1,
    nonTailRevision: 2,
    resetEpoch: 0,
    settingsRevision: 1,
  };

  assert.equal(cache.peek("rsi-1", baseKey), undefined);
  assert.equal(cache.classifyInvalidation("rsi-1", baseKey), "cold");

  const stored = cache.store("rsi-1", baseKey, { series: [1, 2, 3] });
  assert.equal(cache.peek("rsi-1", baseKey), stored);
  assert.equal(cache.classifyInvalidation("rsi-1", baseKey), "hit");

  series.revision = 11;
  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey }), "tail");

  series.revision = 12;
  series.nonTailRevision = 3;
  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey, nonTailRevision: 3 }), "non-tail");

  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey, series: { revision: 13, nonTailRevision: 3, resetEpoch: 0 } }), "cold");
  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey, resetEpoch: 1 }), "cold");
  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey, generation: 2 }), "cold");
  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey, settingsRevision: 2 }), "cold");
  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey, market: "BINANCE_FUTURES:ethusdt" }), "cold");
  assert.equal(cache.classifyInvalidation("rsi-1", { ...baseKey, timeframe: "5m" }), "cold");
});

test("#295: prewarmPreparedData achieves 0 cache misses on draw and matches sync prepared output", () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const series = makeSeries(120);
  const view = makeFakeView();
  const ctx = makeFakeCtx();
  const chart = { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: INTERVAL };
  const range = [20, 120];

  const managerPrewarm = new IndicatorManager({
    ownerDocument: { dispatchEvent: () => true },
    root: {},
    initial: makeInstances(["rsi", "atr", "keltner-channels"]),
    onChange() {},
    onLayoutChange() {},
    onInvalidate() {},
    getChartContext: () => chart,
  });

  const prewarm = managerPrewarm.prewarmPreparedData(view, series, range, { budgetMs: 100 });
  assert.equal(prewarm.prepared, 3);
  assert.equal(prewarm.deferred, 0);

  resetPerformanceTelemetry();
  for (const pane of managerPrewarm.getPaneRenders()) {
    pane.draw(ctx, view, series, { top: view.area.top + view.area.height, height: pane.height }, range);
  }
  for (const overlay of managerPrewarm.getPriceOverlayRenders()) {
    overlay.draw(ctx, view, series, { top: view.area.top, height: view.area.height }, range);
  }

  const snap = snapshotPerformanceTelemetry();
  assert.equal(snap.counters["indicator.prepare.cache.miss.rsi"] ?? 0, 0);
  assert.equal(snap.counters["indicator.prepare.cache.miss.atr"] ?? 0, 0);
  assert.equal(snap.counters["indicator.prepare.cache.miss.keltner-channels"] ?? 0, 0);
  assert.equal(snap.counters["indicator.prepare.cache.hit.rsi"], 1);
  assert.equal(snap.counters["indicator.prepare.cache.hit.atr"], 1);
  assert.equal(snap.counters["indicator.prepare.cache.hit.keltner-channels"], 1);

  for (const instance of managerPrewarm.peekInstances()) {
    const def = getIndicatorDefinition(instance.type);
    const syncPrepared = def.prepareData({
      ctx,
      view,
      series,
      rect: { top: 0, height: 100 },
      range,
      instance,
      settings: instance.settings,
      chart,
      requestRefresh() {},
    });
    const cachedPrepared = Reflect.get(managerPrewarm, "preparedDataCache").peek(instance.id, {
      definitionType: def.type,
      instance,
      series,
      rangeFrom: range[0],
      rangeTo: range[1],
      market: chart.market,
      timeframe: chart.timeframe,
      intervalMs: chart.intervalMs,
      generation: 0,
      nonTailRevision: series.nonTailRevision,
      resetEpoch: series.resetEpoch,
      settingsRevision: 0,
      timeBucket: typeof def.prepareCache === "string" ? 0 : Math.floor(Date.now() / Math.max(1, def.prepareCache.maxAgeMs)),
    });
    assert.deepEqual(cachedPrepared, syncPrepared);
  }

  managerPrewarm.dispose();
});

test("#295: prewarmPreparedData defers overflow beyond budget and triggers ChartChange.Data on completion", async () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const series = makeSeries(120);
  const view = makeFakeView();
  const ctx = makeFakeCtx();
  const chart = { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: INTERVAL };
  const range = [0, 120];
  const invalidations = [];

  const manager = new IndicatorManager({
    ownerDocument: { dispatchEvent: () => true },
    root: {},
    initial: makeInstances(["rsi", "atr", "macd"]),
    onChange() {},
    onLayoutChange() {},
    onInvalidate(changes) {
      invalidations.push(changes);
    },
    getChartContext: () => chart,
  });

  let tick = 0;
  const result = manager.prewarmPreparedData(view, series, range, {
    budgetMs: 5,
    now: () => {
      const current = tick;
      tick += 6;
      return current;
    },
  });

  assert.equal(result.prepared, 1);
  assert.equal(result.deferred, 2);
  assert.equal(invalidations.length, 0);

  await result.completed;
  assert.deepEqual(invalidations, [ChartChange.Data]);

  resetPerformanceTelemetry();
  for (const pane of manager.getPaneRenders()) {
    pane.draw(ctx, view, series, { top: view.area.top + view.area.height, height: pane.height }, range);
  }
  const snap = snapshotPerformanceTelemetry();
  assert.equal(snap.counters["indicator.prepare.cache.miss.rsi"] ?? 0, 0);
  assert.equal(snap.counters["indicator.prepare.cache.miss.atr"] ?? 0, 0);
  assert.equal(snap.counters["indicator.prepare.cache.miss.macd"] ?? 0, 0);

  manager.dispose();
});

test("#295: IndicatorPrepareScheduler coalesces requests, aborts superseded jobs, and drops stale completions", async () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const scheduler = new IndicatorPrepareScheduler();
  assert.equal(isCompatibleIndicatorPrepareRevisionStamp(undefined, makeStamp()), false);

  const stampA = makeStamp({ seriesRevision: 10 });
  const stampB = makeStamp({ seriesRevision: 11 });
  let runnerCalls = 0;

  const p1 = scheduler.schedule({
    instanceId: "rsi-0",
    definitionType: "rsi",
    stamp: stampA,
    context: {},
    runner: async () => {
      runnerCalls += 1;
      return "v1";
    },
  });
  const p2 = scheduler.schedule({
    instanceId: "rsi-0",
    definitionType: "rsi",
    stamp: stampA,
    context: {},
    runner: async () => {
      runnerCalls += 1;
      return "v1-dup";
    },
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(runnerCalls, 1);
  assert.equal(r1.status, "applied");
  assert.equal(r2.status, "applied");
  assert.equal(r1.value, "v1");

  let abortedSignal = null;
  let resolveInFlight;
  const inFlight = scheduler.schedule({
    instanceId: "rsi-0",
    definitionType: "rsi",
    stamp: stampA,
    context: {},
    runner: (req) => {
      abortedSignal = req.signal;
      return new Promise((resolve) => {
        resolveInFlight = resolve;
      });
    },
  });

  await Promise.resolve();
  assert.ok(abortedSignal);
  assert.equal(abortedSignal.aborted, false);

  const superseded = scheduler.schedule({
    instanceId: "rsi-0",
    definitionType: "rsi",
    stamp: stampB,
    context: {},
    runner: async () => "v2",
  });

  assert.equal(abortedSignal.aborted, true);
  resolveInFlight("stale-v1");

  const [staleRes, freshRes] = await Promise.all([inFlight, superseded]);
  assert.equal(staleRes.status, "stale");
  assert.equal(freshRes.status, "applied");
  assert.equal(freshRes.value, "v2");

  const staleReasons = [
    ["live rollover", makeStamp({ seriesRevision: 12 })],
    ["history repair", makeStamp({ nonTailRevision: 3, seriesRevision: 13 })],
    ["replay seek", makeStamp({ resetEpoch: 2, seriesRevision: 14 })],
    ["settings change", makeStamp({ settingsRevision: 9 })],
    ["market switch", makeStamp({ market: "BINANCE_FUTURES:solusdt" })],
  ];

  for (const [, nextStamp] of staleReasons) {
    let release;
    const job = scheduler.schedule({
      instanceId: "rsi-0",
      definitionType: "rsi",
      stamp: stampB,
      context: {},
      runner: () => new Promise((resolve) => {
        release = resolve;
      }),
    });
    await Promise.resolve();
    scheduler.setExpectedStamp("rsi-0", nextStamp);
    release("stale-payload");
    const outcome = await job;
    assert.equal(outcome.status, "stale");
  }

  const snap = snapshotPerformanceTelemetry();
  assert.equal(snap.counters["indicator.prepare.staleDropped.rsi"], 6);
  scheduler.dispose();
});

test("#295: removeIndicator, restore, and dispose cancel pending async prewarm jobs", async () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const series = makeSeries(80);
  const view = makeFakeView();
  const chart = { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: INTERVAL };
  const range = [0, 80];
  const invalidations = [];

  const manager = new IndicatorManager({
    ownerDocument: { dispatchEvent: () => true },
    root: {},
    initial: makeInstances(["rsi", "atr"]),
    onChange() {},
    onLayoutChange() {},
    onInvalidate(changes) {
      invalidations.push(changes);
    },
    getChartContext: () => chart,
  });

  const resolvers = new Map();
  const signals = new Map();
  const runner = (req) => {
    signals.set(req.instanceId, req.signal);
    return new Promise((resolve) => {
      resolvers.set(req.instanceId, resolve);
    });
  };

  const prewarm1 = manager.prewarmPreparedData(view, series, range, { budgetMs: 0, runner });
  await Promise.resolve();
  assert.equal(signals.get("rsi-0")?.aborted, false);
  assert.equal(signals.get("atr-1")?.aborted, false);

  manager.deleteIndicator("rsi-0");
  assert.equal(signals.get("rsi-0")?.aborted, true);
  assert.equal(signals.get("atr-1")?.aborted, false);

  resolvers.get("rsi-0")?.({ stale: true });
  manager.restore(makeInstances(["macd"]));
  assert.equal(signals.get("atr-1")?.aborted, true);
  resolvers.get("atr-1")?.({ stale: true });

  await prewarm1.completed;
  assert.equal(invalidations.filter((c) => c === ChartChange.Data).length, 0);

  const prewarm2 = manager.prewarmPreparedData(view, series, range, { budgetMs: 0, runner });
  await Promise.resolve();
  assert.equal(signals.get("macd-0")?.aborted, false);
  manager.dispose();
  assert.equal(signals.get("macd-0")?.aborted, true);
  resolvers.get("macd-0")?.({ stale: true });
  await prewarm2.completed;
  assert.equal(invalidations.filter((c) => c === ChartChange.Data).length, 0);
});

test("#409: IndicatorPrepareCache.resolveWithTail distinguishes tail-only vs non-tail updates cleanly", () => {
  const cache = new IndicatorPrepareCache(1);
  const series = { revision: 1, nonTailRevision: 1, resetEpoch: 0 };
  const instance = { id: "tail-1", type: "custom-tail", settings: {} };
  const baseKey = {
    definitionType: "custom-tail",
    instance,
    series,
    rangeFrom: 0,
    rangeTo: 50,
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    intervalMs: INTERVAL,
    generation: 0,
    nonTailRevision: 1,
    resetEpoch: 0,
    settingsRevision: 0,
    timeBucket: 0,
  };

  let fullCount = 0;
  let tailCount = 0;
  const r1 = cache.resolveWithTail(
    "tail-1",
    baseKey,
    () => {
      fullCount++;
      return { values: [1, 2], mode: "full" };
    },
    () => {
      tailCount++;
      return { values: [1, 2], mode: "tail" };
    },
  );
  assert.equal(r1.mode, "full");
  assert.equal(fullCount, 1);
  assert.equal(tailCount, 0);

  // Exact hit: neither full nor tail callback invoked.
  const r2 = cache.resolveWithTail("tail-1", { ...baseKey }, () => {
    fullCount++;
    return { values: [], mode: "full" };
  }, () => {
    tailCount++;
    return { values: [], mode: "tail" };
  });
  assert.equal(r2.mode, "hit");
  assert.equal(fullCount, 1);
  assert.equal(tailCount, 0);

  // Tail-only revision bump: updateTail runs while compute full is skipped.
  series.revision = 2;
  const r3 = cache.resolveWithTail(
    "tail-1",
    { ...baseKey },
    () => {
      fullCount++;
      return { values: [], mode: "full" };
    },
    (candidate) => {
      tailCount++;
      return { values: [...candidate.value.values, 3], mode: "tail" };
    },
  );
  assert.equal(r3.mode, "tail");
  assert.deepEqual(r3.value.values, [1, 2, 3]);
  assert.equal(fullCount, 1);
  assert.equal(tailCount, 1);

  // Non-tail revision bump: must bypass tail updater and compute full.
  series.revision = 3;
  series.nonTailRevision = 2;
  const r4 = cache.resolveWithTail(
    "tail-1",
    { ...baseKey, nonTailRevision: 2 },
    () => {
      fullCount++;
      return { values: [10, 20], mode: "full" };
    },
    () => {
      tailCount++;
      return { values: [], mode: "tail" };
    },
  );
  assert.equal(r4.mode, "full");
  assert.deepEqual(r4.value.values, [10, 20]);
  assert.equal(fullCount, 2);
  assert.equal(tailCount, 1);
});
