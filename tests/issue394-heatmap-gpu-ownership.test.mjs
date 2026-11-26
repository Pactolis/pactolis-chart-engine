import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  configurePerformanceTelemetry,
  resetPerformanceTelemetry,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import {
  ChartHeatmapGpuCoordinator,
  HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT,
  HEATMAP_GPU_SLOW_FRAME_THRESHOLD_MS,
  resetSoftwareRendererProbeCacheForTest,
} from "../dist/features/chart/ChartHeatmapGpuCoordinator.js";

function makeMockGl(rendererString, { unmasked = true } = {}) {
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  return {
    getExtension(name) {
      if (name === "WEBGL_debug_renderer_info" && unmasked) {
        return { UNMASKED_RENDERER_WEBGL };
      }
      return null;
    },
    getParameter(pname) {
      if (unmasked && pname === UNMASKED_RENDERER_WEBGL) {
        return rendererString;
      }
      if (!unmasked && pname === 0x1f01) {
        return rendererString;
      }
      return null;
    },
  };
}

function makeCoordinatorAndHost({ backendKind = "webgl2" } = {}) {
  let invalidated = 0;
  const view = new View();
  view.area = { left: 0, top: 0, width: 640, height: 320 };
  view.colWidth = 12;
  view.priceTop = 110;
  view.pricePerPx = 0.25;

  const series = new FootprintSeries({
    intervalMs: 60_000,
    priceStep: 1,
    pricePrecision: 2,
    referenceMarket: "BINANCE_FUTURES:btcusdt",
  });
  series.upsertBar({
    startTime: 1_699_999_980_000,
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 10,
    delta: 2,
    count: 2,
    cells: new Map([[100, { priceBin: 100, buyVol: 6, sellVol: 4 }]]),
    hasRef: true,
    completeness: "complete",
    sources: ["history"],
  });

  const orderbookHeatmap = {
    currentDataKey: () => "key-394",
    prepareGpuCells: (_v, _s, _range, reserve) => ({
      dataKey: "key-394",
      threshold: 50,
      ceiling: 500,
      colWidth: 12,
      offsetX: 0,
      cellCount: 1,
      preparedLease: reserve(64),
    }),
  };

  const host = {
    backendKind,
    orderbookHeatmap,
    renderCoordinator: {
      getAnnotationLayerOrder: () => ["orderbook-heatmap"],
    },
    renderer: {
      visibleRange: () => [0, 1],
    },
    invalidateSession: () => {
      invalidated++;
    },
  };

  const coordinator = new ChartHeatmapGpuCoordinator(host);
  return {
    coordinator,
    view,
    series,
    getInvalidatedCount: () => invalidated,
  };
}

function attachMockGpuRenderer(coordinator, { renderFrame = () => true, isDisposed = () => false } = {}) {
  let disposed = false;
  coordinator.heatmapGpuRenderer = {
    reservePreparedPayload: () => ({ release() {} }),
    renderFrame,
    dispose: () => {
      disposed = true;
    },
    isDisposed: () => disposed || isDisposed(),
  };
  return () => disposed;
}

test("CE-394: 6 consecutive slow GLOBAL frames with healthy AMD Radeon AI Pro R9700 keep WebGL2 ownership", async () => {
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const { coordinator, view, series } = makeCoordinatorAndHost();
  coordinator.setGl(makeMockGl("AMD Radeon AI Pro R9700"));
  coordinator.setResidentHeatmapEnabled(true, false);
  await coordinator.whenHeatmapGpuRendererReady();
  const isRendererDisposed = attachMockGpuRenderer(coordinator);

  for (let i = 0; i < 6; i++) {
    coordinator.beginFrameAttempt();
    const frame = coordinator.prepareHeatmapGpuCells(view, series);
    coordinator.renderHeatmapGpuCells(frame, view, series);
    const demoted = coordinator.observeRenderedFrame({
      renderMs: 85,
      rafLatencyMs: 90,
      visible: true,
      heatmapGpuMs: 1.5,
    });
    assert.equal(demoted, false, `global slow frame ${i + 1} must not demote`);
  }

  const diag = coordinator.getDiagnostics();
  assert.equal(diag.failureLatched, false);
  assert.equal(diag.heatmapPath, "webgl2");
  assert.equal(diag.fallbackReason, null);
  assert.equal(coordinator.isHeatmapGpuSupported(), true);
  assert.equal(coordinator.heatmapGpuSuppressedAnnotation(view, series, [0, 1]), true);
  assert.equal(isRendererDisposed(), false);

  const counters = snapshotPerformanceTelemetry().counters;
  assert.ok((counters["chart.gpu.heatmap.globalSlowFrame"] ?? 0) >= 6);
  assert.equal(counters["chart.gpu.heatmap.fallback.permanent"] ?? 0, 0);

  coordinator.dispose();
  resetPerformanceTelemetry();
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
});

