import { expect, test } from "@playwright/test";
import { FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, INTERVAL_MS, openHarness } from "./support/history.js";

/**
 * Report-only frame cost of the orderbook heatmap with 1, 4, 8 and 16 charts:
 * the Canvas2D annotation path against the default-off GPU texture path.
 *
 * Given N charts on one 1800x1000 page, each with 500 footprint bars and a
 * dense acknowledged book (60 walls per bar, all above the threshold),
 * When matched ABBA blocks (CPU/GPU/GPU/CPU) invalidate every chart's three surfaces,
 * Then the spec prints one `heatmap-multichart-perf` JSON line per N with:
 * - frameMs: invalidate of all N to the last chart's renderDirtySurfaces return
 *   (includes the RAF wait; not GPU finish, presentation or FPS),
 * - renderSpanMs: first render start to last render end inside that frame,
 * - annotationMs / gpuDrawMs: summed per-surface draw time across the N charts.
 * Nothing is gated on speed. It fails only when a sample is not a real
 * all-surface frame, or when GPU mode silently fell back to Canvas2D.
 *
 * Software GL (the default and CI) only proves the spec runs. For numbers, run
 * it on a machine with a real GPU and pick the renderer:
 *   HEATMAP_PERF_GL=default        Windows/macOS: the browser's own GPU backend
 *   HEATMAP_PERF_GL=angle-gl       Linux: ANGLE on OpenGL
 *   HEATMAP_PERF_GL=angle-vulkan   Linux: ANGLE on Vulkan
 *   HEATMAP_PERF_CHARTS=1,4,8,16   chart counts to run (default 1,4,8,16)
 *   npx playwright test --project=perf
 *
 * 16 charts sit at Chromium's per-page WebGL context limit (about 16), so that
 * run reports context losses instead of failing on them.
 */

const GL_ARGS: Record<string, readonly string[]> = {
  swiftshader: FUNCTIONAL_WEBGL_ARGS,
  default: ["--ignore-gpu-blocklist"],
  "angle-gl": ["--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=gl"],
  "angle-vulkan": ["--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan"],
};
const glName = process.env.HEATMAP_PERF_GL ?? "swiftshader";
const glArgs = GL_ARGS[glName];
if (!glArgs) throw new Error(`HEATMAP_PERF_GL must be one of ${Object.keys(GL_ARGS).join(", ")}`);
const CHART_COUNTS = (process.env.HEATMAP_PERF_CHARTS ?? "1,4,8,16").split(",").map(Number);
if (CHART_COUNTS.some((n) => !Number.isInteger(n) || n < 1 || n > 16)) throw new Error("HEATMAP_PERF_CHARTS: integers 1..16");

test.use({
  launchOptions: { args: [...glArgs], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) },
  deviceScaleFactor: 1,
});

const MARKET = "BINANCE_FUTURES:btcusdt";
const VIEWPORT = { width: 1800, height: 1000 };
const BAR_COUNT = 500;
const WARMUP_BLOCKS = 5;
const BLOCKS = 30;
const ABBA = ["CPU", "GPU", "GPU", "CPU"] as const;

const lastBar = Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
// Footprint rows on the canonical 25 grid; OHLC spans the whole book.
const bars = Array.from({ length: BAR_COUNT }, (_, index) => ({
  t: lastBar - (BAR_COUNT - 1 - index) * INTERVAL_MS,
  o: 1500, h: 3500, l: 500, c: 1550, v: 4, d: 0, n: 4,
  cells: [[500, 0, 1, 0, 0, 1, 0, 1], [1500, 1, 0, 0, 0, 1, 1, 0],
    [1550, 0, 1, 0, 0, 1, 0, 1], [3500, 1, 0, 0, 0, 1, 1, 0]],
  lb: 0, ls: 0, completeness: "complete", updatedAt: FROZEN_NOW,
}));
// 60 walls per bar from 500 to 3450: (bidUSD + askUSD) / (bin + 25) = 32 BTC each,
// so every wall clears the 16 BTC threshold and is painted.
const book = Array.from({ length: 60 }, (_, i) => {
  const price = 500 + i * 50;
  return [price, (price + 25) * 16, (price + 25) * 16];
});

