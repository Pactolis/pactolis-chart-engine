import test from "node:test";
import assert from "node:assert/strict";

import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  createGpuSurface,
  createGpuSurfaceAsync,
} from "../dist/core/gpu/selectBackend.js";
import {
  isWebGpuSupported,
  requestWebGpuDevice,
  resetSharedWebGpuDevice,
} from "../dist/core/gpu/webgpu/webgpuDevice.js";
import {
  WebGpuQuadPipeline,
  FLOATS_PER_INSTANCE,
  BYTES_PER_INSTANCE,
} from "../dist/core/gpu/webgpu/webgpuQuadPipeline.js";
import {
  WebGpuQuadSink,
  WebGpuSurface,
} from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { WebGl2Surface } from "../dist/core/gpu/webgl2/webgl2Surface.js";
import { Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";

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

function makeFakeGpuBuffer(size, usage) {
  const mappedData = new Uint8Array(size);
  return {
    size,
    usage,
    destroyed: false,
    mappedMode: null,
    destroy() {
      this.destroyed = true;
    },
    async mapAsync(mode) {
      this.mappedMode = mode;
    },
    getMappedRange() {
      return mappedData.buffer;
    },
    unmap() {
      this.mappedMode = null;
    },
    _fillData(uint8Array) {
      mappedData.set(uint8Array);
    },
  };
}

function makeFakeWebGpuDevice(format = "rgba8unorm") {
  const buffers = [];
  const passes = [];
  const submittedCommands = [];
  const writtenBuffers = [];
  const uncapturedListeners = new Set();
  let lostResolve;
  const lostPromise = new Promise((resolve) => {
    lostResolve = resolve;
  });

  const device = {
    format,
    limits: {
      maxBufferSize: 268435456,
      maxTextureDimension2D: 8192,
    },
    lost: lostPromise,
    _triggerLost(info = { reason: "destroyed" }) {
      lostResolve(info);
    },
    addEventListener(event, cb) {
      if (event === "uncapturederror") {
        uncapturedListeners.add(cb);
      }
    },
    removeEventListener(event, cb) {
      if (event === "uncapturederror") {
        uncapturedListeners.delete(cb);
      }
    },
    _triggerUncapturedError(err = new Error("Mock WebGPU error")) {
      for (const cb of uncapturedListeners) {
        cb({ error: err });
      }
    },
    createShaderModule(desc) {
      return { label: desc.label, code: desc.code };
    },
    createBuffer(desc) {
      const buf = makeFakeGpuBuffer(desc.size, desc.usage);
      buf.label = desc.label;
      buffers.push(buf);
      return buf;
    },
    createBindGroupLayout(desc) {
      return { label: desc.label, entries: desc.entries };
    },
    createBindGroup(desc) {
      return { label: desc.label, layout: desc.layout, entries: desc.entries };
    },
    createPipelineLayout(desc) {
      return { label: desc.label, bindGroupLayouts: desc.bindGroupLayouts };
    },
    createRenderPipeline(desc) {
      return { label: desc.label, layout: desc.layout, vertex: desc.vertex, fragment: desc.fragment };
    },
    createCommandEncoder(desc) {
      const recordedDraws = [];
      const copies = [];
      return {
        label: desc.label,
        beginRenderPass(passDesc) {
          const pass = {
            desc: passDesc,
            pipeline: null,
            bindGroups: new Map(),
            vertexBuffers: new Map(),
            draws: [],
            setPipeline(p) { this.pipeline = p; },
            setBindGroup(idx, bg) { this.bindGroups.set(idx, bg); },
            setVertexBuffer(slot, vb) { this.vertexBuffers.set(slot, vb); },
            draw(vertexCount, instanceCount, firstVertex, firstInstance) {
              this.draws.push({ vertexCount, instanceCount, firstVertex, firstInstance });
              recordedDraws.push({ vertexCount, instanceCount });
            },
            end() { passes.push(this); },
          };
          return pass;
        },
        copyTextureToBuffer(source, destination, copySize) {
          copies.push({ source, destination, copySize });
        },
        finish() {
          return { recordedDraws, copies };
        },
      };
    },
    queue: {
      writeBuffer(buffer, offset, data, byteOffset, byteLength) {
        writtenBuffers.push({ buffer, offset, data, byteOffset, byteLength });
      },
      submit(commandBuffers) {
        submittedCommands.push(...commandBuffers);
      },
    },
    destroy() {},
  };

  return {
    device,
    buffers,
    passes,
    submittedCommands,
    writtenBuffers,
  };
}

function makeFakeWebGpuContext(device, format = "rgba8unorm") {
  let configuredDesc = null;
  const currentTexture = {
    format,
    createView() {
      return { texture: this };
    },
  };
  return {
    configure(desc) {
      configuredDesc = desc;
    },
    getCurrentTexture() {
      return currentTexture;
    },
    getConfiguredDesc() {
      return configuredDesc;
    },
  };
}

function makeFakeCanvas(contextMap = {}) {
  const listeners = new Map();
  const canvas = {
    dataset: {},
    style: { cssText: "position:absolute;width:100%;height:100%;" },
    width: 640,
    height: 360,
    parentNode: {
      replaceChild: () => {},
    },
    replaceWith(next) {
      this.replacedWith = next;
    },
    getContext(kind) {
      return contextMap[kind] ?? null;
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent(type, event = { preventDefault() {} }) {
      for (const cb of listeners.get(type) ?? []) cb(event);
    },
  };
  return canvas;
}

function makeFakeGl() {
  return {
    drawingBufferWidth: 640,
    drawingBufferHeight: 360,
    viewport() {},
    clearColor() {},
    clear() {},
    readPixels(_x, _y, _w, _h, _format, _type, buffer) {
      buffer.fill(42);
    },
    deleteVertexArray() {},
    deleteBuffer() {},
    deleteProgram() {},
  };
}

function makeFake2dContext() {
  return {
    operations: [],
    fillStyle: "",
    save() {},
    restore() {},
    setTransform() {},
    fillRect() {},
    getImageData(x, y, w, h) {
      return {
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      };
    },
  };
}

test("WebGPU support detection and requestWebGpuDevice lifecycle", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();

  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    // When navigator.gpu is absent
    setMockNavigator({});
    assert.equal(isWebGpuSupported(), false);
    const nullDevice = await requestWebGpuDevice();
    assert.equal(nullDevice, null);

    // When navigator.gpu is available
    const { device } = makeFakeWebGpuDevice("rgba8unorm");
    const fakeAdapter = {
      async requestDevice() {
        return device;
      },
    };

    setMockNavigator({
      gpu: {
        async requestAdapter() {
          return fakeAdapter;
        },
        getPreferredCanvasFormat() {
          return "bgra8unorm";
        },
      },
    });

    assert.equal(isWebGpuSupported(), true);
    const handle = await requestWebGpuDevice();
    assert.ok(handle);
    assert.equal(handle.format, "bgra8unorm");
    assert.equal(handle.isLost(), false);
    assert.equal(handle.device, device);

    // Singleton caching: subsequent request returns same handle
    const handle2 = await requestWebGpuDevice();
    assert.equal(handle2, handle);

    // Adapter request failure triggers fallback
    resetSharedWebGpuDevice();
    setMockNavigator({
      gpu: {
        async requestAdapter() {
          return null;
        },
        getPreferredCanvasFormat() {
          return "bgra8unorm";
        },
      },
    });

    const failedAdapterHandle = await requestWebGpuDevice();
    assert.equal(failedAdapterHandle, null);
    const diag = getGpuDiagnostics();
    assert.equal(diag.fallbacks.length, 1);
    assert.equal(diag.fallbacks[0].from, "webgpu");
    assert.equal(diag.fallbacks[0].to, "webgl2");
    assert.equal(diag.fallbacks[0].reason, "adapter_request_failed");
  } finally {
    restoreNavigator(originalDescriptor);
    resetSharedWebGpuDevice();
  }
});

