import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateWebGl2StorageDecision,
  formatWebGl2HeatmapStorageMarkdown,
  medianOf,
  resolveWebGl2HeatmapStorageFixture,
  summarizeMetricValues,
  WEBGL2_HEATMAP_STORAGE_VARIANTS,
  WEBGL2_HEATMAP_STORAGE_WORKLOADS,
} from "../harness/webgl2HeatmapStorageBenchmark.mjs";

test("resolveWebGl2HeatmapStorageFixture configures hardware and CI smoke matrices", () => {
  assert.deepEqual(WEBGL2_HEATMAP_STORAGE_VARIANTS, ["mutable", "immutable", "bucket"]);
  assert.deepEqual(WEBGL2_HEATMAP_STORAGE_WORKLOADS, ["static", "fixed-update", "resize"]);

  const hw = resolveWebGl2HeatmapStorageFixture({ hardwareMode: true });
  assert.deepEqual(hw.chartCounts, [1, 8]);
  assert.equal(hw.repetitions, 3);
  assert.equal(hw.warmupFrames, 16);
  assert.equal(hw.measuredFrames, 36);
  assert.equal(hw.staticCells, 40_000);
  assert.deepEqual(hw.resizePattern, [15_000, 40_000, 16_000, 39_000]);

  const ci = resolveWebGl2HeatmapStorageFixture({ hardwareMode: false });
  assert.deepEqual(ci.chartCounts, [1]);
  assert.equal(ci.repetitions, 1);
  assert.equal(ci.warmupFrames, 4);
  assert.equal(ci.measuredFrames, 8);
  assert.equal(ci.staticCells, 4_000);
  assert.deepEqual(ci.resizePattern, [1_500, 4_000, 1_600, 3_900]);

  const custom = resolveWebGl2HeatmapStorageFixture({ hardwareMode: true, chartCounts: "2,4" });
  assert.deepEqual(custom.chartCounts, [2, 4]);
});

test("summarizeMetricValues and medianOf compute quantiles cleanly", () => {
  const s = summarizeMetricValues([10, 2, 6, 4, 8]);
  assert.equal(s.count, 5);
  assert.equal(s.p50Ms, 6);
  assert.equal(s.p95Ms, 10);
  assert.equal(s.meanMs, 6);
  assert.equal(medianOf([12, 4, 8, 10]), 9);
  assert.equal(medianOf([]), 0);
});

