import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

const { chartLocale, configureChartLocale } = await import("../dist/core/chartLocale.js");
const { calculateOrderFlowProfile } = await import("../dist/core/analysis/orderFlowProfile.js");
const { calculateVolumeProfile } = await import("../dist/core/analysis/volumeProfile.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("../dist/core/performanceTelemetry.js");
const { profileHistogramParts } = await import("../dist/core/render/orderFlowProfile.js");
const { recordFootprintSupport, resetFootprintSupport } = await import("../dist/core/syncAllowlist.js");
const { uiColor } = await import("../dist/core/ui/seriesPalette.js");
const { volumeProfileIndicatorDefinition } = await import("../dist/features/indicators/builtins/volumeProfile.js");

const T0 = Date.UTC(2026, 2, 1, 0, 0, 0);
const MIN = 60_000;

function exactBar(time, levels, overrides = {}) {
  let buySum = 0;
  let sellSum = 0;
  for (const level of levels) {
    buySum += level.buyVol;
    sellSum += level.sellVol;
  }
  return {
    startTime: time,
    open: 100,
    high: 104,
    low: 99,
    close: 102,
    volume: buySum + sellSum,
    delta: buySum - sellSum,
    count: levels.length * 2,
    hasRef: true,
    cellRevision: 1,
    completeness: "complete",
    sources: ["history"],
    cells: new Map(levels.map((level) => [level.priceBin, level])),
    ...overrides,
  };
}

function ohlcvBar(time, open, high, low, close, volume, overrides = {}) {
  return {
    startTime: time,
    open,
    high,
    low,
    close,
    volume,
    delta: 0,
    count: 0,
    hasRef: true,
    cellRevision: 1,
    completeness: "complete",
    sources: ["history"],
    cells: new Map(),
    ...overrides,
  };
}

function mockCanvas() {
  const fillTexts = [];
  const fillRects = [];
  const noop = () => {};
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    strokeRect: noop,
    setLineDash: noop,
    measureText: (text) => ({ width: String(text).length * 7 }),
    fillRect(x, y, w, h) {
      fillRects.push({ x, y, w, h, fillStyle: this.fillStyle, alpha: this.globalAlpha });
    },
    fillText(text, x, y) {
      fillTexts.push({ text: String(text), x, y, fillStyle: this.fillStyle });
    },
  };
  return { ctx, fillTexts, fillRects };
}

function makeIndicatorCtx(series, range, overrides = {}) {
  const { ctx, fillTexts, fillRects } = mockCanvas();
  const queuedLabels = [];
  const settings = { ...volumeProfileIndicatorDefinition.defaultSettings(), ...overrides };
  const area = { left: 0, top: 0, width: 700, height: 320 };
  const view = {
    colWidth: 10,
    area,
    priceAxisW: 60,
    xOfIndex: (i) => i * 10,
    indexOfX: (x) => Math.floor(x / 10),
    yOfPrice: (price) => 300 - (price - 95) * 10,
    priceOfY: (y) => 95 + (300 - y) / 10,
  };
  const instance = {
    id: `ofp-est-${Math.random().toString(36).slice(2)}`,
    type: "volume-profile",
    title: "Order Flow Profile",
    visible: true,
    paneId: "main",
    order: 0,
    settings,
    seq: 1,
  };
  return {
    drawCtx: {
      ctx,
      view,
      series,
      rect: { top: 320, height: 72 },
      range,
      instance,
      settings,
      requestRefresh() {},
      queuePriceLabel(price, label, color, priority) {
        queuedLabels.push({ price, label, color, priority });
      },
    },
    fillTexts,
    fillRects,
    queuedLabels,
  };
}

function withLocale(langTag, fn) {
  const prev = chartLocale();
  configureChartLocale({
    locale: () => langTag,
    timeZone: () => "UTC",
    translate: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    onLocaleChange: () => () => {},
  });
  try {
    return fn();
  } finally {
    configureChartLocale(prev);
  }
}

