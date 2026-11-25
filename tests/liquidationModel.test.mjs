import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  checkSeamAndDetectShift,
  createLiquidationModel,
  decodeF32LeBase64,
  encodeF32LeBase64,
} from "../dist/core/analysis/liquidationModel.js";
import {
  drawLiquidationProfileOverlay,
  liquidationProfileIndicatorDefinition,
  prepareLiquidationProfile,
} from "../dist/features/indicators/builtins/liquidationProfile.js";
import { configureIndicatorDataSource } from "../dist/features/indicators/indicatorDataSource.js";
import { configureChartLocale } from "../dist/core/chartLocale.js";

function setupTurkishLocale() {
  configureChartLocale({
    locale: () => "tr-TR",
    timeZone: () => "Europe/Istanbul",
    translate: (key) => key,
    onLocaleChange: () => () => {},
  });
}

function canvasRecorder() {
  const fills = [];
  const texts = [];
  const strokes = [];
  const state = [];
  const canvas = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    save() {
      state.push({
        globalAlpha: this.globalAlpha,
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
      });
    },
    restore() {
      Object.assign(this, state.pop() ?? { globalAlpha: 1 });
    },
    rect() {},
    clip() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    setLineDash() {},
    stroke() { strokes.push({ color: this.strokeStyle, lineWidth: this.lineWidth }); },
    roundRect() {},
    fill() {},
    fillText(text, x, y) { texts.push({ text: String(text), x, y, color: this.fillStyle }); },
    measureText(text) { return { width: String(text).length * 6 }; },
    fillRect(x, y, width, height) {
      fills.push({ x, y, width, height, alpha: this.globalAlpha, color: this.fillStyle });
    },
  };
  return { canvas, fills, texts, strokes };
}

function makeCtx(canvas, settingsOverrides = {}, crosshair = undefined, binanceLast = 74_430, market = "BINANCE_FUTURES:btcusdt") {
  return {
    ctx: canvas,
    view: {
      area: { left: 10, top: 20, width: 600, height: 300 },
      yOfPrice: (price) => 20 + ((80_000 - price) / 10_000) * 300,
    },
    series: {
      listReadonly: () => [{ close: binanceLast }],
    },
    rect: { top: 20, height: 300 },
    range: [0, 1],
    instance: { id: "lp-1", type: "liquidation-profile", title: "Liquidation Profile", visible: true, paneId: "p1", order: 0 },
    settings: { ...liquidationProfileIndicatorDefinition.defaultSettings(), ...settingsOverrides },
    chart: { market, timeframe: "5m", intervalMs: 300_000 },
    crosshair,
    requestRefresh: () => {},
  };
}

const DEFAULT_PARAMS = {
  lev: [5, 10, 20, 25, 50, 100],
  lw: [0.25, 0.30, 0.20, 0.10, 0.10, 0.05],
  mmr: 0.004,
  bw: 0.001,
  p0: 80,
  nbk: 450,
};

function makeEmptyModelState(overrides = {}) {
  const nbk = overrides.params?.nbk ?? DEFAULT_PARAMS.nbk;
  const zeros = new Array(nbk).fill(0);
  const now = Date.now();
  return {
    schemaVersion: 1,
    modelVersion: 1,
    symbol: "BTCUSDT",
    params: { ...DEFAULT_PARAMS, ...overrides.params },
    asOf: overrides.asOf ?? now - 600_000,
    lastOi: overrides.lastOi ?? 100,
    longb: overrides.longb ?? encodeF32LeBase64(zeros),
    shortb: overrides.shortb ?? encodeF32LeBase64(zeros),
    v1: overrides.v1 ?? {
      passed: true,
      tested: true,
      fallingBp: 12.5,
      risingBp: 11.2,
      bestPlaceboBp: 2.1,
      days: 190,
    },
    seam: overrides.seam ?? [
      { t: (overrides.asOf ?? now - 600_000) - 300_000, h: 101, l: 99, c: 100, v: 1000, tb: 500, oi: 100 },
      { t: overrides.asOf ?? now - 600_000, h: 101, l: 99, c: 100, v: 1000, tb: 500, oi: 100 },
    ],
  };
}

