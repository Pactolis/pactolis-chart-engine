import { expect, test } from "@playwright/test";
import { FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

const WEEK_MS = 7 * 24 * 60 * 60_000;
const JAN_12_2026_UTC = Date.UTC(2026, 0, 12, 0, 0, 0);

function buildWeeklyJan12Bars() {
  return Array.from({ length: 80 }, (_, i) => {
    const t = JAN_12_2026_UTC - (75 - i) * WEEK_MS;
    const isTarget = t === JAN_12_2026_UTC;
    return {
      t,
      o: isTarget ? 91_200 : 88_000,
      h: isTarget ? 97_932 : 98_500,
      l: isTarget ? 90_066 : 86_000,
      c: isTarget ? 95_400 : 92_000,
      v: 1000,
      d: 50,
      n: 120,
      cells: [
        [93_500, 120, 80, 0, 0],
        [94_000, 180, 95, 0, 0],
        [94_500, 140, 110, 0, 0],
      ],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: JAN_12_2026_UTC + WEEK_MS,
    };
  });
}

test("#283 Footprint dual-axis wheel zooms X+Y anchored on Jan 12 1W candle without leaving plot", async ({ page }, testInfo) => {
  testInfo.setTimeout(90_000);
  await page.setViewportSize({ width: 1400, height: 860 });
  const bars = buildWeeklyJan12Bars();
  await installHistory(page, { bars, intervalMs: WEEK_MS, priceStep: 50 });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=1w");

  const hook = page.locator('[data-testid="chart-hook"]:not([data-ft-synthetic="1"])');
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-series-len", "80", { timeout: 30_000 });
  const id = await hook.getAttribute("data-panel-id");
  if (!id) throw new Error("NOTRUN: missing panel ID");

  const canvas = hook.locator("xpath=..").locator('canvas[data-chart-surface="interaction"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error("NOTRUN: missing canvas box");

  const probe = await page.evaluate(async (panelId) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(panelId)!;
    const idx = 75; // Jan 12, 2026 bar
    const anchorLocalX = r.view.xOfIndex(idx) + r.view.colWidth * 0.5;
    const anchorLocalY = r.view.yOfPrice(94_000);
    return {
      anchorLocalX,
      anchorLocalY,
      colWidth: r.view.colWidth,
      pricePerPx: r.view.pricePerPx,
      indexAtAnchor: r.view.indexOfX(anchorLocalX),
      priceAtAnchor: r.view.priceOfY(anchorLocalY),
    };
  }, id);

  await page.mouse.move(box.x + probe.anchorLocalX, box.y + probe.anchorLocalY);
  for (let i = 0; i < 18; i++) {
    await page.mouse.wheel(0, -120);
  }

  await expect.poll(async () => page.evaluate(async (panelId) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(panelId)!;
    return 50 / r.view.pricePerPx >= 9 && r.view.colWidth >= 72;
  }, id)).toBe(true);

  const afterZoom = await page.evaluate(async ({ panelId, anchorLocalX, anchorLocalY }) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const { cellTextModeFor } = await import("/src/core/render/chartLod.ts");
    const r = getChartRuntime(panelId)!;
    const cellHeight = 50 / r.view.pricePerPx;
    return {
      colWidth: r.view.colWidth,
      pricePerPx: r.view.pricePerPx,
      cellHeight,
      textMode: cellTextModeFor(cellHeight, r.view.colWidth),
      indexAtAnchor: r.view.indexOfX(anchorLocalX),
      priceAtAnchor: r.view.priceOfY(anchorLocalY),
      autoScale: r.isPriceAutoScale(),
    };
  }, { panelId: id, anchorLocalX: probe.anchorLocalX, anchorLocalY: probe.anchorLocalY });

  expect(afterZoom.textMode).toBe("full");
  expect(afterZoom.autoScale).toBe(false);
  expect(Math.abs(afterZoom.indexAtAnchor - probe.indexAtAnchor)).toBeLessThan(0.05);
  expect(Math.abs(afterZoom.priceAtAnchor - probe.priceAtAnchor)).toBeLessThan(25);

  // goLatest preserves manual Y scale; resetPriceScale restores auto-scale
  const afterGoLatest = await page.evaluate(async (panelId) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const r = getChartRuntime(panelId)!;
    r.goLatest();
    const manualPricePerPx = r.view.pricePerPx;
    const manualAutoScale = r.isPriceAutoScale();
    r.view.resetPriceScale();
    r.refreshAutoScale();
    return {
      manualPricePerPx,
      manualAutoScale,
      resetAutoScale: r.isPriceAutoScale(),
      resetPricePerPx: r.view.pricePerPx,
    };
  }, id);

  expect(afterGoLatest.manualAutoScale).toBe(false);
  expect(afterGoLatest.manualPricePerPx).toBeCloseTo(afterZoom.pricePerPx, 6);
  expect(afterGoLatest.resetAutoScale).toBe(true);
  expect(afterGoLatest.resetPricePerPx).toBeGreaterThan(afterZoom.pricePerPx);

  // Horizontal preference keeps Y scale fixed on wheel
  const horizCheck = await page.evaluate(async (panelId) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const { settings } = await import("/src/core/settings.ts");
    settings.footprintWheelZoomMode = "horizontal";
    const r = getChartRuntime(panelId)!;
    return r.view.pricePerPx;
  }, id);
  await page.mouse.wheel(0, -240);
  const horizAfter = await page.evaluate(async (panelId) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const { settings } = await import("/src/core/settings.ts");
    settings.footprintWheelZoomMode = "dual";
    return getChartRuntime(panelId)!.view.pricePerPx;
  }, id);
  expect(horizAfter).toBeCloseTo(horizCheck, 6);
});
