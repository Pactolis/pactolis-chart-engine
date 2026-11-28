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
  crossExchangeOpenInterestIndicatorDefinition,
  normalizeCrossExchangeOpenInterestSettings,
  OPEN_INTEREST_VENUES,
} = await import("../dist/features/indicators/builtins/crossExchangeOpenInterest.js");

const MIN = 60_000;
const T0 = Date.UTC(2026, 3, 1, 0, 0, 0);

function buildSeries(closes) {
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars(
    closes.map((close, index) => ({
      startTime: T0 + index * MIN,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
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

function makeCtx(series, settingsOverrides = {}) {
  const settings = {
    ...crossExchangeOpenInterestIndicatorDefinition.defaultSettings(),
    ...settingsOverrides,
  };
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 200 };
  view.colWidth = 10;
  view.offsetX = 0;

  return {
    ctx: {},
    view,
    series,
    rect: { top: 0, height: 120 },
    range: [0, series.length],
    instance: {
      id: "ce-oi-437-test",
      type: "cross-exchange-open-interest",
      title: "Cross-Exchange OI",
      visible: true,
      paneId: "pane-ce-oi",
      order: 0,
      settings,
    },
    settings,
    chart: {
      market: "BINANCE_FUTURES:btcusdt",
      timeframe: "1m",
      intervalMs: MIN,
    },
    requestRefresh: () => {},
  };
}

function withMockDataSource(mock, fn) {
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

function withLocale(localeTag, fn) {
  let prev = null;
  try {
    prev = chartLocale();
  } catch {
    prev = null;
  }
  configureChartLocale({
    locale: () => localeTag,
    timeZone: () => "UTC",
    translate: (key) => key,
    onLocaleChange: () => () => {},
  });
  try {
    return fn();
  } finally {
    if (prev !== null) configureChartLocale(prev);
  }
}

test("CE #437: missing exchanges, empty object, and legacy-only keys default to all 4 exchanges (4ex)", () => {
  const allTrue = { binance: true, bybit: true, okx: true, hyperliquid: true };

  for (const raw of [
    undefined,
    {},
    { exchanges: {} },
    { exchanges: { bitmexf: true, coinbasef: false, "binancef-inverse": true } },
  ]) {
    const normalized = normalizeCrossExchangeOpenInterestSettings(raw);
    assert.deepEqual(normalized.exchanges, allTrue);
    const label = crossExchangeOpenInterestIndicatorDefinition.getHeaderLabel({
      settings: normalized,
      chart: { timeframe: "1m" },
    });
    assert.ok(label.includes("| 4ex"), `expected 4ex in header label: ${label}`);
  }
});

test("CE #437: explicit all-false exchanges keeps 0 selected, shows 0ex, returns no-data without calling requestOpenInterestSeries (TR & EN)", () => {
  const allFalse = { binance: false, bybit: false, okx: false, hyperliquid: false };
  const normalized = normalizeCrossExchangeOpenInterestSettings({ exchanges: allFalse });
  assert.deepEqual(normalized.exchanges, allFalse);
  assert.equal(OPEN_INTEREST_VENUES.filter((v) => normalized.exchanges[v]).length, 0);

  const label = crossExchangeOpenInterestIndicatorDefinition.getHeaderLabel({
    settings: normalized,
    chart: { timeframe: "1m" },
  });
  assert.ok(label.includes("| 0ex"), `expected 0ex in header label: ${label}`);

  const series = buildSeries([100, 101, 102]);
  let calls = 0;

  withMockDataSource(
    {
      requestOpenInterestSeries: () => {
        calls++;
        return { status: "idle" };
      },
    },
    () => {
      withLocale("tr-TR", () => {
        const prepared = crossExchangeOpenInterestIndicatorDefinition.prepareData(
          makeCtx(series, { exchanges: allFalse }),
        );
        assert.equal(prepared.status, "no-data");
        assert.equal(prepared.message, "OI için en az bir borsa seçilmelidir");
      });

      withLocale("en-US", () => {
        const prepared = crossExchangeOpenInterestIndicatorDefinition.prepareData(
          makeCtx(series, { exchanges: allFalse }),
        );
        assert.equal(prepared.status, "no-data");
        assert.equal(prepared.message, "Select at least one exchange for OI");
      });
    },
  );

  assert.equal(calls, 0);
});

test("CE #437: explicit 1-exchange and 4-exchange selections match header label (1ex / 4ex) and requestOpenInterestSeries venues", () => {
  const series = buildSeries([100, 101, 102]);
  const requestedVenues = [];

  withMockDataSource(
    {
      requestOpenInterestSeries: (input) => {
        requestedVenues.push(input.venues);
        return { status: "loading" };
      },
    },
    () => {
      const oneExchange = normalizeCrossExchangeOpenInterestSettings({
        exchanges: { binance: true, bybit: false, okx: false, hyperliquid: false },
      });
      const label1 = crossExchangeOpenInterestIndicatorDefinition.getHeaderLabel({
        settings: oneExchange,
        chart: { timeframe: "1m" },
      });
      assert.ok(label1.includes("| 1ex"), `expected 1ex in header label: ${label1}`);
      crossExchangeOpenInterestIndicatorDefinition.prepareData(
        makeCtx(series, { exchanges: oneExchange.exchanges }),
      );

      const fourExchanges = normalizeCrossExchangeOpenInterestSettings({
        exchanges: { binance: true, bybit: true, okx: true, hyperliquid: true },
      });
      const label4 = crossExchangeOpenInterestIndicatorDefinition.getHeaderLabel({
        settings: fourExchanges,
        chart: { timeframe: "1m" },
      });
      assert.ok(label4.includes("| 4ex"), `expected 4ex in header label: ${label4}`);
      crossExchangeOpenInterestIndicatorDefinition.prepareData(
        makeCtx(series, { exchanges: fourExchanges.exchanges }),
      );
    },
  );

  assert.deepEqual(requestedVenues, [
    ["binance"],
    ["binance", "bybit", "okx", "hyperliquid"],
  ]);
});
