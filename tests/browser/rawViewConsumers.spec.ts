import { test, expect } from '@playwright/test';
import { installHistory, openHarness } from './support/history.js';

// TEST_ONLY; shared browser contract; NOT_RUN. No engine/native acceptance claim.
// Given literal raw fixtures, exercise actual consumers and module composition separately.
test('raw/view consumers, public header refresh, interaction reuse and recovery', async ({ page }) => {
  test.setTimeout(60_000);
  await installHistory(page);
  await openHarness(page);
  const result = await page.evaluate(async () => {
    const mod = (path: string): Promise<any> => import(path);
    const { IndicatorManager } = await mod('/src/features/indicators/IndicatorManager.ts');
    const { ChartIndicatorController } = await mod('/src/features/chart/ChartIndicatorController.ts');
    const { getIndicatorDefinition, createIndicatorInstanceAsync } = await mod('/src/features/indicators/registry.ts');
    const { mountIndicatorPaneHeaders } = await mod('/harness/indicatorPaneHeaders.ts');
    const { buildIndicatorAnalysisSnapshot } = await mod('/src/features/indicators/analysisSnapshot.ts');
    const { FootprintSeries } = await mod('/src/core/model/footprint.ts');
    const { View } = await mod('/src/core/engine/view.ts');
    const baseTime = 1577836800000, interval = 60000;
    const chart = () => ({ market: 'BINANCE_FUTURES:btcusdt', timeframe: '1m', intervalMs: interval });
    function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
    const equal = (a: unknown, b: unknown, label: string) => check(JSON.stringify(a) === JSON.stringify(b), label);
    function bar(i: number, shift = 0) {
      const close = 12 + 2 * i + shift;
      return { startTime: baseTime + i * interval, open: close - 2, high: close + 2, low: close - 4, close,
        volume: 24, delta: 2, count: 10, liquidationBuyVol: 1, liquidationSellVol: 2,
        cells: new Map([[close, { priceBin: close, buyVol: 13, sellVol: 11, count: 10,
          buyCount: 6, sellCount: 4, liquidationBuyVol: 1, liquidationSellVol: 2 }]]),
        hasRef: true, completeness: 'complete', sources: ['history'], cellRevision: 1,
        updatedAt: baseTime + i * interval, deltaBySize: [3, -1, 0, 0, 0, 0, 0, 0, 0, 0] };
    }
    const fixture = (shift = 0) => [bar(0, shift), bar(1, shift), bar(2, shift)];
    const stamp = (s: any) => [s.resetEpoch, s.revision, s.structureRevision];
    function baseline(s: any) {
      const bars = s.listReadonly();
      const encode = (xs: any[]) => JSON.stringify(xs.map(b => ({ ...b, cells: [...b.cells] })));
      const value = encode(bars);
      const refs = bars.map((b: any) => [b, b.cells, b.sources, b.deltaBySize, [...b.cells]]);
      const counters = stamp(s), length = s.length;
      return () => {
        equal(stamp(s), counters, 'raw counters mutated');
        check(s.length === length && encode(s.listReadonly()) === value, 'raw values mutated');
        s.listReadonly().forEach((b: any, i: number) => {
          const r = refs[i];
          check(b === r[0] && b.cells === r[1] && b.sources === r[2] && b.deltaBySize === r[3], 'raw references mutated');
          for (const [key, cell] of r[4]) check(b.cells.get(key) === cell, 'raw cell reference mutated');
        });
      };
    }
    const cleanup: Array<() => unknown> = [];
    let primary: unknown, failed = false;
    async function finish() {
      const errors: unknown[] = [];
      while (cleanup.length) { try { await cleanup.pop()!(); } catch (error) { errors.push(error); } }
      if (failed || errors.length) throw new AggregateError(failed ? [primary, ...errors] : errors, 'consumer test/cleanup failed');
    }
    function override(target: any, key: string, value: any) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value });
      let active = true;
      const restore = () => { if (!active) return; if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; active = false; };
      cleanup.push(restore);
      return restore;
    }
    const counts: Record<string, number> = {};
    const prepared: Record<string, any[]> = {};
    function spy(target: any, key: string, name: string) {
      const original = target[key];
      check(typeof original === 'function', 'missing real hook: ' + name);
      counts[name] = 0;
      override(target, key, function(this: any, ...args: any[]) {
        counts[name]++;
        const result = original.apply(this, args);
        if (key === 'prepareData') (prepared[name] ??= []).push(result);
        return result;
      });
    }
    try {
      const ma = getIndicatorDefinition('moving-average'), rsi = getIndicatorDefinition('rsi');
      check(ma && rsi && !ma.analysisExport, 'real MA generic export definition required');
      const maInst = await createIndicatorInstanceAsync(ma.type, 1);
      const rsiInst = await createIndicatorInstanceAsync(rsi.type, 0);
      maInst.settings = { ...maInst.settings, lines: [{ id: 'sma2', method: 'sma', period: 2, timeframe: 'chart', enabled: true, color: '#44aaff' }] };
      rsiInst.settings = { ...rsiInst.settings, period: 2, showReadout: true, showLastValueLabel: false };
      const instances = [rsiInst, maInst];
      const s1 = new FootprintSeries({ intervalMs: interval, priceStep: 1 }); s1.loadBars(fixture());
      const s2 = new FootprintSeries({ intervalMs: interval, priceStep: 1 }); s2.loadBars(fixture(90));
      equal(stamp(s1), stamp(s2), 'different series must have matching counters');
      const untouched1 = baseline(s1), untouched2 = baseline(s2);
      function harness() {
        const root = document.createElement('div'); document.body.append(root); cleanup.push(() => root.remove());
        const mounted = mountIndicatorPaneHeaders(root); cleanup.push(() => mounted.dispose());
        return { root, mounted };
      }
      const mh = harness(), ch = harness();
      check(mh.mounted.headers !== ch.mounted.headers, 'independent header ownership');
      const options = (h: any) => ({ ownerDocument: document, root: h.root, initial: instances,
        onChange: () => {}, onLayoutChange: () => {}, onInvalidate: () => {}, getChartContext: chart,
        queuePriceLabel: () => {}, headers: h.mounted.headers });
      const manager = new IndicatorManager(options(mh)); cleanup.push(() => manager.dispose());
      const controller = new ChartIndicatorController(options(ch)); cleanup.push(() => controller.dispose());
      override(ma, 'prepareCache', 'series-range');
      const headerOriginal = Object.getOwnPropertyDescriptor(rsi, 'getHeaderLabel');
      const undoHeader = override(rsi, 'getHeaderLabel', () => 'RAWHDR-333');
      spy(rsi, 'getHeaderLabel', 'header');
      spy(ma, 'prepareData', 'maPrepare'); spy(ma, 'drawPriceOverlay', 'maDraw');
      spy(rsi, 'prepareData', 'rsiPrepare'); spy(rsi, 'drawSubPane', 'rsiDraw'); spy(rsi, 'drawInteraction', 'interaction');
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 300;
      const ctx = canvas.getContext('2d'); check(ctx, 'real canvas context required');
      const texts: string[] = [];
      const fillText = ctx.fillText;
      override(ctx, 'fillText', function(this: CanvasRenderingContext2D, ...args: any[]) {
        texts.push(String(args[0])); Reflect.apply(fillText, this, args);
      });
      const view = new View(); view.area = { left: 0, top: 0, width: 1200, height: 300 };
      const rect = { top: 0, height: 160 }, range = [0, 3];
      const crosshair = { x: view.xOfIndex(2) + view.colWidth / 4, y: 80, visible: true };
      const pane = controller.getPaneRenders().find((p: any) => p.id === rsiInst.id);
      check(pane && typeof pane.drawInteraction === 'function', 'real captured RSI interaction closure');
      const overlays = manager.getPriceOverlayRenders(); check(overlays.length > 0, 'real MA overlay closure');
      const values = (data: any) => data.meta.series[0].points.map((p: any) => p.value);
      function interact(series: any) {
        texts.length = 0;
        pane.drawInteraction(ctx, view, series, rect, range, crosshair);
        check(texts.some(t => t.includes('◆') && t.includes('RSI 100.00')), 'actual finite hover readout missing');
      }
      interact(s1);
      equal(values(prepared.rsiPrepare.at(-1)), [null, null, 100], 'literal RSI2');
      const firstPrepared = prepared.rsiPrepare.at(-1), firstCount = counts.rsiPrepare;
      interact(s1);
      check(counts.rsiPrepare === firstCount && prepared.rsiPrepare.at(-1) === firstPrepared, 'same-input cache reuse');
      interact(s2); check(counts.rsiPrepare === firstCount + 1, 'other-series fresh prepare');
      check(prepared.rsiPrepare.at(-1) !== firstPrepared, 'other-series prepared identity');
      equal(prepared.rsiPrepare.at(-1).meta.series[0].points.map((p: any) => p.time), [baseTime, baseTime + interval, baseTime + 2 * interval], 'RSI times');
      untouched1(); untouched2();
      const beforeReset = stamp(s2), beforeResetPrepared = prepared.rsiPrepare.at(-1), beforeResetCount = counts.rsiPrepare;
      const resetFixture = [bar(0, 80), bar(1, 80), bar(2, 74)];
      equal(resetFixture.map(b => [b.open, b.high, b.low, b.close]), [[90, 94, 88, 92], [92, 96, 90, 94], [88, 92, 86, 90]], 'literal reset OHLC');
      s2.loadBars(resetFixture);
      const afterReset = stamp(s2);
      check(afterReset.every((v: number, i: number) => v > beforeReset[i]), 'combined public reset stamps');
      const untouchedReset = baseline(s2);
      texts.length = 0; pane.drawInteraction(ctx, view, s2, rect, range, crosshair);
      check(counts.rsiPrepare === beforeResetCount + 1 && prepared.rsiPrepare.at(-1) !== beforeResetPrepared, 'reset fresh prepare');
      // Closes 92,94,90: seed average gain=1, loss=2; RSI2=100/3, not 25 or stale 100.
      const resetValues = values(prepared.rsiPrepare.at(-1));
      equal(resetValues.slice(0, 2), [null, null], 'reset RSI2 warmup');
      check(resetValues.length === 3 && typeof resetValues[2] === 'number' && Math.abs(resetValues[2] - 33.33333333333333) < 1e-12, 'literal reset RSI2');
      check(texts.some(t => t.includes('◆') && t.includes('RSI 33.33')), 'reset actual readout'); untouchedReset();
      function exportMA() {
        const snap = buildIndicatorAnalysisSnapshot(maInst, ma, s1, chart(), [0, 3]);
        check(snap.status === 'ok' && snap.warnings.length === 0, 'actual generic export');
        equal(snap.series[0].samples, [{ time: baseTime + interval, value: 13 }, { time: baseTime + 2 * interval, value: 15 }], 'literal generic SMA export');
        return snap;
      }
      function rawLeg() {
        const drawBefore = counts.maDraw, subBefore = counts.rsiDraw, interactionBefore = counts.interaction;
        for (const overlay of overlays) overlay.draw(ctx, view, s1, rect, range, undefined);
        pane.draw(ctx, view, s1, rect, range, crosshair); interact(s1);
        check(counts.maDraw > drawBefore && counts.rsiDraw > subBefore && counts.interaction > interactionBefore, 'RAW positive consumers');
        equal(values(prepared.maPrepare.at(-1)), [null, 13, 15], 'literal SMA prepare');
        const exportBefore = counts.maPrepare; exportMA();
        return exportBefore;
      }
      rawLeg(); check(counts.maPrepare > 0 && counts.rsiPrepare > 0, 'separate prepare witnesses');
      // Public restore rebuilds real header arrays; captured draw closures remain unchanged.
      function headers(expected: string, shouldCall: boolean) {
        for (const [owner, h] of [[manager, mh], [controller, ch]] as any[]) {
          const oldArray = h.mounted.headers.panes, oldPane = oldArray.find((p: any) => p.id === rsiInst.id);
          const before = counts.header, prepareBefore = [counts.maPrepare, counts.rsiPrepare];
          owner.restore(instances);
          const fresh = h.mounted.headers.panes.find((p: any) => p.id === rsiInst.id);
          check(h.mounted.headers.panes !== oldArray && fresh !== oldPane && fresh.label === expected, 'fresh public header oracle');
          check(shouldCall ? counts.header > before : counts.header === before, 'header own source guard');
          equal([counts.maPrepare, counts.rsiPrepare], prepareBefore, 'restore must not prepare');
        }
      }
      headers('RAWHDR-333', true); untouched1();
      const undoMa = override(ma, 'inputSource', 'view'), undoRsi = override(rsi, 'inputSource', 'view');
      const beforeView = { ...counts };
      ctx.clearRect(0, 0, canvas.width, canvas.height); texts.length = 0;
      for (const overlay of overlays) overlay.draw(ctx, view, s1, rect, range, undefined);
      pane.draw(ctx, view, s1, rect, range, crosshair); pane.drawInteraction(ctx, view, s1, rect, range, crosshair);
      const unsupported = buildIndicatorAnalysisSnapshot(maInst, ma, s1, chart(), [0, 3]);
      check(unsupported.status === 'unsupported', 'VIEW export status');
      equal(unsupported.warnings, ['view-adapter-unavailable'], 'VIEW warning'); equal(unsupported.series, [], 'no stale RAW export');
      headers(rsiInst.title, false); equal(counts, beforeView, 'VIEW hook isolation');
      check(texts.length === 0 && ctx.getImageData(0, 0, canvas.width, canvas.height).data.every(v => v === 0), 'VIEW no rendering/readout'); untouched1();
      undoRsi(); undoMa();
      const recoveryPrepare = counts.maPrepare;
      headers('RAWHDR-333', true); rawLeg();
      check(counts.maPrepare > recoveryPrepare, 'RAW recovery actual preparation'); untouched1();
      // Explicit LIFO: remove wrapper before restoring original header descriptor.
      while (cleanup.length && rsi.getHeaderLabel !== undefined) {
        const current = Object.getOwnPropertyDescriptor(rsi, 'getHeaderLabel');
        if (current?.value === headerOriginal?.value) break;
        await cleanup.pop()!();
      }
      undoHeader();
      const restored = Object.getOwnPropertyDescriptor(rsi, 'getHeaderLabel');
      check(restored?.value === headerOriginal?.value && restored?.configurable === headerOriginal?.configurable, 'original header descriptor');
      return { beforeReset, afterReset, scope: 'combined-reset-not-epoch-only' };
    } catch (error) { primary = error; failed = true; }
    finally { await finish(); }
  });
  expect(result?.scope).toBe('combined-reset-not-epoch-only');
});

