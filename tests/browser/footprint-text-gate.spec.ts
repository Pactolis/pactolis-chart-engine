import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { FUNCTIONAL_WEBGL_ARGS } from "./support/history.js";
import {
  buildDenseFootprintBars,
  classifyWebGpuAdapter,
  evaluateFootprintTextGate,
  FOOTPRINT_TEXT_GATE_RULE,
  FOOTPRINT_TEXT_METRICS,
  FOOTPRINT_TEXT_SCENARIOS,
  readWebGpuAdapterIdentity,
  resolveFootprintTextFixture,
  selectWebGpuProbe,
  shouldTryWebGpuVulkan,
  summarizeMetricValues,
  webGpuFlushHardwareInvalidReasons,
  webGpuFlushLaunchArgs,
} from "../../harness/footprintTextGateBenchmark.mjs";

const HARDWARE_MODE = process.env.CHART_GPU_BENCHMARK_MODE === "hardware";
const ACTIVE_FIXTURE = resolveFootprintTextFixture({
  hardwareMode: HARDWARE_MODE,
  chartCounts: process.env.CHART_FOOTPRINT_TEXT_CHARTS,
});

const {
  viewport: VIEWPORT,
  markets: ALL_MARKETS,
  barCount: BAR_COUNT,
  cellsPerBar: CELLS_PER_BAR,
  priceStep: PRICE_STEP,
  intervalMs: INTERVAL_MS,
  chartCounts: CHART_COUNTS,
  repetitions: REPETITIONS,
  panFrames: PAN_FRAMES,
  zoomFrames: ZOOM_FRAMES,
  liveFrames: LIVE_FRAMES,
  liveRatePerSecondPerMarket: LIVE_RATE_PER_SECOND_PER_MARKET,
  textModes: TEXT_MODES,
  frozenNow: FROZEN_NOW,
} = ACTIVE_FIXTURE;

const READY_TIMEOUT_MS = HARDWARE_MODE ? 90_000 : 30_000;

type WebGpuVariant = "no-vulkan-compositor" | "vulkan-compositor";
type MetricName = (typeof FOOTPRINT_TEXT_METRICS)[number];
type TextMode = "full" | "compact";

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
  let executablePath: string | undefined;
  if (process.env.CHROMIUM_PATH) {
    executablePath = process.env.CHROMIUM_PATH;
  } else if (HARDWARE_MODE && process.platform === "win32") {
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
      `$1globalThis.__footprintTextGateRecord?.($2, $3); $4`,
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
    const includeFootprint = url.searchParams.get("includeFootprint") !== "0";
    const served = includeFootprint ? denseBars : [];
    const meta = includeFootprint
      ? {
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
        }
      : { schemaVersion: 1, generatedAt: FROZEN_NOW };
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
            canvasPresentation: { supported: false, error: "adapter unavailable" },
          };
        }
        const { readWebGpuAdapterIdentity } = await import("/harness/footprintTextGateBenchmark.mjs");
        const adapterInfo = await readWebGpuAdapterIdentity(adapter);
        const device = await adapter.requestDevice();
        if (!device) {
          return {
            ok: false,
            rafWorking: rafCheck,
            reason: "adapter.requestDevice() returned null",
            adapterInfo,
            webglInfo,
            softwareRenderer,
            canvasPresentation: { supported: false, error: "device unavailable" },
          };
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
      canvasPresentation: { supported: false, error: reason },
      webgpuSoftware: classifyWebGpuAdapter(null),
    };
  } finally {
    await browser?.close();
  }
}

