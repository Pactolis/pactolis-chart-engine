import test from "node:test";
import assert from "node:assert/strict";
import { calculateAnchoredVwap } from "../dist/core/analysis/anchoredVwap.js";
import { drawAnalysisDrawings } from "../dist/core/render/analysisDrawings.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

function makeBar(index) {
  const price = 100 + (index % 17);
  return {
    startTime: index * 60000,
    open: price,
    high: price + 2,
    low: price - 1,
    close: price + 0.5,
    volume: 10 + (index % 5),
    delta: 0,
    count: 1,
    hasRef: true,
    cells: new Map(),
  };
}

function makeHarness(barCount) {
  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  series.loadBars(Array.from({ length: barCount }, (_, index) => makeBar(index)));
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = view.area.width - barCount * view.colWidth;
  view.priceTop = 1000;
  view.pricePerPx = 1;
  const time = {
    indexForTime: (t) => series.indexOfTime(t),
    timeForIndex: (idx) => series.timeOfIndex(idx),
  };
  let lastPlotted = null;
  const ctx = {
    save() {},
    restore() {},
    beginPath() { lastPlotted = null; },
    moveTo(x, y) { lastPlotted = [x, y]; },
    lineTo(x, y) { lastPlotted = [x, y]; },
    stroke() {},
    setLineDash() {},
  };
  const drawing = {
    id: "avwap-50k-benchmark",
    type: "anchored-vwap",
    points: [{ time: 0, price: 100 }],
    market: "BTC",
    visible: true,
    color: "#fff",
    showPriceLabel: true,
  };
  return { series, view, time, ctx, drawing, getLastPlotted: () => lastPlotted };
}

function wrapListReadonlyWithIndexCounter(series) {
  const originalListReadonly = series.listReadonly.bind(series);
  let indexedReads = 0;
  series.listReadonly = () => {
    const bars = originalListReadonly();
    return new Proxy(bars, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (idx >= 0 && idx < target.length) indexedReads++;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  return {
    originalListReadonly,
    getIndexedReads: () => indexedReads,
    restore: () => { series.listReadonly = originalListReadonly; },
  };
}

test("Issue #76 / #133: 50k-bar append updates AVWAP cache in O(1) without full recalculation", (t) => {
  const { series, view, time, ctx, drawing, getLastPlotted } = makeHarness(49744);
  const wasTelemetryEnabled = isPerformanceTelemetryEnabled();
  const baseMetrics = snapshotPerformanceTelemetry().metrics;
  const baseCalcCount = baseMetrics["analysis.drawings.avwap.calculate.ms"]?.count ?? 0;
  const baseAppendCount = baseMetrics["analysis.drawings.avwap.append.ms"]?.count ?? 0;

  configurePerformanceTelemetry({ enabled: true });
  let spy;
  try {
    let lastRenderedValue = null;
    const onLineObject = (price) => { lastRenderedValue = price; };

    // Build prefix/cache with one initial full calculation.
    drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC", onLineObject);
    const afterBuildMetrics = snapshotPerformanceTelemetry().metrics;
    assert.equal(
      (afterBuildMetrics["analysis.drawings.avwap.calculate.ms"]?.count ?? 0) - baseCalcCount,
      1,
      "initial cache build must perform exactly one full calculation",
    );
    assert.equal(
      (afterBuildMetrics["analysis.drawings.avwap.append.ms"]?.count ?? 0) - baseAppendCount,
      0,
      "initial cache build must not use the append path",
    );

    spy = wrapListReadonlyWithIndexCounter(series);
    let maxReadsPerAppend = 0;
    for (let index = 49744; index < 50000; index++) {
      const readsBefore = spy.getIndexedReads();
      series.upsertBar(makeBar(index));
      view.offsetX = view.area.width - series.length * view.colWidth;
      drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC", onLineObject);
      const deltaReads = spy.getIndexedReads() - readsBefore;
      if (deltaReads > maxReadsPerAppend) maxReadsPerAppend = deltaReads;
    }
    const totalAppendIndexedReads = spy.getIndexedReads();
    spy.restore();

    const afterAppendMetrics = snapshotPerformanceTelemetry().metrics;
    const calcDelta = (afterAppendMetrics["analysis.drawings.avwap.calculate.ms"]?.count ?? 0) - baseCalcCount;
    const appendMetric = afterAppendMetrics["analysis.drawings.avwap.append.ms"];
    const appendDelta = (appendMetric?.count ?? 0) - baseAppendCount;

    assert.equal(calcDelta, 1, "appends must not trigger any additional full recalculation");
    assert.equal(appendDelta, 256, "every append must take the incremental path");
    assert.ok(maxReadsPerAppend <= 4, `each append must read <= 4 bar indices, observed ${maxReadsPerAppend}`);
    assert.ok(
      totalAppendIndexedReads > 0 && totalAppendIndexedReads <= 1024,
      `expected <= 1024 indexed reads across 256 O(1) appends (O(n) would read >12.8M), observed ${totalAppendIndexedReads}`,
    );

    const oracle = calculateAnchoredVwap(series.listReadonly(), 0);
    const oracleLast = oracle.points[oracle.points.length - 1]?.value;
    assert.equal(oracle.points.length, 50000);
    assert.ok(Number.isFinite(oracleLast), "oracle final AVWAP value must be finite");
    assert.ok(Number.isFinite(lastRenderedValue), "incremental final AVWAP value must be finite");
    assert.equal(lastRenderedValue, oracleLast, "incremental final AVWAP must match full calculation oracle");
    assert.deepEqual(
      getLastPlotted(),
      [view.xOfIndex(49999) + view.colWidth / 2, view.yOfPrice(oracleLast)],
      "plotted tail point must match full calculation oracle",
    );

    t.diagnostic(
      `50k-bar AVWAP append p50: ${(appendMetric.p50Ms * 1000).toFixed(3)}us, ` +
      `indexedReads: ${totalAppendIndexedReads} (max/append: ${maxReadsPerAppend})`,
    );
  } finally {
    spy?.restore();
    configurePerformanceTelemetry({ enabled: wasTelemetryEnabled });
  }
});

test("Issue #133: indexed-read and telemetry guards catch full O(n) recalculation on non-tail mutation", () => {
  const { series, view, time, ctx, drawing } = makeHarness(2000);
  const wasTelemetryEnabled = isPerformanceTelemetryEnabled();
  const baseMetrics = snapshotPerformanceTelemetry().metrics;
  const baseCalcCount = baseMetrics["analysis.drawings.avwap.calculate.ms"]?.count ?? 0;

  configurePerformanceTelemetry({ enabled: true });
  let spy;
  try {
    drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC");
    spy = wrapListReadonlyWithIndexCounter(series);

    // Mutating bar 0 bumps nonTailRevision, forcing full O(n) recalculation.
    series.upsertBar({ ...makeBar(0), open: 200, high: 202, low: 199, close: 200.5 });
    drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC");

    const calcDelta = (snapshotPerformanceTelemetry().metrics["analysis.drawings.avwap.calculate.ms"]?.count ?? 0) - baseCalcCount;
    assert.equal(calcDelta, 2, "non-tail mutation must trigger full recalculation");
    assert.ok(
      spy.getIndexedReads() >= 2000,
      `full recalculation must scan the series (>= 2000 indexed reads), observed ${spy.getIndexedReads()}`,
    );
  } finally {
    spy?.restore();
    configurePerformanceTelemetry({ enabled: wasTelemetryEnabled });
  }
});
