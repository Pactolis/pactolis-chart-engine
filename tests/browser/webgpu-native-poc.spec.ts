import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { FUNCTIONAL_WEBGL_ARGS } from "./support/history.js";
import {
  buildDenseFootprintBars,
  buildWebGpuNativeAssessment,
  classifyWebGpuAdapter,
  computeMissedFrameStats,
  computeUploadStats,
  readWebGpuAdapterIdentity,
  resolveWebGpuNativeFixture,
  selectWebGpuProbe,
  shouldTryWebGpuVulkan,
  summarizeMetricValues,
  WEBGPU_NATIVE_METRICS,
  WEBGPU_NATIVE_SCENARIOS,
  webGpuFlushHardwareInvalidReasons,
  webGpuFlushLaunchArgs,
} from "../../harness/webgpuNativeBenchmark.mjs";

const ACTIVE_FIXTURE = resolveWebGpuNativeFixture({
  profile: process.env.CHART_GPU_NATIVE_PROFILE,
  barCount: process.env.CHART_GPU_NATIVE_BARS,
  cellsPerBar: process.env.CHART_GPU_NATIVE_CELLS,
  fitColumns: process.env.CHART_GPU_NATIVE_FIT,
});

const {
  viewport: VIEWPORT,
  markets: MARKETS,
  barCount: BAR_COUNT,
  cellsPerBar: CELLS_PER_BAR,
  priceStep: PRICE_STEP,
  intervalMs: INTERVAL_MS,
  fitColumns: FIT_COLUMNS,
  liveRatePerSecondPerMarket: LIVE_RATE_PER_SECOND_PER_MARKET,
  liveFramesPerRepetition: LIVE_FRAMES_PER_REPETITION,
  panFramesPerRepetition: PAN_FRAMES_PER_REPETITION,
  zoomFramesPerRepetition: ZOOM_FRAMES_PER_REPETITION,
  liveRolloverFramesPerRepetition: LIVE_ROLLOVER_FRAMES_PER_REPETITION,
  liveRolloverEveryFrames: LIVE_ROLLOVER_EVERY_FRAMES,
  repetitions: REPETITIONS,
  frozenNow: FROZEN_NOW,
  missedFrameThresholdMs: MISSED_FRAME_THRESHOLD_MS,
} = ACTIVE_FIXTURE;

const READY_TIMEOUT_MS = ACTIVE_FIXTURE.profile === "large" ? 90_000 : 30_000;

type NativeMode = "immediate" | "gpu-native";
type WebGpuVariant = "no-vulkan-compositor" | "vulkan-compositor";
type ScenarioKind = (typeof WEBGPU_NATIVE_SCENARIOS)[number];
type MetricName = (typeof WEBGPU_NATIVE_METRICS)[number];

const HARDWARE_MODE = process.env.CHART_GPU_BENCHMARK_MODE === "hardware";

