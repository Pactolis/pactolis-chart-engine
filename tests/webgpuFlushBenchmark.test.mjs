import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDenseFootprintBars,
  buildWebGpuFlushAssessment,
  WEBGPU_FLUSH_DECISION_RULE,
  WEBGPU_FLUSH_FIXTURE,
  WEBGPU_FLUSH_SCENARIOS,
} from "../harness/webgpuFlushBenchmark.mjs";

function backendWithFlushMean(meanMs) {
  return {
    scenarios: Object.fromEntries(WEBGPU_FLUSH_SCENARIOS.map((scenario) => [scenario, {
      combined: {
        "chart.gpu.flush.ms": { count: 20, meanMs, p50Ms: meanMs, p95Ms: meanMs, p99Ms: meanMs },
      },
    }])),
  };
}

test("WebGPU flush assessment returns GO when all scenario means meet the fixed 2x rule", () => {
  const assessment = buildWebGpuFlushAssessment({
    hardwareValid: true,
    webgl2: backendWithFlushMean(0.05),
    webgpu: backendWithFlushMean(0.1),
  });
  assert.equal(assessment.decision, "GO");
  assert.equal(assessment.comparisons.length, 3);
  assert.ok(assessment.comparisons.every((item) => item.within2xBudget === true));
});

test("WebGPU flush assessment returns NO-GO when any scenario exceeds the fixed 2x rule", () => {
  const webgpu = backendWithFlushMean(0.1);
  webgpu.scenarios.live.combined["chart.gpu.flush.ms"].meanMs = 0.101;
  const assessment = buildWebGpuFlushAssessment({
    hardwareValid: true,
    webgl2: backendWithFlushMean(0.05),
    webgpu,
  });
  assert.equal(assessment.decision, "NO_GO");
  assert.equal(assessment.display, "NO-GO, P3 kalır");
  assert.equal(assessment.comparisons.find((item) => item.scenario === "live")?.within2xBudget, false);
});

test("WebGPU flush assessment marks software or unavailable hardware invalid without deciding", () => {
  const assessment = buildWebGpuFlushAssessment({
    hardwareValid: false,
    webgl2: backendWithFlushMean(0.05),
    webgpu: backendWithFlushMean(0.05),
  });
  assert.equal(assessment.decision, "HARDWARE_INVALID");
  assert.equal(assessment.display, "hardware-invalid");
  assert.match(assessment.rationale, /software renderer or unavailable WebGPU adapter/);
});

test("WebGPU flush fixture and decision rule are shared and pinned", () => {
  assert.equal(WEBGPU_FLUSH_FIXTURE.markets.length, 4);
  assert.deepEqual(WEBGPU_FLUSH_FIXTURE.viewport, { width: 1600, height: 900 });
  assert.equal(WEBGPU_FLUSH_FIXTURE.barCount, 600);
  assert.equal(WEBGPU_FLUSH_FIXTURE.cellsPerBar, 40);
  assert.equal(WEBGPU_FLUSH_FIXTURE.fitColumns, 60);
  assert.equal(WEBGPU_FLUSH_FIXTURE.liveRatePerSecondPerMarket, 200);
  assert.equal(WEBGPU_FLUSH_DECISION_RULE.maximumRatio, 2);
  assert.deepEqual(WEBGPU_FLUSH_DECISION_RULE.scenarios, ["pan", "live", "crosshair"]);
});

test("shared WebGPU flush fixture builder produces the browser workload shape", () => {
  const bars = buildDenseFootprintBars(WEBGPU_FLUSH_FIXTURE.frozenNow);
  assert.equal(bars.length, 600);
  assert.equal(bars[0].cells.length, 40);
  assert.equal(bars.at(-1).cells.length, 40);
  assert.equal(bars[0].completeness, "complete");
  assert.equal(bars[0].updatedAt, WEBGPU_FLUSH_FIXTURE.frozenNow);
});
