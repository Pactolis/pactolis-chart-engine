import { expect, test, type Page } from "@playwright/test";
import type { ChartCaptureReadiness } from "../../src/features/chart/captureReadiness.js";
import type { View } from "../../src/core/engine/view.js";
import type { FootprintSeries } from "../../src/core/model/footprint.js";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";
import { HEATMAP_GPU_FRAG_SRC, HEATMAP_GPU_VERT_SRC } from "../../src/features/chart/heatmap/gpu/heatmapGpuShaders.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

type RuntimeProbe = {
  heatmapTexturePrototypeEnabled: boolean;
  view: View;
  pipeline: { series: FootprintSeries };
  getState(): ChartPanelState;
  updateState(state: ChartPanelState): void;
  getCaptureReadiness(): ChartCaptureReadiness;
  subscribeCaptureReadiness(cb: (snapshot: ChartCaptureReadiness) => void): () => void;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  invalidate(): void;
  whenHeatmapGpuRendererReady(): Promise<void>;
  orderbookHeatmap: {
    bars: Map<number, { t: number; cells: number[][] }>;
    chunks: Map<number, { status: string }>;
    inFlight: Set<AbortController>;
  };
  session: {
    gl: WebGL2RenderingContext;
    pendingCapture: unknown;
    captureCompositePng(): Promise<{ blob: Blob; width: number; height: number }>;
  };
};

declare global {
  interface Window {
    __heatmapNativeProbe: {
      captureActive: boolean;
      heatmapPrograms: number;
      heatmapDraws: number;
      otherDraws: number;
      reads: number;
      startCapture(): void;
      resetCapture(): void;
      readCapture(): { heatmapPrograms: number; heatmapDraws: number; otherDraws: number; reads: number };
      shaderSources: WeakMap<WebGLShader, string>;
      programShaders: WeakMap<WebGLProgram, WebGLShader[]>;
      currentByContext: WeakMap<WebGL2RenderingContext, WebGLProgram | null>;
      vertex: string;
      fragment: string;
    };
  }
}

const hookSelector = '[data-testid="chart-hook"]:not([data-ft-synthetic="1"])';

