import { existsSync } from "node:fs";
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
    variant: "no-vulkan-compositor",
    hardwareMode,
    platform: process.platform,
    functionalWebglArgs: FUNCTIONAL_WEBGL_ARGS,
  });
}

async function launchBrowser(args: string[], hardwareMode = false): Promise<Browser> {
  let executablePath: string | undefined;
  if (process.env.CHROMIUM_PATH) {
    executablePath = process.env.CHROMIUM_PATH;
  } else if (hardwareMode && process.platform === "win32") {
    const fullExe = chromium.executablePath();
    if (fullExe && existsSync(fullExe)) {
      executablePath = fullExe;
    }
  }
  return chromium.launch({
    headless: true,
    args,
    ...(executablePath ? { executablePath } : {}),
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

async function probeWebGpu(page: Page): Promise<{ supported: boolean; adapter: any }> {
  return page.evaluate(async () => {
    const gpu = (navigator as any).gpu;
    if (!gpu) return { supported: false, adapter: null };
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return { supported: false, adapter: null };
      const { readWebGpuAdapterIdentity } = await import("/harness/webgpuNativeBenchmark.mjs");
      const identity = await readWebGpuAdapterIdentity(adapter);
      const device = await adapter.requestDevice();
      device?.destroy?.();
      return { supported: Boolean(device), adapter: identity };
    } catch {
      return { supported: false, adapter: null };
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
  await page.route("**/fapi/v1/klines*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.routeWebSocket((url) => url.hostname !== "127.0.0.1", (ws) => ws.close());
  await page.route("**/src/core/performanceTelemetry.ts*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const patched = body.replace(
      /(function\s+recordPerformanceDuration\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{[\s\S]*?)(totals\.set\()/,
      `$1globalThis.__webgpuHeatmapBenchRecord?.($2, $3); $4`,
    );
    if (patched === body) {
      throw new Error("Failed to instrument recordPerformanceDuration in /src/core/performanceTelemetry.ts");
    }
    const headers = { ...response.headers() };
    delete headers["content-length"];
    await route.fulfill({ status: response.status(), headers, body: patched });
  });
  await page.route(/\/history(?:\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    const includeFootprint = q.get("includeFootprint") !== "0";
    const served = includeFootprint ? bars : [];
    const meta = includeFootprint
      ? {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          footprint: { available: true, allowed: true, priceStep: 50 },
          footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
        }
      : { schemaVersion: 1, generatedAt: FROZEN_NOW };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars: served }, meta }),
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

interface ScenarioRawMetrics {
  readonly frameSamples: number[];
  readonly heatmapSamples: number[];
  readonly prepareCount: number;
  readonly rafSamples: number[];
  readonly rafMissed: number;
  readonly dataBytes: number;
  readonly uniformBytes: number;
  readonly uploadBytes: number;
}

interface ModeMeasurement {
  readonly paths: Record<string, string>;
  readonly adapter: any;
  readonly fallbacks: number;
  readonly pngB64: string;
  readonly pan: {
    readonly frame: ReturnType<typeof summarizeMetricValues>;
    readonly heatmap: ReturnType<typeof summarizeMetricValues>;
    readonly raf: ReturnType<typeof summarizeMetricValues>;
    readonly rafMissed: number;
    readonly prepareCount: number;
    readonly dataBytes: number;
    readonly uniformBytes: number;
    readonly uploadBytes: number;
  };
  readonly zoom: {
    readonly frame: ReturnType<typeof summarizeMetricValues>;
    readonly heatmap: ReturnType<typeof summarizeMetricValues>;
    readonly raf: ReturnType<typeof summarizeMetricValues>;
    readonly rafMissed: number;
    readonly prepareCount: number;
    readonly dataBytes: number;
    readonly uniformBytes: number;
    readonly uploadBytes: number;
  };
  readonly logFallbackPaths?: Record<string, string>;
  readonly footprintPaths?: Record<string, string>;
  readonly nativeTextWhenHeatmapActive?: boolean;
}

function summarizeRawScenario(raw: ScenarioRawMetrics) {
  return {
    frame: summarizeMetricValues(raw.frameSamples),
    heatmap: summarizeMetricValues(raw.heatmapSamples),
    raf: summarizeMetricValues(raw.rafSamples),
    rafMissed: raw.rafMissed,
    prepareCount: raw.prepareCount,
    dataBytes: raw.dataBytes,
    uniformBytes: raw.uniformBytes,
    uploadBytes: raw.uploadBytes,
  };
}

async function measureHeatmapMode({
  browser,
  baseURL,
  bars,
  heatmapBars,
  fixture,
  residentEnabled,
  hardwareMode,
  checkFallbackAndLayerOrder = false,
}: {
  browser: Browser;
  baseURL: string;
  bars: any[];
  heatmapBars: any[];
  fixture: ReturnType<typeof resolveWebGpuHeatmapFixture>;
  residentEnabled: boolean;
  hardwareMode: boolean;
  checkFallbackAndLayerOrder?: boolean;
}): Promise<ModeMeasurement> {
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (!hardwareMode) {
    await installWebGpuOffscreenPresentInitScript(page);
  }
  await installHeatmapRoutes(page, bars, heatmapBars);
  await openHarness(
    page,
    `?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0&gpu=webgpu&webgpuNative=1&residentHeatmap=${residentEnabled ? 1 : 0}`,
  );

  const hook = page.locator(HOOK_SELECTOR);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Missing chart panel id");

  await expect.poll(
    () => page.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      return getChartRuntime(id)?.pipeline?.series?.length ?? 0;
    }, { id }),
    { timeout: 30_000 },
  ).toBeGreaterThanOrEqual(fixture.barCount);

  await page.evaluate(async ({ id, fitColumns }) => {
    const { getChartRuntime, updateOrderbookHeatmapSettings, setOrderbookHeatmapModeFor } =
      await import("/harness/chart.ts");
    const { settings } = await import("/src/core/settings.ts");
    settings.grid = false;
    const r: any = getChartRuntime(id);
    const s = r.pipeline.series;
    r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: "linear" });
    r.invalidate();
    await r.session.captureCompositePng();
    r.view.colWidth = Math.max(2, Math.floor(r.view.area.width / fitColumns));
    r.view.setPriceAutoScale(false);
    r.view.pricePerPx = 50 / 20;
    r.view.priceTop = 61_500;
    r.view.offsetX = Math.floor(r.view.area.width - (s.length + 2) * r.view.colWidth);
    updateOrderbookHeatmapSettings({ unit: "btc", bucketStep: 50, single: { usd: 0, btc: 10 } });
    setOrderbookHeatmapModeFor(r.getState().market, "single");
    r.invalidate();
    await r.session.captureCompositePng();
  }, { id, fitColumns: fixture.fitColumns });

  await expect.poll(
    () => page.evaluate(async ({ id, minBars }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const r: any = getChartRuntime(id);
      const book = r?.orderbookHeatmap;
      const s = r?.pipeline?.series;
      const tail = book && s && s.length > 0 ? book.bars.get(s.timeOfIndex(s.length - 1)) : null;
      return Boolean(
        book
        && book.bars.size >= minBars
        && tail?.cells?.length > 0
        && book.inFlight.size === 0
        && book.chunks.size > 0
        && [...book.chunks.values()].every((c: any) => c.status === "ready"),
      );
    }, { id, minBars: Math.min(100, fixture.barCount) }),
    { timeout: 30_000 },
  ).toBe(true);

  const measured = await page.evaluate(async ({ id, fitColumns, panFrames, zoomFrames, residentEnabled, checkFallbackAndLayerOrder }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    const { readWebGpuAdapterIdentity } = await import("/harness/webgpuNativeBenchmark.mjs");

    const nextRaf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const blobToB64 = (blob: Blob) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });

    const gpu = (navigator as any).gpu;
    const adapterObj = gpu ? await gpu.requestAdapter() : null;
    const adapter = adapterObj ? await readWebGpuAdapterIdentity(adapterObj) : null;

    const r: any = getChartRuntime(id);
    const s = r.pipeline.series;
    r.view.colWidth = Math.max(2, Math.floor(r.view.area.width / fitColumns));
    r.view.setPriceAutoScale(false);
    r.view.pricePerPx = 50 / 20;
    r.view.priceTop = 61_500;
    r.view.offsetX = Math.floor(r.view.area.width - (s.length + 2) * r.view.colWidth);
    // Single static capture before timed loops for warm-up and parity baseline.
    r.invalidate();
    const staticCapture = await r.session.captureCompositePng();
    const pngB64 = await blobToB64(staticCapture.blob);
    const paths = { ...(getGpuDiagnostics().featurePaths ?? {}) };

    // Settle any pending heatmap chunk/texture uploads before timed pan/zoom loops.
    r.invalidate();
    await nextRaf();
    if ((r.orderbookHeatmap?.inFlight?.size ?? 0) > 0) {
      for (let settle = 0; settle < 120 && (r.orderbookHeatmap?.inFlight?.size ?? 0) > 0; settle++) {
        await nextRaf();
      }
      r.invalidate();
      await nextRaf();
    }

    const heatmapMetric = residentEnabled ? "chart.gpu.heatmap.render.ms" : "chart.annotation.layer.orderbook-heatmap.ms";
    let activeFrameSamples: number[] = [];
    let activeHeatmapSamples: number[] = [];
    let activePrepareCount = 0;

    (globalThis as any).__webgpuHeatmapBenchRecord = (name: string, durationMs: number) => {
      if (name === "chart.frame.render.ms") activeFrameSamples.push(durationMs);
      else if (name === heatmapMetric) activeHeatmapSamples.push(durationMs);
      else if (name === "chart.gpu.heatmap.prepare.ms") activePrepareCount++;
    };

    const runTimedLoop = async (count: number, step: (i: number) => void): Promise<ScenarioRawMetrics> => {
      activeFrameSamples = [];
      activeHeatmapSamples = [];
      activePrepareCount = 0;
      const rafSamples: number[] = [];
      let rafMissed = 0;

      telemetry.configurePerformanceTelemetry({ enabled: true });
      telemetry.resetPerformanceTelemetry();

      await nextRaf();
      let prevTs = performance.now();
      for (let i = 0; i < count; i++) {
        step(i);
        r.invalidate();
        await nextRaf();
        const nowTs = performance.now();
        const dt = nowTs - prevTs;
        prevTs = nowTs;
        rafSamples.push(dt);
        if (dt > 20) rafMissed++;
      }

      const snap = telemetry.snapshotPerformanceTelemetry();
      return {
        frameSamples: activeFrameSamples,
        heatmapSamples: activeHeatmapSamples,
        prepareCount: activePrepareCount,
        rafSamples,
        rafMissed,
        dataBytes: snap.counters["gpu.native.heatmap.dataBytes"] ?? 0,
        uniformBytes: snap.counters["gpu.native.heatmap.uniformBytes"] ?? 0,
        uploadBytes: snap.counters["gpu.upload.bytes"] ?? 0,
      };
    };

    const pan = await runTimedLoop(panFrames, (i) => {
      r.view.panX(i % 2 === 0 ? -16 : 16);
      r.view.panY(i % 2 === 0 ? 4 : -4);
    });
    const zoom = await runTimedLoop(zoomFrames, (i) => {
      r.view.zoomX(i % 2 === 0 ? 1.04 : 1 / 1.04, 600);
    });

    (globalThis as any).__webgpuHeatmapBenchRecord = undefined;

    let logFallbackPaths: Record<string, string> | undefined;
    let footprintPaths: Record<string, string> | undefined;
    let nativeTextWhenHeatmapActive: boolean | undefined;
    if (checkFallbackAndLayerOrder) {
      r.updateState({ ...r.getState(), scaleMode: "log" });
      r.invalidate();
      await r.session.captureCompositePng();
      logFallbackPaths = { ...(getGpuDiagnostics().featurePaths ?? {}) };

      r.updateState({ ...r.getState(), chartType: "footprint", scaleMode: "linear" });
      r.invalidate();
      await r.session.captureCompositePng();
      footprintPaths = { ...(getGpuDiagnostics().featurePaths ?? {}) };
      nativeTextWhenHeatmapActive = r.renderer.renderedNativeFootprintText;
    }

    const fallbacks = getGpuDiagnostics().fallbacks.length;
    return {
      paths,
      adapter,
      fallbacks,
      pngB64,
      pan,
      zoom,
      logFallbackPaths,
      footprintPaths,
      nativeTextWhenHeatmapActive,
    };
  }, {
    id,
    fitColumns: fixture.fitColumns,
    panFrames: fixture.panFrames,
    zoomFrames: fixture.zoomFrames,
    residentEnabled,
    checkFallbackAndLayerOrder,
  });

  await context.close();
  expect(errors).toEqual([]);

  return {
    paths: measured.paths,
    adapter: measured.adapter,
    fallbacks: measured.fallbacks,
    pngB64: measured.pngB64,
    pan: summarizeRawScenario(measured.pan),
    zoom: summarizeRawScenario(measured.zoom),
    logFallbackPaths: measured.logFallbackPaths,
    footprintPaths: measured.footprintPaths,
    nativeTextWhenHeatmapActive: measured.nativeTextWhenHeatmapActive,
  };
}

