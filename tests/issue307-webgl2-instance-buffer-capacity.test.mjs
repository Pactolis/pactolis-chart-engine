import test from "node:test";
import assert from "node:assert/strict";
import { HeatmapGpuRenderer } from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";

function makeGlTracker() {
  const bufferDataSizes = [];
  const bufferSubDataSizes = [];
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
    drawingBufferWidth: 600,
    drawingBufferHeight: 100,
    canvas: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } },
    getParameter: () => 4096,
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
    bufferData: (_t, data) => {
      if (typeof data === "number" && data > 1) bufferDataSizes.push(data);
    },
    bufferSubData: (_t, _off, view) => {
      bufferSubDataSizes.push(view.byteLength);
    },
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    vertexAttribDivisor: noop,
    createTexture: () => ({}),
    deleteTexture: noop,
    bindTexture: noop,
    texParameteri: noop,
    texImage2D: noop,
    texSubImage2D: noop,
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
    drawArrays: noop,
  };
  return { gl, bufferDataSizes, bufferSubDataSizes };
}

function makeCells(count) {
  return Array.from({ length: count }, (_, i) => ({
    x: (i % 60) * 10,
    yTop: Math.floor(i / 60) * 2,
    width: 10,
    height: 2,
    value: 100 + i,
  }));
}

test("#307: VBO & staging capacity separation avoids per-frame bufferData on +1 cell growth and ±1 oscillation", () => {
  const { gl, bufferDataSizes, bufferSubDataSizes } = makeGlTracker();
  const renderer = new HeatmapGpuRenderer();
  const plot = { left: 0, top: 0, width: 600, height: 100, pixelRatio: 1 };

  try {
    // Warm at 12,000 cells
    assert.equal(renderer.renderFrame(gl, { main: makeCells(12_000), extension: [], ceiling: 15_000, threshold: 10, dataKey: "k" }, plot), true);
    const dataBefore = bufferDataSizes.length;
    const subBefore = bufferSubDataSizes.length;

    // Grow +1 cell per frame for 60 frames (12,001 -> 12,060): 0 VBO reallocations and only one run's
    // tail upload per frame (these cells never stack, so each is its own run: 6 vertices x 7 floats = 168 B).
    for (let step = 1; step <= 60; step++) {
      assert.equal(renderer.renderFrame(gl, { main: makeCells(12_000 + step), extension: [], ceiling: 15_000, threshold: 10, dataKey: "k" }, plot), true);
    }
    assert.equal(bufferDataSizes.length - dataBefore, 0, "60 frames of +1 growth must perform 0 VBO bufferData reallocations");
    const subBytes = bufferSubDataSizes.slice(subBefore).reduce((a, b) => a + b, 0);
    assert.equal(subBytes, 60 * 168, "60 frames of +1 growth must upload only 60 * 168 B = 10,080 B");

    // 12,288 <-> 12,289 oscillation -> 0 VBO reallocations after initial headroom
    assert.equal(renderer.renderFrame(gl, { main: makeCells(12_288), extension: [], ceiling: 15_000, threshold: 10, dataKey: "k" }, plot), true);
    assert.equal(renderer.renderFrame(gl, { main: makeCells(12_289), extension: [], ceiling: 15_000, threshold: 10, dataKey: "k" }, plot), true);
    const dataBeforeOsc = bufferDataSizes.length;
    for (let i = 0; i < 10; i++) {
      assert.equal(renderer.renderFrame(gl, { main: makeCells(i % 2 === 0 ? 12_288 : 12_289), extension: [], ceiling: 15_000, threshold: 10, dataKey: "k" }, plot), true);
    }
    assert.equal(bufferDataSizes.length - dataBeforeOsc, 0, "12,288 <-> 12,289 oscillation must perform 0 VBO reallocations");

    // Sudden shrink 12,289 -> 200 triggers shrink hysteresis and releases budget
    const reservedBeforeShrink = renderer.reservedBytes;
    assert.equal(renderer.renderFrame(gl, { main: makeCells(200), extension: [], ceiling: 15_000, threshold: 10, dataKey: "k" }, plot), true);
    assert.ok(renderer.reservedBytes < reservedBeforeShrink, "sudden shrink must release VBO/staging budget");
  } finally {
    renderer.dispose();
    assert.equal(renderer.reservedBytes, 0);
  }
});
