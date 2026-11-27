import test from "node:test";
import assert from "node:assert/strict";
import {
  BoundedWorkerPortQueue,
  INGRESS_TICKS_STRIDE,
} from "../dist/features/chart/worker/workerProtocol.js";
import { ChartWorkerPanelRuntime } from "../dist/features/chart/worker/chartWorkerRuntime.js";
import { WorkerChartHostBridge } from "../dist/features/chart/worker/workerRuntimeAdapter.js";

function makePortPair() {
  const listenersA = new Set();
  const listenersB = new Set();
  const portA = {
    postMessage(data) {
      for (const fn of [...listenersB]) fn({ data });
    },
    addEventListener(_type, fn) {
      listenersA.add(fn);
    },
    removeEventListener(_type, fn) {
      listenersA.delete(fn);
    },
    start() {},
    close() {},
  };
  const portB = {
    postMessage(data) {
      for (const fn of [...listenersA]) fn({ data });
    },
    addEventListener(_type, fn) {
      listenersB.add(fn);
    },
    removeEventListener(_type, fn) {
      listenersB.delete(fn);
    },
    start() {},
    close() {},
  };
  return { portA, portB };
}

function makeMock2dContext(canvas) {
  return {
    canvas,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    strokeText() {},
    measureText(text) {
      return { width: String(text ?? "").length * 6 };
    },
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    closePath() {},
    setLineDash() {},
    drawImage() {},
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    getImageData(_x, _y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData() {},
  };
}

function makeMockCanvas(width = 640, height = 360) {
  const canvas = {
    width,
    height,
    getContext(kind) {
      if (kind === "2d") return makeMock2dContext(canvas);
      return null;
    },
  };
  return canvas;
}

function packTicks(ticks) {
  const buffer = new ArrayBuffer(ticks.length * INGRESS_TICKS_STRIDE * Float64Array.BYTES_PER_ELEMENT);
  const view = new Float64Array(buffer);
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    const base = i * INGRESS_TICKS_STRIDE;
    view[base] = t.timestamp;
    view[base + 1] = t.price;
    view[base + 2] = t.size;
    view[base + 3] = t.side === "buy" ? 1 : t.side === "sell" ? -1 : 0;
  }
  return buffer;
}

function snapshotSeries(series) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const bar = series.at(i);
    if (!bar) continue;
    const cells = [...bar.cells.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([priceBin, cell]) => [priceBin, cell.buyVol, cell.sellVol]);
    out.push({
      startTime: bar.startTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      delta: bar.delta,
      count: bar.count,
      cells,
    });
  }
  return out;
}

test("#432: 10k tick/s in 100ms batches matches singular ingress:tick OHLCV/delta/footprint identically and emits N credits", async () => {
  const totalTicks = 10_000;
  const batchSize = 1_000; // 10k tick/s in 100ms batches => 10 batches of 1000 ticks
  const baseTime = 1_700_000_040_000;
  const ticks = new Array(totalTicks);
  let expectedVolume = 0;
  for (let i = 0; i < totalTicks; i++) {
    const price = 50_000 + (i % 15);
    const size = 1 + (i % 5);
    const side = i % 3 === 0 ? "sell" : i % 3 === 1 ? "buy" : undefined;
    expectedVolume += size;
    ticks[i] = {
      timestamp: baseTime + Math.floor(i / 10), // 10 ticks/ms => 1000ms total across 10 batches
      price,
      size,
      side,
    };
  }

  // Runtime A: singular ingress:tick
  const mainA = makePortPair();
  const ingressA = makePortPair();
  const runtimeA = new ChartWorkerPanelRuntime({
    panelId: "p-432-single",
    marketId: "BTCUSDT",
    intervalMs: 60_000,
    priceStep: 1,
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvas(),
  });
  runtimeA.attachPorts({ mainPort: mainA.portB, ingressPort: ingressA.portB });

  // Runtime B: batched ingress:ticks
  const mainB = makePortPair();
  const ingressB = makePortPair();
  const runtimeB = new ChartWorkerPanelRuntime({
    panelId: "p-432-batch",
    marketId: "BTCUSDT",
    intervalMs: 60_000,
    priceStep: 1,
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvas(),
  });
  runtimeB.attachPorts({ mainPort: mainB.portB, ingressPort: ingressB.portB });

  const credits = [];
  ingressB.portA.addEventListener("message", ({ data }) => {
    if (data?.kind === "ingress:credit") {
      credits.push(data.payload.granted);
    }
  });

  for (let i = 0; i < totalTicks; i++) {
    const t = ticks[i];
    ingressA.portA.postMessage({
      channel: "ingress",
      kind: "ingress:tick",
      panelId: "p-432-single",
      marketId: "BTCUSDT",
      generation: 0,
      seq: i + 1,
      revision: 1,
      payload: {
        timestamp: t.timestamp,
        price: t.price,
        size: t.size,
        ...(t.side ? { side: t.side } : {}),
      },
    });
  }

  const batchCount = totalTicks / batchSize;
  for (let b = 0; b < batchCount; b++) {
    const slice = ticks.slice(b * batchSize, (b + 1) * batchSize);
    const buffer = packTicks(slice);
    ingressB.portA.postMessage({
      channel: "ingress",
      kind: "ingress:ticks",
      panelId: "p-432-batch",
      marketId: "BTCUSDT",
      generation: 0,
      seq: b + 1,
      revision: 1,
      transfer: [buffer],
      payload: {
        buffer,
        count: slice.length,
        firstSeq: b * batchSize + 1,
        schema: 1,
      },
    });
  }

  const snapA = snapshotSeries(runtimeA.series);
  const snapB = snapshotSeries(runtimeB.series);
  assert.deepEqual(snapB, snapA);

  const totalVolumeB = snapB.reduce((acc, bar) => acc + bar.volume, 0);
  assert.equal(totalVolumeB, expectedVolume);

  assert.equal(credits.length, batchCount);
  assert.equal(credits.reduce((a, b) => a + b, 0), totalTicks);

  runtimeA.dispose();
  runtimeB.dispose();
});

