import test from "node:test";
import assert from "node:assert/strict";

import { ChartChange, ChartSurfaceDirty } from "../dist/core/render/scene/chartScene.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";

let latestResizeObserver = null;

class FakeResizeObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.observed = null;
    this.operations = { observe: 0, disconnect: 0 };
    latestResizeObserver = this;
    FakeResizeObserver.instances.push(this);
  }
  observe(target) { this.operations.observe++; this.observed = target; }
  disconnect() { this.operations.disconnect++; this.observed = null; }
  trigger() { this.callback([]); }
}

function makeWindow(dpr = 2) {
  let nextRafId = 1;
  const rafs = new Map();
  const mediaListeners = new Set();
  const mediaOperations = { add: 0, remove: 0 };
  return {
    devicePixelRatio: dpr,
    mediaOperations,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame(callback) {
      const id = nextRafId++;
      rafs.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { rafs.delete(id); },
    runNextFrame() {
      const entry = rafs.entries().next().value;
      assert.ok(entry, "expected a queued RAF");
      const [id, callback] = entry;
      rafs.delete(id);
      callback(0);
    },
    queuedRafs() { return rafs.size; },
    pendingFrame() { return rafs.values().next().value; },
    triggerMediaChange() {
      for (const callback of [...mediaListeners]) callback();
    },
    mediaListenerCount() { return mediaListeners.size; },
    matchMedia() {
      return {
        addEventListener(_type, cb) { mediaOperations.add++; mediaListeners.add(cb); },
        removeEventListener(_type, cb) { mediaOperations.remove++; mediaListeners.delete(cb); },
      };
    },
  };
}

function makeCanvas(ownerDocument, context = null) {
  const listeners = new Map();
  const listenerOperations = { add: 0, remove: 0 };
  return {
    ownerDocument,
    listenerOperations,
    style: {},
    width: 0,
    height: 0,
    getContext(kind) {
      if (kind === "webgl2") return context;
      return null;
    },
    addEventListener(type, cb) {
      listenerOperations.add++;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) { listenerOperations.remove++; listeners.get(type)?.delete(cb); },
    dispatch(type, event = { preventDefault() {} }) {
      for (const cb of listeners.get(type) ?? []) cb(event);
    },
  };
}

function makeContext2d() {
  const transforms = [];
  return {
    transforms,
    setTransform(...args) { transforms.push(args); },
  };
}

function makeSession({ annotationInteractionCoupled = false, onInvalidate, onRendered, viewValues = {}, barBase = 101 } = {}) {
  latestResizeObserver = null;
  const win = makeWindow(2);
  const ownerDocument = { defaultView: win };
  const gl = {};
  const gpuCanvas = makeCanvas(ownerDocument, gl);
  const annotationCanvas = makeCanvas(ownerDocument);
  const interactionCanvas = makeCanvas(ownerDocument);
  const annotationCtx2d = makeContext2d();
  const interactionCtx2d = makeContext2d();
  const size = { width: 640, height: 360 };
  const container = {
    ownerDocument,
    getBoundingClientRect: () => ({ width: size.width, height: size.height }),
  };
  const counts = { gpu: 0, annotation: 0, interaction: 0 };
  const rendered = { gpu: [], annotation: [], interaction: [] };
  const defaultView = {
    colWidth: 8, offsetX: -24, priceTop: 120, pricePerPx: 0.25,
    subPanesH: 16, priceAxisW: 64,
    area: { left: 40, top: 12, width: 520, height: 300 },
  };
  const view = { ...defaultView, ...viewValues, area: { ...defaultView.area, ...viewValues.area } };
  const bars = Array.from({ length: 12 }, (_, index) => {
    const open = barBase + index;
    return { time: 1700000000000 + index * 60000, open, high: open + 7, low: open - 2, close: open + 4, volume: 7 + index };
  });
  const series = { length: bars.length, bars };
  const crosshair = { visible: true, x: 37, y: 81, marker: "fixture-crosshair" };
  const snapshotView = actualView => ({
    colWidth: actualView.colWidth, offsetX: actualView.offsetX, priceTop: actualView.priceTop,
    pricePerPx: actualView.pricePerPx, subPanesH: actualView.subPanesH, priceAxisW: actualView.priceAxisW,
    area: { left: actualView.area.left, top: actualView.area.top, width: actualView.area.width, height: actualView.area.height },
  });
  const snapshotSeries = actualSeries => ({
    length: actualSeries.length,
    bars: actualSeries.bars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })),
  });
  const snapshotCrosshair = actualCrosshair => ({
    visible: actualCrosshair.visible, x: actualCrosshair.x, y: actualCrosshair.y,
  });
  const renderer = {
    render(actualView, actualSeries) { counts.gpu++; rendered.gpu.push({ view: snapshotView(actualView), series: snapshotSeries(actualSeries) }); },
    visibleRange() { return [2, 9]; },
  };
  const annotation = {
    render(actualView, actualSeries, actualCrosshair) { counts.annotation++; rendered.annotation.push({ view: snapshotView(actualView), series: snapshotSeries(actualSeries), crosshair: snapshotCrosshair(actualCrosshair) }); },
    requiresInteractionRedraw() { return annotationInteractionCoupled; },
  };
  const interaction = {
    render(actualView, actualSeries, actualCrosshair) { counts.interaction++; rendered.interaction.push({ view: snapshotView(actualView), series: snapshotSeries(actualSeries), crosshair: snapshotCrosshair(actualCrosshair) }); },
  };

  const session = new ChartSession({
    container,
    gpuCanvas,
    annotationCanvas,
    interactionCanvas,
    ownerDocument,
    gl,
    annotationCtx2d,
    interactionCtx2d,
    renderer,
    annotation,
    interaction,
    view,
    series,
    crosshair,
    onRestoreContext() {},
    onInvalidate,
    onRendered,
  });

  const resizeObserver = latestResizeObserver;
  return {
    session,
    view,
    series,
    crosshair,
    rendered,
    gpuCanvas,
    win,
    counts,
    canvases: [gpuCanvas, annotationCanvas, interactionCanvas],
    contexts: [annotationCtx2d, interactionCtx2d],
    size,
    resizeObserver: () => resizeObserver,
  };
}

