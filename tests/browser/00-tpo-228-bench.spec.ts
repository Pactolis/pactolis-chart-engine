import { expect, test } from "@playwright/test";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { FUNCTIONAL_WEBGL_ARGS, openHarness, type WireBar } from "./support/history.js";

// #228 Phase 1 + Phase 3 temporary benchmark spec (runs in CI, deleted in Commit 2).

const INTERVAL_30M = 30 * 60_000;
const BAR_COUNT = 4000;
const PRICE_STEP = 10;
const TICK_COUNT = 120;
const TICK_INTERVAL_MS = 50; // 20 Hz for 6s
const TRADES_PER_TICK_PER_PANEL = 3;
const REPEATS = 3;

const MARKETS_8 = [
  "BINANCE_FUTURES:btcusdt",
  "BINANCE_FUTURES:ethusdt",
  "BINANCE_FUTURES:solusdt",
  "BINANCE_FUTURES:avaxusdt",
  "BINANCE_FUTURES:xauusdt",
  "BINANCE_FUTURES:xagusdt",
  "BINANCE_FUTURES:clusdt",
  "BINANCE_FUTURES:btcusdt",
] as const;

const HEAP_ARGS = ["--enable-precise-memory-info"];

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS, ...HEAP_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

function build4000TpoBars(anchorLastStart: number): WireBar[] {
  const firstStart = anchorLastStart - (BAR_COUNT - 1) * INTERVAL_30M;
  const bars: WireBar[] = new Array(BAR_COUNT);
  let seed = 133742;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let price = 60_000;
  for (let i = 0; i < BAR_COUNT; i++) {
    const stepMove = (Math.floor(rand() * 7) - 3) * PRICE_STEP;
    const open = price;
    const close = Math.max(1_000, open + stepMove);
    const wickUp = (1 + Math.floor(rand() * 4)) * PRICE_STEP;
    const wickDn = (1 + Math.floor(rand() * 4)) * PRICE_STEP;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDn;
    price = close;
    const buyA = 2.5 + (i % 5) * 0.4;
    const sellA = 1.9 + (i % 4) * 0.35;
    bars[i] = {
      t: firstStart + i * INTERVAL_30M,
      o: open,
      h: high,
      l: low,
      c: close,
      v: buyA + sellA,
      d: buyA - sellA,
      n: 10 + (i % 7),
      cells: [
        [low, buyA, sellA, 0, 0],
        [high, sellA, buyA, 0, 0],
      ],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: anchorLastStart + 1000,
    };
  }
  return bars;
}

