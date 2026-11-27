import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";
import { webGpuFlushLaunchArgs } from "../../harness/webgpuFlushBenchmark.mjs";

const VIEWPORT = { width: 1280, height: 800 };
const HOOK_SELECTOR = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

function launchArgs(): string[] {
  return webGpuFlushLaunchArgs({
    kind: "webgpu",
    variant: "no-vulkan-compositor",
    hardwareMode: false,
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

function makeStage2Bars(count = 600) {
  const intervalMs = 15 * 60_000;
  const lastTime = Math.floor(FROZEN_NOW / intervalMs) * intervalMs;
  const firstTime = lastTime - (count - 1) * intervalMs;
  return Array.from({ length: count }, (_, idx) => {
    const t = firstTime + idx * intervalMs;
    const low = 60_000 + (idx % 20) * 50;
    const open = low + 50;
    const close = low + (idx % 2 === 0 ? 250 : 100);
    const high = low + 300;
    const cells = [
      [low, 5 + (idx % 7), 8 + (idx % 5), 0, 0, 5, 3, 2],
      [low + 50, 12 + (idx % 9), 4 + (idx % 4), 0, 0, 8, 5, 3],
      [low + 100, 18 + (idx % 11), 9 + (idx % 6), 0, 0, 12, 7, 5],
      [low + 150, 7 + (idx % 5), 14 + (idx % 7), 0, 0, 9, 4, 5],
      [low + 200, 3 + (idx % 4), 6 + (idx % 3), 0, 0, 4, 2, 2],
    ];
    return {
      t,
      o: open,
      h: high,
      l: low,
      c: close,
      v: 95,
      d: 10,
      n: 38,
      cells,
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: FROZEN_NOW,
    };
  });
}

async function installStage2Routes(page: Page, bars: ReturnType<typeof makeStage2Bars>, onHeatmapAck: () => void): Promise<void> {
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
          resolution: "15m",
          bucketStep: 50,
          from,
          to,
          bars: bars.filter((bar) => bar.t >= from && bar.t <= to).map((bar) => ({
            t: bar.t,
            cells: [
              [60_050, 600_000, 600_000],
              [60_200, 1_500_000, 1_500_000],
              [60_400, 3_000_000, 3_000_000],
            ],
          })),
        },
      }),
    });
    onHeatmapAck();
  });
}

async function probeWebGpu(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      device?.destroy?.();
      return Boolean(device);
    } catch {
      return false;
    }
  });
}

async function waitForReadyWebGpuRuntime(page: Page, id: string, minBars: number): Promise<void> {
  await expect.poll(
    () => page.evaluate(async ({ id, minBars }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
      const r: any = getChartRuntime(id);
      if (!r || !r.pipeline?.series || r.pipeline.series.length < minBars) return false;
      if (r.getCaptureReadiness?.().history?.status !== "settled") return false;
      return getGpuDiagnostics().active === "webgpu" || r.session?.getSurface?.()?.kind === "webgpu";
    }, { id, minBars }),
    { timeout: 20_000 },
  ).toBe(true);
}

