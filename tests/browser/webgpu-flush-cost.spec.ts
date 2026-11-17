import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS } from "./support/history.js";

const VIEWPORT = { width: 1600, height: 900 };
const MARKETS = [
  "BINANCE_FUTURES:btcusdt",
  "BINANCE_FUTURES:ethusdt",
  "BINANCE_FUTURES:solusdt",
  "BINANCE_FUTURES:avaxusdt",
] as const;
const BAR_COUNT = 600;
const CELLS_PER_BAR = 40;
const PRICE_STEP = 10;
const INTERVAL_MS = 60_000;
const FIT_COLUMNS = 60;
const LIVE_RATE_PER_SECOND_PER_MARKET = 200;
const LIVE_DURATION_MS = 2_000;
const PAN_FRAMES_PER_REPETITION = 120;
const CROSSHAIR_FRAMES_PER_REPETITION = 120;
const REPETITIONS = 2;
const METRIC_NAMES = [
  "chart.gpu.flush.ms",
  "chart.gpu.footprint.ms",
  "chart.surface.gpu.draw.ms",
  "chart.frame.render.ms",
] as const;

type BackendKind = "webgl2" | "webgpu";
type ScenarioKind = "pan" | "live" | "crosshair";
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
  scenarios: Record<
    ScenarioKind,
    {
      repetitions: RepetitionMeasurement[];
      combined: Record<MetricName, MetricStats>;
    }
  >;
}

