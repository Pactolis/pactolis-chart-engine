import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

/**
 * Real touch input on a real chart: Chromium's touch emulation (CDP Input.dispatchTouchEvent)
 * on a phone-sized page, so the browser's own gesture handling is in the loop. The synthetic
 * counterpart, with a recording host, is chart-touch-input.spec.ts.
 */

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] },
});

type Point = { x: number; y: number };
type Finger = Point & { id: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", fingers: Finger[] = []): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: fingers.map((f) => ({ x: f.x, y: f.y, id: f.id, radiusX: 8, radiusY: 8, force: 1 })),
  });
}

/** One finger from `from` to `to` in small steps, then lifted. */
async function drag(cdp: CDPSession, from: Point, to: Point, steps = 12): Promise<void> {
  await touch(cdp, "touchStart", [{ ...from, id: 0 }]);
  await sleep(20);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await touch(cdp, "touchMove", [{ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, id: 0 }]);
    await sleep(16);
  }
  await touch(cdp, "touchEnd");
  await sleep(80);
}

/** Two fingers `d0` apart (horizontal, centred on `c`) that end up `d1` apart. */
async function pinch(cdp: CDPSession, c: Point, d0: number, d1: number, steps = 12): Promise<void> {
  const fingers = (d: number): Finger[] => [{ x: c.x - d / 2, y: c.y, id: 0 }, { x: c.x + d / 2, y: c.y, id: 1 }];
  await touch(cdp, "touchStart", fingers(d0));
  await sleep(20);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, "touchMove", fingers(d0 + (d1 - d0) * (i / steps)));
    await sleep(16);
  }
  await touch(cdp, "touchEnd");
  await sleep(80);
}

async function tap(cdp: CDPSession, at: Point): Promise<void> {
  await touch(cdp, "touchStart", [{ ...at, id: 0 }]);
  await sleep(50);
  await touch(cdp, "touchEnd");
  await sleep(80);
}

interface ChartState {
  colWidth: number;
  offsetX: number;
  visibleBars: number;
  crosshairVisible: boolean;
  crosshairTouch: boolean | undefined;
  autoScale: boolean;
  area: { left: number; top: number; width: number; height: number };
  priceAxisW: number;
  pageScale: number | undefined;
  scrollY: number;
}

async function chartState(page: Page): Promise<ChartState> {
  return page.evaluate(async () => {
    const harness = await import("/harness/chart.ts");
    const runtime = harness.listChartRuntimes()[0] as unknown as {
      view: { area: { left: number; top: number; width: number; height: number }; priceAxisW: number; isPriceAutoScale: () => boolean };
      crosshair: { visible: boolean; touch?: boolean };
    };
    const vp = (window as unknown as { __vp: () => { colWidth: number; offsetX: number; visibleBars: number } }).__vp();
    return {
      colWidth: vp.colWidth,
      offsetX: vp.offsetX,
      visibleBars: vp.visibleBars,
      crosshairVisible: runtime.crosshair.visible,
      crosshairTouch: runtime.crosshair.touch,
      autoScale: runtime.view.isPriceAutoScale(),
      area: { ...runtime.view.area },
      priceAxisW: runtime.view.priceAxisW,
      pageScale: window.visualViewport?.scale,
      scrollY: window.scrollY,
    };
  });
}

/** The chart has loaded its history and stopped moving. */
async function waitSettled(page: Page): Promise<void> {
  let last = "";
  let since = Date.now();
  for (let waited = 0; waited < 20_000; waited += 150) {
    const current = await page.evaluate(() => {
      const vp = (window as unknown as { __vp?: () => unknown }).__vp?.();
      const hook = document.querySelector('[data-testid="chart-hook"]');
      return JSON.stringify([vp, hook?.getAttribute("data-history-loading"), hook?.getAttribute("data-series-len")]);
    });
    if (current !== last) {
      last = current;
      since = Date.now();
    } else if (Date.now() - since >= 1000) {
      return;
    }
    await sleep(150);
  }
}

let cdp: CDPSession;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const events = { pointercancel: 0, contextmenu: 0, chartcontextmenu: [] as unknown[] };
    (window as unknown as { __touchEvents: typeof events }).__touchEvents = events;
    window.addEventListener("pointercancel", () => { events.pointercancel += 1; }, true);
    window.addEventListener("contextmenu", () => { events.contextmenu += 1; }, true);
    window.addEventListener("chartcontextmenu", (event) => { events.chartcontextmenu.push((event as CustomEvent).detail); }, true);
  });
  await installHistory(page);
  await openHarness(page, "?chart=BTCUSDT&timeframe=15m&type=footprint");
  await page.waitForFunction(() => {
    const hook = document.querySelector('[data-testid="chart-hook"]');
    return hook && Number(hook.getAttribute("data-series-len")) > 0 && hook.getAttribute("data-visible-range");
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await waitSettled(page);
  cdp = await page.context().newCDPSession(page);
});

const touchEvents = (page: Page) => page.evaluate(() => (window as unknown as {
  __touchEvents: { pointercancel: number; contextmenu: number; chartcontextmenu: Array<{ target: string; clientX: number; clientY: number }> };
}).__touchEvents);

