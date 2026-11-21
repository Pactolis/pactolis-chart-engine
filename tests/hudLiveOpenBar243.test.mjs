import test from "node:test";
import assert from "node:assert/strict";
import { FootprintSeries, isLiveOnlyProvisionalBar } from "../dist/core/model/footprint.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { View } from "../dist/core/engine/view.js";
import { bucketStart } from "../dist/core/time.js";
import { TIMEFRAMES } from "../dist/core/timeframes.js";
import { resolveChartDisplayOptions } from "../dist/core/model/chartDisplayOptions.js";
import { ChartDataPipeline } from "../dist/features/chart/ChartDataPipeline.js";
import { useFakeChartDataSource } from "./support/fakeChartDataSource.mjs";

const MARKET = "BINANCE_FUTURES:btcusdt";
const ETH_MARKET = "BINANCE_FUTURES:ethusdt";
const INTERVAL_12M = TIMEFRAMES.find((tf) => tf.label === "12M").ms;
const INTERVAL_1W = TIMEFRAMES.find((tf) => tf.label === "1w").ms;
const INTERVAL_3D = TIMEFRAMES.find((tf) => tf.label === "3d").ms;
const INTERVAL_1D = TIMEFRAMES.find((tf) => tf.label === "1d").ms;

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise(setImmediate);
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHudContext() {
  const draws = [];
  return {
    canvas: { width: 1200, height: 500 },
    font: "",
    textAlign: "left",
    textBaseline: "top",
    fillStyle: "",
    draws,
    clearRect() {},
    save() {},
    restore() {},
    fillRect() {},
    strokeRect() {},
    fillText(text, x, y) {
      draws.push({ text: String(text), x, y, color: this.fillStyle });
    },
    measureText(text) {
      return { width: String(text).length * 7 };
    },
  };
}

function makeOverlay(ctx, { onHudText, displayOptions, isOpenBarLiveOnly } = {}) {
  const args = Array(22).fill(undefined);
  args[0] = ctx;
  args[12] = onHudText;
  if (displayOptions) args[19] = () => displayOptions;
  if (isOpenBarLiveOnly) args[21] = isOpenBarLiveOnly;
  return new Overlay(...args);
}

function repairMeta(q, overrides = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const watermark = has("watermark") ? overrides.watermark : "100";
  const token = has("authorityToken") ? overrides.authorityToken : "token-243";
  const coveredFrom = has("coveredFrom") ? overrides.coveredFrom : q.from;
  const coveredThrough = has("coveredThrough") ? overrides.coveredThrough : q.to;
  const status = has("status") ? overrides.status : "complete";
  const authority = overrides.authority ?? "provisional";
  const interval = q.interval;
  const meta = {
    schemaVersion: 2,
    generatedAt: q.to,
    degraded: overrides.degraded,
    footprint: { allowed: true, available: overrides.available ?? true },
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: q.reference ?? q.markets?.[0] ?? MARKET,
      authority,
      status,
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      durableThroughId: null,
      projectionThroughId: watermark,
      authorityToken: token,
      reasonCode: overrides.reasonCode ?? null,
    },
  };
  if (overrides.omitRepair !== true && watermark !== null && token && !["gap", "degraded", "error"].includes(status)) {
    meta.repairSnapshot = {
      schemaVersion: 2,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: q.reference ?? q.markets?.[0] ?? MARKET,
      interval,
      priceStep: q.priceStep,
      authority,
      authorityToken: token,
      watermark,
      requestedFrom: q.from,
      requestedTo: q.to,
      coveredFrom,
      coveredThrough,
      bucketFrom: bucketStart(q.from, interval),
      bucketThrough: bucketStart(q.to, interval),
      coverageProof: {
        kind: "resolver-watermark-contiguous-v2",
        authority,
        authorityToken: token,
        projectionThroughId: watermark,
        requestedFrom: q.from,
        requestedTo: q.to,
        coveredFrom,
        coveredThrough,
        watermarkComplete: true,
      },
    };
  }
  return meta;
}

