import test from "node:test";
import assert from "node:assert/strict";

import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
  setGpuSelectionDecision,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  DEFAULT_GPU_SETTINGS,
  readGpuSettings,
  resetGpuSettingsForTest,
} from "../dist/core/gpu/gpuSettings.js";
import {
  createGpuSurface,
  createGpuSurfaceAsync,
  evaluateWebGpuQualification,
  latchWebGpuSessionFallback,
  MIN_WEBGPU_MAX_BUFFER_SIZE,
  MIN_WEBGPU_MAX_TEXTURE_DIMENSION_2D,
  resetWebGpuSessionDecisionForTest,
} from "../dist/core/gpu/selectBackend.js";
import { resetSharedWebGpuDevice } from "../dist/core/gpu/webgpu/webgpuDevice.js";

function setMockNavigator(navObj) {
  Object.defineProperty(globalThis, "navigator", {
    value: navObj,
    configurable: true,
    writable: true,
  });
}

function restoreNavigator(descriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, "navigator", descriptor);
  }
}

function makeFakeGl() {
  return {
    drawingBufferWidth: 640,
    drawingBufferHeight: 360,
    viewport() {},
    clearColor() {},
    clear() {},
    deleteVertexArray() {},
    deleteBuffer() {},
    deleteProgram() {},
  };
}

