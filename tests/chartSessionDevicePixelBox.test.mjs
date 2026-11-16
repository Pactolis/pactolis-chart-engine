import test from "node:test";
import assert from "node:assert/strict";
import { ChartSession } from "../dist/features/chart/ChartSession.js";

function fixture(t, { dpr = 1.25, width = 800.2, height = 500.1, maxDevicePixelRatio = null, rejectDevicePixelBox = false } = {}) {
  let id = 0;
  const queue = new Map();
  const media = new Set();
  const observers = [];

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      observers.push(this);
    }
    observe(target, options) {
      this.observeCalls.push({ target, options });
      if (rejectDevicePixelBox && options?.box === "device-pixel-content-box") {
        throw new TypeError("device-pixel-content-box is not supported");
      }
    }
    disconnect() {}
    trigger(entries) {
      this.callback(entries, this);
    }
  }

  const win = {
    devicePixelRatio: dpr,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame(callback) {
      queue.set(++id, callback);
      return id;
    },
    cancelAnimationFrame(key) {
      queue.delete(key);
    },
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
  const size = { width, height };
  const container = { ownerDocument: doc, getBoundingClientRect: () => ({ ...size }) };
  const gl = {};
  const makeCanvas = () => ({
    ownerDocument: doc,
    style: {},
    width: 0,
    height: 0,
    getContext: () => gl,
    addEventListener() {},
    removeEventListener() {},
  });
  const [gpu, annotation, interaction] = [makeCanvas(), makeCanvas(), makeCanvas()];
  const transforms = [];
  const resizes = [];
  const surfaceResizes = [];
  const gpuSurface = {
    kind: "webgl2",
    resize(w, h, ratio) { surfaceResizes.push({ w, h, ratio }); },
    render() {},
    dispose() {},
    getGlContext: () => gl,
  };
  const context = (name) => ({ setTransform: (...values) => transforms.push({ name, values }) });

  const session = new ChartSession({
    container,
    ownerDocument: doc,
    gl,
    gpuSurface,
    gpuCanvas: gpu,
    annotationCanvas: annotation,
    interactionCanvas: interaction,
    annotationCtx2d: context("annotation"),
    interactionCtx2d: context("interaction"),
    renderer: { render() {}, visibleRange() { return [0, 0]; } },
    annotation: { render() {} },
    interaction: { render() {} },
    view: { colWidth: 11, offsetX: 0, priceTop: 0, pricePerPx: 1, area: { left: 0, top: 0, width: 0, height: 0 } },
    series: { length: 1 },
    crosshair: { visible: false, x: 0, y: 0 },
    onRestoreContext() {},
    onResize(w, h, ratio) { resizes.push({ width: w, height: h, ratio }); },
    onRendered() {},
    maxDevicePixelRatio,
  });

  t.after(() => session.destroy());
  session.activate();
  frame();

  return {
    session,
    win,
    container,
    size,
    gpu,
    annotation,
    interaction,
    observers,
    transforms,
    resizes,
    surfaceResizes,
    frame,
    queued: () => queue.size,
    dprChanged: () => { for (const cb of [...media]) cb(); },
    ro: () => observers.at(-1),
  };
}

const allSurfaceDims = (h) => [
  [h.gpu.width, h.gpu.height],
  [h.annotation.width, h.annotation.height],
  [h.interaction.width, h.interaction.height],
];

test("devicePixelContentBoxSize sets exact physical bitmap dimensions across all three canvases at fractional DPR", (t) => {
  const h = fixture(t, { dpr: 1.25, width: 800.2, height: 500.1 });
  assert.deepEqual(h.ro().observeCalls[0].options, { box: "device-pixel-content-box" });
  // Initial sync before RO delivery falls back to Math.round(w * dpr)
  assert.deepEqual(allSurfaceDims(h), [[1000, 625], [1000, 625], [1000, 625]]);

  // Subpixel-snapped devicePixelContentBoxSize differs from Math.round(800.2 * 1.25)
  h.ro().trigger([{
    target: h.container,
    devicePixelContentBoxSize: [{ inlineSize: 1001, blockSize: 626 }],
  }]);
  assert.equal(h.queued(), 1);
  // Previously painted bitmaps remain intact until the owner RAF commits
  assert.deepEqual(allSurfaceDims(h), [[1000, 625], [1000, 625], [1000, 625]]);

  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[1001, 626], [1001, 626], [1001, 626]]);
  assert.deepEqual(h.surfaceResizes.at(-1), { w: 1001, h: 626, ratio: 1.25 });
  assert.deepEqual([h.gpu.style.width, h.gpu.style.height], ["800.2px", "500.1px"]);
  assert.deepEqual(h.resizes.at(-1), { width: 800.2, height: 500.1, ratio: 1.25 });
  assert.deepEqual(h.transforms.at(-1).values, [1.25, 0, 0, 1.25, 0, 0]);
});

