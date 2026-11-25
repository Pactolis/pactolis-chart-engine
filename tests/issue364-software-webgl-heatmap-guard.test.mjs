import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import {
  getGpuDiagnostics,
  resetGpuDiagnosticsForTest,
} from "../dist/core/gpu/gpuDiagnostics.js";
import {
  readGpuSettings,
  resetGpuSettingsForTest,
} from "../dist/core/gpu/gpuSettings.js";
import { isSoftwareRendererName } from "../dist/core/gpu/selectBackend.js";
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

function makeCoordinatorAndHost() {
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
    currentDataKey: () => "key-1",
    getPrepareCacheKey: () => null,
    prepareGpuCells: (_v, _s, _range, reserve) => ({
      dataKey: "key-1",
      threshold: 10,
      ceiling: 100,
      colWidth: 12,
      offsetX: 0,
      cellCount: 1,
      preparedLease: reserve(64),
    }),
  };

  const host = {
    backendKind: "webgl2",
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

test("isSoftwareRendererName matches known software WebGL2 renderers and ignores hardware GPUs", () => {
  assert.equal(
    isSoftwareRendererName("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"),
    true,
  );
  assert.equal(isSoftwareRendererName("llvmpipe (LLVM 15.0.7, 256 bits)"), true);
  assert.equal(isSoftwareRendererName("Microsoft Basic Render Driver"), true);
  assert.equal(isSoftwareRendererName("AMD Radeon RX 7900"), false);
  assert.equal(isSoftwareRendererName(null), false);
  assert.equal(isSoftwareRendererName(undefined), false);
  assert.equal(isSoftwareRendererName(""), false);
});

test("readGpuSettings tracks residentHeatmapExplicit for URL overrides", () => {
  resetGpuSettingsForTest();
  const enabledOverride = readGpuSettings({ location: { search: "?residentHeatmap=1" } });
  assert.equal(enabledOverride.residentHeatmap, true);
  assert.equal(enabledOverride.residentHeatmapExplicit, true);

  const disabledOverride = readGpuSettings({ location: { search: "?residentHeatmap=0" } });
  assert.equal(disabledOverride.residentHeatmap, false);
  assert.equal(disabledOverride.residentHeatmapExplicit, false);

  const defaultSettings = readGpuSettings({ location: { search: "" } });
  assert.equal(defaultSettings.residentHeatmap, true);
  assert.equal(defaultSettings.residentHeatmapExplicit, undefined);
  resetGpuSettingsForTest();
});

test("ChartHeatmapGpuCoordinator guards software WebGL2 renderer unless explicitOverride is true", () => {
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
  const { coordinator } = makeCoordinatorAndHost();
  const swRenderer = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

  coordinator.setGl(makeMockGl(swRenderer));
  coordinator.setResidentHeatmapEnabled(true, false);

  assert.equal(coordinator.isHeatmapGpuSupported(), false);
  const swDiag = coordinator.getDiagnostics();
  assert.equal(swDiag.heatmapPath, "cpu-raster");
  assert.equal(swDiag.fallbackReason, "software_renderer");
  assert.equal(swDiag.renderer, swRenderer);
  assert.equal(getGpuDiagnostics().counters["gpu.featureFallback.orderbook-heatmap.software_renderer"], 1);

  coordinator.setResidentHeatmapEnabled(true, true);
  assert.equal(coordinator.isHeatmapGpuSupported(), true);

  const hwRenderer = "AMD Radeon RX 7900";
  coordinator.setGl(makeMockGl(hwRenderer));
  coordinator.setResidentHeatmapEnabled(true, false);
  assert.equal(coordinator.isHeatmapGpuSupported(), true);
  assert.equal(coordinator.getDiagnostics().renderer, hwRenderer);

  coordinator.dispose();
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
});

test("ChartHeatmapGpuCoordinator latches session to cpu-raster after 5 consecutive slow GPU heatmap frames", () => {
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
  resetPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });

  const { coordinator, view, series } = makeCoordinatorAndHost();
  coordinator.setGl(makeMockGl("AMD Radeon RX 7900"));
  coordinator.setResidentHeatmapEnabled(true, false);
  coordinator.heatmapGpuRenderer = {
    reservePreparedPayload: () => ({ release() {} }),
    renderFrame: () => true,
    dispose: () => {},
    isDisposed: () => false,
  };

  const runGpuHeatmapFrame = (sample) => {
    coordinator.beginFrameAttempt();
    const frame = coordinator.prepareHeatmapGpuCells(view, series);
    coordinator.renderHeatmapGpuCells(frame, view, series);
    return coordinator.observeRenderedFrame(sample);
  };

  // 4 consecutive slow frames must not latch.
  for (let i = 0; i < HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT - 1; i++) {
    assert.equal(runGpuHeatmapFrame({ renderMs: HEATMAP_GPU_SLOW_FRAME_THRESHOLD_MS + 10, visible: true }), false);
  }
  assert.equal(coordinator.getDiagnostics().failureLatched, false);

  // A fast frame resets the consecutive slow counter.
  assert.equal(runGpuHeatmapFrame({ renderMs: 10, visible: true }), false);
  for (let i = 0; i < HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT - 1; i++) {
    assert.equal(runGpuHeatmapFrame({ renderMs: 65, visible: true }), false);
  }
  assert.equal(coordinator.getDiagnostics().failureLatched, false);

  // Hidden tab frames reset the consecutive slow counter.
  assert.equal(runGpuHeatmapFrame({ renderMs: 80, visible: false }), false);
  for (let i = 0; i < HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT - 1; i++) {
    assert.equal(runGpuHeatmapFrame({ renderMs: 65, visible: true }), false);
  }
  assert.equal(coordinator.getDiagnostics().failureLatched, false);

  // 5th consecutive slow frame latches the session (combining renderMs and rafLatencyMs > 50ms).
  assert.equal(
    runGpuHeatmapFrame({ renderMs: 12, rafLatencyMs: HEATMAP_GPU_SLOW_FRAME_THRESHOLD_MS + 15, visible: true }),
    true,
  );
  const latchedDiag = coordinator.getDiagnostics();
  assert.equal(latchedDiag.failureLatched, true);
  assert.equal(latchedDiag.heatmapPath, "cpu-raster");
  assert.equal(latchedDiag.fallbackReason, "slow_frame_budget");
  assert.equal(coordinator.isHeatmapGpuSupported(), false);
  assert.equal(getGpuDiagnostics().counters["gpu.featureFallback.orderbook-heatmap.slow_frame_budget"], 1);
  assert.equal(snapshotPerformanceTelemetry().counters["chart.gpu.heatmap.fallback.permanent"], 1);

  // explicitOverride = true must not latch even on sustained slow frames.
  const explicit = makeCoordinatorAndHost();
  explicit.coordinator.setGl(makeMockGl("AMD Radeon RX 7900"));
  explicit.coordinator.setResidentHeatmapEnabled(true, true);
  explicit.coordinator.heatmapGpuRenderer = {
    reservePreparedPayload: () => ({ release() {} }),
    renderFrame: () => true,
    dispose: () => {},
    isDisposed: () => false,
  };
  for (let i = 0; i < HEATMAP_GPU_SLOW_FRAME_CONSECUTIVE_LIMIT + 2; i++) {
    explicit.coordinator.beginFrameAttempt();
    const f = explicit.coordinator.prepareHeatmapGpuCells(explicit.view, explicit.series);
    explicit.coordinator.renderHeatmapGpuCells(f, explicit.view, explicit.series);
    assert.equal(explicit.coordinator.observeRenderedFrame({ renderMs: 80, visible: true }), false);
  }
  assert.equal(explicit.coordinator.getDiagnostics().failureLatched, false);

  coordinator.dispose();
  explicit.coordinator.dispose();
  resetPerformanceTelemetry();
  resetGpuDiagnosticsForTest();
  resetSoftwareRendererProbeCacheForTest();
});