test("all three physical surfaces share CSS/bitmap size and Canvas2D DPR transform", () => {
  const { session, canvases, contexts } = makeSession();
  session.activate();

  for (const canvas of canvases) {
    assert.equal(canvas.style.width, "640px");
    assert.equal(canvas.style.height, "360px");
    assert.equal(canvas.width, 1280);
    assert.equal(canvas.height, 720);
  }
  for (const ctx of contexts) {
    assert.deepEqual(ctx.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
  }

  session.destroy();
});

test("interaction-only invalidation redraws only interaction when annotation is uncoupled", () => {
  const { session, win, counts } = makeSession();
  session.activate();
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });

  session.invalidate(ChartChange.Interaction);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 2 });

  session.destroy();
});

test("annotation-only invalidation redraws only the annotation surface", () => {
  const { session, win, counts } = makeSession();
  session.activate();
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });

  session.invalidateSurface(ChartSurfaceDirty.Annotation);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, annotation: 2, interaction: 1 });

  session.destroy();
});

test("interaction invalidation may explicitly redraw annotation for legacy indicator parity", () => {
  const { session, win, counts } = makeSession({ annotationInteractionCoupled: true });
  session.activate();
  win.runNextFrame();

  session.invalidate(ChartChange.Interaction);
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, annotation: 2, interaction: 2 });

  session.destroy();
});

test("render scheduling is demand-driven and invalidation queues exactly one RAF", () => {
  const { session, win, counts } = makeSession();
  session.activate();
  assert.equal(win.queuedRafs(), 1);
  session.activate();
  assert.equal(win.queuedRafs(), 1, "activate must not fork the RAF loop");

  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });
  assert.equal(win.queuedRafs(), 0, "idle sessions must stop waking the main thread");

  session.invalidate(ChartChange.Data);
  assert.equal(win.queuedRafs(), 1, "invalidation must schedule a render");
  session.invalidate(ChartChange.Interaction);
  assert.equal(win.queuedRafs(), 1, "repeated invalidation must coalesce into the queued RAF");
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 2, annotation: 2, interaction: 2 });
  assert.equal(win.queuedRafs(), 0, "RAF must stop again after dirty work is drained");

  session.destroy();
  assert.equal(win.queuedRafs(), 0);
});

test("resize observer coalesces cleared-surface redraws into the next RAF", () => {
  const { session, win, counts, canvases, size, resizeObserver } = makeSession();
  session.activate();
  win.runNextFrame();
  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });

  size.width = 800;
  size.height = 450;
  const ro = resizeObserver();
  assert.ok(ro, "expected an active ResizeObserver");
  ro.trigger();
  ro.trigger();

  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 }, "resize callbacks must not render synchronously");
  assert.equal(win.queuedRafs(), 1, "continuous resize callbacks must coalesce into one RAF");
  for (const canvas of canvases) {
    assert.equal(canvas.width, 1280);
    assert.equal(canvas.height, 720);
  }

  win.runNextFrame();
  for (const canvas of canvases) {
    assert.equal(canvas.width, 1600);
    assert.equal(canvas.height, 900);
  }
  assert.deepEqual(counts, { gpu: 2, annotation: 2, interaction: 2 });
  assert.equal(win.queuedRafs(), 0);

  session.destroy();
});

