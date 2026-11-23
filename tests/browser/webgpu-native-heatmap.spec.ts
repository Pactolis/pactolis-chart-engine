import { writeFile } from "node:fs/promises";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";
import {
  buildWebGpuHeatmapBars,
  evaluateWebGpuHeatmapAssessment,
  resolveWebGpuHeatmapFixture,
  summarizeMetricValues,
} from "../../harness/webgpuNativeHeatmapBenchmark.mjs";
import {
  classifyWebGpuAdapter,
  webGpuFlushLaunchArgs,
} from "../../harness/webgpuNativeBenchmark.mjs";

const VIEWPORT = { width: 1280, height: 800 };
const HOOK_SELECTOR = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

function launchArgs(hardwareMode = false): string[] {
  return webGpuFlushLaunchArgs({
    kind: "webgpu",
    variant: hardwareMode ? "hardware" : "no-vulkan-compositor",
    hardwareMode,
    platform: process.platform,
    functionalWebglArgs: FUNCTIONAL_WEBGL_ARGS,
  });
}

async function launchBrowser(args: string[]): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
}

async function installWebGpuOffscreenPresentInitScript(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    const proxyContexts = new WeakMap<HTMLCanvasElement, any>();
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
      if (type !== "webgpu") {
        return origGetContext.apply(this, [type, ...args] as any);
      }
      const existing = proxyContexts.get(this);
      if (existing) return existing;
      const canvas = this;
      let device: any = null;
      let format = "bgra8unorm";
      let usage = 0x10 | 0x01;
      let texture: any = null;
      let texWidth = 0;
      let texHeight = 0;
      const ctx = {
        configure(cfg: any) {
          device = cfg.device;
          format = cfg.format ?? "bgra8unorm";
          usage = (cfg.usage ?? 0x10) | 0x01;
          if (texture) {
            try { texture.destroy(); } catch {}
            texture = null;
          }
        },
        unconfigure() {
          if (texture) {
            try { texture.destroy(); } catch {}
            texture = null;
          }
        },
        getCurrentTexture() {
          if (!device) return null;
          const w = Math.max(1, canvas.width || 1);
          const h = Math.max(1, canvas.height || 1);
          if (!texture || texWidth !== w || texHeight !== h) {
            if (texture) {
              try { texture.destroy(); } catch {}
            }
            texWidth = w;
            texHeight = h;
            texture = device.createTexture({ size: [w, h], format, usage });
          }
          return texture;
        },
      };
      proxyContexts.set(this, ctx);
      return ctx;
    };
  });
}

async function probeWebGpu(page: Page): Promise<{ supported: boolean; adapter: any; adapterClass: string }> {
  return page.evaluate(async () => {
    const gpu = (navigator as any).gpu;
    if (!gpu) return { supported: false, adapter: null, adapterClass: "unavailable" };
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return { supported: false, adapter: null, adapterClass: "unavailable" };
      const device = await adapter.requestDevice();
      device?.destroy?.();
      const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
      const identity = {
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
        isFallbackAdapter: Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
      };
      return { supported: Boolean(device), adapter: identity, adapterClass: identity.isFallbackAdapter ? "fallback" : "adapter" };
    } catch {
      return { supported: false, adapter: null, adapterClass: "unavailable" };
    }
  });
}

async function installHeatmapRoutes(
  page: Page,
  bars: any[],
  heatmapBars: any[],
): Promise<void> {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });
  await page.route(/\/history(?:\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    const candleOnly = q.get("includeFootprint") === "0";
    const meta = candleOnly
      ? { schemaVersion: 1, generatedAt: FROZEN_NOW }
      : {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          footprint: { available: true, allowed: true, priceStep: 50 },
          footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
        };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars }, meta }),
    });
  });
  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          base: "BTC",
          source: "single",
          resolution: q.get("resolution") ?? "15m",
          bucketStep: Number(q.get("bucketStep") ?? 50),
          from,
          to,
          bars: heatmapBars.filter((bar) => bar.t >= from && bar.t <= to),
        },
      }),
    });
  });
}