test("#432: firstSeq gap emits ingress-gap diagnostic and stale generation batch is ignored without credit", () => {
  const mainPorts = makePortPair();
  const ingressPorts = makePortPair();
  const diagnostics = [];
  const credits = [];

  const runtime = new ChartWorkerPanelRuntime({
    panelId: "p-432-gap",
    marketId: "BTCUSDT",
    intervalMs: 60_000,
    priceStep: 1,
    initialGeneration: 2,
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvas(),
  });
  runtime.attachPorts({ mainPort: mainPorts.portB, ingressPort: ingressPorts.portB });

  const bridge = new WorkerChartHostBridge({
    panelId: "p-432-gap",
    marketId: "BTCUSDT",
    onDiagnostic: (payload) => diagnostics.push(payload),
  });
  bridge.attachPorts({ mainPort: mainPorts.portA, ingressPort: ingressPorts.portA });

  ingressPorts.portA.addEventListener("message", ({ data }) => {
    if (data?.kind === "ingress:credit") {
      credits.push(data);
    }
  });

  // Stale generation (generation: 1 < 2): must be ignored, never applied, never credited
  const staleBuffer = packTicks([{ timestamp: 1_700_000_000_000, price: 100, size: 5, side: "buy" }]);
  ingressPorts.portA.postMessage({
    channel: "ingress",
    kind: "ingress:ticks",
    panelId: "p-432-gap",
    marketId: "BTCUSDT",
    generation: 1,
    seq: 1,
    revision: 1,
    payload: { buffer: staleBuffer, count: 1, firstSeq: 1, schema: 1 },
  });
  assert.equal(runtime.series.length, 0);
  assert.equal(credits.length, 0);

  // Batch 1 (generation: 2, firstSeq: 1, count: 2)
  const buf1 = packTicks([
    { timestamp: 1_700_000_000_000, price: 100, size: 2, side: "buy" },
    { timestamp: 1_700_000_000_010, price: 101, size: 3, side: "sell" },
  ]);
  ingressPorts.portA.postMessage({
    channel: "ingress",
    kind: "ingress:ticks",
    panelId: "p-432-gap",
    marketId: "BTCUSDT",
    generation: 2,
    seq: 2,
    revision: 1,
    payload: { buffer: buf1, count: 2, firstSeq: 1, schema: 1 },
  });
  assert.equal(diagnostics.length, 0);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].payload.granted, 2);

  // Batch 2 with gap (expectedSeq: 3, receivedSeq: 6 => gap: 3)
  const buf2 = packTicks([
    { timestamp: 1_700_000_000_020, price: 102, size: 4, side: "buy" },
  ]);
  ingressPorts.portA.postMessage({
    channel: "ingress",
    kind: "ingress:ticks",
    panelId: "p-432-gap",
    marketId: "BTCUSDT",
    generation: 2,
    seq: 3,
    revision: 1,
    payload: { buffer: buf2, count: 1, firstSeq: 6, schema: 1 },
  });
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    type: "ingress-gap",
    expectedSeq: 3,
    receivedSeq: 6,
    gap: 3,
  });
  assert.equal(credits.length, 2);
  assert.equal(credits[1].payload.granted, 1);

  runtime.dispose();
  bridge.dispose();
});

test("#432: BoundedWorkerPortQueue evicts singular ingress:tick on overflow but never drops ingress:ticks", () => {
  const queue = new BoundedWorkerPortQueue({ maxSize: 2, initialCredits: 10, initialGeneration: 1 });
  const batchBuf = new ArrayBuffer(32);

  queue.enqueue({
    channel: "ingress",
    kind: "ingress:ticks",
    panelId: "p1",
    marketId: "BTCUSDT",
    generation: 1,
    seq: 1,
    revision: 1,
    payload: { buffer: batchBuf, count: 1, firstSeq: 1, schema: 1 },
  });
  queue.enqueue({
    channel: "ingress",
    kind: "ingress:tick",
    panelId: "p1",
    marketId: "BTCUSDT",
    generation: 1,
    seq: 2,
    revision: 1,
    payload: { timestamp: 1000, price: 100, size: 1, side: "buy" },
  });
  queue.enqueue({
    channel: "ingress",
    kind: "ingress:ticks",
    panelId: "p1",
    marketId: "BTCUSDT",
    generation: 1,
    seq: 3,
    revision: 1,
    payload: { buffer: batchBuf, count: 1, firstSeq: 2, schema: 1 },
  });

  const drained = queue.drain(10, true);
  assert.equal(drained.length, 2);
  assert.equal(drained[0].kind, "ingress:ticks");
  assert.equal(drained[1].kind, "ingress:ticks");
});