test("DPR changes resize backing stores and schedule one redraw", () => {
  const { session, win, counts, canvases } = makeSession();
  session.activate();
  win.runNextFrame();

  win.devicePixelRatio = 1.5;
  win.triggerMediaChange();

  assert.equal(win.queuedRafs(), 1, "DPR change must schedule one owner RAF");
  for (const canvas of canvases) {
    assert.equal(canvas.width, 1280);
    assert.equal(canvas.height, 720);
  }
  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });

  win.runNextFrame();
  for (const canvas of canvases) {
    assert.equal(canvas.width, 960);
    assert.equal(canvas.height, 540);
  }
  assert.deepEqual(counts, { gpu: 2, annotation: 2, interaction: 2 });
  session.destroy();
});

test("render completion reports the exact physical surfaces that were actually drawn", () => {
  latestResizeObserver = null;
  const win = makeWindow(2);
  const ownerDocument = { defaultView: win };
  const gl = {};
  const gpuCanvas = makeCanvas(ownerDocument, gl);
  const annotationCanvas = makeCanvas(ownerDocument);
  const interactionCanvas = makeCanvas(ownerDocument);
  const rendered = [];
  const session = new ChartSession({
    container: { ownerDocument, getBoundingClientRect: () => ({ width: 640, height: 360 }) },
    gpuCanvas,
    annotationCanvas,
    interactionCanvas,
    ownerDocument,
    gl,
    annotationCtx2d: makeContext2d(),
    interactionCtx2d: makeContext2d(),
    renderer: { render() {}, visibleRange() { return [0, 0]; } },
    annotation: { render() {} },
    interaction: { render() {} },
    view: {},
    series: { length: 0 },
    crosshair: { visible: false, x: 0, y: 0 },
    onRestoreContext() {},
    onRendered(surfaces) { rendered.push(surfaces); },
  });

  session.activate();
  win.runNextFrame();
  assert.equal(rendered.length, 1);
  assert.notEqual(rendered[0] & ChartSurfaceDirty.Annotation, 0, "initial frame must report annotation surface");

  session.invalidate(ChartChange.Interaction);
  win.runNextFrame();
  assert.equal(rendered.length, 2);
  assert.equal(rendered[1], ChartSurfaceDirty.Interaction, "interaction-only frame must not claim annotation was painted");
  session.destroy();
});

test("native capture is a ChartSession-owned same-frame GPU+annotation operation", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/features/chart/ChartSession.ts", import.meta.url), "utf8"));
  assert.match(source, /captureCompositePng\s*\(/);
  assert.match(source, /readPixels\s*\(/);
  assert.match(source, /ChartSurfaceDirty\.GpuScene\s*\|\s*ChartSurfaceDirty\.Annotation/);
  assert.doesNotMatch(source, /drawImage\(\s*this\.interactionCanvas/);
});

test("production WebGL context never opts into preserveDrawingBuffer", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8"));
  const sessionSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/features/chart/ChartSession.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /preserveDrawingBuffer\s*:\s*true/);
  assert.doesNotMatch(sessionSource, /preserveDrawingBuffer\s*:\s*true/);
});

test("chart diagnostics stay off pure interaction invalidations and debug globals are disposable", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8"));
  assert.match(source, /changes !== ChartChange\.Interaction\) this\._queueHookUpdate\(\)/);
  assert.doesNotMatch(source, /this\.session\.invalidate = /, "the test hook follows invalidation through onInvalidate, not a patched method");
  assert.match(source, /if \(!chartHost\(\)\.exposeDebugGlobals\(\) && !isLoadTraceEnabled\(\)\) return;/);
  assert.match(source, /this\.disposeDebugGlobals\?\.\(\)/);
  assert.match(source, /if \(g\.__vp === vp\) delete g\.__vp/);
});

