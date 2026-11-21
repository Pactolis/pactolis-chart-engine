import { expect, test } from "@playwright/test";
import { openHarness } from "./support/history.js";

test("Swing Map structural swings, BOS/CHoCH, protected levels, replay and Canvas2D render in browser", async ({ page }) => {
  await openHarness(page);

  const report = await page.evaluate(async () => {
    const [
      { FootprintSeries },
      { swingMapIndicatorDefinition },
      { View },
      telemetry,
    ] = await Promise.all([
      import("/src/core/model/footprint.ts"),
      import("/src/features/indicators/builtins/swingMap.ts"),
      import("/src/core/engine/view.ts"),
      import("/src/core/performanceTelemetry.ts"),
    ]);

    telemetry.configurePerformanceTelemetry({ enabled: true });
    const counters = () => telemetry.snapshotPerformanceTelemetry().counters;
    const MIN = 60_000;
    const specs: Array<[number, number, number, number]> = [
      [11, 12, 10, 11],
      [15, 20, 14, 19],
      [18, 16, 13, 14],
      [14, 15, 10, 12],
      [12, 18, 12, 17],
      [17, 25, 16, 23],
      [23, 22, 18, 19],
      [19, 20, 15, 18],
      [18, 21, 16, 20],
      [20, 26, 20, 25], // sweep above 25 (close=25)
      [25, 28, 24, 27], // Bullish BOS
      [26, 27, 24, 26],
      [25, 24, 14, 17], // sweep below 15
      [17, 18, 13, 13.5], // Bearish CHoCH -> transition
      [13.5, 14, 11, 11.5],
      [11.5, 12, 9, 10],
      [10, 13, 10, 12],
      [12, 18, 11, 16],
      [16, 16, 13, 14], // Bearish confirmed
      [14, 14, 8, 8.5], // Bearish BOS
      [8.5, 10, 8, 9.5], // open tail bar
    ];

    const bars = specs.map(([open, high, low, close], i) => ({
      startTime: i * MIN,
      open,
      high,
      low,
      close,
      volume: 10,
      delta: close >= open ? 2 : -2,
      count: 4,
      cells: new Map(),
      hasRef: true,
    }));

    const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
    series.loadBars(bars);

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 320;
    const ctx2d = canvas.getContext("2d")!;
    const view = new View();
    view.area = { left: 0, top: 0, width: 640, height: 320 };
    view.setVisibleIndexRange(0, bars.length);
    view.fitPriceRange(5, 30, 0.1);

    const makeCtx = (id: string, overrides: Record<string, unknown> = {}, asOfTime?: number) => {
      const settings = { ...swingMapIndicatorDefinition.defaultSettings(), left: 1, right: 1, ...overrides };
      return {
        ctx: ctx2d,
        view,
        series,
        rect: { top: 0, height: 320 },
        range: [0, bars.length] as [number, number],
        instance: { id, type: "swing-map", title: "Swing Map", visible: true, paneId: "main", order: 0, settings },
        settings,
        chart: asOfTime === undefined ? undefined : { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: MIN, asOfTime },
        requestRefresh() {},
      };
    };

    const mainCtx = makeCtx("browser-main");
    const prepared = swingMapIndicatorDefinition.prepareData!(mainCtx as never) as {
      status: string;
      points: Array<{ index: number; kind: string; label: string }>;
      meta: {
        trend: string;
        evaluatedWindows: number;
        breakEvents: Array<{ kind: string; direction: string; breakIndex: number }>;
        sweepCandidates: Array<{ kind: string; barIndex: number }>;
      };
    };
    swingMapIndicatorDefinition.drawPriceOverlay!(mainCtx as never, prepared as never);
    const pixels = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonZeroAlpha = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 0) nonZeroAlpha++;
    }

    // Both and wick modes also render cleanly.
    const bothCtx = makeCtx("browser-both", { pivotMode: "both", breakConfirmation: "wick" });
    const bothPrepared = swingMapIndicatorDefinition.prepareData!(bothCtx as never);
    swingMapIndicatorDefinition.drawPriceOverlay!(bothCtx as never, bothPrepared);

    // Live open-bar ticks must stay on incremental hit path with 0 extra windows.
    const fullBefore = counters()["indicator.incremental.full.swing-map"] ?? 0;
    const hitBefore = counters()["indicator.incremental.hit.swing-map"] ?? 0;
    const windowsBefore = prepared.meta.evaluatedWindows;
    for (let k = 0; k < 5; k++) {
      series.addTrades([{ time: (bars.length - 1) * MIN + 1000 + k, price: 9 + k * 0.1, qty: 1, isBuy: true, id: `live-${k}` }]);
      const after = swingMapIndicatorDefinition.prepareData!(mainCtx as never) as typeof prepared;
      if (after.meta.evaluatedWindows !== windowsBefore) {
        throw new Error(`Expected unchanged evaluatedWindows (${windowsBefore}), got ${after.meta.evaluatedWindows}`);
      }
    }
    const fullAfter = counters()["indicator.incremental.full.swing-map"] ?? 0;
    const hitAfter = counters()["indicator.incremental.hit.swing-map"] ?? 0;

    // Replay asOf backward and forward seek parity against fresh oracle.
    const replayCut = 14 * MIN;
    const replayCtx = makeCtx("browser-replay", {}, replayCut);
    const replayForward = swingMapIndicatorDefinition.prepareData!(makeCtx("browser-replay", {}, 20 * MIN));
    void replayForward;
    const replayRewound = swingMapIndicatorDefinition.prepareData!(replayCtx);

    const oracleSeries = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
    oracleSeries.loadBars(bars.slice(0, 14));
    const oracleCtx = { ...makeCtx("browser-oracle", {}, replayCut), series: oracleSeries, range: [0, 14] as [number, number] };
    const oracle = swingMapIndicatorDefinition.prepareData!(oracleCtx as never);

    return {
      status: prepared.status,
      trend: prepared.meta.trend,
      breakEvents: prepared.meta.breakEvents.map((e) => [e.kind, e.direction, e.breakIndex]),
      sweepCount: prepared.meta.sweepCandidates.length,
      nonZeroAlpha,
      liveFullDelta: fullAfter - fullBefore,
      liveHitDelta: hitAfter - hitBefore,
      replayPointsEqual: JSON.stringify(replayRewound.points) === JSON.stringify(oracle.points),
    };
  });

  expect(report.status).toBe("ok");
  expect(report.trend).toBe("bearish");
  expect(report.breakEvents).toEqual([
    ["BOS", "bullish", 10],
    ["CHoCH", "bearish", 13],
    ["BOS", "bearish", 19],
  ]);
  expect(report.sweepCount).toBe(2);
  expect(report.nonZeroAlpha).toBeGreaterThan(0);
  expect(report.liveFullDelta).toBe(0);
  expect(report.liveHitDelta).toBe(5);
  expect(report.replayPointsEqual).toBe(true);
});
