import { expect, test } from "@playwright/test";
import { installHistory, openHarness, INTERVAL_MS } from "./support/history.js";

test("replay hides future and partially future drawings after panning past the replay tail", async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") return route.continue();
    return route.abort("blockedbyclient");
  });
  await installHistory(page);
  await page.addInitScript(() => {
    const colors = new Set(["#f000ff", "#00f0ff"]);
    const probe = window as typeof window & { __futureDrawingStrokes: string[] };
    probe.__futureDrawingStrokes = [];
    const original = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args: Parameters<typeof original>) {
      if (colors.has(String(this.strokeStyle))) probe.__futureDrawingStrokes.push(String(this.strokeStyle));
      return original.apply(this, args);
    };
  });
  await openHarness(page);

  const evidence = await page.evaluate(async () => {
    const [{ mountChart }, { createChartSurfaceModel }, { getChartRuntime }, { DrawingManager }, { DEFAULT_VOLUME_PROFILE_SETTINGS }, { normalizePreviousWeekStrategySettings }, { normalizeMondayRangeSettings }] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/harness/chart.ts"),
      import("/src/features/drawings/drawingManager.ts"),
      import("/src/core/analysis/volumeProfile.ts"),
      import("/src/core/analysis/previousWeekStrategy.ts"),
      import("/src/core/analysis/mondayRange.ts"),
    ]);
    const market = "BINANCE_FUTURES:btcusdt";
    const drawings = new DrawingManager(() => {});
    drawings.setMarket(market);
    const context = {
      market,
      profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
      previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
      mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
      nakedPocs: [],
      drawings,
    };
    const services = {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 0.1,
      fetchPricePrecision: async () => 1,
      getAnalysisContext: () => context,
      getAnalysisRevisionSnapshot: () => ({
        market,
        revision: 1,
        canonical: { status: "complete", market, runKey: "replay-drawing-anchors", generation: 1, revision: 1, failedPeriods: [] },
      }),
      getAutomaticLevelsAsOf: () => null,
      subscribeAnalysis: () => () => {},
      subscribeAnalysisRevision: () => () => {},
      updateAnalysisFromSeries() {},
      fetchNpocSnapshot: () => new Promise(() => {}),
      notifyActiveMarket() {},
      notifyInteractiveCandlesReady() {},
      notifyInteractiveHistorySettled() {},
      triggerAutoSync() {},
      notifyBarClose() {},
      notify() {},
      isFootprintSyncBusy: () => false,
    };
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:8px;top:16px;width:960px;height:560px;overflow:hidden;";
    document.body.appendChild(root);
    const panelId = "replay-drawing-anchors";
    const handle = mountChart(root, {
      type: "chart",
      market,
      timeframe: "15m",
      scaleMode: "linear",
      chartType: "candlestick",
      candles: true,
    } as never, services as never, panelId, createChartSurfaceModel());
    const runtime = await new Promise<{
      pipeline: { series: { length: number; at(index: number): { startTime: number }; indexOfTime(time: number): number } };
      view: { scrollToIndex(index: number, rightPadCols?: number): void };
      session: { invalidate(): void };
      startReplay(): void;
      replaySeek(time: number): void;
      exitReplay(): void;
      getReplaySnapshot(): { virtualTime: number } | null;
    }>((resolve, reject) => {
      let framesRemaining = 900;
      const poll = () => {
        const value = getChartRuntime(panelId) as unknown as ReturnType<typeof getChartRuntime> & {
          pipeline?: { series?: { length?: number } };
        };
        if (value?.pipeline?.series && value.pipeline.series.length > 30) resolve(value as never);
        else if (framesRemaining-- <= 0) reject(new Error("Timed out waiting for chart history"));
        else requestAnimationFrame(poll);
      };
      poll();
    });
    const runtimeInternal = runtime as typeof runtime & { pipeline: { series: { length: number; at(index: number): { startTime: number }; indexOfTime(time: number): number } }; view: { scrollToIndex(index: number, rightPadCols?: number): void } };
    const series = runtimeInternal.pipeline.series;
    const seekTime = series.at(Math.floor(series.length / 2)).startTime;
    const lastTime = series.at(series.length - 1).startTime;
    const futureEnd = lastTime + 20 * INTERVAL_MS;
    const firstColor = "#f000ff";
    const partialColor = "#00f0ff";
    drawings.replace([
      { id: "future-anchor", type: "trend", points: [{ time: lastTime + 10 * INTERVAL_MS, price: 60_100 }, { time: futureEnd, price: 60_300 }], color: firstColor, lineWidth: 2, locked: false, visible: true, market },
      { id: "partial-future-anchor", type: "trend", points: [{ time: seekTime - INTERVAL_MS, price: 60_200 }, { time: futureEnd, price: 60_400 }], color: partialColor, lineWidth: 2, locked: false, visible: true, market },
    ]);

    const probe = window as typeof window & { __futureDrawingStrokes: string[] };
    const annotationCanvas = root.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]');
    if (!annotationCanvas) throw new Error("Chart annotation canvas was not mounted");
    const settleRender = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    };
    const annotationImage = () => annotationCanvas.toDataURL("image/png");
    const panToFutureEnd = () => {
      runtimeInternal.view.scrollToIndex(series.indexOfTime(futureEnd), 2);
      runtime.session.invalidate();
    };
    try {
      panToFutureEnd();
      await settleRender();
      const liveStrokes = [...probe.__futureDrawingStrokes];

      probe.__futureDrawingStrokes = [];
      runtime.startReplay();
      runtime.replaySeek(seekTime);
      panToFutureEnd();
      await settleRender();
      const initialReplayImage = annotationImage();
      runtime.replaySeek(seekTime + 3 * INTERVAL_MS);
      runtime.view.scrollToIndex(series.indexOfTime(futureEnd), 2);
      runtime.session.invalidate();
      await settleRender();
      runtime.replaySeek(seekTime);
      panToFutureEnd();
      await settleRender();
      const returnedReplayImage = annotationImage();
      runtime.session.invalidate();
      await settleRender();
      const fullRedrawImage = annotationImage();
      const replayVirtualTime = runtime.getReplaySnapshot()?.virtualTime ?? null;
      const futureStrokesBeyondLastBar = probe.__futureDrawingStrokes.length;

      probe.__futureDrawingStrokes = [];
      runtime.exitReplay();
      panToFutureEnd();
      await settleRender();
      const restoredStrokes = [...probe.__futureDrawingStrokes];
      return {
        seekTime,
        lastTime,
        futureEnd,
        replayVirtualTime,
        liveStrokes,
        futureStrokesBeyondLastBar,
        replaySeekAndReturnMatches: returnedReplayImage === initialReplayImage,
        replayMatchesFullRedraw: returnedReplayImage === fullRedrawImage,
        restoredStrokes,
      };
    } finally {
      handle.dispose();
      root.remove();
    }
  });

  expect(evidence.replayVirtualTime).toBe(evidence.seekTime);
  expect(evidence.futureEnd).toBeGreaterThan(evidence.lastTime);
  expect(evidence.liveStrokes).toEqual(expect.arrayContaining(["#f000ff", "#00f0ff"]));
  expect(evidence.futureStrokesBeyondLastBar).toBe(0);
  expect(evidence.replaySeekAndReturnMatches).toBe(true);
  expect(evidence.replayMatchesFullRedraw).toBe(true);
  expect(evidence.restoredStrokes).toEqual(expect.arrayContaining(["#f000ff", "#00f0ff"]));
  test.info().attach("replay-drawing-anchors.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});