test('owned runtime cursor composition, actual pointer consumers and replay exit', async ({ page }) => {
  test.setTimeout(60_000);
  await installHistory(page);
  await openHarness(page);
  await page.evaluate(async () => {
    const mod = (path: string): Promise<any> => import(path);
    const { mountChart } = await mod('/harness/chart.ts');
    const { createChartSurfaceModel } = await mod('/harness/chart.ts');
    const { getChartRuntime } = await mod('/harness/chart.ts');
    const { DrawingManager } = await mod('/src/features/drawings/drawingManager.ts');
    const { DEFAULT_VOLUME_PROFILE_SETTINGS } = await mod('/src/core/analysis/volumeProfile.ts');
    const { normalizePreviousWeekStrategySettings } = await mod('/src/core/analysis/previousWeekStrategy.ts');
    const { normalizeMondayRangeSettings } = await mod('/src/core/analysis/mondayRange.ts');
    const { captureRawSource, sameRawSource, resolveRawCursor } = await mod('/src/features/chart/rawViewContract.ts');
    const { FootprintSeries } = await mod('/src/core/model/footprint.ts');
    const { getIndicatorDefinition } = await mod('/src/features/indicators/registry.ts');
    const market = 'BINANCE_FUTURES:btcusdt', base = 1577836800000, intervalMs = 60000;
    const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
    const equal = (a: unknown, b: unknown, label: string) => check(JSON.stringify(a) === JSON.stringify(b), label);
    const context = { market, drawings: new DrawingManager(() => {}), profileSettings: structuredClone(DEFAULT_VOLUME_PROFILE_SETTINGS),
      previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }), previousWeekStrategyLevels: [],
      mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }), mondayRangeLevels: [], nakedPocs: [], referenceLevels: [] };
    const services = { subscribeToTrades: () => () => {}, fetchPriceStep: async () => 0.1, fetchPricePrecision: async () => 1,
      getAnalysisContext: () => context, getAnalysisRevisionSnapshot: () => ({ market, revision: 1,
        canonical: { status: 'complete', market, runKey: market + '|0.1', generation: 1, revision: 1, failedPeriods: [] } }),
      getAutomaticLevelsAsOf: () => null, subscribeAnalysis: () => () => {}, subscribeAnalysisRevision: () => () => {},
      updateAnalysisFromSeries: () => {}, fetchNpocSnapshot: () => new Promise(() => {}), notifyActiveMarket: () => {},
      notifyInteractiveCandlesReady: () => {}, notifyInteractiveHistorySettled: () => {}, triggerAutoSync: () => {},
      notifyBarClose: () => {}, notify: () => {}, isFootprintSyncBusy: () => false };
    const cleanup: Array<() => unknown> = []; let primary: unknown, failed = false;
    const root = document.createElement('div'); root.style.cssText = 'position:fixed;left:8px;top:16px;width:1200px;height:400px';
    document.body.append(root); cleanup.push(() => root.remove());
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 15000;
      while (!predicate()) { check(Date.now() < deadline, 'runtime wait timeout'); await new Promise(r => setTimeout(r, 20)); }
    };
    try {
      const id = 'raw-view-333-owned';
      const handle = mountChart(root, { type: 'chart', market, timeframe: '1m', scaleMode: 'linear', chartType: 'candlestick', candles: true }, services, id, createChartSurfaceModel());
      cleanup.push(() => handle.dispose()); await waitFor(() => Boolean(getChartRuntime(id)));
      const runtime = getChartRuntime(id); await waitFor(() => runtime.getCaptureReadiness().ready && runtime.getCaptureReadiness().reason === 'READY');
      const series = runtime.pipeline.series;
      const bars = [12, 14, 1000000].map((close, i) => ({ startTime: base + i * intervalMs, open: close - 2, high: close + 2, low: close - 4, close,
        volume: 24, delta: 2, count: 10, liquidationBuyVol: 1, liquidationSellVol: 2, cells: new Map([[close, { priceBin: close, buyVol: 13, sellVol: 11,
          count: 10, buyCount: 6, sellCount: 4, liquidationBuyVol: 1, liquidationSellVol: 2 }]]), hasRef: true, completeness: 'complete', sources: ['history'],
        cellRevision: 1, updatedAt: base + i * intervalMs, deltaBySize: [3, -1, 0, 0, 0, 0, 0, 0, 0, 0] }));
      series.loadBars(bars); runtime.startReplay(); check(runtime.getReplaySnapshot().state === 'selecting', 'selecting');
      runtime.replaySeek(base + 2 * intervalMs); check(runtime.getReplaySnapshot().state === 'paused' && series.length === 2, 'seek paused prefix');
      const encode = () => JSON.stringify(series.listReadonly().map((b: any) => ({ ...b, cells: [...b.cells] })));
      const immutable = encode(), refs = series.listReadonly().map((b: any) => [b, b.cells, b.sources, b.deltaBySize, [...b.cells]]);
      const stamps = [series.resetEpoch, series.revision, series.structureRevision];
      const untouched = () => {
        equal(encode(), immutable, 'prefix values immutable'); equal([series.resetEpoch, series.revision, series.structureRevision], stamps, 'prefix counters immutable');
        series.listReadonly().forEach((b: any, i: number) => { const r = refs[i]; check(b === r[0] && b.cells === r[1] && b.sources === r[2] && b.deltaBySize === r[3], 'prefix refs'); for (const [k, c] of r[4]) check(b.cells.get(k) === c, 'prefix cell refs'); });
      };
      const ma = getIndicatorDefinition('moving-average'), settings = { lines: [{ id: 'sma2', method: 'sma', period: 2, timeframe: 'chart', enabled: true, color: '#44aaff' }] };
      const data = ma.prepareData({ ctx: {}, view: runtime.view, series, rect: { top: 0, height: 160 }, range: [0, 2], instance: { id: 'prefix-sma', type: ma.type, title: 'Prefix SMA', visible: true, paneId: 'price', order: 0, settings }, settings,
        chart: { market, timeframe: '1m', intervalMs }, requestRefresh: () => {} });
      equal(data.meta.series[0].points.map((p: any) => p.value), [null, 13], 'no future SMA contamination'); untouched();
      // Direct module composition with genuine runtime ownership; not public cursor metadata.
      const chart = { market, timeframe: '1m', intervalMs }, source = captureRawSource(runtime, series, chart);
      const fields = ['owner', 'series', 'market', 'timeframe', 'intervalMs', 'resetEpoch', 'revision', 'structureRevision'];
      equal(Object.keys(source).sort(), [...fields].sort(), 'eight identity fields');
      check(source.owner === runtime && source.series === series && source.market === market && source.timeframe === '1m' && source.intervalMs === intervalMs, 'identity references/context');
      equal([source.resetEpoch, source.revision, source.structureRevision], stamps, 'current identity stamps');
      check(sameRawSource(source, captureRawSource(runtime, series, chart)), 'fresh same source');
      const alternate = new FootprintSeries({ intervalMs, priceStep: 0.1 }); alternate.loadBars(bars.slice(0, 2));
      const changes = [{}, alternate, market + ':other', '5m', intervalMs + 1, source.resetEpoch + 1, source.revision + 1, source.structureRevision + 1];
      // Identity separation covers all eight fields; it is not an eight-field cursor rejection gate.
      fields.forEach((field, i) => check(!sameRawSource(source, { ...source, [field]: changes[i] }), 'identity separation: ' + field));
      // Single-token resolver checks only three live series counters, independently on both axes.
      // Stronger owner/series/context cursor rejection is UNSUPPORTED: no expected-current context input.
      for (const field of ['resetEpoch', 'revision', 'structureRevision']) {
        const stale = resolveRawCursor({ ...source, [field]: source[field] + 1 }, 0.5, 12.5, 'raw');
        equal(stale, { time: { status: 'unknown', reason: 'stale-source' }, price: { status: 'unknown', reason: 'stale-source' } }, 'both stale axes: ' + field);
      }
      const known = resolveRawCursor(source, 0.5, 12.5, 'raw');
      check(known.time.status === 'known' && known.time.time === base + 30000 && known.time.source === source && known.price.source === source && known.price.price === 12.5, 'known owned current cursor');
      const synthetic = resolveRawCursor(source, 0.5, 999, 'synthetic-noninvertible');
      check(synthetic.time.status === 'known', 'synthetic time remains independent'); equal(synthetic.price, { status: 'unknown', reason: 'non-invertible' }, 'no synthetic raw price'); untouched();
      // Public runtime mapping captures its own fresh owner/series/current state token for each resolve.
      const events: any[] = []; cleanup.push(runtime.subscribeCrosshairMove((e: any) => events.push({ ...e })));
      const canvas = runtime.interactionCanvas, view = runtime.view, rect = canvas.getBoundingClientRect();
      const move = (ordinal: number) => canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + view.xOfIndex(ordinal), clientY: rect.top + view.yOfPrice(12.5) }));
      for (const ordinal of [0, 0.5, 1.5, 2]) {
        move(ordinal); const event = events.at(-1); equal(Object.keys(event).sort(), ['price', 'time'], 'public cursor shape');
        equal(event.time, ordinal === 2 ? null : base + ordinal * intervalMs, 'public pointer time'); check(Math.abs(event.price - 12.5) < 1e-6, 'public pointer price');
      }
      canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true })); equal(events.at(-1), { time: null, price: null }, 'leave axes');
      const descriptor = Object.getOwnPropertyDescriptor(runtime, 'applyingExternal'); let active = true;
      const restore = () => { if (!active) return; if (descriptor) Object.defineProperty(runtime, 'applyingExternal', descriptor); else delete runtime.applyingExternal; active = false; };
      cleanup.push(restore); Object.defineProperty(runtime, 'applyingExternal', { configurable: true, get: () => true });
      const before = events.length; move(0.5); check(events.length === before, 'external guard'); restore();
      const drawing = runtime.screenToDrawingPoint(view.xOfIndex(1), view.yOfPrice(12.5)); check(drawing.time === base + intervalMs && Math.abs(drawing.price - 12.5) < 1e-6, 'drawing canvas-local mapping'); untouched();
      runtime.exitReplay(); check(runtime.getReplaySnapshot() === null && runtime.getDiagnostics().replayActive === false, 'actual public replay exit');
      // Default exit starts genuine asynchronous history reload; no fixture-restoration assertion.
    } catch (error) { primary = error; failed = true; }
    finally {
      const errors: unknown[] = [], cleanupSlots: number[] = []; while (cleanup.length) { try { await cleanup.pop()!(); } catch (error) { errors.push(error); cleanupSlots.push(cleanup.length); } }
      const field = (error: unknown, key: string) => {
        try { const value = (error as any)?.[key], text = String(value ?? (key === 'message' ? error : '<absent>')); return text.slice(0, 2000) + (text.length > 2000 ? ' [truncated]' : ''); }
        catch { return '<unreadable>'; }
      };
      const describe = (label: string, error: unknown) => label + '\nname: ' + field(error, 'name') + '\nmessage: ' + field(error, 'message') + '\nstack: ' + field(error, 'stack');
      if (failed || errors.length) throw new AggregateError(failed ? [primary, ...errors] : errors, 'runtime test/cleanup failed; cleanup failures=' + errors.length + '\n' + (failed ? describe('primary', primary) + '\n' : '') + errors.map((error, i) => describe('cleanup failure ' + (i + 1) + '/' + errors.length + ' (registration slot ' + cleanupSlots[i] + ', zero-based)', error)).join('\n'));
    }
  });
});