test("the interaction canvas hands every touch to the engine instead of the browser", async ({ page }) => {
  const style = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-chart-surface="interaction"]') as HTMLCanvasElement;
    const computed = getComputedStyle(canvas);
    return { touchAction: computed.touchAction, userSelect: computed.userSelect };
  });
  expect(style.touchAction).toBe("none");
  expect(style.userSelect).toBe("none");
});

test("a touch screen starts in touch mode", async ({ page }) => {
  const state = await chartState(page);
  expect(state.crosshairTouch).toBe(true);
  expect(state.crosshairVisible).toBe(false);
});

test("one finger pans the chart without the browser cancelling the gesture or scrolling the page", async ({ page }) => {
  const before = await chartState(page);
  const y = before.area.top + before.area.height / 2;
  await drag(cdp, { x: 120, y }, { x: 270, y });
  await sleep(200);
  const after = await chartState(page);
  expect(after.offsetX - before.offsetX).toBeGreaterThan(120);
  expect(after.offsetX - before.offsetX).toBeLessThan(160);
  expect(after.colWidth).toBe(before.colWidth);
  expect((await touchEvents(page)).pointercancel).toBe(0);
  expect(after.scrollY).toBe(0);
  expect(after.crosshairVisible).toBe(false);
});

test("a tap or a wobble does not move the chart", async ({ page }) => {
  const before = await chartState(page);
  const y = before.area.top + before.area.height / 2;
  await touch(cdp, "touchStart", [{ x: 150, y, id: 0 }]);
  await sleep(40);
  await touch(cdp, "touchMove", [{ x: 154, y: y + 3, id: 0 }]);
  await sleep(40);
  await touch(cdp, "touchEnd");
  await sleep(150);
  const after = await chartState(page);
  expect(after.offsetX).toBe(before.offsetX);
});

test("two fingers zoom the time axis around their midpoint and the page itself stays put", async ({ page }) => {
  const before = await chartState(page);
  const y = before.area.top + before.area.height / 2;
  await pinch(cdp, { x: 190, y }, 60, 220);
  await sleep(200);
  const zoomedIn = await chartState(page);
  expect(zoomedIn.colWidth).toBeGreaterThan(before.colWidth * 2);
  expect(zoomedIn.visibleBars).toBeLessThan(before.visibleBars);
  expect(zoomedIn.pageScale).toBe(1);
  expect((await touchEvents(page)).pointercancel).toBe(0);

  await pinch(cdp, { x: 190, y }, 240, 80);
  await sleep(200);
  const zoomedOut = await chartState(page);
  expect(zoomedOut.colWidth).toBeLessThan(zoomedIn.colWidth);
  expect(zoomedOut.pageScale).toBe(1);
});

test("holding a finger still opens the crosshair, which closes when the finger lifts", async ({ page }) => {
  const before = await chartState(page);
  const y = before.area.top + before.area.height / 2;
  await touch(cdp, "touchStart", [{ x: 150, y, id: 0 }]);
  await sleep(150);
  expect((await chartState(page)).crosshairVisible).toBe(false);
  await sleep(450);
  expect((await chartState(page)).crosshairVisible).toBe(true);
  await touch(cdp, "touchMove", [{ x: 220, y: y + 30, id: 0 }]);
  await sleep(100);
  const held = await chartState(page);
  expect(held.crosshairVisible).toBe(true);
  expect(held.offsetX).toBe(before.offsetX);
  await touch(cdp, "touchEnd");
  await sleep(150);
  expect((await chartState(page)).crosshairVisible).toBe(false);

  const events = await touchEvents(page);
  expect(events.pointercancel).toBe(0);
  expect(events.chartcontextmenu).toEqual([]);
});

test("the corner button opens the chart menu", async ({ page }) => {
  const { area } = await chartState(page);
  const at = { x: area.left + area.width - 36 - 8 + 18, y: area.top + 4 + 18 };
  await tap(cdp, at);
  const events = await touchEvents(page);
  expect(events.chartcontextmenu).toHaveLength(1);
  expect(events.chartcontextmenu[0].target).toBe("plot");
  // The menu is anchored under the button, which hugs the plot's right edge.
  expect(events.chartcontextmenu[0].clientY).toBeGreaterThan(at.y);
  expect(events.chartcontextmenu[0].clientX).toBeGreaterThan(area.left + area.width - 60);
});

test("the price-scale buttons are on the axis and answer a tap", async ({ page }) => {
  const before = await chartState(page);
  expect(before.autoScale).toBe(true);
  const axisCenter = before.area.left + before.area.width + before.priceAxisW / 2;
  const bottom = before.area.top + before.area.height;
  // The auto-scale button is the upper of the two stacked at the foot of the axis.
  await tap(cdp, { x: axisCenter, y: bottom - 4 - 32 - 6 - 16 });
  expect((await chartState(page)).autoScale).toBe(false);
  await tap(cdp, { x: axisCenter, y: bottom - 4 - 32 - 6 - 16 });
  expect((await chartState(page)).autoScale).toBe(true);
});

test("a long press on the plot never raises the browser's own menu", async ({ page }) => {
  const { area } = await chartState(page);
  await touch(cdp, "touchStart", [{ x: 150, y: area.top + area.height / 2, id: 0 }]);
  await sleep(1800);
  await touch(cdp, "touchEnd");
  await sleep(150);
  const events = await touchEvents(page);
  expect(events.chartcontextmenu).toEqual([]);
  expect(events.pointercancel).toBe(0);
});