test("exact footprint bars preserve golden parity and never show Estimated/Tahmini labels", () => {
  const bars = [
    exactBar(T0, [
      { priceBin: 100, buyVol: 10, sellVol: 5, buyCount: 2, sellCount: 1, count: 3 },
      { priceBin: 101, buyVol: 25, sellVol: 15, buyCount: 4, sellCount: 3, count: 7 },
      { priceBin: 102, buyVol: 6, sellVol: 4, buyCount: 1, sellCount: 1, count: 2 },
    ]),
    exactBar(T0 + MIN, [
      { priceBin: 101, buyVol: 12, sellVol: 8, buyCount: 2, sellCount: 2, count: 4 },
    ]),
  ];

  const baseline = calculateOrderFlowProfile(bars, {
    profileMetric: "volume",
    profileSide: "total",
    valueAreaPercent: 0.7,
    developing: true,
  });
  const withFallbackEnabled = calculateOrderFlowProfile(bars, {
    profileMetric: "volume",
    profileSide: "total",
    valueAreaPercent: 0.7,
    developing: true,
    priceStep: 1,
    allowOhlcvEstimate: true,
  });

  assert.deepStrictEqual(withFallbackEnabled, baseline);
  assert.equal(withFallbackEnabled.provenance, "exact");
  assert.equal(withFallbackEnabled.isEstimated, false);
  assert.equal(withFallbackEnabled.exactBarCount, 2);
  assert.equal(withFallbackEnabled.estimatedBarCount, 0);
  assert.equal(withFallbackEnabled.poc, 101);

  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars(bars);

  for (const tag of ["en-US", "tr-TR"]) {
    withLocale(tag, () => {
      const { drawCtx, fillTexts, fillRects, queuedLabels } = makeIndicatorCtx(series, [0, bars.length]);
      const prepared = volumeProfileIndicatorDefinition.prepareData(drawCtx);
      assert.equal(prepared.status, "ok");
      assert.equal(prepared.message, undefined);

      const header = volumeProfileIndicatorDefinition.getHeaderLabel({ settings: drawCtx.settings, prepared });
      assert.ok(!/estimated|tahmini/i.test(header), `${tag}: exact header must not contain Estimated/Tahmini (${header})`);

      volumeProfileIndicatorDefinition.drawPriceOverlay(drawCtx, prepared);
      assert.equal(fillTexts.length, 0, `${tag}: exact price-overlay renders no estimated badge`);
      volumeProfileIndicatorDefinition.drawSubPane(drawCtx, prepared);

      // Exact stacked volume/total renders both sell and buy rects per level.
      const histRects = fillRects.filter((r) => r.alpha === 0.55);
      assert.ok(histRects.some((r) => r.fillStyle === uiColor.buy), `${tag}: exact buy rect`);
      assert.ok(histRects.some((r) => r.fillStyle === uiColor.sell), `${tag}: exact sell rect`);
      assert.ok(queuedLabels.some((l) => l.label === "POC"), `${tag}: exact POC label stays plain`);
      assert.ok(fillTexts.every((entry) => !/estimated|tahmini/i.test(entry.text)), `${tag}: exact subpane has no estimated tag`);
    });
  }
});

test("zero-volume cells-empty bar inside an exact window does not degrade provenance to mixed", () => {
  const bars = [
    exactBar(T0, [{ priceBin: 100, buyVol: 10, sellVol: 10 }]),
    ohlcvBar(T0 + MIN, 100, 100, 100, 100, 0),
  ];
  const result = calculateOrderFlowProfile(bars, {
    profileMetric: "volume",
    profileSide: "total",
    priceStep: 1,
    allowOhlcvEstimate: true,
  });
  assert.equal(result.provenance, "exact");
  assert.equal(result.isEstimated, false);
  assert.equal(result.exactBarCount, 1);
  assert.equal(result.estimatedBarCount, 0);
  assert.equal(result.totalVolume, 20);
});

