import test from "node:test";
import assert from "node:assert/strict";

import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { ChartChange, ChartSurfaceDirty } from "../dist/core/render/scene/chartScene.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";
import { ChartRenderCoordinator } from "../dist/features/chart/ChartRenderCoordinator.js";
import {
  GlobalRenderScheduler,
  configureGlobalRenderScheduler,
  getGlobalRenderScheduler,
  getGlobalRenderSchedulerConfig,
  resetGlobalRenderSchedulerConfig,
} from "../dist/features/chart/globalRenderScheduler.js";

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = null;
  }
  observe(target) { this.observed = target; }
  disconnect() { this.observed = null; }
  trigger() { this.callback([]); }
}

function makeWindow(dpr = 1) {
  let nextRafId = 1;
  let rafRequests = 0;
  let rafCancels = 0;
  const rafs = new Map();
  return {
    devicePixelRatio: dpr,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame(callback) {
      rafRequests++;
      const id = nextRafId++;
      rafs.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      if (rafs.delete(id)) rafCancels++;
    },
    runNextFrame(timestamp = 0) {
      const entry = rafs.entries().next().value;
      assert.ok(entry, "expected a queued RAF");
      const [id, callback] = entry;
      rafs.delete(id);
      callback(timestamp);
    },
    queuedRafs() { return rafs.size; },
    rafRequestCount() { return rafRequests; },
    rafCancelCount() { return rafCancels; },
    matchMedia() {
      return {
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };
}

function makeCanvas(ownerDocument, context = null) {
  return {
    ownerDocument,
    style: {},
    width: 0,
    height: 0,
    getContext(kind) {
      if (kind === "webgl2") return context;
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeContext2d() {
  return { setTransform() {} };
}

function makeSession({
  win = makeWindow(1),
  useGlobalScheduler,
  renderPriority,
  onDraw,
  onRendered,
} = {}) {
  const ownerDocument = {
    defaultView: win,
    createElement() {
      return makeCanvas(ownerDocument);
    },
  };
  const gl = {};
  const gpuCanvas = makeCanvas(ownerDocument, gl);
  const annotationCanvas = makeCanvas(ownerDocument);
  const interactionCanvas = makeCanvas(ownerDocument);
  const container = {
    ownerDocument,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };
  const counts = { gpu: 0, annotation: 0, interaction: 0 };
  const gpuSurface = {
    kind: "webgpu",
    canvas: gpuCanvas,
    resize(w, h) {
      gpuCanvas.width = w;
      gpuCanvas.height = h;
    },
    dispose() {},
    onLost() { return () => {}; },
    async requestCapture() {
      return {
        width: gpuCanvas.width || 640,
        height: gpuCanvas.height || 360,
        data: new Uint8ClampedArray((gpuCanvas.width || 640) * (gpuCanvas.height || 360) * 4),
      };
    },
  };
  const view = {
    colWidth: 8,
    offsetX: -24,
    priceTop: 120,
    pricePerPx: 0.25,
    subPanesH: 16,
    priceAxisW: 64,
    area: { left: 40, top: 12, width: 520, height: 300 },
  };
  const series = {
    length: 2,
    bars: [
      { time: 1700000000000, open: 100, high: 105, low: 99, close: 103, volume: 10 },
      { time: 1700000060000, open: 103, high: 108, low: 101, close: 106, volume: 12 },
    ],
  };
  const crosshair = { visible: true, x: 10, y: 20 };

  const session = new ChartSession({
    container,
    gpuCanvas,
    annotationCanvas,
    interactionCanvas,
    ownerDocument,
    gpuSurface,
    annotationCtx2d: makeContext2d(),
    interactionCtx2d: makeContext2d(),
    renderer: {
      render() {
        counts.gpu++;
        onDraw?.("gpu");
      },
      visibleRange() { return [0, 1]; },
    },
    annotation: {
      render() {
        counts.annotation++;
        onDraw?.("annotation");
      },
    },
    interaction: {
      render() {
        counts.interaction++;
        onDraw?.("interaction");
      },
    },
    view,
    series,
    crosshair,
    onRestoreContext() {},
    onRendered,
    useGlobalScheduler,
    renderPriority,
  });

  return { session, win, container, counts, gpuCanvas, annotationCanvas };
}

function resetAll() {
  configurePerformanceTelemetry({ enabled: false });
  resetPerformanceTelemetry();
  resetGlobalRenderSchedulerConfig();
}

test("global scheduler maintains zero-idle RAF invariant", () => {
  resetAll();
  try {
    const win = makeWindow();
    const scheduler = new GlobalRenderScheduler(win);
    assert.equal(win.queuedRafs(), 0);
    assert.equal(scheduler.isRafScheduled(), false);

    const tokenA = { id: "A" };
    let calls = 0;
    scheduler.schedule(tokenA, () => { calls++; }, { priority: "active" });
    assert.equal(win.queuedRafs(), 1);
    assert.equal(scheduler.isRafScheduled(), true);

    // Unregistering the only pending panel cancels the RAF immediately.
    scheduler.unregister(tokenA);
    assert.equal(win.queuedRafs(), 0);
    assert.equal(win.rafCancelCount(), 1);
    assert.equal(scheduler.isRafScheduled(), false);

    // Scheduling and flushing once leaves zero pending RAFs when queue drains.
    scheduler.schedule(tokenA, () => { calls++; }, { priority: "active" });
    assert.equal(win.queuedRafs(), 1);
    win.runNextFrame();
    assert.equal(calls, 1);
    assert.equal(win.queuedRafs(), 0);
    assert.equal(scheduler.isRafScheduled(), false);
  } finally {
    resetAll();
  }
});

test("global scheduler prioritizes active > visible > hidden under tight frame budget", () => {
  resetAll();
  try {
    configurePerformanceTelemetry({ enabled: true });
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 5, maxStalenessMs: 1000 });

    let clock = 0;
    const win = makeWindow();
    const scheduler = new GlobalRenderScheduler(win, () => clock);

    const order = [];
    const hidden = { id: "hidden" };
    const visible = { id: "visible" };
    const active = { id: "active" };

    // Enqueue in reverse priority order; each callback advances virtual clock by 6ms (> 5ms budget).
    scheduler.schedule(hidden, () => { order.push("hidden"); clock += 6; }, { priority: "hidden" });
    scheduler.schedule(visible, () => { order.push("visible"); clock += 6; }, { priority: "visible" });
    scheduler.schedule(active, () => { order.push("active"); clock += 6; }, { priority: "active" });

    assert.equal(win.queuedRafs(), 1);

    // Frame 1: only "active" runs before budget is exceeded; "visible" and "hidden" defer.
    win.runNextFrame();
    assert.deepEqual(order, ["active"]);
    assert.equal(win.queuedRafs(), 1);

    // Frame 2: "visible" runs next; "hidden" defers.
    win.runNextFrame();
    assert.deepEqual(order, ["active", "visible"]);
    assert.equal(win.queuedRafs(), 1);

    // Frame 3: "hidden" runs and queue drains.
    win.runNextFrame();
    assert.deepEqual(order, ["active", "visible", "hidden"]);
    assert.equal(win.queuedRafs(), 0);

    const { counters } = snapshotPerformanceTelemetry();
    assert.equal(counters["chart.scheduler.frames"], 3);
    assert.equal(counters["chart.scheduler.deferred"], 3);
  } finally {
    resetAll();
  }
});

test("global scheduler enforces round-robin fairness and age-based anti-starvation", () => {
  resetAll();
  try {
    configurePerformanceTelemetry({ enabled: true });
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 5, maxStalenessMs: 20 });

    let clock = 0;
    const win = makeWindow();
    const scheduler = new GlobalRenderScheduler(win, () => clock);

    const ran = [];
    const a1 = { id: "a1" };
    const a2 = { id: "a2" };
    const v1 = { id: "v1" };

    const scheduleA1 = () => scheduler.schedule(a1, () => {
      ran.push("a1");
      clock += 6;
      if (ran.length < 4) scheduleA1();
    }, { priority: "active" });

    const scheduleA2 = () => scheduler.schedule(a2, () => {
      ran.push("a2");
      clock += 6;
      if (ran.length < 4) scheduleA2();
    }, { priority: "active" });

    scheduleA1();
    scheduleA2();
    scheduler.schedule(v1, () => {
      ran.push("v1");
      clock += 6;
    }, { priority: "visible" });

    // Frame 1 (clock=0): a1 runs (clock -> 6), a2 & v1 defer.
    win.runNextFrame();
    // Frame 2 (clock=6): a2 runs (round-robin ahead of re-queued a1), v1 & a1 defer.
    win.runNextFrame();
    // Advance clock past maxStalenessMs so v1 ages >= 20ms.
    clock = 25;
    // Frame 3 (clock=25): v1 is starvation-boosted and sits ahead of a1/a2 in pending Map!
    win.runNextFrame();

    assert.equal(ran[0], "a1");
    assert.equal(ran[1], "a2");
    assert.equal(ran[2], "v1");

    const { counters } = snapshotPerformanceTelemetry();
    assert.ok((counters["chart.scheduler.starvationBoost"] ?? 0) >= 1);
  } finally {
    resetAll();
  }
});

test("urgent capture and container resize flush ahead of normal active/visible panels", async () => {
  resetAll();
  try {
    configurePerformanceTelemetry({ enabled: true });
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 100, maxStalenessMs: 100 });

    const win = makeWindow();
    const order = [];
    const activePanel = makeSession({
      win,
      useGlobalScheduler: true,
      renderPriority: "active",
      onRendered: () => order.push("active"),
    });
    const capturePanel = makeSession({
      win,
      useGlobalScheduler: true,
      renderPriority: "hidden",
      onRendered: () => order.push("capture"),
    });

    activePanel.session.activate();
    capturePanel.session.activate();
    win.runNextFrame();
    order.length = 0;

    // Schedule active panel first, then hidden panel requests capture (urgent).
    activePanel.session.invalidate(ChartChange.Viewport);
    const capturePromise = capturePanel.session.captureCompositePng().catch(() => "encoded-or-mock");

    assert.equal(win.queuedRafs(), 1);
    win.runNextFrame();
    await capturePromise;

    assert.deepEqual(order, ["capture", "active"]);
    const { counters } = snapshotPerformanceTelemetry();
    assert.ok((counters["chart.scheduler.urgentFlush"] ?? 0) >= 1);

    activePanel.session.destroy();
    capturePanel.session.destroy();
  } finally {
    resetAll();
  }
});

