import test from "node:test";
import assert from "node:assert/strict";

import {
  copyGpuDiagnosticsJson,
  getGpuDiagnostics,
  recordGpuBackendSelection,
  recordGpuFallback,
  recordGpuFrame,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import { Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";
import { WebGl2Surface } from "../dist/core/gpu/webgl2/webgl2Surface.js";
import { WebGl2HeatmapLayer } from "../dist/core/gpu/webgl2/webgl2Heatmap.js";
import { WebGpuSurface } from "../dist/core/gpu/webgpu/webgpuSurface.js";
import { WebGpuHeatmapLayer } from "../dist/core/gpu/webgpu/webgpuHeatmap.js";
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

function makeFakeGl() {
  const operations = [];
  const textures = [];
  const buffers = [];
  const programs = [];
  const vaos = [];

  return {
    drawingBufferWidth: 640,
    drawingBufferHeight: 360,
    operations,
    canvas: { width: 640, height: 360 },
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TEXTURE_2D: 3553,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    LINEAR: 9729,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    CLAMP_TO_EDGE: 33071,
    R32F: 33326,
    RED: 6403,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    R8: 33321,
    BLEND: 3042,
    SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771,
    TEXTURE0: 33984,
    TRIANGLES: 4,

    createShader(type) {
      return { type, source: "", compiled: true };
    },
    shaderSource(shader, src) {
      shader.source = src;
    },
    compileShader() {},
    getShaderParameter(_shader, _pname) {
      return true;
    },
    getShaderInfoLog() {
      return "";
    },
    createProgram() {
      const prog = { attached: [], linked: true };
      programs.push(prog);
      return prog;
    },
    attachShader(prog, shader) {
      prog.attached.push(shader);
    },
    linkProgram() {},
    getProgramParameter(_program, _pname) {
      return true;
    },
    getProgramInfoLog() {
      return "";
    },
    deleteShader() {},
    deleteProgram(p) { p.deleted = true; },
    getUniformLocation(_p, name) {
      return { name };
    },
    getAttribLocation(_p, name) {
      return name === "a_position" ? 0 : 1;
    },
    createVertexArray() {
      const vao = { deleted: false };
      vaos.push(vao);
      return vao;
    },
    deleteVertexArray(v) { v.deleted = true; },
    createBuffer() {
      const buf = { deleted: false, data: null };
      buffers.push(buf);
      return buf;
    },
    deleteBuffer(b) { b.deleted = true; },
    bindVertexArray() {},
    bindBuffer() {},
    bufferData(_target, data) {
      operations.push({ op: "bufferData", length: data.length });
    },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    createTexture() {
      const tex = { deleted: false, width: 0, height: 0, format: 0, data: null };
      textures.push(tex);
      return tex;
    },
    deleteTexture(t) { t.deleted = true; },
    bindTexture(_target, tex) {
      this.currentTexture = tex;
    },
    texParameteri() {},
    texImage2D(_target, _level, internalFormat, width, height, _border, _format, _type, data) {
      if (this.currentTexture) {
        this.currentTexture.width = width;
        this.currentTexture.height = height;
        this.currentTexture.format = internalFormat;
        this.currentTexture.data = data;
      }
      operations.push({ op: "texImage2D", internalFormat, width, height });
    },
    useProgram() {},
    enable() {},
    blendFunc() {},
    uniform2f() {},
    uniform4f() {},
    uniform1f() {},
    uniform1i() {},
    activeTexture() {},
    drawArrays(_mode, first, count) {
      operations.push({ op: "drawArrays", first, count });
    },
    readPixels(_x, _y, w, h, _format, _type, buffer) {
      // Mock deterministic RGBA values
      for (let i = 0; i < w * h; i++) {
        buffer[i * 4] = 51;      // R
        buffer[i * 4 + 1] = 102;  // G
        buffer[i * 4 + 2] = 153;  // B
        buffer[i * 4 + 3] = 255;  // A
      }
    },
    viewport() {},
    clearColor() {},
    clear() {},
  };
}

function makeFakeWebGpuDevice(format = "rgba8unorm") {
  const buffers = [];
  const textures = [];
  const passes = [];
  const writtenBuffers = [];
  const writtenTextures = [];
  let lostResolve;
  const lostPromise = new Promise((resolve) => {
    lostResolve = resolve;
  });

  const device = {
    format,
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    lost: lostPromise,
    _triggerLost(info = { reason: "destroyed" }) {
      lostResolve(info);
    },
    addEventListener() {},
    removeEventListener() {},
    createShaderModule(desc) {
      return { label: desc.label, code: desc.code };
    },
    createSampler(desc) {
      return { label: desc?.label ?? "sampler", desc };
    },
    createBuffer(desc) {
      const mappedData = new Uint8Array(desc.size);
      const buf = {
        label: desc.label,
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        destroy() { this.destroyed = true; },
        async mapAsync() {},
        getMappedRange() { return mappedData.buffer; },
        unmap() {},
        _fillData(data) { mappedData.set(data); },
      };
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
      return { label: desc.label, layout: desc.layout };
    },
    createTexture(desc) {
      const tex = {
        label: desc.label,
        size: desc.size,
        format: desc.format,
        width: Array.isArray(desc.size) ? desc.size[0] : desc.size.width,
        height: Array.isArray(desc.size) ? desc.size[1] : desc.size.height,
        destroyed: false,
        destroy() { this.destroyed = true; },
        createView() { return { texture: this }; },
      };
      textures.push(tex);
      return tex;
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
            draws: [],
            setPipeline(p) { this.pipeline = p; },
            setBindGroup(idx, bg) { this.bindGroups.set(idx, bg); },
            setVertexBuffer() {},
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
        finish() { return { recordedDraws, copies }; },
      };
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        writtenBuffers.push({ buffer, offset, data });
      },
      writeTexture(dest, data, dataLayout, size) {
        writtenTextures.push({ dest, data, dataLayout, size });
      },
      submit() {},
    },
  };

  return { device, buffers, textures, passes, writtenBuffers, writtenTextures };
}