for (const [label, interrupt] of [
  ["deactivation", ({ session }) => session.deactivate()],
  ["WebGL context loss", ({ gpuCanvas }) => gpuCanvas.dispatch("webglcontextlost")],
]) {
  test(`a pending native capture is rejected on ${label} instead of waiting forever`, async () => {
    const harness = makeSession();
    harness.session.activate();
    harness.win.runNextFrame();
    const capture = harness.session.captureCompositePng();
    interrupt(harness);
    await assert.rejects(capture, (error) => error?.code === "CAPTURE_FAILED");
    // The session can capture again once it renders: the rejected capture no longer blocks it.
    harness.session.activate();
    if (label === "WebGL context loss") harness.gpuCanvas.dispatch("webglcontextrestored");
    const next = harness.session.captureCompositePng();
    harness.session.destroy();
    await assert.rejects(next, /destroyed during capture/);
  });
}

test("invalidate reports its semantic changes to onInvalidate", () => {
  const seen = [];
  const { session } = makeSession({ onInvalidate: (changes) => seen.push(changes) });
  session.invalidate(ChartChange.Interaction);
  session.invalidate();
  assert.deepEqual(seen, [ChartChange.Interaction, ChartChange.All]);
  session.destroy();
});

// T05-A (#316): every invalidation scope is carried to the frame that draws it, and the
// surfaces drawn stay the full set they were before the vocabulary was split.
test("each update kind reaches its frame with its own scope and the same surfaces", () => {
  const ALL = ChartSurfaceDirty.All;
  const frames = [];
  const { session, win, counts } = makeSession({ onRendered: (surfaces, changes) => frames.push({ surfaces, changes }) });
  session.activate();
  win.runNextFrame();
  assert.deepEqual(frames.at(-1), { surfaces: ALL, changes: ChartChange.All | ChartChange.Layout }, "first frame is a full one");

  const scenarios = [
    ["style", ChartChange.Style],
    ["visibility", ChartChange.Visibility],
    ["viewport", ChartChange.Viewport],
    ["layout", ChartChange.Layout | ChartChange.Viewport],
    ["live tail", ChartChange.DataTail],
    ["live tail with auto-fit", ChartChange.DataTail | ChartChange.Viewport],
    ["non-tail correction", ChartChange.DataNonTail],
    ["unscoped", ChartChange.All],
  ];
  for (const [label, change] of scenarios) {
    const before = { ...counts };
    session.invalidate(change);
    assert.deepEqual(session.pendingInvalidation, { changes: change, surfaces: ALL }, `${label}: pending scope`);
    win.runNextFrame();
    assert.deepEqual(frames.at(-1), { surfaces: ALL, changes: change }, `${label}: rendered scope`);
    assert.deepEqual(counts, { gpu: before.gpu + 1, annotation: before.annotation + 1, interaction: before.interaction + 1 }, `${label}: all three surfaces redrawn`);
    assert.deepEqual(session.pendingInvalidation, { changes: ChartChange.None, surfaces: ChartSurfaceDirty.None }, `${label}: scope consumed`);
  }
  session.destroy();
});

test("changes coalesced into one frame are reported together", () => {
  const frames = [];
  const { session, win } = makeSession({ onRendered: (surfaces, changes) => frames.push({ surfaces, changes }) });
  session.activate();
  win.runNextFrame();

  session.invalidate(ChartChange.Interaction);
  session.invalidate(ChartChange.DataTail);
  session.invalidate(ChartChange.Viewport);
  assert.equal(win.queuedRafs(), 1);
  win.runNextFrame();
  assert.deepEqual(frames.at(-1), {
    surfaces: ChartSurfaceDirty.All,
    changes: ChartChange.Interaction | ChartChange.DataTail | ChartChange.Viewport,
  });

  session.invalidateSurface(ChartSurfaceDirty.Annotation);
  win.runNextFrame();
  assert.deepEqual(frames.at(-1), { surfaces: ChartSurfaceDirty.Annotation, changes: ChartChange.None }, "an explicit surface request names no change");
  session.destroy();
});

test("resize reports a layout change and context restore a full one", () => {
  const frames = [];
  const { session, win, size, resizeObserver, gpuCanvas } = makeSession({ onRendered: (surfaces, changes) => frames.push({ surfaces, changes }) });
  session.activate();
  win.runNextFrame();

  size.width = 700;
  resizeObserver().trigger();
  win.runNextFrame();
  assert.deepEqual(frames.at(-1), { surfaces: ChartSurfaceDirty.All, changes: ChartChange.Layout });

  gpuCanvas.dispatch("webglcontextlost");
  assert.deepEqual(session.pendingInvalidation, { changes: ChartChange.None, surfaces: ChartSurfaceDirty.None });
  gpuCanvas.dispatch("webglcontextrestored");
  win.runNextFrame();
  assert.deepEqual(frames.at(-1), { surfaces: ChartSurfaceDirty.All, changes: ChartChange.All });
  session.destroy();
});

