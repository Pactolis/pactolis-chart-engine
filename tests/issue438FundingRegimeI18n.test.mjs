import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { chartLocale, configureChartLocale } = await import("../dist/core/chartLocale.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { View } = await import("../dist/core/engine/view.js");
const { configureIndicatorDataSource, indicatorDataSource } = await import(
  "../dist/features/indicators/indicatorDataSource.js"
);
const {
  fundingRegimeIndicatorDefinition,
  resetFundingRegimeCachesForTests,
} = await import("../dist/features/indicators/builtins/fundingRegime.js");

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeSeries(startTime, count, intervalMs = HOUR_MS) {
  const series = new FootprintSeries({ intervalMs, priceStep: 1 });
  series.loadBars(
    Array.from({ length: count }, (_, i) => ({
      startTime: startTime + i * intervalMs,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      delta: 0,
      count: 1,
      cells: new Map(),
      hasRef: true,
      cellRevision: 0,
    })),
  );
  return series;
}

function makeCanvasMock() {
  const fillTexts = [];
  const ctx = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "round",
    lineCap: "round",
    globalAlpha: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    strokeRect() {},
    roundRect() {},
    fill() {},
    measureText(text) {
      return { width: String(text).length * 4 };
    },
    fillText(text, x, y) {
      fillTexts.push({ text: String(text), x, y });
    },
  };
  return { ctx, fillTexts };
}

function makeDrawContext(series, settingsOverrides = {}, canvasMock = makeCanvasMock()) {
  const settings = { ...fundingRegimeIndicatorDefinition.defaultSettings(), ...settingsOverrides };
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 120 };
  view.colWidth = 10;
  view.offsetX = 0;
  return {
    ctx: canvasMock.ctx,
    view,
    series,
    rect: { top: 0, height: 120 },
    range: [0, series.length],
    instance: {
      id: `fr-i18n-${Math.random()}`,
      type: "funding-regime",
      title: "Funding Regime",
      visible: true,
      paneId: "p-fr",
      order: 0,
      settings,
    },
    settings,
    chart: {
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1h",
      intervalMs: series.config.intervalMs,
    },
    requestRefresh() {},
  };
}

function withHostLocale(localeTag, translateFn, fn) {
  let prev = null;
  try {
    prev = chartLocale();
  } catch {
    prev = null;
  }
  configureChartLocale({
    locale: () => localeTag,
    timeZone: () => "UTC",
    translate: translateFn,
    onLocaleChange: () => () => {},
  });
  try {
    return fn();
  } finally {
    if (prev !== null) configureChartLocale(prev);
  }
}

function withMockFundingDataSource({ spanDays, excludedVenues = [] }, fn) {
  let prev = null;
  try {
    prev = indicatorDataSource();
  } catch {
    prev = null;
  }
  resetFundingRegimeCachesForTests();
  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => {
      throw new Error("unused");
    },
    requestVenueFundingSeries: (input) => {
      const start = Math.max(input.from, input.to - spanDays * DAY_MS);
      const points = [];
      for (let t = start + HOUR_MS; t <= input.to; t += HOUR_MS) {
        const hourIndex = Math.round((t - start) / HOUR_MS);
        points.push({
          t,
          rate8h: 0.0001 + Math.sin(hourIndex / 6) * 0.00003,
          venues: input.venues,
        });
      }
      return {
        status: "ready",
        data: {
          market: input.market,
          from: input.from,
          to: input.to,
          venues: input.venues,
          series: [],
          aggregate: {
            points,
            current: { t: input.to, rate8h: 0.00015, venues: input.venues },
            excludedVenues,
            source: "backend-oi",
          },
        },
      };
    },
  });
  try {
    return fn();
  } finally {
    resetFundingRegimeCachesForTests();
    if (prev !== null) configureIndicatorDataSource(prev);
  }
}