test("devicePixelContentBoxSize works at 1.5 DPR and clears when subsequent entry lacks the field", (t) => {
  const h = fixture(t, { dpr: 1.5, width: 640.3, height: 360.3 });
  assert.deepEqual(allSurfaceDims(h), [[960, 540], [960, 540], [960, 540]]);

  h.ro().trigger([{
    target: h.container,
    devicePixelContentBoxSize: [{ inlineSize: 961, blockSize: 541 }],
  }]);
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[961, 541], [961, 541], [961, 541]]);

  // Subsequent RO without devicePixelContentBoxSize falls back to Math.round(w * dpr)
  h.ro().trigger([{ target: h.container, contentRect: { width: 640.3, height: 360.3 } }]);
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[960, 540], [960, 540], [960, 540]]);
});

test("falls back cleanly when observe({ box: 'device-pixel-content-box' }) throws TypeError", (t) => {
  const h = fixture(t, { dpr: 1.25, width: 800.2, height: 500.1, rejectDevicePixelBox: true });
  assert.equal(h.ro().observeCalls.length, 2);
  assert.deepEqual(h.ro().observeCalls[0].options, { box: "device-pixel-content-box" });
  assert.equal(h.ro().observeCalls[1].options, undefined);
  assert.deepEqual(allSurfaceDims(h), [[1000, 625], [1000, 625], [1000, 625]]);

  h.size.width = 640.3;
  h.size.height = 360.3;
  h.win.devicePixelRatio = 1.5;
  h.ro().trigger([{ target: h.container, contentRect: { width: 640.3, height: 360.3 } }]);
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[960, 540], [960, 540], [960, 540]]);
});

test("maxDevicePixelRatio cap keeps Math.round(w * cappedDpr) and lifting cap restores devicePixelContentBoxSize", (t) => {
  const h = fixture(t, { dpr: 2, width: 640.3, height: 360.3, maxDevicePixelRatio: 1.25 });
  assert.deepEqual(allSurfaceDims(h), [[800, 450], [800, 450], [800, 450]]);

  // RO reports physical 2x DPR box; cap below rawDpr must keep 800x450
  h.ro().trigger([{
    target: h.container,
    devicePixelContentBoxSize: [{ inlineSize: 1281, blockSize: 721 }],
  }]);
  assert.equal(h.queued(), 0, "capped bitmap is unchanged so no extra frame should be queued");
  assert.deepEqual(allSurfaceDims(h), [[800, 450], [800, 450], [800, 450]]);

  // Lifting cap restores rawDpr and applies the physical box reported by RO
  h.session.setMaxDevicePixelRatio(null);
  assert.equal(h.queued(), 1);
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[1281, 721], [1281, 721], [1281, 721]]);
  assert.equal(h.resizes.at(-1).ratio, 2);
});

test("DPR change and updateContainer reset cached devicePixelContentBoxSize", (t) => {
  const h = fixture(t, { dpr: 1.25, width: 800.2, height: 500.1 });
  h.ro().trigger([{
    target: h.container,
    devicePixelContentBoxSize: [{ inlineSize: 1001, blockSize: 626 }],
  }]);
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[1001, 626], [1001, 626], [1001, 626]]);

  // DPR change without a follow-up RO must invalidate stale 1001x626
  h.win.devicePixelRatio = 1.5;
  h.dprChanged();
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[1200, 750], [1200, 750], [1200, 750]]);

  // Re-populate at 1.5, then adopt a new container -> old box must reset
  h.ro().trigger([{
    target: h.container,
    devicePixelContentBoxSize: [{ inlineSize: 1201, blockSize: 751 }],
  }]);
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[1201, 751], [1201, 751], [1201, 751]]);

  const nextContainer = { ownerDocument: { defaultView: h.win }, getBoundingClientRect: () => ({ width: 800.2, height: 500.1 }) };
  h.session.updateContainer(nextContainer);
  assert.equal(h.ro().observeCalls[0].target, nextContainer);
  assert.deepEqual(h.ro().observeCalls[0].options, { box: "device-pixel-content-box" });
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[1200, 750], [1200, 750], [1200, 750]]);
});

test("ignores devicePixelContentBoxSize that diverges from active window DPR (e.g. headless CDP emulation)", (t) => {
  const h = fixture(t, { dpr: 2, width: 800.2, height: 500.1 });
  assert.deepEqual(allSurfaceDims(h), [[1600, 1000], [1600, 1000], [1600, 1000]]);

  // Emulated 2x viewport where ResizeObserver still emits 1x CSS pixels (800x500)
  h.ro().trigger([{
    target: h.container,
    devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: 500 }],
  }]);
  assert.equal(h.queued(), 0, "mismatched 1x box should keep Math.round(w * dpr) without queuing resize");
  assert.deepEqual(allSurfaceDims(h), [[1600, 1000], [1600, 1000], [1600, 1000]]);

  // Valid subpixel-snapped 2x box within <= 2px of w * dpr still applies
  h.ro().trigger([{
    target: h.container,
    devicePixelContentBoxSize: [{ inlineSize: 1601, blockSize: 1001 }],
  }]);
  assert.equal(h.queued(), 1);
  h.frame();
  assert.deepEqual(allSurfaceDims(h), [[1601, 1001], [1601, 1001], [1601, 1001]]);
});