interface SummaryStat {
  count: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface Step1RunReport {
  elapsedMs: number;
  rafFrames: number;
  fps: number;
  tradesSent: number;
  tradesFlushed: number;
  heapDeltaBytes: number | null;
  longTasksCount: number;
  cacheCalls: number;
  cacheEarlyHits: number;
  skippedGroups: number;
  computedGroups: number;
  closedTpoReuse: number;
  paintRetainedFrames: number;
  paintRetainHits: number;
  paintRetainMisses: number;
  paintNonRetainedFrames: number;
  drawImageCalls: number;
  drawImageTotalMs: number;
  changesDist: Record<string, number>;
  rafJs: SummaryStat;
  frameRender: SummaryStat;
  tpoCompute: SummaryStat;
  tpoPaint: SummaryStat;
  tpoLayer: SummaryStat;
  cachePerCall: Record<"a1" | "a2" | "a3" | "a4" | "total", SummaryStat>;
  cachePerFrame: Record<"a1" | "a2" | "a3" | "a4" | "total", SummaryStat>;
  paintPerCall: Record<"b1" | "b2" | "b3" | "total", SummaryStat>;
  paintPerFrame: Record<"b1" | "b2" | "b3" | "total", SummaryStat>;
}

interface AbRunReport {
  mode: "candlestick" | "tpo-main" | "tpo-pr";
  actualColWidth: number;
  visibleGroupsSample: number;
  elapsedMs: number;
  rafFrames: number;
  fps: number;
  tradesSent: number;
  tradesFlushed: number;
  heapDeltaBytes: number | null;
  longTasksCount: number;
  skippedGroups: number;
  computedGroups: number;
  closedTpoReuse: number;
  changesDist: Record<string, number>;
  rafJs: SummaryStat;
  frameRender: SummaryStat;
  tpoCompute: SummaryStat;
  tpoPaint: SummaryStat;
  tpoLayer: SummaryStat;
}

function medianOf(values: number[]): number {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (valid.length === 0) return 0;
  const mid = Math.floor(valid.length / 2);
  const val = valid.length % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
  return Math.round(val * 1000) / 1000;
}

function summarizeRuns(runs: AbRunReport[]) {
  const r = runs[0];
  return {
    mode: r.mode,
    repeats: runs.length,
    actualColWidth: medianOf(runs.map((x) => x.actualColWidth)),
    visibleGroups: medianOf(runs.map((x) => x.visibleGroupsSample)),
    fpsMedian: medianOf(runs.map((x) => x.fps)),
    rafJsP50Median: medianOf(runs.map((x) => x.rafJs.p50Ms)),
    rafJsP95Median: medianOf(runs.map((x) => x.rafJs.p95Ms)),
    frameRenderP50Median: medianOf(runs.map((x) => x.frameRender.p50Ms)),
    frameRenderP95Median: medianOf(runs.map((x) => x.frameRender.p95Ms)),
    tpoComputeP50Median: medianOf(runs.map((x) => x.tpoCompute.p50Ms)),
    tpoComputeP95Median: medianOf(runs.map((x) => x.tpoCompute.p95Ms)),
    tpoPaintP50Median: medianOf(runs.map((x) => x.tpoPaint.p50Ms)),
    tpoPaintP95Median: medianOf(runs.map((x) => x.tpoPaint.p95Ms)),
    tpoLayerP50Median: medianOf(runs.map((x) => x.tpoLayer.p50Ms)),
    tpoLayerP95Median: medianOf(runs.map((x) => x.tpoLayer.p95Ms)),
    skippedGroupsMedian: medianOf(runs.map((x) => x.skippedGroups)),
    computedGroupsMedian: medianOf(runs.map((x) => x.computedGroups)),
    closedTpoReuseMedian: medianOf(runs.map((x) => x.closedTpoReuse)),
    longTasksMedian: medianOf(runs.map((x) => x.longTasksCount)),
    heapDeltaMiBMedian: medianOf(runs.map((x) => (x.heapDeltaBytes ?? 0) / (1024 * 1024))),
    rawRuns: runs.map((x) => ({
      fps: x.fps,
      rafJsP50: x.rafJs.p50Ms,
      rafJsP95: x.rafJs.p95Ms,
      frameRenderP50: x.frameRender.p50Ms,
      frameRenderP95: x.frameRender.p95Ms,
      longTasks: x.longTasksCount,
      heapDeltaBytes: x.heapDeltaBytes,
      skippedGroups: x.skippedGroups,
      computedGroups: x.computedGroups,
      closedTpoReuse: x.closedTpoReuse,
      changesDist: x.changesDist,
      tradesSent: x.tradesSent,
      tradesFlushed: x.tradesFlushed,
    })),
  };
}

async function setupRoutes(page: import("@playwright/test").Page, bars: WireBar[]) {
  const fullPayload = JSON.stringify({
    ok: true,
    data: { bars },
    meta: {
      schemaVersion: 1,
      generatedAt: Date.now(),
      footprint: { available: true, allowed: true, priceStep: PRICE_STEP },
      footprintCoverage: {
        status: "complete",
        requestedFrom: bars[0].t,
        requestedTo: bars[bars.length - 1].t,
        coveredFrom: bars[0].t,
        coveredThrough: bars[bars.length - 1].t + INTERVAL_30M,
      },
    },
  });

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });

  await page.route("**/src/core/performanceTelemetry.ts*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const patched = body.replace(
      /(function\s+recordPerformanceDuration\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{[\s\S]*?)(totals\.set\()/,
      `$1globalThis.__tpoBenchPerfRecord?.($2, $3); $4`,
    );
    if (patched === body) {
      throw new Error("Failed to instrument recordPerformanceDuration in /src/core/performanceTelemetry.ts");
    }
    const headers = { ...response.headers() };
    delete headers["content-length"];
    await route.fulfill({ status: response.status(), headers, body: patched });
  });

  await page.route(/\/history(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (Number.isFinite(from) && Number.isFinite(to) && from <= bars[0].t && to >= bars[bars.length - 1].t) {
      return route.fulfill({ contentType: "application/json", body: fullPayload });
    }
    const matched = Number.isFinite(from) && Number.isFinite(to)
      ? bars.filter((bar) => bar.t >= from && bar.t <= to)
      : bars;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { bars: matched },
        meta: {
          schemaVersion: 1,
          generatedAt: Date.now(),
          footprint: { available: true, allowed: true, priceStep: PRICE_STEP },
          footprintCoverage: {
            status: "complete",
            requestedFrom: Number.isFinite(from) ? from : bars[0].t,
            requestedTo: Number.isFinite(to) ? to : bars[bars.length - 1].t,
            coveredFrom: bars[0].t,
            coveredThrough: bars[bars.length - 1].t + INTERVAL_30M,
          },
        },
      }),
    });
  });
}

