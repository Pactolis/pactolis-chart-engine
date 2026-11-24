import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BoundedWorkerPortQueue,
  WORKER_RUNTIME_HOST_BOUNDARY,
} from "../dist/features/chart/worker/workerProtocol.js";
import {
  OffscreenCanvasOwnershipManager,
  ORDERED_SURFACE_ROLES,
  SURFACE_LAYER_Z_ORDER,
  probeOffscreenCanvasCapabilities,
} from "../dist/features/chart/worker/offscreenSurfaceAdapter.js";
import {
  WorkerChartEndpoint,
  WorkerChartHostBridge,
} from "../dist/features/chart/worker/workerRuntimeAdapter.js";

function createSpyPort(port) {
  let addCount = 0;
  let removeCount = 0;
  const realAdd = port.addEventListener.bind(port);
  const realRemove = port.removeEventListener.bind(port);
  port.addEventListener = (type, listener) => {
    addCount++;
    return realAdd(type, listener);
  };
  port.removeEventListener = (type, listener) => {
    removeCount++;
    return realRemove(type, listener);
  };
  return {
    port,
    getAddCount: () => addCount,
    getRemoveCount: () => removeCount,
    getActiveListeners: () => addCount - removeCount,
  };
}

function createFakeCanvas(initialWidth = 800, initialHeight = 600) {
  let transferred = false;
  return {
    width: initialWidth,
    height: initialHeight,
    style: {},
    transferControlToOffscreen() {
      if (transferred) {
        throw new Error("Native DOMException: Cannot transfer control twice");
      }
      transferred = true;
      return { width: this.width, height: this.height, kind: "fake-offscreen" };
    },
  };
}

test("static DOM-safety: workerProtocol.ts and workerRuntimeAdapter.ts contain zero document./window. accesses", () => {
  const protocolSrc = readFileSync(
    new URL("../src/features/chart/worker/workerProtocol.ts", import.meta.url),
    "utf8",
  );
  const runtimeSrc = readFileSync(
    new URL("../src/features/chart/worker/workerRuntimeAdapter.ts", import.meta.url),
    "utf8",
  );

  for (const [name, src] of [
    ["workerProtocol.ts", protocolSrc],
    ["workerRuntimeAdapter.ts", runtimeSrc],
  ]) {
    assert.equal(/\bdocument\./.test(src), false, `${name} must not reference document.`);
    assert.equal(/\bwindow\./.test(src), false, `${name} must not reference window.`);
  }

  assert.ok(WORKER_RUNTIME_HOST_BOUNDARY.mainThreadResponsibilities.length > 0);
  assert.ok(WORKER_RUNTIME_HOST_BOUNDARY.workerCoreResponsibilities.length > 0);
  assert.match(WORKER_RUNTIME_HOST_BOUNDARY.zeroRelayRule, /direct/i);
});

