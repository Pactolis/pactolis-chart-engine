import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state = (value) => value;

const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { drawAnalysisDrawings } = await import("../dist/core/render/analysisDrawings.js");
const {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} = await import("../dist/core/performanceTelemetry.js");

const INTERVAL_MS = 60_000;
const BASE_TIME = 1_700_000_040_000; // aligned to 60_000
const MAP_SIZE_GETTER = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;

function createCanvasMock() {
  return {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    setLineDash() {},
    beginPath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    fillText() {},
    measureText(text) {
      return { width: String(text).length * 6 };
    },
  };
}

function createViewMock(series) {
  return {
    area: { left: 0, top: 0, width: 1200, height: 600 },
    colWidth: 8,
    priceAxisW: 60,
    xOfIndex: (index) => index * 8,
    indexOfX: (x) => x / 8,
    yOfPrice: (price) => 500 - (price - 90) * 10,
    priceRange: () => ({ minValue: () => 90, maxValue: () => 120 }),
    series,
  };
}

function createTimeContext(series) {
  return {
    indexForTime: (time) => series.indexOfTime(time),
  };
}

function makeBar(index, withCells) {
  const startTime = BASE_TIME + index * INTERVAL_MS;
  const cells = new Map();
  if (withCells) {
    cells.set(100, {
      priceBin: 100,
      buyVol: 6,
      sellVol: 4,
      count: 2,
      buyCount: 1,
      sellCount: 1,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
    });
    cells.set(101, {
      priceBin: 101,
      buyVol: 3,
      sellVol: 2,
      count: 1,
      buyCount: 1,
      sellCount: 0,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
    });
  }
  return {
    startTime,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 15,
    delta: 5,
    count: 3,
    liquidationBuyVol: 0,
    liquidationSellVol: 0,
    cells,
    hasRef: true,
    cellRevision: withCells ? 1 : 0,
  };
}

function instrumentCellsSizeCounter(bars, counter) {
  for (const bar of bars) {
    Object.defineProperty(bar.cells, "size", {
      configurable: true,
      get() {
        counter.reads += 1;
        return MAP_SIZE_GETTER.call(this);
      },
    });
  }
}

function makeFrvpDrawing(fromTime, toTime) {
  return {
    id: "frvp-1",
    type: "fixed-range-volume-profile",
    visible: true,
    market: "BTCUSDT",
    points: [
      { time: fromTime, price: 99 },
      { time: toTime, price: 102 },
    ],
    color: "#ffffff",
    lineWidth: 1,
    showPoc: true,
    showValueArea: true,
  };
}

function setupSeries(withCells, count = 2501) {
  const series = new FootprintSeries({ intervalMs: INTERVAL_MS, priceStep: 1 });
  const bars = [];
  for (let i = 0; i < count; i++) {
    bars.push(makeBar(i, withCells));
  }
  series.loadBars(bars);
  return { series, bars };
}

for (const withCells of [false, true]) {
  const modeLabel = withCells ? "footprint exact" : "OHLCV-only estimated";

  test(`FRVP (${modeLabel}): 20 live trades on out-of-range bar 2501 trigger 0 historical cells.size reads and 20 cache hits`, () => {
    configurePerformanceTelemetry({ enabled: true });
    resetPerformanceTelemetry();

    const { series } = setupSeries(withCells, 2501);
    const listBars = series.listReadonly();
    const sizeCounter = { reads: 0 };
    instrumentCellsSizeCounter(listBars.slice(0, 2500), sizeCounter);

    const fromTime = BASE_TIME;
    const toTime = BASE_TIME + 2499 * INTERVAL_MS;
    const drawing = makeFrvpDrawing(fromTime, toTime);
    const canvas = createCanvasMock();
    const view = createViewMock(series);
    const timeCtx = createTimeContext(series);

    // Initial render -> cache miss
    drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
    let snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["analysis.drawings.frvp.cache.miss"], 1);
    assert.equal(snap.counters["analysis.drawings.frvp.cache.hit"] ?? 0, 0);

    // Reset counters before 20 live out-of-range trades on bar 2500
    sizeCounter.reads = 0;
    resetPerformanceTelemetry();

    const liveBarTime = BASE_TIME + 2500 * INTERVAL_MS;
    for (let t = 0; t < 20; t++) {
      series.addTrade({
        id: 10_000 + t,
        time: liveBarTime + t * 100,
        price: 101,
        qty: 1,
        isBuy: t % 2 === 0,
      });
      drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
    }

    snap = snapshotPerformanceTelemetry();
    assert.equal(
      sizeCounter.reads,
      0,
      `${modeLabel}: expected 0 historical cells.size reads across 20 out-of-range live redraws, got ${sizeCounter.reads}`,
    );
    assert.equal(snap.counters["analysis.drawings.frvp.cache.hit"], 20);
    assert.equal(snap.counters["analysis.drawings.frvp.cache.miss"] ?? 0, 0);
  });
}