test("Issue #57: WebGPU device cache retry after failure, loss recovery without resetSharedWebGpuDevice, and concurrent flight coalescence", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    let adapterFail = true;
    let deviceFail = false;
    let adapterRequestCount = 0;
    let deviceRequestCount = 0;
    let currentDevice = null;

    setMockNavigator({
      gpu: {
        async requestAdapter() {
          adapterRequestCount++;
          if (adapterFail) return null;
          return {
            async requestDevice() {
              deviceRequestCount++;
              if (deviceFail) throw new Error("Mock device creation failure");
              const dev = makeFakeWebGpuDevice("rgba8unorm").device;
              currentDevice = dev;
              return dev;
            },
          };
        },
        getPreferredCanvasFormat() {
          return "rgba8unorm";
        },
      },
    });

    // 1. İlk requestAdapter null döner -> ikinci requestWebGpuDevice çağrıldığında adapter düzelmişse yeni sağlıklı handle döner (resetSharedWebGpuDevice çağırmadan!)
    const firstNull = await requestWebGpuDevice();
    assert.equal(firstNull, null);
    assert.equal(adapterRequestCount, 1);

    adapterFail = false;
    deviceFail = true;
    // 2. İlk requestDevice hata fırlatır -> ikinci çağrıda sağlıklı handle döner
    const secondError = await requestWebGpuDevice();
    assert.equal(secondError, null);
    assert.equal(adapterRequestCount, 2);
    assert.equal(deviceRequestCount, 1);

    deviceFail = false;
    const thirdSuccess = await requestWebGpuDevice();
    assert.ok(thirdSuccess);
    assert.equal(thirdSuccess.isLost(), false);
    assert.equal(adapterRequestCount, 3);
    assert.equal(deviceRequestCount, 2);

    // 3. İlk edinim başarılı -> device.lost tetiklenir -> sonraki requestWebGpuDevice() çağrısı eski isLost() === true handle'ı döndürmez, yeni cihaz edinir
    const firstHealthyDevice = currentDevice;
    firstHealthyDevice._triggerLost({ reason: "destroyed" });
    await new Promise((resolve) => setTimeout(resolve, 0)); // wait for promise microtasks
    assert.equal(thirdSuccess.isLost(), true);

    const fourthReacquired = await requestWebGpuDevice();
    assert.ok(fourthReacquired);
    assert.notEqual(fourthReacquired, thirdSuccess);
    assert.equal(fourthReacquired.isLost(), false);
    assert.equal(adapterRequestCount, 4);

    // 4. Eşzamanlı iki requestWebGpuDevice() çağrısı tek requestAdapter/requestDevice çağrısında birleşir;
    // eski cihazın geç gelen lost bildirimi yeni edinilmiş sharedHandle'ı silmez.
    const lateLostDevice = currentDevice;
    lateLostDevice._triggerLost({ reason: "delayed-lost" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fourthReacquired.isLost(), true);

    let delayAdapterResolve;
    const delayedPromise = new Promise((resolve) => { delayAdapterResolve = resolve; });
    const prevRequestAdapter = globalThis.navigator.gpu.requestAdapter;
    let concurrentAdapterCalls = 0;
    globalThis.navigator.gpu.requestAdapter = async function() {
      concurrentAdapterCalls++;
      await delayedPromise;
      return prevRequestAdapter();
    };

    const p1 = requestWebGpuDevice();
    const p2 = requestWebGpuDevice();
    delayAdapterResolve();
    const [h1, h2] = await Promise.all([p1, p2]);
    assert.equal(h1, h2, "concurrent calls share the same device handle");
    assert.equal(concurrentAdapterCalls, 1, "concurrent calls coalesce into a single requestAdapter");
    assert.ok(h1);
    assert.equal(h1.isLost(), false);

    // Stale loss notification does not kill h1
    assert.equal(h1.isLost(), false);
    const h3 = await requestWebGpuDevice();
    assert.equal(h3, h1, "cached handle is not invalidated by stale device loss");
  } finally {
    restoreNavigator(originalDescriptor);
    resetSharedWebGpuDevice();
  }
});