test("BoundedWorkerPortQueue drops stale generations, enforces credit/backpressure, and coalesces pointermove/wheel without reordering barriers", () => {
  const queue = new BoundedWorkerPortQueue({
    maxSize: 16,
    initialCredits: 2,
    initialGeneration: 2,
  });

  // Stale generation dropped
  const staleRes = queue.enqueue({
    channel: "main",
    kind: "main:input",
    panelId: "p1",
    marketId: "BTC-USD",
    generation: 1,
    seq: 1,
    revision: 1,
    payload: { type: "pointermove", x: 1, y: 1, timestamp: 10 },
  });
  assert.equal(staleRes, "dropped-stale");

  // Ordered sequence: pointerdown -> pointermove (x2 coalesced) -> wheel (x2 coalesced) -> pointerup
  queue.enqueue({
    channel: "main",
    kind: "main:input",
    panelId: "p1",
    marketId: "BTC-USD",
    generation: 2,
    seq: 2,
    revision: 1,
    payload: { type: "pointerdown", x: 10, y: 20, button: 0, timestamp: 20 },
  });
  queue.enqueue({
    channel: "main",
    kind: "main:input",
    panelId: "p1",
    marketId: "BTC-USD",
    generation: 2,
    seq: 3,
    revision: 1,
    payload: { type: "pointermove", x: 11, y: 21, timestamp: 21 },
  });
  const coalescedMove = queue.enqueue({
    channel: "main",
    kind: "main:input",
    panelId: "p1",
    marketId: "BTC-USD",
    generation: 2,
    seq: 4,
    revision: 1,
    payload: { type: "pointermove", x: 15, y: 25, timestamp: 22 },
  });
  assert.equal(coalescedMove, "coalesced");

  queue.enqueue({
    channel: "main",
    kind: "main:input",
    panelId: "p1",
    marketId: "BTC-USD",
    generation: 2,
    seq: 5,
    revision: 1,
    payload: { type: "wheel", x: 15, y: 25, deltaX: 0, deltaY: 10, timestamp: 23 },
  });
  queue.enqueue({
    channel: "main",
    kind: "main:input",
    panelId: "p1",
    marketId: "BTC-USD",
    generation: 2,
    seq: 6,
    revision: 1,
    payload: { type: "wheel", x: 15, y: 25, deltaX: 2, deltaY: 20, timestamp: 24 },
  });
  queue.enqueue({
    channel: "main",
    kind: "main:input",
    panelId: "p1",
    marketId: "BTC-USD",
    generation: 2,
    seq: 7,
    revision: 1,
    payload: { type: "pointerup", x: 15, y: 25, button: 0, timestamp: 25 },
  });

  // Only 2 credits initially -> drains 2 items
  const firstBatch = queue.drain(10, false);
  assert.equal(firstBatch.length, 2);
  assert.equal(firstBatch[0].payload.type, "pointerdown");
  assert.equal(firstBatch[1].payload.type, "pointermove");
  assert.equal(firstBatch[1].payload.x, 15);

  // 0 credits left -> drain returns 0
  assert.equal(queue.drain(10, false).length, 0);

  // Grant credits and drain remaining
  queue.grantCredits(5);
  const secondBatch = queue.drain(10, false);
  assert.equal(secondBatch.length, 2);
  assert.equal(secondBatch[0].payload.type, "wheel");
  assert.equal(secondBatch[0].payload.deltaY, 30);
  assert.equal(secondBatch[0].payload.deltaX, 2);
  assert.equal(secondBatch[1].payload.type, "pointerup");
});

