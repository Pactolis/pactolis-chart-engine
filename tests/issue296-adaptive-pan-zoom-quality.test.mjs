import test from "node:test";
import assert from "node:assert/strict";
import { InteractionQualityController } from "../dist/core/render/interactionQuality.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { DEFAULT_VOLUME_PROFILE_SETTINGS } from "../dist/core/analysis/volumeProfile.js";
import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";
import { Canvas2dSurface } from "../dist/core/gpu/canvas2d/canvas2dSurface.js";

function makeDeterministicTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimer(cb, delayMs) {
      const id = nextId++;
      tasks.set(id, { cb, delayMs });
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    pendingCount() {
      return tasks.size;
    },
    flushAll() {
      const entries = [...tasks.entries()];
      for (const [id, entry] of entries) {
        tasks.delete(id);
        entry.cb();
      }
    },
    captureCallbacks() {
      return [...tasks.values()].map((t) => t.cb);
    },
  };
}

function makeMock2dContext(canvas) {
  const fillTextCalls = [];
  const drawImageCalls = [];
  const ctx = {
    canvas,
    fillStyle: "#000",
    strokeStyle: "#000",
    font: "12px monospace",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    setLineDash() {},
    setTransform() {},
    getTransform() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    },
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    fillText(text, x, y) {
      fillTextCalls.push({ text: String(text), x, y });
    },
    drawImage(...args) {
      drawImageCalls.push(args);
    },
  };
  return { ctx, fillTextCalls, drawImageCalls };
}

