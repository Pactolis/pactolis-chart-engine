import test from "node:test";
import assert from "node:assert/strict";

import { ChartSession } from "../dist/features/chart/ChartSession.js";

test("ChartSession forwards runtime WebGL options when acquiring fallback and restored contexts", () => {
  const requestedOptions = [];
  const options = { antialias: false, powerPreference: "low-power" };
  const gl = {};
  const listeners = new Map();
  const canvas = {
    ownerDocument: null,
    style: {},
    width: 1,
    height: 1,
    getContext(kind, contextOptions) {
      if (kind === "webgl2") requestedOptions.push(contextOptions);
      return kind === "webgl2" ? gl : null;
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatch(type, event = { preventDefault() {} }) {
      for (const callback of listeners.get(type) ?? []) callback(event);
    },
  };
  const win = {
    devicePixelRatio: 1,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    matchMedia() { return { addEventListener() {}, removeEventListener() {} }; },
  };
  const ownerDocument = { defaultView: win };
  canvas.ownerDocument = ownerDocument;

  const session = new ChartSession({
    container: { ownerDocument, getBoundingClientRect: () => ({ width: 10, height: 10 }) },
    gpuCanvas: canvas,
    annotationCanvas: { ...canvas, getContext: () => null },
    interactionCanvas: { ...canvas, getContext: () => null },
    ownerDocument,
    gl,
    annotationCtx2d: { setTransform() {} },
    interactionCtx2d: { setTransform() {} },
    renderer: { render() {}, visibleRange() { return [0, 0]; } },
    annotation: { render() {} },
    interaction: { render() {} },
    view: {},
    series: [],
    crosshair: {},
    webglOptions: options,
    onRestoreContext() {},
  });

  canvas.dispatch("webglcontextlost");
  canvas.dispatch("webglcontextrestored");
  session.destroy();

  assert.equal(requestedOptions.length, 1, "restoration must acquire a fresh WebGL2 context");
  assert.deepEqual(requestedOptions[0], {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    stencil: false,
  });
});