test("Direct MessageChannel end-to-end: zero main-thread tick/history relay, stale/abort filtering, dedup, and request/response correlation", async () => {
  const mainChannel = new MessageChannel();
  const ingressChannel = new MessageChannel();
  const historyChannel = new MessageChannel();

  const hostMainSpy = createSpyPort(mainChannel.port1);
  const hostIngressSpy = createSpyPort(ingressChannel.port1);
  const hostHistorySpy = createSpyPort(historyChannel.port1);

  const workerMainSpy = createSpyPort(mainChannel.port2);
  const workerIngressSpy = createSpyPort(ingressChannel.port2);
  const workerHistorySpy = createSpyPort(historyChannel.port2);

  const receivedTicks = [];
  const receivedBars = [];
  const receivedHistory = [];
  const receivedInputs = [];
  const recycledBuffers = [];

  const bridge = new WorkerChartHostBridge({
    panelId: "panel-1",
    marketId: "ETH-USD",
    initialCredits: 10,
    closePortsOnDispose: true,
    onRecycleBuffer: (payload) => recycledBuffers.push(payload),
  });

  const endpoint = new WorkerChartEndpoint({
    panelId: "panel-1",
    marketId: "ETH-USD",
    handlers: {
      onTick: (p) => receivedTicks.push(p),
      onBar: (p) => receivedBars.push(p),
      onHistoryChunk: (p) => receivedHistory.push(p),
      onInput: (e) => receivedInputs.push(e),
      onHitTest: ({ x, y }) => ({ hit: true, targetKind: "candle", price: 3200 + x, time: 1000 + y }),
      onTooltip: ({ x, y }) => ({ visible: true, title: "ETH", lines: ["O:3200"], x, y }),
      onCapture: ({ format }) => ({ ok: true, width: 800, height: 600, buffer: new ArrayBuffer(format === "png" ? 16 : 8) }),
    },
  });

  bridge.attachPorts({
    mainPort: hostMainSpy.port,
    ingressPort: hostIngressSpy.port,
    historyPort: hostHistorySpy.port,
  });

  // Main thread NEVER attaches message listeners to ingress or history ports
  assert.equal(hostIngressSpy.getAddCount(), 0);
  assert.equal(hostHistorySpy.getAddCount(), 0);

  endpoint.attachPorts({
    mainPort: workerMainSpy.port,
    ingressPort: workerIngressSpy.port,
    historyPort: workerHistorySpy.port,
  });

  // Direct worker <-> worker ingress ticks (bypassing main thread completely)
  ingressChannel.port1.postMessage({
    channel: "ingress",
    kind: "ingress:tick",
    panelId: "panel-1",
    marketId: "ETH-USD",
    generation: 0,
    seq: 1,
    revision: 1,
    payload: { price: 3250, size: 1.5, timestamp: 1000, tradeId: "t-1" },
  });
  // Duplicate tradeId should be dropped
  ingressChannel.port1.postMessage({
    channel: "ingress",
    kind: "ingress:tick",
    panelId: "panel-1",
    marketId: "ETH-USD",
    generation: 0,
    seq: 2,
    revision: 1,
    payload: { price: 3250, size: 1.5, timestamp: 1000, tradeId: "t-1" },
  });
  // Bar + duplicate bar revision
  ingressChannel.port1.postMessage({
    channel: "ingress",
    kind: "ingress:bar",
    panelId: "panel-1",
    marketId: "ETH-USD",
    generation: 0,
    seq: 3,
    revision: 5,
    payload: { time: 60, open: 1, high: 2, low: 1, close: 2, volume: 10, timeframe: "1m" },
  });
  ingressChannel.port1.postMessage({
    channel: "ingress",
    kind: "ingress:bar",
    panelId: "panel-1",
    marketId: "ETH-USD",
    generation: 0,
    seq: 4,
    revision: 5,
    payload: { time: 60, open: 1, high: 2, low: 1, close: 2, volume: 10, timeframe: "1m" },
  });

  // Direct history chunk
  historyChannel.port1.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "panel-1",
    marketId: "ETH-USD",
    generation: 0,
    seq: 1,
    revision: 1,
    payload: { timeframe: "1m", bars: [], hasMore: false, chunkIndex: 0 },
  });

  // Correlated requests over mainPort
  const [hitRes, tipRes, capRes] = await Promise.all([
    bridge.requestHitTest(10, 20),
    bridge.requestTooltip(15, 25),
    bridge.requestCapture({ format: "png" }),
  ]);

  assert.equal(hitRes.hit, true);
  assert.equal(hitRes.price, 3210);
  assert.equal(tipRes.visible, true);
  assert.equal(capRes.ok, true);
  assert.equal(capRes.buffer?.byteLength, 16);

  // Input coalescing across mainPort
  bridge.sendInput({ type: "pointerdown", x: 1, y: 1, button: 0, timestamp: 1 });
  bridge.sendInput({ type: "pointermove", x: 2, y: 2, timestamp: 2 });
  bridge.sendInput({ type: "pointermove", x: 9, y: 9, timestamp: 3 });
  bridge.sendInput({ type: "pointerup", x: 9, y: 9, button: 0, timestamp: 4 });

  await new Promise((r) => setTimeout(r, 20));
  endpoint.flushInputs();

  assert.equal(receivedTicks.length, 1);
  assert.equal(receivedBars.length, 1);
  assert.equal(receivedHistory.length, 1);
  assert.deepEqual(
    receivedInputs.map((i) => i.type),
    ["pointerdown", "pointermove", "pointerup"],
  );
  assert.equal(receivedInputs[1].x, 9);

  // Transferable buffer recycle hook
  const recycleBuf = new ArrayBuffer(32);
  endpoint.recycleBuffer(recycleBuf, "buf-1");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(recycledBuffers.length, 1);
  assert.equal(recycledBuffers[0].bufferId, "buf-1");
  assert.equal(recycledBuffers[0].buffer.byteLength, 32);

  // Generation bump drops stale messages & aborts pending requests
  const newGen = bridge.bumpGeneration("market-switch");
  assert.equal(newGen, 1);
  await new Promise((r) => setTimeout(r, 20));

  // Stale generation=0 message directly to worker must be dropped
  ingressChannel.port1.postMessage({
    channel: "ingress",
    kind: "ingress:tick",
    panelId: "panel-1",
    marketId: "ETH-USD",
    generation: 0,
    seq: 99,
    revision: 1,
    payload: { price: 9999, size: 1, timestamp: 9999, tradeId: "stale-1" },
  });
  // Aborted message must be dropped
  ingressChannel.port1.postMessage({
    channel: "ingress",
    kind: "ingress:tick",
    panelId: "panel-1",
    marketId: "ETH-USD",
    generation: 1,
    seq: 1,
    revision: 1,
    abort: true,
    payload: { price: 8888, size: 1, timestamp: 9999, tradeId: "abort-1" },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(receivedTicks.length, 1);
  const stats = endpoint.getStats();
  assert.ok(stats.droppedStale >= 1);
  assert.ok(stats.droppedAborted >= 1);
  assert.ok(stats.droppedDuplicate >= 2);

  // Clean teardown -> zero leaked listeners
  bridge.dispose();
  endpoint.dispose();
  assert.equal(hostMainSpy.getActiveListeners(), 0);
  assert.equal(workerMainSpy.getActiveListeners(), 0);
  assert.equal(workerIngressSpy.getActiveListeners(), 0);
  assert.equal(workerHistorySpy.getActiveListeners(), 0);
});