test("OHLCV-only estimator distributes volume deterministically and conserves total across edge cases", () => {
  // 1. Exact multi-bin equal distribution
  const uniform = calculateOrderFlowProfile(
    [ohlcvBar(T0, 100.5, 103, 100, 102, 30)],
    { priceStep: 1, allowOhlcvEstimate: true, developing: true },
  );
  assert.equal(uniform.provenance, "estimated");
  assert.equal(uniform.isEstimated, true);
  assert.equal(uniform.exactBarCount, 0);
  assert.equal(uniform.estimatedBarCount, 1);
  assert.equal(uniform.totalBuyVolume, 0);
  assert.equal(uniform.totalSellVolume, 0);
  assert.equal(uniform.totalVolume, 30);
  assert.equal(uniform.totalTradeCount, null);
  assert.deepEqual(
    uniform.levels.map((l) => [l.priceBin, l.totalVol, l.buyValue, l.sellValue]),
    [
      [100, 10, null, null],
      [101, 10, null, null],
      [102, 10, null, null],
    ],
  );
  // Uniform ties break deterministically to lowest price bin (100) and total histogram renders one-sided.
  assert.equal(uniform.poc, 100);
  assert.equal(uniform.val, 100);
  assert.equal(uniform.vah, 102);
  assert.deepEqual(profileHistogramParts(uniform.levels[0], "volume", "total"), [
    { side: "total", value: 10, signed: 10 },
  ]);

  // 2. Partial bin overlap at both ends
  const partial = calculateOrderFlowProfile(
    [ohlcvBar(T0, 101, 102.25, 100.5, 101.5, 17.5)],
    { priceStep: 1, allowOhlcvEstimate: true },
  );
  assert.deepEqual(
    partial.levels.map((l) => [l.priceBin, l.totalVol]),
    [
      [100, 5],
      [101, 10],
      [102, 2.5],
    ],
  );
  assert.equal(partial.poc, 101);
  assert.equal(partial.totalVolume, 17.5);

  // 3. Flat bar (high === low) falls onto one bin
  const flat = calculateOrderFlowProfile(
    [ohlcvBar(T0, 100.3, 100.3, 100.3, 100.3, 12)],
    { priceStep: 1, allowOhlcvEstimate: true },
  );
  assert.deepEqual(flat.levels.map((l) => [l.priceBin, l.totalVol]), [[100, 12]]);
  assert.deepEqual([flat.poc, flat.val, flat.vah], [100, 100, 100]);

  // 4. Fractional tick precision (0.05 and 1e-8) conserves sum without drift or NaN
  for (const [low, high, step, vol] of [
    [150.0, 150.15, 0.05, 9],
    [0.000001, 0.00000105, 0.00000001, 5],
    [0, 10, 5, 20],
  ]) {
    const res = calculateOrderFlowProfile(
      [ohlcvBar(T0, low, high, low, high, vol)],
      { priceStep: step, allowOhlcvEstimate: true },
    );
    const levelSum = res.levels.reduce((sum, l) => sum + l.totalVol, 0);
    assert.ok(Math.abs(levelSum - vol) <= 1e-12, `step=${step} levelSum=${levelSum} vol=${vol}`);
    assert.ok(res.levels.every((l) => l.totalVol >= 0 && Number.isFinite(l.totalVol)));
    assert.ok(Math.abs(res.totalVolume - vol) <= 1e-12);
  }

  // 5. Invalid/corrupted OHLCV bars (NaN, high < low, zero volume) are safely ignored
  const sanitized = calculateOrderFlowProfile(
    [
      ohlcvBar(T0, 100, 99, 101, 100, 50), // inverted high < low
      ohlcvBar(T0 + MIN, 100, 101, 100, 100, Number.NaN),
      ohlcvBar(T0 + 2 * MIN, 100, 102, 100, 101, 0),
    ],
    { priceStep: 1, allowOhlcvEstimate: true },
  );
  assert.equal(sanitized.levels.length, 0);
  assert.equal(sanitized.provenance, "none");

  // 6. Huge price span stays bounded <= 2048 bins per bar while conserving total volume
  const hugeSpan = calculateOrderFlowProfile(
    [ohlcvBar(T0, 10, 100_010, 10, 90_000, 500)],
    { priceStep: 1, allowOhlcvEstimate: true },
  );
  assert.ok(hugeSpan.levels.length > 0 && hugeSpan.levels.length <= 2_048);
  assert.ok(Math.abs(hugeSpan.totalVolume - 500) <= 1e-9);

  // 7. calculateVolumeProfile wrapper compatibility
  const vpRes = calculateVolumeProfile(
    [ohlcvBar(T0, 100, 102, 100, 101, 20)],
    0.7,
    { priceStep: 1, allowOhlcvEstimate: true },
  );
  assert.equal(vpRes.provenance, "estimated");
  assert.equal(vpRes.isEstimated, true);
  assert.equal(vpRes.totalVolume, 20);
  assert.deepEqual(vpRes.levels, [
    { priceBin: 100, buyVol: 0, sellVol: 0, totalVol: 10 },
    { priceBin: 101, buyVol: 0, sellVol: 0, totalVol: 10 },
  ]);
});

