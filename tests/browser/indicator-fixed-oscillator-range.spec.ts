import { test, expect } from '@playwright/test';
import { openHarness } from './support/history.js';

// Given a bounded oscillator whose visible values occupy only part of its domain,
// when the visible window changes and the real pane renderer draws it,
// then the 0-100 scale, OB/50/OS labels, and 50-line pixel position remain fixed.
test('RSI pane keeps fixed oscillator range and axis labels while scrolling', async ({ page }) => {
  await openHarness(page);
  const evidence = await page.evaluate(async () => {
    const { FootprintSeries } = await import('/src/core/model/footprint.ts');
    const { rsiIndicatorDefinition } = await import('/src/features/indicators/builtins/rsi.ts');
    const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 0.01 });
    let close = 100;
    series.loadBars(Array.from({ length: 160 }, (_, i) => {
      close += i % 2 === 0 ? 2 : -1;
      return { startTime: Date.UTC(2026, 0, 1) + i * 60_000, open: close, high: close + 0.5, low: close - 0.5,
        close, volume: 10 + i, delta: 0, count: 1, cells: new Map(), hasRef: true, cellRevision: 0 };
    }));
    const render = (from: number, to: number, overrides: Record<string, unknown> = {}) => {
      const settings = { ...rsiIndicatorDefinition.defaultSettings(), ...overrides };
      const prepared = rsiIndicatorDefinition.prepareData({ ctx: {}, view: {}, series, rect: { top: 0, height: 120 }, range: [from, to],
        instance: { id: `rsi-${from}`, type: 'rsi', title: 'RSI', visible: true, paneId: 'pane', order: 0, settings }, settings,
        requestRefresh() {} } as any);
      const labels: Array<{ text: string; x: number; y: number }> = [];
      const canvas = new Proxy({ fillText: (text: string, x: number, y: number) => labels.push({ text, x, y }),
        measureText: () => ({ width: 20 }) } as any, { get(target, key) { return key in target ? target[key] : () => {}; },
        set(target, key, value) { target[key] = value; return true; } });
      rsiIndicatorDefinition.drawSubPane!({ ctx: canvas, view: { area: { left: 0, width: 300 }, priceAxisW: 48,
        colWidth: 4, xOfIndex: (index: number) => index }, rect: { top: 0, height: 120 }, range: [from, to], series,
        instance: { id: `rsi-${from}`, type: 'rsi', title: 'RSI', visible: true, paneId: 'pane', order: 0, settings }, settings,
        requestRefresh() {} } as any, prepared);
      const scaleMin = prepared.range.min, scaleMax = prepared.range.max;
      const axis = labels.filter(({ text, x }) => /^(?:\d+(?:\.\d+)?)$/.test(text) && x > 300);
      return { scaleMin, scaleMax, axis, ticks: prepared.meta.axisTicks };
    };
    return { earlier: render(0, 100), recent: render(100, 160), manual: render(100, 160, { paneScaleAuto: false, paneScaleFactor: 0.5 }) };
  });

  expect(evidence.earlier.scaleMin).toBe(0);
  expect(evidence.earlier.scaleMax).toBe(100);
  expect(evidence.earlier.ticks).toEqual([70, 50, 30]);
  expect(evidence.earlier.axis.map(({ text }) => text)).toEqual(['70', '50', '30']);
  expect(evidence.recent.axis.map(({ text }) => text)).toEqual(['70', '50', '30']);
  expect(evidence.earlier.axis[1].y).toBe(evidence.recent.axis[1].y);
  expect(evidence.manual.scaleMin).toBe(25);
  expect(evidence.manual.scaleMax).toBe(75);
  expect(evidence.manual.axis.map(({ text }) => text)).toEqual(['70', '50']);
});
