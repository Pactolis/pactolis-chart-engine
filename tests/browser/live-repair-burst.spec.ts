import { expect, test } from "@playwright/test";

// Virtual exchange time compresses 90 seconds into 90 browser turns. This is
// pipeline/journal qualification; timings are diagnostics, not a real GPU census.
test("5k trades per second for 90 seconds recover after a delayed snapshot within the journal cap", async ({ page }, testInfo) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { ChartDataPipeline } = await import("/src/features/chart/ChartDataPipeline.ts");
    const { configureChartDataSource } = await import("/src/features/chart/chartDataSource.ts");
    const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("/src/core/performanceTelemetry.ts");
    configureChartDataSource({ isDirectCandleMarket: () => false } as any);
    configurePerformanceTelemetry({ enabled: true });
    const base = Date.UTC(2026, 10, 10);
    let emit!: (trade: any) => void;
    let session!: (value: any) => void;
    const requests: Array<{ query: any; resolve: (bars: any[]) => void }> = [];
    const states: string[] = [];
    let degraded = false;
    const heap = () => (performance as any).memory?.usedJSHeapSize ?? null;
    const heapBefore = heap();
    let peakHeap = heapBefore;
    const frameMs: number[] = [];
    const pipeline = new ChartDataPipeline({ market: "M", intervalMs: 60000, priceStep: 1,
      services: {
        subscribeToTrades: (_market: string, cb: any) => { emit = cb; return () => {}; },
        subscribeToTradeSessions: (cb: any) => { session = cb; return () => {}; },
        fetchHistory: (query: any) => new Promise<any[]>((resolve) => requests.push({ query, resolve })),
        fetchPriceStep: async () => 1, fetchPricePrecision: async () => undefined, triggerAutoSync() {},
        acquirePipelineIntegrityReporter: () => ({ report: (state: string) => states.push(state), dispose() {} }),
      },
      onDataDegraded: (value: boolean) => { degraded = value; },
      scheduler: { request: (cb: () => void) => { cb(); return 0; }, cancel() {} },
    });
    try {
      session({ generation: 1, epoch: 1, session: "burst", boundaryAt: base + 60000 });
      const volumes = new Map<number, number>();
      for (let second = 0; second < 90; second++) {
        const started = performance.now();
        for (let index = 0; index < 5000; index++) {
          const n = second * 5000 + index;
          const time = base + 60001 + Math.floor(n / 5);
          volumes.set(Math.floor(time / 60000) * 60000, (volumes.get(Math.floor(time / 60000) * 60000) ?? 0) + 1);
          emit({ id: String(n + 1), time, price: 100, qty: 1, isBuy: true, liquidation: false, market: "M", source: "live", receivedAt: time + 1 });
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frameMs.push(performance.now() - started);
        const used = heap();
        if (used !== null) peakHeap = Math.max(peakHeap ?? 0, used);
      }
      const active = requests.at(-1)!;
      const q = active.query;
      const common = { authority: "provisional", requestedFrom: q.from, requestedTo: q.to,
        coveredFrom: q.from, coveredThrough: q.to };
      q.onMeta({ schemaVersion: 2, generatedAt: base + 150000,
        repairSnapshot: { schemaVersion: 1, mode: "trade-id-v1", source: "binance-usdm-aggTrade", instrument: "M",
          interval: 60000, priceStep: 1, authorityToken: "fixture", watermark: "450000", ...common,
          bucketFrom: q.from, bucketThrough: Math.floor(q.to / 60000) * 60000,
          coverageProof: { kind: "resolver-contiguous-v1", ...common, complete: true } },
      });
      active.resolve([...volumes].map(([startTime, volume]) => ({ startTime, open: 100, high: 100, low: 100, close: 100,
        volume, delta: volume, count: volume, hasRef: true, completeness: "complete", sources: ["history"],
        cells: new Map([[100, { priceBin: 100, buyVol: volume, sellVol: 0, count: volume, buyCount: volume, sellCount: 0,
          liquidationBuyVol: 0, liquidationSellVol: 0 }]]) })));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      const bars = pipeline.series.listReadonly();
      frameMs.sort((a, b) => a - b);
      return { volume: bars.reduce((n, b) => n + b.volume, 0),
        cellVolume: bars.reduce((n, b) => n + [...b.cells.values()].reduce((n, c) => n + c.buyVol + c.sellVol, 0), 0),
        state: states.at(-1), errors: states.filter((s) => s === "error").length, degraded,
        requests: requests.length, heapBefore, peakHeap, heapAfter: heap(),
        journalHighWater: snapshotPerformanceTelemetry().counters["pipeline.repair.buffer_high_water"],
        browserTurnP95Ms: frameMs[Math.ceil(frameMs.length * 0.95) - 1] };
    } finally { pipeline.dispose(); }
  });
  await testInfo.attach("live-repair-burst-memory-and-turns.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.volume).toBe(450000);
  expect(result.cellVolume).toBe(450000);
  expect(result.state).toBe("healthy");
  expect(result.degraded).toBe(false);
  expect(result.errors).toBe(0);
  expect(result.journalHighWater).toBeLessThanOrEqual(200000);
  expect(result.requests).toBe(3);
});