test("OffscreenCanvasOwnershipManager enforces single-transfer rule, recreates canvas on recovery, preserves 3-surface Z-order, and probes fallback", () => {
  // In Node without OffscreenCanvas, probe deterministically recommends main-thread fallback
  const probe = probeOffscreenCanvasCapabilities(null);
  assert.equal(probe.supported, false);
  assert.equal(probe.recommendedMode, "main-thread");
  assert.ok(probe.fallbackReason);

  const manager = new OffscreenCanvasOwnershipManager();
  const gpuCanvas = createFakeCanvas(1024, 768);
  const annCanvas = createFakeCanvas(1024, 768);
  const intCanvas = createFakeCanvas(1024, 768);

  const gpuOffscreen = manager.transferSurface("gpu-scene", gpuCanvas, { width: 1024, height: 768, dpr: 2 });
  manager.transferSurface("annotation", annCanvas, { width: 1024, height: 768, dpr: 2 });
  manager.transferSurface("interaction", intCanvas, { width: 1024, height: 768, dpr: 2 });

  assert.ok(gpuOffscreen);
  assert.equal(manager.hasTransferred(gpuCanvas), true);

  // Single-transfer rule enforcement: transferring same DOM canvas twice must throw
  assert.throws(() => {
    manager.transferSurface("gpu-scene", gpuCanvas, { width: 1024, height: 768, dpr: 2 });
  }, /already been transferred/i);

  // 3-surface Z-order preservation
  const snapshotBefore = manager.getSurfaceSnapshot();
  assert.deepEqual(
    snapshotBefore.map((s) => s.role),
    ORDERED_SURFACE_ROLES,
  );
  assert.deepEqual(
    snapshotBefore.map((s) => s.zIndex),
    [SURFACE_LAYER_Z_ORDER["gpu-scene"], SURFACE_LAYER_Z_ORDER.annotation, SURFACE_LAYER_Z_ORDER.interaction],
  );

  // Recovery / popout re-homing: recreate canvas node and transfer fresh node
  const { entry: recreatedEntry } = manager.recreateAndTransfer(
    "gpu-scene",
    () => createFakeCanvas(1280, 720),
    { width: 1280, height: 720, dpr: 2 },
  );

  assert.notEqual(recreatedEntry.canvas, gpuCanvas);
  assert.equal(recreatedEntry.zIndex, 0);
  assert.equal(recreatedEntry.canvas.style.zIndex, "0");
  assert.equal(manager.hasTransferred(gpuCanvas), true);
  assert.equal(manager.hasTransferred(recreatedEntry.canvas), true);

  const snapshotAfter = manager.getSurfaceSnapshot();
  assert.deepEqual(
    snapshotAfter.map((s) => s.role),
    ["gpu-scene", "annotation", "interaction"],
  );
  assert.equal(snapshotAfter[0].width, 1280);
  assert.equal(snapshotAfter[0].generation, 1);

  manager.dispose();
});

test("Worker crash/restart bounded recovery clears pending requests and bounds restart attempts", async () => {
  const ch1 = new MessageChannel();
  const ch2 = new MessageChannel();

  const statuses = [];
  const bridge = new WorkerChartHostBridge({
    panelId: "panel-crash",
    marketId: "SOL-USD",
    maxRestarts: 1,
    closePortsOnDispose: true,
    onStatusChange: (s) => statuses.push(s),
  });

  const spy1 = createSpyPort(ch1.port1);
  bridge.attachPorts({ mainPort: spy1.port });

  const pendingReq = bridge.requestHitTest(5, 5);
  const recovered = bridge.handleWorkerCrash("uncaught-oom", { mainPort: ch2.port1 });
  assert.equal(recovered, true);
  assert.equal(spy1.getActiveListeners(), 0);
  await assert.rejects(pendingReq, /Worker crashed/i);

  // Second crash exceeds maxRestarts (1) -> transitions to failed
  const recoveredSecond = bridge.handleWorkerCrash("second-crash");
  assert.equal(recoveredSecond, false);
  assert.equal(bridge.currentStatus, "failed");
  assert.ok(statuses.includes("recovering"));
  assert.ok(statuses.includes("failed"));

  bridge.dispose();
  ch1.port2.close();
  ch2.port2.close();
});