test("WebGPU powerPreference adapter option negotiation and cache behavior (#67)", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();

  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    const { device } = makeFakeWebGpuDevice("rgba8unorm");
    const adapterCalls = [];

    const fakeAdapter = {
      async requestDevice() {
        return device;
      },
    };

    setMockNavigator({
      gpu: {
        async requestAdapter(options) {
          adapterCalls.push(options ? { ...options } : options);
          return fakeAdapter;
        },
        getPreferredCanvasFormat() {
          return "rgba8unorm";
        },
      },
    });

    // 1. requestWebGpuDevice() without options does not pass powerPreference
    resetSharedWebGpuDevice();
    adapterCalls.length = 0;
    const h1 = await requestWebGpuDevice();
    assert.ok(h1);
    assert.equal(adapterCalls.length, 1);
    assert.equal("powerPreference" in (adapterCalls[0] ?? {}), false, "no powerPreference sent when options omitted");

    // 2. requestWebGpuDevice({ powerPreference: 'default' }) does not pass powerPreference
    resetSharedWebGpuDevice();
    adapterCalls.length = 0;
    const hDefault = await requestWebGpuDevice({ powerPreference: "default" });
    assert.ok(hDefault);
    assert.equal(adapterCalls.length, 1);
    assert.equal("powerPreference" in (adapterCalls[0] ?? {}), false, "no powerPreference sent for 'default'");

    // 3. requestWebGpuDevice({ powerPreference: 'low-power' }) passes low-power
    resetSharedWebGpuDevice();
    adapterCalls.length = 0;
    const hLow = await requestWebGpuDevice({ powerPreference: "low-power" });
    assert.ok(hLow);
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0]?.powerPreference, "low-power");

    // 4. requestWebGpuDevice({ powerPreference: 'high-performance' }) passes high-performance
    resetSharedWebGpuDevice();
    adapterCalls.length = 0;
    const hHigh = await requestWebGpuDevice({ powerPreference: "high-performance" });
    assert.ok(hHigh);
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0]?.powerPreference, "high-performance");

    // 5. Switching powerPreference requests a new device matching the new preference
    resetSharedWebGpuDevice();
    adapterCalls.length = 0;
    const devA = await requestWebGpuDevice({ powerPreference: "low-power" });
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0]?.powerPreference, "low-power");

    // Same preference returns shared device
    const devA2 = await requestWebGpuDevice({ powerPreference: "low-power" });
    assert.equal(devA2, devA);
    assert.equal(adapterCalls.length, 1);

    // Changed preference triggers new adapter request
    const devB = await requestWebGpuDevice({ powerPreference: "high-performance" });
    assert.equal(adapterCalls.length, 2);
    assert.equal(adapterCalls[1]?.powerPreference, "high-performance");

    // 6. createGpuSurfaceAsync propagates powerPreference to WebGPU adapter request
    resetSharedWebGpuDevice();
    adapterCalls.length = 0;
    const fakeWebGpuCtx = makeFakeWebGpuContext(device, "rgba8unorm");
    const canvas = makeFakeCanvas({ webgpu: fakeWebGpuCtx });

    const surface = await createGpuSurfaceAsync(
      canvas,
      "webgpu",
      undefined,
      undefined,
      { powerPreference: "low-power" },
    );
    assert.equal(surface.kind, "webgpu");
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0]?.powerPreference, "low-power");

    // createGpuSurfaceAsync with default powerPreference omits powerPreference
    resetSharedWebGpuDevice();
    adapterCalls.length = 0;
    const surfaceDefault = await createGpuSurfaceAsync(
      canvas,
      "webgpu",
      undefined,
      undefined,
      { powerPreference: "default" },
    );
    assert.equal(surfaceDefault.kind, "webgpu");
    assert.equal(adapterCalls.length, 1);
    assert.equal("powerPreference" in (adapterCalls[0] ?? {}), false);
  } finally {
    restoreNavigator(originalDescriptor);
    resetSharedWebGpuDevice();
  }
});