test("popout multi-window domain isolation via updateContainer re-homes pending work cleanly", () => {
  resetAll();
  try {
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 16, maxStalenessMs: 100 });

    const mainWin = makeWindow();
    const popoutWin = makeWindow();
    const mainScheduler = getGlobalRenderScheduler(mainWin);
    const popoutScheduler = getGlobalRenderScheduler(popoutWin);
    assert.notEqual(mainScheduler, popoutScheduler);

    const { session, counts } = makeSession({ win: mainWin, useGlobalScheduler: true });
    session.activate();
    mainWin.runNextFrame();
    assert.equal(counts.gpu, 1);

    // Queue a pending frame on mainWin.
    session.invalidate(ChartChange.Data);
    assert.equal(mainScheduler.getPendingCount(), 1);
    assert.equal(mainWin.queuedRafs(), 1);
    assert.equal(popoutScheduler.getPendingCount(), 0);

    // Move container to popoutWin's document.
    const popoutDocument = {
      defaultView: popoutWin,
      createElement: () => makeCanvas({ defaultView: popoutWin }),
    };
    const popoutContainer = {
      ownerDocument: popoutDocument,
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    };
    session.updateContainer(popoutContainer);

    assert.equal(mainScheduler.getPendingCount(), 0);
    assert.equal(mainWin.queuedRafs(), 0);
    assert.equal(popoutScheduler.getPendingCount(), 1);
    assert.equal(popoutWin.queuedRafs(), 1);

    popoutWin.runNextFrame();
    assert.equal(counts.gpu, 2);
    assert.equal(popoutWin.queuedRafs(), 0);

    session.destroy();
  } finally {
    resetAll();
  }
});

