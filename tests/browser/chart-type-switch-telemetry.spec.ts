import { expect, test, type Page } from "@playwright/test";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const MARKET = "BINANCE_FUTURES:btcusdt";
const TIMEFRAME = "15m";
const INTERVAL_MS = 15 * 60_000;
const TYPES_SEQUENCE = ["candlestick", "footprint", "footprintProfile", "tpo", "candlestick"] as const;
const WARM_ITERATIONS = 5;
const COLD_ITERATIONS = 3;

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] * 100) / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function installBrowserProbe(page: Page, intervalMs: number, frozenNow: number): Promise<void> {
  await page.evaluate(async ({ intervalMs, frozenNow }) => {
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    const harness = await import("/harness/chart.ts");
    telemetry.configurePerformanceTelemetry({ enabled: true });
    telemetry.resetPerformanceTelemetry();

    const w = window as unknown as {
      __longTasks?: Array<{ duration: number }>;
      __obsInstalled?: boolean;
      __probeTypeReady?: (panelId: string, chartType: string) => {
        firstReady: boolean;
        visibleReady: boolean;
        hasAnyCells: boolean;
        hasAllCells: boolean;
        hasTpoZone: boolean;
        gpuMs: number;
        annotationMs: number;
        computeMs: number;
      };
    };

    w.__longTasks = [];
    if (!w.__obsInstalled && "PerformanceObserver" in window) {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__longTasks?.push({ duration: entry.duration });
        });
        obs.observe({ entryTypes: ["longtask"] });
        w.__obsInstalled = true;
      } catch {
        // longtask unsupported in environment
      }
    }

    w.__probeTypeReady = (panelId: string, chartType: string) => {
      const r = harness.getChartRuntime(panelId);
      const metrics = telemetry.snapshotPerformanceTelemetry().metrics;
      const gpuDraws = metrics["chart.surface.gpu.draw.ms"]?.count ?? 0;
      const annDraws = metrics["chart.surface.annotation.draw.ms"]?.count ?? 0;
      const candleDraws = metrics["chart.gpu.candles.ms"]?.count ?? 0;
      const fpDraws = metrics["chart.gpu.footprint.ms"]?.count ?? 0;
      const profileDraws = metrics["chart.gpu.footprint-profile.ms"]?.count ?? 0;
      const tpoPaints = metrics["chart.tpo.paint.ms"]?.count ?? 0;
      const gpuMs = metrics["chart.surface.gpu.draw.ms"]?.totalMs ?? 0;
      const annotationMs = metrics["chart.surface.annotation.draw.ms"]?.totalMs ?? 0;
      const computeMs = (metrics["chart.tpo.compute.ms"]?.totalMs ?? 0)
        + (metrics["chart.gpu.footprint.ms"]?.totalMs ?? 0)
        + (metrics["chart.gpu.footprint-profile.ms"]?.totalMs ?? 0);

      if (!r) {
        return { firstReady: false, visibleReady: false, hasAnyCells: false, hasAllCells: false, hasTpoZone: false, gpuMs, annotationMs, computeMs };
      }

      const pipeline = Reflect.get(r, "pipeline") as {
        series: {
          listReadonly(): readonly Array<{
            startTime: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
            count: number;
            cells: { size: number };
          }>;
        };
      };
      const allBars = pipeline.series.listReadonly();
      const range = r.getVisibleTimeRange();
      const visibleBars = range
        ? allBars.filter((b) => b.startTime >= range.from - intervalMs && b.startTime <= range.to)
        : allBars;

      const hasFiniteOhlc = visibleBars.some(
        (b) => Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close),
      );
      const hasAnyCells = visibleBars.some((b) => b.cells.size > 0);
      const hasAllCells = hasAnyCells
        && visibleBars.every((b) => b.cells.size > 0 || (b.volume <= 0 && b.count <= 0));

      let hasTpoZone = false;
      if (chartType === "tpo" && allBars.length > 0 && annDraws > 0 && tpoPaints > 0) {
        const view = Reflect.get(r, "view") as { area: { top: number; height: number }; colWidth: number; xOfIndex(i: number): number };
        const overlay = Reflect.get(r, "overlay") as { getTpoProfileAt(x: number, y: number): unknown };
        const probeY = view.area.top + Math.max(1, view.area.height / 2);
        const startIdx = Math.max(0, allBars.length - visibleBars.length);
        const step = Math.max(1, Math.floor((allBars.length - startIdx) / 4));
        for (let i = startIdx; i < allBars.length; i += step) {
          if (overlay.getTpoProfileAt(view.xOfIndex(i) + Math.max(0.5, view.colWidth * 0.25), probeY) !== null) {
            hasTpoZone = true;
            break;
          }
        }
        if (!hasTpoZone) {
          hasTpoZone = overlay.getTpoProfileAt(view.xOfIndex(allBars.length - 1) + Math.max(0.5, view.colWidth * 0.25), probeY) !== null;
        }
        if (hasTpoZone) {
          const analysis = r.getAnalysisSnapshot({ now: frozenNow + 86_400_000 });
          hasTpoZone = (analysis.tpoProfiles?.length ?? 0) > 0;
        }
      }

      let firstReady = false;
      let visibleReady = false;
      switch (chartType) {
        case "candlestick":
          firstReady = gpuDraws > 0 && candleDraws > 0 && hasFiniteOhlc;
          visibleReady = firstReady;
          break;
        case "footprint":
          firstReady = gpuDraws > 0 && fpDraws > 0 && hasAnyCells;
          visibleReady = gpuDraws > 0 && fpDraws > 0 && hasAllCells;
          break;
        case "footprintProfile":
          firstReady = gpuDraws > 0 && profileDraws > 0 && hasAnyCells;
          visibleReady = gpuDraws > 0 && profileDraws > 0 && hasAllCells;
          break;
        case "tpo":
          firstReady = annDraws > 0 && tpoPaints > 0 && hasTpoZone;
          visibleReady = firstReady;
          break;
      }

      return { firstReady, visibleReady, hasAnyCells, hasAllCells, hasTpoZone, gpuMs, annotationMs, computeMs };
    };
  }, { intervalMs, frozenNow });
}