function makeHistoryBar(startTime, { open = 87_608.3, high = 97_932.1, low = 55_126.7, close = 57_996.9, volume = 250_000, delta = 12_500, count = 1_247_050_078, completeness = "complete", sources = ["history"] } = {}) {
  return {
    startTime,
    open,
    high,
    low,
    close,
    volume,
    delta,
    count,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells: new Map([[57_990, { priceBin: 57_990, buyVol: volume / 2 + delta / 2, sellVol: volume / 2 - delta / 2, count, buyCount: Math.ceil(count / 2), sellCount: Math.floor(count / 2), liquidationBuyVol: 0, liquidationSellVol: 0 }]]),
    hasRef: true,
    completeness,
    sources,
    updatedAt: startTime + 1000,
    cellRevision: 0,
  };
}

function makePipelineHarness(fetchHistory, opts = {}) {
  const tradeSubs = new Map();
  let sessionCb = null;
  let readinessCb = null;
  const reporterEvents = [];
  const degraded = [];
  const services = {
    subscribeToTrades(market, cb) {
      let set = tradeSubs.get(market);
      if (!set) tradeSubs.set(market, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    ...(opts.useReadiness
      ? { subscribeToTradeMarketReadiness(cb) { readinessCb = cb; return () => { readinessCb = null; }; } }
      : { subscribeToTradeSessions(cb) { sessionCb = cb; return () => { sessionCb = null; }; } }),
    fetchHistory,
    fetchPriceStep: async () => 10,
    fetchPricePrecision: async () => 1,
    triggerAutoSync() {},
    acquirePipelineIntegrityReporter() {
      return {
        report(state, detail) { reporterEvents.push({ state, detail }); },
        dispose() {},
      };
    },
  };
  const pipeline = new ChartDataPipeline({
    market: opts.market ?? MARKET,
    intervalMs: opts.intervalMs ?? INTERVAL_12M,
    priceStep: 10,
    pricePrecision: 1,
    services,
    scheduler: { request(cb) { cb(); return 0; }, cancel() {} },
    onDataDegraded: (value, detail) => degraded.push({ value, detail }),
  });
  return {
    pipeline,
    reporterEvents,
    degraded,
    emitTrade(trade) {
      const m = trade.market ?? pipeline.market;
      for (const cb of tradeSubs.get(m) ?? []) cb(trade);
    },
    emitSession(session) { sessionCb?.(session); },
    emitReadiness(readiness) { readinessCb?.(readiness); },
  };
}

test("isLiveOnlyProvisionalBar identifies WS-only provisional bars without affecting history or closed bars", () => {
  assert.equal(isLiveOnlyProvisionalBar({ completeness: "provisional", sources: ["live"] }), true);
  assert.equal(isLiveOnlyProvisionalBar({ completeness: "provisional", sources: ["recovery"] }), true);
  assert.equal(isLiveOnlyProvisionalBar({ completeness: "provisional", sources: [] }), true);
  assert.equal(isLiveOnlyProvisionalBar({ completeness: "provisional", sources: ["history"] }), false);
  assert.equal(isLiveOnlyProvisionalBar({ completeness: "provisional", sources: ["history", "live"] }), false);
  assert.equal(isLiveOnlyProvisionalBar({ completeness: "partial", sources: ["live"] }), false);
  assert.equal(isLiveOnlyProvisionalBar({ completeness: "complete", sources: ["history"] }), false);
});

test("HUD marks live-only open bar consistently on canvas (wide + narrow) and data-hud, leaving closed bars untouched", () => {
  const now = Date.now();
  const openStart = bucketStart(now, INTERVAL_12M);
  const closedStart = bucketStart(openStart - 1, INTERVAL_12M);
  const series = new FootprintSeries({ intervalMs: INTERVAL_12M, priceStep: 10, referenceMarket: MARKET, pricePrecision: 1 });
  series.loadBars([makeHistoryBar(closedStart, { open: 42_000, high: 99_000, low: 38_000, close: 93_500, count: 1_270_402_283 })]);
  series.addTrade({ id: "1", time: now - 500, price: 57_996.9, qty: 0.008, isBuy: true, market: MARKET, source: "live", receivedAt: now - 400 });
  series.addTrade({ id: "2", time: now - 200, price: 57_996.9, qty: 0.008, isBuy: true, market: MARKET, source: "live", receivedAt: now - 100 });

  assert.equal(series.length, 2);
  const openBar = series.at(1);
  assert.equal(openBar.startTime, openStart);
  assert.equal(openBar.completeness, "provisional");
  assert.deepEqual(openBar.sources, ["live"]);

  // Wide layout: default open bar is marked [Live only] and ≈ on both canvas and onHudText.
  let hudText = null;
  const wideCtx = makeHudContext();
  const wideView = new View();
  wideView.area = { left: 0, top: 0, width: 1200, height: 500 };
  wideView.colWidth = 20;
  wideView.offsetX = 100;
  const overlay = makeOverlay(wideCtx, {
    onHudText: (text) => { hudText = text; },
    isOpenBarLiveOnly: (bar) => bar.startTime === openStart,
  });
  overlay.renderAnnotations(wideView, series, { x: 0, y: 0, visible: false }, [0, 2], ["hud"]);

  assert.ok(hudText?.startsWith("[Live only] "), `expected [Live only] prefix in data-hud, got: ${hudText}`);
  assert.ok(hudText.includes("Vol ≈$928"), `expected ≈ Vol in data-hud, got: ${hudText}`);
  assert.ok(hudText.includes("Δ ≈+$928"), `expected ≈ Δ in data-hud, got: ${hudText}`);
  assert.ok(hudText.includes("Trades ≈2"), `expected ≈ Trades in data-hud, got: ${hudText}`);
  const wideJoined = wideCtx.draws.map((d) => d.text).join(" ");
  assert.ok(wideJoined.includes("[Live only]"), `expected [Live only] on wide canvas, got: ${wideJoined}`);
  assert.ok(wideJoined.includes("Vol ≈$928"), `expected Vol ≈$928 on wide canvas, got: ${wideJoined}`);
  assert.ok(wideJoined.includes("Trades ≈2"), `expected Trades ≈2 on wide canvas, got: ${wideJoined}`);

  // Narrow layout (phone): [Live only] and ≈ stay present on canvas rows too.
  const narrowCtx = makeHudContext();
  const narrowView = new View();
  narrowView.area = { left: 0, top: 0, width: 320, height: 500 };
  let narrowHudText = null;
  const narrowOverlay = makeOverlay(narrowCtx, {
    onHudText: (text) => { narrowHudText = text; },
    displayOptions: resolveChartDisplayOptions({
      labels: { trades: "İşlemler", volume: "Hacim", range: "Aralık", change: "Değişim" },
      numberLocale: "tr-TR",
    }),
    isOpenBarLiveOnly: (bar) => bar.startTime === openStart,
  });
  narrowOverlay.renderAnnotations(narrowView, series, { x: 0, y: 0, visible: false }, [0, 2], ["hud"]);
  assert.ok(narrowHudText?.startsWith("[Yalnızca canlı] "), `expected Turkish live-only tag, got: ${narrowHudText}`);
  const narrowJoined = narrowCtx.draws.map((d) => d.text).join(" ");
  assert.ok(narrowJoined.includes("[Yalnızca canlı]"), `expected [Yalnızca canlı] on narrow canvas, got: ${narrowJoined}`);
  assert.ok(narrowJoined.includes("Hacim ≈$928"), `expected Hacim ≈$928 on narrow canvas, got: ${narrowJoined}`);
  assert.ok(narrowJoined.includes("İşlemler ≈2"), `expected İşlemler ≈2 on narrow canvas, got: ${narrowJoined}`);

  // Hovering closed bar (index 0) must NOT show [Live only] or ≈.
  const hoverCtx = makeHudContext();
  let hoverHudText = null;
  const hoverOverlay = makeOverlay(hoverCtx, {
    onHudText: (text) => { hoverHudText = text; },
    isOpenBarLiveOnly: (bar) => bar.startTime === openStart,
  });
  const closedX = wideView.xOfIndex(0) + wideView.colWidth / 2;
  hoverOverlay.renderInteraction(wideView, series, { x: closedX, y: 100, visible: true }, [0, 2], ["hud"]);
  assert.equal(hoverHudText?.includes("[Live only]"), false, `closed bar hover must not show live-only: ${hoverHudText}`);
  assert.equal(hoverHudText?.includes("≈"), false, `closed bar hover must not show ≈: ${hoverHudText}`);
  assert.ok(hoverHudText?.includes("Trades 1270402283"), `closed bar hover must keep exact trade count: ${hoverHudText}`);
  assert.equal(hoverCtx.draws.some((d) => d.text.includes("[Live only]") || d.text.includes("≈")), false);
});

test("BTC 12M WS-before-history repro: stays live-only even after OHLC-only seed, then reconciles snapshot + tail without double-count", async (t) => {
  const now = Date.now();
  const openStart = bucketStart(now, INTERVAL_12M);
  const prevStart = bucketStart(openStart - 1, INTERVAL_12M);
  const repairReq = deferred();
  const phase1Req = deferred();

  useFakeChartDataSource(t, {
    history: async (query) => {
      if (query.includeFootprint === false) {
        return phase1Req.promise;
      }
      return {
        bars: [makeHistoryBar(prevStart)],
        meta: { footprint: { allowed: true, available: true } },
      };
    },
  });

  const h = makePipelineHarness((q) => {
    repairReq.query = q;
    return repairReq.promise;
  });

  try {
    h.emitSession({ generation: 1, epoch: 1, session: "ws-1", boundaryAt: now - 1000 });
    h.emitTrade({ id: "99", time: now - 900, price: 57_996.9, qty: 0.008, isBuy: true, market: MARKET, source: "live", receivedAt: now - 890 });
    h.emitTrade({ id: "100", time: now - 800, price: 57_996.9, qty: 0.008, isBuy: true, market: MARKET, source: "live", receivedAt: now - 790 });
    h.emitTrade({ id: "101", time: now - 500, price: 58_010.0, qty: 0.01, isBuy: true, market: MARKET, source: "live", receivedAt: now - 490 });

    const liveOnlyBar = h.pipeline.series.get(openStart);
    assert.ok(liveOnlyBar);
    assert.equal(liveOnlyBar.count, 3);
    assert.equal(h.pipeline.isOpenBarLiveOnly(liveOnlyBar, { now }), true);
    assert.deepEqual(h.pipeline.getOpenBucketReadiness(liveOnlyBar, { now }), {
      market: MARKET,
      timeframe: "12M",
      intervalMs: INTERVAL_12M,
      bucket: openStart,
      generation: 0,
      status: "live-only",
      source: "live-only",
    });

    // Even if OHLC-only seed runs reassertOHLC while repair is still pending,
    // volume/count are still live-only, so readiness MUST stay live-only.
    h.pipeline.applyLiveBarSeed(
      [makeHistoryBar(openStart, { open: 87_608.3, high: 97_932.1, low: 55_126.7, close: 58_010.0, volume: 250_000, count: 1_247_050_078 })],
      { market: MARKET, intervalMs: INTERVAL_12M, from: openStart, observedAt: now - 400 },
    );
    assert.equal(h.pipeline.series.get(openStart)?.count, 3, "reassertOHLC leaves live-only count untouched");
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(openStart), { now }), true);

    // Resolve Phase 1 / loadHistory while repair is still delayed: still live-only!
    const historyPromise = h.pipeline.loadHistory({ from: prevStart, to: now, twoPhase: true });
    phase1Req.resolve({
      bars: [makeHistoryBar(prevStart)],
      meta: {
        candleCoverage: {
          schemaVersion: 1,
          source: "binance-klines",
          instrument: MARKET,
          ownership: "snapshot",
          status: "verified",
          requestedFrom: prevStart,
          requestedTo: now,
          snapshotAt: now,
          closedThrough: prevStart + INTERVAL_12M - 1,
          reasonCode: null,
        },
      },
    });
    await historyPromise;
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(openStart), { now }), true);

    // Now repair snapshot arrives with watermark=100 (covers id 99 and 100; tail id 101 must apply once).
    repairReq.query.onMeta?.(repairMeta(repairReq.query, { watermark: "100" }));
    repairReq.resolve([
      makeHistoryBar(openStart, {
        open: 87_608.3,
        high: 97_932.1,
        low: 55_126.7,
        close: 57_996.9,
        volume: 100,
        delta: 20,
        count: 1_247_050_078,
      }),
    ]);
    await tick();

    const repaired = h.pipeline.series.get(openStart);
    assert.ok(repaired);
    assert.equal(repaired.open, 87_608.3);
    assert.equal(repaired.high, 97_932.1);
    assert.equal(repaired.low, 55_126.7);
    assert.equal(repaired.close, 58_010.0);
    assert.equal(repaired.count, 1_247_050_079, "snapshot (through id 100) + tail (id 101) without double counting");
    assert.equal(repaired.volume, 100.01);
    assert.equal(h.pipeline.isOpenBarLiveOnly(repaired, { now }), false);
    assert.equal(h.pipeline.getOpenBucketReadiness(repaired, { now }).status, "verified");
    assert.equal(h.pipeline.getOpenBucketReadiness(repaired, { now }).source, "repair");
  } finally {
    h.pipeline.dispose();
  }
});