test("10x burst presentation requests coalesce into 1 callback without losing semantic changes", () => {
  resetAll();
  try {
    configurePerformanceTelemetry({ enabled: true });
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 16, maxStalenessMs: 100 });

    const win = makeWindow();
    const renderedEvents = [];
    const { session, counts } = makeSession({
      win,
      useGlobalScheduler: true,
      onRendered: (surfaces, changes) => renderedEvents.push({ surfaces, changes }),
    });

    session.activate();
    win.runNextFrame();
    renderedEvents.length = 0;
    const initialGpuDraws = counts.gpu;

    // 10 rapid invalidations across different surface/change kinds before vsync.
    for (let i = 0; i < 4; i++) session.invalidate(ChartChange.Interaction);
    for (let i = 0; i < 3; i++) session.invalidate(ChartChange.Style);
    for (let i = 0; i < 3; i++) session.invalidate(ChartChange.Data);

    assert.equal(win.queuedRafs(), 1);
    win.runNextFrame();

    assert.equal(counts.gpu, initialGpuDraws + 1);
    assert.equal(renderedEvents.length, 1);
    assert.ok((renderedEvents[0].changes & ChartChange.Interaction) !== 0);
    assert.ok((renderedEvents[0].changes & ChartChange.Style) !== 0);
    assert.ok((renderedEvents[0].changes & ChartChange.Data) !== 0);
    assert.equal(renderedEvents[0].surfaces, ChartSurfaceDirty.All);

    session.destroy();
  } finally {
    resetAll();
  }
});

