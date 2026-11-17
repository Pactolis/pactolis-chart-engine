import test from "node:test";
import assert from "node:assert/strict";
import { calculateOrderFlowProfile } from "../dist/core/analysis/orderFlowProfile.js";
import { calculateOrderFlowRangeProfile } from "../dist/core/analysis/rangeProfile.js";
import { chartLocale, configureChartLocale } from "../dist/core/chartLocale.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { drawAnalysisDrawings } from "../dist/core/render/analysisDrawings.js";
import { buildChartAnalysisSnapshot } from "../dist/features/chart/analysisSnapshot.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

const MINUTE = 60_000;
const BASE_TIME = Date.UTC(2024, 0, 1);
const options = {
  profileMetric: "volume",
  profileSide: "total",
  priceStep: 1,
  allowOhlcvEstimate: true,
  developing: true,
};

function ohlcvBar(index, low, high, volume) {
  return {
    startTime: BASE_TIME + index * MINUTE,
    open: low,
    high,
    low,
    close: high,
    volume,
    delta: 0,
    count: 0,
    hasRef: true,
    cells: new Map(),
  };
}

function exactBar(index, priceBin, buyVol, sellVol) {
  return {
    ...ohlcvBar(index, priceBin, priceBin + 1, buyVol + sellVol),
    cells: new Map([[priceBin, { priceBin, buyVol, sellVol, buyCount: 1, sellCount: 1, count: 2 }]]),
  };
}

function makeDrawingHarness(bars) {
  const series = new FootprintSeries({ intervalMs: MINUTE, priceStep: 1 });
  series.loadBars(bars);
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 16;
  view.offsetX = 0;
  view.priceTop = 110;
  view.pricePerPx = 0.1;
  const time = {
    indexForTime: (value) => series.indexOfTime(value),
    timeForIndex: (index) => series.timeOfIndex(index),
  };
  const texts = [];
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    fillRect() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
    fillText(text) { texts.push(String(text)); },
  };
  const drawing = {
    id: "frvp-test",
    type: "fixed-range-volume-profile",
    points: [
      { time: bars[0].startTime, price: bars[0].low },
      { time: bars.at(-1).startTime, price: bars.at(-1).high },
    ],
    color: "#ffffff",
    lineWidth: 1,
    locked: false,
    visible: true,
    market: "TEST:asset",
    profileMetric: "volume",
    profileSide: "total",
  };
  const draw = () => drawAnalysisDrawings(ctx, view, series, time, [drawing], drawing.market);
  return { series, drawing, texts, draw };
}

function configureLocale(tag) {
  configureChartLocale({
    locale: () => tag,
    timeZone: () => "UTC",
    translate: (key) => key,
    onLocaleChange: () => () => {},
  });
}

function profileSnapshot(series, drawing) {
  return buildChartAnalysisSnapshot({
    panelId: "frvp-tooltip-test",
    market: drawing.market,
    timeframe: "1m",
    intervalMs: MINUTE,
    selectionGeneration: 1,
    series,
    analysis: {
      market: drawing.market,
      profileSettings: { enabled: false, mode: "visible", valueAreaPercent: 0.7, showPoc: true, showVah: true, showVal: true },
      previousWeekStrategySettings: { enabled: false, visible: {}, groups: [], levels: [], labelFormat: "label", presets: [] },
      previousWeekStrategyLevels: [],
      mondayRangeSettings: { enabled: false, visible: {}, groups: [], levels: [], labelFormat: "label", presets: [] },
      mondayRangeLevels: [],
      nakedPocs: [],
      referenceLevels: [],
      drawings: { listForMarket: () => [drawing] },
    },
    analysisRevision: {
      revision: 1,
      market: drawing.market,
      canonical: { status: "complete", market: drawing.market, runKey: "frvp-tooltip-test", generation: 1, revision: 1, failedPeriods: [] },
    },
    indicators: [],
    options: { now: BASE_TIME + 5 * MINUTE },
  });
}