test.use({
  launchOptions: {
    args: [
      ...FUNCTIONAL_WEBGL_ARGS,
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan=swiftshader",
      "--disable-vulkan-surface",
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: VIEWPORT,
});

function summarize(values: readonly number[]): MetricStats {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) {
    return { count: 0, totalMs: 0, meanMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const round3 = (value: number) => Math.round(value * 1_000) / 1_000;
  const total = valid.reduce((sum, value) => sum + value, 0);
  const at = (quantile: number) => valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(quantile * valid.length) - 1))];
  return {
    count: valid.length,
    totalMs: round3(total),
    meanMs: round3(total / valid.length),
    minMs: round3(valid[0]),
    maxMs: round3(valid[valid.length - 1]),
    p50Ms: round3(at(0.5)),
    p95Ms: round3(at(0.95)),
    p99Ms: round3(at(0.99)),
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

function buildDenseFootprintBars(anchorTo: number) {
  const bucketEnd = Math.floor(anchorTo / INTERVAL_MS) * INTERVAL_MS;
  const firstTime = bucketEnd - BAR_COUNT * INTERVAL_MS;
  const basePrice = 60_000;
  return Array.from({ length: BAR_COUNT }, (_, barIndex) => {
    const time = firstTime + barIndex * INTERVAL_MS;
    const low = basePrice;
    const high = basePrice + (CELLS_PER_BAR - 1) * PRICE_STEP;
    const open = basePrice + (10 + (barIndex % 6)) * PRICE_STEP;
    const close = basePrice + (28 - (barIndex % 6)) * PRICE_STEP;
    let totalBuy = 0;
    let totalSell = 0;
    const cells: Array<[number, number, number, number, number]> = [];
    for (let cellIndex = 0; cellIndex < CELLS_PER_BAR; cellIndex++) {
      const priceBin = low + cellIndex * PRICE_STEP;
      const buyVol = Number((1.2 + ((barIndex + cellIndex) % 7) * 0.45).toFixed(2));
      const sellVol = Number((1.1 + ((barIndex * 3 + cellIndex) % 7) * 0.4).toFixed(2));
      totalBuy += buyVol;
      totalSell += sellVol;
      cells.push([priceBin, buyVol, sellVol, 0, 0]);
    }
    return {
      t: time,
      o: open,
      h: high,
      l: low,
      c: close,
      v: Number((totalBuy + totalSell).toFixed(2)),
      d: Number((totalBuy - totalSell).toFixed(2)),
      n: CELLS_PER_BAR * 2,
      cells,
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: FROZEN_NOW,
    };
  });
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
  // Same headless SwiftShader workaround as issue #88/#87: canvas presentation
  // loses the device in software-only Chromium, so getContext("webgpu") returns a
  // device-backed offscreen texture of the same dimensions while keeping all
  // shaders, pipelines, uniform/instance writeBuffers, render passes and submits real.
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

async function probeWebGpuCapability(browser: Browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await installCommonRoutes(page);
    await page.goto("/harness/blank.html");
    return await page.evaluate(async () => {
      const gpu = (navigator as any).gpu;
      if (!gpu) {
        return { ok: false, reason: "navigator.gpu is undefined", adapterInfo: null };
      }
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          return { ok: false, reason: "navigator.gpu.requestAdapter() returned null", adapterInfo: null };
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
          return { ok: false, reason: "adapter.requestDevice() returned null", adapterInfo };
        }
        device.destroy?.();
        return {
          ok: true,
          reason: null,
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
        return { ok: false, reason: String(error), adapterInfo: null };
      }
    });
  } finally {
    await context.close();
  }
}

async function measureBackend(browser: Browser, backend: BackendKind): Promise<BackendMeasurement> {
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await installCommonRoutes(page);
    if (backend === "webgpu") {
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
        liveDurationMs,
        liveRatePerMarket,
        repetitions,
        metricNames,
      }) => {
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
          { webgpuDeviceModule },
        ] = await Promise.all([
          import("/harness/chart.ts"),
          import("/src/core/performanceTelemetry.ts"),
          import("/src/core/gpu/gpuDiagnostics.ts"),
          import("/src/core/render/scene/chartScene.ts"),
          import("/src/core/analysis/volumeProfile.ts"),
          import("/src/core/analysis/previousWeekStrategy.ts"),
          import("/src/core/analysis/mondayRange.ts"),
          import("/src/features/drawings/drawingManager.ts"),
          import("/src/core/gpu/webgpu/webgpuDevice.ts").then((m) => ({ webgpuDeviceModule: m })),
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

        const runtimes = () => panelIds.map((id: string) => harness.getChartRuntime(id)!);
        const readyDeadline = performance.now() + 60_000;
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

        const panelBackends = roots.map((root) => {
          const hook = root.querySelector('[data-testid="chart-hook"]');
          return hook?.getAttribute("data-gpu-backend") ?? "missing";
        });

        const nextRaf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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

        // 2. LIVE: deliver 200 trades/s per market for LIVE_DURATION_MS across all 4 charts.
        let tradeSeq = 1;
        for (let rep = 0; rep < repetitions; rep++) {
          const baseTimes = runtimes().map((runtime) => {
            const s = runtime.pipeline.series;
            return s.timeOfIndex(s.length - 1);
          });
          const bucket: Record<string, number[]> = {};
          activeBucket = bucket;
          let tradesDelivered = 0;
          let rAFTicks = 0;
          const startedAt = performance.now();
          let lastTickAt = startedAt;
          let carryTrades = 0;
          while (performance.now() - startedAt < liveDurationMs) {
            await nextRaf();
            rAFTicks++;
            const now = performance.now();
            const dt = Math.max(0, Math.min(100, now - lastTickAt));
            lastTickAt = now;
            carryTrades += (liveRatePerMarket * dt) / 1_000;
            const perMarketCount = Math.floor(carryTrades);
            carryTrades -= perMarketCount;
            if (perMarketCount > 0) {
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
            }
          }
          // Let any queued tail trades flush cleanly inside the live bucket.
          for (let drain = 0; drain < 6; drain++) await nextRaf();
          activeBucket = null;
          await syncBackendWork();
          scenarioBuckets.live.push({ frames: rAFTicks, tradesDelivered, bucket });
        }

        // 3. CROSSHAIR + static-scene GPU redraw comparison (issue #88 fixture baseline).
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
        liveDurationMs: LIVE_DURATION_MS,
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
      presentation: backend === "webgpu" ? "offscreen device texture (swapchain bypassed per #87/#88)" : "native canvas",
      active: result.diag.active,
      requested: result.diag.requested,
      panelBackends: result.panelBackends,
      fallbacks: result.diag.fallbacks,
      adapter: result.diag.adapter ?? null,
      counters: result.counters,
      avgQuadsPerFlush,
      crosshairInteractionOnlyGpuFlushCount: result.crosshairInteractionOnlyGpuFlushCount,
      scenarios,
    };
  } finally {
    await context?.close();
  }
}