test("CE-394: consecutive layer-specific slow heatmap GPU submits trigger reversible cooldown then recover", async () => {
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const { coordinator, view, series } = makeCoordinatorAndHost();
  coordinator.setGl(makeMockGl("AMD Radeon AI Pro R9700"));
  coordinator.setResidentHeatmapEnabled(true, false);
  await coordinator.whenHeatmapGpuRendererReady();
  const isRendererDisposed = attachMockGpuRenderer(coordinator);

  let triggeredCooldown = false;
  for (let i = 0; i < HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT; i++) {
    coordinator.beginFrameAttempt();
    const frame = coordinator.prepareHeatmapGpuCells(view, series);
    coordinator.renderHeatmapGpuCells(frame, view, series);
    const demoted = coordinator.observeRenderedFrame({
      renderMs: HEATMAP_GPU_SLOW_FRAME_THRESHOLD_MS + 25,
      rafLatencyMs: 12,
      visible: true,
      heatmapGpuMs: HEATMAP_GPU_SLOW_FRAME_THRESHOLD_MS + 20,
    });
    if (demoted) {
      triggeredCooldown = true;
    }
  }

  assert.equal(triggeredCooldown, true, "consecutive layer-specific slow frames must enter cooldown");
  const cooldownDiag = coordinator.getDiagnostics();
  assert.equal(cooldownDiag.failureLatched, false);
  assert.equal(cooldownDiag.fallbackReason, "layer_slow_budget_cooldown");
  assert.equal(cooldownDiag.heatmapPath, "cpu-raster");
  assert.equal(isRendererDisposed(), false, "reversible cooldown must keep renderer alive");

  const cooldownCounters = snapshotPerformanceTelemetry().counters;
  assert.ok((cooldownCounters["chart.gpu.heatmap.fallback.recoverable"] ?? 0) > 0);

  // Step through cooldown frames until GPU automatically retries and recovers.
  let recovered = false;
  for (let i = 0; i < 64; i++) {
    coordinator.beginFrameAttempt();
    const frame = coordinator.prepareHeatmapGpuCells(view, series);
    if (frame) {
      coordinator.renderHeatmapGpuCells(frame, view, series);
      coordinator.observeRenderedFrame({
        renderMs: 8,
        rafLatencyMs: 4,
        visible: true,
        heatmapGpuMs: 1.2,
      });
      if (coordinator.getDiagnostics().heatmapPath === "webgl2") {
        recovered = true;
        break;
      }
    } else {
      coordinator.observeRenderedFrame({
        renderMs: 8,
        rafLatencyMs: 4,
        visible: true,
        heatmapGpuMs: 0,
      });
    }
  }

  assert.equal(recovered, true, "heatmap GPU ownership must recover automatically after cooldown");
  const recoveredDiag = coordinator.getDiagnostics();
  assert.equal(recoveredDiag.heatmapPath, "webgl2");
  assert.equal(recoveredDiag.fallbackReason, null);
  assert.equal(recoveredDiag.failureLatched, false);
  assert.ok((snapshotPerformanceTelemetry().counters["chart.gpu.heatmap.recovery"] ?? 0) > 0);

  coordinator.dispose();
  resetPerformanceTelemetry();
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
});

test("CE-394: duplicate raster suppression yields zero Canvas2D heatmap density cells when GPU claims frame", async () => {
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const { coordinator, view, series } = makeCoordinatorAndHost();
  coordinator.setGl(makeMockGl("AMD Radeon AI Pro R9700"));
  coordinator.setResidentHeatmapEnabled(true, false);
  await coordinator.whenHeatmapGpuRendererReady();
  attachMockGpuRenderer(coordinator);

  coordinator.beginFrameAttempt();
  const frame = coordinator.prepareHeatmapGpuCells(view, series);
  coordinator.renderHeatmapGpuCells(frame, view, series);

  assert.equal(coordinator.heatmapGpuSuppressedAnnotation(view, series, [0, 1]), true);
  // Claim mismatch (different range or offsetX) must not falsely suppress fallback.
  assert.equal(coordinator.heatmapGpuSuppressedAnnotation(view, series, [0, 2]), false);

  const counters = snapshotPerformanceTelemetry().counters;
  assert.equal(counters["chart.cpu.heatmap.density.cells"] ?? 0, 0);

  coordinator.dispose();
  resetPerformanceTelemetry();
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
});