test("encodeF32LeBase64 and decodeF32LeBase64 roundtrip float32 LE values", () => {
  const input = [0, 1.5, 12345.25, 0.000125];
  const encoded = encodeF32LeBase64(input);
  const decoded = decodeF32LeBase64(encoded);
  assert.equal(decoded.length, input.length);
  for (let i = 0; i < input.length; i += 1) {
    assert.ok(Math.abs(decoded[i] - input[i]) <= Math.abs(input[i]) * 1e-6 + 1e-12);
  }
});

test("step(bar) opens, liquidates, and proportionally scales negative dOI", () => {
  const state = makeEmptyModelState({ lastOi: 100 });
  const model = createLiquidationModel(state);

  // Bar 1: dOI = +100, b = 0.6 -> 60 long coins, 40 short coins
  const r1 = model.step({ t: 1_709_251_200_000, h: 101, l: 99, c: 100, v: 1000, tb: 600, oi: 200 });
  assert.equal(r1.dOi, 100);
  assert.equal(r1.liqL, 0);
  assert.equal(r1.liqS, 0);

  let book = model.book();
  let sumL = book.longUsd.reduce((a, b) => a + b, 0) / book.lastClose;
  let sumS = book.shortUsd.reduce((a, b) => a + b, 0) / book.lastClose;
  assert.ok(Math.abs(sumL - 60) < 1e-9);
  assert.ok(Math.abs(sumS - 40) < 1e-9);

  // Bar 2: spike down to l=89 liquidates 10x/20x/25x/50x/100x longs (liq >= 90.4), leaving 5x (0.25 of 60 = 15)
  const r2 = model.step({ t: 1_709_251_500_000, h: 100.2, l: 89, c: 95, v: 1000, tb: 400, oi: 200 });
  assert.ok(Math.abs(r2.liqL - 45) < 1e-6, `expected 45 liquidated long coins, got ${r2.liqL}`);
  assert.equal(r2.liqS, 0);

  // Bar 3: dOI = -20 (after 0 liq on this bar) reduces both longb and shortb proportionally
  const r3 = model.step({ t: 1_709_251_800_000, h: 96, l: 94, c: 95, v: 1000, tb: 500, oi: 180 });
  assert.equal(r3.dOi, -20);
  book = model.book();
  sumL = book.longUsd.reduce((a, b) => a + b, 0) / book.lastClose;
  sumS = book.shortUsd.reduce((a, b) => a + b, 0) / book.lastClose;
  // Remaining long = 15 - 10 = 5; remaining short = 40 - 10 = 30
  assert.ok(Math.abs(sumL - 5) < 1e-6);
  assert.ok(Math.abs(sumS - 30) < 1e-6);
});

test("dynamic bucket expansion grows below p0 and above nbk", () => {
  const state = makeEmptyModelState({
    params: { ...DEFAULT_PARAMS, p0: 100, nbk: 10 },
    lastOi: 100,
  });
  const model = createLiquidationModel(state);
  const initialP0 = model.p0;
  const initialNbk = model.nbk;

  // Step with price=500 -> far above 100 * exp(10 * 0.001) and far below 100 for 5x long?
  // 5x long liq = 500 * (1 - 0.2 + 0.004) = 402; 5x short liq = 500 * 1.196 = 598 -> expands upper!
  model.step({ t: 1_709_251_200_000, h: 505, l: 495, c: 500, v: 100, tb: 50, oi: 200 });
  assert.ok(model.nbk > initialNbk, "expected upper bucket expansion");

  // Now step with price=20 -> 5x long liq = 20 * 0.804 = 16.08 < p0=100 -> expands lower!
  model.step({ t: 1_709_251_500_000, h: 21, l: 19, c: 20, v: 100, tb: 50, oi: 300 });
  assert.ok(model.p0 < initialP0, "expected lower bucket expansion (p0 decreased)");
  const book = model.book();
  assert.equal(book.centers.length, model.nbk);
  assert.equal(book.longUsd.length, model.nbk);
  assert.equal(book.shortUsd.length, model.nbk);
});

