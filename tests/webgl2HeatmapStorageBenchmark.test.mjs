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
});