test("history-first open bucket stays verified even while a background loadHistory is in flight", async (t) => {
  const now = Date.now();
  const openStart = bucketStart(now, INTERVAL_12M);
  const bgLoad = deferred();

  useFakeChartDataSource(t, {
    history: async () => bgLoad.promise,
  });

  const h = makePipelineHarness(() => new Promise(() => {}));
  try {
    const applied = h.pipeline.applyLiveBarSeed(
      [makeHistoryBar(openStart, { count: 1_247_050_078 })],
      { market: MARKET, intervalMs: INTERVAL_12M, from: openStart, observedAt: now },
    );
    assert.deepEqual(applied, [openStart]);
    const bar = h.pipeline.series.get(openStart);
    assert.equal(h.pipeline.isOpenBarLiveOnly(bar, { now }), false);

    // Start an unrelated background loadHistory (e.g. older bars); verified open bar must remain verified.
    const loadPromise = h.pipeline.loadHistory({ from: openStart - INTERVAL_12M * 2, to: openStart - 1 });
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(openStart), { now }), false);

    bgLoad.resolve({ bars: [], meta: {} });
    await loadPromise;
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(openStart), { now }), false);
  } finally {
    h.pipeline.dispose();
  }
});

test("repair failure, degraded fallback, and retry transition HUD readiness accurately", async (t) => {
  const now = Date.now();
  const openStart = bucketStart(now, INTERVAL_1D);
  useFakeChartDataSource(t);

  const retries = [];
  let attempt = 0;
  const h = makePipelineHarness(
    async (q) => {
      attempt++;
      if (attempt === 1) {
        throw new Error("HTTP 503");
      }
      if (attempt === 2) {
        q.onMeta?.({ ...repairMeta(q, { degraded: true, omitRepair: true }) });
        return [makeHistoryBar(openStart, { volume: 50, delta: 10, count: 500 })];
      }
      q.onMeta?.(repairMeta(q, { watermark: "10" }));
      return [makeHistoryBar(openStart, { volume: 50, delta: 10, count: 500 })];
    },
    { intervalMs: INTERVAL_1D },
  );
  h.pipeline.setRecentCoverageRetryScheduler((num, cb) => retries.push({ num, cb }));

  try {
    h.emitSession({ generation: 1, epoch: 1, session: "s1", boundaryAt: now - 1000 });
    h.emitTrade({ id: "11", time: now - 500, price: 60_000, qty: 2, isBuy: true, market: MARKET, source: "live", receivedAt: now - 400 });
    await tick();

    // Attempt 1 failed with HTTP 503 -> bar stays live-only.
    assert.equal(attempt, 1);
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(openStart), { now }), true);
    assert.equal(retries.length, 1);

    // Attempt 2 degraded fallback -> bar completeness becomes "partial".
    assert.equal(retries[0].cb(), true);
    await tick();
    assert.equal(attempt, 2);
    const degradedBar = h.pipeline.series.get(openStart);
    assert.equal(degradedBar.completeness, "partial");
    assert.equal(h.pipeline.getOpenBucketReadiness(degradedBar, { now }).status, "partial");
    assert.equal(retries.length, 2);

    // Attempt 3 succeeds -> bar is verified and complete.
    assert.equal(retries[1].cb(), true);
    await tick();
    assert.equal(attempt, 3);
    const healthyBar = h.pipeline.series.get(openStart);
    assert.equal(healthyBar.completeness, "complete");
    assert.equal(healthyBar.count, 501);
    assert.equal(h.pipeline.getOpenBucketReadiness(healthyBar, { now }).status, "verified");
    assert.equal(h.pipeline.isOpenBarLiveOnly(healthyBar, { now }), false);
  } finally {
    h.pipeline.setRecentCoverageRetryScheduler(null);
    h.pipeline.dispose();
  }
});

