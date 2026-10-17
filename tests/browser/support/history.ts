import type { Page } from "@playwright/test";
import type { WireBar } from "../../../harness/historySource.js";

// Deterministic clock and bars for the browser specs. FROZEN_NOW matches the
// Pactolis app's browser fixtures, so ported specs keep their expectations.
export const FROZEN_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
export const INTERVAL_MS = 15 * 60_000;
export const PRICE_STEP = 10;

function alignedFrozenNow(): number {
  return Math.floor(FROZEN_NOW / INTERVAL_MS) * INTERVAL_MS;
}

function fixedHudBar(time: number): WireBar {
  return {
    t: time,
    o: 60000,
    h: 60500,
    l: 59800,
    c: 60200,
    v: 12.5,
    d: 3.25,
    n: 42,
    cells: [
      [59800, 1.5, 0.8, 0, 0],
      [59850, 1.1, 0.7, 0, 0],
      [59900, 1.3, 0.9, 0, 0],
      [59950, 1.7, 1.0, 0, 0],
      [60000, 2.1, 1.4, 0, 0],
      [60050, 2.3, 1.2, 0, 0],
      [60100, 2.6, 1.1, 0, 0],
      [60150, 2.8, 1.0, 0, 0],
      [60200, 3.0, 0.9, 0.2, 0],
      [60250, 2.5, 1.1, 0, 0],
      [60300, 2.0, 1.3, 0, 0],
      [60350, 1.6, 1.5, 0, 0],
      [60400, 1.2, 1.6, 0, 0.1],
    ],
    lb: 0.2,
    ls: 0.1,
    completeness: "complete",
    updatedAt: FROZEN_NOW,
  };
}

/** Deterministic footprint bars ending at FROZEN_NOW. The first and last 20 bars share fixed OHLC. */
export function buildBars(count: number, opts: { startPrice?: number } = {}): WireBar[] {
  const safeCount = Math.max(0, Math.floor(count));
  const lastTime = alignedFrozenNow();
  const firstTime = lastTime - Math.max(0, safeCount - 1) * INTERVAL_MS;
  const startPrice = opts.startPrice ?? 60000;

  return Array.from({ length: safeCount }, (_, index) => {
    const time = firstTime + index * INTERVAL_MS;
    if (index === 0 || index >= Math.max(0, safeCount - 20)) return fixedHudBar(time);

    const drift = index * 18;
    const wave = index % 2 === 0 ? 90 : -70;
    const open = startPrice + drift;
    const close = open + wave;
    const high = Math.max(open, close) + 180;
    const low = Math.min(open, close) - 160;
    const bin = Math.floor(low / PRICE_STEP) * PRICE_STEP;
    const buyA = 1 + (index % 5) * 0.4;
    const sellA = 0.8 + (index % 4) * 0.35;
    const buyB = 1.8 + (index % 3) * 0.25;
    const sellB = 1.1 + (index % 6) * 0.2;

    return {
      t: time,
      o: open,
      h: high,
      l: low,
      c: close,
      v: buyA + sellA + buyB + sellB,
      d: buyA + buyB - sellA - sellB,
      n: 20 + index,
      cells: [
        [bin, buyA, sellA, 0, 0],
        [bin + PRICE_STEP, buyB, sellB, index % 7 === 0 ? 0.15 : 0, 0],
        [bin + PRICE_STEP * 2, sellA, buyA, 0, index % 9 === 0 ? 0.12 : 0],
      ],
      lb: index % 7 === 0 ? 0.15 : 0,
      ls: index % 9 === 0 ? 0.12 : 0,
      completeness: "complete",
      updatedAt: FROZEN_NOW,
    };
  });
}

/** Answer the harness's `/history` requests with `bars`. Routes added later take precedence. */
export async function installHistory(page: Page, opts: { bars?: WireBar[] } = {}): Promise<{ bars: WireBar[]; historyRequests: URL[] }> {
  const bars = opts.bars ?? buildBars(60);
  const historyRequests: URL[] = [];
  await page.route(/\/history(?:\?|$)/, (route) => {
    historyRequests.push(new URL(route.request().url()));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { bars } }) });
  });
  return { bars, historyRequests };
}

/** Open the harness page and wait until its ports are wired. */
export async function openHarness(page: Page, search = ""): Promise<void> {
  await page.goto(`/harness/${search}`);
  await page.waitForFunction(() => (window as Window & { __chartHarnessReady?: boolean }).__chartHarnessReady === true);
}

/** Chromium flags that give headless runs a working WebGL2 through SwiftShader. */
export const FUNCTIONAL_WEBGL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader-webgl",
  "--enable-unsafe-swiftshader",
] as const;
