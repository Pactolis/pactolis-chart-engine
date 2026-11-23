import test from "node:test";
import assert from "node:assert/strict";
import { HeatmapGpuRenderer } from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";
import { WebGpuNativeHeatmapPipeline } from "../dist/core/gpu/webgpu/webgpuNativeHeatmapPipeline.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

function makeGlMock() {
  const texSubCalls = [];
  const bufferSubCalls = [];
  const noop = () => {};
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    R32F: 0x822e,
    R8: 0x8229,
    RED: 0x1903,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0x0cf5,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    CULL_FACE: 0x0b44,
    DEPTH_TEST: 0x0b71,
    STENCIL_TEST: 0x0b90,
    RASTERIZER_DISCARD: 0x8c89,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ONE: 1,
    SCISSOR_TEST: 0x0c11,
    TRIANGLES: 0x0004,
    MAX_TEXTURE_SIZE: 0x0d33,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    drawingBufferWidth: 400,
    drawingBufferHeight: 300,
    canvas: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } },
    getParameter: (p) => (p === 0x0d33 ? 4096 : 0),
    createShader: () => ({}),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => true,
    deleteShader: noop,
    deleteProgram: noop,
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    createVertexArray: () => ({}),
    deleteVertexArray: noop,
    createBuffer: () => ({}),
    deleteBuffer: noop,
    bindVertexArray: noop,
    bindBuffer: noop,
    bufferData: noop,
    bufferSubData: (_t, offset, view) => bufferSubCalls.push({ offset, bytes: view.byteLength }),
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    vertexAttribDivisor: noop,
    createTexture: () => ({}),
    deleteTexture: noop,
    bindTexture: noop,
    texParameteri: noop,
    texImage2D: noop,
    texSubImage2D: (_t, _l, x, y, w, h, _f, type) => {
      texSubCalls.push({ x, y, w, h, bytes: w * h * (type === 0x1406 ? 4 : 1) });
    },
    pixelStorei: noop,
    viewport: noop,
    useProgram: noop,
    uniform2f: noop,
    uniform1f: noop,
    uniform1i: noop,
    activeTexture: noop,
    disable: noop,
    enable: noop,
    blendFunc: noop,
    blendFuncSeparate: noop,
    scissor: noop,
    drawArraysInstanced: noop,
  };
  return { gl, texSubCalls, bufferSubCalls };
}

function makeWebGpuDevice() {
  const cellWrites = [];
  const device = {
    limits: { maxBufferSize: 128 * 1024 * 1024 },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: (desc) => ({ label: desc.label, size: desc.size, destroy() {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setScissorRect() {},
        setPipeline() {},
        setBindGroup() {},
        draw() {},
        end() {},
      }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buf, offset, _src, _dOff, size) {
        if (buf.label === "NativeHeatmapCellStorage") cellWrites.push({ offset, size });
      },
      submit() {},
    },
  };
  return { device, cellWrites };
}

test("#298: palette/opacity change skips cell reads (contentRevision) and single-cell change uploads partial range", () => {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  resetPerformanceTelemetry();

  const { gl, texSubCalls, bufferSubCalls } = makeGlMock();
  const glRenderer = new HeatmapGpuRenderer();
  const { device, cellWrites } = makeWebGpuDevice();
  const gpuPipeline = new WebGpuNativeHeatmapPipeline(device, "rgba8unorm");
  const target = { createView: () => ({}) };
  const plot = { left: 0, top: 0, width: 400, height: 300, pixelRatio: 1 };

  const main = Array.from({ length: 1200 }, (_, i) => ({
    x: (i % 60) * 5,
    yTop: Math.floor(i / 60) * 10,
    width: 5,
    height: 10,
    value: 100 + i,
  }));

  try {
    const frame1 = { main, extension: [], ceiling: 2000, threshold: 10, opacity: 0.8, palette: "pactolis", dataKey: "k", contentRevision: 1 };
    assert.equal(glRenderer.renderFrame(gl, frame1, plot), true);
    assert.equal(gpuPipeline.renderFrame(target, 400, 300, 1, frame1, plot), true);

    const texCallsBeforePalette = texSubCalls.length;
    const bufCallsBeforePalette = bufferSubCalls.length;
    const wgCellWritesBeforePalette = cellWrites.length;
    resetPerformanceTelemetry();

    // Palette + opacity change with a getter that throws if `value` is re-read!
    let valueReads = 0;
    const guardedMain = main.map((r) => {
      const val = r.value;
      return {
        x: r.x,
        yTop: r.yTop,
        width: r.width,
        height: r.height,
        get value() { valueReads++; return val; },
      };
    });
    // Warm once with guardedMain under contentRevision 2
    const frame2 = { main: guardedMain, extension: [], ceiling: 2000, threshold: 10, opacity: 0.8, palette: "pactolis", dataKey: "k", contentRevision: 2 };
    assert.equal(glRenderer.renderFrame(gl, frame2, plot), true);
    assert.equal(gpuPipeline.renderFrame(target, 400, 300, 1, frame2, plot), true);
    const readsAfterWarm = valueReads;

    // Now change ONLY palette & opacity with same contentRevision -> 0 extra value reads and 0 cell uploads
    const frame2Palette = { ...frame2, palette: "viridis", opacity: 0.55 };
    assert.equal(glRenderer.renderFrame(gl, frame2Palette, plot), true);
    assert.equal(gpuPipeline.renderFrame(target, 400, 300, 1, frame2Palette, plot), true);
    assert.equal(valueReads, readsAfterWarm, "palette/opacity change must not re-read cell values");
    assert.equal(bufferSubCalls.length, bufCallsBeforePalette + 0);
    assert.equal(cellWrites.length, wgCellWritesBeforePalette + 0);

    // Mutate only the last cell's value -> partial upload (32 B in WebGPU, <= 4 B density sub-texel in WebGL2)
    const nextMain = main.map((r, idx) => (idx === main.length - 1 ? { ...r, value: 9999 } : r));
    const texBeforeSingle = texSubCalls.length;
    const wgBeforeSingle = cellWrites.length;
    const frame3 = { main: nextMain, extension: [], ceiling: 10000, threshold: 10, opacity: 0.55, palette: "viridis", dataKey: "k", contentRevision: 3 };
    assert.equal(glRenderer.renderFrame(gl, frame3, plot), true);
    assert.equal(gpuPipeline.renderFrame(target, 400, 300, 1, frame3, plot), true);

    const glSingleUploadBytes = texSubCalls.slice(texBeforeSingle).reduce((s, c) => s + c.bytes, 0);
    assert.equal(glSingleUploadBytes, 4, "WebGL2 single-cell value update uploads 1 R32F texel (4 B)");
    const wgSingleWrites = cellWrites.slice(wgBeforeSingle);
    assert.equal(wgSingleWrites.length, 1);
    assert.equal(wgSingleWrites[0].size, 32, "WebGPU single-cell update uploads 1 record (32 B)");
    assert.ok(texCallsBeforePalette > 0);
    assert.ok(snapshotPerformanceTelemetry());
  } finally {
    glRenderer.dispose();
    gpuPipeline.dispose();
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
});
