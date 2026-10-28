import test from "node:test";
import assert from "node:assert/strict";
import { ChartSession } from "../dist/features/chart/ChartSession.js";

// A session on a 400x300 container in a window with the given devicePixelRatio. The canvases and the
// window are stand-ins that record what the session does with them; nothing reads session internals.
function fixture(t, { dpr = 3, maxDevicePixelRatio } = {}) {
  let id = 0;
  const queue = new Map();
  const media = new Set();
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  const win = {
    devicePixelRatio: dpr,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame(callback) { queue.set(++id, callback); return id; },
    cancelAnimationFrame(key) { queue.delete(key); },
    matchMedia() {
      return {
        addEventListener(_type, callback) { media.add(callback); },
        removeEventListener(_type, callback) { media.delete(callback); },
      };
    },
  };
  const frame = () => {
    const entry = queue.entries().next().value;
    assert.ok(entry, "a frame must be queued");
    queue.delete(entry[0]);
    entry[1](0);
  };
  const doc = { defaultView: win };
  const size = { width: 400, height: 300 };
  const gl = {};
  const canvas = () => ({
    ownerDocument: doc, style: {}, width: 0, height: 0,
    getContext: () => gl, addEventListener() {}, removeEventListener() {},
  });
  const [gpu, annotation, interaction] = [canvas(), canvas(), canvas()];
  const transforms = [];
  const resizes = [];
  const context = (name) => ({ setTransform: (...values) => transforms.push({ name, values }) });
  const session = new ChartSession({
    container: { ownerDocument: doc, getBoundingClientRect: () => ({ ...size }) },
    ownerDocument: doc, gl,
    gpuCanvas: gpu, annotationCanvas: annotation, interactionCanvas: interaction,
    annotationCtx2d: context("annotation"), interactionCtx2d: context("interaction"),
    renderer: { render() {}, visibleRange() { return [0, 0]; } },
    annotation: { render() {} },
    interaction: { render() {} },
    view: { colWidth: 11, offsetX: 0, priceTop: 0, pricePerPx: 1, area: { left: 0, top: 0, width: 0, height: 0 } },
    series: { length: 1 },
    crosshair: { visible: false, x: 0, y: 0 },
    onRestoreContext() {},
    onResize(width, height, ratio) { resizes.push({ width, height, ratio }); },
    onRendered() {},
    maxDevicePixelRatio,
  });
  t.after(() => session.destroy());
  session.activate();
  frame();
  return {
    session, win, size, gpu, annotation, interaction, transforms, resizes, frame,
    queued: () => queue.size,
    dprChanged: () => { for (const callback of [...media]) callback(); },
  };
}

const bitmap = (h) => [h.gpu.width, h.gpu.height];

test("with no cap the canvases render at the window's pixel ratio", (t) => {
  const h = fixture(t);
  assert.deepEqual(bitmap(h), [1200, 900]);
  assert.deepEqual([h.gpu.style.width, h.gpu.style.height], ["400px", "300px"]);
  assert.deepEqual(h.resizes.at(-1), { width: 400, height: 300, ratio: 3 });
  assert.deepEqual(h.transforms.at(-1).values, [3, 0, 0, 3, 0, 0]);
});

test("a cap below the window's ratio holds the bitmap, the 2D transforms and the reported ratio at the cap", (t) => {
  const h = fixture(t, { maxDevicePixelRatio: 2 });
  assert.deepEqual(bitmap(h), [800, 600]);
  assert.deepEqual([h.annotation.width, h.annotation.height], [800, 600]);
  assert.deepEqual([h.interaction.width, h.interaction.height], [800, 600]);
  assert.deepEqual([h.gpu.style.width, h.gpu.style.height], ["400px", "300px"], "the CSS size is the window's, not the cap's");
  assert.deepEqual(h.resizes.at(-1), { width: 400, height: 300, ratio: 2 });
  assert.deepEqual(h.transforms.map((entry) => entry.values), [[2, 0, 0, 2, 0, 0], [2, 0, 0, 2, 0, 0]]);
});

test("a cap above the window's ratio changes nothing", (t) => {
  const h = fixture(t, { dpr: 1.5, maxDevicePixelRatio: 2 });
  assert.deepEqual(bitmap(h), [600, 450]);
  assert.equal(h.resizes.at(-1).ratio, 1.5);
});

test("the cap moves on a live session: a frame resizes the canvases, and lifting it restores the window's ratio", (t) => {
  const h = fixture(t);
  assert.equal(h.queued(), 0);

  h.session.setMaxDevicePixelRatio(1);
  assert.equal(h.queued(), 1, "a cap that changes the bitmap asks for a frame");
  assert.deepEqual(bitmap(h), [1200, 900], "and the committed bitmap stays until that frame");
  h.frame();
  assert.deepEqual(bitmap(h), [400, 300]);
  assert.equal(h.resizes.at(-1).ratio, 1);

  h.session.setMaxDevicePixelRatio(1);
  assert.equal(h.queued(), 0, "the same cap again does nothing");

  h.session.setMaxDevicePixelRatio(null);
  h.frame();
  assert.deepEqual(bitmap(h), [1200, 900]);
  assert.equal(h.resizes.at(-1).ratio, 3);
});

test("a cap that does not change the bitmap asks for no frame", (t) => {
  const h = fixture(t, { dpr: 1.5 });
  h.session.setMaxDevicePixelRatio(2);
  assert.equal(h.queued(), 0, "the window's 1.5 is under the cap already");
  assert.deepEqual(bitmap(h), [600, 450]);
});

test("a window ratio change is clamped by the cap too", (t) => {
  const h = fixture(t, { maxDevicePixelRatio: 2 });
  h.win.devicePixelRatio = 2.5;
  h.dprChanged();
  assert.equal(h.queued(), 0, "2.5 still renders at the cap of 2");

  h.win.devicePixelRatio = 1.25;
  h.dprChanged();
  assert.equal(h.queued(), 1);
  h.frame();
  assert.deepEqual(bitmap(h), [500, 375]);
  assert.equal(h.resizes.at(-1).ratio, 1.25);
});
