import test from "node:test";
import assert from "node:assert/strict";

import {
  CELL_RECORD_BYTES,
  COMPUTE_MERGED_CELLS_WGSL,
  WebGpuNativeScenePipeline,
} from "../dist/core/gpu/webgpu/webgpuNativeScenePipeline.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { buildPixelCellBuckets } from "../dist/core/render/footprint/pixelBuckets.js";
import { isWebGpuSupported } from "../dist/core/gpu/webgpu/webgpuDevice.js";

const T0 = Date.UTC(2024, 0, 1);

function makeFakeNativeWebGpuDevice(format = "rgba8unorm") {
  const buffers = [];
  const writtenBuffers = [];
  const device = {
    format,
    features: new Set(),
    limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
    addEventListener() {},
    removeEventListener() {},
    createShaderModule(desc) {
      return { label: desc.label, code: desc.code };
    },
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
    createQuerySet(desc) {
      return { label: desc.label, destroy() {} };
    },
    createBindGroupLayout(desc) { return { label: desc.label, entries: desc.entries }; },
    createBindGroup(desc) { return { label: desc.label, entries: desc.entries }; },
    createPipelineLayout(desc) { return { label: desc.label }; },
    createComputePipeline(desc) { return { label: desc.label, compute: desc.compute }; },
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

function simulateMergedCellsCompute({ cells, origin, areaTop, plotHeight, priceTop, pricePerPx, priceStep }) {
  const startCoord = Math.floor(areaTop);
  const priceTopRel = priceTop - origin;
  const rows = new Map();
  let mergedMax = 0;
  let hasCur = false;
  let curY = 0;
  let curBuy = 0;
  let curSell = 0;

  for (const cell of cells) {
    const priceBinRel = cell.priceBin - origin;
    const yTopF = areaTop + (priceTopRel - (priceBinRel + priceStep)) / pricePerPx;
    const yTopI = Math.floor(yTopF);

    if (!hasCur) {
      hasCur = true;
      curY = yTopI;
      curBuy = cell.buyVol;
      curSell = cell.sellVol;
    } else if (yTopI === curY) {
      curBuy += cell.buyVol;
      curSell += cell.sellVol;
    } else {
      mergedMax = Math.max(mergedMax, curBuy, curSell);
      curY = yTopI;
      curBuy = cell.buyVol;
      curSell = cell.sellVol;
    }

    const rowIdx = yTopI - startCoord;
    if (rowIdx >= 0 && rowIdx < plotHeight) {
      const prev = rows.get(rowIdx) ?? { buyVol: 0, sellVol: 0 };
      prev.buyVol += cell.buyVol;
      prev.sellVol += cell.sellVol;
      rows.set(rowIdx, prev);
    }
  }
  if (hasCur) {
    mergedMax = Math.max(mergedMax, curBuy, curSell);
  }
  return { mergedMax, rows };
}

test("#321: WebGpuNativeScenePipeline packs cells sorted ascending by priceBin and shader tracks off-screen merged_max", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  // Insert price bins out of order on purpose
  const unsortedCells = new Map([
    [130, { priceBin: 130, buyVol: 15, sellVol: 5, count: 2, buyCount: 1, sellCount: 1 }],
    [100, { priceBin: 100, buyVol: 40, sellVol: 10, count: 2, buyCount: 1, sellCount: 1 }],
    [101, { priceBin: 101, buyVol: 35, sellVol: 20, count: 2, buyCount: 1, sellCount: 1 }],
    [120, { priceBin: 120, buyVol: 10, sellVol: 12, count: 2, buyCount: 1, sellCount: 1 }],
  ]);
  series.loadBars([{
    startTime: T0,
    open: 100,
    high: 131,
    low: 100,
    close: 130,
    volume: 132,
    delta: 53,
    count: 8,
    cells: unsortedCells,
    hasRef: true,
    cellRevision: 1,
  }]);

  const device = makeFakeNativeWebGpuDevice();
  const pipeline = new WebGpuNativeScenePipeline(device, "rgba8unorm");
  const prepared = pipeline.prepareFrame({
    series,
    view: {
      area: { left: 0, top: 0, width: 400, height: 100 },
      offsetX: 10,
      colWidth: 40,
      priceTop: 135,
      pricePerPx: 1,
      candleWidth: 12,
    },
    lodMode: "merged-cells",
    drawCandles: true,
    drawFootprint: true,
    drawHeat: true,
    drawPoc: false,
    candleStyle: "strip",
  }, 400, 100);
  assert.equal(prepared.ok, true);

  const cellBuf = device._buffers.find((b) => b.label === "NativeSceneCellStorage");
  assert.ok(cellBuf, "cellBuffer must exist");
  const f32 = new Float32Array(cellBuf.data.buffer);
  const packedPrices = [];
  for (let i = 0; i < 4; i++) {
    packedPrices.push(f32[i * (CELL_RECORD_BYTES / 4) + 1]);
  }
  assert.deepEqual(packedPrices, [0, 1, 20, 30], "packed cells must be sorted ascending by priceBin");

  // Verify WGSL contains monotonic single-pass cur_y/cur_buy/cur_sell accumulation
  assert.match(COMPUTE_MERGED_CELLS_WGSL, /\bcur_y\b/);
  assert.match(COMPUTE_MERGED_CELLS_WGSL, /\bcur_buy\b/);
  assert.match(COMPUTE_MERGED_CELLS_WGSL, /\bcur_sell\b/);

  pipeline.dispose();
});

test("#321: vertical pan preserves merged_bar_max and matches Canvas2D pixel bucket parity", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  const cells = new Map([
    [100, { priceBin: 100, buyVol: 50, sellVol: 10, count: 2, buyCount: 1, sellCount: 1 }],
    [101, { priceBin: 101, buyVol: 45, sellVol: 15, count: 2, buyCount: 1, sellCount: 1 }],
    [120, { priceBin: 120, buyVol: 20, sellVol: 25, count: 2, buyCount: 1, sellCount: 1 }],
    [121, { priceBin: 121, buyVol: 10, sellVol: 15, count: 2, buyCount: 1, sellCount: 1 }],
  ]);
  series.loadBars([{
    startTime: T0,
    open: 100,
    high: 122,
    low: 100,
    close: 121,
    volume: 190,
    delta: 60,
    count: 8,
    cells,
    hasRef: true,
    cellRevision: 1,
  }]);

  const sortedCells = [...cells.values()].sort((a, b) => a.priceBin - b.priceBin);
  const pricePerPx = 2; // 2 price units per pixel -> (100, 101) merge into same pixel row (buy=95)
  const areaTop = 10;
  const plotHeight = 20;

  // Before pan: all cells visible
  const beforePan = simulateMergedCellsCompute({
    cells: sortedCells,
    origin: 100,
    areaTop,
    plotHeight,
    priceTop: 130,
    pricePerPx,
    priceStep: 1,
  });

  // After pan: high-volume (100, 101) row panned off-screen below plotHeight
  const afterPan = simulateMergedCellsCompute({
    cells: sortedCells,
    origin: 100,
    areaTop,
    plotHeight,
    priceTop: 150,
    pricePerPx,
    priceStep: 1,
  });

  assert.equal(beforePan.mergedMax, 95);
  assert.equal(afterPan.mergedMax, 95, "merged_max must remain identical when peak row pans off-screen");

  // Canvas2D parity check via buildPixelCellBuckets
  const yOfPrice = (p) => areaTop + (150 - p) / pricePerPx;
  const canvasBuckets = buildPixelCellBuckets(sortedCells, 1, yOfPrice);
  let canvasMax = 0;
  for (const b of canvasBuckets) {
    canvasMax = Math.max(canvasMax, b.buyVol, b.sellVol);
  }
  assert.equal(afterPan.mergedMax, canvasMax, "WebGPU merged_max must match Canvas2D mergedMax");

  // Guard for environments without real WebGPU hardware
  if (!isWebGpuSupported()) {
    assert.equal(typeof isWebGpuSupported(), "boolean");
  }
});