test("fatal non-retryable repair error keeps live-only status instead of clearing it", async (t) => {
  const now = Date.now();
  const openStart = bucketStart(now, INTERVAL_1D);
  useFakeChartDataSource(t);

  const h = makePipelineHarness(
    async (q) => {
      q.onMeta?.(repairMeta(q, { watermark: "10" }));
      // Return invalid bar outside range to trigger non-retryable RepairRejection(state: "error").
      return [makeHistoryBar(openStart - 10 * INTERVAL_1D)];
    },
    { intervalMs: INTERVAL_1D },
  );

  try {
    h.emitSession({ generation: 1, epoch: 1, session: "s1", boundaryAt: now - 1000 });
    h.emitTrade({ id: "11", time: now - 500, price: 60_000, qty: 1, isBuy: true, market: MARKET, source: "live", receivedAt: now - 400 });
    await tick();

    const bar = h.pipeline.series.get(openStart);
    assert.ok(bar);
    assert.equal(h.pipeline.liveBootstrapReconciled, false);
    assert.equal(h.pipeline.isOpenBarLiveOnly(bar, { now }), true);
  } finally {
    h.pipeline.dispose();
  }
});

test("readiness is scoped to market + timeframe + bucket + generation and ignores stale responses", async (t) => {
  const now = Date.now();
  useFakeChartDataSource(t);

  const pendingRepairs = [];
  const h = makePipelineHarness(
    (q) => {
      const d = deferred();
      pendingRepairs.push({ q, ...d });
      return d.promise;
    },
    { intervalMs: INTERVAL_1W, useReadiness: true },
  );

  try {
    const weekStart = bucketStart(now, INTERVAL_1W);
    h.emitReadiness({ market: MARKET, generation: 1, epoch: 1, session: "s1", acknowledgedAt: now, transportGeneration: 1, boundaryAt: now - 1000 });
    h.emitTrade({ id: "10", time: now - 500, price: 60_000, qty: 1, isBuy: true, market: MARKET, source: "live", receivedAt: now - 400 });
    assert.equal(pendingRepairs.length, 1);

    // Reconcile 1W (gen 0).
    pendingRepairs[0].q.onMeta?.(repairMeta(pendingRepairs[0].q, { watermark: "9" }));
    pendingRepairs[0].resolve([makeHistoryBar(weekStart, { count: 900 })]);
    await tick();
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(weekStart), { now }), false);

    // Switch to 3D -> generation bumps, series clears, new repair starts.
    await h.pipeline.changeConfig({ intervalMs: INTERVAL_3D });
    const threeDayStart = bucketStart(now, INTERVAL_3D);
    h.emitTrade({ id: "20", time: now - 300, price: 60_100, qty: 1, isBuy: true, market: MARKET, source: "live", receivedAt: now - 200 });
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(threeDayStart), { now }), true);
    const stale3dRepair = pendingRepairs.at(-1);

    // Rapidly switch to 12M before 3D resolves.
    await h.pipeline.changeConfig({ intervalMs: INTERVAL_12M });
    const liveNow = Date.now() + 50;
    const yearStart = bucketStart(liveNow, INTERVAL_12M);
    h.emitTrade({ id: "30", time: liveNow, price: 60_200, qty: 1, isBuy: true, market: MARKET, source: "live", receivedAt: liveNow });
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(yearStart), { now: liveNow }), true);

    // Resolving stale 3D repair must NOT corrupt or verify 12M!
    stale3dRepair.q.onMeta?.(repairMeta(stale3dRepair.q, { watermark: "20" }));
    stale3dRepair.resolve([makeHistoryBar(threeDayStart, { count: 777 })]);
    await tick();
    assert.equal(h.pipeline.series.get(yearStart)?.count, 1);
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(yearStart), { now: liveNow }), true);

    // Resolving current 12M repair verifies 12M.
    const current12mRepair = pendingRepairs.at(-1);
    current12mRepair.q.onMeta?.(repairMeta(current12mRepair.q, { watermark: "29" }));
    current12mRepair.resolve([makeHistoryBar(yearStart, { count: 1_247_050_078 })]);
    await tick();
    assert.equal(h.pipeline.series.get(yearStart)?.count, 1_247_050_079);
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(yearStart), { now: liveNow }), false);

    // Market mismatch on scope query cannot falsely report verified.
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(yearStart), { market: ETH_MARKET, now: liveNow }), true);
  } finally {
    h.pipeline.dispose();
  }
});