function makeFakeCanvas(contextMap = {}) {
  const listeners = new Map();
  return {
    dataset: {},
    style: { cssText: "position:absolute;width:100%;height:100%;" },
    width: 640,
    height: 360,
    parentNode: { replaceChild: () => {} },
    replaceWith(next) { this.replacedWith = next; },
    getContext(kind) { return contextMap[kind] ?? null; },
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
}

function makeFake2dContext() {
  const operations = [];
  return {
    operations,
    fillStyle: "",
    save() {},
    restore() {},
    setTransform() {},
    fillRect(x, y, w, h) {
      operations.push({ op: "fillRect", x, y, w, h, fillStyle: this.fillStyle });
    },
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = 51;
        data[i * 4 + 1] = 102;
        data[i * 4 + 2] = 153;
        data[i * 4 + 3] = 255;
      }
      return { data, width: w, height: h };
    },
  };
}

test("WebGl2HeatmapLayer uploads density, draws quad and cleans up on dispose", () => {
  const fakeGl = makeFakeGl();
  const heatmap = new WebGl2HeatmapLayer(fakeGl);
  assert.equal(heatmap.kind, "webgl2");

  // Upload Float32Array
  const dataF32 = new Float32Array(64 * 32);
  dataF32.fill(0.5);
  heatmap.upload(64, 32, dataF32);
  assert.deepEqual(heatmap.getDimensions(), { width: 64, height: 32 });
  const texUpload1 = fakeGl.operations.find((op) => op.op === "texImage2D");
  assert.ok(texUpload1);
  assert.equal(texUpload1.internalFormat, fakeGl.R32F);

  // Draw quad
  heatmap.draw({ x: 10, y: 20, w: 200, h: 100 }, 0.8);
  const drawOp = fakeGl.operations.find((op) => op.op === "drawArrays");
  assert.ok(drawOp);
  assert.equal(drawOp.count, 6);

  // Upload Uint8Array RGBA and verify dimension change
  const dataU8 = new Uint8Array(128 * 64 * 4);
  heatmap.upload(128, 64, dataU8);
  assert.deepEqual(heatmap.getDimensions(), { width: 128, height: 64 });
  const texUpload2 = fakeGl.operations.filter((op) => op.op === "texImage2D")[1];
  assert.equal(texUpload2.internalFormat, fakeGl.RGBA);

  heatmap.dispose();
});

test("WebGpuHeatmapLayer uploads texture, stores draw params, records pass and disposes", () => {
  const { device, textures, writtenTextures } = makeFakeWebGpuDevice("rgba8unorm");
  const heatmap = new WebGpuHeatmapLayer(device, "rgba8unorm");
  assert.equal(heatmap.kind, "webgpu");

  // Upload Float32Array
  const f32Data = new Float32Array(32 * 16);
  f32Data.fill(0.75);
  heatmap.upload(32, 16, f32Data);
  assert.deepEqual(heatmap.getDimensions(), { width: 32, height: 16 });
  assert.equal(textures.length, 1);
  assert.equal(writtenTextures.length, 1);

  // Draw and record pass
  heatmap.draw({ x: 5, y: 10, w: 150, h: 80 }, 0.9);
  const lastParams = heatmap.getLastDrawParams();
  assert.deepEqual(lastParams.rect, { x: 5, y: 10, w: 150, h: 80 });
  assert.equal(lastParams.opacity, 0.9);

  let passDrawn = false;
  const mockPass = {
    setPipeline() {},
    setBindGroup() {},
    draw(count) {
      if (count === 6) passDrawn = true;
    },
  };
  heatmap.recordPass(mockPass, 800, 600);
  assert.equal(passDrawn, true);

  // Resize dimension change recreates texture
  heatmap.upload(64, 64, new Uint8Array(64 * 64 * 4));
  assert.deepEqual(heatmap.getDimensions(), { width: 64, height: 64 });
  assert.ok(textures.length >= 2);
  assert.equal(textures[0].destroyed, true);

  heatmap.dispose();
});

