import test from "node:test";
import assert from "node:assert/strict";
import { OrderbookHeatmapOverlay } from "../dist/features/orderbook/heatmapOverlay.js";
import { configureOrderbookHeatmapSettingsSource } from "../dist/features/orderbook/heatmapSettingsSource.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

// The CPU prepare of the GPU heatmap path reports `chart.gpu.heatmap.prepare.ms`
// for every active production frame, and costs nothing while telemetry is off.

const METRIC = "chart.gpu.heatmap.prepare.ms";
const MARKET = "BINANCE_FUTURES:btcusdt";
const INTERVAL = 15 * 60_000;
const BARS = 10;
const BASE = Date.UTC(2026, 9, 1);
const NOW = BASE + BARS * INTERVAL;
const RANGE = [0, BARS - 1];

let mode = "single";
configureOrderbookHeatmapSettingsSource({
  settingsFor: () => ({
    mode, unit: "usd", bucketStep: 25,
    single: { usd: 1, btc: 1 }, aggregated: { usd: 1, btc: 1 },
  }),
  onChange: () => () => {},
});

// Three walls per bar, all inside the plot; the last bar also gets its live extension.
const WALLS = [[100, 600, 400], [125, 900, 100], [150, 300, 300]];
const series = { length: BARS, config: { intervalMs: INTERVAL }, timeOfIndex: (index) => BASE + index * INTERVAL };
const view = {
  area: { left: 0, top: 0, width: 400, height: 300 },
  colWidth: 20,
  xOfIndex: (index) => index * 20,
  yOfPrice: (price) => 300 - (price - 100),
};
const grant = () => ({ release() {} });

const sampleCount = () => snapshotPerformanceTelemetry().metrics[METRIC]?.count ?? 0;

function withTelemetry(enabled, work) {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled });
  try {
    return work();
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
}

/** An overlay whose visible chunk has been acknowledged, so the next frame has walls to prepare. */
async function loadedOverlay() {
  const overlay = new OrderbookHeatmapOverlay({
    fetch: async (request) => ({
      schemaVersion: 1, generatedAt: NOW, base: "BTC", source: request.source, resolution: request.resolution,
      bucketStep: request.bucketStep, from: request.from, to: request.to,
      bars: Array.from({ length: BARS }, (_, index) => ({ t: BASE + index * INTERVAL, cells: WALLS })),
    }),
    invalidate: () => {},
    getMarket: () => MARKET,
    now: () => NOW,
  });
  // The first frame schedules the chunk; the answer lands before the next one.
  withTelemetry(false, () => overlay.prepareGpuCells(view, series, RANGE, grant));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return overlay;
}

test("an active production frame records one prepare sample and the frame is unchanged", async () => {
  const overlay = await loadedOverlay();
  try {
    const off = withTelemetry(false, () => overlay.prepareGpuCells(view, series, RANGE, grant));
    const before = sampleCount();
    const on = withTelemetry(true, () => overlay.prepareGpuCells(view, series, RANGE, grant));
    assert.equal(sampleCount() - before, 1);
    const snapshot = snapshotPerformanceTelemetry().metrics[METRIC];
    assert.ok(Number.isFinite(snapshot.p95Ms) && snapshot.p95Ms >= 0 && snapshot.maxMs >= snapshot.minMs);
    assert.equal(on.main.length, BARS * WALLS.length);
    assert.equal(on.extension.length, WALLS.length);
    const shape = ({ main, extension, ceiling, threshold, dataKey }) => ({ main, extension, ceiling, threshold, dataKey });
    assert.deepEqual(shape(on), shape(off));
  } finally {
    overlay.dispose();
  }
});

test("telemetry off reads no clock; on reads it twice per frame", async (t) => {
  const overlay = await loadedOverlay();
  try {
    let reads = 0;
    const realNow = performance.now.bind(performance);
    t.mock.method(performance, "now", () => { reads++; return realNow(); });
    withTelemetry(false, () => overlay.prepareGpuCells(view, series, RANGE, grant));
    assert.equal(reads, 0);
    withTelemetry(true, () => overlay.prepareGpuCells(view, series, RANGE, grant));
    assert.equal(reads, 2);
  } finally {
    overlay.dispose();
  }
});

test("an inactive heatmap prepares nothing and records nothing", async () => {
  const overlay = await loadedOverlay();
  try {
    mode = "off";
    const before = sampleCount();
    const frame = withTelemetry(true, () => overlay.prepareGpuCells(view, series, RANGE, grant));
    assert.equal(frame, null);
    assert.equal(sampleCount(), before);
  } finally {
    mode = "single";
    overlay.dispose();
  }
});

test("a denied reservation still records the precount it paid for", async () => {
  const overlay = await loadedOverlay();
  try {
    const requested = [];
    const before = sampleCount();
    const frame = withTelemetry(true, () => overlay.prepareGpuCells(view, series, RANGE, (bytes) => {
      requested.push(bytes);
      return null;
    }));
    assert.equal(frame, null);
    assert.equal(requested.length, 1);
    assert.ok(requested[0] > 0);
    assert.equal(sampleCount() - before, 1);
  } finally {
    overlay.dispose();
  }
});

test("a throwing reservation still records and rethrows", async () => {
  const overlay = await loadedOverlay();
  try {
    const before = sampleCount();
    assert.throws(() => withTelemetry(true, () => overlay.prepareGpuCells(view, series, RANGE, () => {
      throw new Error("reserve failed");
    })), /reserve failed/);
    assert.equal(sampleCount() - before, 1);
  } finally {
    overlay.dispose();
  }
});