test("SwiftShader WebGPU verifies 40k-cell GPU-resident heatmap with 0 B pan/zoom upload, log fallback, and layer order", async ({ baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const browser = await launchBrowser(launchArgs(false));

  try {
    const probeCtx = await browser.newContext({ baseURL: resolvedBaseURL, viewport: VIEWPORT });
    const probePage = await probeCtx.newPage();
    await installWebGpuOffscreenPresentInitScript(probePage);
    await probePage.goto("/harness/blank.html");
    const probe = await probeWebGpu(probePage);
    await probeCtx.close();
    if (!probe.supported) {
      test.skip(true, "WebGPU adapter unavailable in runtime");
    }

    const fixture = resolveWebGpuHeatmapFixture({ barCount: 2000, cellsPerBar: 20, fitColumns: 120 });
    const { bars, heatmapBars } = buildWebGpuHeatmapBars(fixture, FROZEN_NOW);

    const context = await browser.newContext({ baseURL: resolvedBaseURL, viewport: VIEWPORT });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await installWebGpuOffscreenPresentInitScript(page);
    await installHeatmapRoutes(page, bars, heatmapBars);
    await openHarness(
      page,
      "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0&gpu=webgpu&webgpuNative=1&residentHeatmap=1",
    );

    const hook = page.locator(HOOK_SELECTOR);
    await expect(hook).toHaveCount(1);
    await expect(hook).toHaveAttribute("data-history-loading", "false");
    const id = await hook.getAttribute("data-panel-id");
    if (!id) throw new Error("Missing chart panel id");

    await page.evaluate(async ({ id }) => {
      const { getChartRuntime, updateOrderbookHeatmapSettings, setOrderbookHeatmapModeFor } =
        await import("/harness/chart.ts");
      const { settings } = await import("/src/core/settings.ts");
      settings.grid = false;
      const r: any = getChartRuntime(id);
      const s = r.pipeline.series;
      r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: "linear" });
      r.view.fitPriceRange(59_800, 61_600, 0.05);
      r.view.colWidth = 10;
      r.view.offsetX = r.view.area.width - (s.length + 2) * r.view.colWidth;
      updateOrderbookHeatmapSettings({ unit: "btc", bucketStep: 50, single: { usd: 0, btc: 10 } });
      setOrderbookHeatmapModeFor(r.getState().market, "single");
      r.invalidate();
      await r.session.captureCompositePng();
    }, { id });

    await expect.poll(() => page.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const r: any = getChartRuntime(id);
      const book = r.orderbookHeatmap;
      return Boolean(book && book.bars.size >= 100 && book.inFlight.size === 0 && book.chunks.size > 0);
    }, { id })).toBe(true);

    const out = await page.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
      const telemetry = await import("/src/core/performanceTelemetry.ts");

      const r: any = getChartRuntime(id);
      // Warm initial full resident sync
      r.invalidate();
      await r.session.captureCompositePng();
      const initialPaths = { ...(getGpuDiagnostics().featurePaths ?? {}) };

      // Pan & Zoom under telemetry
      telemetry.configurePerformanceTelemetry({ enabled: true });
      telemetry.resetPerformanceTelemetry();
      for (let i = 0; i < 4; i++) {
        r.view.panX(-24);
        r.view.panY(4);
        r.invalidate();
        await r.session.captureCompositePng();
      }
      for (let i = 0; i < 3; i++) {
        r.view.zoomX(1.06, 600);
        r.invalidate();
        await r.session.captureCompositePng();
      }
      const snap = telemetry.snapshotPerformanceTelemetry();

      // Log scale fallback
      r.updateState({ ...r.getState(), scaleMode: "log" });
      r.invalidate();
      await r.session.captureCompositePng();
      const logPaths = { ...(getGpuDiagnostics().featurePaths ?? {}) };

      // Back to linear + footprint verifies Canvas2D footprint text layer order
      r.updateState({ ...r.getState(), chartType: "footprint", scaleMode: "linear" });
      r.invalidate();
      await r.session.captureCompositePng();
      const footprintPaths = { ...(getGpuDiagnostics().featurePaths ?? {}) };
      const nativeTextWhenHeatmapActive = r.renderer.renderedNativeFootprintText;

      return {
        initialPaths,
        panZoomDataBytes: snap.counters["gpu.native.heatmap.dataBytes"] ?? 0,
        panZoomUniformBytes: snap.counters["gpu.native.heatmap.uniformBytes"] ?? 0,
        panZoomPrepareCount: snap.metrics["chart.gpu.heatmap.prepare.ms"]?.count ?? 0,
        panZoomRenderCount: snap.metrics["chart.gpu.heatmap.render.ms"]?.count ?? 0,
        logPaths,
        footprintPaths,
        nativeTextWhenHeatmapActive,
      };
    }, { id });

    await context.close();

    expect(errors).toEqual([]);
    expect(out.initialPaths.heatmap).toBe("webgpu-native");
    expect(out.initialPaths["orderbook-heatmap"]).toBe("webgpu");
    expect(out.panZoomDataBytes).toBe(0);
    expect(out.panZoomUniformBytes).toBeGreaterThan(0);
    expect(out.panZoomPrepareCount).toBe(0);
    expect(out.panZoomRenderCount).toBeGreaterThanOrEqual(7);
    expect(out.logPaths.heatmap).not.toBe("webgpu-native");
    expect(out.footprintPaths.heatmap).toBe("webgpu-native");
    expect(out.nativeTextWhenHeatmapActive).toBe(false);
  } finally {
    await browser.close().catch(() => {});
  }
});