test("two-owner RAF isolation survives owner teardown", () => {
  const ownerA = makeSession();
  const ownerB = makeSession();
  const staleFrames = [];
  const requestA = ownerA.win.requestAnimationFrame.bind(ownerA.win);
  ownerA.win.requestAnimationFrame = callback => {
    staleFrames.push(callback);
    return requestA(callback);
  };

  ownerA.session.activate();
  ownerB.session.activate();
  assert.equal(ownerA.win.queuedRafs(), 1);
  assert.equal(ownerB.win.queuedRafs(), 1);
  ownerA.win.runNextFrame();
  ownerB.win.runNextFrame();
  assert.deepEqual(ownerA.counts, { gpu: 1, annotation: 1, interaction: 1 });
  assert.deepEqual(ownerB.counts, { gpu: 1, annotation: 1, interaction: 1 });

  ownerA.session.invalidate(ChartChange.Data);
  assert.equal(ownerA.win.queuedRafs(), 1);
  const staleFrame = staleFrames.at(-1);
  ownerA.session.destroy();
  assert.equal(ownerA.win.queuedRafs(), 0, "destroy cancels A's actual pending frame");
  staleFrame(0);
  assert.deepEqual(ownerA.counts, { gpu: 1, annotation: 1, interaction: 1 }, "a saved stale A callback cannot render after teardown");

  ownerB.session.invalidate(ChartChange.Interaction);
  assert.equal(ownerB.win.queuedRafs(), 1, "A teardown leaves B able to schedule work");
  ownerB.win.runNextFrame();
  assert.deepEqual(ownerB.counts, { gpu: 1, annotation: 1, interaction: 2 }, "B remains an independently active positive control");
  ownerB.session.destroy();
  assert.equal(ownerB.win.queuedRafs(), 0);
});