test("zero-history-trades repair bucket with tail trades and continuous rollover after reconciliation are verified", async (t) => {
  const now = Date.now();
  const currentBucket = bucketStart(now, INTERVAL_1D);
  const nextBucket = currentBucket + INTERVAL_1D;
  useFakeChartDataSource(t);

  const h = makePipelineHarness(
    async (q) => {
      q.onMeta?.(repairMeta(q, { watermark: "100" }));
      return [];
    },
    { intervalMs: INTERVAL_1D },
  );

  try {
    h.emitSession({ generation: 1, epoch: 1, session: "s1", boundaryAt: now - 1000 });
    h.emitTrade({ id: "101", time: now - 500, price: 60_000, qty: 1, isBuy: true, market: MARKET, source: "live", receivedAt: now - 400 });
    assert.equal(h.pipeline.isOpenBarLiveOnly(h.pipeline.series.get(currentBucket), { now }), true);
    await tick();

    // Snapshot had 0 trades <= 100 in currentBucket, tail id 101 proved the whole bucket.
    const bar = h.pipeline.series.get(currentBucket);
    assert.ok(bar);
    assert.equal(bar.count, 1);
    assert.equal(h.pipeline.series.isRepairOwned(currentBucket), true);
    assert.equal(h.pipeline.isOpenBarLiveOnly(bar, { now }), false);

    // Continuous rollover into nextBucket while reconciled must NOT be marked live-only.
    h.emitTrade({ id: "102", time: nextBucket + 500, price: 60_100, qty: 1, isBuy: true, market: MARKET, source: "live", receivedAt: nextBucket + 600 });
    const nextBar = h.pipeline.series.get(nextBucket);
    assert.ok(nextBar);
    assert.equal(h.pipeline.isOpenBarLiveOnly(nextBar, { now: nextBucket + 1000 }), false);
    assert.equal(h.pipeline.getOpenBucketReadiness(nextBar, { now: nextBucket + 1000 }).source, "live-rollover");
  } finally {
    h.pipeline.dispose();
  }
});