test("CE-394: explicit Canvas2D, software WebGL2, and context lost/restored transitions", async () => {
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();

  // Explicit Canvas2D backend
  const canvasHost = makeCoordinatorAndHost({ backendKind: "canvas2d" });
  canvasHost.coordinator.setResidentHeatmapEnabled(true, false);
  assert.equal(canvasHost.coordinator.isHeatmapGpuSupported(), false);
  assert.equal(canvasHost.coordinator.getDiagnostics().fallbackReason, "backend_unsupported");
  canvasHost.coordinator.dispose();

  // Software WebGL2 (SwiftShader)
  const swHost = makeCoordinatorAndHost({ backendKind: "webgl2" });
  const swRenderer = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
  swHost.coordinator.setGl(makeMockGl(swRenderer));
  swHost.coordinator.setResidentHeatmapEnabled(true, false);
  assert.equal(swHost.coordinator.isHeatmapGpuSupported(), false);
  assert.equal(swHost.coordinator.getDiagnostics().fallbackReason, "software_renderer");
  swHost.coordinator.dispose();

  // Context lost & restored on hardware WebGL2
  const hwHost = makeCoordinatorAndHost({ backendKind: "webgl2" });
  hwHost.coordinator.setGl(makeMockGl("AMD Radeon AI Pro R9700"));
  hwHost.coordinator.setResidentHeatmapEnabled(true, false);
  await hwHost.coordinator.whenHeatmapGpuRendererReady();
  attachMockGpuRenderer(hwHost.coordinator);

  hwHost.coordinator.onLostContext();
  assert.equal(hwHost.coordinator.getDiagnostics().failureLatched, false);

  hwHost.coordinator.onRestoreContext(makeMockGl("AMD Radeon AI Pro R9700"));
  await hwHost.coordinator.whenHeatmapGpuRendererReady();
  attachMockGpuRenderer(hwHost.coordinator);
  hwHost.coordinator.beginFrameAttempt();
  const frame = hwHost.coordinator.prepareHeatmapGpuCells(hwHost.view, hwHost.series);
  hwHost.coordinator.renderHeatmapGpuCells(frame, hwHost.view, hwHost.series);
  assert.equal(hwHost.coordinator.getDiagnostics().heatmapPath, "webgl2");
  hwHost.coordinator.dispose();

  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
});

test("CE-394: lazy renderer loading and budget-exceeded counters", async () => {
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const { coordinator, view, series } = makeCoordinatorAndHost();
  coordinator.setGl(makeMockGl("AMD Radeon AI Pro R9700"));
  // Enable without awaiting whenHeatmapGpuRendererReady so renderer is not yet loaded.
  coordinator.setResidentHeatmapEnabled(true, false);
  coordinator.heatmapGpuRenderer = null;

  coordinator.beginFrameAttempt();
  const lazyFrame = coordinator.prepareHeatmapGpuCells(view, series);
  assert.equal(lazyFrame, null);
  assert.equal(coordinator.getDiagnostics().fallbackReason, "renderer_loading");
  assert.ok((snapshotPerformanceTelemetry().counters["chart.gpu.heatmap.skip.rendererLoading"] ?? 0) >= 1);

  // Now attach renderer that throws budget exceeded.
  await coordinator.whenHeatmapGpuRendererReady();
  attachMockGpuRenderer(coordinator, {
    renderFrame: () => {
      throw new Error("Heatmap GPU prototype budget exceeded");
    },
  });

  coordinator.beginFrameAttempt();
  const frame = coordinator.prepareHeatmapGpuCells(view, series);
  coordinator.renderHeatmapGpuCells(frame, view, series);

  assert.equal(coordinator.getDiagnostics().fallbackReason, "budget-exceeded");
  assert.equal(coordinator.getDiagnostics().heatmapPath, "cpu");
  assert.ok((snapshotPerformanceTelemetry().counters["chart.gpu.heatmap.skip.budgetExceeded"] ?? 0) >= 1);

  coordinator.dispose();
  resetPerformanceTelemetry();
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
});