test("WebGpuQuadPipeline compiles shaders, writes uniforms, dynamic buffer growth and records draws", () => {
  const { device, buffers, passes, writtenBuffers } = makeFakeWebGpuDevice("rgba8unorm");

  const pipeline = new WebGpuQuadPipeline(device, "rgba8unorm", 1024);
  assert.equal(pipeline.format, "rgba8unorm");
  assert.ok(pipeline.pipeline);
  assert.ok(pipeline.uniformBuffer);
  assert.ok(pipeline.bindGroup);

  // Uniform resolution write
  pipeline.updateResolution(1920, 1080);
  assert.equal(writtenBuffers.length, 1);
  assert.equal(writtenBuffers[0].buffer, pipeline.uniformBuffer);
  const writtenFloats = new Float32Array(writtenBuffers[0].data.buffer);
  assert.equal(writtenFloats[0], 1920);
  assert.equal(writtenFloats[1], 1080);

  // Upload instances within initial capacity
  const initialQuads = 500;
  const quadData = new Float32Array(initialQuads * FLOATS_PER_INSTANCE);
  pipeline.uploadInstances(quadData, initialQuads);
  assert.equal(writtenBuffers.length, 2);
  assert.equal(writtenBuffers[1].byteLength, initialQuads * BYTES_PER_INSTANCE);

  // Upload instances exceeding initial capacity (triggers buffer reallocation)
  const largeQuads = 3000;
  const largeQuadData = new Float32Array(largeQuads * FLOATS_PER_INSTANCE);
  pipeline.uploadInstances(largeQuadData, largeQuads);
  assert.equal(writtenBuffers.length, 3);
  assert.equal(writtenBuffers[2].byteLength, largeQuads * BYTES_PER_INSTANCE);
  // Verify instance buffer was recreated with at least required capacity
  const instanceBuffers = buffers.filter((b) => b.label === "QuadInstanceBuffer");
  assert.ok(instanceBuffers.length >= 2);
  assert.ok(instanceBuffers[instanceBuffers.length - 1].size >= largeQuads * BYTES_PER_INSTANCE);

  // Record pass
  const encoder = device.createCommandEncoder({ label: "TestEncoder" });
  const pass = encoder.beginRenderPass({});
  pipeline.recordPass(pass, largeQuads);
  pass.end();

  assert.equal(passes.length, 1);
  assert.equal(passes[0].pipeline, pipeline.pipeline);
  assert.equal(passes[0].draws.length, 1);
  assert.equal(passes[0].draws[0].vertexCount, 6);
  assert.equal(passes[0].draws[0].instanceCount, largeQuads);

  pipeline.dispose();
  assert.equal(pipeline.uniformBuffer.destroyed, true);
});