function makeFake2dContext() {
  return {
    fillStyle: "",
    save() {},
    restore() {},
    setTransform() {},
    fillRect() {},
    getImageData(_x, _y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
  };
}

function makeFakeWebGpuDevice(format = "rgba8unorm", limitOverrides = {}) {
  const uncapturedListeners = new Set();
  let lostResolve;
  const lostPromise = new Promise((resolve) => {
    lostResolve = resolve;
  });

  return {
    format,
    destroyed: false,
    limits: {
      maxBufferSize: 268435456,
      maxTextureDimension2D: 8192,
      ...limitOverrides,
    },
    lost: lostPromise,
    _triggerLost(info = { reason: "unknown" }) {
      lostResolve(info);
    },
    addEventListener(event, cb) {
      if (event === "uncapturederror") uncapturedListeners.add(cb);
    },
    removeEventListener(event, cb) {
      if (event === "uncapturederror") uncapturedListeners.delete(cb);
    },
    _triggerUncapturedError(error) {
      for (const cb of [...uncapturedListeners]) {
        cb({ error });
      }
    },
    destroy() {
      this.destroyed = true;
    },
    createShaderModule(desc) {
      return { label: desc.label, code: desc.code };
    },
    createBuffer(desc) {
      return { size: desc.size, usage: desc.usage, destroy() {} };
    },
    createBindGroupLayout(desc) {
      return { label: desc.label };
    },
    createBindGroup(desc) {
      return { label: desc.label };
    },
    createPipelineLayout(desc) {
      return { label: desc.label };
    },
    createRenderPipeline(desc) {
      return { label: desc.label };
    },
    createCommandEncoder(desc) {
      return {
        label: desc.label,
        beginRenderPass() {
          return { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {}, end() {} };
        },
        finish() {
          return {};
        },
      };
    },
    queue: {
      writeBuffer() {},
      submit() {},
    },
  };
}

function makeFakeWebGpuContext(device, format = "rgba8unorm") {
  return {
    configured: null,
    configure(desc) {
      this.configured = desc;
    },
    unconfigure() {
      this.configured = null;
    },
    getCurrentTexture() {
      return {
        format,
        createView() {
          return {};
        },
      };
    },
  };
}

function makeFakeCanvas(contexts = {}) {
  return {
    dataset: {},
    style: { cssText: "" },
    width: 640,
    height: 360,
    ownerDocument: {
      createElement() {
        return makeFakeCanvas(contexts);
      },
    },
    getContext(kind) {
      return contexts[kind] ?? null;
    },
    remove() {},
  };
}

function resetAllGpuTestState() {
  resetGpuSettingsForTest();
  resetGpuDiagnosticsForTest();
  resetWebGpuSessionDecisionForTest();
  resetSharedWebGpuDevice();
}

test("#286: DEFAULT_GPU_SETTINGS keeps backend=webgl2 and URL overrides parse rollout and kill-switch", () => {
  resetAllGpuTestState();
  assert.equal(DEFAULT_GPU_SETTINGS.backend, "webgl2");

  const parsed = readGpuSettings({
    location: {
      search: "?gpu=auto&webgpuNative=1&webgpuText=0&residentHeatmap=1&webgpuRollout=canary&webgpuKillSwitch=true",
    },
  });
  assert.equal(parsed.backend, "auto");
  assert.equal(parsed.nativeWebGpu, true);
  assert.equal(parsed.nativeWebGpuText, false);
  assert.equal(parsed.residentHeatmap, true);
  assert.equal(parsed.webgpuRollout, "canary");
  assert.equal(parsed.webgpuKillSwitch, true);

  const offParsed = readGpuSettings({
    location: { search: "?webgpuRollout=off&webgpuKillSwitch=0" },
  });
  assert.equal(offParsed.webgpuRollout, "off");
  assert.equal(offParsed.webgpuKillSwitch, false);
});

test("#286: evaluateWebGpuQualification enforces user preference, kill-switch, software adapter rejection, and limits", () => {
  const goodAdapter = { vendor: "nvidia", architecture: "ampere", isFallbackAdapter: false };
  const goodLimits = {
    maxBufferSize: MIN_WEBGPU_MAX_BUFFER_SIZE,
    maxTextureDimension2D: MIN_WEBGPU_MAX_TEXTURE_DIMENSION_2D,
  };

  assert.deepEqual(evaluateWebGpuQualification(goodAdapter, goodLimits, { preference: "webgl2" }), {
    qualified: false,
    selectionReason: "user_forced_webgl2",
  });
  assert.deepEqual(evaluateWebGpuQualification(goodAdapter, goodLimits, { preference: "canvas2d" }), {
    qualified: false,
    selectionReason: "user_forced_canvas2d",
  });
  assert.deepEqual(
    evaluateWebGpuQualification(goodAdapter, goodLimits, { preference: "auto", webgpuKillSwitch: true }),
    {
      qualified: false,
      selectionReason: "kill_switch",
      fallbackReason: "kill_switch",
    },
  );
  assert.deepEqual(
    evaluateWebGpuQualification(goodAdapter, goodLimits, { preference: "auto", webgpuRollout: "off" }),
    {
      qualified: false,
      selectionReason: "kill_switch",
      fallbackReason: "kill_switch",
    },
  );

  for (const swAdapter of [
    { isFallbackAdapter: true },
    { vendor: "google", description: "SwiftShader WebGPU" },
    { description: "Microsoft Basic Render Driver" },
    { vendor: "mesa", description: "llvmpipe (LLVM 15.0.7)" },
    { vendor: "mesa", architecture: "lavapipe" },
  ]) {
    const autoRes = evaluateWebGpuQualification(swAdapter, goodLimits, { preference: "auto" });
    assert.equal(autoRes.qualified, false);
    assert.equal(autoRes.selectionReason, "fallback_adapter_rejected");

    const forcedRes = evaluateWebGpuQualification(swAdapter, goodLimits, { preference: "webgpu" });
    assert.equal(forcedRes.qualified, true);
    assert.equal(forcedRes.selectionReason, "user_forced_webgpu");
  }

  assert.equal(
    evaluateWebGpuQualification(goodAdapter, { maxBufferSize: MIN_WEBGPU_MAX_BUFFER_SIZE - 1, maxTextureDimension2D: 4096 }, { preference: "auto" }).selectionReason,
    "insufficient_limits",
  );
  assert.equal(
    evaluateWebGpuQualification(goodAdapter, { maxBufferSize: MIN_WEBGPU_MAX_BUFFER_SIZE, maxTextureDimension2D: 2048 }, { preference: "auto" }).selectionReason,
    "insufficient_limits",
  );
  assert.deepEqual(evaluateWebGpuQualification(goodAdapter, goodLimits, { preference: "auto" }), {
    qualified: true,
    selectionReason: "qualified_hardware",
  });
});

test("#286: explicit webgl2 and canvas2d preserve user preference and report diagnostics", async () => {
  resetAllGpuTestState();
  const glCanvas = makeFakeCanvas({ webgl2: makeFakeGl() });
  const glSurface = await createGpuSurfaceAsync(glCanvas, "webgl2");
  assert.equal(glSurface.kind, "webgl2");
  let diag = getGpuDiagnostics();
  assert.equal(diag.requested, "webgl2");
  assert.equal(diag.active, "webgl2");
  assert.equal(diag.selectionReason, "user_forced_webgl2");
  assert.equal(diag.nativeWebGpuActive, false);
  assert.equal(diag.nativeWebGpuDisabledReason, "user_forced_webgl2");
  glSurface.dispose();

  resetAllGpuTestState();
  const c2dCanvas = makeFakeCanvas({ "2d": makeFake2dContext() });
  const c2dSurface = createGpuSurface(c2dCanvas, "canvas2d");
  assert.equal(c2dSurface.kind, "canvas2d");
  diag = getGpuDiagnostics();
  assert.equal(diag.requested, "canvas2d");
  assert.equal(diag.active, "canvas2d");
  assert.equal(diag.selectionReason, "user_forced_canvas2d");
  assert.equal(diag.nativeWebGpuActive, false);
  c2dSurface.dispose();
});

test("#286: auto rejects software adapter, pins session fallback, and explicit webgpu allows SwiftShader", async () => {
  resetAllGpuTestState();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let requestAdapterCalls = 0;

  try {
    const device = makeFakeWebGpuDevice();
    setMockNavigator({
      gpu: {
        async requestAdapter() {
          requestAdapterCalls++;
          return {
            info: { vendor: "google", description: "SwiftShader", isFallbackAdapter: true },
            async requestDevice() {
              return device;
            },
          };
        },
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });

    const canvas = makeFakeCanvas({
      webgpu: makeFakeWebGpuContext(device),
      webgl2: makeFakeGl(),
    });

    const s1 = await createGpuSurfaceAsync(canvas, "auto");
    assert.equal(s1.kind, "webgl2");
    assert.equal(requestAdapterCalls, 1);

    const diag1 = getGpuDiagnostics();
    assert.equal(diag1.requested, "auto");
    assert.equal(diag1.active, "webgl2");
    assert.equal(diag1.selectionReason, "fallback_adapter_rejected");
    assert.equal(diag1.nativeWebGpuActive, false);
    assert.equal(diag1.nativeWebGpuDisabledReason, "fallback_adapter_rejected");
    assert.equal(diag1.adapter?.vendor, "google");
    assert.equal(diag1.limits?.maxBufferSize, 268435456);
    assert.equal(diag1.fallbacks[0]?.reason, "fallback_adapter_rejected");
    s1.dispose();

    // Second auto call must use the session-pinned fallback without probing WebGPU again
    const s2 = await createGpuSurfaceAsync(canvas, "auto");
    assert.equal(s2.kind, "webgl2");
    assert.equal(requestAdapterCalls, 1);
    s2.dispose();

    // Explicit webgpu still allows SwiftShader for CI compatibility
    const s3 = await createGpuSurfaceAsync(canvas, "webgpu");
    assert.equal(s3.kind, "webgpu");
    assert.equal(getGpuDiagnostics().selectionReason, "user_forced_webgpu");
    assert.equal(getGpuDiagnostics().nativeWebGpuActive, true);
    s3.dispose();
  } finally {
    restoreNavigator(originalNav);
    resetAllGpuTestState();
  }
});

test("#286: auto rejects insufficient limits and falls back to WebGL2 or Canvas2D", async () => {
  resetAllGpuTestState();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    const lowLimitDevice = makeFakeWebGpuDevice("rgba8unorm", {
      maxBufferSize: 16 * 1024 * 1024,
      maxTextureDimension2D: 2048,
    });
    setMockNavigator({
      gpu: {
        async requestAdapter() {
          return {
            info: { vendor: "intel", architecture: "gen-12", isFallbackAdapter: false },
            async requestDevice() {
              return lowLimitDevice;
            },
          };
        },
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });

    const canvasNoGl = makeFakeCanvas({
      webgpu: makeFakeWebGpuContext(lowLimitDevice),
      "2d": makeFake2dContext(),
    });
    const surface = await createGpuSurfaceAsync(canvasNoGl, "auto");
    assert.equal(surface.kind, "canvas2d");
    const diag = getGpuDiagnostics();
    assert.equal(diag.requested, "auto");
    assert.equal(diag.active, "canvas2d");
    assert.equal(diag.selectionReason, "insufficient_limits");
    assert.equal(diag.nativeWebGpuActive, false);
    assert.equal(diag.fallbacks[0]?.reason, "insufficient_limits");
    assert.equal(diag.fallbacks[1]?.reason, "context_unavailable");
    surface.dispose();
  } finally {
    restoreNavigator(originalNav);
    resetAllGpuTestState();
  }
});

test("#286: kill-switch forces safe WebGL2 fallback without probing WebGPU", async () => {
  resetAllGpuTestState();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let requestAdapterCalls = 0;

  try {
    setMockNavigator({
      gpu: {
        async requestAdapter() {
          requestAdapterCalls++;
          return null;
        },
      },
    });

    const canvas = makeFakeCanvas({ webgl2: makeFakeGl() });
    const s1 = await createGpuSurfaceAsync(canvas, "auto", undefined, undefined, {
      webgpuKillSwitch: true,
    });
    assert.equal(s1.kind, "webgl2");
    assert.equal(requestAdapterCalls, 0);
    assert.equal(getGpuDiagnostics().selectionReason, "kill_switch");
    assert.equal(getGpuDiagnostics().fallbacks[0]?.reason, "kill_switch");
    s1.dispose();

    const s2 = await createGpuSurfaceAsync(canvas, "auto", undefined, undefined, {
      webgpuRollout: "off",
    });
    assert.equal(s2.kind, "webgl2");
    assert.equal(requestAdapterCalls, 0);
    s2.dispose();
  } finally {
    restoreNavigator(originalNav);
    resetAllGpuTestState();
  }
});

test("#286: qualified hardware pins session to WebGPU, then device-loss and OOM latch session fallback", async () => {
  resetAllGpuTestState();
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    let device = makeFakeWebGpuDevice();
    setMockNavigator({
      gpu: {
        async requestAdapter() {
          return {
            info: { vendor: "amd", architecture: "rdna3", isFallbackAdapter: false },
            async requestDevice() {
              return device;
            },
          };
        },
        getPreferredCanvasFormat: () => "rgba8unorm",
      },
    });

    const canvas = makeFakeCanvas({
      webgpu: makeFakeWebGpuContext(device),
      webgl2: makeFakeGl(),
    });

    const s1 = await createGpuSurfaceAsync(canvas, "auto");
    assert.equal(s1.kind, "webgpu");
    assert.equal(getGpuDiagnostics().selectionReason, "qualified_hardware");
    assert.equal(getGpuDiagnostics().nativeWebGpuActive, true);

    const s2 = await createGpuSurfaceAsync(canvas, "auto");
    assert.equal(s2.kind, "webgpu");
    assert.equal(getGpuDiagnostics().selectionReason, "qualified_hardware");

    // 1. Runtime device loss latches session fallback
    device._triggerLost({ reason: "destroyed" });
    await Promise.resolve();
    await Promise.resolve();

    let diag = getGpuDiagnostics();
    assert.equal(diag.nativeWebGpuActive, false);
    assert.equal(diag.nativeWebGpuDisabledReason, "device-lost");

    const s3 = await createGpuSurfaceAsync(canvas, "auto");
    assert.equal(s3.kind, "webgl2");
    assert.equal(getGpuDiagnostics().selectionReason, "device-lost");
    s1.dispose();
    s2.dispose();
    s3.dispose();

    // 2. Runtime GPUOutOfMemoryError latches session fallback
    resetAllGpuTestState();
    device = makeFakeWebGpuDevice();
    const oomCanvas = makeFakeCanvas({
      webgpu: makeFakeWebGpuContext(device),
      webgl2: makeFakeGl(),
    });
    const s4 = await createGpuSurfaceAsync(oomCanvas, "auto");
    assert.equal(s4.kind, "webgpu");

    const oomErr = new Error("OOM");
    oomErr.name = "GPUOutOfMemoryError";
    device._triggerUncapturedError(oomErr);

    diag = getGpuDiagnostics();
    assert.equal(diag.nativeWebGpuActive, false);
    assert.equal(diag.nativeWebGpuDisabledReason, "out-of-memory");

    const s5 = await createGpuSurfaceAsync(oomCanvas, "auto");
    assert.equal(s5.kind, "webgl2");
    assert.equal(getGpuDiagnostics().selectionReason, "out-of-memory");
    s4.dispose();
    s5.dispose();

    // 3. Direct helper setGpuSelectionDecision & latchWebGpuSessionFallback reset cleanly
    setGpuSelectionDecision({ selectionReason: "custom_reason" });
    assert.equal(getGpuDiagnostics().selectionReason, "custom_reason");
    latchWebGpuSessionFallback("manual_latch");
    assert.equal(getGpuDiagnostics().nativeWebGpuDisabledReason, "manual_latch");
    resetGpuDiagnosticsForTest();
    assert.equal(getGpuDiagnostics().selectionReason, undefined);
  } finally {
    restoreNavigator(originalNav);
    resetAllGpuTestState();
  }
});