async function runChartCountPass(
  baseURL: string,
  chartCount: number,
  args: string[],
  presentationMode: "real" | "offscreen-substitute",
  sharedAnchorTo: number,
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

    await page.goto("/harness/blank.html?gpu=webgpu");
    const markets = ALL_MARKETS.slice(0, chartCount);

    const raw = await page.evaluate(
      async ({
        chartCount,
        markets,
        barCount,
        cellsPerBar,
        priceStep,
        intervalMs,
        repetitions,
        panFrames,
        zoomFrames,
        liveFrames,
        liveRatePerMarket,
        textModes,
        metricNames,
        rule,
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
          { cellTextModeFor },
          { configureFootprintBootstrapMarkets },
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
          import("/src/core/render/chartLod.ts"),
          import("/src/core/syncAllowlist.ts"),
          import("/src/core/analysis/volumeProfile.ts"),
          import("/src/core/analysis/previousWeekStrategy.ts"),
          import("/src/core/analysis/mondayRange.ts"),
          import("/src/features/drawings/drawingManager.ts"),
          import("/src/core/gpu/webgpu/webgpuDevice.ts"),
          import("/harness/footprintTextGateBenchmark.mjs"),
        ]);

        configureFootprintBootstrapMarkets(markets);

        const nextRaf = () =>
          Promise.race([
            new Promise<number>((resolve) => requestAnimationFrame((ts) => resolve(ts))),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`rAF stalled >5000ms (${chartCount} charts)`)), 5_000)),
          ]);

        const tracked = new Set<string>(metricNames);
        let activeBucket: Record<string, number[]> | null = null;
        (globalThis as any).__footprintTextGateRecord = (name: string, durationMs: number) => {
          if (!activeBucket || !tracked.has(name)) return;
          (activeBucket[name] ??= []).push(durationMs);
        };

        const tradeListeners = new Map<string, Set<(trade: any) => void>>();
        const roots: HTMLDivElement[] = [];
        const handles: Array<{ dispose(): void }> = [];
        const panelIds = markets.map((_: string, idx: number) => `footprint-text-gate-${chartCount}-${idx}`);
        const cols = chartCount <= 4 ? 2 : 4;
        const rows = Math.ceil(chartCount / cols);
        const cellW = Math.floor(1600 / cols);
        const cellH = Math.floor(900 / rows);

        for (let idx = 0; idx < markets.length; idx++) {
          const m = markets[idx];
          const root = document.createElement("div");
          root.style.cssText = `position:fixed;left:${(idx % cols) * cellW}px;top:${Math.floor(idx / cols) * cellH}px;width:${cellW}px;height:${cellH}px;`;
          document.body.appendChild(root);
          roots.push(root);

          const drawings = new DrawingManager(() => {});
          drawings.setMarket(m);
          const analysisContext = {
            market: m,
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
            getAnalysisRevisionSnapshot: (sub = m) => ({
              market: sub,
              revision: 1,
              canonical: { status: "complete" as const, market: sub, runKey: `${sub}|${priceStep}`, generation: 1, revision: 1, failedPeriods: [] },
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
            { type: "chart", market: m, timeframe: "1m", scaleMode: "linear", chartType: "footprint", candles: true } as any,
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
            throw new Error(`Timed out waiting for ${chartCount} dense footprint charts`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const panelBackends = roots.map((root) => {
          const hook = root.querySelector('[data-testid="chart-hook"]');
          return hook?.getAttribute("data-gpu-backend") ?? "missing";
        });

        let measuredAdapter: any = null;
        const syncBackendWork = async () => {
          const handle = await webgpuDeviceModule.requestWebGpuDevice();
          measuredAdapter = handle?.adapter ?? measuredAdapter;
          await handle?.device?.queue?.onSubmittedWorkDone?.();
          await nextRaf();
        };

        const configureTextViewport = async (textMode: TextMode) => {
          const targetColWidth = textMode === "compact" ? rule.compactColWidthPx : rule.fullColWidthPx;
          for (const runtime of runtimes()) {
            if (!(runtime.view.area.width > 1 && runtime.view.area.height > 1)) {
              throw new Error(`Chart viewport area not laid out yet (${runtime.view.area.width}x${runtime.view.area.height})`);
            }
            (runtime as any).timeViewport?.ensurePendingLatestPlacement?.(runtime.pipeline.series.length);
            runtime.view.colWidth = targetColWidth;
            runtime.view.offsetX = runtime.view.area.width - runtime.pipeline.series.length * targetColWidth;
            runtime.view.setPriceAutoScale(false);
            runtime.view.pricePerPx = priceStep / rule.targetCellHeightPx;
            const lastBar = runtime.pipeline.series.at(runtime.pipeline.series.length - 1);
            const midPrice = lastBar ? (lastBar.high + lastBar.low) * 0.5 : 60_000;
            runtime.view.priceTop = midPrice + runtime.view.area.height * 0.5 * runtime.view.pricePerPx;
            runtime.session.invalidate(ChartChange.Viewport);
          }
          await nextRaf();
          await syncBackendWork();

          for (const runtime of runtimes()) {
            const lastBar = runtime.pipeline.series.at(runtime.pipeline.series.length - 1);
            const midPrice = lastBar ? (lastBar.high + lastBar.low) * 0.5 : 60_000;
            const measuredCellH = Math.abs(runtime.view.yOfPrice(midPrice) - runtime.view.yOfPrice(midPrice + priceStep));
            const fpW = runtime.view.colWidth - runtime.view.candleStripWidth();
            const actualMode = cellTextModeFor(measuredCellH, fpW);
            if (actualMode !== textMode) {
              throw new Error(`Expected cellTextMode "${textMode}" but got "${actualMode}" (cellH=${measuredCellH}, fpW=${fpW})`);
            }
          }
        };

        // Warmup before measurement so any initial-fit viewport placement settles first
        telemetry.configurePerformanceTelemetry({ enabled: false });
        for (let w = 0; w < 3; w++) {
          for (const runtime of runtimes()) {
            runtime.session.invalidate(ChartChange.Viewport);
          }
          await nextRaf();
        }
        await syncBackendWork();
        await configureTextViewport(textModes[0] as TextMode);

        telemetry.configurePerformanceTelemetry({ enabled: true });
        const reuseCounterName = "chart.annotation.pass.footprint-text.reuse";
        const counterVal = () => telemetry.snapshotPerformanceTelemetry().counters[reuseCounterName] ?? 0;

        const runScenario = async (
          textMode: TextMode,
          repCount: number,
          frameCount: number,
          stepFn: (rep: number, frame: number) => void,
          drainAfter = false,
        ) => {
          const reps: Array<{
            repetition: number;
            frames: number;
            bucket: Record<string, number[]>;
            reuseDelta: number;
          }> = [];
          for (let rep = 0; rep < repCount; rep++) {
            await configureTextViewport(textMode);
            const bucket: Record<string, number[]> = {};
            const beforeReuse = counterVal();
            activeBucket = bucket;
            for (let frame = 0; frame < frameCount; frame++) {
              stepFn(rep, frame);
              await nextRaf();
            }
            if (drainAfter) {
              for (let d = 0; d < 4; d++) await nextRaf();
            }
            activeBucket = null;
            await syncBackendWork();
            const afterReuse = counterVal();
            reps.push({
              repetition: rep + 1,
              frames: frameCount,
              bucket,
              reuseDelta: Math.max(0, afterReuse - beforeReuse),
            });
          }
          return reps;
        };

        let tradeSeq = 1;
        let lastTickAt = performance.now();
        let carryTrades = 0;
        let baseTimes = runtimes().map((runtime) => {
          const s = runtime.pipeline.series;
          return s.timeOfIndex(s.length - 1);
        });
        let liveStartAt = performance.now();

        const rawEntries: Array<{
          chartCount: number;
          textMode: TextMode;
          scenario: string;
          reps: Awaited<ReturnType<typeof runScenario>>;
        }> = [];

        for (const textMode of textModes as TextMode[]) {
          const panHalf = Math.floor(panFrames / 2);
          const panReps = await runScenario(textMode, repetitions, panFrames, (_rep, frame) => {
            const stepX = frame < panHalf ? 6 : frame < panHalf * 2 ? -6 : 0;
            for (const runtime of runtimes()) {
              runtime.view.offsetX += stepX;
              runtime.session.invalidate(ChartChange.Viewport);
            }
          });
          rawEntries.push({ chartCount, textMode, scenario: "pan", reps: panReps });

          const zoomHalf = Math.floor(zoomFrames / 2);
          const zoomReps = await runScenario(textMode, repetitions, zoomFrames, (_rep, frame) => {
            const factor = frame < zoomHalf ? 1.015 : frame < zoomHalf * 2 ? 1 / 1.015 : 1;
            for (const runtime of runtimes()) {
              const area = runtime.view.area;
              runtime.view.zoomX(factor, area.left + area.width * 0.5);
              runtime.session.invalidate(ChartChange.Viewport);
            }
          });
          rawEntries.push({ chartCount, textMode, scenario: "zoom", reps: zoomReps });

          const liveReps = await runScenario(
            textMode,
            repetitions,
            liveFrames,
            (rep, frame) => {
              if (frame === 0) {
                baseTimes = runtimes().map((runtime) => {
                  const s = runtime.pipeline.series;
                  return s.timeOfIndex(s.length - 1);
                });
                lastTickAt = performance.now();
                liveStartAt = lastTickAt;
                carryTrades = 0;
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
                    id: `ft-gate-live-${chartCount}-${textMode}-${rep}-${tradeSeq}`,
                  };
                  tradeSeq++;
                  for (const cb of listeners) cb(trade);
                }
              }
            },
            true,
          );
          rawEntries.push({ chartCount, textMode, scenario: "live", reps: liveReps });
        }

        const diag = diagnostics.getGpuDiagnostics();
        const adapter = await readWebGpuAdapterIdentity(measuredAdapter);

        for (const handle of handles) handle.dispose();
        for (const root of roots) root.remove();
        delete (globalThis as any).__footprintTextGateRecord;

        return { diag, adapter, panelBackends, rawEntries };
      },
      {
        chartCount,
        markets,
        barCount: BAR_COUNT,
        cellsPerBar: CELLS_PER_BAR,
        priceStep: PRICE_STEP,
        intervalMs: INTERVAL_MS,
        repetitions: REPETITIONS,
        panFrames: PAN_FRAMES,
        zoomFrames: ZOOM_FRAMES,
        liveFrames: LIVE_FRAMES,
        liveRatePerMarket: LIVE_RATE_PER_SECOND_PER_MARKET,
        textModes: [...TEXT_MODES],
        metricNames: [...FOOTPRINT_TEXT_METRICS],
        rule: FOOTPRINT_TEXT_GATE_RULE,
        readyTimeoutMs: READY_TIMEOUT_MS,
      },
    );

    const summarizedEntries = raw.rawEntries.map((entry) => {
      const combined = Object.fromEntries(
        FOOTPRINT_TEXT_METRICS.map((metric) => [
          metric,
          summarizeMetricValues(entry.reps.flatMap((rep) => rep.bucket[metric] ?? [])),
        ]),
      ) as Record<MetricName, ReturnType<typeof summarizeMetricValues>>;
      const reuseCount = entry.reps.reduce((sum, rep) => sum + rep.reuseDelta, 0);
      const totalFrames = entry.reps.reduce((sum, rep) => sum + rep.frames * chartCount, 0);
      return {
        chartCount: entry.chartCount,
        textMode: entry.textMode,
        scenario: entry.scenario,
        reuseCount,
        totalFrames,
        combined,
      };
    });

    return {
      chartCount,
      active: raw.diag.active,
      featurePaths: raw.diag.featurePaths ?? {},
      panelBackends: raw.panelBackends,
      fallbacks: raw.diag.fallbacks,
      adapter: raw.adapter,
      entries: summarizedEntries,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

test("WebGPU native footprint cell text share pre-gate benchmark across 4/8 charts and full/compact modes", async ({ baseURL }, testInfo) => {
  test.setTimeout(HARDWARE_MODE ? 480_000 : 240_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const reportPath = process.env.CHART_FOOTPRINT_TEXT_REPORT_PATH;
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
    await testInfo.attach("footprint-text-gate-evidence.json", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    if (reportPath) {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  };

  if (!webgpuProbe.ok) {
    if (HARDWARE_MODE) {
      const gate = evaluateFootprintTextGate({ hardwareValid: false, entries: [] });
      await writeReport({
        schemaVersion: 1,
        issue: "#266",
        fixture: ACTIVE_FIXTURE,
        hardwareValid: false,
        hardwareInvalidReasons,
        presentation: presentationMode,
        environment,
        webgpuProbe,
        featurePathsByChartCount: {},
        ...gate,
      });
    }
    test.skip(true, `WebGPU adapter unavailable in runtime (${webgpuProbe.reason ?? "unknown"})`);
  }

  const passResults: Array<Awaited<ReturnType<typeof runChartCountPass>>> = [];
  for (const count of CHART_COUNTS) {
    passResults.push(await runChartCountPass(resolvedBaseURL, count, webgpuProbe.args, presentationMode, sharedAnchorTo));
  }

  const lastAdapter = passResults[passResults.length - 1]?.adapter ?? webgpuProbe.adapterInfo;
  environment.webgpuAdapter = lastAdapter;
  const measuredReason = classifyWebGpuAdapter(lastAdapter).reason;
  if (measuredReason) {
    if (!hardwareInvalidReasons.includes(measuredReason)) hardwareInvalidReasons.push(measuredReason);
    hardwareValid = false;
  }

  const featurePathsByChartCount = Object.fromEntries(
    passResults.map((res) => [String(res.chartCount), res.featurePaths]),
  );
  const allEntries = passResults.flatMap((res) => res.entries);
  const gate = evaluateFootprintTextGate({ hardwareValid, entries: allEntries });
  const report = {
    schemaVersion: 1,
    issue: "#266",
    fixture: ACTIVE_FIXTURE,
    scenarios: FOOTPRINT_TEXT_SCENARIOS,
    hardwareValid,
    hardwareInvalidReasons,
    presentation: presentationMode,
    environment,
    webgpuProbe,
    featurePathsByChartCount,
    ...gate,
  };

  console.log("FOOTPRINT_TEXT_GATE_EVIDENCE", JSON.stringify({
    decision: report.decision,
    hardwareValid: report.hardwareValid,
    maxPanZoomTextShareP95: report.maxPanZoomTextShareP95,
    featurePathsByChartCount,
    rows: report.rows,
  }));
  await writeReport(report);

  for (const res of passResults) {
    expect(res.active).toBe("webgpu");
    expect(res.panelBackends).toEqual(Array(res.chartCount).fill("webgpu"));
    expect(res.featurePaths.scene).toBe("webgpu-native");
  }
  for (const row of gate.rows) {
    if (row.scenario === "pan" || row.scenario === "zoom") {
      expect(row.footprintText?.count ?? 0).toBeGreaterThan(0);
    }
  }
});
