import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_PACKED_V1_BAR_STRIDE,
  HISTORY_PACKED_V2_BAR_STRIDE,
  HISTORY_PACKED_V2_CELL_STRIDE,
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

function packSchema2(historyBars) {
  const barsBuf = new ArrayBuffer(historyBars.length * HISTORY_PACKED_V2_BAR_STRIDE * Float64Array.BYTES_PER_ELEMENT);
  const barsView = new Float64Array(barsBuf);
  let totalCells = 0;
  for (let i = 0; i < historyBars.length; i++) {
    const b = historyBars[i];
    const base = i * HISTORY_PACKED_V2_BAR_STRIDE;
    barsView[base] = b.time;
    barsView[base + 1] = b.open;
    barsView[base + 2] = b.high;
    barsView[base + 3] = b.low;
    barsView[base + 4] = b.close;
    barsView[base + 5] = b.volume;
    barsView[base + 6] = b.delta ?? 0;
    barsView[base + 7] = b.count ?? 1;
    totalCells += b.cells?.length ?? 0;
  }

  const cellsBuf = new ArrayBuffer(totalCells * HISTORY_PACKED_V2_CELL_STRIDE * Float64Array.BYTES_PER_ELEMENT);
  const cellsView = new Float64Array(cellsBuf);
  let cOffset = 0;
  for (let i = 0; i < historyBars.length; i++) {
    const cells = historyBars[i].cells ?? [];
    for (const [price, buyVol, sellVol] of cells) {
      cellsView[cOffset] = i;
      cellsView[cOffset + 1] = price;
      cellsView[cOffset + 2] = sellVol; // bidVolume
      cellsView[cOffset + 3] = buyVol; // askVolume
      cOffset += HISTORY_PACKED_V2_CELL_STRIDE;
    }
  }

  return { schema: 2, bars: barsBuf, cells: cellsBuf };
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

test("#433: object history:chunk and packed schema:2 produce identical FootprintBar arrays and emit matching history:ack", () => {
  const sampleBars = [
    {
      time: 1_700_000_040_000,
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 25,
      delta: 7,
      count: 14,
      cells: [
        [100, 5, 2],
        [102, 8, 4],
        [103, 3, 3],
      ],
    },
    {
      time: 1_700_000_100_000,
      open: 103,
      high: 106,
      low: 101,
      close: 102,
      volume: 18,
      delta: -4,
      count: 9,
      cells: [
        [101, 2, 6],
        [104, 5, 5],
      ],
    },
  ];

  // Object path
  const mainObj = makePortPair();
  const histObj = makePortPair();
  const rtObj = new ChartWorkerPanelRuntime({
    panelId: "p-433-obj",
    marketId: "BTCUSDT",
    intervalMs: 60_000,
    priceStep: 1,
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvas(),
  });
  rtObj.attachPorts({ mainPort: mainObj.portB, historyPort: histObj.portB });

  // Schema 2 path
  const mainS2 = makePortPair();
  const histS2 = makePortPair();
  const rtS2 = new ChartWorkerPanelRuntime({
    panelId: "p-433-s2",
    marketId: "BTCUSDT",
    intervalMs: 60_000,
    priceStep: 1,
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvas(),
  });
  rtS2.attachPorts({ mainPort: mainS2.portB, historyPort: histS2.portB });

  const acks = [];
  histS2.portA.addEventListener("message", ({ data }) => {
    if (data?.kind === "history:ack") {
      acks.push(data);
    }
  });

  histObj.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "p-433-obj",
    marketId: "BTCUSDT",
    generation: 0,
    seq: 11,
    revision: 1,
    payload: {
      timeframe: "1m",
      bars: sampleBars,
      hasMore: false,
      chunkIndex: 0,
    },
  });

  const packed = packSchema2(sampleBars);
  histS2.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "p-433-s2",
    marketId: "BTCUSDT",
    generation: 0,
    seq: 42,
    revision: 1,
    transfer: [packed.bars, packed.cells],
    payload: {
      timeframe: "1m",
      packed,
      hasMore: false,
      chunkIndex: 0,
    },
  });

  const snapObj = snapshotSeries(rtObj.series);
  const snapS2 = snapshotSeries(rtS2.series);
  assert.deepEqual(snapS2, snapObj);
  assert.equal(snapS2[0].delta, 7);
  assert.equal(snapS2[0].count, 14);
  assert.equal(snapS2[0].cells.length, 3);
  assert.equal(snapS2[1].delta, -4);
  assert.equal(snapS2[1].count, 9);
  assert.equal(snapS2[1].cells.length, 2);

  assert.equal(acks.length, 1);
  assert.equal(acks[0].channel, "history");
  assert.equal(acks[0].kind, "history:ack");
  assert.equal(acks[0].panelId, "p-433-s2");
  assert.equal(acks[0].marketId, "BTCUSDT");
  assert.equal(acks[0].generation, 0);
  assert.deepEqual(acks[0].payload, { ackedSeq: 42 });

  rtObj.dispose();
  rtS2.dispose();
});