test("fail-closed on unsupported metrics/sides in all-OHLCV estimated windows", () => {
  const ohlcvOnly = [ohlcvBar(T0, 100, 103, 100, 102, 30)];

  const unsupportedCombos = [
    ["volume", "buy"],
    ["volume", "sell"],
    ["delta", "total"],
    ["trade-count", "total"],
    ["trade-count", "buy"],
    ["average-trade-size", "total"],
  ];

  const label = "ohlcvOnly";
  const bars = ohlcvOnly;
  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars(bars);

  for (const [profileMetric, profileSide] of unsupportedCombos) {
    const result = calculateOrderFlowProfile(bars, {
      profileMetric,
      profileSide,
      priceStep: 1,
      allowOhlcvEstimate: true,
      developing: true,
    });
    assert.equal(result.dataComplete, false, `${label} ${profileMetric}/${profileSide}`);
    assert.equal(result.isEstimated, true);
    assert.equal(result.provenance, "estimated");
    assert.deepEqual(result.levels, []);
    assert.equal(result.summaryValue, null);
    assert.deepEqual([result.poc, result.vah, result.val], [null, null, null]);

    for (const [tag, expectedWord] of [["en-US", "Estimated"], ["tr-TR", "Tahmini"]]) {
      withLocale(tag, () => {
        const { drawCtx, fillTexts } = makeIndicatorCtx(series, [0, bars.length], { profileMetric, profileSide });
        const prepared = volumeProfileIndicatorDefinition.prepareData(drawCtx);
        assert.equal(prepared.status, "no-data", `${label} ${tag} ${profileMetric}/${profileSide} fail-closed`);
        assert.ok(prepared.message?.includes(expectedWord), `${tag} unsupported message mentions ${expectedWord}: ${prepared.message}`);

        const header = volumeProfileIndicatorDefinition.getHeaderLabel({ settings: drawCtx.settings, prepared });
        assert.ok(header.includes(expectedWord), `${tag} header still mentions ${expectedWord}: ${header}`);

        volumeProfileIndicatorDefinition.drawPriceOverlay(drawCtx, prepared);
        assert.ok(fillTexts.some((entry) => entry.text.includes(expectedWord)), `${tag} price-overlay draws fail-closed ${expectedWord} notice`);
        fillTexts.length = 0;
        volumeProfileIndicatorDefinition.drawSubPane(drawCtx, prepared);
        assert.ok(fillTexts.some((entry) => entry.text.includes(expectedWord)), `${tag} pane badge shows ${expectedWord}`);
      });
    }
  }
});

