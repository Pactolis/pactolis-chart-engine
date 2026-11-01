import test from "node:test";
import assert from "node:assert/strict";

const { View } = await import("../dist/core/engine/view.js");
const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { settings } = await import("../dist/core/settings.js");
const {
  ChartMagnetController,
  MAGNET_SNAP_THRESHOLD_CSS_PX,
} = await import("../dist/features/chart/ChartMagnetController.js");
const {
  ChartHeatmapGpuCoordinator,
} = await import("../dist/features/chart/ChartHeatmapGpuCoordinator.js");
const {
  ChartLevelContextController,
} = await import("../dist/features/chart/ChartLevelContextController.js");

// ---------------------------------------------------------------------------
// 1. ChartMagnetController Tests
// ---------------------------------------------------------------------------

test("ChartMagnetController: snaps to OHLC, POC, and volume profile levels", () => {
  const INTERVAL = 60_000;
  const T = 1_800_000_000_000;

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 50200;
  view.pricePerPx = 1;

  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.loadBars([
    {
      startTime: T,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50050,
      volume: 100,
      delta: 10,
      count: 20,
      cells: new Map([
        [50020, { priceBin: 50020, buyVol: 50, sellVol: 50, count: 10, buyCount: 5, sellCount: 5 }],
      ]),
      hasRef: true,
    },
  ]);

  let hookLabel = "";
  let invalidations = 0;
  const vpLevels = { poc: 50030, vah: 50080, val: 49920 };

  const host = {
    view,
    pipeline: { series },
    state: { market: "BTC-USDT" },
    session: { invalidate: () => { invalidations++; } },
    overlay: { getActiveVolumeProfileLevels: () => vpLevels },
    setHookAttr: (name, val) => {
      if (name === "data-magnet-snap") hookLabel = val;
    },
    analysisContextForChart: () => ({ drawings: null }),
  };

  const controller = new ChartMagnetController(host);
  assert.equal(controller.activeMagnetSnap, null);

  const prevMagnet = settings.magnet;
  const prevMode = settings.magnetMode;
  settings.magnet = true;
  settings.magnetMode = "weak";

  try {
    // 1. Cursor close to Bar High (50100) -> snaps to High
    const highY = view.yOfPrice(50100);
    const snapHigh = controller.screenToDrawingPoint(0, highY + 2);
    assert.equal(snapHigh.price, 50100, "snaps to bar High");
    assert.equal(controller.activeMagnetSnap?.label, "H");
    assert.equal(hookLabel, "H");

    // 2. Cursor close to POC (50020.5) -> snaps to POC
    const pocY = view.yOfPrice(50020.5);
    const snapPoc = controller.screenToDrawingPoint(0, pocY + 1);
    assert.equal(snapPoc.price, 50020.5, "snaps to bar POC");
    assert.equal(controller.activeMagnetSnap?.label, "POC");

    // 3. Clear snap resets state
    controller.clearMagnetSnap();
    assert.equal(controller.activeMagnetSnap, null);
    assert.equal(hookLabel, "");

    // 4. Cursor far away (> MAGNET_SNAP_THRESHOLD_CSS_PX) in weak mode does not snap
    const farY = view.yOfPrice(49500);
    const snapFar = controller.screenToDrawingPoint(0, farY);
    assert.equal(snapFar.price, 49500, "returns raw price when far from levels in weak mode");
    assert.equal(controller.activeMagnetSnap, null);
  } finally {
    settings.magnet = prevMagnet;
    settings.magnetMode = prevMode;
  }
});

test("ChartMagnetController: drawMagnetSnapRing executes without canvas errors", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };

  const host = {
    view,
    pipeline: { series: new FootprintSeries({ intervalMs: 60000, priceStep: 1 }) },
    state: { market: "BTC" },
    analysisContextForChart: () => ({}),
  };
  const controller = new ChartMagnetController(host);

  const calls = [];
  const mockCtx = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    arc: () => calls.push("arc"),
    stroke: () => calls.push("stroke"),
    fill: () => calls.push("fill"),
    roundRect: () => calls.push("roundRect"),
    fillText: () => calls.push("fillText"),
    measureText: () => ({ width: 20 }),
  };

  controller.drawMagnetSnapRing(mockCtx, view, { x: 100, y: 100, label: "POC" });
  assert.ok(calls.includes("save"));
  assert.ok(calls.includes("arc"));
  assert.ok(calls.includes("fillText"));
  assert.ok(calls.includes("restore"));
});

// ---------------------------------------------------------------------------
// 2. ChartHeatmapGpuCoordinator Tests
// ---------------------------------------------------------------------------

