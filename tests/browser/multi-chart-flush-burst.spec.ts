import { expect, test } from "@playwright/test";
import type { ChartPanelState } from "../../src/core/chartPanelState.js";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, installHistory, INTERVAL_MS, openHarness } from "./support/history.js";

// #147 multi-panel flush & frame budget census across 1, 2, 4, and 8 active charts (2x4 grid).
// Measures real mounted ChartDataPipeline + ChartSession WebGL2/2D runtimes under two burst
// regimes (sustained HF stream and synchronous 1,000-trade-per-panel backlog waves) on CI runners.
const VIEWPORT = { width: 1280, height: 720 };

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
  viewport: VIEWPORT,
});

const FOOTPRINT_MARKETS = [
  "BINANCE_FUTURES:btcusdt",
  "BINANCE_FUTURES:ethusdt",
  "BINANCE_FUTURES:solusdt",
  "BINANCE_FUTURES:avaxusdt",
  "BINANCE_FUTURES:xauusdt",
  "BINANCE_FUTURES:xagusdt",
  "BINANCE_FUTURES:clusdt",
  "BINANCE_FUTURES:btcusdt",
] as const;

interface QuantileSummary {
  count: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  gt4MsCount: number;
  gt4MsPct: number;
  gt16_6MsCount: number;
  gt16_6MsPct: number;
  gt20MsCount: number;
  gt20MsPct: number;
  gt33_3MsPct: number;
}

interface PhaseReport {
  pipelineFlush: QuantileSummary;
  flushPerFrameTotalMs: QuantileSummary;
  frameRender: QuantileSummary;
  renderPerFrameTotalMs: QuantileSummary;
  frameWorkMs: QuantileSummary;
  rafIntervalMs: QuantileSummary;
  longTasksCount: number;
  maxLongTaskMs: number;
}

interface ChartCountReport {
  charts: number;
  grid: string;
  viewportPerChart: string;
  tradesSentTotal: number;
  tradesFlushed: number;
  overflowCount: number;
  overflowDroppedCount: number;
  volumeDeltaExact: boolean;
  sustained: PhaseReport;
  backlog: PhaseReport;
  combined: PhaseReport;
}

const SCENARIOS = [
  { charts: 1, columns: 1, rows: 1 },
  { charts: 2, columns: 2, rows: 1 },
  { charts: 4, columns: 2, rows: 2 },
  { charts: 8, columns: 4, rows: 2 },
] as const;

const allReports: ChartCountReport[] = [];

