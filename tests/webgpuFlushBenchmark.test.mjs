import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDenseFootprintBars,
  buildWebGpuFlushAssessment,
  classifyWebGpuAdapter,
  readWebGpuAdapterIdentity,
  selectWebGpuProbe,
  shouldTryWebGpuVulkan,
  WEBGPU_FLUSH_DECISION_RULE,
  WEBGPU_FLUSH_FIXTURE,
  WEBGPU_FLUSH_SCENARIOS,
  webGpuFlushHardwareInvalidReasons,
  webGpuFlushLaunchArgs,
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
  assert.equal(assessment.decision, "NOT_EVALUATED_HARDWARE_INVALID");
  assert.equal(assessment.display, "hardware-invalid");
  assert.match(assessment.rationale, /software renderer or unavailable WebGPU adapter/);
});

test("classifies WebGPU adapter identity, including individual software fields and fallback priority", () => {
  const software = { software: true, reason: "webgpu-software-adapter" };
  assert.deepEqual(classifyWebGpuAdapter({ vendor: "google", architecture: "swiftshader", description: "" }), software);
  assert.deepEqual(classifyWebGpuAdapter({ vendor: "amd", architecture: "rdna-4", description: "Radeon", isFallbackAdapter: false }), {
    software: false, reason: null,
  });
  const fallback = { software: true, reason: "webgpu-fallback-adapter" };
  assert.deepEqual(classifyWebGpuAdapter({ vendor: "intel", architecture: "gen-9", isFallbackAdapter: true }), fallback);
  assert.deepEqual(classifyWebGpuAdapter({ architecture: "swiftshader", isFallbackAdapter: true }), fallback);
  const unknown = { software: false, reason: "webgpu-adapter-identity-unavailable" };
  assert.deepEqual(classifyWebGpuAdapter(null), unknown);
  assert.deepEqual(classifyWebGpuAdapter({ vendor: "", architecture: "  ", description: "", isFallbackAdapter: false }), unknown);
  assert.deepEqual(classifyWebGpuAdapter({ vendor: "llvmpipe" }), software);
  assert.deepEqual(classifyWebGpuAdapter({ architecture: "LAVAPIPE" }), software);
  assert.deepEqual(classifyWebGpuAdapter({ description: "WARP" }), software);
  assert.deepEqual(classifyWebGpuAdapter({ description: "Microsoft Basic Render Driver" }), software);
  assert.deepEqual(classifyWebGpuAdapter({ description: "softpipe" }), software);
});

test("reads the current WebGPU fallback flag before the legacy adapter property", async () => {
  const current = { vendor: "intel", architecture: "gen-9", description: "", isFallbackAdapter: false };
  assert.deepEqual(await readWebGpuAdapterIdentity({ info: current, isFallbackAdapter: true }), current);
  assert.equal((await readWebGpuAdapterIdentity({ info: { isFallbackAdapter: true }, isFallbackAdapter: false })).isFallbackAdapter, true);
  assert.equal((await readWebGpuAdapterIdentity({ info: { vendor: "intel" }, isFallbackAdapter: true })).isFallbackAdapter, true);
  assert.deepEqual(await readWebGpuAdapterIdentity({
    requestAdapterInfo: async () => ({ vendor: "intel", architecture: "gen-9", description: "" }),
    isFallbackAdapter: false,
  }), current);
  assert.equal((await readWebGpuAdapterIdentity({ info: { vendor: "intel" } })).isFallbackAdapter, null);
});

function probeFor(adapter, { ok = true, presentation = true } = {}) {
  return { ok, canvasPresentation: { supported: presentation }, webgpuSoftware: classifyWebGpuAdapter(adapter) };
}