test("40k-cell resident vs immediate heatmap benchmark", async ({ baseURL }, testInfo) => {
  test.skip(process.env.CHART_GPU_BENCHMARK_MODE !== "hardware", "Run via npm run benchmark:webgpu-heatmap");
  test.setTimeout(300_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const fixture = resolveWebGpuHeatmapFixture({
    barCount: process.env.CHART_GPU_HEATMAP_BARS,
    cellsPerBar: process.env.CHART_GPU_HEATMAP_CELLS,
    fitColumns: process.env.CHART_GPU_HEATMAP_FIT,
  });
  const { bars, heatmapBars } = buildWebGpuHeatmapBars(fixture, FROZEN_NOW);
  const browser = await launchBrowser(launchArgs(true));

  try {
    const context = await browser.newContext({ baseURL: resolvedBaseURL, viewport: VIEWPORT });
    const page = await context.newPage();
    await installWebGpuOffscreenPresentInitScript(page);
    await installHeatmapRoutes(page, bars, heatmapBars);
    await openHarness(
      page,
      "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0&gpu=webgpu&webgpuNative=1&residentHeatmap=1",
    );
    const hook = page.locator(HOOK_SELECTOR);
    await expect(hook).toHaveCount(1);
    await expect(hook).toHaveAttribute("data-history-loading", "false");
    const id = await hook.getAttribute("data-panel-id");
    if (!id) throw new Error("Missing chart panel id");

    const adapterIdentity = await page.evaluate(async () => {
      const adapter = await (navigator as any).gpu?.requestAdapter?.();
      if (!adapter) return null;
      return adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? null;
    });
    const adapterClass = classifyWebGpuAdapter(adapterIdentity ?? {});

    await page.evaluate(async ({ id, fitColumns }) => {
      const { getChartRuntime, updateOrderbookHeatmapSettings, setOrderbookHeatmapModeFor } =
        await import("/harness/chart.ts");
      const r: any = getChartRuntime(id);
      const s = r.pipeline.series;
      r.view.colWidth = Math.max(2, r.view.area.width / fitColumns);
      r.view.offsetX = r.view.area.width - (s.length + 2) * r.view.colWidth;
      updateOrderbookHeatmapSettings({ unit: "btc", bucketStep: 50, single: { usd: 0, btc: 10 } });
      setOrderbookHeatmapModeFor(r.getState().market, "single");
      r.invalidate();
      await r.session.captureCompositePng();
    }, { id, fitColumns: fixture.fitColumns });

    await expect.poll(() => page.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const r: any = getChartRuntime(id);
      const book = r.orderbookHeatmap;
      return Boolean(book && book.bars.size >= 100 && book.inFlight.size === 0 && book.chunks.size > 0);
    }, { id })).toBe(true);

    const bench = await page.evaluate(async ({ id, fixture }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
      const telemetry = await import("/src/core/performanceTelemetry.ts");

      const r: any = getChartRuntime(id);
      const runPanZoom = async () => {
        telemetry.configurePerformanceTelemetry({ enabled: true });
        telemetry.resetPerformanceTelemetry();
        const frameSamples: number[] = [];
        for (let i = 0; i < fixture.panFrames; i++) {
          const t0 = performance.now();
          r.view.panX(i % 2 === 0 ? -12 : 12);
          r.invalidate();
          await r.session.captureCompositePng();
          frameSamples.push(performance.now() - t0);
        }
        for (let i = 0; i < fixture.zoomFrames; i++) {
          const t0 = performance.now();
          r.view.zoomX(i % 2 === 0 ? 1.03 : 0.97, 600);
          r.invalidate();
          await r.session.captureCompositePng();
          frameSamples.push(performance.now() - t0);
        }
        const snap = telemetry.snapshotPerformanceTelemetry();
        return {
          frameSamples,
          dataBytes: snap.counters["gpu.native.heatmap.dataBytes"] ?? 0,
          uploadBytes: snap.counters["gpu.upload.bytes"] ?? 0,
          uniformBytes: snap.counters["gpu.native.heatmap.uniformBytes"] ?? 0,
          prepareCount: snap.metrics["chart.gpu.heatmap.prepare.ms"]?.count ?? 0,
        };
      };

      r.setResidentHeatmapEnabled(true);
      r.invalidate();
      await r.session.captureCompositePng();
      const resident = await runPanZoom();
      const fallbacks = getGpuDiagnostics().fallbacks.length;

      return { resident, fallbacks };
    }, { id, fixture });

    await context.close();

    const hardwareValid = Boolean(adapterIdentity) && !Boolean(adapterIdentity?.isFallbackAdapter) && adapterClass !== "software";
    const residentSummary = summarizeMetricValues(bench.resident.frameSamples);
    const assessment = evaluateWebGpuHeatmapAssessment({
      hardwareValid,
      residentZeroPanZoomUpload: bench.resident.dataBytes === 0,
      residentPrepareCallsDuringPanZoom: bench.resident.prepareCount,
      fallbacks: bench.fallbacks,
      scenarios: { residentPanZoom: residentSummary },
    });

    if (process.env.CHART_GPU_HEATMAP_REPORT_PATH) {
      await writeFile(process.env.CHART_GPU_HEATMAP_REPORT_PATH, JSON.stringify({
        issue: "#265",
        adapter: adapterIdentity,
        adapterClass,
        hardwareValid,
        residentPanZoomDataBytes: bench.resident.dataBytes,
        residentPanZoomUniformBytes: bench.resident.uniformBytes,
        residentPanZoomPrepareCount: bench.resident.prepareCount,
        assessment,
      }, null, 2));
    }

    expect(bench.resident.dataBytes).toBe(0);
    expect(bench.resident.prepareCount).toBe(0);
  } finally {
    await browser.close().catch(() => {});
  }
});