test("CPU lifecycle preserves owner state, DPR migration, and resource balance", () => {
  const ownerA = makeSession();
  const ownerB = makeSession({ barBase: 199, viewValues: { colWidth: 11, offsetX: 37, priceTop: 240, pricePerPx: 0.5, subPanesH: 28, priceAxisW: 72, area: { left: 52, top: 20, width: 480, height: 260 } } });
  assert.notEqual(ownerA.view, ownerB.view);
  assert.notEqual(ownerA.series, ownerB.series);
  assert.notEqual(ownerA.crosshair, ownerB.crosshair);
  assert.notEqual(ownerA.resizeObserver(), ownerB.resizeObserver(), "each session owns a distinct ResizeObserver");
  Object.assign(ownerA.series.bars[0], { open: 102, high: 109, low: 100, close: 106 });
  ownerB.crosshair.x = 92;
  assert.equal(ownerA.series.bars.length, 12);
  assert.equal(ownerB.series.bars.length, 12);
  for (const owner of [ownerA, ownerB]) {
    for (const bar of owner.series.bars) {
      assert.ok(bar.low <= bar.open && bar.low <= bar.close && bar.high >= bar.open && bar.high >= bar.close);
    }
  }
  assert.notDeepEqual(ownerA.view, ownerB.view, "owners carry distinct numeric public View state");
  ownerA.session.activate();
  ownerA.session.invalidate(ChartChange.Data);
  ownerB.session.activate();
  assert.equal(ownerA.win.queuedRafs(), 1, "activate and invalidate coalesce to one A frame");
  assert.equal(ownerB.win.queuedRafs(), 1);
  ownerA.win.runNextFrame();
  ownerB.win.runNextFrame();
  assert.equal(ownerA.rendered.gpu[0].series.bars[0].close, 106);
  assert.deepEqual(ownerA.rendered.gpu[0].view, {
    colWidth: 8, offsetX: -24, priceTop: 120, pricePerPx: 0.25, subPanesH: 16, priceAxisW: 64,
    area: { left: 40, top: 12, width: 520, height: 300 },
  });
  assert.deepEqual(ownerA.rendered.gpu[0].series.bars[0], {
    time: 1700000000000, open: 102, high: 109, low: 100, close: 106, volume: 7,
  });
  assert.deepEqual(ownerA.rendered.annotation[0].crosshair, { visible: true, x: 37, y: 81 });
  assert.equal(ownerB.rendered.gpu[0].series.bars[0].close, 203);
  assert.deepEqual(ownerB.rendered.gpu[0].series.bars[0], {
    time: 1700000000000, open: 199, high: 206, low: 197, close: 203, volume: 7,
  });
  assert.deepEqual(ownerB.rendered.gpu[0].view, {
    colWidth: 11, offsetX: 37, priceTop: 240, pricePerPx: 0.5, subPanesH: 28, priceAxisW: 72,
    area: { left: 52, top: 20, width: 480, height: 260 },
  });
  assert.deepEqual(ownerB.rendered.interaction[0].crosshair, { visible: true, x: 92, y: 81 });
  const migratedWin = makeWindow(1.5);
  const oldObserver = ownerA.resizeObserver();
  const oldWin = ownerA.win;
  ownerA.session.updateContainer({ ownerDocument: { defaultView: migratedWin }, getBoundingClientRect: () => ({ width: ownerA.size.width, height: ownerA.size.height }) });
  const newObserver = FakeResizeObserver.instances.at(-1);
  assert.notEqual(oldObserver, newObserver);
  assert.equal(oldObserver.operations.disconnect, 1);
  assert.equal(oldWin.mediaListenerCount(), 0, "old owner has no retained DPR listener");
  assert.equal(migratedWin.mediaOperations.add, 1);
  assert.equal(migratedWin.queuedRafs(), 1);
  for (const canvas of ownerA.canvases) {
    assert.equal(canvas.width, 1280); assert.equal(canvas.height, 720);
  }
  assert.deepEqual(ownerA.counts, { gpu: 1, annotation: 1, interaction: 1 });
  migratedWin.runNextFrame();
  for (const canvas of ownerA.canvases) {
    assert.equal(canvas.style.width, "640px"); assert.equal(canvas.style.height, "360px");
    assert.equal(canvas.width, 960); assert.equal(canvas.height, 540);
  }
  assert.deepEqual(ownerA.counts, { gpu: 2, annotation: 2, interaction: 2 });
  assert.equal(migratedWin.queuedRafs(), 0);
  ownerA.size.width = 0; ownerA.size.height = 0; newObserver.trigger();
  assert.equal(migratedWin.queuedRafs(), 0);
  for (const canvas of ownerA.canvases) {
    assert.equal(canvas.style.width, "640px"); assert.equal(canvas.style.height, "360px");
    assert.equal(canvas.width, 960); assert.equal(canvas.height, 540);
  }
  ownerA.size.width = 640; ownerA.size.height = 360;
  const beforeLoss = { ...ownerA.counts };
  ownerA.session.invalidate(ChartChange.Data);
  assert.equal(migratedWin.queuedRafs(), 1, "A has a real pending RAF before context loss");
  const pendingBeforeLoss = migratedWin.pendingFrame();
  assert.equal(typeof pendingBeforeLoss, "function", "capture the actual scheduled A callback");
  ownerA.gpuCanvas.dispatch("webglcontextlost");
  assert.equal(migratedWin.queuedRafs(), 0, "context loss cancels A's actual pending RAF");
  assert.deepEqual(ownerA.counts, beforeLoss, "loss callback itself does not draw any surface");
  pendingBeforeLoss(0);
  assert.deepEqual(ownerA.counts, beforeLoss, "the canceled pre-loss callback cannot draw after loss");
  ownerA.session.invalidate(ChartChange.Data);
  assert.equal(migratedWin.queuedRafs(), 1, "a real lost-context render intent may enqueue a RAF");
  migratedWin.runNextFrame();
  assert.equal(migratedWin.queuedRafs(), 0, "the lost-context callback completes without rescheduling");
  assert.deepEqual(ownerA.counts, beforeLoss, "lost-context render intent draws none of the three surfaces");
  ownerB.session.invalidate(ChartChange.Interaction); ownerB.win.runNextFrame();
  assert.equal(ownerB.counts.interaction, 2, "B remains a positive-control renderer during A context loss");
  assert.deepEqual(ownerA.counts, beforeLoss);
  ownerA.gpuCanvas.dispatch("webglcontextrestored");
  assert.equal(migratedWin.queuedRafs(), 1); migratedWin.runNextFrame();
  assert.deepEqual(ownerA.counts, { gpu: beforeLoss.gpu + 1, annotation: beforeLoss.annotation + 1, interaction: beforeLoss.interaction + 1 });
  assert.deepEqual(ownerA.rendered.gpu.at(-1).series.bars[0], {
    time: 1700000000000, open: 102, high: 109, low: 100, close: 106, volume: 7,
  });
  assert.deepEqual(ownerA.rendered.gpu.at(-1).view, {
    colWidth: 8, offsetX: -24, priceTop: 120, pricePerPx: 0.25, subPanesH: 16, priceAxisW: 64,
    area: { left: 40, top: 12, width: 520, height: 300 },
  });
  assert.deepEqual(ownerA.rendered.annotation.at(-1).crosshair, { visible: true, x: 37, y: 81 });
  assert.deepEqual(ownerA.rendered.interaction.at(-1).crosshair, { visible: true, x: 37, y: 81 });
  assert.equal(ownerB.counts.interaction, 2, "restoring A does not mutate B");
  ownerA.session.invalidate(ChartChange.Data); ownerA.session.invalidate(ChartChange.Interaction);
  assert.equal(migratedWin.queuedRafs(), 1);
  const staleFrame = migratedWin.pendingFrame();
  ownerA.session.deactivate(); assert.equal(migratedWin.queuedRafs(), 0);
  ownerA.session.activate(); assert.equal(migratedWin.queuedRafs(), 1);
  ownerA.session.destroy(); assert.equal(migratedWin.queuedRafs(), 0);
  assert.equal(newObserver.operations.observe, 1);
  assert.equal(newObserver.operations.disconnect, 1, 'destroy disconnects the migrated owner observer');
  const finalA = { ...ownerA.counts }; staleFrame(0); assert.deepEqual(ownerA.counts, finalA);
  ownerB.session.invalidate(ChartChange.Interaction); ownerB.win.runNextFrame();
  assert.equal(ownerB.counts.interaction, 3);
  ownerB.session.destroy(); assert.equal(ownerB.win.queuedRafs(), 0); assert.equal(ownerB.win.mediaListenerCount(), 0, "destroy releases B owner media listener");
  for (const owner of [ownerA, ownerB]) {
    for (const canvas of owner.canvases) assert.equal(canvas.listenerOperations.add, canvas.listenerOperations.remove);
    assert.equal(owner.resizeObserver().operations.observe, 1);
    assert.equal(owner.resizeObserver().operations.disconnect, 1);
  }
  assert.equal(oldWin.mediaListenerCount(), 0);
  assert.equal(migratedWin.mediaListenerCount(), 0, "destroy releases the replacement-owner DPR listener");
});