for (const charts of CHART_COUNTS) {
  test(`heatmap frame cost, ${charts} chart(s), Canvas2D vs GPU (report-only)`, async ({ page }, testInfo) => {
    // Software GL needs about 40 s per chart for the 140 frames; real GPUs finish far sooner.
    test.setTimeout(120_000 + charts * 60_000);
    await page.setViewportSize(VIEWPORT);
    await page.route(/\/history(?:\?.*)?$/, (route) => {
      const q = new URL(route.request().url()).searchParams;
      const from = Number(q.get("from")), to = Number(q.get("to"));
      const candleOnly = q.get("includeFootprint") === "0";
      const served = candleOnly ? bars.map((bar) => ({ ...bar, cells: [] })) : bars;
      const meta = candleOnly ? { schemaVersion: 1, generatedAt: FROZEN_NOW } : {
        schemaVersion: 1, generatedAt: FROZEN_NOW,
        footprint: { available: true, allowed: true, priceStep: 25 },
        footprintCoverage: { status: "complete", requestedFrom: from, requestedTo: to, coveredFrom: from, coveredThrough: to },
      };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars: served }, meta }) });
    });
    await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, (route) => {
      const q = new URL(route.request().url()).searchParams;
      const from = Number(q.get("from")), to = Number(q.get("to"));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: {
        schemaVersion: 1, generatedAt: FROZEN_NOW, base: q.get("base"), source: q.get("source"),
        resolution: q.get("resolution"), bucketStep: Number(q.get("bucketStep")), from, to,
        bars: bars.filter((bar) => bar.t >= from && bar.t <= to).map((bar) => ({ t: bar.t, cells: book })),
      } }) });
    });
    await openHarness(page);

    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return "no WebGL2";
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension("WEBGL_lose_context")?.loseContext(); // Do not hold one of the page's contexts.
      return name;
    });

    const panelIds = Array.from({ length: charts }, (_, i) => `heatmap-perf-${i}`);
    const columns = Math.ceil(Math.sqrt(charts));
    const rows = Math.ceil(charts / columns);
    await page.evaluate(async ({ market, panelIds, columns, cellWidth, cellHeight }) => {
      const harness = await import("/harness/chart.ts");
      const { createHarnessServices } = await import("/harness/services.ts");
      const { settings } = await import("/src/core/settings.ts");
      settings.grid = false;
      harness.updateOrderbookHeatmapSettings({ unit: "btc", bucketStep: 50, single: { usd: 0, btc: 16 } });
      harness.setOrderbookHeatmapModeFor(market, "single");
      panelIds.forEach((panelId, index) => {
        const root = document.createElement("div");
        root.style.cssText = `position:fixed;overflow:hidden;left:${(index % columns) * cellWidth}px;`
          + `top:${Math.floor(index / columns) * cellHeight}px;width:${cellWidth}px;height:${cellHeight}px;`;
        document.body.appendChild(root);
        harness.mountChart(root, { type: "chart", market, timeframe: "15m", scaleMode: "linear",
          chartType: "candlestick", candles: true } as never,
        createHarnessServices({ priceStep: 50, priceStepResolved: false }), panelId);
      });
    }, { market: MARKET, panelIds, columns,
      cellWidth: Math.floor(VIEWPORT.width / columns), cellHeight: Math.floor(VIEWPORT.height / rows) });

    // Every chart: history settled on the served step, and every heatmap chunk it needs acknowledged.
    await expect.poll(() => page.evaluate(async ({ panelIds, barCount }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      // "ready", or what the first unready chart is still missing.
      for (const id of panelIds) {
        const r = getChartRuntime(id) as any;
        if (!r) return `${id}: not mounted`;
        const ready = r.getCaptureReadiness(), s = r.pipeline.series, heatmap = r.orderbookHeatmap;
        if (ready.disposed || !ready.ready || ready.history.status !== "settled" || ready.priceStep !== 25
            || s.length !== barCount) {
          return `${id}: history ${JSON.stringify({ ready: ready.ready, history: ready.history.status, priceStep: ready.priceStep, bars: s.length })}`;
        }
        r.invalidate(); // Draw so the overlay asks for the visible chunks.
        const chunks = [...heatmap.chunks.values()].map((chunk: any) => chunk.status);
        const tail = heatmap.bars.get(s.timeOfIndex(s.length - 1))?.cells.length;
        if (heatmap.inFlight.size > 0 || chunks.length === 0 || chunks.some((c) => c !== "ready") || tail !== 60) {
          return `${id}: heatmap ${JSON.stringify({ inFlight: heatmap.inFlight.size, chunks, tail })}`;
        }
      }
      return "ready";
    }, { panelIds, barCount: BAR_COUNT }), { timeout: 60_000 }).toBe("ready");

    const result = await page.evaluate(async ({ panelIds, abba, warmupBlocks, blocks, allowContextLoss }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const telemetry = await import("/src/core/performanceTelemetry.ts");
      const { ChartSurfaceDirty } = await import("/src/core/render/scene/chartScene.ts");
      const fail = (message: string): never => { throw new Error("HEATMAP_PERF: " + message); };
      const all = panelIds.map((id) => getChartRuntime(id) as any);
      const lost = all.filter((r) => !r.session.gpuValid).length;
      if (lost > 0 && !allowContextLoss) fail(`${lost} chart(s) lost their WebGL context before timing`);
      const cohort = all.filter((r) => r.session.gpuValid);
      if (cohort.length === 0) fail("no chart with a live WebGL context");
      const frozen = cohort.map((r) => ({ length: r.pipeline.series.length, key: r.orderbookHeatmap.currentDataKey() }));
      const originals = cohort.map((r) => ({ r, render: r.session.renderDirtySurfaces, flag: r.heatmapTexturePrototypeEnabled }));
      const wasEnabled = telemetry.isPerformanceTelemetryEnabled();
      let pending: any = null;
      const unchanged = () => cohort.forEach((r, i) => {
        if (r.pipeline.series.length !== frozen[i].length || r.orderbookHeatmap.currentDataKey() !== frozen[i].key
            || r.orderbookHeatmap.inFlight.size > 0) fail("chart data changed during timing");
      });
      const sumMs = (snapshot: any, name: string) => snapshot.metrics[name]?.totalMs ?? 0;
      const samples: any[] = [];
      try {
        telemetry.configurePerformanceTelemetry({ enabled: true });
        for (const o of originals) {
          o.r.session.renderDirtySurfaces = function () {
            const p = pending;
            if (!p) return o.render.call(this);
            if (p.done.has(this)) fail("duplicate frame");
            const dirty = this.pendingInvalidation.surfaces;
            const began = performance.now();
            o.render.call(this);
            const ended = performance.now();
            if (dirty !== ChartSurfaceDirty.All) fail("frame did not redraw all surfaces");
            p.began = Math.min(p.began, began);
            p.ended = Math.max(p.ended, ended);
            p.done.add(this);
            if (p.done.size === cohort.length) p.resolve();
          };
        }
        const frame = async (mode: string, block: number, warmup: boolean) => {
          unchanged();
          for (const r of cohort) r.heatmapTexturePrototypeEnabled = mode === "GPU";
          const before = telemetry.snapshotPerformanceTelemetry();
          const p: any = { done: new Set(), began: Infinity, ended: -Infinity, resolve: null };
          let deadline: ReturnType<typeof setTimeout> | undefined;
          const completed = new Promise<void>((resolve, reject) => {
            p.resolve = resolve;
            deadline = setTimeout(() => reject(new Error("HEATMAP_PERF: frame deadline")), 10_000);
          });
          pending = p;
          const start = performance.now();
          for (const r of cohort) r.invalidate();
          try { await completed; } finally { clearTimeout(deadline); pending = null; }
          const end = performance.now();
          if (mode === "GPU" && cohort.some((r) => !r.heatmapGpuFrame || r.heatmapGpuFailureLatched))
            fail("GPU mode fell back to Canvas2D");
          if (mode === "CPU" && cohort.some((r) => r.heatmapGpuFrame)) fail("CPU mode still owned a GPU frame");
          const after = telemetry.snapshotPerformanceTelemetry();
          if (!warmup) samples.push({ mode, block, frameMs: end - start, renderSpanMs: p.ended - p.began,
            annotationMs: sumMs(after, "chart.surface.annotation.draw.ms") - sumMs(before, "chart.surface.annotation.draw.ms"),
            gpuDrawMs: sumMs(after, "chart.surface.gpu.draw.ms") - sumMs(before, "chart.surface.gpu.draw.ms") });
        };
        for (let block = 0; block < warmupBlocks; block++) for (const mode of abba) await frame(mode, block, true);
        for (let block = 0; block < blocks; block++) for (const mode of abba) await frame(mode, block, false);
      } finally {
        pending = null;
        for (const o of originals) {
          o.r.session.renderDirtySurfaces = o.render;
          o.r.heatmapTexturePrototypeEnabled = o.flag;
        }
        telemetry.configurePerformanceTelemetry({ enabled: wasEnabled });
      }
      const round = (x: number) => Math.round(x * 100) / 100;
      const stats = (mode: string, field: string) => {
        const a = samples.filter((s) => s.mode === mode).map((s) => s[field]).sort((x, y) => x - y);
        const rank = (q: number) => a[Math.max(0, Math.ceil(q * a.length) - 1)];
        return { p50: round(rank(0.5)), p95: round(rank(0.95)), p99: round(rank(0.99)), max: round(a[a.length - 1]) };
      };
      const fields = ["frameMs", "renderSpanMs", "annotationMs", "gpuDrawMs"];
      const summary = (mode: string) => Object.fromEntries(fields.map((f) => [f, stats(mode, f)]));
      return { measuredCharts: cohort.length, lostContexts: lost,
        samplesPerMode: samples.length / 2, cpu: summary("CPU"), gpu: summary("GPU") };
    }, { panelIds, abba: [...ABBA], warmupBlocks: WARMUP_BLOCKS, blocks: BLOCKS, allowContextLoss: charts > 8 });

    const report = { charts, gl: glName, renderer, viewport: VIEWPORT, bars: BAR_COUNT, wallsPerBar: book.length,
      order: `ABBA x${BLOCKS}, ${WARMUP_BLOCKS} warmup blocks`, ...result,
      p95RenderSpanGpuOverCpu: Math.round((result.gpu.renderSpanMs.p95 / result.cpu.renderSpanMs.p95) * 1000) / 1000 };
    console.log("heatmap-multichart-perf " + JSON.stringify(report));
    await testInfo.attach(`heatmap-multichart-perf-${charts}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    expect(result.samplesPerMode).toBe(BLOCKS * 2);
  });
}