test("WebGpuSurface renders frame lifecycle and writes instance data via WebGpuQuadSink", () => {
  const { device, passes, writtenBuffers, submittedCommands } = makeFakeWebGpuDevice("rgba8unorm");
  const ctx = makeFakeWebGpuContext(device, "rgba8unorm");
  const canvas = makeFakeCanvas({ webgpu: ctx });

  const handle = {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  };

  const surface = new WebGpuSurface(canvas, handle);
  assert.equal(surface.kind, "webgpu");
  assert.equal(surface.canvas, canvas);
  assert.equal(surface.heatmap, null);

  surface.resize(1000, 500, 2);
  assert.equal(canvas.width, 1000);
  assert.equal(canvas.height, 500);

  const clearColor = { r: 0.1, g: 0.2, b: 0.3, a: 1.0 };
  const frame = surface.beginFrame(clearColor);
  assert.ok(frame.quads instanceof WebGpuQuadSink);

  // Push 2 quads
  frame.quads.rect(10, 20, 100, 50, { r: 1, g: 0, b: 0, a: 1 });
  frame.quads.rect(30, 40, 200, 60, { r: 0, g: 1, b: 0, a: 1 });
  assert.equal(frame.quads.count, 2);

  // Logical width/height flushes properly
  frame.flushQuads(500, 250);
  frame.end();

  assert.ok(passes.length >= 1);
  assert.ok(submittedCommands.length >= 1);
  assert.equal(passes[0].draws[0].instanceCount, 2);

  // Check uniform resolution was set to logical bounds (500x250)
  const uniformWrites = writtenBuffers.filter((wb) => wb.buffer.label === "QuadResolutionUniform");
  assert.ok(uniformWrites.length > 0);
  const lastRes = new Float32Array(uniformWrites[uniformWrites.length - 1].data.buffer);
  assert.equal(lastRes[0], 500);
  assert.equal(lastRes[1], 250);

  surface.dispose();
});