test("range profile estimates OHLCV-only windows but keeps partial footprint ranges exact", () => {
  const bars = [
    ohlcvBar(0, 100, 101, 10),
    ohlcvBar(1, 100, 102, 30),
    ohlcvBar(2, 101, 102, 20),
  ];
  const noFootprint = calculateOrderFlowRangeProfile(bars, BASE_TIME, BASE_TIME + 2 * MINUTE, options);
  assert.equal(noFootprint.provenance, "estimated");
  assert.equal(noFootprint.isEstimated, true);
  assert.equal(noFootprint.exactBarCount, 0);
  assert.equal(noFootprint.estimatedBarCount, 3);
  assert.equal(noFootprint.coveredBars, 0);
  assert.equal(noFootprint.coverage, 0);
  assert.equal(noFootprint.complete, false);
  assert.equal(noFootprint.dataComplete, true);
  assert.equal(noFootprint.totalVolume, 60);

  // Any exact footprint coverage preserves the existing exact-only behavior for
  // the whole selected range; the missing positive-volume bar remains a warning.
  const partialBars = [
    exactBar(0, 100, 9, 1),
    ohlcvBar(1, 100, 102, 30),
    exactBar(2, 101, 4, 6),
  ];
  const partial = calculateOrderFlowRangeProfile(partialBars, BASE_TIME, BASE_TIME + 2 * MINUTE, options);
  assert.equal(partial.provenance, "exact");
  assert.equal(partial.isEstimated, false);
  assert.equal(partial.exactBarCount, 2);
  assert.equal(partial.estimatedBarCount, 0);
  assert.equal(partial.coveredBars, 2);
  assert.equal(partial.coverage, 2 / 3);
  assert.deepEqual(partial.missingDays, [BASE_TIME]);
  assert.equal(partial.complete, false);
  assert.equal(partial.totalVolume, 20);
  assert.deepEqual(partial.levels.map((level) => level.priceBin), [100, 101]);

  const { texts, draw } = makeDrawingHarness(partialBars);
  configureLocale("en-US");
  draw();
  assert.ok(texts.includes("indicator.volumeProfile.coverageIncomplete"));
  assert.equal(texts.some((text) => /estimated/i.test(text)), false);
});

test("cell-less live bars with a zero-volume bar keep main exact profile, complete, and missingDays semantics", () => {
  const exact = exactBar(0, 100, 9, 1);
  const liveMissing = ohlcvBar(1, 100, 102, 30);
  const zeroVolumeMissing = {
    ...ohlcvBar(2, 101, 102, 0),
    startTime: BASE_TIME + 86_400_000,
  };
  const bars = [exact, liveMissing, zeroVolumeMissing];
  const expectedExact = calculateOrderFlowProfile([exact], options);
  const range = calculateOrderFlowRangeProfile(
    bars,
    BASE_TIME,
    zeroVolumeMissing.startTime,
    options,
  );

  const rangeProfile = Object.fromEntries(
    Object.keys(expectedExact).map((key) => [key, range[key]]),
  );
  assert.deepEqual(rangeProfile, expectedExact);
  assert.equal(range.provenance, "exact");
  assert.equal(range.complete, false);
  assert.deepEqual(range.missingDays, [BASE_TIME]);
  assert.equal(range.totalBars, 3);
  assert.equal(range.coveredBars, 1);

  const zeroVolumeOnlyGap = calculateOrderFlowRangeProfile(
    [exact, zeroVolumeMissing],
    BASE_TIME,
    zeroVolumeMissing.startTime,
    options,
  );
  assert.equal(zeroVolumeOnlyGap.complete, true);
  assert.deepEqual(zeroVolumeOnlyGap.missingDays, []);
});

test("full footprint range remains identical to the exact order-flow profile fixture", () => {
  const bars = [exactBar(0, 100, 8, 2), exactBar(1, 101, 4, 6), exactBar(2, 102, 7, 3)];
  const exact = calculateOrderFlowProfile(bars, options);
  const range = calculateOrderFlowRangeProfile(bars, BASE_TIME, BASE_TIME + 2 * MINUTE, options);
  assert.deepStrictEqual(range, {
    ...exact,
    requestedFrom: BASE_TIME,
    requestedTo: BASE_TIME + 2 * MINUTE,
    coveredBars: 3,
    totalBars: 3,
    coverage: 1,
    missingDays: [],
    complete: true,
  });
  assert.equal(range.provenance, "exact");
  assert.equal(range.isEstimated, false);
});

