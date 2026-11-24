import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state = (value) => value;

const { TypedArrayPool } = await import("../dist/core/cache/scratchPool.js");
const {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} = await import("../dist/core/performanceTelemetry.js");
const {
  buildPixelCandleBuckets,
  buildPixelCellBuckets,
} = await import("../dist/core/render/chartLod.js");
const { FootprintRenderer } = await import("../dist/core/render/footprintRenderer.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { View } = await import("../dist/core/engine/view.js");
const { settings } = await import("../dist/core/settings.js");

const T0 = Date.UTC(2024, 0, 1);

function makeSpySurface() {
  const quads = [];
  const sink = {
    rect(x, y, w, h, color) {
      quads.push({ x, y, w, h, r: color.r, g: color.g, b: color.b, a: color.a });
    },
  };
  const surface = {
    kind: "canvas2d",
    canvas: { width: 400, height: 200 },
    beginFrame() {
      quads.length = 0;
      return {
        quads: sink,
        flushQuads() {},
        end() {},
      };
    },
    resize() {},
    requestCapture: async () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
    onLost: () => () => {},
    dispose() {},
  };
  return { surface, quads };
}

function makeConfig(overrides = {}) {
  return {
    ...settings,
    chartType: "footprint",
    candles: true,
    heat: true,
    poc: true,
    stackedImbalance: true,
    cellNumbers: false,
    ...overrides,
  };
}

test("#284: TypedArrayPool hit/alloc/evict/dispose and telemetry counters", () => {
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  try {
    const f32Pool = new TypedArrayPool(Float32Array, { maxEntries: 2, maxBytes: 128 });
    const u32Pool = new TypedArrayPool(Uint32Array, { maxEntries: 4, maxBytes: 256 });
    const u8Pool = new TypedArrayPool(Uint8Array, { maxEntries: 4, maxBytes: 256 });

    const lease1 = f32Pool.acquire(8); // 32 bytes -> alloc
    assert.equal(lease1.state, "leased");
    assert.equal(lease1.view.length, 8);
    lease1.view[0] = 42.5;
    lease1.release();
    assert.equal(lease1.state, "returned");
    assert.equal(f32Pool.pooledEntries, 1);
    assert.equal(f32Pool.pooledBytes, 32);

    const lease2 = f32Pool.acquire(4); // 16 bytes -> hit on 32-byte buffer
    assert.equal(lease2.view.length, 4);
    assert.equal(lease2.view[0], 42.5);
    assert.equal(f32Pool.pooledEntries, 0);
    lease2.release();

    // Fill maxEntries=2 and trigger eviction on 3rd distinct buffer
    const a = f32Pool.acquire(16); // 64 bytes -> alloc
    const b = f32Pool.acquire(16); // 64 bytes -> alloc
    const c = f32Pool.acquire(16); // 64 bytes -> alloc
    a.release(); // 64 bytes
    b.release(); // 128 bytes (2 entries)
    c.release(); // evicts a (entries) + b (bytes) to stay <= 128 bytes
    assert.ok(f32Pool.pooledEntries <= 2);
    assert.ok(f32Pool.pooledBytes <= 128);

    // Oversized buffer (> maxBytes=128) is immediately evicted on release
    const huge = f32Pool.acquire(64); // 256 bytes -> alloc
    huge.release();
    assert.ok(f32Pool.pooledBytes <= 128);

    const u32Lease = u32Pool.acquire(4);
    u32Lease.view[0] = 123456;
    u32Lease.release();
    assert.equal(u32Pool.pooledEntries, 1);

    const u8Lease = u8Pool.acquire(16);
    u8Lease.view[0] = 255;
    u8Lease.release();
    assert.equal(u8Pool.pooledEntries, 1);

    const snap = snapshotPerformanceTelemetry();
    assert.equal(snap.counters["memory.pool.hit"], 1);
    assert.equal(snap.counters["memory.pool.alloc"], 7);
    assert.ok((snap.counters["memory.pool.evict"] ?? 0) >= 2);

    // dispose clears pooled buffers and marks active leases disposed
    const active = f32Pool.acquire(4);
    f32Pool.dispose();
    assert.equal(f32Pool.isDisposed, true);
    assert.equal(f32Pool.pooledEntries, 0);
    assert.equal(f32Pool.pooledBytes, 0);
    assert.equal(active.state, "disposed");
    assert.throws(() => active.view, /disposed/);
    assert.throws(() => active.release(), /disposed/);
    assert.throws(() => f32Pool.acquire(4), /disposed/);

    u32Pool.dispose();
    u8Pool.dispose();
  } finally {
    resetPerformanceTelemetry();
    configurePerformanceTelemetry({ enabled: false });
  }
});

test("#284: ScratchBufferLease double-free, detached-buffer, and worker transfer guards", () => {
  const pool = new TypedArrayPool(Float32Array, { maxEntries: 4, maxBytes: 1024 });

  // Double-free guard
  const lease = pool.acquire(16);
  lease.release();
  assert.throws(() => lease.release(), /already returned/);
  assert.throws(() => pool.release(lease), /already returned/);
  assert.throws(() => lease.view, /returned/);

  // Worker transfer detachForTransfer() + recycleReturnedBuffer()
  const transferLease = pool.acquire(16);
  transferLease.view[0] = 99;
  const rawBuffer = transferLease.detachForTransfer();
  assert.equal(transferLease.state, "detached");
  assert.equal(pool.activeLeaseCount, 0);
  assert.throws(() => transferLease.view, /detached/);
  assert.throws(() => transferLease.release(), /detached/);
  assert.throws(() => transferLease.detachForTransfer(), /detached/);

  // Actually transfer the ArrayBuffer via structuredClone to simulate worker postMessage
  const workerCopy = structuredClone(rawBuffer, { transfer: [rawBuffer] });
  assert.equal(rawBuffer.byteLength, 0);
  assert.throws(() => pool.recycleReturnedBuffer(rawBuffer), /detached/);

  // Re-admit returned buffer from worker
  assert.equal(pool.recycleReturnedBuffer(workerCopy), true);
  assert.equal(pool.pooledEntries, 1);

  const reused = pool.acquire(16);
  assert.equal(reused.view[0], 99);
  reused.release();

  // External detachment while still "leased" is caught on view access and release
  const externalLease = pool.acquire(8);
  const externalBuf = externalLease.view.buffer;
  structuredClone(externalBuf, { transfer: [externalBuf] });
  assert.throws(() => externalLease.view, /detached/);
  assert.equal(externalLease.state, "detached");

  pool.dispose();
});

test("#284: buildPixelCandleBuckets and buildPixelCellBuckets scratch reuse has bit-exact parity", () => {
  const bars = Array.from({ length: 120 }, (_, i) => ({
    open: 100 + i * 0.1,
    high: 105 + i * 0.15,
    low: 95 + i * 0.05,
    close: 101 + (i % 7) - 3,
  }));
  const xOfIndex = (i) => i * 0.25;

  const expectedCandles = buildPixelCandleBuckets(0, bars.length, (i) => bars[i], xOfIndex);
  const scratchCandles = [];
  const reusedCandles1 = buildPixelCandleBuckets(0, bars.length, (i) => bars[i], xOfIndex, scratchCandles);
  assert.equal(reusedCandles1, scratchCandles);
  assert.deepEqual(reusedCandles1, expectedCandles);

  // Shrink on subsequent call with fewer bars
  const expectedShort = buildPixelCandleBuckets(10, 20, (i) => bars[i], xOfIndex);
  const reusedCandles2 = buildPixelCandleBuckets(10, 20, (i) => bars[i], xOfIndex, scratchCandles);
  assert.equal(reusedCandles2, scratchCandles);
  assert.deepEqual(reusedCandles2, expectedShort);

  const cells = Array.from({ length: 200 }, (_, i) => ({
    priceBin: 100 + i * 0.5,
    buyVol: 10 + (i % 11),
    sellVol: 5 + (i % 7),
  }));
  const yOfPrice = (p) => 200 - (p - 100) * 0.4;

  const expectedCells = buildPixelCellBuckets(cells, 0.5, yOfPrice);
  const scratchCells = [];
  const reusedCells1 = buildPixelCellBuckets(cells, 0.5, yOfPrice, scratchCells);
  assert.equal(reusedCells1, scratchCells);
  assert.deepEqual(reusedCells1, expectedCells);

  const subset = cells.slice(0, 20);
  const expectedCellsShort = buildPixelCellBuckets(subset, 0.5, yOfPrice);
  const reusedCells2 = buildPixelCellBuckets(subset, 0.5, yOfPrice, scratchCells);
  assert.equal(reusedCells2, scratchCells);
  assert.deepEqual(reusedCells2, expectedCellsShort);
});

test("#284: FootprintRenderer repeated live-tail and pan frames preserve output parity and snapshot immutability", () => {
  const prevGrid = settings.grid;
  settings.grid = false;

  try {
    const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10 });
    const rawBars = [];
    for (let b = 0; b < 30; b++) {
      const cells = new Map([
        [100, { priceBin: 100, buyVol: 2, sellVol: 10, count: 2, buyCount: 1, sellCount: 1 }],
        [110, { priceBin: 110, buyVol: 80, sellVol: 2, count: 3, buyCount: 2, sellCount: 1 }],
        [120, { priceBin: 120, buyVol: 90, sellVol: 2, count: 3, buyCount: 2, sellCount: 1 }],
        [130, { priceBin: 130, buyVol: 100, sellVol: 2, count: 3, buyCount: 2, sellCount: 1 }],
        [140, { priceBin: 140, buyVol: 110, sellVol: 2, count: 3, buyCount: 2, sellCount: 1 }],
      ]);
      rawBars.push({
        startTime: T0 + b * 60_000,
        open: 100,
        high: 150,
        low: 100,
        close: 145,
        volume: 400,
        delta: 364,
        count: 14,
        cells,
        hasRef: true,
        cellRevision: 1,
      });
    }
    series.loadBars(rawBars);

    // Freeze bar 0 cells snapshot to assert FootprintRenderer never mutates FootprintBar snapshots
    const bar0 = series.at(0);
    const bar0Snapshot = [...bar0.cells.entries()].map(([k, v]) => [k, { ...v }]);

    const { surface: refSurface, quads: refQuads } = makeSpySurface();
    const { surface: reuseSurface, quads: reuseQuads } = makeSpySurface();
    const refRenderer = new FootprintRenderer(refSurface);
    const reuseRenderer = new FootprintRenderer(reuseSurface);
    const cfg = makeConfig();
    refRenderer.setChartConfig(cfg);
    reuseRenderer.setChartConfig(cfg);

    const view = new View();
    view.area = { left: 0, top: 0, width: 400, height: 200 };
    view.colWidth = 40;
    view.offsetX = 0;
    view.priceTop = 160;
    view.pricePerPx = 0.4;
    view.pixelRatio = 1;

    // Frame 1: standard footprint
    refRenderer.render(view, series);
    reuseRenderer.render(view, series);
    assert.deepEqual(reuseQuads, refQuads);

    // Frame 2: live-tail mutation on last bar + pan
    const tail = series.at(series.length - 1);
    const prevCell = tail.cells.get(140);
    tail.cells.set(140, { ...prevCell, buyVol: prevCell.buyVol + 50, count: prevCell.count + 1 });
    tail.cellRevision = (tail.cellRevision ?? 0) + 1;
    view.offsetX = -120;

    refRenderer.render(view, series);
    reuseRenderer.render(view, series);
    assert.deepEqual(reuseQuads, refQuads);

    // Frame 3: sub-pixel pixel-bucket LOD
    view.colWidth = 0.5;
    view.offsetX = 0;
    refRenderer.render(view, series);
    reuseRenderer.render(view, series);
    assert.deepEqual(reuseQuads, refQuads);

    // Frame 4: sub-pixel merged-cells vertical LOD
    view.colWidth = 20;
    view.pricePerPx = 8;
    refRenderer.render(view, series);
    reuseRenderer.render(view, series);
    assert.deepEqual(reuseQuads, refQuads);

    // Verify bar0 snapshot remained completely untouched
    const bar0After = [...bar0.cells.entries()].map(([k, v]) => [k, { ...v }]);
    assert.deepEqual(bar0After, bar0Snapshot);

    reuseRenderer.clearScratch();
    reuseRenderer.dispose();
    refRenderer.dispose();
  } finally {
    settings.grid = prevGrid;
  }
});
