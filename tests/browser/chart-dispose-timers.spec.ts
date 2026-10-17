import { expect, test } from "@playwright/test";
import { openHarness } from "./support/history.js";

// #325 timer teardown: when the mount falls back to a default price step, the chart retries
// the real step in the background after 5 s, 15 s and 30 s. Disposing the chart must clear
// the pending retry timer instead of leaving it (and the runtime it holds) alive for up to
// 50 s after the panel is gone.
test("disposing a chart clears its pending price-step retry timer", async ({ page }) => {
  test.setTimeout(60_000);
  await openHarness(page);

  const evidence = await page.evaluate(async () => {
    const [
      { mountChart, createChartSurfaceModel, getChartRuntime },
      { DrawingManager },
      { DEFAULT_VOLUME_PROFILE_SETTINGS },
      { normalizePreviousWeekStrategySettings },
      { normalizeMondayRangeSettings },
    ] = await Promise.all([
      import("/harness/chart.ts"),
      import("/src/features/drawings/drawingManager.ts"),
      import("/src/core/analysis/volumeProfile.ts"),
      import("/src/core/analysis/previousWeekStrategy.ts"),
      import("/src/core/analysis/mondayRange.ts"),
    ]);

    // Track only timers the chart runtime schedules with the first retry delay; the rest of
    // the page's timers pass through untouched.
    const RETRY_DELAY_MS = 5_000;
    const fromChartRuntime = () => /\/(?:ChartRuntime|abortableDelay)\.(?:ts|js)\b/.test(new Error().stack ?? "");
    const realSetTimeout = window.setTimeout;
    const realClearTimeout = window.clearTimeout;
    const pendingRetryTimers = new Set<number>();
    let retryTimersScheduled = 0;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout !== RETRY_DELAY_MS || typeof handler !== "function" || !fromChartRuntime()) return realSetTimeout(handler, timeout, ...args);
      retryTimersScheduled++;
      const id = realSetTimeout(() => {
        pendingRetryTimers.delete(id);
        (handler as (...rest: unknown[]) => void)(...args);
      }, timeout);
      pendingRetryTimers.add(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) pendingRetryTimers.delete(id);
      realClearTimeout(id);
    }) as typeof window.clearTimeout;

    const market = "BINANCE_FUTURES:btcusdt";
    const context = {
      market,
      profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
      previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
      mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
      nakedPocs: [],
      drawings: new DrawingManager(() => {}),
      previousWeekStrategyLevels: [],
      mondayRangeLevels: [],
      referenceLevels: [],
    };
    let stepRequests = 0;
    const services = {
      subscribeToTrades: () => () => {},
      fetchPriceStep: async () => 0.1,
      // The step stays unresolved, so the mount uses its fallback and schedules retries.
      fetchPriceStepResult: async () => { stepRequests++; return { step: 0.1, resolved: false }; },
      fetchPricePrecision: async () => 1,
      getAnalysisContext: () => context,
      getAnalysisRevisionSnapshot: () => ({
        market,
        revision: 1,
        canonical: { status: "complete", market, runKey: "dispose-timers", generation: 1, revision: 1, failedPeriods: [] },
      }),
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
    root.style.cssText = "position:fixed;left:8px;top:16px;width:640px;height:360px;overflow:hidden;";
    document.body.appendChild(root);
    const panelId = `dispose-timers-${Date.now()}`;
    const waitFor = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => realSetTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${description}`);
    };

    try {
      const handle = mountChart(root, {
        type: "chart",
        market,
        timeframe: "1m",
        scaleMode: "linear",
        chartType: "candlestick",
        candles: true,
      } as never, services as never, panelId, createChartSurfaceModel());
      await waitFor(() => Boolean(getChartRuntime(panelId)), "the chart runtime");
      await waitFor(() => pendingRetryTimers.size > 0, "the background price-step retry timer");
      const pendingBeforeDispose = pendingRetryTimers.size;
      handle.dispose();
      await waitFor(() => !getChartRuntime(panelId), "the runtime registry teardown");
      // Let any promise continuation that dispose resumes run before reading the ledger.
      await new Promise((resolve) => realSetTimeout(resolve, 50));
      return {
        stepRequests,
        retryTimersScheduled,
        pendingBeforeDispose,
        pendingAfterDispose: pendingRetryTimers.size,
      };
    } finally {
      window.setTimeout = realSetTimeout;
      window.clearTimeout = realClearTimeout;
      root.remove();
    }
  });

  expect(evidence.stepRequests).toBe(1);
  expect(evidence.retryTimersScheduled).toBe(1);
  expect(evidence.pendingBeforeDispose).toBe(1);
  expect(evidence.pendingAfterDispose).toBe(0);
});
