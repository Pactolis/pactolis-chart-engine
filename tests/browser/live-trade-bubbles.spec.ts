import { expect, test } from "@playwright/test";
import { buildBars, installHistory, openHarness } from "./support/history.js";

test("Live Trade Bubbles renders in light & dark themes and stays within frame budget at 50 events/s pan/zoom", async ({ page }) => {
  await openHarness(page);

  const report = await page.evaluate(async () => {
    const [
      { FootprintSeries },
      { liveTradeBubblesIndicatorDefinition, pushLiveTradeEvents, clearLiveTradeEvents },
      { configureIndicatorDataSource },
      { configureChartLocale },
      { View },
    ] = await Promise.all([
      import("/src/core/model/footprint.ts"),
      import("/src/features/indicators/builtins/liveTradeBubbles.ts"),
      import("/src/features/indicators/indicatorDataSource.ts"),
      import("/src/core/chartLocale.ts"),
      import("/src/core/engine/view.ts"),
    ]);

    configureChartLocale({
      locale: () => "en-US",
      timeZone: () => "UTC",
      translate: (key) => key,
      onLocaleChange: () => () => {},
    });

    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      fetchOptionsGexSurface: async () => { throw new Error("unused"); },
      subscribeLiveTradeEvents: () => () => {},
    });

    clearLiveTradeEvents();
    const MIN = 60_000;
    const baseTime = Date.UTC(2026, 0, 15, 12, 0, 0);
    const bars = Array.from({ length: 40 }, (_, i) => ({
      startTime: baseTime + i * MIN,
      open: 60_000 + i * 10,
      high: 60_300 + i * 10,
      low: 59_700 + i * 10,
      close: 60_100 + i * 10,
      volume: 100,
      delta: 12,
      count: 25,
      cells: new Map(),
      hasRef: true,
    }));

    const series = new FootprintSeries({ intervalMs: MIN, priceStep: 10 });
    series.loadBars(bars);

    pushLiveTradeEvents("BTCUSDT", [
      { id: "b1", kind: "trade", time: baseTime + 10 * MIN + 15_000, price: 60_150, qty: 4, notionalUsd: 240_000, side: "buy", venue: "binance" },
      { id: "s1", kind: "trade", time: baseTime + 15 * MIN + 30_000, price: 60_050, qty: 6, notionalUsd: 360_000, side: "sell", venue: "bybit" },
      { id: "l1", kind: "liquidation", time: baseTime + 20 * MIN + 40_000, price: 60_220, qty: 10, notionalUsd: 602_200, side: "long", venue: "binance", sampled: true },
      { id: "l2", kind: "liquidation", time: baseTime + 25 * MIN + 20_000, price: 59_950, qty: 8, notionalUsd: 479_600, side: "short", venue: "okx" },
    ]);

    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 400;
    const ctx2d = canvas.getContext("2d")!;
    const view = new View();
    view.area = { left: 0, top: 0, width: 800, height: 400 };
    view.setVisibleIndexRange(0, bars.length);
    view.fitPriceRange(59_500, 60_700, 0.1);

    const settings = liveTradeBubblesIndicatorDefinition.defaultSettings();
    const makeCtx = (crosshair?: { x: number; y: number; visible: boolean }) => ({
      ctx: ctx2d,
      view,
      series,
      rect: { top: 0, height: 400 },
      range: [0, bars.length] as [number, number],
      instance: { id: "browser-bubbles", type: "live-trade-bubbles", title: "Live Trade Bubbles", visible: true, paneId: "main", order: 0, settings },
      settings,
      chart: { market: "BTCUSDT", timeframe: "1m", intervalMs: MIN },
      crosshair,
      requestRefresh() {},
    });

    const renderWithTheme = (bg: string) => {
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.fillStyle = bg;
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      const before = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data.slice();
      const ctx = makeCtx({ x: view.xOfIndex(20 + 40_000 / MIN), y: view.yOfPrice(60_220), visible: true });
      const prepared = liveTradeBubblesIndicatorDefinition.prepareData!(ctx as never);
      liveTradeBubblesIndicatorDefinition.drawPriceOverlay!(ctx as never, prepared);
      const after = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
      let changedPixels = 0;
      for (let i = 0; i < after.length; i += 4) {
        if (after[i] !== before[i] || after[i + 1] !== before[i + 1] || after[i + 2] !== before[i + 2]) {
          changedPixels++;
        }
      }
      return changedPixels;
    };

    const darkChanged = renderWithTheme("#0d0f14");
    const lightChanged = renderWithTheme("#f8fafc");

    // 50 events/s burst + pan/zoom frame budget check across 30 frames.
    const frameTimesMs: number[] = [];
    for (let f = 0; f < 30; f++) {
      const burst = Array.from({ length: 5 }, (_, k) => ({
        id: `burst-${f}-${k}`,
        kind: (k % 3 === 0 ? "liquidation" : "trade") as "trade" | "liquidation",
        time: baseTime + ((f + k) % 38) * MIN + k * 10_000,
        price: 59_800 + ((f * 37 + k * 53) % 600),
        qty: 2,
        notionalUsd: 120_000 + k * 25_000,
        side: (k % 2 === 0 ? "buy" : "sell") as "buy" | "sell",
        venue: "binance",
      }));
      pushLiveTradeEvents("BTCUSDT", burst);
      view.panX(f % 2 === 0 ? 4 : -4);
      view.zoomX(f % 2 === 0 ? 1.02 : 0.98, 400);

      const t0 = performance.now();
      const ctx = makeCtx();
      const prepared = liveTradeBubblesIndicatorDefinition.prepareData!(ctx as never);
      liveTradeBubblesIndicatorDefinition.drawPriceOverlay!(ctx as never, prepared);
      frameTimesMs.push(performance.now() - t0);
    }

    const avgFrameMs = frameTimesMs.reduce((a, b) => a + b, 0) / frameTimesMs.length;
    const maxFrameMs = Math.max(...frameTimesMs);
    clearLiveTradeEvents();

    return { darkChanged, lightChanged, avgFrameMs, maxFrameMs };
  });

  expect(report.darkChanged).toBeGreaterThan(200);
  expect(report.lightChanged).toBeGreaterThan(200);
  expect(report.avgFrameMs).toBeLessThan(16);
  expect(report.maxFrameMs).toBeLessThan(32);
});