test("owner adoption cancels the pending RAF on its actual old window and re-schedules on the new owner", () => {
  // Given: one live session holding a pending frame (realm-local id 1) on the OLD owner
  // window, plus an independent NEW owner window whose only queued frame carries the same
  // realm-local id 1 for an UNRELATED control callback - a deliberate cross-realm RAF id
  // collision. Everything is observed through external scheduler queues and render side
  // effects; no session-private field is read or patched.
  const ownerA = makeSession();
  const winB = makeWindow(2);
  const cancelsA = [];
  const cancelOnA = ownerA.win.cancelAnimationFrame.bind(ownerA.win);
  ownerA.win.cancelAnimationFrame = (id) => { cancelsA.push(id); return cancelOnA(id); };
  const cancelsB = [];
  const cancelOnB = winB.cancelAnimationFrame.bind(winB);
  winB.cancelAnimationFrame = (id) => { cancelsB.push(id); return cancelOnB(id); };

  const controlRuns = [];
  const controlId = winB.requestAnimationFrame(() => controlRuns.push("control-1"));
  ownerA.session.activate();
  assert.equal(ownerA.win.queuedRafs(), 1, "positive control: the session holds a pending frame on the old owner window");
  assert.equal(winB.queuedRafs(), 1, "positive control: the new owner window queue is populated before adoption");
  assert.equal(controlId, 1, "premise: the control's realm-local id collides with the session's pending old-realm id");

  // When: the public host path adopts a second-owner container exactly like
  // ChartRuntime.refreshHostLifecycle - updateContainer(panelRoot) then invalidate(),
  // with no pre-deactivate - while the old-realm frame is still pending.
  ownerA.session.updateContainer({
    ownerDocument: { defaultView: winB },
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  });
  ownerA.session.invalidate();

  // Then: the pending old-realm frame is cancelled on its OWN window ...
  assert.ok(cancelsA.includes(1), "adoption must cancel the pending old-owner frame on the old window");
  assert.equal(ownerA.win.queuedRafs(), 0, "the old owner scheduler must no longer hold any session frame");
  // ... and the new owner schedules exactly one fresh session frame beside the control.
  assert.equal(winB.queuedRafs(), 2, "new owner queue = unrelated control + exactly one fresh session frame");

  // The fresh new-owner frame is real: draining the new realm runs the control first,
  // then renders the session through the new owner's scheduler.
  winB.runNextFrame();
  assert.deepEqual(controlRuns, ["control-1"], "the unrelated new-owner control survives adoption");
  winB.runNextFrame();
  assert.deepEqual(ownerA.counts, { gpu: 1, annotation: 1, interaction: 1 }, "the adopted session renders through the new owner's scheduler");
  assert.equal(winB.queuedRafs(), 0, "the fresh frame drains fully without rescheduling");

  // Destroy isolation: only the chart-owned new-owner schedule is cancelled.
  ownerA.session.invalidate();
  const control2Runs = [];
  winB.requestAnimationFrame(() => control2Runs.push("control-2"));
  ownerA.session.destroy();
  assert.deepEqual(cancelsB, [3], "destroy cancels exactly the chart-owned new-owner frame (realm-local id 3), never an unrelated callback");
  assert.equal(winB.queuedRafs(), 1, "the unrelated new-owner control survives destroy");
  assert.equal(ownerA.win.queuedRafs(), 0, "the old owner queue stays empty after destroy");

  // Draining both realms cannot create post-destroy renders or new schedules.
  winB.runNextFrame();
  assert.deepEqual(control2Runs, ["control-2"]);
  assert.equal(winB.queuedRafs(), 0);
  assert.deepEqual(ownerA.counts, { gpu: 1, annotation: 1, interaction: 1 }, "no chart render may run after destroy");
  assert.deepEqual(controlRuns, ["control-1"], "both non-chart controls stayed alive across adoption and destroy");
});