test("ChartHeatmapGpuCoordinator: manages lifecycle, lease, and annotation suppression", () => {
  let sessionInvalidated = false;
  let leasedReleased = false;

  const mockLease = {
    release: () => { leasedReleased = true; },
  };

  const mockOverlay = {
    currentDataKey: () => "data-key-1",
    prepareGpuCells: (v, s, range, reserve) => ({
      dataKey: "data-key-1",
      threshold: 10,
      ceiling: 100,
      preparedLease: mockLease,
    }),
  };

  const host = {
    orderbookHeatmap: mockOverlay,
    renderCoordinator: {
      getAnnotationLayerOrder: () => ["orderbook-heatmap", "candles"],
    },
    renderer: {
      visibleRange: () => [0, 10],
    },
    invalidateSession: () => { sessionInvalidated = true; },
  };

  const coordinator = new ChartHeatmapGpuCoordinator(host);
  assert.equal(coordinator.isHeatmapTexturePrototypeEnabled(), false);

  // Toggle prototype
  coordinator.setHeatmapTexturePrototypeEnabled(true);
  assert.equal(coordinator.isHeatmapTexturePrototypeEnabled(), true);
  assert.equal(sessionInvalidated, true);

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 50000;
  view.pricePerPx = 1;

  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  series.loadBars([{ startTime: 0, open: 10, high: 20, low: 5, close: 15, volume: 10, delta: 0, count: 1, cells: new Map() }]);

  // Prepare frame
  const frame = coordinator.prepareHeatmapGpuCells(view, series);
  assert.ok(frame);
  assert.equal(frame.dataKey, "data-key-1");

  // Render without GL latches failure and releases lease
  leasedReleased = false;
  coordinator.renderHeatmapGpuCells(frame, view, series);
  assert.equal(leasedReleased, true, "lease released on render without valid GL");

  // On context loss & restore
  coordinator.onLostContext();
  coordinator.onRestoreContext(null);
  assert.equal(coordinator.getFrame(), null);
  assert.equal(coordinator.getLease(), null);

  // Cleanup
  coordinator.dispose();
});

// ---------------------------------------------------------------------------
// 3. ChartLevelContextController Tests
// ---------------------------------------------------------------------------

test("ChartLevelContextController: nPOC request abortion, settling, and level caching", async () => {
  let invalidated = false;
  let hookUpdated = false;
  let fetchCount = 0;

  const mockServices = {
    fetchNpocSnapshot: async (market, signal) => {
      fetchCount++;
      return {
        levels: [
          { period: "1D", periodStart: 1_700_000_000_000, pocLower: 50100, pocUpper: 50110, age: 1 },
        ],
      };
    },
    getAnalysisContext: (market, shared) => ({
      market,
      previousWeekStrategySettings: { enabled: true, visible: {} },
      previousWeekStrategyLevels: [],
      mondayRangeSettings: { enabled: true, visible: {} },
      mondayRangeLevels: [],
      nakedPocs: [],
      referenceLevels: [],
    }),
    getAnalysisRevisionSnapshot: (market) => ({ revision: 1 }),
    getAutomaticLevelsAsOf: (market, asOf) => ({
      previousWeekStrategyLevels: [{ id: "pw-1", price: 49000 }],
      mondayRangeLevels: [],
      referenceLevels: [],
    }),
  };

  const series = new FootprintSeries({ intervalMs: 60000, priceStep: 1 });
  series.loadBars([{ startTime: 0, open: 10, high: 20, low: 5, close: 15, volume: 10, delta: 0, count: 1, cells: new Map() }]);

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.priceRange = () => ({ minValue: () => 40000, maxValue: () => 60000 });

  const host = {
    state: { market: "BTC-USDT", timeframe: "1h" },
    pipeline: { series },
    view,
    svc: mockServices,
    session: { invalidate: () => { invalidated = true; } },
    replayCoordinator: { isActive: () => false, getSnapshot: () => null },
    isDisposed: () => false,
    updateHook: () => { hookUpdated = true; },
  };

  const controller = new ChartLevelContextController(host);

  // 1. Initial state
  assert.equal(controller.getNpocLevels().length, 0);

  // 2. Request nPOC
  controller.beginNpocRequest("BTC-USDT");
  assert.equal(fetchCount, 1);

  // Allow microtasks to complete fetch
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 3. Settle history -> nPOC levels applied
  controller.notifyNpocHistorySettled("BTC-USDT", "1h");
  assert.equal(controller.getNpocLevels().length, 1);
  assert.equal(controller.getNpocLevels()[0].price, 50100);

  // 4. Replay automatic levels caching
  const context = mockServices.getAnalysisContext("BTC-USDT", true);
  const levels1 = controller.automaticLevelsAsOf("BTC-USDT", 1_700_000_000_000, context);
  const levels2 = controller.automaticLevelsAsOf("BTC-USDT", 1_700_000_000_000, context);
  assert.equal(levels1, levels2, "successive calls return referentially identical cached levels");
  assert.equal(levels1.previousWeekStrategyLevels[0].price, 49000);

  // 5. Visibility filtering in analysisContextForChart
  host.state = {
    ...host.state,
    nakedPocVisibility: { "1D": false },
  };
  const analysisContext = controller.analysisContextForChart();
  assert.equal(analysisContext.nakedPocs.length, 0, "nakedPocs hidden when 1D visibility is false");

  controller.dispose();
});