function launchArgsFor(variant: WebGpuVariant = "no-vulkan-compositor"): string[] {
  return webGpuFlushLaunchArgs({
    kind: "webgpu",
    variant,
    hardwareMode: HARDWARE_MODE,
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

async function installCommonRoutes(page: Page, sharedAnchorTo: number): Promise<void> {
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
      `$1globalThis.__webgpuNativeBenchRecord?.($2, $3); $4`,
    );
    if (patched === body) {
      throw new Error("Failed to instrument recordPerformanceDuration in /src/core/performanceTelemetry.ts");
    }
    const headers = { ...response.headers() };
    delete headers["content-length"];
    await route.fulfill({ status: response.status(), headers, body: patched });
  });

  const denseBars = buildDenseFootprintBars(sharedAnchorTo, ACTIVE_FIXTURE);
  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const served = denseBars;
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

async function probeWebGpuCapability(baseURL: string, variant: WebGpuVariant, sharedAnchorTo: number) {
  const args = launchArgsFor(variant);
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser(args);
    const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    const page = await context.newPage();
    await installCommonRoutes(page, sharedAnchorTo);
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
        return {
          ok: false,
          rafWorking: rafCheck,
          reason: "navigator.gpu is undefined",
          adapterInfo: null,
          webglInfo,
          softwareRenderer,
          timestampQuerySupported: false,
          canvasPresentation: { supported: false, error: "navigator.gpu is undefined" },
        };
      }
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          return {
            ok: false,
            rafWorking: rafCheck,
            reason: "navigator.gpu.requestAdapter() returned null",
            adapterInfo: null,
            webglInfo,
            softwareRenderer,
            timestampQuerySupported: false,
            canvasPresentation: { supported: false, error: "adapter unavailable" },
          };
        }
        const { readWebGpuAdapterIdentity } = await import("/harness/webgpuNativeBenchmark.mjs");
        const adapterInfo = await readWebGpuAdapterIdentity(adapter);
        const wantsTs = Boolean(adapter.features?.has?.("timestamp-query"));
        let device: any = null;
        if (wantsTs) {
          try {
            device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
          } catch {
            device = null;
          }
        }
        if (!device) {
          device = await adapter.requestDevice();
        }
        if (!device) {
          return {
            ok: false,
            rafWorking: rafCheck,
            reason: "adapter.requestDevice() returned null",
            adapterInfo,
            webglInfo,
            softwareRenderer,
            timestampQuerySupported: false,
            canvasPresentation: { supported: false, error: "device unavailable" },
          };
        }
        const timestampQuerySupported = Boolean(device.features?.has?.("timestamp-query"));
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
          timestampQuerySupported,
          canvasPresentation,
          adapterInfo,
        };
      } catch (error) {
        return {
          ok: false,
          rafWorking: rafCheck,
          reason: String(error),
          adapterInfo: null,
          webglInfo,
          softwareRenderer,
          timestampQuerySupported: false,
          canvasPresentation: { supported: false, error: String(error) },
        };
      }
    });
    return { variant, args, browserVersion: browser.version(), ...result, webgpuSoftware: classifyWebGpuAdapter(result.adapterInfo) };
  } catch (error) {
    if (!HARDWARE_MODE) throw error;
    const reason = String(error);
    return {
      variant,
      args,
      browserVersion: browser?.version() ?? null,
      ok: false,
      rafWorking: false,
      reason,
      adapterInfo: null,
      webglInfo: null,
      softwareRenderer: false,
      timestampQuerySupported: false,
      canvasPresentation: { supported: false, error: reason },
      webgpuSoftware: classifyWebGpuAdapter(null),
    };
  } finally {
    await browser?.close();
  }
}