async function runSingleIteration(
  page: import("@playwright/test").Page,
  cdp: import("@playwright/test").CDPSession,
  opts: {
    mode: "candlestick" | "tpo-main" | "tpo-pr";
    collectStep1: boolean;
    charts: number;
    columns: number;
    rows: number;
    viewport: { width: number; height: number };
    targetColWidth: number | null;
    cpuRate: number;
  },
): Promise<{ ab: AbRunReport; step1?: Step1RunReport }> {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await openHarness(page, "");

  // Phase 1 (unthrottled): mount charts, wait for 4000 bars to load, apply target zoom.
  await page.evaluate(
    async ({ mode, collectStep1, charts, columns, rows, markets, viewport, targetColWidth }) => {
      const [harness, { createHarnessServices }, telemetry, { Overlay }, { AnnotationPassCache }, { ChartChange }] = await Promise.all([
        import("/harness/chart.ts"),
        import("/harness/services.ts"),
        import("/src/core/performanceTelemetry.ts"),
        import("/src/core/render/overlay.ts"),
        import("/src/core/render/overlay/annotationPassCache.ts"),
        import("/src/core/render/scene/chartScene.ts"),
      ]);

      const globalBag = globalThis as Record<string, unknown>;
      globalBag.__tpoBenchMode = mode === "tpo-main" ? "main" : "pr";

      const prevTelemetry = telemetry.isPerformanceTelemetryEnabled();
      telemetry.configurePerformanceTelemetry({ enabled: true });

      const cellWidth = Math.floor(viewport.width / columns);
      const cellHeight = Math.floor(viewport.height / rows);

      const roots: HTMLDivElement[] = [];
      const handles: Array<{ dispose(): void }> = [];
      const panelIds: string[] = [];
      const panelServices: ReturnType<typeof createHarnessServices>[] = [];
      const panelMarkets: string[] = [];
      let settledCount = 0;

      for (let i = 0; i < charts; i++) {
        const market = markets[i];
        const panelId = `tpo-bench-${charts}-${i}`;
        const root = document.createElement("div");
        root.style.cssText = `position:fixed;left:${(i % columns) * cellWidth}px;top:${Math.floor(i / columns) * cellHeight}px;width:${cellWidth}px;height:${cellHeight}px;`;
        document.body.appendChild(root);
        roots.push(root);

        const baseSvc = createHarnessServices({ priceStep: 10, priceStepResolved: true });
        let settled = false;
        const services = {
          ...baseSvc,
          notifyInteractiveHistorySettled(...args: Parameters<typeof baseSvc.notifyInteractiveHistorySettled>) {
            if (!settled) {
              settled = true;
              settledCount += 1;
            }
            return baseSvc.notifyInteractiveHistorySettled(...args);
          },
        };
        const state: ChartPanelState = {
          type: "chart",
          market,
          timeframe: "30m",
          scaleMode: "linear",
          chartType: mode === "candlestick" ? "candlestick" : "tpo",
          tpoMode: "blocks",
          tpoProfilePeriod: "daily",
          tpoBracketSize: "30m",
          candles: true,
        };
        const handle = harness.mountChart(root, state, services, panelId, harness.createChartSurfaceModel());
        handles.push(handle);
        panelIds.push(panelId);
        panelServices.push(services);
        panelMarkets.push(market);
      }

      const deadline = performance.now() + 45_000;
      while (performance.now() < deadline) {
        const ready = settledCount >= charts && panelIds.every((id) => {
          const rt = harness.getChartRuntime(id);
          return rt && rt.pipeline.series.length >= 4000;
        });
        if (ready) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      for (const id of panelIds) {
        const rt = harness.getChartRuntime(id);
        if (!rt || rt.pipeline.series.length < 4000) {
          throw new Error(`Panel ${id} loaded only ${rt?.pipeline.series.length ?? 0} bars`);
        }
      }

      await new Promise((r) => setTimeout(r, 150));
      for (let f = 0; f < 2; f++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      for (const id of panelIds) {
        const rt = harness.getChartRuntime(id)!;
        if (targetColWidth !== null) {
          rt.view.colWidth = targetColWidth;
          rt.view.offsetX = rt.view.area.width - rt.pipeline.series.length * targetColWidth;
        }
        rt.autoFit();
        rt.session.invalidate(ChartChange.Viewport);
      }

      for (let f = 0; f < 6; f++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      const firstRt = harness.getChartRuntime(panelIds[0])!;
      const firstOverlay = Reflect.get(firstRt, "overlay") as { tpoCache?: { groups?: unknown[] } | null };
      const tailStartTime = firstRt.pipeline.series.at(firstRt.pipeline.series.length - 1)!.startTime;

      globalBag.__tpoBenchCtx = {
        mode,
        collectStep1,
        prevTelemetry,
        telemetry,
        Overlay,
        AnnotationPassCache,
        harness,
        roots,
        handles,
        panelIds,
        panelServices,
        panelMarkets,
        tailStartTime,
        actualColWidth: firstRt.view.colWidth,
        visibleGroupsSample: firstOverlay?.tpoCache?.groups?.length ?? 0,
      };
    },
    {
      mode: opts.mode,
      collectStep1: opts.collectStep1,
      charts: opts.charts,
      columns: opts.columns,
      rows: opts.rows,
      markets: [...MARKETS_8],
      viewport: opts.viewport,
      targetColWidth: opts.targetColWidth,
    },
  );

  // Phase 2 (under CDP CPU throttling): 6s 20 Hz live trade ticks.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: opts.cpuRate });

  const result = await page.evaluate(
    async ({ tickCount, tickIntervalMs, tradesPerTick }) => {
      const globalBag = globalThis as Record<string, unknown>;
      const ctx = globalBag.__tpoBenchCtx as {
        mode: "candlestick" | "tpo-main" | "tpo-pr";
        collectStep1: boolean;
        prevTelemetry: boolean;
        telemetry: typeof import("/src/core/performanceTelemetry.ts");
        Overlay: typeof import("/src/core/render/overlay.ts").Overlay;
        AnnotationPassCache: typeof import("/src/core/render/overlay/annotationPassCache.ts").AnnotationPassCache;
        harness: typeof import("/harness/chart.ts");
        roots: HTMLDivElement[];
        handles: Array<{ dispose(): void }>;
        panelIds: string[];
        panelServices: Array<{ pushTrade(market: string, trade: any): void }>;
        panelMarkets: string[];
        tailStartTime: number;
        actualColWidth: number;
        visibleGroupsSample: number;
      };

      const {
        mode, collectStep1, prevTelemetry, telemetry, Overlay, AnnotationPassCache,
        harness, roots, handles, panelIds, panelServices, panelMarkets,
        tailStartTime, actualColWidth, visibleGroupsSample,
      } = ctx;

      const summarize = (values: readonly number[]): SummaryStat => {
        const valid = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
        const n = valid.length;
        if (n === 0) return { count: 0, totalMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
        const r3 = (x: number) => Math.round(x * 1000) / 1000;
        const at = (q: number) => valid[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
        const total = valid.reduce((a, b) => a + b, 0);
        return {
          count: n,
          totalMs: r3(total),
          avgMs: r3(total / n),
          p50Ms: r3(at(0.5)),
          p95Ms: r3(at(0.95)),
          maxMs: r3(valid[n - 1]),
        };
      };

      const rafJsSamples: number[] = [];
      const frameRenderSamples: number[] = [];
      const tpoComputeSamples: number[] = [];
      const tpoPaintSamples: number[] = [];
      const tpoLayerSamples: number[] = [];
      const longTasks: number[] = [];
      const changesDist: Record<string, number> = {};

      // Step 1 detailed buckets
      const cachePerCall = { a1: [] as number[], a2: [] as number[], a3: [] as number[], a4: [] as number[], total: [] as number[] };
      const cachePerFrame = { a1: [] as number[], a2: [] as number[], a3: [] as number[], a4: [] as number[], total: [] as number[] };
      const paintPerCall = { b1: [] as number[], b2: [] as number[], b3: [] as number[], total: [] as number[] };
      const paintPerFrame = { b1: [] as number[], b2: [] as number[], b3: [] as number[], total: [] as number[] };
      let cacheEarlyHits = 0;
      let paintRetainedFrames = 0;
      let paintRetainHits = 0;
      let paintRetainMisses = 0;
      let paintNonRetainedFrames = 0;
      let drawImageCalls = 0;
      let drawImageTotalMs = 0;

      let active = false;
      let rafCount = 0;
      let turnHasWork = false;
      let turnJsMs = 0;
      let curFrameHasCache = false;
      let curFrameA1 = 0;
      let curFrameA2 = 0;
      let curFrameA3 = 0;
      let curFrameA4 = 0;
      let curFrameATotal = 0;
      let curFrameHasPaint = false;
      let curFrameB1 = 0;
      let curFrameB2 = 0;
      let curFrameB3 = 0;
      let curFrameBTotal = 0;
      let endOfTurnQueued = false;

      const mc = new MessageChannel();
      mc.port1.onmessage = () => {
        endOfTurnQueued = false;
        if (active && turnHasWork) rafJsSamples.push(turnJsMs);
        if (active && collectStep1 && curFrameHasCache) {
          cachePerFrame.a1.push(curFrameA1);
          cachePerFrame.a2.push(curFrameA2);
          cachePerFrame.a3.push(curFrameA3);
          cachePerFrame.a4.push(curFrameA4);
          cachePerFrame.total.push(curFrameATotal);
        }
        if (active && collectStep1 && curFrameHasPaint) {
          paintPerFrame.b1.push(curFrameB1);
          paintPerFrame.b2.push(curFrameB2);
          paintPerFrame.b3.push(curFrameB3);
          paintPerFrame.total.push(curFrameBTotal);
        }
        turnHasWork = false;
        turnJsMs = 0;
        curFrameHasCache = false;
        curFrameA1 = curFrameA2 = curFrameA3 = curFrameA4 = curFrameATotal = 0;
        curFrameHasPaint = false;
        curFrameB1 = curFrameB2 = curFrameB3 = curFrameBTotal = 0;
      };

      const origRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = ((callback: FrameRequestCallback): number =>
        origRaf((ts: number) => {
          if (!endOfTurnQueued) {
            endOfTurnQueued = true;
            mc.port2.postMessage(undefined);
          }
          const start = performance.now();
          try {
            callback(ts);
          } finally {
            turnJsMs += Math.max(0, performance.now() - start);
          }
        })) as typeof window.requestAnimationFrame;

      let sampling = true;
      const rafCounterLoop = () => {
        if (!sampling) return;
        if (active) rafCount += 1;
        origRaf(rafCounterLoop);
      };
      origRaf(rafCounterLoop);

      globalBag.__tpoBenchPerfRecord = (name: string, durationMs: number) => {
        if (!active || !Number.isFinite(durationMs) || durationMs < 0) return;
        if (name === "pipeline.flush" || name === "chart.frame.render.ms") turnHasWork = true;
        if (name === "chart.frame.render.ms") frameRenderSamples.push(durationMs);
        else if (name === "chart.tpo.compute.ms") tpoComputeSamples.push(durationMs);
        else if (name === "chart.tpo.paint.ms") tpoPaintSamples.push(durationMs);
        else if (name === "chart.annotation.layer.tpo.ms") tpoLayerSamples.push(durationMs);
      };

      const origRenderAnnotations = Overlay.prototype.renderAnnotations;
      Overlay.prototype.renderAnnotations = function (view, series, crosshair, range, layerOrder, changes = 0, asOfTime) {
        if (active) {
          const k = String(changes);
          changesDist[k] = (changesDist[k] ?? 0) + 1;
        }
        return origRenderAnnotations.call(this, view, series, crosshair, range, layerOrder, changes, asOfTime);
      };

      let origPassRender: typeof AnnotationPassCache.prototype.render | null = null;
      let origDrawImage: typeof CanvasRenderingContext2D.prototype.drawImage | null = null;
      let inClosedTpo = false;

      if (collectStep1) {
        origPassRender = AnnotationPassCache.prototype.render;
        origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
          if (active && inClosedTpo) {
            const t0 = performance.now();
            try {
              return (origDrawImage as (...a: unknown[]) => unknown).apply(this, args);
            } finally {
              drawImageCalls += 1;
              drawImageTotalMs += performance.now() - t0;
            }
          }
          return (origDrawImage as (...a: unknown[]) => unknown).apply(this, args);
        };
        AnnotationPassCache.prototype.render = function (ctx2d, pass, key, changes, draw, replay) {
          const isClosedTpo = pass?.id === "closed-tpo";
          if (isClosedTpo) inClosedTpo = true;
          try {
            return origPassRender!.call(this, ctx2d, pass, key, changes, draw, replay);
          } finally {
            if (isClosedTpo) inClosedTpo = false;
          }
        };

        globalBag.__tpoStep1 = {
          onCacheEarlyHit() {
            if (active) cacheEarlyHits += 1;
          },
          onCacheMeasure(sample: { a1Ms: number; a2Ms: number; a3Ms: number; a4Ms: number; totalMs: number }) {
            if (!active) return;
            cachePerCall.a1.push(sample.a1Ms);
            cachePerCall.a2.push(sample.a2Ms);
            cachePerCall.a3.push(sample.a3Ms);
            cachePerCall.a4.push(sample.a4Ms);
            cachePerCall.total.push(sample.totalMs);
            curFrameHasCache = true;
            curFrameA1 += sample.a1Ms;
            curFrameA2 += sample.a2Ms;
            curFrameA3 += sample.a3Ms;
            curFrameA4 += sample.a4Ms;
            curFrameATotal += sample.totalMs;
          },
          onPaintMeasure(sample: { retainedPath: boolean; retainHit: boolean; b1Ms: number; b2Ms: number; b3Ms: number; totalMs: number }) {
            if (!active) return;
            if (sample.retainedPath) {
              paintRetainedFrames += 1;
              if (sample.retainHit) paintRetainHits += 1;
              else paintRetainMisses += 1;
            } else {
              paintNonRetainedFrames += 1;
            }
            paintPerCall.b1.push(sample.b1Ms);
            paintPerCall.b2.push(sample.b2Ms);
            paintPerCall.b3.push(sample.b3Ms);
            paintPerCall.total.push(sample.totalMs);
            curFrameHasPaint = true;
            curFrameB1 += sample.b1Ms;
            curFrameB2 += sample.b2Ms;
            curFrameB3 += sample.b3Ms;
            curFrameBTotal += sample.totalMs;
          },
        };
      }

      let observer: PerformanceObserver | null = null;
      try {
        observer = new PerformanceObserver((list) => {
          if (!active) return;
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: "longtask", buffered: false });
      } catch {
        observer = null;
      }

      try {
        const beforeSnap = telemetry.snapshotPerformanceTelemetry().counters;
        const flushedBefore = beforeSnap["pipeline.flush.trades"] ?? 0;
        const skippedBefore = beforeSnap["chart.tpo.cache.skippedGroups"] ?? 0;
        const computedBefore = beforeSnap["chart.tpo.compute.groups"] ?? 0;
        const reuseBefore = beforeSnap["chart.annotation.pass.closed-tpo.reuse"] ?? 0;
        const heapBefore: number | null = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;

        const basePrice = harness.getChartRuntime(panelIds[0])!.pipeline.series.at(
          harness.getChartRuntime(panelIds[0])!.pipeline.series.length - 1,
        )!.close;

        let seq = 0;
        let sent = 0;
        const tStart = performance.now();
        active = true;

        for (let tick = 0; tick < tickCount; tick++) {
          const targetAt = tStart + tick * tickIntervalMs;
          const wait = Math.max(0, targetAt - performance.now());
          await new Promise<void>((resolve) => setTimeout(resolve, wait));

          for (let p = 0; p < panelServices.length; p++) {
            const market = panelMarkets[p];
            const svc = panelServices[p];
            for (let k = 0; k < tradesPerTick; k++) {
              const tradeSeq = seq++;
              // Oscillate mostly inside bar range (brackets path), widening tail high every 12 ticks (profile path).
              const stepExpansion = tick % 12 === 11 && k === tradesPerTick - 1 ? (Math.floor(tick / 12) + 4) * 10 : 0;
              const wiggle = ((tradeSeq % 5) - 2) * 10 + stepExpansion;
              const t = tailStartTime + 100 + tradeSeq;
              svc.pushTrade(market, {
                id: `bench228-${p}-${tradeSeq}`,
                time: t,
                price: Math.max(100, basePrice + wiggle),
                qty: 0.5,
                isBuy: (tradeSeq & 1) === 0,
                liquidation: false,
                market,
                source: "live",
                receivedAt: t + 1,
              });
              sent += 1;
            }
          }
        }

        const flushDeadline = performance.now() + 45_000;
        while (performance.now() < flushDeadline) {
          const curFlushed = (telemetry.snapshotPerformanceTelemetry().counters["pipeline.flush.trades"] ?? 0) - flushedBefore;
          if (curFlushed >= sent) break;
          await new Promise<void>((resolve) => origRaf(() => resolve()));
        }
        for (let f = 0; f < 4; f++) {
          await new Promise<void>((resolve) => origRaf(() => resolve()));
        }
        const elapsedMs = Math.max(1, performance.now() - tStart);
        active = false;

        const afterSnap = telemetry.snapshotPerformanceTelemetry().counters;
        const heapAfter: number | null = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
        const skippedGroups = (afterSnap["chart.tpo.cache.skippedGroups"] ?? 0) - skippedBefore;
        const computedGroups = (afterSnap["chart.tpo.compute.groups"] ?? 0) - computedBefore;
        const closedTpoReuse = (afterSnap["chart.annotation.pass.closed-tpo.reuse"] ?? 0) - reuseBefore;
        const tradesFlushed = (afterSnap["pipeline.flush.trades"] ?? 0) - flushedBefore;

        const fps = Math.round((rafCount / (elapsedMs / 1000)) * 100) / 100;
        const rafJs = summarize(rafJsSamples);
        const frameRender = summarize(frameRenderSamples);
        const tpoCompute = summarize(tpoComputeSamples);
        const tpoPaint = summarize(tpoPaintSamples);
        const tpoLayer = summarize(tpoLayerSamples);

        const ab: AbRunReport = {
          mode,
          actualColWidth: Math.round(actualColWidth * 1000) / 1000,
          visibleGroupsSample,
          elapsedMs: Math.round(elapsedMs),
          rafFrames: rafCount,
          fps,
          tradesSent: sent,
          tradesFlushed,
          heapDeltaBytes: heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null,
          longTasksCount: longTasks.length,
          skippedGroups,
          computedGroups,
          closedTpoReuse,
          changesDist,
          rafJs,
          frameRender,
          tpoCompute,
          tpoPaint,
          tpoLayer,
        };

        if (!collectStep1) return { ab };

        const step1: Step1RunReport = {
          elapsedMs: ab.elapsedMs,
          rafFrames: ab.rafFrames,
          fps: ab.fps,
          tradesSent: sent,
          tradesFlushed,
          heapDeltaBytes: ab.heapDeltaBytes,
          longTasksCount: longTasks.length,
          cacheCalls: cachePerCall.total.length,
          cacheEarlyHits,
          skippedGroups,
          computedGroups,
          closedTpoReuse,
          paintRetainedFrames,
          paintRetainHits,
          paintRetainMisses,
          paintNonRetainedFrames,
          drawImageCalls,
          drawImageTotalMs: Math.round(drawImageTotalMs * 1000) / 1000,
          changesDist,
          rafJs,
          frameRender,
          tpoCompute,
          tpoPaint,
          tpoLayer,
          cachePerCall: {
            a1: summarize(cachePerCall.a1),
            a2: summarize(cachePerCall.a2),
            a3: summarize(cachePerCall.a3),
            a4: summarize(cachePerCall.a4),
            total: summarize(cachePerCall.total),
          },
          cachePerFrame: {
            a1: summarize(cachePerFrame.a1),
            a2: summarize(cachePerFrame.a2),
            a3: summarize(cachePerFrame.a3),
            a4: summarize(cachePerFrame.a4),
            total: summarize(cachePerFrame.total),
          },
          paintPerCall: {
            b1: summarize(paintPerCall.b1),
            b2: summarize(paintPerCall.b2),
            b3: summarize(paintPerCall.b3),
            total: summarize(paintPerCall.total),
          },
          paintPerFrame: {
            b1: summarize(paintPerFrame.b1),
            b2: summarize(paintPerFrame.b2),
            b3: summarize(paintPerFrame.b3),
            total: summarize(paintPerFrame.total),
          },
        };
        return { ab, step1 };
      } finally {
        active = false;
        sampling = false;
        delete globalBag.__tpoBenchPerfRecord;
        delete globalBag.__tpoStep1;
        delete globalBag.__tpoBenchMode;
        delete globalBag.__tpoBenchCtx;
        window.requestAnimationFrame = origRaf;
        Overlay.prototype.renderAnnotations = origRenderAnnotations;
        if (origPassRender) AnnotationPassCache.prototype.render = origPassRender;
        if (origDrawImage) CanvasRenderingContext2D.prototype.drawImage = origDrawImage;
        observer?.disconnect();
        mc.port1.close();
        mc.port2.close();
        for (const h of handles) h.dispose();
        for (const r of roots) r.remove();
        telemetry.configurePerformanceTelemetry({ enabled: prevTelemetry });
      }
    },
    { tickCount: TICK_COUNT, tickIntervalMs: TICK_INTERVAL_MS, tradesPerTick: TRADES_PER_TICK_PER_PANEL },
  );

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  expect(result.ab.tradesFlushed).toBeGreaterThanOrEqual(result.ab.tradesSent);
  return result;
}

const combinedOutput: Record<string, unknown> = {};

test.describe.serial("#228 Desktop 8-panel (4x2 1280x720 DPR 1)", () => {
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

  test("Step 1 internal breakdown on main (8x zoom-out 6x CPU, 3 repeats)", async ({ page }) => {
    test.setTimeout(300_000);
    const bars = build4000TpoBars(Math.floor(Date.now() / INTERVAL_30M) * INTERVAL_30M);
    await setupRoutes(page, bars);
    const cdp = await page.context().newCDPSession(page);

    const step1Runs: Step1RunReport[] = [];
    for (let r = 0; r < REPEATS; r++) {
      const res = await runSingleIteration(page, cdp, {
        mode: "tpo-main",
        collectStep1: true,
        charts: 8,
        columns: 4,
        rows: 2,
        viewport: { width: 1280, height: 720 },
        targetColWidth: 0.175,
        cpuRate: 6,
      });
      if (res.step1) step1Runs.push(res.step1);
    }

    const summary = {
      repeats: step1Runs.length,
      fpsMedian: medianOf(step1Runs.map((x) => x.fps)),
      rafJsP50Median: medianOf(step1Runs.map((x) => x.rafJs.p50Ms)),
      rafJsP95Median: medianOf(step1Runs.map((x) => x.rafJs.p95Ms)),
      frameRenderP50Median: medianOf(step1Runs.map((x) => x.frameRender.p50Ms)),
      frameRenderP95Median: medianOf(step1Runs.map((x) => x.frameRender.p95Ms)),
      tpoComputeP50Median: medianOf(step1Runs.map((x) => x.tpoCompute.p50Ms)),
      tpoComputeP95Median: medianOf(step1Runs.map((x) => x.tpoCompute.p95Ms)),
      tpoPaintP50Median: medianOf(step1Runs.map((x) => x.tpoPaint.p50Ms)),
      tpoPaintP95Median: medianOf(step1Runs.map((x) => x.tpoPaint.p95Ms)),
      tpoLayerP50Median: medianOf(step1Runs.map((x) => x.tpoLayer.p50Ms)),
      tpoLayerP95Median: medianOf(step1Runs.map((x) => x.tpoLayer.p95Ms)),
      skippedGroupsMedian: medianOf(step1Runs.map((x) => x.skippedGroups)),
      computedGroupsMedian: medianOf(step1Runs.map((x) => x.computedGroups)),
      closedTpoReuseMedian: medianOf(step1Runs.map((x) => x.closedTpoReuse)),
      paintRetainedFramesMedian: medianOf(step1Runs.map((x) => x.paintRetainedFrames)),
      paintRetainHitsMedian: medianOf(step1Runs.map((x) => x.paintRetainHits)),
      paintRetainMissesMedian: medianOf(step1Runs.map((x) => x.paintRetainMisses)),
      paintNonRetainedFramesMedian: medianOf(step1Runs.map((x) => x.paintNonRetainedFrames)),
      drawImageCallsMedian: medianOf(step1Runs.map((x) => x.drawImageCalls)),
      drawImageTotalMsMedian: medianOf(step1Runs.map((x) => x.drawImageTotalMs)),
      a1FrameP50Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a1.p50Ms)),
      a1FrameP95Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a1.p95Ms)),
      a1TotalMedian: medianOf(step1Runs.map((x) => x.cachePerCall.a1.totalMs)),
      a2FrameP50Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a2.p50Ms)),
      a2FrameP95Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a2.p95Ms)),
      a2TotalMedian: medianOf(step1Runs.map((x) => x.cachePerCall.a2.totalMs)),
      a3FrameP50Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a3.p50Ms)),
      a3FrameP95Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a3.p95Ms)),
      a3TotalMedian: medianOf(step1Runs.map((x) => x.cachePerCall.a3.totalMs)),
      a4FrameP50Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a4.p50Ms)),
      a4FrameP95Median: medianOf(step1Runs.map((x) => x.cachePerFrame.a4.p95Ms)),
      a4TotalMedian: medianOf(step1Runs.map((x) => x.cachePerCall.a4.totalMs)),
      aTotalFrameP50Median: medianOf(step1Runs.map((x) => x.cachePerFrame.total.p50Ms)),
      aTotalFrameP95Median: medianOf(step1Runs.map((x) => x.cachePerFrame.total.p95Ms)),
      b1FrameP50Median: medianOf(step1Runs.map((x) => x.paintPerFrame.b1.p50Ms)),
      b1FrameP95Median: medianOf(step1Runs.map((x) => x.paintPerFrame.b1.p95Ms)),
      b1TotalMedian: medianOf(step1Runs.map((x) => x.paintPerCall.b1.totalMs)),
      b2FrameP50Median: medianOf(step1Runs.map((x) => x.paintPerFrame.b2.p50Ms)),
      b2FrameP95Median: medianOf(step1Runs.map((x) => x.paintPerFrame.b2.p95Ms)),
      b2TotalMedian: medianOf(step1Runs.map((x) => x.paintPerCall.b2.totalMs)),
      b3FrameP50Median: medianOf(step1Runs.map((x) => x.paintPerFrame.b3.p50Ms)),
      b3FrameP95Median: medianOf(step1Runs.map((x) => x.paintPerFrame.b3.p95Ms)),
      b3TotalMedian: medianOf(step1Runs.map((x) => x.paintPerCall.b3.totalMs)),
      bTotalFrameP50Median: medianOf(step1Runs.map((x) => x.paintPerFrame.total.p50Ms)),
      bTotalFrameP95Median: medianOf(step1Runs.map((x) => x.paintPerFrame.total.p95Ms)),
      rawRuns: step1Runs,
    };
    combinedOutput.step1 = summary;
    console.log("BENCH_228_STEP1_JSON:" + JSON.stringify(summary));
    expect(step1Runs.length).toBe(REPEATS);
  });

  for (const scenario of [
    { id: "zoom_out_8x_4x", cpuRate: 4, colWidth: 0.175 },
    { id: "zoom_out_8x_6x", cpuRate: 6, colWidth: 0.175 },
    { id: "default_zoom_8x_6x", cpuRate: 6, colWidth: 1.028 },
  ] as const) {
    test(`Step 3 A/B: ${scenario.id}`, async ({ page }) => {
      test.setTimeout(300_000);
      const bars = build4000TpoBars(Math.floor(Date.now() / INTERVAL_30M) * INTERVAL_30M);
      await setupRoutes(page, bars);
      const cdp = await page.context().newCDPSession(page);

      const byMode: Record<"candlestick" | "tpo-main" | "tpo-pr", AbRunReport[]> = {
        candlestick: [],
        "tpo-main": [],
        "tpo-pr": [],
      };
      for (let r = 0; r < REPEATS; r++) {
        for (const mode of ["candlestick", "tpo-main", "tpo-pr"] as const) {
          const res = await runSingleIteration(page, cdp, {
            mode,
            collectStep1: false,
            charts: 8,
            columns: 4,
            rows: 2,
            viewport: { width: 1280, height: 720 },
            targetColWidth: scenario.colWidth,
            cpuRate: scenario.cpuRate,
          });
          byMode[mode].push(res.ab);
        }
      }

      const report = {
        id: scenario.id,
        cpuRate: scenario.cpuRate,
        targetColWidth: scenario.colWidth,
        candlestick: summarizeRuns(byMode.candlestick),
        tpoMain: summarizeRuns(byMode["tpo-main"]),
        tpoPr: summarizeRuns(byMode["tpo-pr"]),
      };
      combinedOutput[scenario.id] = report;
      console.log(`BENCH_228_SCENARIO_JSON:${scenario.id}:` + JSON.stringify(report));
      expect(byMode["tpo-pr"].length).toBe(REPEATS);
    });
  }
});

