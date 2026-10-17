import test from "node:test";
import assert from "node:assert/strict";
import {
  HeatmapGpuRenderer,
  HEATMAP_GPU_CHART_BUDGET_BYTES,
  HEATMAP_GPU_MODULE_BUDGET_BYTES,
} from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";

// Requested logical payload only: no physical heap/VRAM, pixels or timing oracle.
// These hooks run before the fake driver records replacement storage.
function fixture() {
  const buffers = new Map();
  const textures = new Map();
  let buffer = null;
  let texture = null;
  const hooks = { buffer: null, texture: null };
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33, ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401,
    TEXTURE_2D: 0x0de1, R32F: 0x822e, R8: 0x8229, RED: 0x1903,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f, UNPACK_ALIGNMENT: 0x0cf5,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    getParameter(p) { assert.equal(p, gl.MAX_TEXTURE_SIZE); return 4096; },
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter(s, p) { assert.ok(s); assert.equal(p, gl.COMPILE_STATUS); return true; },
    getShaderInfoLog: () => "", deleteShader() {},
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter(p, key) { assert.ok(p); assert.equal(key, gl.LINK_STATUS); return true; },
    getProgramInfoLog: () => "", deleteProgram() {},
    getUniformLocation: (p, name) => ({ name }),
    getAttribLocation: (p, name) => ["a_unit", "a_rect", "a_texel", "a_alphaScale"].indexOf(name),
    createVertexArray: () => ({}), bindVertexArray() {}, deleteVertexArray() {},
    createBuffer: () => ({}),
    bindBuffer(target, value) { assert.equal(target, gl.ARRAY_BUFFER); buffer = value; },
    bufferData(target, data) {
      assert.equal(target, gl.ARRAY_BUFFER);
      assert.ok(buffer);
      const bytes = typeof data === "number" ? data : data.byteLength;
      hooks.buffer?.(bytes);
      buffers.set(buffer, bytes);
    },
    bufferSubData(target, offset, data) {
      assert.equal(target, gl.ARRAY_BUFFER);
      assert.ok(offset + data.byteLength <= buffers.get(buffer));
    },
    deleteBuffer(value) { buffers.delete(value); },
    enableVertexAttribArray(location) { assert.ok(location >= 0); },
    vertexAttribPointer() {}, vertexAttribDivisor() {},
    createTexture: () => ({}),
    bindTexture(target, value) { assert.equal(target, gl.TEXTURE_2D); texture = value; },
    texParameteri() {},
    texImage2D(target, level, format, width, height, border, external, type, data) {
      assert.equal(target, gl.TEXTURE_2D);
      assert.ok(texture);
      assert.ok(format === gl.R32F || format === gl.R8);
      assert.equal(type, format === gl.R32F ? gl.FLOAT : gl.UNSIGNED_BYTE);
      assert.equal(data, null);
      const bytes = width * height * (format === gl.R32F ? 4 : 1);
      hooks.texture?.({ width, height, bytes, format });
      textures.set(texture, bytes);
    },
    texSubImage2D() {}, pixelStorei() {},
    deleteTexture(value) { textures.delete(value); },
  };
  return {
    gl, hooks, buffers, textures,
    gpuBytes: () => [...buffers.values(), ...textures.values()].reduce((sum, n) => sum + n, 0),
  };
}

function cpuBytes(renderer) {
  return ["stagingValues", "stagingValidity", "instanceData", "uploadedInstances",
    "uploadedValues", "uploadedValidity"]
    .reduce((sum, key) => sum + (renderer[key]?.byteLength ?? 0), 0);
}

function frame(count) {
  return {
    main: Array.from({ length: count }, (_, x) => ({ x, yTop: 1, width: 1, height: 1, value: 2 })),
    extension: [], ceiling: 10, threshold: 1, dataKey: "payload-budget",
  };
}

function warm(renderer, f) {
  renderer.ensureResources(f.gl, 585, 585);
  renderer.uploadData(f.gl, frame(585));
  renderer.uploadInstances(f.gl, frame(585));
  assert.equal(renderer.stagingValues.byteLength, 4096 * 4);
  assert.equal(renderer.stagingValidity.byteLength, 4096);
  assert.equal(renderer.instanceData.byteLength, 4096 * 4);
  assert.equal(renderer.uploadedInstances.byteLength, 585 * 28);
  assert.deepEqual([...f.textures.values()], [585 * 4, 585]);
  assert.deepEqual([...f.buffers.values()], [48, 585 * 28]);
  assert.ok(renderer.reservedBytes >= cpuBytes(renderer) + f.gpuBytes());
}