function makeMockCanvas(width = 800, height = 400) {
  const canvas = {
    width,
    height,
    style: { cssText: "", width: "", height: "", cursor: "" },
    dataset: {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    ownerDocument: null,
    getContext() { return null; },
  };
  const { ctx, fillTextCalls, drawImageCalls } = makeMock2dContext(canvas);
  canvas.ownerDocument = {
    createElement: () => makeMockCanvas(width, height).canvas,
  };
  canvas.getContext = (kind) => (kind === "2d" ? ctx : null);
  return { canvas, ctx, fillTextCalls, drawImageCalls };
}

function makeSeriesWithFootprintCells() {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
  const cells = new Map([
    [50_000, { priceBin: 50_000, buyVol: 18, sellVol: 12, count: 6 }],
    [50_010, { priceBin: 50_010, buyVol: 14, sellVol: 8, count: 4 }],
  ]);
  series.loadBars([
    {
      startTime: 1_699_999_980_000,
      open: 50_000,
      high: 50_020,
      low: 49_990,
      close: 50_010,
      volume: 52,
      delta: 12,
      count: 10,
      cells,
      hasRef: true,
    },
  ]);
  return series;
}

function makeView() {
  const view = new View();
  view.area = { left: 0, top: 0, width: 720, height: 360 };
  view.colWidth = 100;
  view.offsetX = 0;
  view.priceTop = 50_050;
  view.pricePerPx = 0.5;
  return view;
}

function makeFakeSessionDomEnv() {
  const rafs = new Map();
  let nextRafId = 1;
  const makeNode = (tag) => {
    const listeners = new Map();
    const attrs = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      width: 0,
      height: 0,
      style: { cssText: "", width: "", height: "", cursor: "" },
      dataset: {},
      children,
      parentNode: null,
      parentElement: null,
      get ownerDocument() { return doc; },
      setAttribute(name, val) { attrs.set(name, String(val)); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      removeAttribute(name) { attrs.delete(name); },
      appendChild(child) { child.parentNode = el; child.parentElement = el; children.push(child); return child; },
      append(...nodes) { for (const n of nodes) el.appendChild(n); },
      getContext(kind) { return kind === "2d" ? makeMock2dContext(el).ctx : null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0 }; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    };
    return el;
  };
  const doc = {
    visibilityState: "visible",
    defaultView: null,
    head: null,
    createElement: (tag) => makeNode(tag),
    addEventListener() {},
    removeEventListener() {},
  };
  doc.head = makeNode("head");
  const win = {
    devicePixelRatio: 1,
    location: { search: "?gpu=canvas2d" },
    performance: { now: () => Date.now() },
    document: doc,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    matchMedia() {
      return { matches: true, addEventListener() {}, removeEventListener() {} };
    },
    requestAnimationFrame(cb) {
      const id = nextRafId++;
      rafs.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      rafs.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = win;
  return { doc, win, makeContainer: () => makeNode("div") };
}

test("#296: opt-in default-off and pinnedFullQuality never enter reduced quality", () => {
  const timers = makeDeterministicTimers();
  const defaultController = new InteractionQualityController({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.equal(defaultController.getPolicy().enabled, false);
  assert.equal(defaultController.getPolicy().pinnedFullQuality, false);

  defaultController.beginInteraction();
  for (let i = 0; i < 6; i++) {
    const snap = defaultController.noteMotion({ velocityPxPerSec: 2500, frameMs: 40, now: i * 16 });
    assert.equal(snap.qualityLevel, "full");
    assert.equal(snap.suppressDenseFootprintText, false);
    assert.equal(snap.preserveCoreElements, true);
  }
  defaultController.endInteraction();
  assert.equal(timers.pendingCount(), 0);

  const pinnedController = new InteractionQualityController({
    policy: { enabled: true, pinnedFullQuality: true, hysteresisFrames: 2 },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  pinnedController.beginInteraction();
  for (let i = 0; i < 5; i++) {
    const snap = pinnedController.noteMotion({ velocityPxPerSec: 3000, frameMs: 50, now: i * 16 });
    assert.equal(snap.qualityLevel, "full");
    assert.equal(snap.suppressDenseFootprintText, false);
    assert.equal(snap.preserveCoreElements, true);
  }
  pinnedController.dispose();
  defaultController.dispose();
});

test("#296: state machine transitions idle -> interacting -> settling -> idle with hysteresis and telemetry", () => {
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const timers = makeDeterministicTimers();
    const settledGenerations = [];
    const controller = new InteractionQualityController({
      policy: {
        enabled: true,
        enterVelocityPxPerSec: 800,
        enterFrameBudgetMs: 20,
        hysteresisFrames: 3,
        settleDelayMs: 120,
        maxReducedDurationMs: 2000,
      },
      onSettleFullQuality: (gen) => settledGenerations.push(gen),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    assert.equal(controller.getSnapshot().phase, "idle");
    assert.equal(controller.getSnapshot().qualityLevel, "full");

    // Single-frame jitter must not enter reduced quality.
    controller.beginInteraction();
    assert.equal(controller.getSnapshot().phase, "interacting");
    assert.equal(controller.noteMotion({ velocityPxPerSec: 1200, frameMs: 10, now: 10 }).qualityLevel, "full");
    assert.equal(controller.noteMotion({ velocityPxPerSec: 200, frameMs: 8, now: 26 }).qualityLevel, "full");

    // Sustained fast velocity (3 consecutive frames) enters reduced quality.
    assert.equal(controller.noteMotion({ velocityPxPerSec: 950, frameMs: 12, now: 42 }).qualityLevel, "full");
    assert.equal(controller.noteMotion({ velocityPxPerSec: 950, frameMs: 12, now: 58 }).qualityLevel, "full");
    const reducedSnap = controller.noteMotion({ velocityPxPerSec: 950, frameMs: 12, now: 74 });
    assert.equal(reducedSnap.phase, "interacting");
    assert.equal(reducedSnap.qualityLevel, "reduced");
    assert.equal(reducedSnap.suppressDenseFootprintText, true);
    assert.equal(reducedSnap.deferNonCriticalProfileDetail, true);
    assert.equal(reducedSnap.preserveCoreElements, true);

    // Ending interaction enters settling and schedules deterministic full-quality settle.
    const settlingSnap = controller.endInteraction();
    assert.equal(settlingSnap.phase, "settling");
    assert.equal(settlingSnap.qualityLevel, "reduced");
    assert.equal(settlingSnap.preserveCoreElements, true);

    timers.flushAll();
    const idleSnap = controller.getSnapshot();
    assert.equal(idleSnap.phase, "idle");
    assert.equal(idleSnap.qualityLevel, "full");
    assert.equal(idleSnap.suppressDenseFootprintText, false);
    assert.equal(idleSnap.preserveCoreElements, true);
    assert.deepEqual(settledGenerations, [0]);

    const telemetry = snapshotPerformanceTelemetry();
    assert.equal(telemetry.counters["chart.interactionQuality.enteredReduced"], 1);
    assert.equal(telemetry.counters["chart.interactionQuality.settledFull"], 1);
    controller.dispose();
  } finally {
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: false });
  }
});

test("#296: frame-budget gating, stale generation settle drop, and cancel/dispose cleanup", () => {
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const timers = makeDeterministicTimers();
    const settledGenerations = [];
    const controller = new InteractionQualityController({
      policy: {
        enabled: true,
        enterVelocityPxPerSec: 5000,
        enterFrameBudgetMs: 18,
        hysteresisFrames: 2,
        settleDelayMs: 100,
        maxReducedDurationMs: 1000,
      },
      onSettleFullQuality: (gen) => settledGenerations.push(gen),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    // Frame-budget gating alone can trigger reduced quality.
    controller.beginInteraction();
    controller.noteMotion({ velocityPxPerSec: 100, frameMs: 22, now: 10 });
    const reduced = controller.noteMotion({ velocityPxPerSec: 100, frameMs: 25, now: 35 });
    assert.equal(reduced.qualityLevel, "reduced");

    // Enter settling, capture scheduled timer callback, then bump generation before it fires.
    controller.endInteraction();
    const staleCallbacks = timers.captureCallbacks();
    assert.ok(staleCallbacks.length >= 1);
    const nextGen = controller.bumpGeneration();
    assert.equal(nextGen, 1);
    assert.equal(controller.getSnapshot().phase, "idle");
    assert.equal(controller.getSnapshot().qualityLevel, "full");

    // Firing the stale settle callback must be ignored and counted.
    for (const cb of staleCallbacks) cb();
    assert.deepEqual(settledGenerations, []);
    const telemetry = snapshotPerformanceTelemetry();
    assert.ok((telemetry.counters["chart.interactionQuality.staleIgnored"] ?? 0) >= 1);

    // Cancel clears timers and resets to idle/full.
    controller.beginInteraction();
    controller.noteMotion({ frameMs: 30, now: 100 });
    controller.noteMotion({ frameMs: 30, now: 130 });
    assert.equal(controller.getSnapshot().qualityLevel, "reduced");
    controller.cancel();
    assert.equal(controller.getSnapshot().phase, "idle");
    assert.equal(controller.getSnapshot().qualityLevel, "full");
    assert.equal(timers.pendingCount(), 0);

    // Dispose prevents further transitions.
    controller.dispose();
    controller.beginInteraction();
    controller.noteMotion({ frameMs: 40, now: 200 });
    controller.noteMotion({ frameMs: 40, now: 240 });
    assert.equal(controller.getSnapshot().qualityLevel, "full");
    assert.equal(controller.getSnapshot().preserveCoreElements, true);
  } finally {
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: false });
  }
});

test("#296: Overlay suppresses only dense footprint text in reduced quality and restores full parity on settle", () => {
  const timers = makeDeterministicTimers();
  const controller = new InteractionQualityController({
    policy: {
      enabled: true,
      enterVelocityPxPerSec: 500,
      hysteresisFrames: 2,
      settleDelayMs: 80,
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const { ctx, fillTextCalls } = makeMockCanvas(800, 400);
  const series = makeSeriesWithFootprintCells();
  const view = makeView();
  const crosshair = { x: 0, y: 0, visible: false };
  let foregroundCalls = 0;

  const overlay = new Overlay(
    ctx,
    () => { foregroundCalls += 1; },
    () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
  );
  overlay.setInteractionQualityController(controller);

  const layers = ["footprint-text", "drawings", "axis"];

  // Baseline full quality renders footprint text and core layers.
  overlay.renderAnnotations(view, series, crosshair, [0, 1], layers, ChartChange.All);
  const baselineTextCount = fillTextCalls.length;
  assert.ok(baselineTextCount > 0, "baseline full quality renders footprint/axis text");
  assert.equal(foregroundCalls, 1);
  assert.equal(overlay.isAdaptiveReducedQualityActive(), false);

  // Enter reduced quality via sustained fast pan.
  controller.beginInteraction();
  controller.noteMotion({ velocityPxPerSec: 900, now: 10 });
  controller.noteMotion({ velocityPxPerSec: 900, now: 26 });
  assert.equal(overlay.isAdaptiveReducedQualityActive(), true);

  fillTextCalls.length = 0;
  overlay.renderAnnotations(view, series, crosshair, [0, 1], layers, ChartChange.Viewport);
  const reducedTextCount = fillTextCalls.length;
  assert.ok(
    reducedTextCount < baselineTextCount,
    `reduced quality suppresses dense footprint text (${reducedTextCount} < ${baselineTextCount})`,
  );
  assert.equal(foregroundCalls, 2, "core drawings layer still renders during reduced quality");

  // Settle back to full quality: annotationPassCache must not reuse reduced pass.
  controller.endInteraction();
  timers.flushAll();
  assert.equal(overlay.isAdaptiveReducedQualityActive(), false);

  fillTextCalls.length = 0;
  overlay.renderAnnotations(view, series, crosshair, [0, 1], layers, ChartChange.Style);
  assert.equal(fillTextCalls.length, baselineTextCount, "full-quality settle restores exact text parity");
  assert.equal(foregroundCalls, 3);

  overlay.dispose();
  controller.dispose();
});

test("#296: ChartSession hooks trigger deterministic full-quality settle redraw and clean up on deactivate/destroy", () => {
  const env = makeFakeSessionDomEnv();
  const container = env.makeContainer();
  const gpuCanvas = env.doc.createElement("canvas");
  const annotationCanvas = env.doc.createElement("canvas");
  const interactionCanvas = env.doc.createElement("canvas");

  const invalidations = [];
  const attachedControllers = [];
  const session = new ChartSession({
    container,
    gpuCanvas,
    gpuSurface: new Canvas2dSurface(gpuCanvas),
    annotationCanvas,
    interactionCanvas,
    ownerDocument: env.doc,
    annotationCtx2d: makeMock2dContext(annotationCanvas).ctx,
    interactionCtx2d: makeMock2dContext(interactionCanvas).ctx,
    renderer: { render() {}, visibleRange() { return [0, 0]; } },
    annotation: {
      render() {},
      setInteractionQualityController(c) { attachedControllers.push(c); },
    },
    interaction: { render() {} },
    view: { area: { left: 0, top: 0, width: 640, height: 360 } },
    series: { length: 0 },
    crosshair: { x: 0, y: 0, visible: false },
    onRestoreContext() {},
    onInvalidate: (changes) => invalidations.push(changes),
  });

  const timers = makeDeterministicTimers();
  const controller = new InteractionQualityController({
    policy: {
      enabled: true,
      enterVelocityPxPerSec: 600,
      hysteresisFrames: 2,
      settleDelayMs: 90,
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  session.activate();
  session.setInteractionQualityController(controller);
  assert.equal(attachedControllers.at(-1), controller);

  session.notifyInteractionMotion({ velocityPxPerSec: 1000, now: 10 });
  const snap = session.notifyInteractionMotion({ velocityPxPerSec: 1000, now: 26 });
  assert.equal(snap?.qualityLevel, "reduced");

  invalidations.length = 0;
  session.endInteractionMotion();
  assert.equal(timers.pendingCount() >= 1, true);
  timers.flushAll();
  assert.ok(invalidations.includes(ChartChange.Style), "settle triggers deterministic Style invalidation");

  // Deactivate cancels pending timers.
  session.notifyInteractionMotion({ velocityPxPerSec: 1000, now: 100 });
  session.notifyInteractionMotion({ velocityPxPerSec: 1000, now: 120 });
  session.endInteractionMotion();
  session.deactivate();
  assert.equal(controller.getSnapshot().phase, "idle");
  assert.equal(controller.getSnapshot().qualityLevel, "full");
  assert.equal(timers.pendingCount(), 0);

  // Destroy disposes controller cleanly.
  session.destroy();
  session.notifyInteractionMotion({ velocityPxPerSec: 1000, now: 200 });
  assert.equal(controller.getSnapshot().qualityLevel, "full");
});