async function installFixture(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1600, height: 900 });
  const bars = buildBars(500).map((bar) => ({
    ...bar, o: 250, h: 350, l: 50, c: 260, v: 4, d: 0, n: 4,
    cells: [[50, 0, 1, 0, 0, 1, 0, 1], [250, 1, 1, 0, 0, 2, 1, 1],
      [350, 1, 0, 0, 0, 1, 1, 0]], lb: 0, ls: 0,
  }));
  await page.route(/\/history(?:\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from")), to = Number(q.get("to"));
    const candleOnly = q.get("includeFootprint") === "0";
    const meta = candleOnly ? { schemaVersion: 1, generatedAt: FROZEN_NOW } : {
      schemaVersion: 1, generatedAt: FROZEN_NOW,
      footprint: { available: true, allowed: true, priceStep: 25 },
      footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to,
        coveredFrom: from, coveredThrough: to },
    };
    return route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars }, meta }) });
  });
  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from")), to = Number(q.get("to"));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      ok: true, data: { schemaVersion: 1, generatedAt: FROZEN_NOW, base: "BTC",
        source: "single", resolution: "15m", bucketStep: 50, from, to,
        bars: bars.filter((bar) => bar.t >= from && bar.t <= to).map((bar) => ({
          t: bar.t, cells: [[50, 0, 0], [100, 2000, 2000], [200, 7200, 7200]],
        })),
      },
    }) });
  });
  await page.addInitScript(({ vertex, fragment }) => {
    const state = {
      vertex, fragment, shaderSources: new WeakMap<WebGLShader, string>(),
      programShaders: new WeakMap<WebGLProgram, WebGLShader[]>(),
      currentByContext: new WeakMap<WebGL2RenderingContext, WebGLProgram | null>(),
      captureActive: false, heatmapPrograms: 0, heatmapDraws: 0, otherDraws: 0, reads: 0,
      captureHeatmapPrograms: new Set<WebGLProgram>(),
      resetCapture() {
        this.heatmapPrograms = 0; this.heatmapDraws = 0; this.otherDraws = 0; this.reads = 0;
        this.captureHeatmapPrograms.clear();
      },
      startCapture() { this.resetCapture(); this.captureActive = true; },
      readCapture() {
        this.captureActive = false;
        return { heatmapPrograms: this.heatmapPrograms, heatmapDraws: this.heatmapDraws,
          otherDraws: this.otherDraws, reads: this.reads };
      },
    };
    Object.defineProperty(window, "__heatmapNativeProbe", { value: state, configurable: false });
    const proto = WebGL2RenderingContext.prototype;
    const shaderSource = proto.shaderSource, attachShader = proto.attachShader;
    const useProgram = proto.useProgram, draw = proto.drawArraysInstanced, readPixels = proto.readPixels;
    proto.shaderSource = function (shader, source) {
      state.shaderSources.set(shader, source);
      return shaderSource.call(this, shader, source);
    };
    proto.attachShader = function (program, shader) {
      const shaders = state.programShaders.get(program) ?? [];
      shaders.push(shader); state.programShaders.set(program, shaders);
      return attachShader.call(this, program, shader);
    };
    proto.useProgram = function (program) {
      state.currentByContext.set(this, program);
      const sources = program ? (state.programShaders.get(program) ?? []).map((shader) => state.shaderSources.get(shader) ?? "") : [];
      if (state.captureActive && program && sources.includes(state.vertex) && sources.includes(state.fragment)
        && !state.captureHeatmapPrograms.has(program)) {
        state.captureHeatmapPrograms.add(program);
        state.heatmapPrograms++;
      }
      return useProgram.call(this, program);
    };
    proto.drawArraysInstanced = function (...args) {
      const p = state.currentByContext.get(this);
      const sources = p ? (state.programShaders.get(p) ?? []).map((s) => state.shaderSources.get(s) ?? "") : [];
      if (state.captureActive) {
        if (sources.includes(state.vertex) && sources.includes(state.fragment)) state.heatmapDraws++;
        else state.otherDraws++;
      }
      return draw.apply(this, args);
    };
    proto.readPixels = function (...args) {
      const result = readPixels.apply(this, args);
      if (state.captureActive) state.reads++;
      return result;
    };
  }, { vertex: HEATMAP_GPU_VERT_SRC, fragment: HEATMAP_GPU_FRAG_SRC });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=50&priceStepResolved=0");
  const hook = page.locator(hookSelector);
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("Fixture: missing actual panel id");
  await page.evaluate(async ({ id }) => {
    const chart = await import("/harness/chart.ts");
    const { settings } = await import("/src/core/settings.ts");
    const r = chart.getChartRuntime(id) as unknown as RuntimeProbe;
    if (!r?.session || r.heatmapTexturePrototypeEnabled || !r.getCaptureReadiness)
      throw new Error("Fixture: actual default-off Runtime was not mounted");
    settings.grid = false;
    r.updateState({ ...r.getState(), chartType: "candlestick" });
    const selection = r.getState();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("history settlement deadline exceeded")), 15000);
      let stop = () => {};
      stop = r.subscribeCaptureReadiness((snapshot) => {
        if (snapshot.disposed || snapshot.market !== selection.market || snapshot.timeframe !== selection.timeframe) {
          clearTimeout(timeout); stop(); reject(new Error("history selection changed"));
        } else if (snapshot.history.status === "settled" && snapshot.ready && snapshot.priceStep === 25) {
          clearTimeout(timeout); stop(); resolve();
        }
      });
    });
    if (r.pipeline.series.length !== 500) throw new Error("Fixture: expected real 500-bar runtime series");
    r.setVisibleTimeRange({ from: r.pipeline.series.timeOfIndex(455), to: r.pipeline.series.timeOfIndex(505) });
    await r.session.captureCompositePng();
    const v = r.view, last = r.pipeline.series.length - 1;
    v.fitPriceRange(50, 350, .1); v.colWidth = 32;
    v.offsetX = v.area.width - (last + 3) * v.colWidth;
    r.invalidate();
    await r.session.captureCompositePng();
    const { updateOrderbookHeatmapSettings, setOrderbookHeatmapModeFor } = chart;
    updateOrderbookHeatmapSettings({ unit: "btc", bucketStep: 50, single: { usd: 0, btc: 16 } });
    setOrderbookHeatmapModeFor(selection.market, "single");
    r.invalidate();
  }, { id });
  await expect.poll(() => page.evaluate(async ({ id }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(id) as unknown as RuntimeProbe;
    const s = r.pipeline.series, tail = r.orderbookHeatmap.bars.get(s.timeOfIndex(s.length - 1));
    return !!tail && tail.cells.length === 3 && r.orderbookHeatmap.inFlight.size === 0
      && r.orderbookHeatmap.chunks.size > 0
      && [...r.orderbookHeatmap.chunks.values()].every((chunk) => chunk.status === "ready");
  }, { id })).toBe(true);
  return id;
}

