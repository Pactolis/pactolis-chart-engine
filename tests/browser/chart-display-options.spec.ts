import { expect, test, type Page } from "@playwright/test";

import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

/**
 * What a host can ask of a chart through ChartHost.displayOptions: the compact layout, the default
 * fit, the pixel-ratio cap and the WebGL context attributes. The harness answers from the URL
 * (`density=compact&fit=100&dprcap=2&antialias=0&power=low-power`) and lets a spec change the
 * answer while the chart is mounted (setDisplayOptions in harness/chart.ts).
 */

test.use({ deviceScaleFactor: 3, launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

interface Snapshot {
  layout: { priceAxisWidth: number; timeAxisHeight: number; density: string };
  defaultFitColumns: number;
  area: { left: number; top: number; width: number; height: number };
  priceAxisW: number;
  colWidth: number;
  pixelRatio: number | null;
  css: { width: number; height: number };
  cssStyle: { width: string; height: string };
  bitmaps: { gpu: number[]; annotation: number[]; interaction: number[] };
  webgl: { antialias: boolean; powerPreference: string } | null;
}

interface TextDraw {
  surface: string;
  text: string;
  x: number;
  y: number;
  width: number;
}

type HarnessModule = {
  listChartRuntimes(): unknown[];
  setDisplayOptions(options: Record<string, unknown>): void;
};

const SYMBOL = "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m";

async function open(page: Page, search = ""): Promise<void> {
  await installHistory(page, { bars: buildBars(300) });
  await openHarness(page, `${SYMBOL}${search}`);
  const hook = page.locator('[data-testid="chart-hook"]:not([data-ft-synthetic="1"])');
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 30_000 });
  await expect(hook).toHaveAttribute("data-series-len", "300", { timeout: 30_000 });
  await settle(page);
}

/** A few frames, so history placement and the first paint are done. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const tick = () => (++frames >= 6 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const harness = await import("/harness/chart.ts") as unknown as HarnessModule;
    const runtime = harness.listChartRuntimes()[0] as unknown as {
      view: {
        chartLayoutOptions: Snapshot["layout"];
        timeScaleOptions: { defaultFitColumns: number };
        area: Snapshot["area"];
        priceAxisW: number;
        colWidth: number;
        pixelRatio: number | null;
      };
    };
    const surface = (name: string) => document.querySelector<HTMLCanvasElement>(`canvas[data-chart-surface="${name}"]`)!;
    const gpu = surface("gpu-scene");
    const rect = gpu.getBoundingClientRect();
    const attributes = (gpu.getContext("webgl2") as WebGL2RenderingContext | null)?.getContextAttributes();
    return {
      layout: { ...runtime.view.chartLayoutOptions },
      defaultFitColumns: runtime.view.timeScaleOptions.defaultFitColumns,
      area: { ...runtime.view.area },
      priceAxisW: runtime.view.priceAxisW,
      colWidth: runtime.view.colWidth,
      pixelRatio: runtime.view.pixelRatio,
      css: { width: rect.width, height: rect.height },
      cssStyle: { width: gpu.style.width, height: gpu.style.height },
      bitmaps: {
        gpu: [gpu.width, gpu.height],
        annotation: [surface("annotation").width, surface("annotation").height],
        interaction: [surface("interaction").width, surface("interaction").height],
      },
      webgl: attributes ? { antialias: attributes.antialias, powerPreference: String(attributes.powerPreference) } : null,
    };
  });
}

function setDisplayOptions(page: Page, options: Record<string, unknown>): Promise<void> {
  return page.evaluate(async (next) => {
    const harness = await import("/harness/chart.ts") as unknown as HarnessModule;
    harness.setDisplayOptions(next);
  }, options);
}

/** Records every fillText with the surface it lands on and its measured width. */
async function recordText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const draws: TextDraw[] = [];
    (window as unknown as { __textDraws: TextDraw[] }).__textDraws = draws;
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
      const surface = (this.canvas as HTMLCanvasElement | null)?.dataset?.chartSurface ?? "";
      draws.push({ surface, text: String(text), x, y, width: this.measureText(String(text)).width });
      if (draws.length > 20_000) draws.splice(0, 10_000);
      return maxWidth === undefined ? original.call(this, text, x, y) : original.call(this, text, x, y, maxWidth);
    };
  });
}

