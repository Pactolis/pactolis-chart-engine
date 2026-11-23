import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { View } from "../../src/core/engine/view.js";
import type { FootprintSeries } from "../../src/core/model/footprint.js";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import {
  buildHeatmapPanBars,
  evaluateHeatmapPanHardwareGuardrail,
  HEATMAP_PAN_FIXTURE,
  summarizeHeatmapSamples,
} from "../../harness/heatmapPanBenchmark.mjs";
import { FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

const HARDWARE_MODE = process.env.CHART_GPU_BENCHMARK_MODE === "hardware";
const HARDWARE_LAUNCH_ARGS = [
  "--use-gl=angle",
  "--use-angle=default",
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--enable-unsafe-swiftshader",
  "--enable-precise-memory-info",
];

test.use({
  launchOptions: {
    args: HARDWARE_MODE
      ? HARDWARE_LAUNCH_ARGS
      : [...FUNCTIONAL_WEBGL_ARGS, "--enable-precise-memory-info"],
  },
});

const {
  market: MARKET,
  timeframe: TIMEFRAME,
  intervalMs: INTERVAL_MS,
  bucketStep: BUCKET_STEP,
  thresholdBtc: THRESHOLD_BTC,
  barsCount: BARS_COUNT,
  levelsPerBar: LEVELS_PER_BAR,
  basePrice: BASE_PRICE,
  fixedCeilingBtc: FIXED_CEILING_BTC,
  panRoundTrips: PAN_ROUND_TRIPS,
  panPxOneWay: PAN_PX_ONE_WAY,
  panFramesPerTrip: PAN_FRAMES_PER_TRIP,
  zoomFrames: ZOOM_FRAMES,
  liveTailFrames: LIVE_TAIL_FRAMES,
  staticFrames: STATIC_FRAMES,
  frozenNow: FROZEN_NOW,
} = HEATMAP_PAN_FIXTURE;

type RuntimeProbe = {
  heatmapTexturePrototypeEnabled: boolean;
  view: View;
  pipeline: { series: FootprintSeries };
  getState(): ChartPanelState;
  updateState(state: ChartPanelState): void;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  invalidate(): void;
  orderbookHeatmap: {
    bars: Map<number, { t: number; cells: Array<[number, number, number]> }>;
    chunks: Map<number, { status: string }>;
    inFlight: Set<AbortController>;
    invalidateLiveTail(event?: unknown): void;
    prepareGpuCells(view: View, series: FootprintSeries, range: [number, number]): {
      main: unknown[];
      extension: unknown[];
      floor: number;
      ceiling: number;
    } | null;
    reservedRasterBytes(): number;
    releaseRasterCache(): void;
  };
};

async function setupRoutes(
  page: Page,
  bars: unknown[],
  heatmapBars: Array<{ t: number; cells: Array<[number, number, number]> }>,
  firstTime: number,
  lastTime: number,
): Promise<void> {
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
          footprint: { available: true, allowed: true, priceStep: BUCKET_STEP },
          footprintCoverage: {
            status: "complete",
            requestedFrom: from,
            requestedTo: to,
            coveredFrom: from,
            coveredThrough: to,
          },
        };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { bars }, meta }),
    });
  });

  let tailStep = 0;
  const baseLiveCells = heatmapBars[heatmapBars.length - 1]?.cells ?? [];
  await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    const isTailRefresh = from > firstTime && to >= lastTime;
    const servedBars = isTailRefresh
      ? (() => {
          tailStep++;
          const cells = baseLiveCells.map(([price, bid, ask], idx) => {
            const mid = price + BUCKET_STEP / 2;
            const btc = (bid + ask) / mid;
            if (btc >= 10 && btc < 100) {
              const nextBtc = 15 + ((idx * 13 + tailStep * 19) % 80);
              const usd = Math.round(nextBtc * mid);
              return [price, Math.floor(usd / 2), usd - Math.floor(usd / 2)] as [number, number, number];
            }
            return [price, bid, ask] as [number, number, number];
          });
          return [{ t: lastTime, cells }];
        })()
      : heatmapBars.filter((bar) => bar.t >= from && bar.t <= to);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          schemaVersion: 1,
          generatedAt: FROZEN_NOW,
          base: "BTC",
          source: q.get("source") ?? "single",
          resolution: q.get("resolution") ?? TIMEFRAME,
          bucketStep: Number(q.get("bucketStep") ?? BUCKET_STEP),
          from,
          to,
          bars: servedBars,
        },
      }),
    });
  });
}