test("#433: schema 1 (stride 6) remains backward-compatible and stale/aborted/disposed chunks emit no ack", () => {
  const mainPorts = makePortPair();
  const histPorts = makePortPair();
  const acks = [];

  const runtime = new ChartWorkerPanelRuntime({
    panelId: "p-433-guard",
    marketId: "BTCUSDT",
    intervalMs: 60_000,
    priceStep: 1,
    initialGeneration: 2,
    backendPreference: "canvas2d",
    createScratchCanvas: () => makeMockCanvas(),
  });
  runtime.attachPorts({ mainPort: mainPorts.portB, historyPort: histPorts.portB });

  const bridge = new WorkerChartHostBridge({
    panelId: "p-433-guard",
    marketId: "BTCUSDT",
  });
  bridge.attachPorts({ mainPort: mainPorts.portA, historyPort: histPorts.portA });

  histPorts.portA.addEventListener("message", ({ data }) => {
    if (data?.kind === "history:ack") {
      acks.push(data);
    }
  });

  // Stale generation (1 < 2) -> dropped, no ack
  const stalePacked = packSchema2([
    { time: 1_700_000_040_000, open: 10, high: 11, low: 9, close: 10, volume: 5, delta: 1, count: 2 },
  ]);
  histPorts.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "p-433-guard",
    marketId: "BTCUSDT",
    generation: 1,
    seq: 1,
    revision: 1,
    payload: { timeframe: "1m", packed: stalePacked, hasMore: false, chunkIndex: 0 },
  });
  assert.equal(runtime.series.length, 0);
  assert.equal(acks.length, 0);

  // Aborted chunk -> dropped, no ack
  const abortPacked = packSchema2([
    { time: 1_700_000_040_000, open: 10, high: 11, low: 9, close: 10, volume: 5, delta: 1, count: 2 },
  ]);
  histPorts.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "p-433-guard",
    marketId: "BTCUSDT",
    generation: 2,
    seq: 2,
    revision: 1,
    abort: true,
    payload: { timeframe: "1m", packed: abortPacked, hasMore: false, chunkIndex: 0 },
  });
  assert.equal(runtime.series.length, 0);
  assert.equal(acks.length, 0);

  // Schema 1 (stride 6) active generation -> applied and acked
  const v1Buf = new ArrayBuffer(HISTORY_PACKED_V1_BAR_STRIDE * Float64Array.BYTES_PER_ELEMENT);
  const v1View = new Float64Array(v1Buf);
  v1View.set([1_700_000_040_000, 100, 102, 99, 101, 10]);
  histPorts.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "p-433-guard",
    marketId: "BTCUSDT",
    generation: 2,
    seq: 3,
    revision: 1,
    payload: { timeframe: "1m", bars: v1Buf, hasMore: false, chunkIndex: 0 },
  });
  assert.equal(runtime.series.length, 1);
  assert.equal(acks.length, 1);
  assert.deepEqual(acks[0].payload, { ackedSeq: 3 });

  // Disposed panel -> dropped, no ack
  runtime.dispose();
  const afterDisposePacked = packSchema2([
    { time: 1_700_000_100_000, open: 101, high: 103, low: 100, close: 102, volume: 8, delta: 2, count: 3 },
  ]);
  histPorts.portA.postMessage({
    channel: "history",
    kind: "history:chunk",
    panelId: "p-433-guard",
    marketId: "BTCUSDT",
    generation: 2,
    seq: 4,
    revision: 1,
    payload: { timeframe: "1m", packed: afterDisposePacked, hasMore: false, chunkIndex: 1 },
  });
  assert.equal(acks.length, 1);

  bridge.dispose();
});
