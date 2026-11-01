import test from "node:test";
import assert from "node:assert/strict";

import { QuadBatch } from "../dist/core/engine/quadBatch.js";
import {
  configurePerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

function makeGl() {
  const bufferDataCalls = [];
  const bufferSubDataCalls = [];
  const vertexAttribPointerCalls = [];
  let nextObjectId = 1;
  return {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    bufferDataCalls,
    bufferSubDataCalls,
    vertexAttribPointerCalls,
    createShader() { return { id: nextObjectId++ }; },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ""; },
    deleteShader() {},
    createProgram() { return { id: nextObjectId++ }; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ""; },
    deleteProgram() {},
    getAttribLocation(_program, name) { return name === "a_unit" ? 0 : name === "a_rect" ? 1 : 2; },
    getUniformLocation() { return { id: nextObjectId++ }; },
    createVertexArray() { return { id: nextObjectId++ }; },
    createBuffer() { return { id: nextObjectId++ }; },
    bindVertexArray() {},
    bindBuffer() {},
    bufferData(target, dataOrSize, usage) { bufferDataCalls.push({ target, dataOrSize, usage }); },
    bufferSubData(target, offset, data) { bufferSubDataCalls.push({ target, offset, length: data.length, byteLength: data.byteLength }); },
    enableVertexAttribArray() {},
    vertexAttribPointer(index, size, type, normalized, stride, offset) {
      vertexAttribPointerCalls.push({ index, size, type, normalized, stride, offset });
    },
    vertexAttribDivisor() {},
    useProgram() {},
    uniform2f() {},
    enable() {},
    blendFunc() {},
    drawArraysInstanced() {},
    deleteVertexArray() {},
    deleteBuffer() {},
  };
}

const COLOR = { r: 1, g: 0.5, b: 0.25, a: 1 };

test("QuadBatch configures 20-byte UNORM8 instance layout and performs buffer orphaning on every flush", () => {
  const gl = makeGl();
  const batch = new QuadBatch(gl, 4);

  // 1. VAO setup verifies 20-byte stride with 4-byte UNORM8 color
  const rectAttrib = gl.vertexAttribPointerCalls.find((c) => c.index === 1);
  assert.ok(rectAttrib, "a_rect attrib configured");
  assert.equal(rectAttrib.size, 4);
  assert.equal(rectAttrib.type, gl.FLOAT);
  assert.equal(rectAttrib.stride, 20, "20-byte stride for rect");
  assert.equal(rectAttrib.offset, 0);

  const colorAttrib = gl.vertexAttribPointerCalls.find((c) => c.index === 2);
  assert.ok(colorAttrib, "a_color attrib configured");
  assert.equal(colorAttrib.size, 4);
  assert.equal(colorAttrib.type, gl.UNSIGNED_BYTE);
  assert.equal(colorAttrib.normalized, true, "UNORM8 normalization enabled");
  assert.equal(colorAttrib.stride, 20, "20-byte stride for color");
  assert.equal(colorAttrib.offset, 16, "16-byte offset for color after 4 Float32s");

  // 2. Initial capacity allocation: 4 quads * 20 bytes = 80 bytes
  const dynamicAllocations = gl.bufferDataCalls.filter((call) => call.usage === gl.DYNAMIC_DRAW);
  assert.equal(dynamicAllocations.length, 1);
  assert.equal(dynamicAllocations[0].dataOrSize, 4 * 20);

  // 3. First flush orphans buffer and uploads 5 words (20 bytes) for 1 quad
  batch.begin();
  batch.rect(0, 0, 10, 10, COLOR);
  batch.flush(100, 100);

  // Buffer orphaning check: bufferData was called again on flush before bufferSubData
  const dynamicAfterFirstFlush = gl.bufferDataCalls.filter((call) => call.usage === gl.DYNAMIC_DRAW);
  assert.equal(dynamicAfterFirstFlush.length, 2, "bufferData orphaning performed on flush");
  assert.equal(gl.bufferSubDataCalls.length, 1);
  assert.equal(gl.bufferSubDataCalls[0].byteLength, 20, "20 bytes uploaded for 1 quad");

  // 4. Second flush also orphans buffer (implicit driver stall prevention)
  batch.begin();
  batch.rect(10, 10, 20, 20, COLOR);
  batch.flush(100, 100);

  const dynamicAfterSecondFlush = gl.bufferDataCalls.filter((call) => call.usage === gl.DYNAMIC_DRAW);
  assert.equal(dynamicAfterSecondFlush.length, 3, "bufferData orphaning performed on second flush");
  assert.equal(gl.bufferSubDataCalls.length, 2);
  assert.equal(gl.bufferSubDataCalls[1].byteLength, 20);
});

test("QuadBatch delivers 37.5% upload byte savings tracked via gpu.upload.bytes telemetry", () => {
  configurePerformanceTelemetry({ enabled: true });
  const gl = makeGl();
  const batch = new QuadBatch(gl, 100);

  const beforeBytes = snapshotPerformanceTelemetry().counters["gpu.upload.bytes"] ?? 0;

  batch.begin();
  for (let i = 0; i < 10; i++) {
    batch.rect(i * 10, i * 10, 10, 10, COLOR);
  }
  batch.flush(200, 200);

  const afterBytes = snapshotPerformanceTelemetry().counters["gpu.upload.bytes"] ?? 0;
  const deltaBytes = afterBytes - beforeBytes;

  // 10 quads at 20 bytes each = 200 bytes
  // Previous 32-byte layout was 10 * 32 = 320 bytes -> (320 - 200) / 320 = 37.5% reduction
  assert.equal(deltaBytes, 10 * 20, "Exact 20 bytes per quad uploaded");
  const previousLegacyBytes = 10 * 32;
  const savingsPct = ((previousLegacyBytes - deltaBytes) / previousLegacyBytes) * 100;
  assert.equal(savingsPct, 37.5, "Exact 37.5% upload byte savings achieved");
});

test("QuadBatch grows dynamic GPU capacity only when CPU capacity grows", () => {
  const gl = makeGl();
  const batch = new QuadBatch(gl, 1); // 1 quad = 20 bytes
  batch.begin();
  batch.rect(0, 0, 1, 1, COLOR);
  batch.rect(1, 1, 1, 1, COLOR);
  batch.flush(100, 100);

  // 1 constructor allocation (20B) + 1 flush with growth (>= 40B)
  const dynamicAllocations = gl.bufferDataCalls.filter((call) => call.usage === gl.DYNAMIC_DRAW);
  assert.equal(dynamicAllocations.length, 2);
  assert.ok(dynamicAllocations[1].dataOrSize >= 2 * 20);
  assert.equal(gl.bufferSubDataCalls.at(-1).byteLength, 2 * 20);
});