test("Stage 2 SwiftShader WebGPU verifies pixel-bucket LOD, sub-pixel merged-cells LOD, and WebGPU resident heatmap parity", async ({ baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const args = launchArgs();
  const browser = await launchBrowser(args);

  try {
    const probeCtx = await browser.newContext({ baseURL: resolvedBaseURL, viewport: VIEWPORT });
    const probePage = await probeCtx.newPage();
    await installWebGpuOffscreenPresentInitScript(probePage);
    await probePage.goto("/harness/blank.html");
    const webgpuAvailable = await probeWebGpu(probePage);
    await probeCtx.close();
    if (!webgpuAvailable) {
      test.skip(true, "WebGPU adapter unavailable in runtime");
    }

    const bars = makeStage2Bars(600);

    const captureLodMode = async (nativeEnabled: boolean) => {
      const context = await browser.newContext({ baseURL: resolvedBaseURL, viewport: VIEWPORT });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(FROZEN_NOW));
      await installWebGpuOffscreenPresentInitScript(page);
      await installStage2Routes(page, bars, () => {});
      await openHarness(
        page,
        `?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0&gpu=webgpu&webgpuNative=${nativeEnabled ? 1 : 0}`,
      );
      const hook = page.locator(HOOK_SELECTOR);
      await expect(hook).toHaveCount(1);
      await expect(hook).toHaveAttribute("data-history-loading", "false");
      const id = await hook.getAttribute("data-panel-id");
      if (!id) throw new Error("Missing chart panel id");
      await waitForReadyWebGpuRuntime(page, id, bars.length);

      const out = await page.evaluate(async ({ id }) => {
        const { getChartRuntime } = await import("/harness/chart.ts");
        const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
        const { settings } = await import("/src/core/settings.ts");

        settings.grid = false;
        const r: any = getChartRuntime(id);
        const v = r.view;

        const blobToB64 = (blob: Blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });

        // Wait for initial paint
        r.invalidate();
        await r.session.captureCompositePng();

        // 1. pixel-bucket LOD (colWidth = 0.5)
        r.historyController?.cancelMaintenanceRefresh?.();
        const series = r.pipeline.series;
        if (series.length >= 2) {
          r.setVisibleTimeRange({ from: series.timeOfIndex(0), to: series.timeOfIndex(series.length - 1) });
        }
        r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: "linear" });
        r.invalidate();
        await r.session.captureCompositePng();
        v.setPriceAutoScale(false);
        v.colWidth = 0.5;
        v.offsetX = 0;
        v.fitPriceRange(59_800, 61_500, 0.05);
        v.setPriceAutoScale(false);
        r.invalidate();
        await r.session.captureCompositePng();
        v.setPriceAutoScale(false);
        v.colWidth = 0.5;
        v.offsetX = 0;
        v.fitPriceRange(59_800, 61_500, 0.05);
        v.setPriceAutoScale(false);
        r.invalidate();
        const pbFrame = await r.session.captureCompositePng();
        const pbView = { colWidth: v.colWidth, offsetX: v.offsetX, priceTop: v.priceTop, pricePerPx: v.pricePerPx };
        const pbPath = getGpuDiagnostics().featurePaths?.scene ?? null;
        const pbPng = await blobToB64(pbFrame.blob);

        // 2. merged-cells LOD (footprint with rowHeight < CELL_PIXEL_MERGE_HEIGHT = 2)
        r.historyController?.cancelMaintenanceRefresh?.();
        r.updateState({ ...r.getState(), chartType: "footprint", scaleMode: "linear" });
        r.invalidate();
        await r.session.captureCompositePng();
        v.setPriceAutoScale(false);
        v.colWidth = 20;
        v.offsetX = 0;
        v.fitPriceRange(52_000, 72_000, 0.05); // ~20k range / ~750px -> pricePerPx ~26.7 -> rowHeight = 50/26.7 ~ 1.87 < 2
        v.setPriceAutoScale(false);
        r.invalidate();
        await r.session.captureCompositePng();
        v.setPriceAutoScale(false);
        v.colWidth = 20;
        v.offsetX = 0;
        v.fitPriceRange(52_000, 72_000, 0.05);
        v.setPriceAutoScale(false);
        r.invalidate();
        const mcFrame = await r.session.captureCompositePng();
        const mcView = { colWidth: v.colWidth, offsetX: v.offsetX, priceTop: v.priceTop, pricePerPx: v.pricePerPx };
        const mcPath = getGpuDiagnostics().featurePaths?.scene ?? null;
        const mcPng = await blobToB64(mcFrame.blob);

        return {
          backend: getGpuDiagnostics().active,
          pbPath,
          pbView,
          pbPng,
          mcPath,
          mcView,
          mcPng,
        };
      }, { id });

      await context.close();
      return out;
    };

    const imm = await captureLodMode(false);
    const nat = await captureLodMode(true);

    expect(imm.backend).toBe("webgpu");
    expect(nat.backend).toBe("webgpu");
    expect(imm.pbPath).toBe("immediate-quads");
    expect(nat.pbPath).toBe("webgpu-native");
    expect(imm.mcPath).toBe("immediate-quads");
    expect(nat.mcPath).toBe("webgpu-native");

    // Compare pixel parity for pixel-bucket and merged-cells
    const compareCtx = await browser.newContext({ baseURL: resolvedBaseURL, viewport: VIEWPORT });
    const comparePage = await compareCtx.newPage();
    await comparePage.goto("/harness/blank.html");
    const lodParity = await comparePage.evaluate(async ({ imm, nat }) => {
      const decode = async (b64: string) => {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([raw], { type: "image/png" }));
        const c = document.createElement("canvas");
        c.width = bitmap.width;
        c.height = bitmap.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const diffImgs = async (aB64: string, bB64: string) => {
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
        return { matchRatio: matched / total, nonBg };
      };
      return {
        pb: await diffImgs(imm.pbPng, nat.pbPng),
        mc: await diffImgs(imm.mcPng, nat.mcPng),
      };
    }, { imm, nat });
    await compareCtx.close();

    expect(nat.pbView).toEqual(imm.pbView);
    expect(nat.mcView).toEqual(imm.mcView);
    expect(lodParity.pb.nonBg).toBeGreaterThan(200);
    expect(lodParity.pb.matchRatio).toBeGreaterThanOrEqual(0.98);
    expect(lodParity.mc.nonBg).toBeGreaterThan(200);
    expect(lodParity.mc.matchRatio).toBeGreaterThanOrEqual(0.98);

    // 3. WebGPU Native Orderbook Heatmap parity & featurePaths["orderbook-heatmap"] === "webgpu"
    let heatmapAckCount = 0;
    const hmCtx = await browser.newContext({ baseURL: resolvedBaseURL, viewport: VIEWPORT });
    const hmPage = await hmCtx.newPage();
    await hmPage.clock.setFixedTime(new Date(FROZEN_NOW));
    await installWebGpuOffscreenPresentInitScript(hmPage);
    await installStage2Routes(hmPage, bars, () => { heatmapAckCount++; });
    await openHarness(
      hmPage,
      "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0&gpu=webgpu&webgpuNative=1",
    );
    const hmHook = hmPage.locator(HOOK_SELECTOR);
    await expect(hmHook).toHaveCount(1);
    await expect(hmHook).toHaveAttribute("data-history-loading", "false");
    const hmId = await hmHook.getAttribute("data-panel-id");
    if (!hmId) throw new Error("Missing heatmap panel id");
    await waitForReadyWebGpuRuntime(hmPage, hmId, bars.length);

    await hmPage.evaluate(async ({ id }) => {
      const { getChartRuntime, updateOrderbookHeatmapSettings, setOrderbookHeatmapModeFor } =
        await import("/harness/chart.ts");
      const { settings } = await import("/src/core/settings.ts");
      settings.grid = false;
      const r: any = getChartRuntime(id);
      const s = r.pipeline.series;
      if (s.length >= 2) {
        r.setVisibleTimeRange({ from: s.timeOfIndex(0), to: s.timeOfIndex(s.length - 1) });
      }
      r.updateState({ ...r.getState(), chartType: "candlestick", scaleMode: "linear" });
      r.invalidate();
      await r.session.captureCompositePng();
      r.view.fitPriceRange(59_900, 61_400, 0.1);
      r.view.colWidth = 24;
      r.view.offsetX = r.view.area.width - (s.length + 2) * r.view.colWidth;
      r.invalidate();
      await r.session.captureCompositePng();
      updateOrderbookHeatmapSettings({ unit: "btc", bucketStep: 50, single: { usd: 0, btc: 16 } });
      setOrderbookHeatmapModeFor(r.getState().market, "single");
      await r.whenOrderbookHeatmapReady?.();
      r.invalidate();
    }, { id: hmId });

    await expect.poll(() => heatmapAckCount).toBeGreaterThan(0);
    await expect.poll(() => hmPage.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const r: any = getChartRuntime(id);
      const book = r?.orderbookHeatmap;
      const s = r.pipeline.series;
      const tail = book?.bars.get(s.timeOfIndex(s.length - 1));
      return Boolean(book && tail && tail.cells.length > 0 && book.inFlight.size === 0 && book.chunks.size > 0
        && [...book.chunks.values()].every((c: any) => c.status === "ready"));
    }, { id: hmId })).toBe(true);

    const hmResult = await hmPage.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
      const telemetry = await import("/src/core/performanceTelemetry.ts");

      const r: any = getChartRuntime(id);
      const blobToB64 = (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      const decode = async (b64: string) => {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([raw], { type: "image/png" }));
        const c = document.createElement("canvas");
        c.width = bitmap.width;
        c.height = bitmap.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, c.width, c.height);
      };

      r.heatmapTexturePrototypeEnabled = false;
      r.invalidate();
      const cpuCap = await r.session.captureCompositePng();
      const cpuPath = getGpuDiagnostics().featurePaths?.["orderbook-heatmap"] ?? null;
      const cpuB64 = await blobToB64(cpuCap.blob);

      telemetry.configurePerformanceTelemetry({ enabled: true });
      telemetry.resetPerformanceTelemetry();
      r.heatmapTexturePrototypeEnabled = true;
      await r.whenHeatmapGpuRendererReady();
      r.invalidate();
      const gpuCap = await r.session.captureCompositePng();
      const gpuPaths = { ...(getGpuDiagnostics().featurePaths ?? {}) };
      const hmTelemetry = telemetry.snapshotPerformanceTelemetry().metrics["chart.gpu.heatmap.render.ms"]?.count ?? 0;
      const gpuB64 = await blobToB64(gpuCap.blob);

      const a = await decode(cpuB64);
      const b = await decode(gpuB64);
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
        cpuPath,
        gpuPaths,
        hmTelemetry,
        nonBg,
        matchRatio: matched / total,
      };
    }, { id: hmId });

    await hmCtx.close();

    expect(hmResult.cpuPath).not.toBe("webgpu");
    expect(hmResult.gpuPaths.scene).toBe("webgpu-native");
    expect(hmResult.gpuPaths["orderbook-heatmap"]).toBe("webgpu");
    expect(hmResult.hmTelemetry).toBeGreaterThanOrEqual(1);
    expect(hmResult.nonBg).toBeGreaterThan(200);
    expect(hmResult.matchRatio).toBeGreaterThanOrEqual(0.98);
  } finally {
    await browser.close().catch(() => {});
  }
});
