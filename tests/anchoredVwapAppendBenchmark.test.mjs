import test from "node:test";
import assert from "node:assert/strict";
import { drawAnalysisDrawings } from "../dist/core/render/analysisDrawings.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { View } from "../dist/core/engine/view.js";
import { configurePerformanceTelemetry, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";

test("Issue #76: 50k-bar append cache calculation stays under 5us", () => {
  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  const makeBar = (index) => ({
    startTime: index * 60000, open: 100, high: 101, low: 99, close: 100,
    volume: 10, delta: 0, count: 1, hasRef: true, cells: new Map(),
  });
  series.loadBars(Array.from({ length: 49744 }, (_, index) => makeBar(index)));
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.priceTop = 1000;
  view.pricePerPx = 1;
  const time = {
    indexForTime: (t) => series.indexOfTime(t),
    timeForIndex: (idx) => series.timeOfIndex(idx),
  };
  const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {} };
  const drawing = { id: "avwap-50k-benchmark", type: "anchored-vwap", points: [{ time: 0, price: 100 }], market: "BTC", visible: true, color: "#fff", showPriceLabel: false };

  configurePerformanceTelemetry({ enabled: true });
  drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC"); // Build prefix/cache outside the measured appends.
  for (let index = 49744; index < 50000; index++) {
    series.upsertBar(makeBar(index));
    drawAnalysisDrawings(ctx, view, series, time, [drawing], "BTC");
  }
  const metric = snapshotPerformanceTelemetry().metrics["analysis.drawings.avwap.append.ms"];
  assert.equal(metric?.count, 256, "every append must take the incremental path");
  console.log(`50k-bar AVWAP append p50: ${(metric.p50Ms * 1000).toFixed(3)}us`);
  assert.ok(metric.p50Ms < 0.005, `50k-bar AVWAP append p50 was ${(metric.p50Ms * 1000).toFixed(3)}us; expected <5us`);
  configurePerformanceTelemetry({ enabled: false });
});
