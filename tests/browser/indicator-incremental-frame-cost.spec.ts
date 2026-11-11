import { test, expect } from '@playwright/test';
import { openHarness } from './support/history.js';

// #128 verification in a real browser. Given 10k bars and the indicators converted to the
// incremental/cached path, when live trades hit the tail and the view pans one bar per frame,
// then (blocking) no tail tick or pan frame takes the full-recompute path, as counted by the
// performance telemetry, and (blocking, relative) a tail tick is cheaper than a full
// recompute of the same indicator measured in the same page moments apart (>= 2x; the
// real gap is 10-1000x). Absolute frame times are recorded as test annotations only: they
// depend on the runner and must not gate CI.
const KINDS = [
  { file: 'volume', kind: 'volume', overrides: { showMa: true, maPeriod: 20 } },
  { file: 'volumeProfile', kind: 'volumeProfile', overrides: { mode: 'lookback', lookbackBars: 300 }, noPan: true, noRatio: true },
  { file: 'bollinger', kind: 'bollinger' },
  { file: 'cci', kind: 'cci' },
  { file: 'mfi', kind: 'mfi' },
  { file: 'kdj', kind: 'kdj' },
  { file: 'dmi', kind: 'dmi' },
  { file: 'superTrend', kind: 'superTrend' },
  { file: 'stochRsi', kind: 'stochRsi' },
  { file: 'ichimoku', kind: 'ichimoku' },
];

test('converted indicators stay on the incremental path in the browser (counter based, relative cost)', async ({ page }, testInfo) => {
  await openHarness(page);
  const report = await page.evaluate(async (kinds) => {
    const { FootprintSeries } = await import('/src/core/model/footprint.ts');
    const telemetry = await import('/src/core/performanceTelemetry.ts');
    telemetry.configurePerformanceTelemetry({ enabled: true });
    const counters = () => telemetry.snapshotPerformanceTelemetry().counters;
    const N = 10_000;
    const MIN = 60_000;
    const T0 = Date.UTC(2026, 0, 1);
    const mkBar = (i: number) => {
      const close = 10_000 + Math.round(Math.sin(i / 9) * 30 + (i % 7));
      const cells = new Map<number, any>();
      for (let c = 0; c < 5; c++) { const b = close - 2 + c; cells.set(b, { priceBin: b, buyVol: 1 + (c % 3), sellVol: 1 + (c % 2), count: 2, buyCount: 1, sellCount: 1 }); }
      return { startTime: T0 + i * MIN, open: close - 1, high: close + 3, low: close - 3, close, volume: 10 + (i % 5), delta: (i % 3) - 1, count: 5, cells, hasRef: true, cellRevision: 1, completeness: 'complete', sources: ['history'] };
    };
    const p50 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const out: any[] = [];
    for (const spec of kinds as any[]) {
      const mod = await import(/* @vite-ignore */ `/src/features/indicators/builtins/${spec.file}.ts`);
      const def: any = Object.values(mod).find((v: any) => v && typeof v.prepareData === 'function');
      const series = new FootprintSeries({ intervalMs: MIN, priceStep: 1 });
      series.loadBars(Array.from({ length: N }, (_, i) => mkBar(i)));
      const settings = { ...def.defaultSettings(), ...(spec.overrides ?? {}) };
      const make = (id: string, range: [number, number]) => ({
        ctx: {}, view: { colWidth: 6, xOfIndex: (i: number) => i * 6, indexOfX: (x: number) => x / 6 }, series, rect: { top: 0, height: 100 }, range,
        instance: { id, type: def.type, title: def.type, visible: true, paneId: 'p', order: 0, settings, seq: 1 }, settings, requestRefresh() {},
      });
      const live = make(`live-${spec.kind}`, [N - 200, N]);
      def.prepareData(live);
      const tail = () => series.listReadonly().at(-1)!;
      const hit = () => counters()[`indicator.incremental.hit.${spec.kind}`] ?? 0;
      const full = () => counters()[`indicator.incremental.full.${spec.kind}`] ?? 0;
      let h0 = hit(); let f0 = full();
      const tailMs: number[] = [];
      for (let k = 0; k < 30; k++) {
        series.addTrades([{ time: tail().startTime + 1000 + k, price: tail().close, qty: 0.1, isBuy: k % 2 === 0, id: `b${spec.kind}${k}` }]);
        const t = performance.now(); def.prepareData(live); tailMs.push(performance.now() - t);
      }
      const tailFull = full() - f0; const tailHits = hit() - h0;
      let panFull = 0; const panMs: number[] = [];
      if (!spec.noPan) {
        f0 = full();
        for (let k = 1; k <= 30; k++) { live.range = [N - 200 - k, N - k]; const t = performance.now(); def.prepareData(live); panMs.push(performance.now() - t); }
        panFull = full() - f0;
      }
      // Cost of the full recompute for the same indicator, measured with fresh (uncached) instances.
      const fullMs: number[] = [];
      for (let k = 0; k < 8; k++) { const t = performance.now(); def.prepareData(make(`ref-${spec.kind}-${k}`, [N - 200, N])); fullMs.push(performance.now() - t); }
      out.push({ kind: spec.kind, tailFull, tailHits, panFull, noRatio: !!spec.noRatio, tailP50: p50(tailMs), panP50: panMs.length ? p50(panMs) : null, fullP50: p50(fullMs) });
    }
    return out;
  }, KINDS);

  for (const r of report) {
    testInfo.annotations.push({ type: `frame-cost ${r.kind}`, description: `tail p50 ${r.tailP50.toFixed(3)} ms, pan p50 ${r.panP50 === null ? 'n/a' : r.panP50.toFixed(3) + ' ms'}, full p50 ${r.fullP50.toFixed(3)} ms` });
    expect(r.tailFull, `${r.kind}: tail ticks must not run the full path`).toBe(0);
    expect(r.tailHits, `${r.kind}: every tail tick must hit the incremental path`).toBe(30);
    expect(r.panFull, `${r.kind}: pan frames must not run the full path`).toBe(0);
    // Volume Profile's full path is only ~0.5 ms at this window, too close to timer noise for a ratio.
    if (!r.noRatio) expect(r.tailP50 * 2, `${r.kind}: tail tick (${r.tailP50.toFixed(3)} ms) must be at least 2x cheaper than a full recompute (${r.fullP50.toFixed(3)} ms)`).toBeLessThan(r.fullP50);
  }
});