test("WebGpuSurface requestCapture strips 256-byte pitch padding and converts BGRA to RGBA", async () => {
  const { device, buffers } = makeFakeWebGpuDevice("bgra8unorm");
  const ctx = makeFakeWebGpuContext(device, "bgra8unorm");
  const canvas = makeFakeCanvas({ webgpu: ctx });

  const handle = {
    adapter: {},
    device,
    format: "bgra8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  };

  const surface = new WebGpuSurface(canvas, handle);
  // Width: 10 pixels -> unpadded row: 40 bytes.
  // 256-byte pitch alignment -> aligned bytesPerRow = 256 bytes!
  const width = 10;
  const height = 4;
  surface.resize(width, height, 1);

  // Begin frame to capture texture reference
  const frame = surface.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
  frame.flushQuads();
  frame.end();

  // Intercept staging buffer to simulate GPU copy output
  const originalCreateBuffer = device.createBuffer.bind(device);
  let capturedStagingBuffer = null;
  device.createBuffer = (desc) => {
    const buf = originalCreateBuffer(desc);
    if (desc.label === "WebGpuCaptureStagingBuffer") {
      capturedStagingBuffer = buf;
      // Pre-fill buffer with mock BGRA values: B=200, G=150, R=100, A=255
      const alignedBytesPerRow = 256;
      const raw = new Uint8Array(alignedBytesPerRow * height);
      for (let r = 0; r < height; r++) {
        for (let x = 0; x < width; x++) {
          const idx = r * alignedBytesPerRow + x * 4;
          raw[idx] = 200;     // B
          raw[idx + 1] = 150; // G
          raw[idx + 2] = 100; // R
          raw[idx + 3] = 255; // A
        }
      }
      buf._fillData(raw);
    }
    return buf;
  };

  const capture = await surface.requestCapture();
  assert.equal(capture.width, 10);
  assert.equal(capture.height, 4);
  assert.equal(capture.data.length, 10 * 4 * 4); // 160 bytes total (no padding)

  // Verify BGRA -> RGBA swapped correctly: R=100, G=150, B=200, A=255
  assert.equal(capture.data[0], 100);
  assert.equal(capture.data[1], 150);
  assert.equal(capture.data[2], 200);
  assert.equal(capture.data[3], 255);

  // Staging buffer should be destroyed after capture
  assert.ok(capturedStagingBuffer);
  assert.equal(capturedStagingBuffer.destroyed, true);

  surface.dispose();
});

test("Device loss and uncapturederror triggers onLost and updates GpuDiagnostics", async () => {
  resetGpuDiagnosticsForTest();
  const { device } = makeFakeWebGpuDevice("rgba8unorm");

  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    setMockNavigator({
      gpu: {
        async requestAdapter() {
          return {
            async requestDevice() {
              return device;
            },
          };
        },
        getPreferredCanvasFormat() {
          return "rgba8unorm";
        },
      },
    });

    resetSharedWebGpuDevice();
    const handle = await requestWebGpuDevice();
    assert.ok(handle);

    let lossReason = null;
    handle.onLost((reason) => {
      lossReason = reason;
    });

    // Trigger uncapturederror -> validation failure
    device._triggerUncapturedError(new Error("Shader parse failed"));
    assert.equal(lossReason, "validation-failed");
    assert.equal(handle.isLost(), true);

    const diag = getGpuDiagnostics();
    assert.ok(diag.counters["chart.gpu.contextLost"] >= 1);
  } finally {
    restoreNavigator(originalDescriptor);
    resetSharedWebGpuDevice();
  }
});