test("tries Vulkan on software or unidentified primary adapters in hardware mode", () => {
  const hardware = probeFor({ vendor: "amd", architecture: "rdna-4" }, { presentation: false });
  const software = probeFor({ vendor: "google", architecture: "swiftshader" });
  const unknown = probeFor(null);
  const failed = probeFor(null, { ok: false });
  assert.equal(shouldTryWebGpuVulkan(software, true), true);
  assert.equal(shouldTryWebGpuVulkan(unknown, true), true);
  assert.equal(shouldTryWebGpuVulkan(software, false), false);
  assert.equal(shouldTryWebGpuVulkan(hardware, true), true);
  assert.equal(shouldTryWebGpuVulkan(hardware, false), false);
  assert.equal(shouldTryWebGpuVulkan(failed, false), true);
  assert.equal(selectWebGpuProbe(software, hardware, true), hardware);
  assert.equal(selectWebGpuProbe(unknown, hardware, true), hardware);
  assert.equal(selectWebGpuProbe(software, unknown, true), software);
  assert.equal(selectWebGpuProbe(software, failed, true), software);
  assert.equal(selectWebGpuProbe(hardware, software, true), hardware);
  assert.equal(selectWebGpuProbe(failed, software, false), software);
});

test("a software or unidentified WebGPU adapter prevents GO at a 1.2 ratio even with hardware WebGL2", () => {
  const webglRenderer = {
    softwareRenderer: false,
    webglInfo: { debugExtensionAvailable: true, unmaskedVendor: "AMD", unmaskedRenderer: "Radeon" },
  };
  const webgl2 = backendWithFlushMean(0.05);
  const webgpu = backendWithFlushMean(0.06);
  for (const adapter of [{ vendor: "google", architecture: "swiftshader" }, null]) {
    const reasons = webGpuFlushHardwareInvalidReasons(probeFor(adapter), webglRenderer);
    assert.deepEqual(reasons, [adapter ? "webgpu-software-adapter" : "webgpu-adapter-identity-unavailable"]);
    const assessment = buildWebGpuFlushAssessment({ hardwareValid: reasons.length === 0, webgl2, webgpu });
    assert.ok(assessment.comparisons.every((comparison) => comparison.flushMeanRatio === 1.2));
    assert.equal(assessment.decision, "NOT_EVALUATED_HARDWARE_INVALID");
  }
  assert.deepEqual(webGpuFlushHardwareInvalidReasons(probeFor({ isFallbackAdapter: true }), {
    ...webglRenderer, softwareRenderer: true,
  }), ["software-renderer", "webgpu-fallback-adapter"]);
});

test("Linux hardware Vulkan flags apply only to the WebGPU variant", () => {
  const kind = "webgpu";
  const variant = "vulkan-compositor";
  const platform = "linux";
  const functionalWebglArgs = ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"];
  const hardwareOptions = { kind, variant, platform, hardwareMode: true, functionalWebglArgs };
  const hardwareDefault = [
    "--use-gl=angle", "--use-angle=default", "--ignore-gpu-blocklist", "--enable-webgl",
    "--enable-unsafe-webgpu", "--enable-precise-memory-info",
  ];
  assert.deepEqual(webGpuFlushLaunchArgs(hardwareOptions), [
    "--use-gl=angle", "--use-angle=vulkan", "--ignore-gpu-blocklist", "--enable-webgl",
    "--enable-unsafe-webgpu", "--enable-precise-memory-info", "--enable-features=Vulkan", "--disable-vulkan-surface",
  ]);
  assert.deepEqual(webGpuFlushLaunchArgs({ ...hardwareOptions, platform: "win32" }), [...hardwareDefault, "--enable-features=Vulkan"]);
  assert.deepEqual(webGpuFlushLaunchArgs({ ...hardwareOptions, kind: "webgl2" }), hardwareDefault);
  assert.deepEqual(webGpuFlushLaunchArgs({ ...hardwareOptions, variant: "no-vulkan-compositor" }), hardwareDefault);
  const functionalOptions = { ...hardwareOptions, hardwareMode: false };
  const functionalWebgpu = [...functionalWebglArgs, "--enable-unsafe-webgpu", "--use-vulkan=swiftshader", "--disable-vulkan-surface"];
  assert.deepEqual(webGpuFlushLaunchArgs({ ...functionalOptions, kind: "webgl2" }), functionalWebglArgs);
  assert.deepEqual(webGpuFlushLaunchArgs({ ...functionalOptions, variant: "no-vulkan-compositor" }), functionalWebgpu);
  assert.deepEqual(webGpuFlushLaunchArgs(functionalOptions), [...functionalWebgpu, "--enable-features=Vulkan"]);
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