test("golden fixture matches BE #551 math within < 1e-5 relative error", () => {
  // Exact BE #551 parameters and 4-bar test from services/market-data/src/liqmap/model.rs
  // + snapshot resume parity check
  const bw = 0.001;
  const mmr = 0.004;
  const lev = [5, 10, 20, 25, 50, 100];
  const lw = [0.25, 0.30, 0.20, 0.10, 0.10, 0.05];
  const p0 = 89 * 0.3;
  const pHi = 101 * 3.0;
  const nbk = Math.floor(Math.log(pHi / p0) / bw) + 2;

  const state = {
    schemaVersion: 1,
    modelVersion: 1,
    symbol: "BTCUSDT",
    params: { lev, lw, mmr, bw, p0, nbk },
    asOf: 1_709_251_200_000,
    lastOi: 100,
    longb: new Array(nbk).fill(0),
    shortb: new Array(nbk).fill(0),
    v1: { passed: true, tested: true, fallingBp: 10, risingBp: 10, bestPlaceboBp: 2, days: 200 },
    seam: [{ t: 1_709_251_200_000, h: 101, l: 99, c: 100, v: 1000, tb: 600, oi: 100 }],
  };

  const sim = createLiquidationModel(state);
  // Mirror BE #551 step_bars with exact dOI sequence: [100, 0, -10]
  sim.stepWithDoi({ t: 1_709_251_200_000, h: 101, l: 99, c: 100, v: 1000, tb: 600, oi: 100 }, 100);
  const r2 = sim.stepWithDoi({ t: 1_709_251_500_000, h: 100.2, l: 89, c: 95, v: 1000, tb: 400, oi: 200 }, 0);
  sim.stepWithDoi({ t: 1_709_251_800_000, h: 96, l: 94, c: 95, v: 1000, tb: 500, oi: 200 }, -10);

  // Analytical BE #551 values:
  // After bar 0: 60 long coins (5x:15, 10x:18, 20x:12, 25x:6, 50x:6, 100x:3), 40 short coins
  // After bar 1 (l=89): 10x..100x longs liquidated = 45 coins; remaining long = 15 coins, short = 40 coins
  // After bar 2 (dOI=-10, b=0.5): 5 coins removed from long -> 10 coins; 5 from short -> 35 coins
  // At lastClose=95: longUsd = 10 * 95 = 950, shortUsd = 35 * 95 = 3325
  assert.ok(Math.abs(r2.liqL - 45) / 45 < 1e-5);
  const book = sim.book();
  const totalLongUsd = book.longUsd.reduce((a, b) => a + b, 0);
  const totalShortUsd = book.shortUsd.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(totalLongUsd - 950) / 950 < 1e-5);
  assert.ok(Math.abs(totalShortUsd - 3325) / 3325 < 1e-5);

  // Now encode into f32 LE base64 (like BE #551 storage.rs) and resume in a second model instance
  const resumedState = {
    ...state,
    asOf: 1_709_251_800_000,
    lastOi: 190,
    longb: encodeF32LeBase64(book.longUsd),
    shortb: encodeF32LeBase64(book.shortUsd),
    seam: [{ t: 1_709_251_800_000, h: 96, l: 94, c: 95, v: 1000, tb: 500, oi: 190 }],
  };
  const resumed = createLiquidationModel(resumedState);
  const resumedBook = resumed.book();
  const resumedLongUsd = resumedBook.longUsd.reduce((a, b) => a + b, 0);
  const resumedShortUsd = resumedBook.shortUsd.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(resumedLongUsd - totalLongUsd) / totalLongUsd < 1e-5);
  assert.ok(Math.abs(resumedShortUsd - totalShortUsd) / totalShortUsd < 1e-5);
});

