import test from "node:test";
import assert from "node:assert/strict";

import {
  ChartCaptureError,
  MAX_CAPTURE_BYTES,
  createCaptureStateToken,
  captureStateMatches,
  encodeGpuAndAnnotationPng,
  flipRgbaRows,
  validateCaptureDimensions,
  validateEncodedPngSize,
} from "../dist/features/chart/nativeCapture.js";

const ready = {
  disposed: false,
  ready: true,
  reason: "READY",
  market: "BINANCE_FUTURES:btcusdt",
  timeframe: "4h",
  selectionGeneration: 3,
  priceStep: 25,
  history: {
    status: "settled",
    generation: 7,
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "4h",
    footprintReceived: false,
  },
  analysis: {
    revision: 44,
    market: "BINANCE_FUTURES:btcusdt",
    canonical: {
      status: "complete",
      market: "BINANCE_FUTURES:btcusdt",
      runKey: "BINANCE_FUTURES:btcusdt|25",
      generation: 9,
      revision: 44,
      failedPeriods: [],
    },
  },
  renderedAnalysisRevision: 44,
  renderedAnalysisMarket: "BINANCE_FUTURES:btcusdt",
};

test("WebGL bottom-left RGBA rows are vertically flipped into canvas top-left order", () => {
  const source = new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 255, 255,
  ]);
  assert.deepEqual([...flipRgbaRows(source, 2, 2)], [
    0, 0, 255, 255,   255, 255, 255, 255,
    255, 0, 0, 255,   0, 255, 0, 255,
  ]);
});

test("capture state token is atomic across market/timeframe/history/canonical identity and ignores interaction-only churn", () => {
  const token = createCaptureStateToken(ready);
  assert.equal(captureStateMatches(token, ready), true);

  const cases = [
    { ...ready, market: "BINANCE_FUTURES:ethusdt" },
    { ...ready, timeframe: "1h" },
    { ...ready, selectionGeneration: 4 },
    { ...ready, history: { ...ready.history, generation: 8 } },
    { ...ready, analysis: { ...ready.analysis, canonical: { ...ready.analysis.canonical, generation: 10 } } },
    { ...ready, analysis: { ...ready.analysis, canonical: { ...ready.analysis.canonical, revision: 45 } } },
    { ...ready, renderedAnalysisRevision: 43 },
  ];
  for (const changed of cases) assert.equal(captureStateMatches(token, changed), false);

  assert.equal(Object.hasOwn(token, "crosshair"), false);
  assert.equal(Object.hasOwn(token, "interaction"), false);
});

test("capture token cannot be created from a non-ready chart", () => {
  assert.throws(
    () => createCaptureStateToken({ ...ready, ready: false, reason: "HISTORY_PENDING" }),
    (error) => error instanceof ChartCaptureError && error.code === "CAPTURE_NOT_READY",
  );
});

test("capture dimensions fail closed instead of silently downscaling", () => {
  assert.deepEqual(validateCaptureDimensions(1920, 1080, 1920, 1080), { width: 1920, height: 1080 });
  for (const args of [
    [4097, 100, 4097, 100],
    [100, 4097, 100, 4097],
    [4096, 4096, 4095, 4096],
    [0, 1080, 0, 1080],
  ]) {
    assert.throws(() => validateCaptureDimensions(...args), (error) => error instanceof ChartCaptureError);
  }
});

test("encoded PNG is bounded at 8 MiB", () => {
  assert.doesNotThrow(() => validateEncodedPngSize(MAX_CAPTURE_BYTES));
  assert.throws(
    () => validateEncodedPngSize(MAX_CAPTURE_BYTES + 1),
    (error) => error instanceof ChartCaptureError && error.code === "IMAGE_TOO_LARGE",
  );
});

test("PNG compositor draws only the annotation canvas over GPU pixels", async () => {
  const calls = [];
  const annotationCanvas = { id: "annotation" };
  const imageData = { data: new Uint8ClampedArray(16) };
  const ctx = {
    createImageData(width, height) { calls.push(["createImageData", width, height]); return imageData; },
    putImageData(image, x, y) { calls.push(["putImageData", image, x, y]); },
    drawImage(canvas, x, y) { calls.push(["drawImage", canvas, x, y]); },
  };
  const scratch = {
    width: 0,
    height: 0,
    getContext(kind) { assert.equal(kind, "2d"); return ctx; },
    toBlob(cb, type) { calls.push(["toBlob", type]); cb(new Blob([new Uint8Array([1, 2, 3])], { type })); },
  };
  const ownerDocument = { createElement(tag) { assert.equal(tag, "canvas"); return scratch; } };
  const pixels = new Uint8ClampedArray(16).fill(7);

  const frame = await encodeGpuAndAnnotationPng(ownerDocument, pixels, 2, 2, annotationCanvas);
  assert.equal(frame.blob.type, "image/png");
  assert.equal(frame.bytes, 3);
  assert.deepEqual([...imageData.data], [...pixels]);
  assert.deepEqual(calls.find((entry) => entry[0] === "drawImage"), ["drawImage", annotationCanvas, 0, 0]);
  assert.equal(calls.filter((entry) => entry[0] === "drawImage").length, 1);
});

test("ChartCaptureCoordinator wraps native capture with pre/post state token validation", async () => {
  const fs = await import("node:fs/promises");
  const [runtimeSource, coordinatorSource] = await Promise.all([
    fs.readFile(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/features/chart/ChartCaptureCoordinator.ts", import.meta.url), "utf8"),
  ]);
  assert.match(runtimeSource, /captureNativePng\(\): Promise<NativeChartCapture> \{ return this\.captureCoordinator\.captureNativePng\(\); \}/);
  assert.match(coordinatorSource, /const token = createCaptureStateToken\(this\.getReadiness\(\)\)/);
  assert.match(coordinatorSource, /await this\.host\.session\.captureCompositePng\(\)/);
  assert.match(coordinatorSource, /captureStateMatches\(token, post\)/);
  assert.match(coordinatorSource, /STATE_SUPERSEDED/);
});

test("production WebGL2 contexts explicitly disable preserveDrawingBuffer", async () => {
  const fs = await import("node:fs/promises");
  const nativeSource = await fs.readFile(new URL("../src/features/chart/nativeCapture.ts", import.meta.url), "utf8");
  const runtimeSource = await fs.readFile(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8");
  const sessionSource = await fs.readFile(new URL("../src/features/chart/ChartSession.ts", import.meta.url), "utf8");

  assert.match(nativeSource, /preserveDrawingBuffer:\s*false/);
  assert.match(nativeSource, /canvas\.getContext\("webgl2", CHART_WEBGL_CONTEXT_ATTRIBUTES\)/);
  assert.match(runtimeSource, /getChartWebGl2Context\(gpuCanvas\)/);
  assert.equal((sessionSource.match(/getChartWebGl2Context\(this\.gpuCanvas\)/g) ?? []).length, 2);
  assert.doesNotMatch(runtimeSource, /gpuCanvas\.getContext\("webgl2"/);
  assert.doesNotMatch(sessionSource, /this\.gpuCanvas\.getContext\("webgl2"/);
});