test.describe.serial("#228 Mobile 1-panel (390x844 DPR 3)", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  test("Step 3 A/B: mobile_1x_6x", async ({ page }) => {
    test.setTimeout(300_000);
    const bars = build4000TpoBars(Math.floor(Date.now() / INTERVAL_30M) * INTERVAL_30M);
    await setupRoutes(page, bars);
    const cdp = await page.context().newCDPSession(page);

    const byMode: Record<"candlestick" | "tpo-main" | "tpo-pr", AbRunReport[]> = {
      candlestick: [],
      "tpo-main": [],
      "tpo-pr": [],
    };
    for (let r = 0; r < REPEATS; r++) {
      for (const mode of ["candlestick", "tpo-main", "tpo-pr"] as const) {
        const res = await runSingleIteration(page, cdp, {
          mode,
          collectStep1: false,
          charts: 1,
          columns: 1,
          rows: 1,
          viewport: { width: 390, height: 844 },
          targetColWidth: null,
          cpuRate: 6,
        });
        byMode[mode].push(res.ab);
      }
    }

    const report = {
      id: "mobile_1x_6x",
      cpuRate: 6,
      targetColWidth: null,
      candlestick: summarizeRuns(byMode.candlestick),
      tpoMain: summarizeRuns(byMode["tpo-main"]),
      tpoPr: summarizeRuns(byMode["tpo-pr"]),
    };
    combinedOutput.mobile_1x_6x = report;
    console.log("BENCH_228_SCENARIO_JSON:mobile_1x_6x:" + JSON.stringify(report));
    console.log("BENCH_228_RESULTS_JSON:" + JSON.stringify(combinedOutput));
    expect(byMode["tpo-pr"].length).toBe(REPEATS);
  });
});