async function measureMode(
  baseURL: string,
  mode: NativeMode,
  args: string[],
  presentationMode: "real" | "offscreen-substitute",
  sharedAnchorTo: number,
  referencePngBase64: string | null = null,
) {
  const browser = await launchBrowser(args);
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ baseURL, viewport: VIEWPORT });
    const page = await context.newPage();
    await installCommonRoutes(page, sharedAnchorTo);
    if (presentationMode === "offscreen-substitute") {
      await installWebGpuOffscreenPresentInitScript(page);
    }

    const nativeFlag = mode === "gpu-native" ? 1 : 0;
    await page.goto(`/harness/blank.html?gpu=webgpu&webgpuNative=${nativeFlag}&fit=${FIT_COLUMNS}`);

    const result = await page.evaluate(
      async ({
        mode,
        markets,
        barCount,
        cellsPerBar,
        priceStep,
        intervalMs,
        panFrames,
        zoomFrames,
        liveFrames,
        liveRolloverFrames,
        liveRolloverEveryFrames,
        liveRatePerMarket,
        repetitions,
        metricNames,
        referencePngBase64,
        readyTimeoutMs,
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
          webgpuDeviceModule,
          { readWebGpuAdapterIdentity },
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
          import("/harness/webgpuNativeBenchmark.mjs"),
        ]);

        const nextRaf = () =>
          Promise.race([
            new Promise<number>((resolve) => requestAnimationFrame((ts) => resolve(ts))),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`rAF stalled >5000ms on ${mode}`)), 5_000)),
          ]);

        const tracked = new Set<string>(metricNames);
        let activeBucket: Record<string, number[]> | null = null;
        let activeRolloverBucket: Record<string, number[]> | null = null;
        (globalThis as any).__webgpuNativeBenchRecord = (name: string, durationMs: number) => {
          if (!tracked.has(name)) return;
          if (activeBucket) (activeBucket[name] ??= []).push(durationMs);
          if (activeRolloverBucket) (activeRolloverBucket[name] ??= []).push(durationMs);
        };

        const tradeListeners = new Map<string, Set<(trade: any) => void>>();
        const roots: HTMLDivElement[] = [];
        const handles: Array<{ dispose(): void }> = [];
        const panelIds = markets.map((_: string, idx: number) => `webgpu-native-${mode}-${idx}`);
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
        const readyDeadline = performance.now() + readyTimeoutMs;
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
            throw new Error(`Timed out waiting for 4 dense footprint charts on ${mode}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const panelBackends = roots.map((root) => {
          const hook = root.querySelector('[data-testid="chart-hook"]');
          return hook?.getAttribute("data-gpu-backend") ?? "missing";
        });

        let measuredAdapter: any = null;
        let timestampQuerySupported = false;
        const syncBackendWork = async () => {
          const handle = await webgpuDeviceModule.requestWebGpuDevice();
          measuredAdapter = handle?.adapter ?? measuredAdapter;
          timestampQuerySupported = Boolean(handle?.supportsTimestampQuery);
          await handle?.device?.queue?.onSubmittedWorkDone?.();
          await nextRaf();
        };

        // Warm up before capture and measurements (symmetric +4 / -4 so viewport matches).
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

        // Composite capture for parity & non-empty frame check.
        const rt0 = runtimes()[0];
        rt0.view.resetTimeScale(rt0.pipeline.series.length);
        rt0.session.invalidate(ChartChange.Viewport);
        await nextRaf();
        await syncBackendWork();
        const captureFrame = await rt0.session.captureCompositePng();
        const captureView = {
          offsetX: rt0.view.offsetX,
          colWidth: rt0.view.colWidth,
          priceTop: rt0.view.priceTop,
          pricePerPx: rt0.view.pricePerPx,
          area: { ...rt0.view.area },
          firstTime: rt0.pipeline.series.at(0)?.startTime ?? null,
          lastTime: rt0.pipeline.series.at(rt0.pipeline.series.length - 1)?.startTime ?? null,
        };
        const blobToBase64 = async (blob: Blob) => {
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          return btoa(bin);
        };
        const decodePngRgba = async (b64: string) => {
          const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([raw], { type: "image/png" }));
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return ctx.getImageData(0, 0, canvas.width, canvas.height);
        };

        const capturePngBase64 = await blobToBase64(captureFrame.blob);
        const decodedCurrent = await decodePngRgba(capturePngBase64);
        let nonBgPixels = 0;
        for (let i = 0; i < decodedCurrent.data.length; i += 4) {
          const r = decodedCurrent.data[i];
          const g = decodedCurrent.data[i + 1];
          const b = decodedCurrent.data[i + 2];
          if (Math.abs(r - 18) > 4 || Math.abs(g - 20) > 4 || Math.abs(b - 26) > 4) {
            nonBgPixels++;
          }
        }

        let parity: { matchRatio: number; maxChannelDiff: number; meanAbsDiff: number; totalPixels: number } | null = null;
        if (referencePngBase64) {
          const decodedRef = await decodePngRgba(referencePngBase64);
          if (decodedRef.width === decodedCurrent.width && decodedRef.height === decodedCurrent.height) {
            const totalPixels = decodedCurrent.width * decodedCurrent.height;
            let matched = 0;
            let maxDiff = 0;
            let sumDiff = 0;
            for (let i = 0; i < decodedCurrent.data.length; i += 4) {
              const dr = Math.abs(decodedCurrent.data[i] - decodedRef.data[i]);
              const dg = Math.abs(decodedCurrent.data[i + 1] - decodedRef.data[i + 1]);
              const db = Math.abs(decodedCurrent.data[i + 2] - decodedRef.data[i + 2]);
              const da = Math.abs(decodedCurrent.data[i + 3] - decodedRef.data[i + 3]);
              const d = Math.max(dr, dg, db, da);
              sumDiff += (dr + dg + db + da) / 4;
              if (d > maxDiff) maxDiff = d;
              if (d <= 2) matched++;
            }
            parity = { matchRatio: matched / totalPixels, maxChannelDiff: maxDiff, meanAbsDiff: sumDiff / totalPixels, totalPixels };
          }
        }

        const wasEnabled = telemetry.isPerformanceTelemetryEnabled();
        telemetry.configurePerformanceTelemetry({ enabled: true });

        const counterSnapshot = () => ({ ...telemetry.snapshotPerformanceTelemetry().counters });
        const diffCounters = (before: Record<string, number>, after: Record<string, number>) => {
          const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
          const delta: Record<string, number> = {};
          for (const key of keys) {
            const d = (after[key] ?? 0) - (before[key] ?? 0);
            if (d !== 0) delta[key] = d;
          }
          return delta;
        };

        const runScenario = async (
          repCount: number,
          frameCount: number,
          stepFn: (rep: number, frame: number) => void,
          drainAfter = false,
          options?: {
            isRolloverFrame?: (rep: number, frame: number) => boolean;
          },
        ) => {
          const reps: Array<{
            repetition: number;
            frames: number;
            bucket: Record<string, number[]>;
            rafIntervalsMs: number[];
            counterDelta: Record<string, number>;
            rolloverCount: number;
            rolloverFrames: {
              frameCount: number;
              bucket: Record<string, number[]>;
              counterDelta: Record<string, number>;
            };
          }> = [];
          for (let rep = 0; rep < repCount; rep++) {
            const bucket: Record<string, number[]> = {};
            const rolloverBucket: Record<string, number[]> = {};
            const rolloverCounterDelta: Record<string, number> = {};
            const rafIntervalsMs: number[] = [];
            const beforeLengths = runtimes().map((runtime) => runtime.pipeline.series.length);
            const beforeCounters = counterSnapshot();
            activeBucket = bucket;
            let rolloverFrameCount = 0;
            let prevRafTs: number | null = null;
            for (let frame = 0; frame < frameCount; frame++) {
              const trackRollover = Boolean(options?.isRolloverFrame?.(rep, frame));
              const beforeFrameCounters = trackRollover ? counterSnapshot() : null;
              if (trackRollover) {
                activeRolloverBucket = rolloverBucket;
              }
              stepFn(rep, frame);
              const rafTs = await nextRaf();
              if (trackRollover) {
                activeRolloverBucket = null;
                rolloverFrameCount++;
                const afterFrameCounters = counterSnapshot();
                const frameDelta = diffCounters(beforeFrameCounters!, afterFrameCounters);
                for (const [k, v] of Object.entries(frameDelta)) {
                  rolloverCounterDelta[k] = (rolloverCounterDelta[k] ?? 0) + v;
                }
              }
              if (prevRafTs !== null) {
                rafIntervalsMs.push(rafTs - prevRafTs);
              }
              prevRafTs = rafTs;
            }
            if (drainAfter) {
              for (let d = 0; d < 4; d++) await nextRaf();
            }
            activeBucket = null;
            activeRolloverBucket = null;
            await syncBackendWork();
            const afterCounters = counterSnapshot();
            const afterLengths = runtimes().map((runtime) => runtime.pipeline.series.length);
            const rolloverCount = afterLengths.reduce(
              (minDelta, len, idx) => Math.min(minDelta, len - beforeLengths[idx]),
              Number.POSITIVE_INFINITY,
            );
            reps.push({
              repetition: rep + 1,
              frames: frameCount,
              bucket,
              rafIntervalsMs,
              counterDelta: diffCounters(beforeCounters, afterCounters),
              rolloverCount: Number.isFinite(rolloverCount) ? rolloverCount : 0,
              rolloverFrames: {
                frameCount: rolloverFrameCount,
                bucket: rolloverBucket,
                counterDelta: rolloverCounterDelta,
              },
            });
          }
          return reps;
        };

        // 1. PAN
        const panHalf = Math.floor(panFrames / 2);
        const panReps = await runScenario(repetitions, panFrames, (_rep, frame) => {
          const stepX = frame < panHalf ? 6 : -6;
          for (const runtime of runtimes()) {
            runtime.view.offsetX += stepX;
            runtime.session.invalidate(ChartChange.Viewport);
          }
        });

        // 2. ZOOM
        const zoomHalf = Math.floor(zoomFrames / 2);
        const zoomReps = await runScenario(repetitions, zoomFrames, (_rep, frame) => {
          const factor = frame < zoomHalf ? 1.03 : 1 / 1.03;
          for (const runtime of runtimes()) {
            const area = runtime.view.area;
            runtime.view.zoomX(factor, area.left + area.width * 0.5);
            runtime.session.invalidate(ChartChange.Viewport);
          }
        });

        // 3. LIVE (200 trades/s/market)
        let tradeSeq = 1;
        let lastTickAt = performance.now();
        let carryTrades = 0;
        let baseTimes = runtimes().map((runtime) => {
          const s = runtime.pipeline.series;
          return s.timeOfIndex(s.length - 1);
        });
        const liveStartAt = performance.now();
        const liveReps = await runScenario(
          repetitions,
          liveFrames,
          (rep, frame) => {
            if (frame === 0) {
              baseTimes = runtimes().map((runtime) => {
                const s = runtime.pipeline.series;
                return s.timeOfIndex(s.length - 1);
              });
            }
            const now = performance.now();
            const dt = Math.max(16, Math.min(100, now - lastTickAt));
            lastTickAt = now;
            carryTrades += (liveRatePerMarket * dt) / 1_000;
            const perMarketCount = Math.max(1, Math.floor(carryTrades));
            carryTrades = Math.max(0, carryTrades - perMarketCount);
            for (let mIdx = 0; mIdx < markets.length; mIdx++) {
              const listeners = tradeListeners.get(markets[mIdx]);
              if (!listeners || listeners.size === 0) continue;
              const ts = baseTimes[mIdx] + Math.min(intervalMs - 1_000, Math.floor(now - liveStartAt));
              for (let tIdx = 0; tIdx < perMarketCount; tIdx++) {
                const price = 60_000 + ((tradeSeq + tIdx) % cellsPerBar) * priceStep;
                const trade = {
                  price,
                  qty: 0.25 + ((tradeSeq + tIdx) % 5) * 0.1,
                  time: ts,
                  isBuyerMaker: (tradeSeq + tIdx) % 2 === 0,
                  id: `native-live-${mode}-${rep}-${tradeSeq}`,
                };
                tradeSeq++;
                for (const cb of listeners) cb(trade);
              }
            }
          },
          true,
        );

        // 4. LIVE-ROLLOVER (new bar every liveRolloverEveryFrames, >= 10 rollovers/rep)
        let rolloverSeq = 1;
        let rolloverBaseTimes = runtimes().map((runtime) => {
          const s = runtime.pipeline.series;
          return s.timeOfIndex(s.length - 1);
        });
        let rolloverBarOffset = 0;
        let rolloverIntraOffset = 500;
        const liveRolloverReps = await runScenario(
          repetitions,
          liveRolloverFrames,
          (rep, frame) => {
            if (frame === 0) {
              rolloverBaseTimes = runtimes().map((runtime) => {
                const s = runtime.pipeline.series;
                return s.timeOfIndex(s.length - 1);
              });
              rolloverBarOffset = 0;
              rolloverIntraOffset = 500;
            } else if (frame % liveRolloverEveryFrames === 0) {
              rolloverBarOffset += 1;
              rolloverIntraOffset = 500;
            } else {
              rolloverIntraOffset = Math.min(intervalMs - 1_000, rolloverIntraOffset + 500);
            }
            for (let mIdx = 0; mIdx < markets.length; mIdx++) {
              const listeners = tradeListeners.get(markets[mIdx]);
              if (!listeners || listeners.size === 0) continue;
              const ts = rolloverBaseTimes[mIdx] + rolloverBarOffset * intervalMs + rolloverIntraOffset;
              for (let tIdx = 0; tIdx < 2; tIdx++) {
                const price = 60_000 + ((rolloverSeq + tIdx) % cellsPerBar) * priceStep;
                const trade = {
                  price,
                  qty: 0.35 + ((rolloverSeq + tIdx) % 4) * 0.1,
                  time: ts,
                  isBuyerMaker: (rolloverSeq + tIdx) % 2 === 0,
                  id: `native-rollover-${mode}-${rep}-${rolloverSeq}`,
                };
                rolloverSeq++;
                for (const cb of listeners) cb(trade);
              }
            }
          },
          true,
          {
            isRolloverFrame: (_rep, frame) => frame > 0 && frame % liveRolloverEveryFrames === 0,
          },
        );

        const diag = diagnostics.getGpuDiagnostics();
        const adapter = await readWebGpuAdapterIdentity(measuredAdapter);
        telemetry.configurePerformanceTelemetry({ enabled: wasEnabled });

        for (const handle of handles) handle.dispose();
        for (const root of roots) root.remove();
        delete (globalThis as any).__webgpuNativeBenchRecord;

        return {
          mode,
          diag,
          adapter,
          timestampQuerySupported,
          panelBackends,
          capture: {
            width: captureFrame.width,
            height: captureFrame.height,
            bytes: captureFrame.bytes,
            nonBgPixels,
            view: captureView,
            pngBase64: referencePngBase64 ? null : capturePngBase64,
            parity,
          },
          rawScenarios: { pan: panReps, zoom: zoomReps, live: liveReps, "live-rollover": liveRolloverReps },
        };
      },
      {
        mode,
        markets: [...MARKETS],
        barCount: BAR_COUNT,
        cellsPerBar: CELLS_PER_BAR,
        priceStep: PRICE_STEP,
        intervalMs: INTERVAL_MS,
        panFrames: PAN_FRAMES_PER_REPETITION,
        zoomFrames: ZOOM_FRAMES_PER_REPETITION,
        liveFrames: LIVE_FRAMES_PER_REPETITION,
        liveRolloverFrames: LIVE_ROLLOVER_FRAMES_PER_REPETITION,
        liveRolloverEveryFrames: LIVE_ROLLOVER_EVERY_FRAMES,
        liveRatePerMarket: LIVE_RATE_PER_SECOND_PER_MARKET,
        repetitions: REPETITIONS,
        metricNames: [...WEBGPU_NATIVE_METRICS],
        referencePngBase64,
        readyTimeoutMs: READY_TIMEOUT_MS,
      },
    );

    const summarizeScenario = (reps: typeof result.rawScenarios.pan) => {
      const combinedMetrics = Object.fromEntries(
        WEBGPU_NATIVE_METRICS.map((metric) => [
          metric,
          summarizeMetricValues(reps.flatMap((rep) => rep.bucket[metric] ?? [])),
        ]),
      ) as Record<MetricName, ReturnType<typeof summarizeMetricValues>>;
      const totalChartFrames = reps.reduce((sum, rep) => sum + rep.frames * MARKETS.length, 0);
      const combinedDelta: Record<string, number> = {};
      const rolloverCombinedDelta: Record<string, number> = {};
      let rolloverCountTotal = 0;
      let rolloverFrameCountTotal = 0;
      for (const rep of reps) {
        rolloverCountTotal += rep.rolloverCount;
        rolloverFrameCountTotal += rep.rolloverFrames.frameCount;
        for (const [key, val] of Object.entries(rep.counterDelta)) {
          combinedDelta[key] = (combinedDelta[key] ?? 0) + val;
        }
        for (const [key, val] of Object.entries(rep.rolloverFrames.counterDelta)) {
          rolloverCombinedDelta[key] = (rolloverCombinedDelta[key] ?? 0) + val;
        }
      }
      const rolloverCombinedMetrics = Object.fromEntries(
        WEBGPU_NATIVE_METRICS.map((metric) => [
          metric,
          summarizeMetricValues(reps.flatMap((rep) => rep.rolloverFrames.bucket[metric] ?? [])),
        ]),
      ) as Record<MetricName, ReturnType<typeof summarizeMetricValues>>;
      const rolloverChartFrames = rolloverFrameCountTotal * MARKETS.length;
      return {
        repetitions: reps.map((rep) => ({
          repetition: rep.repetition,
          frames: rep.frames,
          rolloverCount: rep.rolloverCount,
          raf: computeMissedFrameStats(rep.rafIntervalsMs, MISSED_FRAME_THRESHOLD_MS),
          uploads: computeUploadStats(rep.counterDelta, rep.frames * MARKETS.length),
          metrics: Object.fromEntries(
            WEBGPU_NATIVE_METRICS.map((metric) => [metric, summarizeMetricValues(rep.bucket[metric] ?? [])]),
          ),
          rolloverFrames: {
            frameCount: rep.rolloverFrames.frameCount,
            uploads: computeUploadStats(rep.rolloverFrames.counterDelta, rep.rolloverFrames.frameCount * MARKETS.length),
            metrics: Object.fromEntries(
              WEBGPU_NATIVE_METRICS.map((metric) => [metric, summarizeMetricValues(rep.rolloverFrames.bucket[metric] ?? [])]),
            ),
          },
        })),
        combined: combinedMetrics,
        raf: computeMissedFrameStats(reps.flatMap((rep) => rep.rafIntervalsMs), MISSED_FRAME_THRESHOLD_MS),
        uploads: computeUploadStats(combinedDelta, totalChartFrames),
        rolloverCount: rolloverCountTotal,
        rolloverFrames: rolloverFrameCountTotal > 0
          ? {
              frameCount: rolloverFrameCountTotal,
              rolloverCount: rolloverCountTotal,
              combined: rolloverCombinedMetrics,
              uploads: computeUploadStats(rolloverCombinedDelta, rolloverChartFrames),
            }
          : null,
      };
    };

    return {
      mode,
      presentation: presentationMode,
      active: result.diag.active,
      requested: result.diag.requested,
      featurePaths: result.diag.featurePaths ?? {},
      panelBackends: result.panelBackends,
      fallbacks: result.diag.fallbacks,
      adapter: result.adapter,
      timestampQuerySupported: result.timestampQuerySupported,
      capture: result.capture,
      scenarios: {
        pan: summarizeScenario(result.rawScenarios.pan),
        zoom: summarizeScenario(result.rawScenarios.zoom),
        live: summarizeScenario(result.rawScenarios.live),
        "live-rollover": summarizeScenario(result.rawScenarios["live-rollover"]),
      },
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

test("four-chart WebGPU immediate vs GPU-native PoC comparison across pan, zoom, live and live-rollover", async ({ baseURL }, testInfo) => {
  test.setTimeout(ACTIVE_FIXTURE.profile === "large" ? 480_000 : 240_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const reportPath = process.env.CHART_GPU_NATIVE_REPORT_PATH;
  const sharedAnchorTo = Date.now();

  const primaryProbe = await probeWebGpuCapability(resolvedBaseURL, "no-vulkan-compositor", sharedAnchorTo);
  let webgpuProbe = primaryProbe;
  if (shouldTryWebGpuVulkan(primaryProbe, HARDWARE_MODE)) {
    const fallbackProbe = await probeWebGpuCapability(resolvedBaseURL, "vulkan-compositor", sharedAnchorTo);
    webgpuProbe = selectWebGpuProbe(primaryProbe, fallbackProbe, HARDWARE_MODE);
  }

  const webglProbe = HARDWARE_MODE ? primaryProbe : webgpuProbe;
  const hardwareInvalidReasons = webGpuFlushHardwareInvalidReasons(webgpuProbe, webglProbe);
  let hardwareValid = HARDWARE_MODE && hardwareInvalidReasons.length === 0;
  const presentationMode = HARDWARE_MODE && webgpuProbe.canvasPresentation?.supported
    ? "real"
    : "offscreen-substitute";

  const environment = {
    browserVersion: webgpuProbe.browserVersion ?? null,
    operatingSystem: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    launchArgs: webgpuProbe.args,
    webglRenderer: webglProbe.webglInfo ?? null,
    webgpuAdapter: webgpuProbe.adapterInfo ?? null,
    webgpuVariant: webgpuProbe.variant,
    webgpuLaunchArgs: webgpuProbe.args,
    canvasPresentationProbe: webgpuProbe.canvasPresentation ?? null,
  };

  const writeReport = async (report: Record<string, unknown>) => {
    await testInfo.attach("webgpu-native-poc-evidence.json", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    if (reportPath) {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  };

  if (!webgpuProbe.ok) {
    if (HARDWARE_MODE) {
      const assessment = buildWebGpuNativeAssessment({ hardwareValid: false, fixture: ACTIVE_FIXTURE });
      await writeReport({
        schemaVersion: 1,
        issue: "#258",
        fixture: ACTIVE_FIXTURE,
        hardwareValid: false,
        hardwareInvalidReasons,
        timestampQuerySupported: false,
        presentation: presentationMode,
        environment,
        webgpuProbe,
        immediate: null,
        gpuNative: null,
        ...assessment,
      });
    }
    test.skip(true, `WebGPU adapter unavailable in runtime (${webgpuProbe.reason ?? "unknown"})`);
  }

  const immediate = await measureMode(resolvedBaseURL, "immediate", webgpuProbe.args, presentationMode, sharedAnchorTo, null);
  const gpuNative = await measureMode(
    resolvedBaseURL,
    "gpu-native",
    webgpuProbe.args,
    presentationMode,
    sharedAnchorTo,
    immediate.capture.pngBase64,
  );
  // Strip large raw PNG base64 before serializing report.
  const parity = gpuNative.capture.parity
    ? {
        ...gpuNative.capture.parity,
        nonBgPixelsImmediate: immediate.capture.nonBgPixels,
        nonBgPixelsNative: gpuNative.capture.nonBgPixels,
      }
    : null;
  immediate.capture.pngBase64 = null;
  gpuNative.capture.pngBase64 = null;

  environment.webgpuAdapter = gpuNative.adapter;
  const measuredReason = classifyWebGpuAdapter(gpuNative.adapter).reason;
  if (measuredReason) {
    if (!hardwareInvalidReasons.includes(measuredReason)) hardwareInvalidReasons.push(measuredReason);
    hardwareValid = false;
  }

  const assessment = buildWebGpuNativeAssessment({ hardwareValid, immediate, gpuNative, parity, fixture: ACTIVE_FIXTURE });
  const report = {
    schemaVersion: 1,
    issue: "#258",
    fixture: ACTIVE_FIXTURE,
    hardwareValid,
    hardwareInvalidReasons,
    timestampQuerySupported: Boolean(gpuNative.timestampQuerySupported || webgpuProbe.timestampQuerySupported),
    presentation: presentationMode,
    environment,
    webgpuProbe,
    immediate,
    gpuNative,
    parity,
    ...assessment,
  };
  console.log("WEBGPU_NATIVE_POC_EVIDENCE", JSON.stringify({
    profile: ACTIVE_FIXTURE.profile,
    decision: report.decision,
    defaultGate: report.defaultGate,
    hardwareValid: report.hardwareValid,
    timestampQuerySupported: report.timestampQuerySupported,
    parity: report.parity,
    immediateCaptureView: immediate.capture.view,
    nativeCaptureView: gpuNative.capture.view,
    immediateFeaturePaths: immediate.featurePaths,
    nativeFeaturePaths: gpuNative.featurePaths,
    comparisons: assessment.comparisons,
  }));
  await writeReport(report);

  expect(immediate.active).toBe("webgpu");
  expect(immediate.panelBackends).toEqual(["webgpu", "webgpu", "webgpu", "webgpu"]);
  expect(immediate.featurePaths.scene).toBe("immediate-quads");

  expect(gpuNative.active).toBe("webgpu");
  expect(gpuNative.panelBackends).toEqual(["webgpu", "webgpu", "webgpu", "webgpu"]);
  expect(gpuNative.fallbacks).toEqual([]);
  expect(gpuNative.featurePaths.scene).toBe("webgpu-native");

  expect(gpuNative.scenarios.pan.uploads.dataBytes).toBe(0);
  expect(gpuNative.scenarios.zoom.uploads.dataBytes).toBe(0);
  expect(gpuNative.scenarios.pan.uploads.totalBytes).toBeLessThan(immediate.scenarios.pan.uploads.totalBytes * 0.25);
  expect(gpuNative.scenarios.zoom.uploads.totalBytes).toBeLessThan(immediate.scenarios.zoom.uploads.totalBytes * 0.25);

  for (const rep of immediate.scenarios["live-rollover"].repetitions) {
    expect(rep.rolloverCount).toBeGreaterThanOrEqual(10);
  }
  for (const rep of gpuNative.scenarios["live-rollover"].repetitions) {
    expect(rep.rolloverCount).toBeGreaterThanOrEqual(10);
  }
  expect(gpuNative.scenarios["live-rollover"].uploads.totalBytes).toBeLessThan(
    immediate.scenarios["live-rollover"].uploads.totalBytes * 0.25,
  );
  expect(gpuNative.scenarios["live-rollover"].rolloverFrames).not.toBeNull();
  const rolloverUploadCapBytes = Math.max(8_192, (CELLS_PER_BAR * 16 + 32) * 4);
  expect(gpuNative.scenarios["live-rollover"].rolloverFrames!.uploads.dataPerFrameBytes).toBeLessThan(rolloverUploadCapBytes);

  expect(gpuNative.capture.width).toBeGreaterThan(0);
  expect(gpuNative.capture.height).toBeGreaterThan(0);
  expect(gpuNative.capture.nonBgPixels).toBeGreaterThan(500);
  if (parity) {
    expect(parity.matchRatio).toBeGreaterThanOrEqual(0.98);
  }
});