test("Surface and Heatmap integration: WebGl2Surface and WebGpuSurface expose active HeatmapLayer", () => {
  const fakeGl = makeFakeGl();
  const glCanvas = makeFakeCanvas({ webgl2: fakeGl });
  const webglSurface = new WebGl2Surface(glCanvas, fakeGl);
  assert.ok(webglSurface.heatmap instanceof WebGl2HeatmapLayer);
  assert.equal(webglSurface.heatmap.kind, "webgl2");

  const { device } = makeFakeWebGpuDevice("rgba8unorm");
  const gpuCanvas = makeFakeCanvas();
  const handle = {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  };
  const webgpuSurface = new WebGpuSurface(gpuCanvas, handle);
  assert.ok(webgpuSurface.heatmap instanceof WebGpuHeatmapLayer);
  assert.equal(webgpuSurface.heatmap.kind, "webgpu");

  const c2dCanvas = makeFakeCanvas({ "2d": makeFake2dContext() });
  const c2dSurface = new Canvas2dSurface(c2dCanvas);
  assert.equal(c2dSurface.heatmap, null);

  webglSurface.dispose();
  webgpuSurface.dispose();
  c2dSurface.dispose();
});

test("Pixel capture parity across WebGpuSurface, WebGl2Surface and Canvas2dSurface", async () => {
  const width = 16;
  const height = 16;

  // 1. Canvas2D surface
  const fake2d = makeFake2dContext();
  const c2dCanvas = makeFakeCanvas({ "2d": fake2d });
  c2dCanvas.width = width;
  c2dCanvas.height = height;
  const c2dSurface = new Canvas2dSurface(c2dCanvas);
  c2dSurface.resize(width, height, 1);
  const c2dFrame = c2dSurface.beginFrame({ r: 0.2, g: 0.4, b: 0.6, a: 1.0 });
  c2dFrame.quads.rect(0, 0, width, height, { r: 0.2, g: 0.4, b: 0.6, a: 1.0 });
  c2dFrame.flushQuads();
  c2dFrame.end();
  const c2dCapture = await c2dSurface.requestCapture();

  // 2. WebGL2 surface
  const fakeGl = makeFakeGl();
  const glCanvas = makeFakeCanvas({ webgl2: fakeGl });
  glCanvas.width = width;
  glCanvas.height = height;
  const glSurface = new WebGl2Surface(glCanvas, fakeGl);
  glSurface.resize(width, height, 1);
  const glFrame = glSurface.beginFrame({ r: 0.2, g: 0.4, b: 0.6, a: 1.0 });
  glFrame.quads.rect(0, 0, width, height, { r: 0.2, g: 0.4, b: 0.6, a: 1.0 });
  glFrame.flushQuads();
  glFrame.end();
  const glCapture = await glSurface.requestCapture();

  // 3. WebGPU surface
  const { device } = makeFakeWebGpuDevice("rgba8unorm");
  const gpuCanvas = makeFakeCanvas();
  gpuCanvas.width = width;
  gpuCanvas.height = height;
  const handle = {
    adapter: {},
    device,
    format: "rgba8unorm",
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    isLost: () => false,
    onLost: () => () => {},
    dispose: () => {},
  };
  const webgpuSurface = new WebGpuSurface(gpuCanvas, handle);
  webgpuSurface.resize(width, height, 1);
  const gpuFrame = webgpuSurface.beginFrame({ r: 0.2, g: 0.4, b: 0.6, a: 1.0 });
  gpuFrame.quads.rect(0, 0, width, height, { r: 0.2, g: 0.4, b: 0.6, a: 1.0 });
  gpuFrame.flushQuads();
  gpuFrame.end();

  // Mock capture staging buffer fill
  const originalCreateBuffer = device.createBuffer.bind(device);
  device.createBuffer = (desc) => {
    const buf = originalCreateBuffer(desc);
    if (desc.label === "WebGpuCaptureStagingBuffer") {
      const raw = new Uint8Array(256 * height);
      for (let r = 0; r < height; r++) {
        for (let x = 0; x < width; x++) {
          const idx = r * 256 + x * 4;
          raw[idx] = 51;
          raw[idx + 1] = 102;
          raw[idx + 2] = 153;
          raw[idx + 3] = 255;
        }
      }
      buf._fillData(raw);
    }
    return buf;
  };
  const webgpuCapture = await webgpuSurface.requestCapture();

  // Parity checks
  assert.equal(c2dCapture.width, width);
  assert.equal(glCapture.width, width);
  assert.equal(webgpuCapture.width, width);
  assert.equal(c2dCapture.height, height);
  assert.equal(glCapture.height, height);
  assert.equal(webgpuCapture.height, height);

  assert.equal(c2dCapture.data.length, width * height * 4);
  assert.equal(glCapture.data.length, width * height * 4);
  assert.equal(webgpuCapture.data.length, width * height * 4);

  // RGBA parity: verify pixel [0..3]
  for (let i = 0; i < 4; i++) {
    assert.equal(glCapture.data[i], c2dCapture.data[i]);
    assert.equal(webgpuCapture.data[i], c2dCapture.data[i]);
  }

  c2dSurface.dispose();
  glSurface.dispose();
  webgpuSurface.dispose();
});