test("checkSeamAndDetectShift detects exact match, 5m shift (+1/-1), and mismatch", () => {
  const baseT = 1_709_251_200_000;
  const seam = Array.from({ length: 20 }, (_, i) => ({
    t: baseT + i * 300_000,
    h: 101,
    l: 99,
    c: 100 + i * 0.1,
    v: 1000,
    tb: 500,
    oi: 1000 + i * 10,
  }));

  // 1. Exact match
  const okRes = checkSeamAndDetectShift(seam, seam);
  assert.equal(okRes.status, "ok");
  assert.equal(okRes.shiftSlots, 0);

  // 2. +1 slot (5m) OI shift in REST bars
  const shiftedRest = seam.map((bar, i) => ({
    ...bar,
    oi: i === 0 ? 990 : seam[i - 1].oi,
  }));
  const shiftRes = checkSeamAndDetectShift(seam, shiftedRest);
  assert.equal(shiftRes.status, "shifted");
  assert.equal(shiftRes.shiftSlots, 1);
  assert.equal(shiftRes.correctedBars[0].oi, seam[0].oi);

  // 3. Price mismatch -> seam-mismatch
  const badPriceRest = seam.map((bar) => ({ ...bar, c: bar.c * 1.5 }));
  const mismatchRes = checkSeamAndDetectShift(seam, badPriceRest);
  assert.equal(mismatchRes.status, "seam-mismatch");
});

test("8,640-bar (30d) forward replay completes well under 500ms", () => {
  const state = makeEmptyModelState({
    params: { ...DEFAULT_PARAMS, p0: 50_000, nbk: 1200 },
    lastOi: 50_000,
  });
  const model = createLiquidationModel(state);
  const bars = Array.from({ length: 8_640 }, (_, i) => {
    const price = 70_000 + Math.sin(i * 0.05) * 3_000;
    return {
      t: 1_709_251_200_000 + (i + 1) * 300_000,
      h: price + 80,
      l: price - 80,
      c: price,
      v: 500,
      tb: i % 2 === 0 ? 280 : 220,
      oi: 50_000 + Math.sin(i * 0.1) * 500,
    };
  });

  const t0 = performance.now();
  for (const bar of bars) {
    model.step(bar);
  }
  const book = model.book();
  const elapsedMs = performance.now() - t0;

  assert.ok(book.centers.length >= 1200);
  assert.ok(elapsedMs < 500, `expected 8,640-bar replay < 500ms, got ${elapsedMs.toFixed(2)}ms`);
});

