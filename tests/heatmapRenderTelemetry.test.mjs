import test from "node:test";
import assert from "node:assert/strict";
import {
  HeatmapGpuRenderer,
  HEATMAP_GPU_CHART_BUDGET_BYTES,
} from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";

// Every renderFrame call on a live renderer reports its CPU time as
// `chart.gpu.heatmap.render.ms`, and costs nothing while telemetry is off.

const METRIC = "chart.gpu.heatmap.render.ms";
const PLOT = { left: 0, top: 0, width: 400, height: 300 };

/** A WebGL2 stand-in that lets the renderer initialise, upload and draw; calls it does not model are recorded no-ops. */
function fakeGl({ onDraw } = {}) {
  const calls = [];
  const modelled = {
    canvas: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: () => 4096,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getAttribLocation: (_program, name) => ["a_unit", "a_rect", "a_texel", "a_alphaScale"].indexOf(name),
    getUniformLocation: (_program, name) => ({ name }),
    drawArraysInstanced: () => {
      calls.push("drawArraysInstanced");
      onDraw?.();
    },
  };
  const gl = new Proxy(modelled, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== "string") return undefined;
      return /^[A-Z0-9_]+$/.test(key) ? 0 : () => { calls.push(key); return {}; };
    },
  });
  return { gl, calls };
}

function frame(count) {
  return {
    main: Array.from({ length: count }, (_, x) => ({ x, yTop: 1, width: 1, height: 1, value: 2 })),
    extension: [], ceiling: 10, threshold: 1, dataKey: "render-telemetry",
  };
}

const sampleCount = () => snapshotPerformanceTelemetry().metrics[METRIC]?.count ?? 0;

function withTelemetry(enabled, work) {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled });
  try {
    return work();
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
}

test("a drawn frame records one render sample and issues the same GL calls as without telemetry", () => {
  const off = fakeGl();
  const on = fakeGl();
  const rendererOff = new HeatmapGpuRenderer();
  const rendererOn = new HeatmapGpuRenderer();
  try {
    assert.equal(withTelemetry(false, () => rendererOff.renderFrame(off.gl, frame(3), PLOT)), true);
    const before = sampleCount();
    assert.equal(withTelemetry(true, () => rendererOn.renderFrame(on.gl, frame(3), PLOT)), true);
    assert.equal(sampleCount() - before, 1);
    const snapshot = snapshotPerformanceTelemetry().metrics[METRIC];
    assert.ok(Number.isFinite(snapshot.p95Ms) && snapshot.p95Ms >= 0 && snapshot.maxMs >= snapshot.minMs);
    assert.equal(on.calls.filter((call) => call === "drawArraysInstanced").length, 1);
    assert.deepEqual(on.calls, off.calls);
  } finally {
    rendererOff.dispose();
    rendererOn.dispose();
  }
});

test("telemetry off reads no clock; on reads it twice per call", (t) => {
  const { gl } = fakeGl();
  const renderer = new HeatmapGpuRenderer();
  try {
    let reads = 0;
    const realNow = performance.now.bind(performance);
    t.mock.method(performance, "now", () => { reads++; return realNow(); });
    withTelemetry(false, () => renderer.renderFrame(gl, frame(3), PLOT));
    assert.equal(reads, 0);
    withTelemetry(true, () => renderer.renderFrame(gl, frame(3), PLOT));
    assert.equal(reads, 2);
  } finally {
    renderer.dispose();
  }
});

test("an empty frame and a rejected frame still count as calls", () => {
  const { gl } = fakeGl();
  const renderer = new HeatmapGpuRenderer();
  try {
    const before = sampleCount();
    assert.equal(withTelemetry(true, () => renderer.renderFrame(gl, frame(0), PLOT)), true);
    assert.equal(sampleCount() - before, 1);
    const rejected = frame(2);
    rejected.main[1].x = Number.NaN;
    assert.equal(withTelemetry(true, () => renderer.renderFrame(gl, rejected, PLOT)), false);
    assert.equal(sampleCount() - before, 2);
  } finally {
    renderer.dispose();
  }
});

test("a GL failure while drawing records the call, and a disposed renderer records nothing", () => {
  const { gl } = fakeGl({ onDraw() { throw new Error("context lost"); } });
  const renderer = new HeatmapGpuRenderer();
  try {
    const before = sampleCount();
    assert.equal(withTelemetry(true, () => renderer.renderFrame(gl, frame(3), PLOT)), false);
    assert.equal(sampleCount() - before, 1);
    // The failure disposed the renderer, so the next call returns before any work.
    assert.equal(withTelemetry(true, () => renderer.renderFrame(gl, frame(3), PLOT)), false);
    assert.equal(sampleCount() - before, 1);
  } finally {
    renderer.dispose();
  }
});

test("a budget denial records the call and still reaches the caller", () => {
  const { gl } = fakeGl();
  const renderer = new HeatmapGpuRenderer();
  // Leaves too little of the chart budget for the unit quad, which the first frame reserves.
  const pressure = renderer.reservePreparedPayload(HEATMAP_GPU_CHART_BUDGET_BYTES - 10);
  try {
    assert.ok(pressure);
    const prepared = { ...frame(3), preparedLease: { release() {} } };
    const before = sampleCount();
    assert.throws(
      () => withTelemetry(true, () => renderer.renderFrame(gl, prepared, PLOT)),
      /budget exceeded/,
    );
    assert.equal(sampleCount() - before, 1);
  } finally {
    pressure?.release();
    renderer.dispose();
  }
});