test("native capture keeps real CPU heatmap ownership while the lazy GPU module is pending", async ({ page }) => {
  test.setTimeout(120_000);

  // Resolve this URL from the actual relative import in ChartHeatmapGpuCoordinator:
  // import("./heatmap/gpu/heatmapGpuRenderer.js"). Vite's source request is this TS path.
  let enteredRoute!: () => void;
  const importEntered = new Promise<void>((resolve) => { enteredRoute = resolve; });
  let releaseImport!: () => void;
  const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
  let interceptedUrl = "";
  await page.route(/\/src\/features\/chart\/heatmap\/gpu\/heatmapGpuRenderer\.(?:ts|js)(?:\?.*)?$/, async (route) => {
    interceptedUrl = route.request().url();
    enteredRoute();
    await importGate;
    await route.continue();
  });

  let id = "";
  try {
    id = await installFixture(page);
    const cpuBaseline = await page.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const r = getChartRuntime(id) as unknown as RuntimeProbe;
      const root = document.querySelector('[data-testid="chart-hook"][data-panel-id="' + id + '"]')?.parentElement;
      const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
      if (!annotation) throw new Error("Fixture: annotation surface unavailable for CPU baseline");
      const last = r.pipeline.series.length - 1;
      const x = Math.floor(r.view.xOfIndex(last) + r.view.colWidth / 2);
      const y = Math.floor(r.view.yOfPrice(125));
      r.invalidate();
      const capture = await r.session.captureCompositePng();
      const ctx = annotation.getContext("2d");
      if (!ctx) throw new Error("annotation context unavailable for CPU baseline");
      const annotationPixel = Array.from(ctx.getImageData(x, y, 1, 1).data);
      const bitmap = await createImageBitmap(capture.blob);
      const canvas = document.createElement("canvas");
      canvas.width = capture.width; canvas.height = capture.height;
      const output = canvas.getContext("2d");
      if (!output) throw new Error("native baseline decode context unavailable");
      output.drawImage(bitmap, 0, 0); bitmap.close();
      return { x, y, annotationPixel,
        nativePixel: Array.from(output.getImageData(x, y, 1, 1).data) };
    }, { id });
    expect(cpuBaseline.annotationPixel[3], "baseline CPU annotation owns the density cell").toBeGreaterThan(0);
    // This real private prototype toggle is already the matrix spec's accepted test seam.
    // The route is armed before the first opt-in can execute its lazy import.
    await page.evaluate(async ({ id }) => {
      // Resolve the already-mounted real runtime; no test renderer is substituted.
      const { getChartRuntime } = await import("/harness/chart.ts");
      (getChartRuntime(id) as unknown as RuntimeProbe).heatmapTexturePrototypeEnabled = true;
    }, { id });
    await importEntered;
    expect(interceptedUrl).toMatch(/\/src\/features\/chart\/heatmap\/gpu\/heatmapGpuRenderer\.(?:ts|js)/);

    const pending = await page.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const r = getChartRuntime(id) as unknown as RuntimeProbe;
      const root = document.querySelector('[data-testid="chart-hook"][data-panel-id="' + id + '"]')?.parentElement;
      const gpuCanvas = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="gpu-scene"]');
      const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
      if (!gpuCanvas || !annotation || gpuCanvas.width <= 1 || annotation.width !== gpuCanvas.width)
        throw new Error("Fixture: actual chart-owned render surfaces unavailable");
      const series = r.pipeline.series, last = series.length - 1;
      const sample = { x: Math.floor(r.view.xOfIndex(last) + r.view.colWidth / 2),
        y: Math.floor(r.view.yOfPrice(125)) };
      if (sample.x < 0 || sample.y < 0 || sample.x >= annotation.width || sample.y >= annotation.height)
        throw new Error("Fixture: heatmap sample is outside the owned annotation surface");
      const probe = window.__heatmapNativeProbe;
      probe.startCapture();
      try {
        r.invalidate();
        const frame = await r.session.captureCompositePng();
        const counts = probe.readCapture();
        const ctx = annotation.getContext("2d");
        if (!ctx) throw new Error("annotation context unavailable");
        const image = ctx.getImageData(0, 0, annotation.width, annotation.height);
        let annotationInk = 0;
        for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) annotationInk++;
        const samplePixel = Array.from(ctx.getImageData(sample.x, sample.y, 1, 1).data);
        return { ...counts, annotationInk, samplePixel, sample,
          bytes: frame.blob.size, width: frame.width, height: frame.height, surfaceWidth: gpuCanvas.width };
      } finally {
        probe.readCapture();
      }
    }, { id });
    expect(pending.reads, "one actual native framebuffer read during pending import").toBe(1);
    expect(pending.heatmapPrograms, "no heatmap shader program is used before import resolves").toBe(0);
    expect(pending.heatmapDraws, "GPU heatmap must not own a frame before import resolves").toBe(0);
    expect(pending.annotationInk, "real annotation fallback must remain painted").toBeGreaterThan(0);
    expect(pending.samplePixel[3], "target cell belongs to annotation before module resolution").toBeGreaterThan(0);
    expect(pending.samplePixel).toEqual(cpuBaseline.annotationPixel);
    expect(pending.bytes).toBeGreaterThan(0);
    expect(pending.width).toBe(pending.surfaceWidth);

    releaseImport();
    const recovered = await page.evaluate(async ({ id }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const r = getChartRuntime(id) as unknown as RuntimeProbe;
      await r.whenHeatmapGpuRendererReady();
      const root = document.querySelector('[data-testid="chart-hook"][data-panel-id="' + id + '"]')?.parentElement;
      const annotation = root?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
      if (!annotation) throw new Error("Fixture: annotation surface missing after import");
      const series = r.pipeline.series, last = series.length - 1;
      const x = Math.floor(r.view.xOfIndex(last) + r.view.colWidth / 2);
      const y = Math.floor(r.view.yOfPrice(125));
      const probe = window.__heatmapNativeProbe;
      probe.startCapture();
      try {
        r.invalidate();
        const capture = await r.session.captureCompositePng();
        const counts = probe.readCapture();
        const ctx = annotation.getContext("2d");
        if (!ctx) throw new Error("annotation context unavailable after import");
        const annotationPixel = Array.from(ctx.getImageData(x, y, 1, 1).data);
        const bitmap = await createImageBitmap(capture.blob);
        const canvas = document.createElement("canvas");
        canvas.width = capture.width; canvas.height = capture.height;
        const output = canvas.getContext("2d");
        if (!output) throw new Error("native image decode context unavailable");
        output.drawImage(bitmap, 0, 0); bitmap.close();
        const nativePixel = Array.from(output.getImageData(x, y, 1, 1).data);
        return { ...counts, annotationPixel, nativePixel, bytes: capture.blob.size };
      } finally {
        probe.readCapture();
      }
    }, { id });
    expect(recovered.reads, "one native framebuffer read after import").toBe(1);
    expect(recovered.heatmapPrograms, "the exact heatmap shader pair is used after import").toBeGreaterThan(0);
    expect(recovered.heatmapDraws, "real GPU heatmap renderer owns the recovered frame").toBeGreaterThan(0);
    expect(recovered.annotationPixel[3], "GPU-owned cell is not duplicated in annotation").toBe(0);
    recovered.nativePixel.forEach((channel, index) => {
      expect(Math.abs(channel - cpuBaseline.nativePixel[index]),
        "GPU transition must preserve native density coverage without blanking or double paint")
        .toBeLessThanOrEqual(3);
    });
    expect(recovered.bytes).toBeGreaterThan(0);
  } finally {
    releaseImport();
  }
});
