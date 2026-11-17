import { expect, test } from "@playwright/test";
import { installHistory, openHarness, FROZEN_NOW } from "./support/history.js";

test("replay hides future and partially future drawings after panning past the replay tail", async ({ page }) => {
  test.setTimeout(60_000);
  const blockedExternalRequests: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") return route.continue();
    blockedExternalRequests.push(url.href);
    return route.abort("blockedbyclient");
  });
  // Add the specific history route after the catch-all so Playwright gives the fixture priority.
  const { historyRequests } = await installHistory(page);
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
  // Keep the runtime's requested history window aligned with the fixed bars served by this fixture.
  // Date.now is pinned while RAF, performance.now, and browser timers remain real.
  await page.addInitScript((frozenNow: number) => {
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args: unknown[]) { super(...((args.length ? args : [frozenNow]) as [value?: number])); }
      static now() { return frozenNow; }
    }
    (window as unknown as Record<string, unknown>).Date = FrozenDate;
  }, FROZEN_NOW);
  await openHarness(page);

  let evidence: {
    seekTime: number;
    lastTime: number;
    futureEnd: number;
    replayVirtualTime: number | null;
    liveStrokes: string[];
    futureStrokesBeyondLastBar: number;
    replaySeekAndReturnMatches: boolean;
    replayMatchesFullRedraw: boolean;
    liveDrawingPixelCounts: { magenta: number; cyan: number };
    replayDrawingPixelCounts: { magenta: number; cyan: number };
    restoredStrokes: string[];
  };
  try {
    evidence = await page.evaluate(async () => {
    const INTERVAL_MS = 15 * 60_000;
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
      previousWeekStrategyLevels: [],
      mondayRangeLevels: [],
      referenceLevels: [],
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
    const waitFor = async (predicate: () => boolean, description: string) => {
      for (let attempt = 0; attempt < 750; attempt++) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${description}`);
    };
    await waitFor(() => Boolean(getChartRuntime(panelId)), "chart runtime");
    const runtime = getChartRuntime(panelId) as unknown as {
      pipeline: { series: { length: number; at(index: number): { startTime: number }; indexOfTime(time: number): number } };
      view: { scrollToIndex(index: number, rightPadCols?: number): void };
      session: { invalidate(): void };
      startReplay(): void;
      replaySeek(time: number): void;
      exitReplay(): void;
      getReplaySnapshot(): { virtualTime: number } | null;
    };
    const runtimeInternal = runtime as typeof runtime & { pipeline: { series: { length: number; at(index: number): { startTime: number }; indexOfTime(time: number): number } }; view: { scrollToIndex(index: number, rightPadCols?: number): void } };
    await waitFor(() => runtimeInternal.pipeline.series.length > 30, "mock history bars");
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
    const targetPixels = () => {
      const context = annotationCanvas.getContext("2d");
      if (!context) throw new Error("Chart annotation canvas has no 2D context");
      const { data } = context.getImageData(0, 0, annotationCanvas.width, annotationCanvas.height);
      const magenta: number[] = [];
      const cyan: number[] = [];
      for (let offset = 0; offset < data.length; offset += 4) {
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const alpha = data[offset + 3];
        if (alpha === 0) continue;
        const pixel = offset / 4;
        if (red >= 220 && green <= 30 && blue >= 220) magenta.push(pixel);
        if (red <= 30 && green >= 220 && blue >= 220) cyan.push(pixel);
      }
      return { magenta, cyan, width: annotationCanvas.width, height: annotationCanvas.height };
    };
    const sameTargetPixels = (left: ReturnType<typeof targetPixels>, right: ReturnType<typeof targetPixels>) =>
      left.width === right.width
      && left.height === right.height
      && left.magenta.length === right.magenta.length
      && left.magenta.every((pixel, index) => pixel === right.magenta[index])
      && left.cyan.length === right.cyan.length
      && left.cyan.every((pixel, index) => pixel === right.cyan[index]);
    const targetPixelCounts = (pixels: ReturnType<typeof targetPixels>) => ({
      magenta: pixels.magenta.length,
      cyan: pixels.cyan.length,
    });
    const settleRender = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    };
    const panToFutureEnd = () => {
      runtimeInternal.view.scrollToIndex(series.indexOfTime(futureEnd), 2);
      runtime.session.invalidate();
    };
    try {
      panToFutureEnd();
      await settleRender();
      const liveStrokes = [...probe.__futureDrawingStrokes];
      const liveDrawingPixels = targetPixels();

      probe.__futureDrawingStrokes = [];
      runtime.startReplay();
      runtime.replaySeek(seekTime);
      panToFutureEnd();
      await settleRender();
      const initialReplayPixels = targetPixels();
      runtime.replaySeek(seekTime + 3 * INTERVAL_MS);
      runtime.view.scrollToIndex(series.indexOfTime(futureEnd), 2);
      runtime.session.invalidate();
      await settleRender();
      runtime.replaySeek(seekTime);
      panToFutureEnd();
      await settleRender();
      const returnedReplayPixels = targetPixels();
      runtime.session.invalidate();
      await settleRender();
      const fullRedrawPixels = targetPixels();
      const replayVirtualTime = runtime.getReplaySnapshot()?.virtualTime ?? null;
      const futureStrokesBeyondLastBar = probe.__futureDrawingStrokes.length;

      probe.__futureDrawingStrokes = [];
      runtime.exitReplay();
      runtimeInternal.view.scrollToIndex(series.indexOfTime(futureEnd), 2);
      await settleRender();
      const restoredStrokes = [...probe.__futureDrawingStrokes];
      return {
        seekTime,
        lastTime,
        futureEnd,
        replayVirtualTime,
        liveStrokes,
        futureStrokesBeyondLastBar,
        liveDrawingPixelCounts: targetPixelCounts(liveDrawingPixels),
        replayDrawingPixelCounts: targetPixelCounts(returnedReplayPixels),
        replaySeekAndReturnMatches: sameTargetPixels(returnedReplayPixels, initialReplayPixels),
        replayMatchesFullRedraw: sameTargetPixels(returnedReplayPixels, fullRedrawPixels),
        restoredStrokes,
      };
    } finally {
      handle.dispose();
      root.remove();
    }
    }) as typeof evidence;
  } catch (error) {
    const servedHistory = historyRequests.map((url) => url.href);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; locally served history requests: ${JSON.stringify(servedHistory)}; blocked external requests: ${JSON.stringify(blockedExternalRequests)}`);
  }

  test.info().attach("replay-drawing-anchors.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  expect(evidence.replayVirtualTime).toBe(evidence.seekTime);
  expect(evidence.futureEnd).toBeGreaterThan(evidence.lastTime);
  expect(evidence.liveStrokes).toEqual(expect.arrayContaining(["#f000ff", "#00f0ff"]));
  expect(evidence.liveDrawingPixelCounts.magenta).toBeGreaterThan(0);
  expect(evidence.liveDrawingPixelCounts.cyan).toBeGreaterThan(0);
  expect(evidence.replayDrawingPixelCounts).toEqual({ magenta: 0, cyan: 0 });
  expect(evidence.futureStrokesBeyondLastBar).toBe(0);
  expect(evidence.replaySeekAndReturnMatches).toBe(true);
  expect(evidence.replayMatchesFullRedraw).toBe(true);
  expect(evidence.restoredStrokes).toEqual(expect.arrayContaining(["#f000ff", "#00f0ff"]));
  expect(historyRequests.length, "the browser fixture must answer history locally").toBeGreaterThan(0);
  expect(blockedExternalRequests, "no external host was requested by this browser fixture").toEqual([]);
});