test("fixed-range label follows chartLocale, and footprint arrival invalidates the estimated cache", () => {
  const previousLocale = (() => {
    try { return chartLocale(); } catch { return null; }
  })();
  const wasTelemetryEnabled = isPerformanceTelemetryEnabled();
  const bars = [ohlcvBar(0, 100, 101, 10), ohlcvBar(1, 100, 102, 30), ohlcvBar(2, 101, 102, 20)];
  const { series, draw, texts } = makeDrawingHarness(bars);
  configurePerformanceTelemetry({ enabled: true });
  try {
    configureLocale("en-US");
    const before = snapshotPerformanceTelemetry().counters;
    draw();
    assert.ok(texts.includes("Estimated (OHLCV)"));
    const afterEstimate = snapshotPerformanceTelemetry().counters;
    assert.equal((afterEstimate["analysis.drawings.frvp.cache.miss"] ?? 0) - (before["analysis.drawings.frvp.cache.miss"] ?? 0), 1);

    draw();
    assert.equal((snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.hit"] ?? 0) - (afterEstimate["analysis.drawings.frvp.cache.hit"] ?? 0), 1);

    // Replacing the selected bars with exact cells changes the source mode and forces a fresh calculation.
    for (let index = 0; index < series.length; index++) {
      const bar = series.at(index);
      series.upsertBar({
        ...bar,
        cells: new Map([[bar.low, {
          priceBin: bar.low,
          buyVol: bar.volume * 0.6,
          sellVol: bar.volume * 0.4,
          buyCount: 3,
          sellCount: 2,
          count: 5,
        }]]),
      });
    }
    texts.length = 0;
    const beforeExact = snapshotPerformanceTelemetry().counters;
    draw();
    const afterExact = snapshotPerformanceTelemetry().counters;
    assert.equal((afterExact["analysis.drawings.frvp.cache.miss"] ?? 0) - (beforeExact["analysis.drawings.frvp.cache.miss"] ?? 0), 1);
    assert.ok(texts.every((text) => !/estimated|tahmini/i.test(text)));

    // The estimate badge also uses the active Turkish chart locale.
    for (let index = 0; index < series.length; index++) {
      const bar = series.at(index);
      series.upsertBar({ ...bar, cells: new Map() });
    }
    configureLocale("tr-TR");
    texts.length = 0;
    draw();
    assert.ok(texts.includes("Tahmini (OHLCV)"));
  } finally {
    configurePerformanceTelemetry({ enabled: wasTelemetryEnabled });
    if (previousLocale) configureChartLocale(previousLocale);
  }
});

test("Fixed Range analysis snapshot exposes a localized estimated tooltip label and preserves exact mode", () => {
  const previousLocale = (() => {
    try { return chartLocale(); } catch { return null; }
  })();
  const noFootprint = [ohlcvBar(0, 100, 101, 10), ohlcvBar(1, 100, 102, 30), ohlcvBar(2, 101, 102, 20)];
  const estimatedHarness = makeDrawingHarness(noFootprint);
  const exactHarness = makeDrawingHarness([exactBar(0, 100, 8, 2), exactBar(1, 101, 20, 10), exactBar(2, 102, 7, 3)]);
  try {
    configureLocale("en-US");
    const enDrawing = profileSnapshot(estimatedHarness.series, estimatedHarness.drawing).drawings[0];
    const enProfile = enDrawing.profile;
    assert.equal(enProfile.provenance, "estimated");
    assert.equal(enProfile.sourceLabel, "Estimated (OHLCV)");
    assert.ok(enDrawing.warnings.includes("Estimated (OHLCV)"));

    configureLocale("tr-TR");
    const trDrawing = profileSnapshot(estimatedHarness.series, estimatedHarness.drawing).drawings[0];
    const trProfile = trDrawing.profile;
    assert.equal(trProfile.provenance, "estimated");
    assert.equal(trProfile.sourceLabel, "Tahmini (OHLCV)");
    assert.ok(trDrawing.warnings.includes("Tahmini (OHLCV)"));

    const exactProfile = profileSnapshot(exactHarness.series, exactHarness.drawing).drawings[0].profile;
    assert.equal(exactProfile.poc, 101);
    assert.equal(exactProfile.sourceLabel, undefined);
    assert.equal(exactProfile.provenance, undefined);
  } finally {
    if (previousLocale) configureChartLocale(previousLocale);
  }
});