test("an exact footprint bar makes OHLCV estimates in the entire window inert", () => {
  const bars = [
    ohlcvBar(T0, 100, 102, 100, 101, 20),
    exactBar(T0 + MIN, [
      { priceBin: 100, buyVol: 15, sellVol: 5, buyCount: 3, sellCount: 2, count: 5 },
      { priceBin: 102, buyVol: 8, sellVol: 12, buyCount: 2, sellCount: 4, count: 6 },
    ]),
    ohlcvBar(T0 + 2 * MIN, 101, 103, 101, 102, 10),
  ];
  const metrics = ["volume", "delta", "trade-count", "average-trade-size"];
  const sides = ["total", "buy", "sell"];

  for (const profileMetric of metrics) {
    for (const profileSide of sides) {
      const options = { profileMetric, profileSide, priceStep: 1, developing: true };
      const baseline = calculateOrderFlowProfile(bars, { ...options, allowOhlcvEstimate: false });
      const withFallbackEnabled = calculateOrderFlowProfile(bars, { ...options, allowOhlcvEstimate: true });
      assert.deepStrictEqual(withFallbackEnabled, baseline, `${profileMetric}/${profileSide}`);
      assert.equal(withFallbackEnabled.provenance, "exact", `${profileMetric}/${profileSide}`);
      assert.equal(withFallbackEnabled.isEstimated, false, `${profileMetric}/${profileSide}`);
      assert.equal(withFallbackEnabled.exactBarCount, 1, `${profileMetric}/${profileSide}`);
      assert.equal(withFallbackEnabled.estimatedBarCount, 0, `${profileMetric}/${profileSide}`);
      assert.equal(withFallbackEnabled.totalVolume, 40, `${profileMetric}/${profileSide}`);
      assert.deepEqual(withFallbackEnabled.levels.map((level) => level.priceBin), [100, 102]);
    }
  }

  const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
  series.loadBars(bars);
  for (const tag of ["en-US", "tr-TR"]) {
    withLocale(tag, () => {
      const { drawCtx, fillTexts, fillRects, queuedLabels } = makeIndicatorCtx(series, [0, bars.length]);
      const prepared = volumeProfileIndicatorDefinition.prepareData(drawCtx);
      assert.equal(prepared.status, "ok");
      assert.equal(prepared.message, undefined);
      const header = volumeProfileIndicatorDefinition.getHeaderLabel({ settings: drawCtx.settings, prepared });
      assert.ok(!/estimated|tahmini/i.test(header), `${tag}: exact header stays unbadged (${header})`);

      volumeProfileIndicatorDefinition.drawPriceOverlay(drawCtx, prepared);
      assert.ok(fillTexts.every((entry) => !/estimated|tahmini/i.test(entry.text)), `${tag}: overlay has no estimate badge`);
      const histRects = fillRects.filter((rect) => rect.alpha === 0.55);
      assert.ok(histRects.some((rect) => rect.fillStyle === uiColor.buy), `${tag}: exact buy histogram`);
      assert.ok(histRects.some((rect) => rect.fillStyle === uiColor.sell), `${tag}: exact sell histogram`);
      assert.ok(queuedLabels.some((label) => label.label === "POC"), `${tag}: exact POC label`);
      fillTexts.length = 0;
      volumeProfileIndicatorDefinition.drawSubPane(drawCtx, prepared);
      assert.ok(fillTexts.every((entry) => !/estimated|tahmini/i.test(entry.text)), `${tag}: subpane has no estimate badge`);
    });
  }
});