test("Live Trade Bubbles market switch invokes handleMarketChange once and measures frame duration", async ({ page }) => {
  const bars = buildBars(40);
  await installHistory(page, { bars });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&priceStep=10");
  await expect(page.getByTestId("chart-hook")).toHaveAttribute("data-series-len", String(bars.length));

  const measurement = await page.evaluate(async () => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const runtime = getChartRuntime("harness-chart") as unknown as {
      getState(): { market: string; [key: string]: unknown };
      updateState(next: Record<string, unknown>): void;
      indicatorController: {
        handleMarketChange(market?: string): void;
        manager: { handleMarketChange(market?: string): void };
      };
    } | undefined;
    if (!runtime) throw new Error("harness-chart runtime not found");

    let controllerCalls = 0;
    let managerCalls = 0;
    const origController = runtime.indicatorController.handleMarketChange.bind(runtime.indicatorController);
    const origManager = runtime.indicatorController.manager.handleMarketChange.bind(runtime.indicatorController.manager);

    runtime.indicatorController.handleMarketChange = (market?: string) => {
      controllerCalls++;
      return origController(market);
    };
    runtime.indicatorController.manager.handleMarketChange = (market?: string) => {
      managerCalls++;
      return origManager(market);
    };

    try {
      const prev = runtime.getState();
      const nextMarket = prev.market === "BINANCE_FUTURES:ethusdt" ? "BINANCE_FUTURES:btcusdt" : "BINANCE_FUTURES:ethusdt";
      const t0 = performance.now();
      runtime.updateState({ ...prev, market: nextMarket });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const marketSwitchFrameMs = Number((performance.now() - t0).toFixed(2));
      return {
        fromMarket: prev.market,
        toMarket: nextMarket,
        controllerCalls,
        managerCalls,
        marketSwitchFrameMs,
      };
    } finally {
      runtime.indicatorController.handleMarketChange = origController;
      runtime.indicatorController.manager.handleMarketChange = origManager;
    }
  });

  console.log("LIVE_TRADE_BUBBLES_MARKET_SWITCH", JSON.stringify(measurement));
  expect(measurement.controllerCalls).toBe(1);
  expect(measurement.managerCalls).toBe(1);
  expect(measurement.marketSwitchFrameMs).toBeLessThan(250);
});
