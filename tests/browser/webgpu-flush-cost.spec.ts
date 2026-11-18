import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { FUNCTIONAL_WEBGL_ARGS } from "./support/history.js";
import {
  buildDenseFootprintBars,
  buildWebGpuFlushAssessment,
  WEBGPU_FLUSH_DECISION_RULE,
  WEBGPU_FLUSH_FIXTURE,
  WEBGPU_FLUSH_METRICS,
  WEBGPU_FLUSH_SCENARIOS,
} from "../../harness/webgpuFlushBenchmark.mjs";

const { viewport: VIEWPORT, markets: MARKETS, barCount: BAR_COUNT, cellsPerBar: CELLS_PER_BAR,
  priceStep: PRICE_STEP, intervalMs: INTERVAL_MS, fitColumns: FIT_COLUMNS,
  liveRatePerSecondPerMarket: LIVE_RATE_PER_SECOND_PER_MARKET,
  liveFramesPerRepetition: LIVE_FRAMES_PER_REPETITION,
  panFramesPerRepetition: PAN_FRAMES_PER_REPETITION,
  crosshairFramesPerRepetition: CROSSHAIR_FRAMES_PER_REPETITION,
  repetitions: REPETITIONS, frozenNow: FROZEN_NOW } = WEBGPU_FLUSH_FIXTURE;
const METRIC_NAMES = WEBGPU_FLUSH_METRICS;

type BackendKind = "webgl2" | "webgpu";
type ScenarioKind = (typeof WEBGPU_FLUSH_SCENARIOS)[number];
type MetricName = (typeof METRIC_NAMES)[number];

interface MetricStats {
  count: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface RepetitionMeasurement {
  repetition: number;
  frames: number;
  tradesDelivered?: number;
  metrics: Record<MetricName, MetricStats>;
}

interface BackendMeasurement {
  backend: BackendKind;
  presentation: string;
  active: string;
  requested: string;
  panelBackends: string[];
  fallbacks: unknown[];
  adapter: unknown;
  counters: Record<string, number>;
  avgQuadsPerFlush: number | null;
  crosshairInteractionOnlyGpuFlushCount: number;
  timingsMs: Record<string, number>;
  scenarios: Record<
    ScenarioKind,
    {
      repetitions: RepetitionMeasurement[];
      combined: Record<MetricName, MetricStats>;
    }
  >;
}

const HARDWARE_MODE = process.env.CHART_GPU_BENCHMARK_MODE === "hardware";

function launchArgsFor(kind: BackendKind, variant: "no-vulkan-compositor" | "vulkan-compositor" = "no-vulkan-compositor"): string[] {
  if (HARDWARE_MODE) {
    const base = [
      "--use-gl=angle",
      "--use-angle=default",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--enable-unsafe-webgpu",
      "--enable-precise-memory-info",
    ];
    return kind === "webgpu" && variant === "vulkan-compositor"
      ? [...base, "--enable-features=Vulkan"]
      : base;
  }
  if (kind === "webgl2") {
    return [...FUNCTIONAL_WEBGL_ARGS];
  }
  const base = [
    ...FUNCTIONAL_WEBGL_ARGS,
    "--enable-unsafe-webgpu",
    "--use-vulkan=swiftshader",
    "--disable-vulkan-surface",
  ];
  return variant === "vulkan-compositor" ? [...base, "--enable-features=Vulkan"] : base;
}

async function launchBackendBrowser(args: string[]): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
}

function summarize(values: readonly number[]): MetricStats {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) {
    return { count: 0, totalMs: 0, meanMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  const total = valid.reduce((sum, value) => sum + value, 0);
  const at = (quantile: number) => valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(quantile * valid.length) - 1))];
  return {
    count: valid.length,
    totalMs: round6(total),
    meanMs: round6(total / valid.length),
    minMs: round6(valid[0]),
    maxMs: round6(valid[valid.length - 1]),
    p50Ms: round6(at(0.5)),
    p95Ms: round6(at(0.95)),
    p99Ms: round6(at(0.99)),
  };
}

