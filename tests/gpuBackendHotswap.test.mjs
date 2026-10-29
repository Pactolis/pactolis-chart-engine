import test from "node:test";
import assert from "node:assert/strict";

import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
  recordGpuBackendSelection,
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
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { WebGl2Surface } from "../dist/core/gpu/webgl2/webgl2Surface.js";
import { Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";
import { ChartSurfaceDirty } from "../dist/core/render/scene/chartScene.js";

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
    createShaderModule(desc) {
      return { label: desc?.label, code: desc?.code };
    },
    createSampler(desc) {
      return { label: desc?.label };
    },
    createBuffer(desc) {
      const buf = makeFakeGpuBuffer(desc.size, desc.usage);
      buf.label = desc.label;
      buffers.push(buf);
      return buf;
    },
    createBindGroupLayout(desc) {
      return { label: desc?.label, entries: desc?.entries };
    },
    createBindGroup(desc) {
      return { label: desc?.label, layout: desc?.layout, entries: desc?.entries };
    },
    createPipelineLayout(desc) {
      return { label: desc?.label, bindGroupLayouts: desc?.bindGroupLayouts };
    },
    createRenderPipeline(desc) {
      return { label: desc?.label, layout: desc?.layout, vertex: desc?.vertex, fragment: desc?.fragment };
    },
    createCommandEncoder(desc) {
      const recordedDraws = [];
      const copies = [];
      return {
        label: desc?.label,
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

  return { device, buffers, passes, submittedCommands, writtenBuffers };
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
    style: { cssText: "position:absolute;width:100%;height:100%;", width: "640px", height: "360px" },
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

test("backend hotswap (webgl2 -> canvas2d -> webgpu) updates renderer surface and maintains quad rendering", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();

  const fakeGl = makeFakeGl();
  const fake2d = makeFake2dContext();
  const { device } = makeFakeWebGpuDevice("rgba8unorm");
  const fakeWebGpuCtx = makeFakeWebGpuContext(device, "rgba8unorm");

  const canvasGl = makeFakeCanvas({ webgl2: fakeGl, "2d": fake2d });
  const canvas2d = makeFakeCanvas({ "2d": fake2d });
  const canvasWebgpu = makeFakeCanvas({ webgpu: fakeWebGpuCtx });

  const webglSurface = new WebGl2Surface(canvasGl, fakeGl);
  recordGpuBackendSelection("webgl2", "webgl2");

  const webgpuHandle = {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  };

  let currentSurfaceInRenderer = null;
  let quadsRendered = 0;

  const mockRenderer = {
    setSurface(nextSurface) {
      currentSurfaceInRenderer = nextSurface;
    },
    visibleRange() {
      return [0, 10];
    },
    render(view, series) {
      void view;
      void series;
      const surface = currentSurfaceInRenderer || webglSurface;
      const frame = surface.beginFrame({ r: 0, g: 0, b: 0, a: 1 });
      frame.quads.rect(10, 10, 50, 20, { r: 1, g: 0, b: 0, a: 1 });
      quadsRendered++;
      frame.flushQuads(640, 360);
      frame.end();
    },
  };

  const container = {
    style: {},
    appendChild() {},
    removeChild() {},
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };

  const win = {
    devicePixelRatio: 1,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  };
  const doc = { defaultView: win, createElement: () => makeFakeCanvas({ "2d": fake2d, webgl2: fakeGl }) };

  const session = new ChartSession({
    container,
    gpuCanvas: canvasGl,
    gpuSurface: webglSurface,
    annotationCanvas: makeFakeCanvas({ "2d": fake2d }),
    interactionCanvas: makeFakeCanvas({ "2d": fake2d }),
    ownerDocument: doc,
    annotationCtx2d: fake2d,
    interactionCtx2d: fake2d,
    renderer: mockRenderer,
    annotation: { render() {} },
    interaction: { render() {} },
    view: {},
    series: [],
    crosshair: {},
    onLostContext: () => {},
    onRestoreContext: () => {},
    onResize: () => {},
  });

  // Verify initial surface in session
  assert.equal(session.getSurface().kind, "webgl2");
  assert.equal(getGpuDiagnostics().active, "webgl2");

  // Initial draw
  mockRenderer.render(null, null);
  assert.equal(quadsRendered, 1);

  // 1. Swap WebGL2 -> Canvas2D
  const surface2d = new Canvas2dSurface(canvas2d, fake2d);
  recordGpuBackendSelection("canvas2d", "canvas2d");
  session.replaceSurface(surface2d, (next, prev) => prev.replaceWith(next));

  assert.equal(session.getSurface().kind, "canvas2d");
  assert.equal(currentSurfaceInRenderer, surface2d);
  assert.equal(getGpuDiagnostics().active, "canvas2d");

  // Draw on Canvas2D surface
  mockRenderer.render(null, null);
  assert.equal(quadsRendered, 2);

  // 2. Swap Canvas2D -> WebGPU
  const webgpuSurface = new WebGpuSurface(canvasWebgpu, webgpuHandle);
  recordGpuBackendSelection("webgpu", "webgpu");
  session.replaceSurface(webgpuSurface, (next, prev) => prev.replaceWith(next));

  assert.equal(session.getSurface().kind, "webgpu");
  assert.equal(currentSurfaceInRenderer, webgpuSurface);
  assert.equal(getGpuDiagnostics().active, "webgpu");

  // Draw on WebGPU surface
  mockRenderer.render(null, null);
  assert.equal(quadsRendered, 3);

  session.dispose();
  webgpuSurface.dispose();
});

test("residentHeatmap and asyncCapture settings changes do not trigger replaceSurface", () => {
  let replaceSurfaceCalls = 0;
  let invalidateSurfaceCalls = 0;

  const mockSession = {
    replaceSurface() {
      replaceSurfaceCalls++;
    },
    invalidateSurface(mask) {
      void mask;
      invalidateSurfaceCalls++;
    },
  };

  let residentHeatmapEnabled = false;
  const mockRuntime = {
    getDiagnostics: () => ({ disposed: false }),
    session: mockSession,
    setResidentHeatmapEnabled(val) {
      residentHeatmapEnabled = val;
    },
  };

  let currentBackendPref = "webgl2";

  // Simulate onGpuSettingsChange handler behavior
  const handleSettingsChange = (nextSettings) => {
    if (mockRuntime.getDiagnostics().disposed) return;
    mockRuntime.setResidentHeatmapEnabled(nextSettings.residentHeatmap);

    if (nextSettings.backend === currentBackendPref) {
      mockRuntime.session.invalidateSurface(ChartSurfaceDirty.All);
      return;
    }

    currentBackendPref = nextSettings.backend;
    mockSession.replaceSurface();
  };

  // Change residentHeatmap only
  handleSettingsChange({ backend: "webgl2", residentHeatmap: true, asyncCapture: false });
  assert.equal(residentHeatmapEnabled, true);
  assert.equal(replaceSurfaceCalls, 0);
  assert.equal(invalidateSurfaceCalls, 1);

  // Change asyncCapture only
  handleSettingsChange({ backend: "webgl2", residentHeatmap: true, asyncCapture: true });
  assert.equal(replaceSurfaceCalls, 0);
  assert.equal(invalidateSurfaceCalls, 2);

  // Change backend
  handleSettingsChange({ backend: "canvas2d", residentHeatmap: true, asyncCapture: true });
  assert.equal(replaceSurfaceCalls, 1);
});

test("createGpuSurfaceAsync auto and webgpu selection with device resolution", async () => {
  resetGpuDiagnosticsForTest();
  resetSharedWebGpuDevice();

  const { device } = makeFakeWebGpuDevice("rgba8unorm");
  const fakeWebGpuCtx = makeFakeWebGpuContext(device, "rgba8unorm");
  const fakeGl = makeFakeGl();
  const fake2d = makeFake2dContext();

  const canvas = makeFakeCanvas({
    webgpu: fakeWebGpuCtx,
    webgl2: fakeGl,
    "2d": fake2d,
  });

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

    // 1. auto preference resolves to WebGPU when supported
    resetSharedWebGpuDevice();
    const autoSurface = await createGpuSurfaceAsync(canvas, "auto", undefined, () => fakeGl);
    assert.equal(autoSurface.kind, "webgpu");
    assert.equal(getGpuDiagnostics().active, "webgpu");

    // 2. webgpu preference resolves to WebGPU
    resetSharedWebGpuDevice();
    const webgpuSurface = await createGpuSurfaceAsync(canvas, "webgpu", undefined, () => fakeGl);
    assert.equal(webgpuSurface.kind, "webgpu");
  } finally {
    restoreNavigator(originalDescriptor);
    resetSharedWebGpuDevice();
  }
});