test("auto source selection, V1 gate, status badges, and model hover readout", () => {
  setupTurkishLocale();

  const now = Date.now();
  const modelState = makeEmptyModelState({
    params: { ...DEFAULT_PARAMS, p0: 65_000, nbk: 300 },
    asOf: now - 3_600_000,
    lastOi: 1000,
    v1: { passed: true, tested: true, fallingBp: 15, risingBp: 12, bestPlaceboBp: 2, days: 200 },
    seam: [{ t: now - 3_600_000, h: 74_500, l: 74_300, c: 74_430, v: 1000, tb: 600, oi: 1000 }],
  });
  const replayBars = [
    { t: now - 3_600_000, h: 74_500, l: 74_300, c: 74_430, v: 1000, tb: 600, oi: 1000 },
    { t: now - 3_300_000, h: 74_600, l: 74_200, c: 74_430, v: 1000, tb: 700, oi: 1200 },
  ];

  // 1. Auto mode falls back to model when HL is unsupported
  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
    requestLiquidationClusters: () => ({ status: "unsupported" }),
    requestLiquidationModel: () => ({
      status: "ready",
      data: { status: "ready", state: modelState, bars: replayBars },
    }),
  });

  const { canvas: c1, fills: f1, texts: t1 } = canvasRecorder();
  const ctx1Pre = makeCtx(c1, { source: "auto", rangePct: 100 }, undefined, 74_430, "BINANCE_FUTURES:wifusdt");
  const p1 = prepareLiquidationProfile(ctx1Pre);
  assert.equal(p1.meta.activeSource, "model");
  assert.equal(p1.meta.replayedBars, 1);
  assert.ok(p1.meta.clusters.length > 0);
  const hoverY = 20 + ((80_000 - p1.meta.clusters[0].alignedPrice) / 10_000) * 300;
  const ctx1 = makeCtx(c1, { source: "auto", rangePct: 100 }, { x: 200, y: hoverY, visible: true }, 74_430, "BINANCE_FUTURES:wifusdt");
  drawLiquidationProfileOverlay(ctx1, p1);
  assert.ok(t1.some((t) => t.text === "Model · tahmini · Binance"));
  assert.ok(!t1.some((t) => t.text === "Hyperliquid · gerçek pozisyon"));
  assert.ok(f1.some((f) => f.height === 1 && f.width > 0));
  assert.ok(t1.some((t) => t.text.includes("+1 bar") && t.text.includes("asOf")));

  // 2. V1 gate: passed=false hidden by default, shown when showUnverifiedModel=true
  const unverifiedState = {
    ...modelState,
    v1: { passed: false, tested: true, fallingBp: 1, risingBp: 1, bestPlaceboBp: 5, days: 200 },
  };
  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
    requestLiquidationModel: () => ({
      status: "ready",
      data: { status: "ready", state: unverifiedState, bars: replayBars },
    }),
  });

  const { canvas: c2, fills: f2, texts: t2 } = canvasRecorder();
  const ctx2 = makeCtx(c2, { source: "model", showUnverifiedModel: false, rangePct: 100 });
  drawLiquidationProfileOverlay(ctx2, prepareLiquidationProfile(ctx2));
  assert.ok(t2.some((t) => t.text === "Model bu paritede doğrulanmadı"));
  assert.equal(f2.filter((f) => f.height === 1).length, 0, "unverified model must not draw bars");

  const { canvas: c3, fills: f3, texts: t3 } = canvasRecorder();
  const ctx3 = makeCtx(c3, { source: "model", showUnverifiedModel: true, rangePct: 100 });
  drawLiquidationProfileOverlay(ctx3, prepareLiquidationProfile(ctx3));
  assert.ok(t3.some((t) => t.text === "Model · tahmini · Binance"));
  assert.ok(f3.some((f) => f.height === 1 && f.width > 0));

  // 3. Stale >30 days state does not draw and shows stale badge
  const staleState = { ...modelState, asOf: now - 31 * 86_400_000 };
  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
    requestLiquidationModel: () => ({
      status: "ready",
      data: { status: "ready", state: staleState, bars: [] },
    }),
  });
  const { canvas: c4, fills: f4, texts: t4 } = canvasRecorder();
  const ctx4 = makeCtx(c4, { source: "model", rangePct: 100 });
  drawLiquidationProfileOverlay(ctx4, prepareLiquidationProfile(ctx4));
  assert.ok(t4.some((t) => t.text.includes("eski")));
  assert.equal(f4.filter((f) => f.height === 1).length, 0);

  // 4. All model status badges (warming, unsupported, seam-mismatch, unavailable)
  const expectedByStatus = [
    ["warming", "Model ısınıyor"],
    ["unsupported", "Bu market desteklenmiyor"],
    ["seam-mismatch", "Model seam uyuşmazlığı"],
    ["unavailable", "Likidasyon verisi yok"],
  ];
  for (const [status, expectedText] of expectedByStatus) {
    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
      requestLiquidationModel: () => ({ status }),
    });
    const { canvas, fills, texts } = canvasRecorder();
    const ctx = makeCtx(canvas, { source: "model" });
    drawLiquidationProfileOverlay(ctx, prepareLiquidationProfile(ctx));
    assert.ok(texts.some((t) => t.text === expectedText), `expected "${expectedText}" for ${status}`);
    assert.equal(fills.filter((f) => f.height === 1).length, 0);
  }
});