const clearText = (page: Page) => page.evaluate(() => { (window as unknown as { __textDraws: TextDraw[] }).__textDraws.length = 0; });
const textDraws = (page: Page) => page.evaluate(() => [...(window as unknown as { __textDraws: TextDraw[] }).__textDraws]);

test("a host that sets nothing gets the desktop layout, the full pixel ratio and the default context", async ({ page }) => {
  await open(page);
  const s = await snapshot(page);
  expect(s.layout).toEqual({ priceAxisWidth: 62, timeAxisHeight: 22, density: "regular" });
  expect(s.defaultFitColumns).toBe(250);
  expect(s.pixelRatio).toBe(3);
  expect(s.bitmaps.gpu).toEqual([Math.round(s.css.width * 3), Math.round(s.css.height * 3)]);
  expect(s.bitmaps.annotation).toEqual(s.bitmaps.gpu);
  expect(s.bitmaps.interaction).toEqual(s.bitmaps.gpu);
  expect(s.area.width).toBeCloseTo(s.css.width - 62, 3);
  expect(s.area.height).toBeCloseTo(s.css.height - 22, 3);
  // 300 bars in history: the initial fit aims for 250 columns plus the latest bar's padding.
  expect(s.colWidth).toBeCloseTo(s.area.width / (250 + 2 - 1), 3);
  expect(s.webgl).toEqual({ antialias: true, powerPreference: "default" });
});

test("density=compact gives the taller time strip, keeps the price gutter and fits the host's column count", async ({ page }) => {
  await open(page, "&density=compact&fit=100");
  const s = await snapshot(page);
  expect(s.layout).toEqual({ priceAxisWidth: 62, timeAxisHeight: 32, density: "compact" });
  expect(s.defaultFitColumns).toBe(100);
  expect(s.priceAxisW).toBe(62);
  expect(s.area.height).toBeCloseTo(s.css.height - 32, 3);
  expect(s.area.width).toBeCloseTo(s.css.width - 62, 3);
  expect(s.colWidth).toBeCloseTo(s.area.width / (100 + 2 - 1), 3);
});

test("each layout field can be set on its own", async ({ page }) => {
  await open(page, "&axisw=70&axish=40");
  const s = await snapshot(page);
  expect(s.layout).toEqual({ priceAxisWidth: 70, timeAxisHeight: 40, density: "regular" });
  expect(s.priceAxisW).toBe(70);
  expect(s.area.width).toBeCloseTo(s.css.width - 70, 3);
  expect(s.area.height).toBeCloseTo(s.css.height - 40, 3);
});

test("a pixel-ratio cap holds all three canvases and the renderers' ratio at the cap", async ({ page }) => {
  await open(page, "&dprcap=2");
  const s = await snapshot(page);
  expect(s.pixelRatio).toBe(2);
  expect(s.bitmaps.gpu).toEqual([Math.round(s.css.width * 2), Math.round(s.css.height * 2)]);
  expect(s.bitmaps.annotation).toEqual(s.bitmaps.gpu);
  expect(s.bitmaps.interaction).toEqual(s.bitmaps.gpu);
  expect(s.cssStyle.width).toBe(`${s.css.width}px`);
});

test("the cap can move while the chart is mounted: a lower one shrinks the bitmaps, none restores the window's ratio", async ({ page }) => {
  await open(page);
  const before = await snapshot(page);
  expect(before.pixelRatio).toBe(3);

  await setDisplayOptions(page, { maxDevicePixelRatio: 1 });
  await expect.poll(async () => (await snapshot(page)).bitmaps.gpu).toEqual([Math.round(before.css.width), Math.round(before.css.height)]);
  const capped = await snapshot(page);
  expect(capped.pixelRatio).toBe(1);
  expect(capped.bitmaps.annotation).toEqual(capped.bitmaps.gpu);
  expect(capped.bitmaps.interaction).toEqual(capped.bitmaps.gpu);
  expect(capped.css).toEqual(before.css);

  await setDisplayOptions(page, {});
  await expect.poll(async () => (await snapshot(page)).bitmaps.gpu).toEqual(before.bitmaps.gpu);
  expect((await snapshot(page)).pixelRatio).toBe(3);
});