test("evaluateWebGl2StorageDecision distinguishes HARDWARE_INVALID, RECOMMEND_IMPLEMENT, and RECOMMEND_NOT_PLANNED", () => {
  assert.equal(evaluateWebGl2StorageDecision({ hardwareValid: false, rows: [] }).decision, "HARDWARE_INVALID");

  const fasterRows = [
    { chartCount: 8, workload: "resize", variant: "mutable", frame: { p50Ms: 5, p95Ms: 12 }, gpu: { count: 0 }, textureAllocCount: 576, texturePayloadPeakMiB: 2, glError: 0 },
    { chartCount: 8, workload: "resize", variant: "immutable", frame: { p50Ms: 4.5, p95Ms: 11 }, gpu: { count: 0 }, textureAllocCount: 576, texturePayloadPeakMiB: 2, glError: 0 },
    { chartCount: 8, workload: "resize", variant: "bucket", frame: { p50Ms: 3.0, p95Ms: 8.0 }, gpu: { count: 0 }, textureAllocCount: 32, texturePayloadPeakMiB: 2.5, glError: 0 },
  ];
  const rec = evaluateWebGl2StorageDecision({ hardwareValid: true, rows: fasterRows });
  assert.equal(rec.decision, "RECOMMEND_IMPLEMENT");
  assert.equal(rec.comparisons[0].speedupBucketVsMutable, 1.5);

  const flatRows = [
    { chartCount: 1, workload: "resize", variant: "mutable", frame: { p50Ms: 2, p95Ms: 4.0 }, gpu: { count: 0 }, textureAllocCount: 72, texturePayloadPeakMiB: 0.25, glError: 0 },
    { chartCount: 1, workload: "resize", variant: "immutable", frame: { p50Ms: 2, p95Ms: 4.0 }, gpu: { count: 0 }, textureAllocCount: 72, texturePayloadPeakMiB: 0.25, glError: 0 },
    { chartCount: 1, workload: "resize", variant: "bucket", frame: { p50Ms: 2, p95Ms: 3.9 }, gpu: { count: 0 }, textureAllocCount: 4, texturePayloadPeakMiB: 0.3125, glError: 0 },
  ];
  assert.equal(evaluateWebGl2StorageDecision({ hardwareValid: true, rows: flatRows }).decision, "RECOMMEND_NOT_PLANNED");

  const md = formatWebGl2HeatmapStorageMarkdown({
    runId: "2026-11-23T00-00-00Z",
    createdAt: "2026-11-23T00:00:00Z",
    fixture: { hardwareMode: true },
    webglInfo: { unmaskedVendor: "Intel", unmaskedRenderer: "Intel UHD 620" },
    hardwareValid: true,
    rows: fasterRows,
    assessment: rec,
  });
  assert.match(md, /RECOMMEND_IMPLEMENT/);
  assert.match(md, /Intel UHD 620/);
  assert.match(md, /\| 8 \| resize \| bucket \|/);

  // Intel UHD 620 pattern: sub-ms 1-chart resize noise + 8-chart fixed-update regression + 8-chart resize miss
  const uhd620Rows = [
    { chartCount: 1, workload: "resize", variant: "mutable", frame: { p50Ms: 1.8, p95Ms: 3.6 }, gpu: { count: 36, p95Ms: 11.09 }, textureAllocCount: 312, texturePayloadPeakMiB: 0.1953, glError: 0 },
    { chartCount: 1, workload: "resize", variant: "immutable", frame: { p50Ms: 1.8, p95Ms: 3.7 }, gpu: { count: 36, p95Ms: 10.935 }, textureAllocCount: 312, texturePayloadPeakMiB: 0.1953, glError: 0 },
    { chartCount: 1, workload: "resize", variant: "bucket", frame: { p50Ms: 1.7, p95Ms: 3.2 }, gpu: { count: 36, p95Ms: 11.024 }, textureAllocCount: 4, texturePayloadPeakMiB: 0.3125, glError: 0 },
    { chartCount: 8, workload: "fixed-update", variant: "mutable", frame: { p50Ms: 16.5, p95Ms: 21.1 }, gpu: { count: 36, p95Ms: 5.224 }, textureAllocCount: 16, texturePayloadPeakMiB: 1.5625, glError: 0 },
    { chartCount: 8, workload: "fixed-update", variant: "immutable", frame: { p50Ms: 17.0, p95Ms: 22.8 }, gpu: { count: 36, p95Ms: 5.138 }, textureAllocCount: 16, texturePayloadPeakMiB: 1.5625, glError: 0 },
    { chartCount: 8, workload: "fixed-update", variant: "bucket", frame: { p50Ms: 30.0, p95Ms: 36.0 }, gpu: { count: 36, p95Ms: 4.88 }, textureAllocCount: 16, texturePayloadPeakMiB: 2.5, glError: 0 },
    { chartCount: 8, workload: "resize", variant: "mutable", frame: { p50Ms: 27.7, p95Ms: 47.3 }, gpu: { count: 36, p95Ms: 5.376 }, textureAllocCount: 2496, texturePayloadPeakMiB: 1.5625, glError: 0 },
    { chartCount: 8, workload: "resize", variant: "immutable", frame: { p50Ms: 28.6, p95Ms: 47.8 }, gpu: { count: 36, p95Ms: 5.531 }, textureAllocCount: 2496, texturePayloadPeakMiB: 1.5625, glError: 0 },
    { chartCount: 8, workload: "resize", variant: "bucket", frame: { p50Ms: 27.3, p95Ms: 49.4 }, gpu: { count: 36, p95Ms: 5.181 }, textureAllocCount: 32, texturePayloadPeakMiB: 2.5, glError: 0 },
  ];
  assert.equal(evaluateWebGl2StorageDecision({ hardwareValid: true, rows: uhd620Rows }).decision, "RECOMMEND_NOT_PLANNED");

  // Non-zero glError must reject implementation
  const glErrorRows = fasterRows.map((row) =>
    row.variant === "bucket" ? { ...row, glError: 1282 } : row,
  );
  assert.equal(evaluateWebGl2StorageDecision({ hardwareValid: true, rows: glErrorRows }).decision, "RECOMMEND_NOT_PLANNED");
});
