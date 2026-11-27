import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { calculateVwapSeries } from "../dist/core/analysis/vwap.js";
import { vwapIndicatorDefinition } from "../dist/features/indicators/builtins/vwapIndicator.js";
import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const DAY = 86_400_000;
const INTERVAL = 3_600_000;
const BASE_TIME = Date.UTC(2024, 0, 1);

function makeSeries(barCount) {
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const p = 100 + Math.sin(i * 0.25) * 4;
    bars.push({
      startTime: BASE_TIME + i * INTERVAL,
      open: p,
      high: p + 1.5,
      low: p - 1.5,
      close: p + 0.25,
      volume: 10 + (i % 7),
      delta: 1,
      count: 2,
      cells: new Map(),
      completeness: "complete",
    });
  }
  series.loadBars(bars);
  return series;
}

function makeCtx(series, instance, range) {
  return {
    ctx: null,
    view: {
      area: { left: 0, top: 0, width: 800, height: 400 },
      indexOfX: () => 0,
      xOfIndex: (i) => i * 10,
      priceOfY: (y) => 100,
      yOfPrice: (p) => 200,
      colWidth: 10,
    },
    series,
    rect: { top: 0, height: 400 },
    range,
    instance,
    settings: instance.settings,
    chart: { market: "BINANCE_FUTURES:btcusdt", timeframe: "1h", intervalMs: INTERVAL },
    requestRefresh() {},
  };
}

test("#409: VWAP tail incremental path supports rolling, previous, current, and bands", async () => {
  const source = await read("src/features/indicators/builtins/vwapIndicator.ts");

  assert.doesNotMatch(source, /lines\.every\(\(line\) => line\.family === "current" && !line\.showBands\)/);
  assert.match(source, /buildLineTailState/);
  assert.match(source, /vwapBandsWithPrefix/);
  assert.match(source, /indicatorPriceSeriesMutation\(ctx\.series\)/);
  assert.match(source, /indicator\.prepare\.incremental\.vwap/);
  assert.match(source, /indicator\.incremental\.hit\.vwap/);
  assert.match(source, /calculateVwapSeries\(bars, lines\.map\(definitionForLine\)\)/);
});

test("#409: VWAP incremental tail updates match calculateVwapSeries for current, rolling, previous, and bands", () => {
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const series = makeSeries(72); // 3 days of 1h bars
  const instance = {
    id: "vwap-all-families",
    type: "vwap",
    visible: true,
    settings: {
      lineWidth: 1.5,
      showLastValueLabel: true,
      showPlotLabel: true,
      showChartLabels: false,
      lines: [
        { id: "c1", enabled: true, family: "current", period: "daily", rollingWindowDays: 1, color: "#fff", showBands: true, bandSigma: 1.5, bandColor: "#aaa" },
        { id: "r1", enabled: true, family: "rolling", period: "daily", rollingWindowDays: 1, color: "#0f0", showBands: true, bandSigma: 1, bandColor: "#0a0" },
        { id: "p1", enabled: true, family: "previous", period: "daily", rollingWindowDays: 1, color: "#00f", showBands: false, bandSigma: 1, bandColor: "#00a" },
      ],
    },
  };

  // Initial full build
  vwapIndicatorDefinition.prepareData(makeCtx(series, instance, [0, series.length]));
  const fullCallsBefore = snapshotPerformanceTelemetry().counters["indicator.incremental.full.vwap"] ?? 0;

  // 1. Live intra-bar tail tick on last bar
  const lastTime = BASE_TIME + 71 * INTERVAL;
  series.addTrade({ time: lastTime + 5_000, price: 112, qty: 25, isBuy: true, liquidation: false, source: "live" });
  const afterTick = vwapIndicatorDefinition.prepareData(makeCtx(series, instance, [0, series.length]));

  // 2. Append a new bar via live rollover trade crossing into next day
  const rolloverTime = BASE_TIME + 72 * INTERVAL;
  series.addTrade({
    time: rolloverTime + 5_000,
    price: 114,
    qty: 42,
    isBuy: true,
    liquidation: false,
    source: "live",
  });
  const afterAppend = vwapIndicatorDefinition.prepareData(makeCtx(series, instance, [0, series.length]));

  const snap = snapshotPerformanceTelemetry();
  assert.equal(snap.counters["indicator.incremental.full.vwap"], fullCallsBefore, "tail tick + append must not fall back to full compute");
  assert.ok((snap.counters["indicator.incremental.hit.vwap"] ?? 0) >= 2);

  // Verify numeric parity against clean calculateVwapSeries on a fresh uncached instance
  const refInstance = { ...instance, id: "vwap-ref-fresh", settings: structuredClone(instance.settings) };
  const ref = vwapIndicatorDefinition.prepareData(makeCtx(series, refInstance, [0, series.length]));
  assert.equal(afterAppend.meta.series.length, ref.meta.series.length);
  for (let s = 0; s < ref.meta.series.length; s++) {
    const incPts = afterAppend.meta.series[s].points;
    const refPts = ref.meta.series[s].points;
    assert.equal(incPts.length, refPts.length);
    for (let i = 0; i < refPts.length; i++) {
      if (refPts[i].value === null) {
        assert.equal(incPts[i].value, null);
      } else {
        assert.ok(Math.abs(incPts[i].value - refPts[i].value) < 1e-9, `series ${s} idx ${i} mismatch`);
      }
    }
  }
  // Confirm afterTick had valid points too
  assert.equal(afterTick.status, "ok");

  // Cross-check rolling value directly against calculateVwapSeries
  const direct = calculateVwapSeries(series.listReadonly(), [
    { id: "rolling-24h", family: "rolling", label: "R1D", color: "#0f0", windowMs: DAY },
  ]);
  const incRolling = afterAppend.meta.series.find((s) => s.key === "vwap-r1");
  assert.ok(incRolling);
  const lastIdx = direct[0].points.length - 1;
  assert.ok(Math.abs(incRolling.points[lastIdx].value - direct[0].points[lastIdx].value) < 1e-9);
});
