import test from "node:test";
import assert from "node:assert/strict";

import { QuadBatch } from "../dist/core/engine/quadBatch.js";

function makeGl() {
  const bufferDataCalls = [];
  const bufferSubDataCalls = [];
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
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    bufferDataCalls,
    bufferSubDataCalls,
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
    bufferSubData(target, offset, data) { bufferSubDataCalls.push({ target, offset, length: data.length }); },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
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

test("QuadBatch allocates dynamic GPU capacity once and uses bufferSubData for steady-state uploads", () => {
  const gl = makeGl();
  const batch = new QuadBatch(gl, 4);
  const dynamicAllocationsAfterConstruction = gl.bufferDataCalls.filter((call) => call.usage === gl.DYNAMIC_DRAW);
  assert.equal(dynamicAllocationsAfterConstruction.length, 1);
  assert.equal(dynamicAllocationsAfterConstruction[0].dataOrSize, 4 * 8 * Float32Array.BYTES_PER_ELEMENT);

  batch.begin();
  batch.rect(0, 0, 10, 10, COLOR);
  batch.flush(100, 100);
  batch.begin();
  batch.rect(10, 10, 20, 20, COLOR);
  batch.flush(100, 100);

  assert.equal(gl.bufferDataCalls.filter((call) => call.usage === gl.DYNAMIC_DRAW).length, 1,
    "steady-state flushes must not orphan/reallocate the instance buffer");
  assert.deepEqual(gl.bufferSubDataCalls.map((call) => [call.offset, call.length]), [[0, 8], [0, 8]]);
});

test("QuadBatch grows dynamic GPU capacity only when CPU capacity grows", () => {
  const gl = makeGl();
  const batch = new QuadBatch(gl, 1);
  batch.begin();
  batch.rect(0, 0, 1, 1, COLOR);
  batch.rect(1, 1, 1, 1, COLOR);
  batch.flush(100, 100);

  const dynamicAllocations = gl.bufferDataCalls.filter((call) => call.usage === gl.DYNAMIC_DRAW);
  assert.equal(dynamicAllocations.length, 2, "one constructor allocation plus one growth allocation expected");
  assert.ok(dynamicAllocations[1].dataOrSize >= 2 * 8 * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(gl.bufferSubDataCalls.at(-1).length, 16);
});
