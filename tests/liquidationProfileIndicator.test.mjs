import test from "node:test";
import assert from "node:assert/strict";
import {
  alignHlPriceToBinance,
  buildLiquidationProfileStatusText,
  computeAlignmentWarnings,
  drawLiquidationProfileOverlay,
  filterLiquidationClusters,
  liquidationProfileIndicatorDefinition,
  mergeClustersByPixelRow,
  prepareLiquidationProfile,
} from "../dist/features/indicators/builtins/liquidationProfile.js";
import { configureIndicatorDataSource } from "../dist/features/indicators/indicatorDataSource.js";
import { configureChartLocale } from "../dist/core/chartLocale.js";
import { uiColor } from "../dist/core/ui/seriesPalette.js";

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

function makeCtx(canvas, settingsOverrides = {}, crosshair = undefined, binanceLast = 74_430) {
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
    chart: { market: "BINANCE_FUTURES:btcusdt", timeframe: "15m", intervalMs: 900_000 },
    crosshair,
    requestRefresh: () => {},
  };
}

test("alignHlPriceToBinance uses ratio (not difference) and handles missing markPx", () => {
  const aligned = alignHlPriceToBinance(74_453, 74_430, 74_453);
  assert.ok(Math.abs(aligned - 74_430) < 1e-6);

  const scaled = alignHlPriceToBinance(70_000, 74_430, 74_453);
  const expected = 70_000 * (74_430 / 74_453);
  assert.ok(Math.abs(scaled - expected) < 1e-9);

  assert.equal(alignHlPriceToBinance(70_000, 74_430, null), 70_000);
  assert.equal(alignHlPriceToBinance(70_000, null, 74_453), 70_000);
});

test("computeAlignmentWarnings flags >60s HL mark price and >1% divergence", () => {
  const now = 1_700_000_100_000;
  const fresh = computeAlignmentWarnings(74_430, 74_453, now - 30_000, now);
  assert.equal(fresh.staleMarkPx, false);
  assert.equal(fresh.priceDivergence, false);

  const staleAndDiverged = computeAlignmentWarnings(75_500, 74_000, now - 65_000, now);
  assert.equal(staleAndDiverged.staleMarkPx, true);
  assert.equal(staleAndDiverged.priceDivergence, true);
  assert.ok((staleAndDiverged.divergencePct ?? 0) > 1);
});

test("filterLiquidationClusters applies rangePct and minNotionalUsd filters", () => {
  const clusters = [
    { price: 70_000, longNotional: 100_000, shortNotional: 0, longCount: 2, shortCount: 0 }, // -6% from 74500
    { price: 73_000, longNotional: 40_000, shortNotional: 0, longCount: 1, shortCount: 0 },  // -2%, < 50k
    { price: 74_000, longNotional: 80_000, shortNotional: 20_000, longCount: 3, shortCount: 1 }, // -0.67%, 100k
    { price: 76_000, longNotional: 0, shortNotional: 120_000, longCount: 0, shortCount: 4 }, // +2%, 120k
  ];

  const r5Min50k = filterLiquidationClusters(clusters, 5, 50_000, 74_500);
  assert.deepEqual(r5Min50k.map((c) => c.price), [74_000, 76_000]);

  const r100All = filterLiquidationClusters(clusters, 100, 0, 74_500);
  assert.equal(r100All.length, 4);
});

test("mergeClustersByPixelRow conserves total notional and bounds draw rows", () => {
  const clusters = [];
  let expectedLong = 0;
  let expectedShort = 0;
  for (let i = 0; i < 1_186; i += 1) {
    const price = 71_000 + i * 5;
    const longNotional = i < 600 ? 10_000 + i * 10 : 0;
    const shortNotional = i >= 600 ? 12_000 + i * 8 : 0;
    expectedLong += longNotional;
    expectedShort += shortNotional;
    clusters.push({
      price,
      hlPrice: price,
      alignedPrice: price,
      longNotional,
      shortNotional,
      longCount: longNotional > 0 ? 1 : 0,
      shortCount: shortNotional > 0 ? 1 : 0,
    });
  }

  const yOfPrice = (p) => 20 + ((80_000 - p) / 10_000) * 300;
  const rows = mergeClustersByPixelRow(clusters, yOfPrice, 20, 320);

  assert.ok(rows.length <= 305, `expected bounded rows <= 305, got ${rows.length}`);
  assert.ok(rows.length < clusters.length, "zoomed-out clusters should merge into fewer pixel rows");

  const mergedLong = rows.reduce((sum, r) => sum + r.longNotional, 0);
  const mergedShort = rows.reduce((sum, r) => sum + r.shortNotional, 0);
  assert.ok(Math.abs(mergedLong - expectedLong) < 1e-6);
  assert.ok(Math.abs(mergedShort - expectedShort) < 1e-6);
});

test("status messages, warnings, and hover readout render in Turkish", () => {
  setupTurkishLocale();

  assert.equal(buildLiquidationProfileStatusText("unsupported", null), "Hyperliquid'de bu market yok");
  assert.equal(buildLiquidationProfileStatusText("disabled", null), "Likidasyon verisi yok");
  assert.equal(buildLiquidationProfileStatusText("unavailable", null), "Likidasyon verisi yok");

  const now = Date.now();
  const badgeText = buildLiquidationProfileStatusText("stale", now - 5 * 60_000, now);
  assert.equal(badgeText, "Hyperliquid · snapshot 5 dk önce · tahmini");

  for (const status of ["unsupported", "disabled", "unavailable"]) {
    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
      requestLiquidationClusters: () => ({ status }),
    });
    const { canvas, texts } = canvasRecorder();
    const ctx = makeCtx(canvas);
    const prepared = prepareLiquidationProfile(ctx);
    drawLiquidationProfileOverlay(ctx, prepared);
    const expected = status === "unsupported" ? "Hyperliquid'de bu market yok" : "Likidasyon verisi yok";
    assert.ok(texts.some((t) => t.text === expected), `expected "${expected}" for status ${status}`);
  }

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: () => Promise.reject(new Error("unused")),
    requestLiquidationClusters: () => ({
      status: "ready",
      data: {
        status: "source-changed",
        source: "hyperliquid",
        hlCoin: "BTC",
        takenAt: Date.now() - 3 * 60_000,
        hlMarkPx: 72_000,
        hlMarkAt: Date.now() - 90_000,
        clusters: [
          { price: 72_000, longNotional: 1_500_000, shortNotional: 250_000, longCount: 12, shortCount: 3 },
        ],
      },
    }),
  });

  const alignedY = 20 + ((80_000 - 74_430) / 10_000) * 300;
  const { canvas, texts, strokes } = canvasRecorder();
  const ctx = makeCtx(canvas, { showCumulative: true }, { x: 200, y: alignedY, visible: true }, 74_430);
  const prepared = prepareLiquidationProfile(ctx);
  drawLiquidationProfileOverlay(ctx, prepared);

  assert.ok(texts.some((t) => t.text.includes("Hyperliquid · snapshot 3 dk önce · tahmini") && t.color === uiColor.warn));
  assert.ok(texts.some((t) => t.text === "HL fiyatı eski" && t.color === uiColor.warn));
  assert.ok(texts.some((t) => t.text === "HL/Binance fiyat farkı >%1" && t.color === uiColor.warn));
  assert.ok(texts.some((t) => t.text.includes("HL 72,000 → Binance ≈ 74,430")));
  assert.ok(strokes.length >= 0);
});
