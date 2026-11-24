import test from "node:test";
import assert from "node:assert/strict";

import {
  BAR_RECORD_BYTES,
  CELL_RECORD_BYTES,
  WebGpuNativeScenePipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeScenePipeline.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";

const T0 = Date.UTC(2024, 0, 1);
const MARKET = "BINANCE_FUTURES:btcusdt";

function makeFakeNativeWebGpuDevice(format = "rgba8unorm") {
  const buffers = [];
  const writtenBuffers = [];
  const device = {
    format,
    features: new Set(),
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    addEventListener() {},
    removeEventListener() {},
    createShaderModule(desc) { return { label: desc.label, code: desc.code }; },
    createBuffer(desc) {
      const data = new Uint8Array(desc.size);
      const buf = {
        label: desc.label,
        size: desc.size,
        usage: desc.usage,
        data,
        destroyed: false,
        destroy() { this.destroyed = true; },
      };
      buffers.push(buf);
      return buf;
    },
    createQuerySet(desc) { return { label: desc.label, destroy() {} }; },
    createBindGroupLayout(desc) { return { label: desc.label, entries: desc.entries }; },
    createBindGroup(desc) { return { label: desc.label, entries: desc.entries }; },
    createPipelineLayout(desc) { return { label: desc.label }; },
    createComputePipeline(desc) { return { label: desc.label }; },
    createRenderPipeline(desc) { return { label: desc.label }; },
    queue: {
      writeBuffer(buffer, dstOffset, src, srcOffset = 0, byteLength = src.byteLength) {
        const bytes = new Uint8Array(
          src instanceof ArrayBuffer ? src : src.buffer,
          (src instanceof ArrayBuffer ? 0 : src.byteOffset) + srcOffset,
          byteLength,
        );
        buffer.data.set(bytes, dstOffset);
        writtenBuffers.push({ label: buffer.label, dstOffset, byteLength });
      },
      submit() {},
    },
    _buffers: buffers,
    _writtenBuffers: writtenBuffers,
  };
  return device;
}

function makeScene(series, drawFootprint) {
  return {
    series,
    view: {
      area: { left: 0, top: 0, width: 400, height: 200 },
      offsetX: 10,
      colWidth: 40,
      priceTop: 150,
      pricePerPx: 0.5,
      candleWidth: 12,
    },
    lodMode: "standard",
    drawCandles: true,
    drawFootprint,
    drawHeat: drawFootprint,
    drawPoc: false,
    candleStyle: drawFootprint ? "strip" : "full",
  };
}

function makeDenseSeries(cellCount = 20) {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, referenceMarket: MARKET });
  const cells = new Map();
  for (let i = 0; i < cellCount; i++) {
    const priceBin = 100 + i;
    cells.set(priceBin, { priceBin, buyVol: 10, sellVol: 5, count: 2, buyCount: 1, sellCount: 1 });
  }
  series.loadBars([{
    startTime: T0,
    open: 100,
    high: 100 + cellCount,
    low: 100,
    close: 105,
    volume: cellCount * 15,
    delta: cellCount * 5,
    count: cellCount * 2,
    cells,
    hasRef: true,
    cellRevision: 1,
  }]);
  return series;
}

function sumBytesForLabel(writes, label) {
  return writes.filter((w) => w.label === label).reduce((sum, w) => sum + w.byteLength, 0);
}

test("#322: candlestick mode uploads 0 B to cellBuffer and syncs fully when switched to footprint", () => {
  const series = makeDenseSeries(50);
  const device = makeFakeNativeWebGpuDevice();
  const pipeline = new WebGpuNativeScenePipeline(device, "rgba8unorm");

  // Initial candlestick frame
  pipeline.prepareFrame(makeScene(series, false), 400, 200);
  assert.equal(sumBytesForLabel(device._writtenBuffers, "NativeSceneCellStorage"), 0);
  assert.equal(sumBytesForLabel(device._writtenBuffers, "NativeSceneBarStorage"), BAR_RECORD_BYTES);

  // Live trade on open candle while still in candlestick mode -> still 0 B cellBuffer upload
  device._writtenBuffers.length = 0;
  series.addTrade({
    time: T0 + 10_000,
    price: 110,
    qty: 5,
    isBuy: true,
    liquidation: false,
    market: MARKET,
    source: "live",
  });
  pipeline.prepareFrame(makeScene(series, false), 400, 200);
  assert.equal(sumBytesForLabel(device._writtenBuffers, "NativeSceneCellStorage"), 0);

  // Bar rollover in candlestick mode -> still 0 B cellBuffer upload
  device._writtenBuffers.length = 0;
  series.addTrade({
    time: T0 + 65_000,
    price: 112,
    qty: 3,
    isBuy: false,
    liquidation: false,
    market: MARKET,
    source: "live",
  });
  pipeline.prepareFrame(makeScene(series, false), 400, 200);
  assert.equal(sumBytesForLabel(device._writtenBuffers, "NativeSceneCellStorage"), 0);

  // Switch to footprint mode -> first frame must upload all cells
  device._writtenBuffers.length = 0;
  pipeline.prepareFrame(makeScene(series, true), 400, 200);
  const uploadedCellsBytes = sumBytesForLabel(device._writtenBuffers, "NativeSceneCellStorage");
  assert.equal(uploadedCellsBytes, 51 * CELL_RECORD_BYTES);

  pipeline.dispose();
});

test("#322: single existing level update in footprint mode uploads only 16 B instead of full bar cells", () => {
  const series = makeDenseSeries(200);
  const device = makeFakeNativeWebGpuDevice();
  const pipeline = new WebGpuNativeScenePipeline(device, "rgba8unorm");

  // Initial full footprint sync
  pipeline.prepareFrame(makeScene(series, true), 400, 200);
  device._writtenBuffers.length = 0;

  // Trade at existing bin 105 (index 5 in sorted order), same close=105 -> OHLC unchanged
  series.addTrade({
    time: T0 + 15_000,
    price: 105,
    qty: 25,
    isBuy: true,
    liquidation: false,
    market: MARKET,
    source: "live",
  });
  pipeline.prepareFrame(makeScene(series, true), 400, 200);

  const cellWrites = device._writtenBuffers.filter((w) => w.label === "NativeSceneCellStorage");
  const barWrites = device._writtenBuffers.filter((w) => w.label === "NativeSceneBarStorage");
  assert.equal(cellWrites.length, 1, "only the mutated cell record should be written");
  assert.equal(cellWrites[0].byteLength, CELL_RECORD_BYTES);
  assert.equal(cellWrites[0].dstOffset, 5 * CELL_RECORD_BYTES);
  assert.equal(barWrites.length, 0, "barBuffer should not be rewritten when OHLC is unchanged");

  // Adding a brand-new price bin (350) triggers full tail cell sync cleanly
  device._writtenBuffers.length = 0;
  series.addTrade({
    time: T0 + 20_000,
    price: 350,
    qty: 10,
    isBuy: true,
    liquidation: false,
    market: MARKET,
    source: "live",
  });
  pipeline.prepareFrame(makeScene(series, true), 400, 200);
  assert.equal(sumBytesForLabel(device._writtenBuffers, "NativeSceneCellStorage"), 201 * CELL_RECORD_BYTES);

  pipeline.dispose();
});