test("hidden panel retains state and renders fresh when unhidden via ChartRenderCoordinator", () => {
  resetAll();
  try {
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 16, maxStalenessMs: 100 });

    const win = makeWindow();
    const { session, counts } = makeSession({
      win,
      useGlobalScheduler: true,
      renderPriority: "hidden",
    });
    const coordinator = new ChartRenderCoordinator({
      session,
      overlay: { setChartConfig() {} },
      getRenderer: () => ({ setChartConfig() {} }),
      listIndicators: () => [],
    });

    session.activate();
    win.runNextFrame();
    assert.equal(counts.gpu, 1);

    // Hide / deactivate retains state; reactivating + promoting to active renders fresh.
    coordinator.setPanelPriority("hidden");
    session.deactivate();
    assert.equal(win.queuedRafs(), 0);

    coordinator.setPanelPriority("active");
    session.activate();
    session.invalidate(ChartChange.Data);
    assert.equal(win.queuedRafs(), 1);

    win.runNextFrame();
    assert.equal(counts.gpu, 2);

    coordinator.dispose();
    session.destroy();
  } finally {
    resetAll();
  }
});

test("opt-in feature flag defaults to disabled and falls back to legacy per-session RAF", () => {
  resetAll();
  try {
    configurePerformanceTelemetry({ enabled: true });
    assert.equal(getGlobalRenderSchedulerConfig().enabled, false);

    const win = makeWindow();
    const s1 = makeSession({ win });
    const s2 = makeSession({ win });

    s1.session.activate();
    s2.session.activate();

    // Legacy per-session RAF queues one RAF per session directly on win.
    assert.equal(win.queuedRafs(), 2);
    win.runNextFrame();
    win.runNextFrame();
    assert.equal(s1.counts.gpu, 1);
    assert.equal(s2.counts.gpu, 1);

    const { counters } = snapshotPerformanceTelemetry();
    assert.equal(counters["chart.scheduler.frames"], undefined);

    s1.session.destroy();
    s2.session.destroy();
  } finally {
    resetAll();
  }
});