test("createGpuSurface and createGpuSurfaceAsync backend selection & fallback", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();

  const { device } = makeFakeWebGpuDevice("rgba8unorm");
  const ctx = makeFakeWebGpuContext(device, "rgba8unorm");
  const fakeGl = makeFakeGl();
  const fake2d = makeFake2dContext();

  const canvas = makeFakeCanvas({
    webgpu: ctx,
    webgl2: fakeGl,
    "2d": fake2d,
  });

  const handle = {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  };

  // 1. Direct WebGPU surface creation
  const surface = createGpuSurface(canvas, "webgpu", fakeGl, handle);
  assert.equal(surface.kind, "webgpu");
  let diag = getGpuDiagnostics();
  assert.equal(diag.active, "webgpu");

  // 2. WebGPU with lost/missing handle falls back to WebGL2
  const lostHandle = { ...handle, isLost: () => true };
  const fallbackSurface = createGpuSurface(canvas, "webgpu", fakeGl, lostHandle);
  assert.equal(fallbackSurface.kind, "webgl2");
  diag = getGpuDiagnostics();
  assert.equal(diag.active, "webgl2");
  const lastFallback = diag.fallbacks[diag.fallbacks.length - 1];
  assert.equal(lastFallback.from, "webgpu");
  assert.equal(lastFallback.to, "webgl2");

  // 3. createGpuSurfaceAsync with WebGPU success
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    setMockNavigator({
      gpu: {
        async requestAdapter() {
          return {
            async requestDevice() {
              return device;
            },
          };
        },
        getPreferredCanvasFormat() {
          return "rgba8unorm";
        },
      },
    });

    resetSharedWebGpuDevice();
    const asyncSurface = await createGpuSurfaceAsync(canvas, "webgpu", fakeGl);
    assert.equal(asyncSurface.kind, "webgpu");
  } finally {
    restoreNavigator(originalDescriptor);
    resetSharedWebGpuDevice();
  }
});

test("ChartSession automatically falls back to WebGl2 or Canvas2d when WebGPU device is lost", () => {
  resetGpuDiagnosticsForTest();
  const { device } = makeFakeWebGpuDevice("rgba8unorm");
  const ctx = makeFakeWebGpuContext(device, "rgba8unorm");
  const fakeGl = makeFakeGl();
  const fake2d = makeFake2dContext();

  const win = {
    devicePixelRatio: 1,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  };

  const doc = {
    defaultView: win,
    createElement: () => makeFakeCanvas({ webgl2: fakeGl, "2d": fake2d }),
  };

  const initialCanvas = makeFakeCanvas({ webgpu: ctx, webgl2: fakeGl, "2d": fake2d });
  initialCanvas.dataset.chartSurface = "gpu-scene";
  initialCanvas.style.cssText = "position:absolute;";

  let triggerLostCallback;
  const handle = {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost(cb) {
      triggerLostCallback = cb;
      return () => {};
    },
    dispose() {},
  };

  const webgpuSurface = new WebGpuSurface(initialCanvas, handle);

  const container = {
    ownerDocument: doc,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  };

  let lostContextFired = false;
  const session = new ChartSession({
    container,
    gpuCanvas: initialCanvas,
    gpuSurface: webgpuSurface,
    annotationCanvas: makeFakeCanvas(),
    interactionCanvas: makeFakeCanvas(),
    ownerDocument: doc,
    annotationCtx2d: makeFake2dContext(),
    interactionCtx2d: makeFake2dContext(),
    renderer: { render() {}, visibleRange() { return [0, 10]; }, setSurface() {} },
    annotation: { render() {} },
    interaction: { render() {} },
    view: {},
    series: [],
    crosshair: {},
    onLostContext: () => { lostContextFired = true; },
    onRestoreContext: () => {},
    onResize: () => {},
  });

  assert.equal(session.getSurface().kind, "webgpu");

  // Trigger device loss on the WebGPU surface
  assert.ok(triggerLostCallback);
  triggerLostCallback("device-lost");

  assert.equal(lostContextFired, true);
  // Session should have replaced the surface with WebGl2
  assert.equal(session.getSurface().kind, "webgl2");

  const diag = getGpuDiagnostics();
  assert.ok(diag.fallbacks.some((f) => f.from === "webgpu" && f.to === "webgl2"));

  session.destroy();
});