test("Full fallback cascade: WebGPU loss -> WebGL2 -> 5s context-restore timeout -> Canvas2dSurface", async () => {
  resetGpuDiagnosticsForTest();

  const originalSetTimeout = globalThis.setTimeout;
  let scheduledTimeoutCb = null;
  let scheduledDelay = 0;

  // Intercept setTimeout to verify 5s timeout without waiting real time
  globalThis.setTimeout = (cb, delay) => {
    scheduledTimeoutCb = cb;
    scheduledDelay = delay;
    return 999;
  };

  try {
    const fakeGl = makeFakeGl();
    const fake2d = makeFake2dContext();
    const { device } = makeFakeWebGpuDevice("rgba8unorm");

    let webgpuLostCb = null;
    const handle = {
      adapter: {},
      device,
      format: "rgba8unorm",
      limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
      isLost: () => false,
      onLost(cb) {
        webgpuLostCb = cb;
        return () => {};
      },
      dispose: () => {},
    };

    const initialCanvas = makeFakeCanvas({ webgl2: fakeGl, "2d": fake2d });
    initialCanvas.dataset.chartSurface = "gpu-scene";
    const webgpuSurface = new WebGpuSurface(initialCanvas, handle);

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

    const container = {
      ownerDocument: doc,
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    };

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
      onLostContext: () => {},
      onRestoreContext: () => {},
      onResize: () => {},
    });

    assert.equal(session.getSurface().kind, "webgpu");

    // 1. WebGPU device loss triggers fallback to WebGL2
    assert.ok(webgpuLostCb);
    webgpuLostCb("device-lost");
    assert.equal(session.getSurface().kind, "webgl2");

    // 2. WebGL context lost occurs on the active canvas
    const activeCanvas = session.getSurface().canvas;
    activeCanvas.dispatchEvent("webglcontextlost", { preventDefault() {} });

    // Verify 5s timeout was scheduled
    assert.equal(scheduledDelay, 5000);
    assert.ok(scheduledTimeoutCb);

    // 3. Fast-forward timeout: triggers fallback to Canvas2D
    scheduledTimeoutCb();
    assert.equal(session.getSurface().kind, "canvas2d");

    // Verify diagnostics recorded full cascade
    const diag = getGpuDiagnostics();
    const reasons = diag.fallbacks.map((f) => `${f.from}->${f.to}`);
    assert.ok(reasons.includes("webgpu->webgl2"));
    assert.ok(reasons.includes("webgl2->canvas2d"));

    session.destroy();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("GpuDiagnostics percentile metrics, counters and copyGpuDiagnosticsJson output", () => {
  resetGpuDiagnosticsForTest();

  recordGpuBackendSelection("webgpu", "webgpu");
  recordGpuFrame("webgpu", 1.2, 16.6);
  recordGpuFrame("webgpu", 1.8, 16.7);
  recordGpuFrame("webgpu", 2.4, 16.6);
  recordGpuFallback("webgpu", "webgl2", "device_lost");

  const diag = getGpuDiagnostics();
  assert.equal(diag.active, "webgpu");
  assert.equal(diag.counters["gpu.backend.webgpu.frames"], 3);
  assert.ok(diag.frame.renderP50Ms > 0);
  assert.ok(diag.frame.renderP95Ms >= diag.frame.renderP50Ms);

  const jsonStr = copyGpuDiagnosticsJson();
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.active, "webgpu");
  assert.equal(parsed.counters["gpu.backend.webgpu.frames"], 3);
  assert.equal(parsed.fallbacks[0].reason, "device_lost");
});
