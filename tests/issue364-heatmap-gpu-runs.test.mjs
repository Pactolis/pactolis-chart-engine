import test from "node:test";
import assert from "node:assert/strict";
import {
  HeatmapGpuRenderer,
  walkHeatmapRuns,
} from "../dist/features/chart/heatmap/gpu/heatmapGpuRenderer.js";

// CE #364 item 3: the WebGL2 heatmap draws one quad per vertical RUN of
// stacked cells instead of one instance per cell.

const collect = (frame) => {
  const runs = [];
  const count = walkHeatmapRuns(frame, (x, y, w, h, firstCell, signedCount, alphaScale) => {
    runs.push({ x, y, w, h, firstCell, signedCount, alphaScale });
  });
  assert.equal(count, runs.length);
  return runs;
};

const frameOf = (main, extension = []) => ({ main, extension, ceiling: 10, threshold: 1, dataKey: "runs" });
const cell = (x, yTop, height = 2.5, width = 7) => ({ x, yTop, width, height, value: 5 });

test("#364: cells stacked upward (production order) merge into one run with a negative count", () => {
  // forEachVisibleCell emits a column bottom -> top: each next cell sits above the previous.
  const main = [cell(0, 100), cell(0, 97.5), cell(0, 95), cell(0, 92.5)];
  const runs = collect(frameOf(main));
  assert.deepEqual(runs, [{ x: 0, y: 92.5, w: 7, h: 10, firstCell: 0, signedCount: -4, alphaScale: 1 }]);
});

test("#364: cells stacked downward merge with a positive count", () => {
  const main = [cell(3, 10), cell(3, 12.5), cell(3, 15)];
  assert.deepEqual(collect(frameOf(main)), [{ x: 3, y: 10, w: 7, h: 7.5, firstCell: 0, signedCount: 3, alphaScale: 1 }]);
});

test("#364: gaps, new columns, height changes and direction changes start a new run", () => {
  const main = [
    cell(0, 100), cell(0, 97.5), // run A (up)
    cell(0, 90),                 // gap -> run B
    cell(7, 90),                 // other column -> run C
    cell(7, 87.5, 3),            // height differs -> run D
    cell(7, 90.5, 3),            // touches D from below, but D is a new run of one, so it merges (down)
    cell(7, 87.5, 3),            // direction flip -> run E
  ];
  const runs = collect(frameOf(main));
  assert.deepEqual(runs.map((r) => [r.firstCell, r.signedCount]), [[0, -2], [2, 1], [3, 1], [4, 2], [6, 1]]);
  // A single cell keeps its own rect unchanged.
  assert.deepEqual(runs[1], { x: 0, y: 90, w: 7, h: 2.5, firstCell: 2, signedCount: 1, alphaScale: 1 });
});

test("#364: an extension ends the run and keeps MAIN -> EXT paint order", () => {
  const main = [cell(0, 100), cell(0, 97.5), cell(0, 95)];
  const extension = [{ x: 7, yTop: 97.5, width: 3, height: 2.5, value: 5, sourceMainIndex: 1 }];
  const runs = collect(frameOf(main, extension));
  assert.deepEqual(runs.map((r) => [r.firstCell, r.signedCount, r.alphaScale]), [[0, -2, 1], [3, 1, 0.45], [2, 1, 1]]);
});

test("#364: extensions out of order still throw", () => {
  const main = [cell(0, 100), cell(0, 97.5)];
  const extension = [
    { x: 7, yTop: 97.5, width: 3, height: 2.5, value: 5, sourceMainIndex: 1 },
    { x: 7, yTop: 100, width: 3, height: 2.5, value: 5, sourceMainIndex: 0 },
  ];
  assert.throws(() => walkHeatmapRuns(frameOf(main, extension), null), /out of order/);
});

test("#364: the renderer draws 6 non-instanced vertices per run", () => {
  const draws = [];
  const uploads = [];
  const gl = new Proxy({
    canvas: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    getParameter: () => 4096,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getAttribLocation: (_p, name) => ["a_rect", "a_run"].indexOf(name),
    getUniformLocation: (_p, name) => ({ name }),
    bufferSubData: (_t, offset, view) => uploads.push({ offset, bytes: view.byteLength }),
    drawArrays: (mode, first, count) => draws.push({ first, count }),
    drawArraysInstanced: () => assert.fail("instanced draw must not be used"),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== "string") return undefined;
      return /^[A-Z0-9_]+$/.test(key) ? 0 : (() => ({}));
    },
  });
  const renderer = new HeatmapGpuRenderer();
  try {
    // 3 columns x 5 stacked cells = 15 cells -> 3 runs.
    const main = [];
    for (let col = 0; col < 3; col++) for (let k = 0; k < 5; k++) main.push(cell(col * 7, 200 - k * 2.5));
    assert.equal(renderer.renderFrame(gl, frameOf(main), { left: 0, top: 0, width: 400, height: 300, pixelRatio: 1 }), true);
    assert.deepEqual(draws, [{ first: 0, count: 3 * 6 }]);
    assert.equal(uploads.reduce((a, u) => a + u.bytes, 0), 3 * 6 * 7 * 4);
  } finally {
    renderer.dispose();
  }
});