test("four-chart WebGPU vs WebGL2 chart.gpu.flush.ms comparison across pan, live and crosshair", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);

  const webgpuProbe = await probeWebGpuCapability(browser);
  if (!webgpuProbe.ok) {
    console.log("WEBGPU_PROBE_UNAVAILABLE", JSON.stringify(webgpuProbe));
    test.skip(true, `BLOCKED: WebGPU adapter/device unavailable in headless runtime (${webgpuProbe.reason}; never counted green)`);
  }

  const webgl2 = await measureBackend(browser, "webgl2");
  const webgpu = await measureBackend(browser, "webgpu");

  expect(webgl2.active).toBe("webgl2");
  expect(webgl2.panelBackends).toEqual(["webgl2", "webgl2", "webgl2", "webgl2"]);
  expect(webgl2.avgQuadsPerFlush ?? 0).toBeGreaterThanOrEqual(4_000);
  expect(webgl2.crosshairInteractionOnlyGpuFlushCount).toBe(0);

  expect(webgpu.active).toBe("webgpu");
  expect(webgpu.panelBackends).toEqual(["webgpu", "webgpu", "webgpu", "webgpu"]);
  expect(webgpu.fallbacks).toEqual([]);
  expect(webgpu.crosshairInteractionOnlyGpuFlushCount).toBe(0);

  const comparison = (["pan", "live", "crosshair"] as const).map((scenario) => {
    const glFlush = webgl2.scenarios[scenario].combined["chart.gpu.flush.ms"];
    const gpuFlush = webgpu.scenarios[scenario].combined["chart.gpu.flush.ms"];
    const glFootprint = webgl2.scenarios[scenario].combined["chart.gpu.footprint.ms"];
    const gpuFootprint = webgpu.scenarios[scenario].combined["chart.gpu.footprint.ms"];
    const glDraw = webgl2.scenarios[scenario].combined["chart.surface.gpu.draw.ms"];
    const gpuDraw = webgpu.scenarios[scenario].combined["chart.surface.gpu.draw.ms"];

    for (const rep of webgl2.scenarios[scenario].repetitions) {
      expect(rep.metrics["chart.gpu.flush.ms"].count, `webgl2 ${scenario} rep ${rep.repetition} count`).toBeGreaterThan(0);
    }
    for (const rep of webgpu.scenarios[scenario].repetitions) {
      expect(rep.metrics["chart.gpu.flush.ms"].count, `webgpu ${scenario} rep ${rep.repetition} count`).toBeGreaterThan(0);
    }

    const round3 = (v: number) => Math.round(v * 1_000) / 1_000;
    const flushMeanRatio = glFlush.meanMs > 0 ? round3(gpuFlush.meanMs / glFlush.meanMs) : null;
    return {
      scenario,
      webgl2: { flush: glFlush, footprint: glFootprint, surfaceGpuDraw: glDraw },
      webgpu: { flush: gpuFlush, footprint: gpuFootprint, surfaceGpuDraw: gpuDraw },
      flushMeanRatio,
      within2xBudget: flushMeanRatio !== null ? flushMeanRatio <= 2 : null,
    };
  });

  const report = {
    fixture: {
      charts: MARKETS.length,
      layout: "2x2",
      panelSize: "800x450",
      viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
      barsPerChart: BAR_COUNT,
      cellsPerBar: CELLS_PER_BAR,
      fitColumns: FIT_COLUMNS,
      liveRatePerMarketPerSecond: LIVE_RATE_PER_SECOND_PER_MARKET,
      repetitions: REPETITIONS,
      avgQuadsPerFlushWebgl2: webgl2.avgQuadsPerFlush,
    },
    webgpuProbe,
    webgl2,
    webgpu,
    comparison,
  };

  console.log("WEBGPU_FLUSH_COMPARISON_EVIDENCE", JSON.stringify(report));
  await testInfo.attach("webgpu-flush-comparison-evidence.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
});