test("incremental tail cache matches exact fallback gating and keys on priceStep", () => {
  const prevTelemetryEnabled = snapshotPerformanceTelemetry().enabled;
  configurePerformanceTelemetry({ enabled: true });
  try {
    const initialBars = Array.from({ length: 40 }, (_, i) =>
      ohlcvBar(T0 + i * MIN, 100, 103, 100, 102, 30 + (i % 5)),
    );
    const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
    series.loadBars(initialBars);

    const { drawCtx } = makeIndicatorCtx(series, [10, 40], { mode: "visible", pocMode: "both" });
    const fullRef = (range) => {
      const slice = series.listReadonly().slice(range[0], range[1]);
      return calculateOrderFlowProfile(slice, {
        profileMetric: "volume",
        profileSide: "total",
        valueAreaPercent: 0.7,
        developing: true,
        priceStep: series.config.priceStep,
        allowOhlcvEstimate: true,
      });
    };

    const hitsBefore = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;
    const p0 = volumeProfileIndicatorDefinition.prepareData(drawCtx);
    assert.equal(p0.status, "ok");
    assert.deepStrictEqual(p0.meta.result, fullRef(drawCtx.range));

    // Tail trades add an exact bar, which disables estimates for the visible window.
    for (let k = 0; k < 4; k++) {
      series.addTrades([{
        time: initialBars.at(-1).startTime + 1_000 + k,
        price: 101,
        qty: 12.5,
        isBuy: k % 2 === 0,
        id: `est-tail-${k}`,
      }]);
      const pTail = volumeProfileIndicatorDefinition.prepareData(drawCtx);
      assert.equal(pTail.status, "ok");
      assert.equal(pTail.meta.result.provenance, "exact");
      assert.deepStrictEqual(pTail.meta.result, fullRef(drawCtx.range), `tail trade ${k} strict parity`);
    }

    const hitsAfter = snapshotPerformanceTelemetry().counters["indicator.incremental.hit.volumeProfile"] ?? 0;
    assert.equal(hitsAfter - hitsBefore, 4, "exact tail ticks must use incremental path");

    // Non-footprint OHLCV-only market (meta.footprint.allowed = false) keeps tail updates in pure estimated mode.
    recordFootprintSupport("BYBIT:solusdt", false);
    try {
      const pureOhlcvBars = Array.from({ length: 40 }, (_, i) =>
        ohlcvBar(T0 + i * MIN, 100, 103, 100, 102, 30 + (i % 5)),
      );
      const ohlcvSeries = new FootprintSeries({ intervalMs: MIN, priceStep: 1, referenceMarket: "BYBIT:solusdt" });
      ohlcvSeries.loadBars(pureOhlcvBars);
      const { drawCtx: ohlcvCtx } = makeIndicatorCtx(ohlcvSeries, [10, 40], { mode: "visible", pocMode: "both" });
      const ohlcvFull = () => calculateOrderFlowProfile(ohlcvSeries.listReadonly().slice(10, 40), {
        profileMetric: "volume",
        profileSide: "total",
        valueAreaPercent: 0.7,
        developing: true,
        priceStep: ohlcvSeries.config.priceStep,
        allowOhlcvEstimate: true,
      });
      const ohlcvP0 = volumeProfileIndicatorDefinition.prepareData(ohlcvCtx);
      assert.equal(ohlcvP0.status, "ok");
      assert.equal(ohlcvP0.meta.result.provenance, "estimated");
      assert.deepStrictEqual(ohlcvP0.meta.result, ohlcvFull());
      for (let k = 0; k < 3; k++) {
        ohlcvSeries.addTrades([{
          time: pureOhlcvBars.at(-1).startTime + 2_000 + k,
          price: 102,
          qty: 5,
          isBuy: k % 2 === 0,
          id: `ohlcv-tail-${k}`,
        }]);
        const ohlcvTail = volumeProfileIndicatorDefinition.prepareData(ohlcvCtx);
        assert.equal(ohlcvTail.status, "ok");
        assert.equal(ohlcvTail.meta.result.provenance, "estimated");
        assert.equal(ohlcvTail.meta.result.exactBarCount, 0);
        assert.deepStrictEqual(ohlcvTail.meta.result, ohlcvFull(), `pure ohlcv live tail ${k}`);
      }
    } finally {
      resetFootprintSupport();
    }

    // Changing priceStep must invalidate the cached key rather than reusing step=1 bins.
    const step2Bars = Array.from({ length: 40 }, (_, i) =>
      ohlcvBar(T0 + i * MIN, 100, 103, 100, 102, 30 + (i % 5)),
    );
    const seriesStep2 = new FootprintSeries({ intervalMs: MIN, priceStep: 2 });
    seriesStep2.loadBars(step2Bars);
    const { drawCtx: ctxStep2 } = makeIndicatorCtx(seriesStep2, [10, 40], { mode: "visible" });
    ctxStep2.instance.id = drawCtx.instance.id;
    const preparedStep2 = volumeProfileIndicatorDefinition.prepareData(ctxStep2);
    assert.deepStrictEqual(
      preparedStep2.meta.result.levels.map((l) => l.priceBin),
      [100, 102],
      "step=2 produces bin widths of 2",
    );
  } finally {
    configurePerformanceTelemetry({ enabled: prevTelemetryEnabled });
  }
});