test("antialias and power preference reach the WebGL context the chart creates", async ({ page }) => {
  await open(page, "&antialias=0&power=low-power");
  expect((await snapshot(page)).webgl).toEqual({ antialias: false, powerPreference: "low-power" });
});

test("a context-level option changed on a mounted chart waits for the next chart", async ({ page }) => {
  await open(page);
  const before = await snapshot(page);
  await setDisplayOptions(page, { antialias: false, powerPreference: "low-power" });
  await settle(page);
  const after = await snapshot(page);
  expect(after.webgl).toEqual(before.webgl);
  expect(after.bitmaps).toEqual(before.bitmaps);
});

test("switching a mounted chart to compact lays it out again without moving its zoom", async ({ page }) => {
  await open(page);
  const before = await snapshot(page);

  await setDisplayOptions(page, { density: "compact", defaultFitColumns: 100 });
  await expect.poll(async () => (await snapshot(page)).layout.timeAxisHeight).toBe(32);
  const compact = await snapshot(page);
  expect(compact.layout.density).toBe("compact");
  expect(compact.defaultFitColumns).toBe(100);
  expect(compact.area.height).toBeCloseTo(before.area.height - 10, 3);
  expect(compact.area.width).toBeCloseTo(before.area.width, 3);
  expect(compact.colWidth).toBeCloseTo(before.colWidth, 6);

  await setDisplayOptions(page, {});
  await expect.poll(async () => (await snapshot(page)).layout.timeAxisHeight).toBe(22);
  const back = await snapshot(page);
  expect(back.layout).toEqual(before.layout);
  expect(back.defaultFitColumns).toBe(250);
  expect(back.area.height).toBeCloseTo(before.area.height, 3);
});

test("the live price label carries its caption on a regular chart and sits in the gutter, without it, on a compact one", async ({ page }) => {
  await recordText(page);
  await open(page);
  expect((await textDraws(page)).filter((draw) => draw.surface === "annotation" && draw.text.startsWith("Price ")).length).toBeGreaterThan(0);

  await clearText(page);
  await setDisplayOptions(page, { density: "compact" });
  await expect.poll(async () => (await snapshot(page)).layout.density).toBe("compact");
  await settle(page);
  const compact = await textDraws(page);
  expect(compact.filter((draw) => draw.surface === "annotation" && draw.text.startsWith("Price ")).length).toBe(0);
  // The last drawn live price text, which is the close of the final bar, still reads in full.
  expect(compact.some((draw) => draw.surface === "annotation" && /^\d{5}(\.\d+)?$/.test(draw.text))).toBe(true);
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test("the bar readout wraps into rows that stay left of the corner button and inside the plot", async ({ page }) => {
    await recordText(page);
    await open(page, "&density=compact&fit=70");
    const { area } = await snapshot(page);
    await clearText(page);
    // A changed answer forces a full layout and repaint, so the readout is drawn again on a clean log.
    await setDisplayOptions(page, { density: "compact", defaultFitColumns: 71 });
    await settle(page);

    const hud = (await textDraws(page)).filter((draw) => draw.surface === "interaction" && draw.x < area.width && draw.y < 60);
    expect(hud.length).toBeGreaterThanOrEqual(5);
    const rows = [...new Set(hud.map((draw) => draw.y))].sort((a, b) => a - b);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows[0]).toBe(8);
    const buttonLeft = area.width - 36 - 8;
    for (const draw of hud) {
      expect(draw.x + draw.width, `"${draw.text}" must end left of the corner button`).toBeLessThanOrEqual(buttonLeft);
    }
    const names = new Set(hud.map((draw) => draw.text.replace("◆ ", "").split(" ")[0]));
    for (const name of ["O", "H", "L", "C"]) expect(names.has(name)).toBe(true);
  });

  test("the compact chart keeps a thumb-sized time strip and the touch controls", async ({ page }) => {
    await open(page, "&density=compact&fit=70");
    const s = await snapshot(page);
    expect(s.layout.timeAxisHeight).toBe(32);
    expect(s.pixelRatio).toBe(2);
    expect(s.colWidth).toBeCloseTo(s.area.width / (70 + 2 - 1), 3);
    // At fit=70 a candle column on a 390px phone is several pixels wide, not the 1-2px of the 250 fit.
    expect(s.colWidth).toBeGreaterThan(4);
  });
});