test.describe.serial("#147 multi-chart live-trade flush & frame budget census", () => {
  test.afterAll(() => {
    if (allReports.length === 0) return;
    console.log("MULTI_CHART_FLUSH_CENSUS_SUMMARY", JSON.stringify(allReports));
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.charts} active chart(s) (${scenario.columns}x${scenario.rows}) under HF burst & 1k/panel backlog waves`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);

      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
      });

      // Collect unclipped per-phase telemetry samples without mutating src/.
      await page.route("**/src/core/performanceTelemetry.ts*", async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        const patched = body.replace(
          /(function\s+recordPerformanceDuration\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{[\s\S]*?)(totals\.set\()/,
          `$1globalThis.__multiChartPerfRecord?.($2, $3); $4`,
        );
        if (patched === body) {
          throw new Error("Failed to instrument recordPerformanceDuration in /src/core/performanceTelemetry.ts");
        }
        const headers = { ...response.headers() };
        delete headers["content-length"];
        await route.fulfill({ status: response.status(), headers, body: patched });
      });

      await installHistory(page, { bars: buildBars(250) });
      await openHarness(page, "?fit=80");

      const report = await page.evaluate(
        async ({ charts, columns, rows, markets, viewport, frozenNow, intervalMs }) => {
          const [harness, { createHarnessServices }, telemetry] = await Promise.all([
            import("/harness/chart.ts"),
            import("/harness/services.ts"),
            import("/src/core/performanceTelemetry.ts"),
          ]);

          const prevTelemetryEnabled = telemetry.isPerformanceTelemetryEnabled();
          telemetry.configurePerformanceTelemetry({ enabled: true });

          const cellWidth = Math.floor(viewport.width / columns);
          const cellHeight = Math.floor(viewport.height / rows);

          type BucketName = "sustained" | "backlog";
          interface RawBucket {
            pipelineFlush: number[];
            flushPerFrameTotalMs: number[];
            frameRender: number[];
            renderPerFrameTotalMs: number[];
            frameWorkMs: number[];
            rafIntervalMs: number[];
            longTasks: number[];
          }
          const newBucket = (): RawBucket => ({
            pipelineFlush: [],
            flushPerFrameTotalMs: [],
            frameRender: [],
            renderPerFrameTotalMs: [],
            frameWorkMs: [],
            rafIntervalMs: [],
            longTasks: [],
          });
          const buckets: Record<BucketName, RawBucket> = {
            sustained: newBucket(),
            backlog: newBucket(),
          };

          let activePhase: BucketName | null = null;
          let frameTurnStartMs = 0;
          let frameFlushMs = 0;
          let frameFlushCount = 0;
          let frameRenderMs = 0;
          let frameRenderCount = 0;
          let endOfTurnScheduled = false;

          const mc = new MessageChannel();
          mc.port1.onmessage = () => {
            endOfTurnScheduled = false;
            const now = performance.now();
            if (activePhase !== null && frameTurnStartMs > 0) {
              const bucket = buckets[activePhase];
              bucket.frameWorkMs.push(Math.max(0, now - frameTurnStartMs));
              if (frameFlushCount > 0) bucket.flushPerFrameTotalMs.push(frameFlushMs);
              if (frameRenderCount > 0) bucket.renderPerFrameTotalMs.push(frameRenderMs);
            }
            frameTurnStartMs = 0;
            frameFlushMs = 0;
            frameFlushCount = 0;
            frameRenderMs = 0;
            frameRenderCount = 0;
          };

          const origRaf = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = ((callback: FrameRequestCallback): number =>
            origRaf((ts: number) => {
              if (frameTurnStartMs === 0) frameTurnStartMs = performance.now();
              if (!endOfTurnScheduled) {
                endOfTurnScheduled = true;
                mc.port2.postMessage(undefined);
              }
              callback(ts);
            })) as typeof window.requestAnimationFrame;

          (globalThis as any).__multiChartPerfRecord = (name: string, durationMs: number) => {
            if (activePhase === null || !Number.isFinite(durationMs) || durationMs < 0) return;
            const bucket = buckets[activePhase];
            if (name === "pipeline.flush") {
              bucket.pipelineFlush.push(durationMs);
              frameFlushMs += durationMs;
              frameFlushCount += 1;
            } else if (name === "chart.frame.render.ms") {
              bucket.frameRender.push(durationMs);
              frameRenderMs += durationMs;
              frameRenderCount += 1;
            }
          };

          let observer: PerformanceObserver | null = null;
          try {
            observer = new PerformanceObserver((list) => {
              if (activePhase === null) return;
              for (const entry of list.getEntries()) {
                buckets[activePhase].longTasks.push(entry.duration);
              }
            });
            observer.observe({ type: "longtask", buffered: false });
          } catch {
            observer = null;
          }

          let samplingRaf = true;
          let lastRafTimestamp: number | null = null;
          const rafSampler = (ts: number) => {
            if (!samplingRaf) return;
            if (activePhase !== null && lastRafTimestamp !== null) {
              buckets[activePhase].rafIntervalMs.push(Math.max(0, ts - lastRafTimestamp));
            }
            lastRafTimestamp = ts;
            window.requestAnimationFrame(rafSampler);
          };
          window.requestAnimationFrame(rafSampler);

          const roots: HTMLDivElement[] = [];
          const handles: Array<{ dispose(): void }> = [];
          const panelIds: string[] = [];
          const panelServices: ReturnType<typeof createHarnessServices>[] = [];
          const panelMarkets: string[] = [];

          const nextFrames = async (count = 2) => {
            for (let f = 0; f < count; f++) {
              await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            }
          };

          try {
            for (let i = 0; i < charts; i++) {
              const market = markets[i];
              const panelId = `flush-panel-${charts}-${i}`;
              const root = document.createElement("div");
              root.dataset.flushPanel = String(i);
              root.style.cssText = `position:fixed;left:${(i % columns) * cellWidth}px;top:${Math.floor(i / columns) * cellHeight}px;width:${cellWidth}px;height:${cellHeight}px;`;
              document.body.appendChild(root);
              roots.push(root);

              const services = createHarnessServices({ priceStep: 10, priceStepResolved: true });
              const initialState: ChartPanelState = {
                type: "chart",
                market,
                timeframe: "15m",
                scaleMode: "linear",
                chartType: "footprint",
                candles: true,
              };
              const handle = harness.mountChart(
                root,
                initialState,
                services,
                panelId,
                harness.createChartSurfaceModel(),
              );
              handles.push(handle);
              panelIds.push(panelId);
              panelServices.push(services);
              panelMarkets.push(market);
            }

            // Wait until every mounted chart finishes loading the 250-bar fixture.
            const loadDeadline = performance.now() + 30_000;
            while (performance.now() < loadDeadline) {
              const ready = panelIds.every((id) => {
                const rt = harness.getChartRuntime(id);
                return rt && rt.pipeline.series.length >= 250;
              });
              if (ready) break;
              await new Promise((r) => setTimeout(r, 25));
            }
            for (const id of panelIds) {
              const rt = harness.getChartRuntime(id);
              if (!rt || rt.pipeline.series.length < 250) {
                throw new Error(`Chart ${id} did not finish loading 250 bars`);
              }
            }
            await nextFrames(6);

            const sumVolumes = () =>
              panelIds.reduce((sum, id) => {
                const bars = harness.getChartRuntime(id)!.pipeline.series.listReadonly();
                let panelSum = 0;
                for (let i = 0; i < bars.length; i++) panelSum += bars[i].volume;
                return sum + panelSum;
              }, 0);

            const initialVolumeTotal = sumVolumes();
            const startSnap = telemetry.snapshotPerformanceTelemetry();
            const flushedBefore = startSnap.counters["pipeline.flush.trades"] ?? 0;
            const overflowBefore = startSnap.counters["pipeline.flush.overflow"] ?? 0;
            const overflowDroppedBefore = startSnap.counters["pipeline.flush.overflow_dropped"] ?? 0;

            const panelSeqs = new Array<number>(charts).fill(0);
            let totalTradesSent = 0;

            const emitTradesToPanel = (panelIdx: number, count: number) => {
              const market = panelMarkets[panelIdx];
              const svc = panelServices[panelIdx];
              let seq = panelSeqs[panelIdx];
              for (let k = 0; k < count; k++) {
                // Keep all live burst trades strictly inside the active last 15m bar (< 900s).
                const time = frozenNow + 100 + seq;
                svc.pushTrade(market, {
                  id: `burst-${charts}-${panelIdx}-${seq}`,
                  time,
                  price: 60000 + (seq % 12) * 10,
                  qty: 1,
                  isBuy: (seq & 1) === 0,
                  liquidation: false,
                  market,
                  source: "live",
                  receivedAt: time + 1,
                });
                seq += 1;
              }
              panelSeqs[panelIdx] = seq;
              totalTradesSent += count;
            };

            const waitForTradesFlushed = async (targetDelta: number) => {
              const deadline = performance.now() + 30_000;
              while (performance.now() < deadline) {
                const flushed = (telemetry.snapshotPerformanceTelemetry().counters["pipeline.flush.trades"] ?? 0) - flushedBefore;
                if (flushed >= targetDelta) break;
                await nextFrames(1);
              }
              await nextFrames(4);
            };

            // Regime A: sustained high-frequency burst (~1,250 trades/s/panel across 120 ticks).
            activePhase = "sustained";
            lastRafTimestamp = null;
            const SUSTAINED_TICKS = 120;
            const TRADES_PER_TICK_PER_PANEL = 20;
            for (let tick = 0; tick < SUSTAINED_TICKS; tick++) {
              for (let p = 0; p < charts; p++) {
                emitTradesToPanel(p, TRADES_PER_TICK_PER_PANEL);
              }
              await new Promise((r) => setTimeout(r, 16));
            }
            await waitForTradesFlushed(totalTradesSent);

            // Regime B: queued saturation waves (1,000 pending trades/panel queued simultaneously before rAF).
            activePhase = "backlog";
            lastRafTimestamp = null;
            const BACKLOG_WAVES = 10;
            const TRADES_PER_WAVE_PER_PANEL = 1_000;
            for (let wave = 0; wave < BACKLOG_WAVES; wave++) {
              await nextFrames(2);
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              for (let p = 0; p < charts; p++) {
                emitTradesToPanel(p, TRADES_PER_WAVE_PER_PANEL);
              }
              await waitForTradesFlushed(totalTradesSent);
            }

            activePhase = null;
            const endSnap = telemetry.snapshotPerformanceTelemetry();
            const tradesFlushed = (endSnap.counters["pipeline.flush.trades"] ?? 0) - flushedBefore;
            const overflowCount = (endSnap.counters["pipeline.flush.overflow"] ?? 0) - overflowBefore;
            const overflowDroppedCount = (endSnap.counters["pipeline.flush.overflow_dropped"] ?? 0) - overflowDroppedBefore;
            const finalVolumeTotal = sumVolumes();

            const summarize = (values: readonly number[]): QuantileSummary => {
              const valid = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
              const n = valid.length;
              if (n === 0) {
                return {
                  count: 0, totalMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0,
                  gt4MsCount: 0, gt4MsPct: 0, gt16_6MsCount: 0, gt16_6MsPct: 0,
                  gt20MsCount: 0, gt20MsPct: 0, gt33_3MsPct: 0,
                };
              }
              const r3 = (x: number) => Math.round(x * 1_000) / 1_000;
              const at = (q: number) => valid[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
              const totalMs = valid.reduce((a, b) => a + b, 0);
              const gt4MsCount = valid.filter((v) => v > 4).length;
              const gt16_6MsCount = valid.filter((v) => v > 16.6).length;
              const gt20MsCount = valid.filter((v) => v > 20).length;
              const gt33_3MsCount = valid.filter((v) => v > 33.3).length;
              return {
                count: n,
                totalMs: r3(totalMs),
                avgMs: r3(totalMs / n),
                p50Ms: r3(at(0.5)),
                p95Ms: r3(at(0.95)),
                p99Ms: r3(at(0.99)),
                maxMs: r3(valid[n - 1]),
                gt4MsCount,
                gt4MsPct: r3((gt4MsCount * 100) / n),
                gt16_6MsCount,
                gt16_6MsPct: r3((gt16_6MsCount * 100) / n),
                gt20MsCount,
                gt20MsPct: r3((gt20MsCount * 100) / n),
                gt33_3MsPct: r3((gt33_3MsCount * 100) / n),
              };
            };

            const buildPhaseReport = (raw: RawBucket): PhaseReport => ({
              pipelineFlush: summarize(raw.pipelineFlush),
              flushPerFrameTotalMs: summarize(raw.flushPerFrameTotalMs),
              frameRender: summarize(raw.frameRender),
              renderPerFrameTotalMs: summarize(raw.renderPerFrameTotalMs),
              frameWorkMs: summarize(raw.frameWorkMs),
              rafIntervalMs: summarize(raw.rafIntervalMs),
              longTasksCount: raw.longTasks.length,
              maxLongTaskMs: raw.longTasks.length ? Math.round(Math.max(...raw.longTasks) * 1_000) / 1_000 : 0,
            });

            const combinedBucket: RawBucket = {
              pipelineFlush: [...buckets.sustained.pipelineFlush, ...buckets.backlog.pipelineFlush],
              flushPerFrameTotalMs: [...buckets.sustained.flushPerFrameTotalMs, ...buckets.backlog.flushPerFrameTotalMs],
              frameRender: [...buckets.sustained.frameRender, ...buckets.backlog.frameRender],
              renderPerFrameTotalMs: [...buckets.sustained.renderPerFrameTotalMs, ...buckets.backlog.renderPerFrameTotalMs],
              frameWorkMs: [...buckets.sustained.frameWorkMs, ...buckets.backlog.frameWorkMs],
              rafIntervalMs: [...buckets.sustained.rafIntervalMs, ...buckets.backlog.rafIntervalMs],
              longTasks: [...buckets.sustained.longTasks, ...buckets.backlog.longTasks],
            };

            const result: ChartCountReport = {
              charts,
              grid: `${columns}x${rows}`,
              viewportPerChart: `${cellWidth}x${cellHeight}`,
              tradesSentTotal: totalTradesSent,
              tradesFlushed,
              overflowCount,
              overflowDroppedCount,
              volumeDeltaExact: Math.abs((finalVolumeTotal - initialVolumeTotal) - totalTradesSent) < 1e-6,
              sustained: buildPhaseReport(buckets.sustained),
              backlog: buildPhaseReport(buckets.backlog),
              combined: buildPhaseReport(combinedBucket),
            };
            (window as any).__chartPerf = result;
            return result;
          } finally {
            activePhase = null;
            samplingRaf = false;
            delete (globalThis as any).__multiChartPerfRecord;
            window.requestAnimationFrame = origRaf;
            observer?.disconnect();
            mc.port1.close();
            mc.port2.close();
            for (const h of handles) h.dispose();
            for (const r of roots) r.remove();
            telemetry.configurePerformanceTelemetry({ enabled: prevTelemetryEnabled });
          }
        },
        {
          charts: scenario.charts,
          columns: scenario.columns,
          rows: scenario.rows,
          markets: [...FOOTPRINT_MARKETS],
          viewport: VIEWPORT,
          frozenNow: FROZEN_NOW,
          intervalMs: INTERVAL_MS,
        },
      );

      allReports.push(report);
      console.log(`MULTI_CHART_FLUSH_CENSUS_${report.charts}`, JSON.stringify(report));
      await testInfo.attach(`multi-chart-flush-census-${report.charts}.json`, {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });

      expect(report.overflowDroppedCount).toBe(0);
      expect(report.tradesFlushed).toBeGreaterThanOrEqual(report.tradesSentTotal);
      expect(report.volumeDeltaExact).toBe(true);
      expect(report.sustained.pipelineFlush.count).toBeGreaterThan(0);
      expect(report.backlog.pipelineFlush.count).toBeGreaterThan(0);
      expect(report.combined.frameWorkMs.count).toBeGreaterThan(0);
    });
  }
});