test("#411: urgent callbacks respect frameBudgetMs across 8+ panels without single-frame spike", () => {
  resetAll();
  try {
    configurePerformanceTelemetry({ enabled: true });
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 16, maxStalenessMs: 100 });
    let nowMs = 1000;
    const win = makeWindow();
    const scheduler = new GlobalRenderScheduler(win, () => nowMs);

    const executed = [];
    for (let i = 0; i < 10; i++) {
      const token = { id: `panel-urgent-${i}` };
      scheduler.schedule(token, () => {
        executed.push(i);
        nowMs += 5;
      }, { priority: "visible", urgent: true });
    }

    assert.equal(win.queuedRafs(), 1);
    win.runNextFrame(nowMs);

    // Budget is 16ms: panel 0 (5ms), 1 (10ms), 2 (15ms), 3 (20ms >= 16ms) -> stops after 4 callbacks.
    assert.deepEqual(executed, [0, 1, 2, 3]);
    assert.equal(scheduler.getPendingCount(), 6);
    assert.equal(win.queuedRafs(), 1, "remaining urgent panels defer to next frame");

    win.runNextFrame(nowMs);
    assert.equal(executed.length, 8);
    assert.equal(scheduler.getPendingCount(), 2);

    win.runNextFrame(nowMs);
    assert.deepEqual(executed, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(scheduler.getPendingCount(), 0);

    const { counters } = snapshotPerformanceTelemetry();
    assert.ok((counters["chart.scheduler.overbudgetFrames"] ?? 0) >= 2);
  } finally {
    resetAll();
  }
});

test("#411: starved visible panels make bounded progress under continuous multi-panel urgent flood", () => {
  resetAll();
  try {
    configurePerformanceTelemetry({ enabled: true });
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 16, maxStalenessMs: 40 });
    let nowMs = 0;
    const win = makeWindow();
    const scheduler = new GlobalRenderScheduler(win, () => nowMs);

    let visibleRuns = 0;
    let urgentRuns = 0;

    // Schedule 1 visible panel that stays starved when urgent flood keeps budget busy.
    scheduler.schedule({ id: "panel-visible" }, () => {
      visibleRuns++;
      nowMs += 4;
    }, { priority: "visible", urgent: false });

    for (let i = 0; i < 6; i++) {
      const token = { id: `panel-flood-${i}` };
      const reschedule = () => {
        urgentRuns++;
        nowMs += 6;
        if (urgentRuns < 30) {
          scheduler.schedule(token, reschedule, { priority: "active", urgent: true });
        }
      };
      scheduler.schedule(token, reschedule, { priority: "active", urgent: true });
    }

    // Frame 1 at t=0: 3 urgent callbacks consume 18ms (>16ms), visible does not starve yet.
    win.runNextFrame(0);
    assert.equal(visibleRuns, 0);

    // Advance past maxStalenessMs (40ms): starved visible entry must outrank urgent flood.
    nowMs = 50;
    win.runNextFrame(nowMs);
    assert.equal(visibleRuns, 1, "starved visible panel must make progress ahead of continuous urgent flood");

    const { counters } = snapshotPerformanceTelemetry();
    assert.ok((counters["chart.scheduler.starvationBoost"] ?? 0) >= 1);
  } finally {
    resetAll();
  }
});

test("#411: scheduler stays consistent across reentrant schedule, unregister during flush, and callback exception", () => {
  resetAll();
  try {
    configureGlobalRenderScheduler({ enabled: true, frameBudgetMs: 32, maxStalenessMs: 100 });
    let nowMs = 0;
    const win = makeWindow();
    const scheduler = new GlobalRenderScheduler(win, () => nowMs);

    const firstToken = { id: "first" };
    const victimToken = { id: "victim" };
    const reentrantToken = { id: "reentrant" };
    const throwerToken = { id: "thrower" };

    const log = [];
    scheduler.schedule(firstToken, () => {
      log.push("first");
      scheduler.unregister(victimToken);
      scheduler.schedule(reentrantToken, () => {
        log.push("reentrant");
      }, { priority: "visible" });
    }, { priority: "active", urgent: true });

    scheduler.schedule(victimToken, () => {
      log.push("victim-should-not-run");
    }, { priority: "active", urgent: true });

    scheduler.schedule(throwerToken, () => {
      log.push("thrower");
      throw new Error("synthetic render failure");
    }, { priority: "visible" });

    assert.throws(() => win.runNextFrame(nowMs), /synthetic render failure/);
    assert.deepEqual(log, ["first", "thrower"]);
    // Reentrant entry was queued while flushing and must remain scheduled for next frame.
    assert.equal(scheduler.getPendingCount(), 1);
    assert.equal(win.queuedRafs(), 1);
    win.runNextFrame(nowMs + 16);
    assert.deepEqual(log, ["first", "thrower", "reentrant"]);
    assert.equal(scheduler.getPendingCount(), 0);
  } finally {
    resetAll();
  }
});