const { ChartRenderCoordinator } = await import("../dist/features/chart/ChartRenderCoordinator.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { FootprintRenderer } = await import("../dist/core/render/footprintRenderer.js");
const { View } = await import("../dist/core/engine/view.js");

function viewConfig(overrides = {}) {
  return {
    chartType: "footprint",
    tpoMode: "letters",
    tpoProfilePeriod: "session",
    tpoBracketSize: 30,
    clusterCellData: "volume",
    profileCellData: "volume",
    candles: true,
    heat: true,
    cellNumbers: true,
    poc: true,
    stackedImbalance: true,
    ...overrides,
  };
}

test("a visibility toggle and a restored renderer both receive the panel config", () => {
  const pushed = [];
  const overlayPushed = [];
  let renderer = { setChartConfig: (config) => pushed.push(["first", config]) };
  const coordinator = new ChartRenderCoordinator({
    session: { invalidate() {} },
    overlay: { setChartConfig: (config) => overlayPushed.push(config) },
    getRenderer: () => renderer,
    listIndicators: () => [],
  });

  coordinator.applyConfig(viewConfig());
  const layers = coordinator.getGpuLayerIds();
  coordinator.applyConfig(viewConfig({ heat: false }));
  assert.equal(pushed.at(-1)[1].heat, false, "heat-only change must reach the renderer");
  assert.equal(overlayPushed.at(-1).heat, false, "heat-only change must reach the overlay");
  assert.equal(coordinator.getGpuLayerIds(), layers, "visibility toggles do not rebuild the layer composition");

  // WebGL restore: a new renderer with the same layer key still gets the panel config.
  renderer = { setChartConfig: (config) => pushed.push(["restored", config]) };
  coordinator.applyConfig(viewConfig({ heat: false }));
  assert.deepEqual(pushed.at(-1)[0], "restored");
  assert.equal(pushed.at(-1)[1].heat, false);
  coordinator.dispose();
});

test("the GPU flush uses the canvas window's DPR, not the main window's", () => {
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const canvas = { ownerDocument: { defaultView: { devicePixelRatio: 2 } } };
    const gl = new Proxy({ canvas, drawingBufferWidth: 1600, drawingBufferHeight: 1200 }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === "string" && /^[A-Z_0-9]+$/.test(prop)) return 1;
        return () => ({});
      },
    });
    const renderer = new FootprintRenderer(gl);
    const flushes = [];
    renderer.batch = {
      begin() {},
      rect() {},
      flush: (w, h) => flushes.push([w, h]),
      dispose() {},
    };
    renderer.setChartConfig(viewConfig());
    const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
    const view = new View();
    view.area = { left: 0, top: 0, width: 800, height: 600 };
    view.priceTop = 120;
    view.pricePerPx = 0.1;
    renderer.renderLayers(view, series, new Set());
    assert.deepEqual(flushes.at(-1), [800, 600]);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