test("FRVP safely recomputes on in-range repair, OHLCV->footprint transition, prepend, replace, anchor, priceStep, and in-range live trade", () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const { series } = setupSeries(false, 2501);
  const fromTime = BASE_TIME;
  const toTime = BASE_TIME + 2499 * INTERVAL_MS;
  const drawing = makeFrvpDrawing(fromTime, toTime);
  const canvas = createCanvasMock();
  const view = createViewMock(series);
  const timeCtx = createTimeContext(series);

  // 1. Initial miss
  drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // 2. In-range repair via replaceRange
  resetPerformanceTelemetry();
  const repairedBar = makeBar(100, false);
  repairedBar.volume = 999;
  series.replaceRange(repairedBar.startTime, repairedBar.startTime + INTERVAL_MS, [repairedBar]);
  drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // 3. OHLCV -> footprint transition on an in-range bar
  resetPerformanceTelemetry();
  const exactBar = makeBar(200, true);
  series.replaceRange(exactBar.startTime, exactBar.startTime + INTERVAL_MS, [exactBar]);
  drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // 4. Prepend before range
  resetPerformanceTelemetry();
  const prependedBar = makeBar(-1, false);
  series.upsertBar(prependedBar);
  drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // 5. Replace inside range
  resetPerformanceTelemetry();
  const replacedBar = makeBar(500, true);
  replacedBar.volume = 420;
  series.replaceRange(replacedBar.startTime, replacedBar.startTime + INTERVAL_MS, [replacedBar]);
  drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // 6. Anchor change
  resetPerformanceTelemetry();
  drawing.points[1].time = BASE_TIME + 2498 * INTERVAL_MS;
  drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // 7. priceStep change
  resetPerformanceTelemetry();
  series.setPriceStep(2);
  const reloaded = [];
  for (let i = 0; i < 2501; i++) reloaded.push(makeBar(i, true));
  series.loadBars(reloaded);
  drawAnalysisDrawings(canvas, view, series, timeCtx, [drawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);

  // 8. In-range live trade (tail bar inside range)
  const { series: inRangeSeries } = setupSeries(true, 100);
  const inRangeDrawing = makeFrvpDrawing(BASE_TIME, BASE_TIME + 99 * INTERVAL_MS);
  const inRangeView = createViewMock(inRangeSeries);
  const inRangeTimeCtx = createTimeContext(inRangeSeries);
  drawAnalysisDrawings(canvas, inRangeView, inRangeSeries, inRangeTimeCtx, [inRangeDrawing], "BTCUSDT");
  resetPerformanceTelemetry();

  inRangeSeries.addTrade({
    id: 99_999,
    time: BASE_TIME + 99 * INTERVAL_MS + 500,
    price: 101,
    qty: 5,
    isBuy: true,
  });
  drawAnalysisDrawings(canvas, inRangeView, inRangeSeries, inRangeTimeCtx, [inRangeDrawing], "BTCUSDT");
  assert.equal(snapshotPerformanceTelemetry().counters["analysis.drawings.frvp.cache.miss"], 1);
});