test("CE #438: fundingRegime localizes headerLabel, readout, and canvas message across en, tr, and custom host catalog", () => {
  const visibleStart = T0 + 30 * DAY_MS;
  const series = makeSeries(visibleStart, 24, HOUR_MS);

  // 1. Sufficient data with excluded venue -> EN & TR
  withMockFundingDataSource({ spanDays: 35, excludedVenues: ["okxf"] }, () => {
    const ctxEn = makeDrawContext(series, { mode: "zScore" });
    const prepared = fundingRegimeIndicatorDefinition.prepareData(ctxEn);

    withHostLocale("en-US", (key) => key, () => {
      const header = fundingRegimeIndicatorDefinition.getHeaderLabel({
        settings: ctxEn.settings,
        chart: ctxEn.chart,
        prepared,
      });
      assert.ok(header.includes("4/4 exchanges"), `EN header missing exchanges: ${header}`);
      assert.ok(header.includes("excl:okxf"), `EN header missing excl: ${header}`);

      const readout = fundingRegimeIndicatorDefinition.getReadout(ctxEn, prepared, null);
      const labels = readout.items.map((i) => i.label);
      assert.ok(labels.includes("avg"), `EN readout missing avg: ${labels.join(",")}`);
      assert.ok(labels.includes("exchanges"), `EN readout missing exchanges: ${labels.join(",")}`);
      assert.ok(labels.includes("excl"), `EN readout missing excl: ${labels.join(",")}`);
    });

    withHostLocale("tr-TR", (key) => key, () => {
      const header = fundingRegimeIndicatorDefinition.getHeaderLabel({
        settings: ctxEn.settings,
        chart: ctxEn.chart,
        prepared,
      });
      assert.ok(header.includes("4/4 borsa"), `TR header missing borsa: ${header}`);
      assert.ok(header.includes("hariç:okxf"), `TR header missing hariç: ${header}`);

      const readout = fundingRegimeIndicatorDefinition.getReadout(ctxEn, prepared, null);
      const labels = readout.items.map((i) => i.label);
      assert.ok(labels.includes("ort"), `TR readout missing ort: ${labels.join(",")}`);
      assert.ok(labels.includes("borsa"), `TR readout missing borsa: ${labels.join(",")}`);
      assert.ok(labels.includes("hariç"), `TR readout missing hariç: ${labels.join(",")}`);
    });
  });

  // 2. Insufficient data (< 7 days) -> EN, TR, and custom host catalog
  withMockFundingDataSource({ spanDays: 2, excludedVenues: [] }, () => {
    const canvasEn = makeCanvasMock();
    const ctxEn = makeDrawContext(series, { mode: "zScore" }, canvasEn);
    const prepared = fundingRegimeIndicatorDefinition.prepareData(ctxEn);

    withHostLocale("en-US", (key) => key, () => {
      const header = fundingRegimeIndicatorDefinition.getHeaderLabel({
        settings: ctxEn.settings,
        chart: ctxEn.chart,
        prepared,
      });
      assert.ok(header.includes("insufficient data"), `EN header missing insufficient data: ${header}`);

      const readout = fundingRegimeIndicatorDefinition.getReadout(ctxEn, prepared, null);
      assert.ok(readout.items.some((i) => i.label === "status" && i.value === "insufficient data"));

      canvasEn.fillTexts.length = 0;
      fundingRegimeIndicatorDefinition.drawSubPane(ctxEn, prepared);
      assert.ok(canvasEn.fillTexts.some((t) => t.text.includes("insufficient data")));
    });

    withHostLocale("tr-TR", (key) => key, () => {
      const header = fundingRegimeIndicatorDefinition.getHeaderLabel({
        settings: ctxEn.settings,
        chart: ctxEn.chart,
        prepared,
      });
      assert.ok(header.includes("yetersiz veri"), `TR header missing yetersiz veri: ${header}`);

      const readout = fundingRegimeIndicatorDefinition.getReadout(ctxEn, prepared, null);
      assert.ok(readout.items.some((i) => i.label === "durum" && i.value === "yetersiz veri"));

      canvasEn.fillTexts.length = 0;
      fundingRegimeIndicatorDefinition.drawSubPane(ctxEn, prepared);
      assert.ok(canvasEn.fillTexts.some((t) => t.text.includes("yetersiz veri")));
    });

    const customCatalog = {
      "indicator.fundingRegime.venues": "CUSTOM_VENUES",
      "indicator.fundingRegime.insufficientData": "CUSTOM_INSUFFICIENT",
      "indicator.fundingRegime.status": "CUSTOM_STATUS",
      "indicator.fundingRegime.mean": "CUSTOM_MEAN",
    };
    withHostLocale("de-DE", (key) => customCatalog[key] ?? key, () => {
      const header = fundingRegimeIndicatorDefinition.getHeaderLabel({
        settings: ctxEn.settings,
        chart: ctxEn.chart,
        prepared,
      });
      assert.ok(header.includes("4/4 CUSTOM_VENUES"), `Custom header missing CUSTOM_VENUES: ${header}`);
      assert.ok(header.includes("CUSTOM_INSUFFICIENT"), `Custom header missing CUSTOM_INSUFFICIENT: ${header}`);

      const readout = fundingRegimeIndicatorDefinition.getReadout(ctxEn, prepared, null);
      assert.ok(readout.items.some((i) => i.label === "CUSTOM_STATUS" && i.value === "CUSTOM_INSUFFICIENT"));
      assert.ok(readout.items.some((i) => i.label === "CUSTOM_MEAN"));
      assert.ok(readout.items.some((i) => i.label === "CUSTOM_VENUES"));

      canvasEn.fillTexts.length = 0;
      fundingRegimeIndicatorDefinition.drawSubPane(ctxEn, prepared);
      assert.ok(canvasEn.fillTexts.some((t) => t.text.includes("CUSTOM_INSUFFICIENT")));
    });
  });
});