async function computePngParity(browser: Browser, baseURL: string, aB64: string, bB64: string) {
  const ctx = await browser.newContext({ baseURL, viewport: VIEWPORT });
  const page = await ctx.newPage();
  await page.goto("/harness/blank.html");
  const parity = await page.evaluate(async ({ aB64, bB64 }) => {
    const decode = async (b64: string) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([raw], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx2d = c.getContext("2d")!;
      ctx2d.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx2d.getImageData(0, 0, c.width, c.height);
    };
    const a = await decode(aB64);
    const b = await decode(bB64);
    const total = a.width * a.height;
    let matched = 0;
    let nonBg = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.abs(b.data[i] - 18) > 4 || Math.abs(b.data[i + 1] - 20) > 4 || Math.abs(b.data[i + 2] - 26) > 4) {
        nonBg++;
      }
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
        Math.abs(a.data[i + 3] - b.data[i + 3]),
      );
      if (d <= 2) matched++;
    }
    return {
      matchRatio: total > 0 ? matched / total : 0,
      nonBg,
      total,
    };
  }, { aB64, bB64 });
  await ctx.close();
  return parity;
}

test("SwiftShader WebGPU verifies 40k-cell GPU-resident heatmap with 0 B pan/zoom upload, log fallback, and layer order", async ({ baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const browser = await launchBrowser(launchArgs(false), false);

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

    const fixture = resolveWebGpuHeatmapFixture({
      barCount: 2000,
      cellsPerBar: 20,
      fitColumns: 120,
      panFrames: 4,
      zoomFrames: 3,
    });
    const { bars, heatmapBars } = buildWebGpuHeatmapBars(fixture, FROZEN_NOW);

    const canvas2d = await measureHeatmapMode({
      browser,
      baseURL: resolvedBaseURL,
      bars,
      heatmapBars,
      fixture: { ...fixture, panFrames: 1, zoomFrames: 1 },
      residentEnabled: false,
      hardwareMode: false,
    });
    const resident = await measureHeatmapMode({
      browser,
      baseURL: resolvedBaseURL,
      bars,
      heatmapBars,
      fixture,
      residentEnabled: true,
      hardwareMode: false,
      checkFallbackAndLayerOrder: true,
    });
    const parity = await computePngParity(browser, resolvedBaseURL, canvas2d.pngB64, resident.pngB64);

    expect(parity.nonBg).toBeGreaterThan(200);
    expect(parity.matchRatio).toBeGreaterThanOrEqual(0.98);
    expect(resident.paths.heatmap).toBe("webgpu-native");
    expect(resident.paths["orderbook-heatmap"]).toBe("webgpu");
    expect(resident.pan.dataBytes).toBe(0);
    expect(resident.zoom.dataBytes).toBe(0);
    expect(resident.pan.uniformBytes).toBeGreaterThan(0);
    expect(resident.zoom.uniformBytes).toBeGreaterThan(0);
    expect(resident.pan.prepareCount).toBe(0);
    expect(resident.zoom.prepareCount).toBe(0);
    expect(resident.pan.heatmap.count).toBeGreaterThanOrEqual(4);
    expect(resident.zoom.heatmap.count).toBeGreaterThanOrEqual(3);
    expect(resident.logFallbackPaths?.heatmap).not.toBe("webgpu-native");
    expect(resident.footprintPaths?.heatmap).toBe("webgpu-native");
    expect(resident.nativeTextWhenHeatmapActive).toBe(false);
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
  const browser = await launchBrowser(launchArgs(true), true);

  try {
    const canvas2d = await measureHeatmapMode({
      browser,
      baseURL: resolvedBaseURL,
      bars,
      heatmapBars,
      fixture,
      residentEnabled: false,
      hardwareMode: true,
    });
    const resident = await measureHeatmapMode({
      browser,
      baseURL: resolvedBaseURL,
      bars,
      heatmapBars,
      fixture,
      residentEnabled: true,
      hardwareMode: true,
    });
    const parity = await computePngParity(browser, resolvedBaseURL, canvas2d.pngB64, resident.pngB64);

    const adapter = resident.adapter ?? canvas2d.adapter ?? null;
    const adapterClassification = adapter ? classifyWebGpuAdapter(adapter) : { software: true, reason: "adapter-unavailable" };
    const hardwareValid = Boolean(adapter) && !adapterClassification.software && !adapter.isFallbackAdapter;

    const ab = {
      canvas2d: { pan: canvas2d.pan, zoom: canvas2d.zoom },
      resident: { pan: resident.pan, zoom: resident.zoom },
    };
    const assessment = evaluateWebGpuHeatmapAssessment({
      hardwareValid,
      residentZeroPanZoomUpload: resident.pan.dataBytes === 0 && resident.zoom.dataBytes === 0,
      residentPrepareCallsDuringPanZoom: resident.pan.prepareCount + resident.zoom.prepareCount,
      fallbacks: canvas2d.fallbacks + resident.fallbacks,
      ab,
      parity,
    });

    const evidence = {
      issue: "#265",
      adapter,
      adapterClassification,
      hardwareValid,
      residentPanZoomDataBytes: resident.pan.dataBytes + resident.zoom.dataBytes,
      residentPanZoomUniformBytes: resident.pan.uniformBytes + resident.zoom.uniformBytes,
      residentPanZoomPrepareCount: resident.pan.prepareCount + resident.zoom.prepareCount,
      parity,
      ab,
      assessment,
    };
    console.log(`WEBGPU_HEATMAP_BENCHMARK_EVIDENCE ${JSON.stringify(evidence)}`);

    if (process.env.CHART_GPU_HEATMAP_REPORT_PATH) {
      await writeFile(process.env.CHART_GPU_HEATMAP_REPORT_PATH, JSON.stringify(evidence, null, 2));
    }

    expect(resident.pan.dataBytes).toBe(0);
    expect(resident.zoom.dataBytes).toBe(0);
    expect(resident.pan.prepareCount + resident.zoom.prepareCount).toBe(0);
    expect(parity.matchRatio).toBeGreaterThanOrEqual(0.98);
  } finally {
    await browser.close().catch(() => {});
  }
});