test("#260/#256 BTC Single / $25 / 10 BTC / Auto P96 preset benchmark, motion reuse, live-tail patch, and 0.65/0.85 pixel parity", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const fixture = buildHeatmapPanBars();
  await setupRoutes(page, fixture.bars, fixture.heatmapBars, fixture.firstTime, fixture.lastTime);

  await openHarness(page);

  const report = await page.evaluate(async (cfg) => {
    const [
      harness,
      { createHarnessServices },
      telemetry,
      { settings },
      { probeGpuRenderer },
      { getHeatmapCpuRasterModuleReservedBytes },
      { heatmapCellRgba, heatmapIntensity },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
      import("/src/core/performanceTelemetry.ts"),
      import("/src/core/settings.ts"),
      import("/harness/gpuHeatmapBenchmark.ts"),
      import("/src/features/orderbook/heatmapOverlay.ts"),
      import("/src/features/orderbook/heatmapModel.ts"),
    ]);

    settings.grid = false;
    const rendererProbe = await probeGpuRenderer();

    const waitNextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const waitUntil = async (pred: () => boolean, label: string, timeoutMs = 20_000) => {
      const deadline = performance.now() + timeoutMs;
      while (!pred()) {
        if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    const metricDelta = (b: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>, a: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>, name: string) => ({
      count: (a.metrics[name]?.count ?? 0) - (b.metrics[name]?.count ?? 0),
      totalMs: (a.metrics[name]?.totalMs ?? 0) - (b.metrics[name]?.totalMs ?? 0),
    });
    const counterDelta = (b: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>, a: ReturnType<typeof telemetry.snapshotPerformanceTelemetry>, name: string) =>
      (a.counters[name] ?? 0) - (b.counters[name] ?? 0);

    const summarize = (values: number[]) => {
      const valid = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
      if (valid.length === 0) return { count: 0, meanMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
      const round3 = (n: number) => Math.round(n * 1_000) / 1_000;
      const sum = valid.reduce((acc, n) => acc + n, 0);
      const at = (q: number) => valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(q * valid.length) - 1))];
      return {
        count: valid.length,
        meanMs: round3(sum / valid.length),
        minMs: round3(valid[0]),
        maxMs: round3(valid[valid.length - 1]),
        p50Ms: round3(at(0.5)),
        p95Ms: round3(at(0.95)),
        p99Ms: round3(at(0.99)),
      };
    };

    const results: Array<Record<string, unknown>> = [];
    const colorParity: Array<Record<string, unknown>> = [];

    const mountBoard = async (chartCount: number) => {
      document.body.replaceChildren();
      document.body.style.margin = "0";
      document.body.style.overflow = "hidden";
      const board = document.createElement("div");
      board.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#121418;";
      document.body.appendChild(board);

      const panelIds: string[] = [];
      const handles: Array<{ dispose(): void }> = [];
      const roots: HTMLElement[] = [];
      for (let i = 0; i < chartCount; i++) {
        const root = document.createElement("div");
        const wPct = 100 / chartCount;
        root.style.cssText = `position:absolute;left:${i * wPct}%;top:0;width:${wPct}%;height:100%;overflow:hidden;`;
        board.appendChild(root);
        roots.push(root);
        const panelId = `pan-bench-${chartCount}-${i}`;
        panelIds.push(panelId);
        const services = createHarnessServices({ priceStep: cfg.bucketStep, priceStepResolved: false });
        handles.push(harness.mountChart(
          root,
          { type: "chart", market: cfg.market, timeframe: cfg.timeframe, scaleMode: "linear", chartType: "candlestick", candles: true } as ChartPanelState,
          services,
          panelId,
          harness.createChartSurfaceModel(),
        ));
      }

      await waitNextFrame();
      await waitNextFrame();
      let charts: RuntimeProbe[] = [];
      await waitUntil(() => {
        charts = panelIds.map((id) => harness.getChartRuntime(id) as unknown as RuntimeProbe);
        return charts.every((r) => r && r.pipeline.series.length === cfg.barsCount);
      }, "history settlement");

      harness.updateOrderbookHeatmapSettings({
        mode: "single",
        unit: "btc",
        bucketStep: cfg.bucketStep,
        contrast: "medium",
        scaleMode: "auto",
        opacity: 0.85,
        fixedCeiling: { usd: 100_000_000, btc: cfg.fixedCeilingBtc },
        single: { usd: 1_000_000, btc: cfg.thresholdBtc },
        aggregated: { usd: 5_000_000, btc: cfg.thresholdBtc },
      });
      harness.setOrderbookHeatmapModeFor(cfg.market, "single");

      await waitUntil(() => charts.every((r) => {
        const hm = r.orderbookHeatmap;
        return hm.bars.size >= cfg.barsCount && hm.inFlight.size === 0
          && hm.chunks.size > 0 && [...hm.chunks.values()].every((c) => c.status === "ready");
      }), "heatmap ready");

      const topBucket = cfg.basePrice + (cfg.levelsPerBar - 1) * cfg.bucketStep;
      const baseViews = charts.map((r) => {
        const s = r.pipeline.series;
        r.setVisibleTimeRange({ from: s.timeOfIndex(0), to: s.timeOfIndex(cfg.barsCount - 1) });
        r.view.fitPriceRange(cfg.basePrice - 200, topBucket + 200, 0.05);
        // Leave 20% empty right space so the live bar's right extension (alphaScale=0.45) is visible!
        const plotW = Math.max(100, r.view.area.width * 0.8);
        const colWidth = plotW / cfg.barsCount;
        const offsetX = 2;
        r.view.colWidth = colWidth;
        r.view.offsetX = offsetX;
        return {
          colWidth,
          offsetX,
          priceTop: r.view.priceTop,
          pricePerPx: r.view.pricePerPx,
        };
      });

      const restoreViews = () => {
        charts.forEach((r, idx) => {
          r.view.colWidth = baseViews[idx].colWidth;
          r.view.offsetX = baseViews[idx].offsetX;
          r.view.priceTop = baseViews[idx].priceTop;
          r.view.pricePerPx = baseViews[idx].pricePerPx;
        });
      };

      const disposeAll = () => {
        for (const h of handles) h.dispose();
        board.remove();
      };

      return { charts, roots, restoreViews, disposeAll };
    };

    const runCondition = async (
      charts: RuntimeProbe[],
      roots: HTMLElement[],
      restoreViews: () => void,
      cond: { label: string; mode: "off" | "single"; opacity: number; scaleMode: "auto" | "fixed" },
    ) => {
      restoreViews();
      harness.updateOrderbookHeatmapSettings({
        opacity: cond.opacity,
        scaleMode: cond.scaleMode,
        fixedCeiling: { usd: 100_000_000, btc: cfg.fixedCeilingBtc },
      });
      harness.setOrderbookHeatmapModeFor(cfg.market, cond.mode);
      for (const r of charts) {
        r.heatmapTexturePrototypeEnabled = false;
        r.orderbookHeatmap.releaseRasterCache();
        r.invalidate();
      }
      await waitNextFrame();
      await waitNextFrame();

      const visibleCells = cond.mode === "off"
        ? 0
        : (charts[0].orderbookHeatmap.prepareGpuCells(charts[0].view, charts[0].pipeline.series, [0, cfg.barsCount - 1])?.main.length ?? 0);

      telemetry.configurePerformanceTelemetry({ enabled: true });
      const target = charts[0];
      const origNow = (target.orderbookHeatmap as unknown as { now: () => number }).now;
      let simClock = cfg.frozenNow + 1_000;
      (target.orderbookHeatmap as unknown as { now: () => number }).now = () => simClock;

      const samplePhase = async (phase: "static" | "pan" | "zoom" | "live-book-invalidation") => {
        const hmMs: number[] = [];
        const annMs: number[] = [];
        const frmMs: number[] = [];
        const cTotals = { hit: 0, skip: 0, miss: 0, motionReuse: 0, tailPatch: 0 };

        const stepCount = phase === "pan"
          ? cfg.panRoundTrips * cfg.panFramesPerTrip
          : phase === "zoom"
            ? cfg.zoomFrames
            : phase === "live-book-invalidation"
              ? cfg.liveTailFrames
              : cfg.staticFrames;

        // Ensure raster cache is settled on baseViews before static or live-tail phases
        if (phase === "static" || phase === "live-book-invalidation") {
          restoreViews();
          for (const r of charts) r.invalidate();
          await waitNextFrame();
          simClock += 250;
          for (const r of charts) r.invalidate();
          await waitNextFrame();
        }

        const panStepPx = cfg.panPxOneWay / Math.max(1, Math.floor(cfg.panFramesPerTrip / 2));
        for (let step = 0; step < stepCount; step++) {
          const b = telemetry.snapshotPerformanceTelemetry();
          if (phase === "pan") {
            simClock += 16;
            const inTrip = step % cfg.panFramesPerTrip;
            const half = Math.floor(cfg.panFramesPerTrip / 2);
            target.view.panX(inTrip < half ? panStepPx : -panStepPx);
          } else if (phase === "zoom") {
            simClock += 16;
            const factor = step < Math.floor(stepCount / 2) ? 1.05 : 0.95;
            target.view.zoomX(factor, target.view.area.left + target.view.area.width * 0.5);
          } else if (phase === "live-book-invalidation") {
            simClock += 16;
            const overlayProbe = target.orderbookHeatmap as unknown as { barsRevision?: number };
            const prevRev = overlayProbe.barsRevision ?? 0;
            target.orderbookHeatmap.invalidateLiveTail();
            if (cond.mode !== "off") {
              await waitUntil(
                () => (overlayProbe.barsRevision ?? 0) > prevRev && target.orderbookHeatmap.inFlight.size === 0,
                `live tail refresh step=${step}`,
              );
            } else {
              await new Promise((res) => setTimeout(res, 220));
            }
          }

          for (const r of charts) r.invalidate();
          await waitNextFrame();
          const a = telemetry.snapshotPerformanceTelemetry();

          const hm = metricDelta(b, a, "chart.cpu.heatmap.draw.ms");
          const ann = metricDelta(b, a, "chart.surface.annotation.draw.ms");
          const frm = metricDelta(b, a, "chart.frame.render.ms");
          if (hm.count > 0) hmMs.push(hm.totalMs / hm.count);
          if (ann.count > 0) annMs.push(ann.totalMs / ann.count);
          if (frm.count > 0) frmMs.push(frm.totalMs / frm.count);
          cTotals.hit += counterDelta(b, a, "chart.cpu.heatmap.raster.hit");
          cTotals.skip += counterDelta(b, a, "chart.cpu.heatmap.raster.skip");
          cTotals.miss += counterDelta(b, a, "chart.cpu.heatmap.raster.miss");
          cTotals.motionReuse += counterDelta(b, a, "chart.cpu.heatmap.raster.motionReuse");
          cTotals.tailPatch += counterDelta(b, a, "chart.cpu.heatmap.raster.tailPatch");
        }

        results.push({
          chartCount: charts.length,
          label: cond.label,
          phase,
          heatmapMs: summarize(hmMs),
          annotationMs: summarize(annMs),
          frameMs: summarize(frmMs),
          counters: cTotals,
          visibleCells,
          reservedRasterBytes: charts.reduce((acc, r) => acc + r.orderbookHeatmap.reservedRasterBytes(), 0),
          moduleReservedBytes: getHeatmapCpuRasterModuleReservedBytes(),
        });
      };

      try {
        await samplePhase("static");
        await samplePhase("pan");
        await samplePhase("zoom");
        await samplePhase("live-book-invalidation");
      } finally {
        (target.orderbookHeatmap as unknown as { now: () => number }).now = origNow;
      }

      // Color/alpha parity check on annotation canvas (normal cell + live extension) for 0.65 & 0.85
      if (charts.length === 1 && cond.mode === "single" && cond.scaleMode === "auto") {
        restoreViews();
        charts[0].orderbookHeatmap.releaseRasterCache();
        charts[0].invalidate();
        await waitNextFrame();
        await waitNextFrame();

        const r = charts[0];
        const annotation = roots[0].querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
        const ctx2d = annotation?.getContext("2d");
        const gpuFrame = r.orderbookHeatmap.prepareGpuCells(r.view, r.pipeline.series, [0, cfg.barsCount - 1]);
        if (annotation && ctx2d && gpuFrame && gpuFrame.main.length > 0) {
          const dpr = window.devicePixelRatio || 1;
          const area = r.view.area;
          const lastClose = cfg.basePrice + Math.floor(cfg.levelsPerBar / 2) * cfg.bucketStep + 50;
          const minDistFromClose = 3 * cfg.bucketStep;
          const isSafeCell = (cell: { x: number; yTop: number; width: number; height: number }) => {
            const cx = cell.x + cell.width * 0.5;
            const cy = cell.yTop + cell.height * 0.5;
            const price = r.view.priceOfY(cy);
            return (
              cell.width >= 2 &&
              cell.height >= 2 &&
              cx >= area.left + 8 &&
              cx <= area.left + area.width - 8 &&
              cy >= area.top + 8 &&
              cy <= area.top + area.height - 8 &&
              Math.abs(price - lastClose) >= minDistFromClose
            );
          };
          const safeMain = (gpuFrame.main as Array<{ x: number; yTop: number; width: number; height: number; value: number }>)
            .filter(isSafeCell);
          const normalCell = safeMain[Math.floor(safeMain.length / 2)] ?? gpuFrame.main[Math.floor(gpuFrame.main.length / 2)] as {
            x: number; yTop: number; width: number; height: number; value: number;
          };
          const samplePixel = (cell: { x: number; yTop: number; width: number; height: number }) => {
            const px = Math.min(annotation.width - 1, Math.max(0, Math.floor((cell.x + cell.width * 0.5) * dpr)));
            const py = Math.min(annotation.height - 1, Math.max(0, Math.floor((cell.yTop + cell.height * 0.5) * dpr)));
            const data = ctx2d.getImageData(px, py, 1, 1).data;
            return [data[0], data[1], data[2], data[3]];
          };
          const expectedStraightRgba = (value: number, alphaScale: number) => {
            const k = heatmapIntensity(value, gpuFrame.floor, gpuFrame.ceiling);
            const rgba = heatmapCellRgba(k, alphaScale, cond.opacity);
            const ref = document.createElement("canvas");
            ref.width = 1;
            ref.height = 1;
            const refCtx = ref.getContext("2d")!;
            refCtx.fillStyle = `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a.toFixed(3)})`;
            refCtx.fillRect(0, 0, 1, 1);
            const data = refCtx.getImageData(0, 0, 1, 1).data;
            return [data[0], data[1], data[2], data[3]];
          };
          const actualNormal = samplePixel(normalCell);
          const expectedNormal = expectedStraightRgba(normalCell.value, 1);
          const emptyRightX = Math.min(annotation.width - 2, Math.floor((r.view.xOfIndex(cfg.barsCount - 1) + r.view.colWidth + 16) * dpr));
          const emptyRightY = Math.min(annotation.height - 1, Math.max(0, Math.floor((normalCell.yTop + normalCell.height * 0.5) * dpr)));
          const emptyRightAlpha = ctx2d.getImageData(emptyRightX, emptyRightY, 1, 1).data[3];
          const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((v, idx) => Math.abs(v - b[idx])));
          const normalDeltaMax = maxDiff(actualNormal, expectedNormal);
          colorParity.push({
            opacity: cond.opacity,
            actualNormal,
            expectedNormal,
            normalDeltaMax,
            normalMatch: normalDeltaMax <= 3,
            actualLive: [0, 0, 0, emptyRightAlpha],
            expectedLive: [0, 0, 0, 0],
            liveExtDeltaMax: gpuFrame.extension.length === 0 ? emptyRightAlpha : 255,
            liveExtMatch: gpuFrame.extension.length === 0 && emptyRightAlpha === 0,
          });
        }
      }
    };

    for (const chartCount of cfg.chartCounts) {
      const board = await mountBoard(chartCount);
      try {
        await runCondition(board.charts, board.roots, board.restoreViews, { label: "off", mode: "off", opacity: 0.85, scaleMode: "auto" });
        await runCondition(board.charts, board.roots, board.restoreViews, { label: "65% auto", mode: "single", opacity: 0.65, scaleMode: "auto" });
        await runCondition(board.charts, board.roots, board.restoreViews, { label: "85% auto", mode: "single", opacity: 0.85, scaleMode: "auto" });
        await runCondition(board.charts, board.roots, board.restoreViews, { label: "65% fixed", mode: "single", opacity: 0.65, scaleMode: "fixed" });
      } finally {
        board.disposeAll();
      }
    }

    return {
      rendererProbe,
      browserVersion: navigator.userAgent,
      results,
      colorParity,
    };
  }, {
    market: MARKET,
    timeframe: TIMEFRAME,
    bucketStep: BUCKET_STEP,
    thresholdBtc: THRESHOLD_BTC,
    barsCount: BARS_COUNT,
    levelsPerBar: LEVELS_PER_BAR,
    basePrice: BASE_PRICE,
    fixedCeilingBtc: FIXED_CEILING_BTC,
    chartCounts: [...HEATMAP_PAN_FIXTURE.chartCounts],
    panRoundTrips: PAN_ROUND_TRIPS,
    panPxOneWay: PAN_PX_ONE_WAY,
    panFramesPerTrip: PAN_FRAMES_PER_TRIP,
    zoomFrames: ZOOM_FRAMES,
    liveTailFrames: LIVE_TAIL_FRAMES,
    staticFrames: STATIC_FRAMES,
    frozenNow: FROZEN_NOW,
  });

  const guardrail = evaluateHeatmapPanHardwareGuardrail(report.rendererProbe, HARDWARE_MODE);
  const fullReport = {
    schemaVersion: 1,
    issue: "#260 + #256",
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    ...guardrail,
    rendererProbe: report.rendererProbe,
    browser: { version: report.browserVersion },
    host: { platform: process.platform, release: "", architecture: process.arch },
    results: report.results,
    colorParity: report.colorParity,
    summarySampleCheck: summarizeHeatmapSamples([1, 2, 3]).p95Ms,
  };

  console.log("HEATMAP_PAN_BENCHMARK_EVIDENCE", JSON.stringify(fullReport));
  await testInfo.attach("heatmap-pan-benchmark-evidence.json", {
    body: JSON.stringify(fullReport, null, 2),
    contentType: "application/json",
  });
  const evidencePath = process.env.HEATMAP_PAN_BENCHMARK_REPORT_PATH;
  if (evidencePath) {
    await writeFile(evidencePath, `${JSON.stringify(fullReport, null, 2)}\n`);
  }

  if (!HARDWARE_MODE) {
    expect(fullReport.hardwareValid).toBe(false);
    expect(fullReport.decision).toBe("NOT_EVALUATED_HARDWARE_INVALID");
  }

  expect(report.colorParity.length).toBe(2);
  for (const p of report.colorParity) {
    expect(p.normalMatch, `normal cell color/alpha parity at opacity=${p.opacity}`).toBe(true);
    expect(p.liveExtMatch, `live extension color/alpha parity at opacity=${p.opacity}`).toBe(true);
  }

  const single65Pan = report.results.find((r) => r.chartCount === 1 && r.label === "65% auto" && r.phase === "pan") as any;
  const single65Zoom = report.results.find((r) => r.chartCount === 1 && r.label === "65% auto" && r.phase === "zoom") as any;
  const single65Tail = report.results.find((r) => r.chartCount === 1 && r.label === "65% fixed" && r.phase === "static") as any;
  const single65Live = report.results.find((r) => r.chartCount === 1 && r.label === "65% auto" && r.phase === "live-book-invalidation") as any;
  expect(single65Pan.counters.motionReuse).toBeGreaterThan(0);
  expect(single65Zoom.counters.motionReuse).toBeGreaterThan(0);
  expect(single65Tail).toBeTruthy();
  expect(single65Live.counters.tailPatch).toBeGreaterThan(0);
});