function summarizeBucket(bucket: Record<string, number[]> | undefined): Record<MetricName, MetricStats> {
  return Object.fromEntries(
    METRIC_NAMES.map((metric) => [metric, summarize(bucket?.[metric] ?? [])]),
  ) as Record<MetricName, MetricStats>;
}

function combineBuckets(buckets: Array<Record<string, number[]> | undefined>): Record<MetricName, MetricStats> {
  return Object.fromEntries(
    METRIC_NAMES.map((metric) => [
      metric,
      summarize(buckets.flatMap((bucket) => bucket?.[metric] ?? [])),
    ]),
  ) as Record<MetricName, MetricStats>;
}

async function installCommonRoutes(page: Page): Promise<void> {
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
      `$1globalThis.__webgpuFlushBenchRecord?.($2, $3); $4`,
    );
    if (patched === body) {
      throw new Error("Failed to instrument recordPerformanceDuration in /src/core/performanceTelemetry.ts");
    }
    const headers = { ...response.headers() };
    delete headers["content-length"];
    await route.fulfill({ status: response.status(), headers, body: patched });
  });

  let denseBars: ReturnType<typeof buildDenseFootprintBars> | null = null;
  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (!denseBars) {
      denseBars = buildDenseFootprintBars(Number.isFinite(to) ? to : FROZEN_NOW);
    }
    const served = denseBars.filter((bar) => bar.t >= from && bar.t <= to);
    const meta = url.searchParams.get("includeFootprint") === "0"
      ? { schemaVersion: 1, generatedAt: FROZEN_NOW }
      : {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          footprint: { available: true, allowed: true, priceStep: PRICE_STEP },
          footprintCoverage: {
            status: "complete",
            requestedFrom: from,
            requestedTo: to,
            coveredFrom: from,
            coveredThrough: to,
          },
        };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars: served }, meta }),
    });
  });
}

async function installWebGpuOffscreenPresentInitScript(page: Page): Promise<void> {
  // Used only when a real WebGPU canvas context cannot present. All shaders,
  // pipelines, writes, render passes and submits still use the probed adapter.
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
      let usage = 0x10 | 0x01; // RENDER_ATTACHMENT | COPY_SRC
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

async function probeWebGpuCapability(baseURL: string, variant: "no-vulkan-compositor" | "vulkan-compositor") {
  const args = launchArgsFor("webgpu", variant);
  const browser = await launchBackendBrowser(args);
  try {
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    const page = await context.newPage();
    await installCommonRoutes(page);
    await page.goto("/harness/blank.html");
    const result = await page.evaluate(async () => {
      const rafCheck = await Promise.race([
        new Promise<boolean>((resolve) => requestAnimationFrame(() => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);
      const webglCanvas = document.createElement("canvas");
      const gl = webglCanvas.getContext("webgl2");
      const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
      const webglInfo = gl
        ? {
            vendor: gl.getParameter(gl.VENDOR) as string,
            renderer: gl.getParameter(gl.RENDERER) as string,
            unmaskedVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string : null,
            unmaskedRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string : null,
            debugExtensionAvailable: Boolean(debugInfo),
          }
        : null;
      const webglIdentity = `${webglInfo?.unmaskedVendor ?? webglInfo?.vendor ?? ""} ${webglInfo?.unmaskedRenderer ?? webglInfo?.renderer ?? ""}`;
      const softwareRenderer = /swiftshader|llvmpipe|softpipe|software raster|basic render|warp device/i.test(webglIdentity);
      const gpu = (navigator as any).gpu;
      if (!gpu) {
        return { ok: false, rafWorking: rafCheck, reason: "navigator.gpu is undefined", adapterInfo: null, webglInfo, softwareRenderer, canvasPresentation: { supported: false, error: "navigator.gpu is undefined" } };
      }
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          return { ok: false, rafWorking: rafCheck, reason: "navigator.gpu.requestAdapter() returned null", adapterInfo: null, webglInfo, softwareRenderer, canvasPresentation: { supported: false, error: "adapter unavailable" } };
        }
        let adapterInfo: any = adapter.info ?? null;
        if (!adapterInfo && typeof adapter.requestAdapterInfo === "function") {
          try {
            adapterInfo = await adapter.requestAdapterInfo();
          } catch {
            adapterInfo = null;
          }
        }
        const device = await adapter.requestDevice();
        if (!device) {
          return { ok: false, rafWorking: rafCheck, reason: "adapter.requestDevice() returned null", adapterInfo, webglInfo, softwareRenderer, canvasPresentation: { supported: false, error: "device unavailable" } };
        }
        let canvasPresentation: { supported: boolean; error: string | null } = { supported: false, error: null };
        try {
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("webgpu") as any;
          if (!context) throw new Error("canvas.getContext('webgpu') returned null");
          context.configure({ device, format: gpu.getPreferredCanvasFormat(), usage: (globalThis as any).GPUTextureUsage?.RENDER_ATTACHMENT ?? 0x10 });
          const texture = context.getCurrentTexture();
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          });
          pass.end();
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          context.unconfigure?.();
          canvasPresentation = { supported: true, error: null };
        } catch (error) {
          canvasPresentation = { supported: false, error: String(error) };
        }
        device.destroy?.();
        return {
          ok: rafCheck,
          rafWorking: rafCheck,
          reason: rafCheck ? null : "requestAnimationFrame stalled",
          webglInfo,
          softwareRenderer,
          canvasPresentation,
          adapterInfo: adapterInfo
            ? {
                vendor: adapterInfo.vendor ?? null,
                architecture: adapterInfo.architecture ?? null,
                description: adapterInfo.description ?? null,
                isFallbackAdapter: adapter.isFallbackAdapter ?? null,
              }
            : { isFallbackAdapter: adapter.isFallbackAdapter ?? null },
        };
      } catch (error) {
        return { ok: false, rafWorking: rafCheck, reason: String(error), adapterInfo: null, webglInfo, softwareRenderer, canvasPresentation: { supported: false, error: String(error) } };
      }
    });
    return { variant, args, browserVersion: browser.version(), ...result };
  } finally {
    await browser.close();
  }
}