async function runBackendChartTypeSuite(page: Page, backend: "webgl2" | "canvas2d") {
  const fullBars = buildBars(120);
  const candleOnlyBars = fullBars.map((bar) => ({ ...bar, cells: [] }));
  let holdPhase2Footprint = false;
  const releasePhase2Queue: Array<() => void> = [];
  let currentTag = "init";
  const netStats = new Map<string, { requests: number; ohlcvRequests: number; bytes: number; dataAccessMs: number[] }>();

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return route.abort();
    }
    if (url.pathname !== "/history") {
      return route.continue();
    }
    const reqStarted = performance.now();
    const q = url.searchParams;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    const includeFootprint = q.get("includeFootprint") !== "0";

    if (includeFootprint && holdPhase2Footprint) {
      await new Promise<void>((resolve) => {
        releasePhase2Queue.push(resolve);
      });
    }

    const bars = includeFootprint ? fullBars : candleOnlyBars;
    const meta = {
      schemaVersion: 2,
      generatedAt: FROZEN_NOW,
      cache: { hit: currentTag.startsWith("warm:") },
      candleCoverage: {
        schemaVersion: 1,
        source: "binance-klines",
        instrument: MARKET,
        ownership: "snapshot",
        status: "verified",
        requestedFrom: from,
        requestedTo: to,
        snapshotAt: FROZEN_NOW,
        closedThrough: FROZEN_NOW,
        reasonCode: null,
      },
      footprint: { available: true, allowed: true, priceStep: 10 },
      footprintCoverage: {
        schemaVersion: 1,
        source: "binance-usdm-aggTrade",
        instrument: MARKET,
        authority: includeFootprint ? "canonical" : null,
        status: includeFootprint ? "verified" : "pending",
        requestedFrom: from,
        requestedTo: to,
        coveredFrom: includeFootprint ? from : null,
        coveredThrough: includeFootprint ? to : null,
        durableThroughId: includeFootprint ? "500" : null,
        projectionThroughId: includeFootprint ? "500" : null,
        authorityToken: includeFootprint ? "canonical" : null,
        reasonCode: null,
      },
    };
    const body = JSON.stringify({ ok: true, data: { bars }, meta });
    const entry = netStats.get(currentTag) ?? { requests: 0, ohlcvRequests: 0, bytes: 0, dataAccessMs: [] };
    entry.requests++;
    if (!includeFootprint) entry.ohlcvRequests++;
    entry.bytes += Buffer.byteLength(body);
    entry.dataAccessMs.push(performance.now() - reqStarted);
    netStats.set(currentTag, entry);
    return route.fulfill({ contentType: "application/json", body });
  });

  type StepSamples = {
    firstDataFrameMs: number[];
    visibleRangeReadyMs: number[];
    computeMs: number[];
    drawMs: number[];
    dataAccessMs: number[];
    requests: number;
    ohlcvRequests: number;
    bytes: number;
    longTasks: number;
    longTaskMs: number;
    frameBudgetOver16ms: number;
  };
  const emptyStep = (): StepSamples => ({
    firstDataFrameMs: [],
    visibleRangeReadyMs: [],
    computeMs: [],
    drawMs: [],
    dataAccessMs: [],
    requests: 0,
    ohlcvRequests: 0,
    bytes: 0,
    longTasks: 0,
    longTaskMs: 0,
    frameBudgetOver16ms: 0,
  });

  const coldResults: Record<string, StepSamples> = {
    candlestick: emptyStep(),
    footprint: emptyStep(),
    footprintProfile: emptyStep(),
    tpo: emptyStep(),
    candlestickReturn: emptyStep(),
  };
  const warmResults: Record<string, StepSamples> = {
    candlestick: emptyStep(),
    footprint: emptyStep(),
    footprintProfile: emptyStep(),
    tpo: emptyStep(),
    candlestickReturn: emptyStep(),
  };

  // --- Cold Cache Iterations (fresh mount each time; initial candlestick keeps Phase 2 gated so Cluster waits for real cells) ---
  for (let iter = 0; iter < COLD_ITERATIONS; iter++) {
    holdPhase2Footprint = true;
    currentTag = `cold:candlestick:${iter}`;
    netStats.set(currentTag, { requests: 0, ohlcvRequests: 0, bytes: 0, dataAccessMs: [] });

    await openHarness(page, `?gpu=${backend}`);
    await installBrowserProbe(page, INTERVAL_MS, FROZEN_NOW);

    // Mount fresh panel as candlestick
    const mountCheck = await page.evaluate(async ({ market, timeframe, intervalMs, frozenNow }) => {
      const harness = await import("/harness/chart.ts");
      const { createHarnessServices } = await import("/harness/services.ts");
      const w = window as unknown as {
        __coldHandle?: unknown;
        __probeTypeReady: (panelId: string, chartType: string) => {
          firstReady: boolean;
          visibleReady: boolean;
          gpuMs: number;
          annotationMs: number;
        };
      };
      const existing = document.getElementById("cold-panel-root");
      if (existing) existing.remove();
      const root = document.createElement("div");
      root.id = "cold-panel-root";
      root.style.cssText = "position:fixed;inset:0;overflow:hidden;";
      document.body.appendChild(root);
      const services = createHarnessServices({ priceStep: 10, priceStepResolved: true });
      const panelId = "cold-chart";
      const t0 = performance.now();
      const handle = harness.mountChart(
        root,
        { type: "chart", market, timeframe, scaleMode: "linear", chartType: "candlestick", candles: true },
        services,
        panelId,
      );
      let firstAt: number | null = null;
      let readyAt: number | null = null;
      await new Promise<void>((resolve) => {
        const deadline = performance.now() + 10_000;
        const check = () => {
          const now = performance.now();
          const hook = document.querySelector(`[data-panel-id="${panelId}"]`);
          const probe = w.__probeTypeReady(panelId, "candlestick");
          if (hook?.getAttribute("data-history-overlay") === "false" && Number(hook.getAttribute("data-series-len")) > 0) {
            if (firstAt === null && probe.firstReady) firstAt = now;
            if (readyAt === null && probe.visibleReady) readyAt = now;
          }
          if ((firstAt !== null && readyAt !== null) || now > deadline) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      const r = harness.getChartRuntime(panelId)!;
      r.setVisibleTimeRange({ from: frozenNow - 40 * intervalMs, to: frozenNow });
      const probe = w.__probeTypeReady(panelId, "candlestick");
      w.__coldHandle = handle;
      return {
        firstMs: (firstAt ?? performance.now()) - t0,
        readyMs: (readyAt ?? performance.now()) - t0,
        gpuMs: probe.gpuMs,
        annotationMs: probe.annotationMs,
      };
    }, { market: MARKET, timeframe: TIMEFRAME, intervalMs: INTERVAL_MS, frozenNow: FROZEN_NOW });

    const candleNet = netStats.get(currentTag)!;
    coldResults.candlestick.firstDataFrameMs.push(mountCheck.firstMs);
    coldResults.candlestick.visibleRangeReadyMs.push(mountCheck.readyMs);
    coldResults.candlestick.drawMs.push(mountCheck.gpuMs + mountCheck.annotationMs);
    coldResults.candlestick.requests += candleNet.requests;
    coldResults.candlestick.ohlcvRequests += candleNet.ohlcvRequests;
    coldResults.candlestick.bytes += candleNet.bytes;
    coldResults.candlestick.dataAccessMs.push(candleNet.dataAccessMs.reduce((a, b) => a + b, 0));

    // Switch to Cluster (footprint) while Phase 2 is still held -> verify placeholder frame has NO cells!
    currentTag = `cold:footprint:${iter}`;
    netStats.set(currentTag, { requests: 0, ohlcvRequests: 0, bytes: 0, dataAccessMs: [] });
    const placeholderCheck = await page.evaluate(async () => {
      const harness = await import("/harness/chart.ts");
      const telemetry = await import("/src/core/performanceTelemetry.ts");
      const w = window as unknown as {
        __longTasks?: Array<{ duration: number }>;
        __clusterStart?: number;
        __probeTypeReady: (panelId: string, chartType: string) => {
          firstReady: boolean;
          hasAnyCells: boolean;
        };
      };
      telemetry.resetPerformanceTelemetry();
      w.__longTasks = [];
      w.__clusterStart = performance.now();
      harness.getChartRuntime("cold-chart")!.setChartType("footprint");
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return w.__probeTypeReady("cold-chart", "footprint");
    });
    expect(placeholderCheck.firstReady, "empty/OHLCV-only Cluster frame must not pass first-data-frame readiness").toBe(false);
    expect(placeholderCheck.hasAnyCells, "empty/OHLCV-only Cluster frame must have zero footprint cells").toBe(false);

    // Release Phase 2 footprint cells and measure Cluster completion
    holdPhase2Footprint = false;
    while (releasePhase2Queue.length > 0) {
      releasePhase2Queue.shift()?.();
    }

    const clusterMeas = await page.evaluate(async () => {
      const w = window as unknown as {
        __clusterStart: number;
        __longTasks?: Array<{ duration: number }>;
        __probeTypeReady: (panelId: string, chartType: string) => {
          firstReady: boolean;
          visibleReady: boolean;
          gpuMs: number;
          annotationMs: number;
          computeMs: number;
        };
      };
      const frameTimes: number[] = [];
      let prev = performance.now();
      let firstAt: number | null = null;
      let readyAt: number | null = null;
      await new Promise<void>((resolve) => {
        const deadline = performance.now() + 10_000;
        const check = () => {
          const now = performance.now();
          frameTimes.push(now - prev);
          prev = now;
          const probe = w.__probeTypeReady("cold-chart", "footprint");
          if (firstAt === null && probe.firstReady) firstAt = now;
          if (readyAt === null && firstAt !== null && probe.visibleReady) readyAt = now;
          if ((firstAt !== null && readyAt !== null) || now > deadline) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      const probe = w.__probeTypeReady("cold-chart", "footprint");
      const longTasks = w.__longTasks ?? [];
      return {
        firstMs: (firstAt ?? performance.now()) - w.__clusterStart,
        readyMs: (readyAt ?? performance.now()) - w.__clusterStart,
        computeMs: probe.computeMs,
        drawMs: probe.gpuMs + probe.annotationMs,
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((s, e) => s + e.duration, 0),
        frameBudgetOver16ms: frameTimes.filter((d) => d > 16.7).length,
      };
    });
    const fpNet = netStats.get(currentTag)!;
    coldResults.footprint.firstDataFrameMs.push(clusterMeas.firstMs);
    coldResults.footprint.visibleRangeReadyMs.push(clusterMeas.readyMs);
    coldResults.footprint.computeMs.push(clusterMeas.computeMs);
    coldResults.footprint.drawMs.push(clusterMeas.drawMs);
    coldResults.footprint.dataAccessMs.push(fpNet.dataAccessMs.reduce((a, b) => a + b, 0));
    coldResults.footprint.requests += fpNet.requests;
    coldResults.footprint.ohlcvRequests += fpNet.ohlcvRequests;
    coldResults.footprint.bytes += fpNet.bytes;
    coldResults.footprint.longTasks += clusterMeas.longTasks;
    coldResults.footprint.longTaskMs += clusterMeas.longTaskMs;
    coldResults.footprint.frameBudgetOver16ms += clusterMeas.frameBudgetOver16ms;

    // Profile -> TPO -> Candlestick (cold render caches, 0 new network requests)
    for (const [key, nextType] of [
      ["footprintProfile", "footprintProfile"],
      ["tpo", "tpo"],
      ["candlestickReturn", "candlestick"],
    ] as const) {
      currentTag = `cold:${key}:${iter}`;
      netStats.set(currentTag, { requests: 0, ohlcvRequests: 0, bytes: 0, dataAccessMs: [] });
      const stepMeas = await page.evaluate(async ({ nextType }) => {
        const harness = await import("/harness/chart.ts");
        const telemetry = await import("/src/core/performanceTelemetry.ts");
        const w = window as unknown as {
          __longTasks?: Array<{ duration: number }>;
          __probeTypeReady: (panelId: string, chartType: string) => {
            firstReady: boolean;
            visibleReady: boolean;
            gpuMs: number;
            annotationMs: number;
            computeMs: number;
          };
        };
        w.__longTasks = [];
        telemetry.resetPerformanceTelemetry();
        const r = harness.getChartRuntime("cold-chart")!;
        const frameTimes: number[] = [];
        let prev = performance.now();
        const t0 = performance.now();
        let firstAt: number | null = null;
        let readyAt: number | null = null;
        r.setChartType(nextType);
        await new Promise<void>((resolve) => {
          const deadline = performance.now() + 10_000;
          const check = () => {
            const now = performance.now();
            frameTimes.push(now - prev);
            prev = now;
            const probe = w.__probeTypeReady("cold-chart", nextType);
            if (firstAt === null && probe.firstReady) firstAt = now;
            if (readyAt === null && firstAt !== null && probe.visibleReady) readyAt = now;
            if ((firstAt !== null && readyAt !== null) || now > deadline) resolve();
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        const probe = w.__probeTypeReady("cold-chart", nextType);
        const longTasks = w.__longTasks ?? [];
        return {
          firstMs: (firstAt ?? performance.now()) - t0,
          readyMs: (readyAt ?? performance.now()) - t0,
          computeMs: probe.computeMs,
          drawMs: probe.gpuMs + probe.annotationMs,
          longTasks: longTasks.length,
          longTaskMs: longTasks.reduce((s, e) => s + e.duration, 0),
          frameBudgetOver16ms: frameTimes.filter((d) => d > 16.7).length,
        };
      }, { nextType });

      const stepNet = netStats.get(currentTag)!;
      coldResults[key].firstDataFrameMs.push(stepMeas.firstMs);
      coldResults[key].visibleRangeReadyMs.push(stepMeas.readyMs);
      coldResults[key].computeMs.push(stepMeas.computeMs);
      coldResults[key].drawMs.push(stepMeas.drawMs);
      coldResults[key].requests += stepNet.requests;
      coldResults[key].bytes += stepNet.bytes;
      coldResults[key].longTasks += stepMeas.longTasks;
      coldResults[key].longTaskMs += stepMeas.longTaskMs;
      coldResults[key].frameBudgetOver16ms += stepMeas.frameBudgetOver16ms;
    }

    await page.evaluate(() => {
      (window as unknown as { __coldHandle?: { dispose(): void } }).__coldHandle?.dispose();
    });
  }

  // --- Warm Cache Iterations on a Single Mounted Chart (fixed visible range) ---
  currentTag = "warm:setup";
  await openHarness(page, `?chart=${encodeURIComponent(MARKET)}&timeframe=${TIMEFRAME}&type=candlestick&priceStep=10&gpu=${backend}`);
  const hook = page.locator('[data-testid="chart-hook"]');
  await expect(hook).toHaveAttribute("data-history-loading", "false");
  await expect(hook).toHaveAttribute("data-series-len", String(fullBars.length));

  await installBrowserProbe(page, INTERVAL_MS, FROZEN_NOW);
  await page.evaluate(async ({ frozenNow, intervalMs }) => {
    const harness = await import("/harness/chart.ts");
    const r = harness.getChartRuntime("harness-chart")!;
    r.setVisibleTimeRange({ from: frozenNow - 40 * intervalMs, to: frozenNow });
    // Warm up each mode once before measuring warm p50/p95
    for (const type of ["footprint", "footprintProfile", "tpo", "candlestick"] as const) {
      r.setChartType(type);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    }
  }, { frozenNow: FROZEN_NOW, intervalMs: INTERVAL_MS });

  for (let iter = 0; iter < WARM_ITERATIONS; iter++) {
    for (let idx = 1; idx < TYPES_SEQUENCE.length; idx++) {
      const nextType = TYPES_SEQUENCE[idx];
      const key = idx === TYPES_SEQUENCE.length - 1 ? "candlestickReturn" : nextType;
      currentTag = `warm:${key}:${iter}`;
      netStats.set(currentTag, { requests: 0, ohlcvRequests: 0, bytes: 0, dataAccessMs: [] });
      const stepMeas = await page.evaluate(async ({ nextType }) => {
        const harness = await import("/harness/chart.ts");
        const telemetry = await import("/src/core/performanceTelemetry.ts");
        const w = window as unknown as {
          __longTasks?: Array<{ duration: number }>;
          __probeTypeReady: (panelId: string, chartType: string) => {
            firstReady: boolean;
            visibleReady: boolean;
            gpuMs: number;
            annotationMs: number;
            computeMs: number;
          };
        };
        w.__longTasks = [];
        telemetry.resetPerformanceTelemetry();
        const r = harness.getChartRuntime("harness-chart")!;
        const frameTimes: number[] = [];
        let prev = performance.now();
        const t0 = performance.now();
        let firstAt: number | null = null;
        let readyAt: number | null = null;
        r.setChartType(nextType);
        await new Promise<void>((resolve) => {
          const deadline = performance.now() + 10_000;
          const check = () => {
            const now = performance.now();
            frameTimes.push(now - prev);
            prev = now;
            const probe = w.__probeTypeReady("harness-chart", nextType);
            if (firstAt === null && probe.firstReady) firstAt = now;
            if (readyAt === null && firstAt !== null && probe.visibleReady) readyAt = now;
            if ((firstAt !== null && readyAt !== null) || now > deadline) resolve();
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        const probe = w.__probeTypeReady("harness-chart", nextType);
        const longTasks = w.__longTasks ?? [];
        return {
          firstMs: (firstAt ?? performance.now()) - t0,
          readyMs: (readyAt ?? performance.now()) - t0,
          computeMs: probe.computeMs,
          drawMs: probe.gpuMs + probe.annotationMs,
          longTasks: longTasks.length,
          longTaskMs: longTasks.reduce((s, e) => s + e.duration, 0),
          frameBudgetOver16ms: frameTimes.filter((d) => d > 16.7).length,
        };
      }, { nextType });

      const stepNet = netStats.get(currentTag)!;
      warmResults[key].firstDataFrameMs.push(stepMeas.firstMs);
      warmResults[key].visibleRangeReadyMs.push(stepMeas.readyMs);
      warmResults[key].computeMs.push(stepMeas.computeMs);
      warmResults[key].drawMs.push(stepMeas.drawMs);
      warmResults[key].requests += stepNet.requests;
      warmResults[key].bytes += stepNet.bytes;
      warmResults[key].longTasks += stepMeas.longTasks;
      warmResults[key].longTaskMs += stepMeas.longTaskMs;
      warmResults[key].frameBudgetOver16ms += stepMeas.frameBudgetOver16ms;
      expect(stepNet.requests, `warm ${nextType} switch must reuse in-memory series without network fetches`).toBe(0);
    }
  }

  // Rapid chartType switch test: Candlestick -> Cluster -> Profile -> TPO -> Candlestick
  currentTag = "rapid-type-switch";
  netStats.set(currentTag, { requests: 0, ohlcvRequests: 0, bytes: 0, dataAccessMs: [] });
  const rapidSwitch = await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts");
    const telemetry = await import("/src/core/performanceTelemetry.ts");
    const w = window as unknown as {
      __probeTypeReady: (panelId: string, chartType: string) => {
        firstReady: boolean;
        visibleReady: boolean;
      };
    };
    telemetry.resetPerformanceTelemetry();
    const r = harness.getChartRuntime("harness-chart")!;
    r.setChartType("footprint");
    r.setChartType("footprintProfile");
    r.setChartType("tpo");
    r.setChartType("candlestick");
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const probe = w.__probeTypeReady("harness-chart", "candlestick");
    const metrics = telemetry.snapshotPerformanceTelemetry().metrics;
    return {
      finalType: r.getState().chartType,
      ready: probe.firstReady && probe.visibleReady,
      candleDraws: metrics["chart.gpu.candles.ms"]?.count ?? 0,
    };
  });
  expect(rapidSwitch.finalType).toBe("candlestick");
  expect(rapidSwitch.ready).toBe(true);
  expect(rapidSwitch.candleDraws).toBeGreaterThanOrEqual(1);
  expect(netStats.get(currentTag)?.requests ?? 0).toBe(0);

  const summarize = (bucket: Record<string, StepSamples>) =>
    Object.fromEntries(
      Object.entries(bucket).map(([step, data]) => {
        const avgData = data.dataAccessMs.length ? data.dataAccessMs.reduce((a, b) => a + b, 0) / data.dataAccessMs.length : 0;
        const avgCompute = data.computeMs.length ? data.computeMs.reduce((a, b) => a + b, 0) / data.computeMs.length : 0;
        const avgDraw = data.drawMs.length ? data.drawMs.reduce((a, b) => a + b, 0) / data.drawMs.length : 0;
        const bottleneck = avgData >= avgCompute && avgData >= avgDraw
          ? "data-access"
          : avgCompute >= avgDraw
            ? "compute"
            : "draw";
        return [
          step,
          {
            firstDataFrameP50Ms: percentile(data.firstDataFrameMs, 0.5),
            firstDataFrameP95Ms: percentile(data.firstDataFrameMs, 0.95),
            visibleRangeReadyP50Ms: percentile(data.visibleRangeReadyMs, 0.5),
            visibleRangeReadyP95Ms: percentile(data.visibleRangeReadyMs, 0.95),
            avgDataAccessMs: round2(avgData),
            avgComputeMs: round2(avgCompute),
            avgDrawMs: round2(avgDraw),
            bottleneck,
            requests: data.requests,
            ohlcvRequests: data.ohlcvRequests,
            bytes: data.bytes,
            longTasks: data.longTasks,
            longTaskMs: round2(data.longTaskMs),
            frameBudgetOver16ms: data.frameBudgetOver16ms,
          },
        ];
      }),
    );

  return {
    backend,
    cold: summarize(coldResults),
    warm: summarize(warmResults),
    rapidSwitch,
  };
}

test("chart type switch telemetry across WebGL2 and Canvas 2D (#244)", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const webglCtx = await browser.newContext();
  const canvasCtx = await browser.newContext();
  try {
    const webglPage = await webglCtx.newPage();
    const webgl2 = await runBackendChartTypeSuite(webglPage, "webgl2");
    const canvasPage = await canvasCtx.newPage();
    const canvas2d = await runBackendChartTypeSuite(canvasPage, "canvas2d");

    const evidence = {
      issue: 244,
      market: MARKET,
      timeframe: TIMEFRAME,
      sequence: TYPES_SEQUENCE,
      webgl2,
      canvas2d,
    };
    console.log("CHART_TYPE_SWITCH_EVIDENCE", JSON.stringify(evidence));
    await testInfo.attach("chart-type-switch-telemetry-244.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });

    expect(webgl2.cold.candlestick.ohlcvRequests).toBeGreaterThanOrEqual(COLD_ITERATIONS);
    expect(canvas2d.cold.candlestick.ohlcvRequests).toBeGreaterThanOrEqual(COLD_ITERATIONS);
  } finally {
    await webglCtx.close();
    await canvasCtx.close();
  }
});