function release(renderer, f) {
  // Disable observers even when an assertion interrupted initialization.
  f.hooks.buffer = null;
  f.hooks.texture = null;
  renderer.dispose();
  assert.equal(renderer.reservedBytes, 0);
  assert.equal(f.gpuBytes(), 0);
}

test("payload fixture: real initialization and uploads complete with allocation traps disabled", () => {
  const renderer = new HeatmapGpuRenderer();
  const f = fixture();
  try {
    assert.equal(HEATMAP_GPU_CHART_BUDGET_BYTES, 64 * 1024 * 1024);
    assert.equal(HEATMAP_GPU_MODULE_BUDGET_BYTES, 256 * 1024 * 1024);
    assert.doesNotThrow(() => warm(renderer, f));
  } finally { release(renderer, f); }
});

test("UNIT_QUAD: reserve 48 bytes before bufferData requests storage", () => {
  const renderer = new HeatmapGpuRenderer();
  const f = fixture();
  let observed = 0;
  try {
    f.hooks.buffer = (bytes) => {
      if (bytes !== 48) return;
      observed++;
      const priorKnownPayload = cpuBytes(renderer) + f.gpuBytes();
      assert.ok(renderer.reservedBytes >= priorKnownPayload + 48,
        "UNIT_QUAD late reservation: 48 requested bytes must be charged before bufferData");
    };
    assert.doesNotThrow(() => renderer.ensureResources(f.gl, 585, 585));
    assert.equal(observed, 1);
  } finally { release(renderer, f); }
});

test("texture shrink: charge full old plus new R32F/R8 pair before replacement", () => {
  const renderer = new HeatmapGpuRenderer();
  const f = fixture();
  let observed = 0;
  try {
    warm(renderer, f);
    const oldGpuPayload = f.gpuBytes();
    const staging = renderer.instanceData;
    f.hooks.texture = ({ width, height, format }) => {
      observed++;
      assert.equal(width, 584);
      assert.equal(height, 1);
      if (observed !== 1) return;
      assert.equal(format, f.gl.R32F);
      assert.equal(renderer.instanceData, staging);
      // Both old stores are still logically live at the first replacement.
      assert.deepEqual([...f.textures.values()], [585 * 4, 585]);
      const oldKnownPayload = cpuBytes(renderer) + oldGpuPayload;
      const fullNewPair = 584 * 4 + 584;
      assert.ok(renderer.reservedBytes >= oldKnownPayload + fullNewPair,
        "texture shrink peak undercharged: full new R32F/R8 pair must precede replacement");
    };
    assert.doesNotThrow(() => renderer.ensureResources(f.gl, 584, 584));
    assert.equal(observed, 2);
  } finally { release(renderer, f); }
});

test("retained instances: charge old plus new copy before same-capacity allocation", () => {
  const renderer = new HeatmapGpuRenderer();
  const f = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Float32Array");
  const Original = globalThis.Float32Array;
  let observed = 0;
  try {
    warm(renderer, f);
    const staging = renderer.instanceData;
    const previousCopy = renderer.uploadedInstances;
    const nextFrame = frame(584);
    const Tracked = new Proxy(Original, {
      construct(target, args, newTarget) {
        if (args[0] === 4088) {
          observed++;
          assert.equal(renderer.instanceData, staging);
          assert.equal(renderer.uploadedInstances, previousCopy);
          const priorActualHeld = cpuBytes(renderer) + f.gpuBytes();
          assert.ok(renderer.reservedBytes >= priorActualHeld + 4088 * 4,
            "retained instance replacement peak undercharged before Float32Array allocation");
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      Object.defineProperty(globalThis, "Float32Array", { ...descriptor, value: Tracked });
      assert.doesNotThrow(() => renderer.uploadInstances(f.gl, nextFrame));
    } finally {
      Object.defineProperty(globalThis, "Float32Array", descriptor);
    }
    assert.equal(observed, 1);
    assert.equal(renderer.instanceData, staging);
  } finally {
    Object.defineProperty(globalThis, "Float32Array", descriptor);
    release(renderer, f);
  }
});