async function measureBackend(
  baseURL: string,
  backend: BackendKind,
  args: string[],
  presentationMode: "real" | "offscreen-substitute" = "offscreen-substitute",
): Promise<BackendMeasurement> {
  const browser = await launchBackendBrowser(args);
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    const page = await context.newPage();
    await installCommonRoutes(page);
    if (backend === "webgpu" && presentationMode === "offscreen-substitute") {
      await installWebGpuOffscreenPresentInitScript(page);
    }

    await page.goto(`/harness/blank.html?gpu=${backend}&fit=${FIT_COLUMNS}`);

    const result = await page.evaluate(
      async ({
        backend,
        markets,
        barCount,
        cellsPerBar,
        priceStep,
        intervalMs,
        panFrames,
        crosshairFrames,
        liveFrames,
        liveRatePerMarket,
        repetitions,
        metricNames,
      }) => {
        const timingsMs: Record<string, number> = {};
        const markStart = performance.now();
        document.body.replaceChildren();
        document.body.style.margin = "0";
        document.body.style.overflow = "hidden";

        const meta = document.createElement("meta");
        meta.setAttribute("name", "footprint-config");
        meta.setAttribute("content", `targetBars=${barCount}`);
        document.head.appendChild(meta);

        const [
          harness,
          telemetry,
          diagnostics,
          { ChartChange },
          { DEFAULT_VOLUME_PROFILE_SETTINGS },
          { normalizePreviousWeekStrategySettings },
          { normalizeMondayRangeSettings },
          { DrawingManager },
          webgpuDeviceModule,
        ] = await Promise.all([
          import("/harness/chart.ts"),
          import("/src/core/performanceTelemetry.ts"),
          import("/src/core/gpu/gpuDiagnostics.ts"),
          import("/src/core/render/scene/chartScene.ts"),
          import("/src/core/analysis/volumeProfile.ts"),
          import("/src/core/analysis/previousWeekStrategy.ts"),
          import("/src/core/analysis/mondayRange.ts"),
          import("/src/features/drawings/drawingManager.ts"),
          import("/src/core/gpu/webgpu/webgpuDevice.ts"),
        ]);

        const nextRaf = () =>
          Promise.race([
            new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`rAF stalled >5000ms on ${backend}`)), 5_000)),
          ]);

        const tracked = new Set<string>(metricNames);
        let activeBucket: Record<string, number[]> | null = null;
        (globalThis as any).__webgpuFlushBenchRecord = (name: string, durationMs: number) => {
          if (!activeBucket || !tracked.has(name)) return;
          (activeBucket[name] ??= []).push(durationMs);
        };

        const tradeListeners = new Map<string, Set<(trade: any) => void>>();
        const roots: HTMLDivElement[] = [];
        const handles: Array<{ dispose(): void }> = [];
        const panelIds = markets.map((_: string, idx: number) => `webgpu-flush-${backend}-${idx}`);
        const cellW = 800;
        const cellH = 450;

        for (let idx = 0; idx < markets.length; idx++) {
          const market = markets[idx];
          const root = document.createElement("div");
          root.style.cssText = `position:fixed;left:${(idx % 2) * cellW}px;top:${Math.floor(idx / 2) * cellH}px;width:${cellW}px;height:${cellH}px;`;
          document.body.appendChild(root);
          roots.push(root);

          const drawings = new DrawingManager(() => {});
          drawings.setMarket(market);
          const analysisContext = {
            market,
            profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
            previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
            previousWeekStrategyLevels: [],
            mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
            mondayRangeLevels: [],
            nakedPocs: [],
            referenceLevels: [],
            drawings,
          };
          const services = {
            subscribeToTrades(subMarket: string, cb: (trade: any) => void) {
              let set = tradeListeners.get(subMarket);
              if (!set) tradeListeners.set(subMarket, (set = new Set()));
              set.add(cb);
              return () => { set!.delete(cb); };
            },
            fetchPriceStep: async () => priceStep,
            fetchPriceStepResult: async () => ({ step: priceStep, resolved: true }),
            fetchPricePrecision: async () => 1,
            fetchHistory: async () => [],
            fetchNpocSnapshot: () => new Promise(() => {}),
            getAnalysisContext: () => analysisContext,
            notify() {},
            getAnalysisRevisionSnapshot: (m = market) => ({
              market: m,
              revision: 1,
              canonical: { status: "complete" as const, market: m, runKey: `${m}|${priceStep}`, generation: 1, revision: 1, failedPeriods: [] },
            }),
            subscribeAnalysis: () => () => {},
            subscribeAnalysisRevision: () => () => {},
            updateAnalysisFromSeries: () => {},
            notifyActiveMarket: () => {},
            notifyInteractiveCandlesReady() {},
            notifyInteractiveHistorySettled() {},
            triggerAutoSync() {},
            isFootprintSyncBusy: () => false,
            notifyBarClose() {},
          };

          const handle = harness.mountChart(
            root,
            { type: "chart", market, timeframe: "1m", scaleMode: "linear", chartType: "footprint", candles: true } as any,
            services as any,
            panelIds[idx],
            harness.createChartSurfaceModel(),
          );
          handles.push(handle);
        }
        timingsMs.mount = Math.round(performance.now() - markStart);

        const runtimes = () => panelIds.map((id: string) => harness.getChartRuntime(id)!);
        const readyStart = performance.now();
        const readyDeadline = readyStart + 30_000;
        while (true) {
          const allReady = runtimes().every((runtime) => {
            if (!runtime) return false;
            const len = runtime.pipeline.series.length;
            if (len < barCount) return false;
            const lastTime = runtime.pipeline.series.timeOfIndex(len - 1);
            const snap = runtime.getAnalysisSnapshot({
              now: lastTime + intervalMs,
              visibleTimeRange: { from: lastTime - intervalMs * 4, to: lastTime },
              maxLevelsAndDrawings: 0,
              maxIndicatorSamples: 0,
            });
            return snap.candles.length >= 4 && snap.candles.every((c: any) => (c.footprint?.length ?? 0) === cellsPerBar);
          });
          if (allReady) break;
          if (performance.now() > readyDeadline) {
            throw new Error(`Timed out waiting for 4 dense footprint charts on ${backend}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        timingsMs.load = Math.round(performance.now() - readyStart);

        const panelBackends = roots.map((root) => {
          const hook = root.querySelector('[data-testid="chart-hook"]');
          return hook?.getAttribute("data-gpu-backend") ?? "missing";
        });

        const syncBackendWork = async () => {
          if (backend === "webgpu") {
            const handle = await webgpuDeviceModule.requestWebGpuDevice();
            await handle?.device?.queue?.onSubmittedWorkDone?.();
          } else {
            for (const runtime of runtimes()) {
              const surface = runtime.session.getSurface() as any;
              surface?.getGlContext?.()?.finish?.();
            }
          }
          await nextRaf();
        };

        // Warm up GPU pipelines before enabling measurement telemetry.
        const warmupStart = performance.now();
        telemetry.configurePerformanceTelemetry({ enabled: false });
        for (let frame = 0; frame < 16; frame++) {
          const stepX = frame < 8 ? 4 : -4;
          for (const runtime of runtimes()) {
            runtime.view.offsetX += stepX;
            runtime.session.invalidate(ChartChange.Viewport);
          }
          await nextRaf();
        }
        await syncBackendWork();
        timingsMs.warmup = Math.round(performance.now() - warmupStart);

        const wasEnabled = telemetry.isPerformanceTelemetryEnabled();
        telemetry.configurePerformanceTelemetry({ enabled: true });

        // Verify current Interaction-only crosshair move keeps GPU scene clean.
        const interactionCheckBucket: Record<string, number[]> = {};
        activeBucket = interactionCheckBucket;
        for (let frame = 0; frame < 8; frame++) {
          for (const runtime of runtimes()) {
            const area = runtime.view.area;
            (runtime as any).crosshair.x = area.left + 40 + frame * 15;
            (runtime as any).crosshair.y = area.top + 40 + frame * 10;
            (runtime as any).crosshair.visible = true;
            runtime.session.invalidate(ChartChange.Interaction);
          }
          await nextRaf();
        }
        activeBucket = null;
        const crosshairInteractionOnlyGpuFlushCount = (interactionCheckBucket["chart.gpu.flush.ms"] ?? []).length;

        const scenarioBuckets: Record<ScenarioKind, Array<{ frames: number; tradesDelivered?: number; bucket: Record<string, number[]> }>> = {
          pan: [],
          live: [],
          crosshair: [],
        };

        // 1. PAN: move viewport back and forth every rAF across all 4 charts concurrently.
        const panStart = performance.now();
        for (let rep = 0; rep < repetitions; rep++) {
          const bucket: Record<string, number[]> = {};
          activeBucket = bucket;
          const half = Math.floor(panFrames / 2);
          for (let frame = 0; frame < panFrames; frame++) {
            // Positive offsetX shifts bar 0 right (pans backward into older bars),
            // keeping all 60 visible columns filled across the entire sweep.
            const stepX = frame < half ? 6 : -6;
            for (const runtime of runtimes()) {
              runtime.view.offsetX += stepX;
              runtime.session.invalidate(ChartChange.Viewport);
            }
            await nextRaf();
          }
          activeBucket = null;
          await syncBackendWork();
          scenarioBuckets.pan.push({ frames: panFrames, bucket });
        }
        timingsMs.pan = Math.round(performance.now() - panStart);

        // 2. LIVE: deliver trades at 200 trades/s per market across fixed rAF ticks for balanced samples.
        const liveStart = performance.now();
        let tradeSeq = 1;
        for (let rep = 0; rep < repetitions; rep++) {
          const baseTimes = runtimes().map((runtime) => {
            const s = runtime.pipeline.series;
            return s.timeOfIndex(s.length - 1);
          });
          const bucket: Record<string, number[]> = {};
          activeBucket = bucket;
          let tradesDelivered = 0;
          const startedAt = performance.now();
          let lastTickAt = startedAt;
          let carryTrades = 0;
          for (let frame = 0; frame < liveFrames; frame++) {
            const now = performance.now();
            const dt = Math.max(16, Math.min(100, now - lastTickAt));
            lastTickAt = now;
            carryTrades += (liveRatePerMarket * dt) / 1_000;
            const perMarketCount = Math.max(1, Math.floor(carryTrades));
            carryTrades = Math.max(0, carryTrades - perMarketCount);
            for (let mIdx = 0; mIdx < markets.length; mIdx++) {
              const listeners = tradeListeners.get(markets[mIdx]);
              if (!listeners || listeners.size === 0) continue;
              const ts = baseTimes[mIdx] + Math.min(intervalMs - 1_000, Math.floor(now - startedAt));
              for (let tIdx = 0; tIdx < perMarketCount; tIdx++) {
                const price = 60_000 + ((tradeSeq + tIdx) % cellsPerBar) * priceStep;
                const trade = {
                  price,
                  qty: 0.25 + ((tradeSeq + tIdx) % 5) * 0.1,
                  time: ts,
                  isBuyerMaker: (tradeSeq + tIdx) % 2 === 0,
                  id: `live-${backend}-${rep}-${tradeSeq}`,
                };
                tradeSeq++;
                for (const cb of listeners) cb(trade);
                tradesDelivered++;
              }
            }
            await nextRaf();
          }
          for (let drain = 0; drain < 4; drain++) await nextRaf();
          activeBucket = null;
          await syncBackendWork();
          scenarioBuckets.live.push({ frames: liveFrames, tradesDelivered, bucket });
        }
        timingsMs.live = Math.round(performance.now() - liveStart);

        // 3. CROSSHAIR + static-scene GPU redraw comparison (issue #88 fixture baseline).
        const crosshairStart = performance.now();
        for (let rep = 0; rep < repetitions; rep++) {
          const bucket: Record<string, number[]> = {};
          activeBucket = bucket;
          for (let frame = 0; frame < crosshairFrames; frame++) {
            for (const runtime of runtimes()) {
              const area = runtime.view.area;
              (runtime as any).crosshair.x = area.left + 24 + ((frame * 9) % Math.max(120, Math.floor(area.width - 48)));
              (runtime as any).crosshair.y = area.top + 24 + ((frame * 5) % Math.max(80, Math.floor(area.height - 48)));
              (runtime as any).crosshair.visible = true;
              runtime.session.invalidate(ChartChange.GpuContext | ChartChange.Interaction);
            }
            await nextRaf();
          }
          activeBucket = null;
          await syncBackendWork();
          scenarioBuckets.crosshair.push({ frames: crosshairFrames, bucket });
        }
        timingsMs.crosshair = Math.round(performance.now() - crosshairStart);

        const telemetrySnap = telemetry.snapshotPerformanceTelemetry();
        const diag = diagnostics.getGpuDiagnostics();
        telemetry.configurePerformanceTelemetry({ enabled: wasEnabled });

        for (const handle of handles) handle.dispose();
        for (const root of roots) root.remove();
        delete (globalThis as any).__webgpuFlushBenchRecord;

        return {
          diag,
          panelBackends,
          counters: telemetrySnap.counters,
          crosshairInteractionOnlyGpuFlushCount,
          timingsMs,
          scenarioBuckets,
        };
      },
      {
        backend,
        markets: [...MARKETS],
        barCount: BAR_COUNT,
        cellsPerBar: CELLS_PER_BAR,
        priceStep: PRICE_STEP,
        intervalMs: INTERVAL_MS,
        panFrames: PAN_FRAMES_PER_REPETITION,
        crosshairFrames: CROSSHAIR_FRAMES_PER_REPETITION,
        liveFrames: LIVE_FRAMES_PER_REPETITION,
        liveRatePerMarket: LIVE_RATE_PER_SECOND_PER_MARKET,
        repetitions: REPETITIONS,
        metricNames: [...METRIC_NAMES],
      },
    );

    const scenarios = {
      pan: {
        repetitions: result.scenarioBuckets.pan.map((entry, idx) => ({
          repetition: idx + 1,
          frames: entry.frames,
          metrics: summarizeBucket(entry.bucket),
        })),
        combined: combineBuckets(result.scenarioBuckets.pan.map((entry) => entry.bucket)),
      },
      live: {
        repetitions: result.scenarioBuckets.live.map((entry, idx) => ({
          repetition: idx + 1,
          frames: entry.frames,
          tradesDelivered: entry.tradesDelivered,
          metrics: summarizeBucket(entry.bucket),
        })),
        combined: combineBuckets(result.scenarioBuckets.live.map((entry) => entry.bucket)),
      },
      crosshair: {
        repetitions: result.scenarioBuckets.crosshair.map((entry, idx) => ({
          repetition: idx + 1,
          frames: entry.frames,
          metrics: summarizeBucket(entry.bucket),
        })),
        combined: combineBuckets(result.scenarioBuckets.crosshair.map((entry) => entry.bucket)),
      },
    };

    const totalFlushCount =
      scenarios.pan.combined["chart.gpu.flush.ms"].count
      + scenarios.live.combined["chart.gpu.flush.ms"].count
      + scenarios.crosshair.combined["chart.gpu.flush.ms"].count;
    const uploadBytes = result.counters["gpu.upload.bytes"];
    const avgQuadsPerFlush =
      typeof uploadBytes === "number" && totalFlushCount > 0
        ? Math.round(uploadBytes / 20 / totalFlushCount)
        : null;

    return {
      backend,
      presentation: backend === "webgpu" ? presentationMode : "real",
      active: result.diag.active,
      requested: result.diag.requested,
      panelBackends: result.panelBackends,
      fallbacks: result.diag.fallbacks,
      adapter: result.diag.adapter ?? null,
      counters: result.counters,
      avgQuadsPerFlush,
      crosshairInteractionOnlyGpuFlushCount: result.crosshairInteractionOnlyGpuFlushCount,
      timingsMs: result.timingsMs,
      scenarios,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

test("four-chart WebGPU vs WebGL2 chart.gpu.flush.ms comparison across pan, live and crosshair", async ({ baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const evidencePath = process.env.CHART_GPU_BENCHMARK_FLUSH_REPORT_PATH;
  const primaryProbe = await probeWebGpuCapability(resolvedBaseURL, "no-vulkan-compositor");
  let webgpuProbe = primaryProbe;
  if (!primaryProbe.ok || (HARDWARE_MODE && !primaryProbe.canvasPresentation?.supported)) {
    const fallbackProbe = await probeWebGpuCapability(resolvedBaseURL, "vulkan-compositor");
    if (!primaryProbe.ok || fallbackProbe.canvasPresentation?.supported) webgpuProbe = fallbackProbe;
  }
  console.log("WEBGPU_PROBE_SELECTED", JSON.stringify(webgpuProbe));

  const hardwareInvalidReasons: string[] = [];
  if (!webgpuProbe.ok) hardwareInvalidReasons.push(`webgpu-adapter-unavailable:${webgpuProbe.reason ?? "unknown"}`);
  if (!webgpuProbe.webglInfo?.debugExtensionAvailable
    || !webgpuProbe.webglInfo?.unmaskedRenderer
    || !webgpuProbe.webglInfo?.unmaskedVendor) {
    hardwareInvalidReasons.push("webgl-renderer-identity-unavailable");
  }
  if (webgpuProbe.softwareRenderer || webgpuProbe.adapterInfo?.isFallbackAdapter === true) {
    hardwareInvalidReasons.push("software-renderer");
  }
  const hardwareValid = HARDWARE_MODE && hardwareInvalidReasons.length === 0;
  const presentationMode = HARDWARE_MODE && webgpuProbe.canvasPresentation?.supported
    ? "real"
    : "offscreen-substitute";

  const environment = {
    browserVersion: webgpuProbe.browserVersion ?? null,
    operatingSystem: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    launchArgs: webgpuProbe.args,
    webglRenderer: webgpuProbe.webglInfo ?? null,
    webgpuAdapter: webgpuProbe.adapterInfo ?? null,
    canvasPresentationProbe: webgpuProbe.canvasPresentation ?? null,
  };
  const fixture = {
    ...WEBGPU_FLUSH_FIXTURE,
    charts: MARKETS.length,
    layout: "2x2",
    panelSize: "800x450",
    viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
    avgQuadsPerFlushWebgl2: null,
  };

  const writeEvidence = async (report: Record<string, unknown>) => {
    console.log("WEBGPU_FLUSH_COMPARISON_EVIDENCE", JSON.stringify(report));
    await testInfo.attach("webgpu-flush-comparison-evidence.json", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  };

  if (HARDWARE_MODE && !hardwareValid) {
    const assessment = buildWebGpuFlushAssessment({ hardwareValid: false });
    await writeEvidence({
      schemaVersion: 1,
      issue: "#88",
      hardwareValid: false,
      hardwareInvalidReasons,
      decisionRule: WEBGPU_FLUSH_DECISION_RULE,
      ...assessment,
      presentation: presentationMode,
      fixture,
      environment,
      webgpuProbe,
      webgl2: null,
      webgpu: null,
    });
    return;
  }

  if (!webgpuProbe.ok) {
    test.skip(true, `BLOCKED: WebGPU adapter/device unavailable in headless runtime (${webgpuProbe.reason}; never counted green)`);
  }

  let webgl2: BackendMeasurement | null = null;
  let webgpu: BackendMeasurement | null = null;
  try {
    webgl2 = await measureBackend(resolvedBaseURL, "webgl2", launchArgsFor("webgl2"), "real");
    console.log("WEBGPU_BENCH_WEBGL2_DONE", JSON.stringify({ timingsMs: webgl2.timingsMs, avgQuadsPerFlush: webgl2.avgQuadsPerFlush }));

    webgpu = await measureBackend(resolvedBaseURL, "webgpu", webgpuProbe.args, presentationMode);
    console.log("WEBGPU_BENCH_WEBGPU_DONE", JSON.stringify({ timingsMs: webgpu.timingsMs, active: webgpu.active, panelBackends: webgpu.panelBackends }));
  } catch (error) {
    const measurementError = error instanceof Error ? error.stack ?? error.message : String(error);
    const assessment = buildWebGpuFlushAssessment({ hardwareValid, webgl2, webgpu, measurementError });
    await writeEvidence({
      schemaVersion: 1,
      issue: "#88",
      hardwareValid,
      hardwareInvalidReasons,
      decisionRule: WEBGPU_FLUSH_DECISION_RULE,
      ...assessment,
      presentation: presentationMode,
      fixture,
      environment,
      webgpuProbe,
      webgl2,
      webgpu,
    });
    throw error;
  }

  const assessment = buildWebGpuFlushAssessment({ hardwareValid, webgl2, webgpu });
  const report = {
    schemaVersion: 1,
    issue: "#88",
    hardwareValid,
    hardwareInvalidReasons,
    decisionRule: WEBGPU_FLUSH_DECISION_RULE,
    ...assessment,
    presentation: presentationMode,
    fixture: { ...fixture, avgQuadsPerFlushWebgl2: webgl2.avgQuadsPerFlush },
    environment,
    webgpuProbe,
    webgl2,
    webgpu,
  };

  await writeEvidence(report);

  expect(webgl2.active).toBe("webgl2");
  expect(webgl2.panelBackends).toEqual(["webgl2", "webgl2", "webgl2", "webgl2"]);
  expect(webgl2.avgQuadsPerFlush ?? 0).toBeGreaterThanOrEqual(4_000);
  expect(webgl2.crosshairInteractionOnlyGpuFlushCount).toBe(0);

  expect(webgpu.active).toBe("webgpu");
  expect(webgpu.panelBackends).toEqual(["webgpu", "webgpu", "webgpu", "webgpu"]);
  expect(webgpu.fallbacks).toEqual([]);
  expect(webgpu.crosshairInteractionOnlyGpuFlushCount).toBe(0);

  for (const scenario of WEBGPU_FLUSH_SCENARIOS) {
    for (const rep of webgl2.scenarios[scenario].repetitions) {
      expect(rep.metrics["chart.gpu.flush.ms"].count, `webgl2 ${scenario} rep ${rep.repetition} count`).toBeGreaterThan(0);
    }
    for (const rep of webgpu.scenarios[scenario].repetitions) {
      expect(rep.metrics["chart.gpu.flush.ms"].count, `webgpu ${scenario} rep ${rep.repetition} count`).toBeGreaterThan(0);
    }
  }
});
