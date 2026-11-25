import { test, expect } from "@playwright/test";
import { openHarness } from "./support/history.js";

test("Whale vs Crowd renders BTC 1h with 3 venues in zScore mode and ±2 threshold lines", async ({ page }) => {
  await openHarness(page);

  const evidence = await page.evaluate(async () => {
    const { FootprintSeries } = await import("/src/core/model/footprint.ts");
    const { View } = await import("/src/core/engine/view.ts");
    const { configureIndicatorDataSource } = await import("/src/features/indicators/indicatorDataSource.ts");
    const { preloadIndicatorDefinition } = await import("/src/features/indicators/registry.ts");

    const def = await preloadIndicatorDefinition("whale-vs-crowd");
    if (!def) throw new Error("whale-vs-crowd definition failed to load");

    const DAY_MS = 86_400_000;
    const HOUR_MS = 3_600_000;
    const MIN_MS = 60_000;
    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    const makeNative = (stepMs: number, resolution: string, offset: number) => {
      const count = Math.floor((10 * DAY_MS) / stepMs);
      return Array.from({ length: count }, (_, i) => ({
        t: startMs + (i + 1) * stepMs,
        whaleRatio: 1.35 + offset + 0.25 * Math.sin(i / 8),
        crowdRatio: 0.95 + 0.08 * Math.cos(i / 11),
        resolution,
        source: "backend",
      }));
    };

    const binancePts = makeNative(5 * MIN_MS, "5m", 0.05);
    const okxPts = makeNative(5 * MIN_MS, "5m", 0.15);
    const hlPts = makeNative(15 * MIN_MS, "15m", -0.05);

    configureIndicatorDataSource({
      requestLiquidationSeries: () => ({ status: "idle" }),
      requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
      requestFuturesPositioningSeries: () => ({ status: "idle" }),
      fetchOptionsGexSurface: async () => { throw new Error("unused"); },
      requestWhaleCrowdSeries: () => ({
        status: "ready",
        data: {
          status: "ready",
          source: "backend",
          venues: [
            { venue: "binance", status: "ready", definition: "Top 20% accounts", points: binancePts },
            { venue: "okx", status: "ready", definition: "Elite trader ratio", points: okxPts },
            { venue: "hyperliquid", status: "ready", definition: "Whale >= $100k", thresholdUsd: 100_000, points: hlPts },
          ],
        },
      }),
    });

    const viewStart = startMs + 9 * DAY_MS;
    const series = new FootprintSeries({ intervalMs: HOUR_MS, priceStep: 1 });
    series.loadBars(
      Array.from({ length: 24 }, (_, i) => ({
        startTime: viewStart + i * HOUR_MS,
        open: 90_000,
        high: 90_100,
        low: 89_900,
        close: 90_050,
        volume: 15,
        delta: 0,
        count: 1,
        cells: new Map(),
        hasRef: true,
        cellRevision: 0,
      })),
    );

    const settings = { ...def.defaultSettings(), showAxisTicks: false };
    const view = new View();
    view.area = { left: 0, top: 0, width: 640, height: 132 };
    view.colWidth = 20;
    view.offsetX = 0;

    const dashedLines: Array<{ y: number; dash: number[] }> = [];
    const strokesByColor: Record<string, number> = {};
    let currentDash: number[] = [];
    let currentColor = "";
    let pathOps = 0;
    let lastPathY: number[] = [];

    const canvas = new Proxy(
      {
        set strokeStyle(v: string) { currentColor = String(v); },
        get strokeStyle() { return currentColor; },
        setLineDash(d: number[]) { currentDash = [...d]; },
        beginPath() { pathOps = 0; lastPathY = []; },
        moveTo(_x: number, y: number) { pathOps++; lastPathY.push(y); },
        lineTo(_x: number, y: number) { pathOps++; lastPathY.push(y); },
        stroke() {
          if (currentDash.length === 2 && lastPathY.length === 2 && lastPathY[0] === lastPathY[1]) {
            dashedLines.push({ y: lastPathY[0], dash: [...currentDash] });
          } else if (pathOps > 2) {
            strokesByColor[currentColor] = (strokesByColor[currentColor] ?? 0) + 1;
          }
        },
        measureText: (text: string) => ({ width: String(text).length * 5 }),
      } as any,
      {
        get(target, key) {
          return key in target ? target[key] : () => {};
        },
        set(target, key, value) {
          target[key] = value;
          return true;
        },
      },
    );

    const drawCtx = {
      ctx: canvas,
      view,
      series,
      rect: { top: 0, height: 132 },
      range: [0, 24] as [number, number],
      instance: {
        id: "wc-browser-1",
        type: "whale-vs-crowd",
        title: "Whale vs Crowd",
        visible: true,
        paneId: "pane-wc",
        order: 0,
        settings,
      },
      settings,
      chart: {
        market: "BINANCE_FUTURES:btcusdt",
        timeframe: "1h",
        intervalMs: HOUR_MS,
      },
      requestRefresh() {},
    };

    const prepared = def.prepareData(drawCtx as any);
    def.drawSubPane!(drawCtx as any, prepared);
    const readout = def.getReadout!(drawCtx as any, prepared, null);

    return {
      status: prepared.status,
      mode: prepared.meta.mode,
      zThreshold: prepared.meta.zThreshold,
      dashedCount: dashedLines.length,
      binanceCount: strokesByColor[settings.binanceColor] ?? 0,
      okxCount: strokesByColor[settings.okxColor] ?? 0,
      hlCount: strokesByColor[settings.hyperliquidColor] ?? 0,
      readoutLabels: readout?.items.map((i) => i.label) ?? [],
    };
  });

  expect(evidence.status).toBe("ok");
  expect(evidence.mode).toBe("zScore");
  expect(evidence.zThreshold).toBe(2);
  expect(evidence.dashedCount).toBe(2);
  expect(evidence.binanceCount).toBeGreaterThanOrEqual(1);
  expect(evidence.okxCount).toBeGreaterThanOrEqual(1);
  expect(evidence.hlCount).toBeGreaterThanOrEqual(1);
  expect(evidence.readoutLabels).toEqual(["BN", "OKX", "HL"]);
});
