import { expect, test } from "@playwright/test";
import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

test("TPO keeps its full candles when zoom crosses the footprint LOD boundary", async ({ page }) => {
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
  });
  await installHistory(page, { bars: buildBars(400) });
  for (const type of ["tpo", "candlestick", "footprint", "footprintProfile"]) {
    await openHarness(page, `?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&type=${type}`);
    const hook = page.getByTestId("chart-hook");
    await expect(hook).toHaveAttribute("data-series-len", "400");
    await expect(hook).toHaveAttribute("data-history-loading", "false");

    const samples = await page.evaluate(async () => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const { FootprintRenderer } = await import("/src/core/render/footprintRenderer.ts");
      const runtime = getChartRuntime("harness-chart");
      if (!runtime) throw new Error("Chart runtime unavailable");
      const proto = FootprintRenderer.prototype as unknown as Record<string, (...args: unknown[]) => void>;
      const methods = {
        full: "drawFullCandle", strip: "drawCandle", cells: "drawFootprintCells", profile: "drawProfile",
      } as const;
      const originals = new Map<string, (...args: unknown[]) => void>();
      let counts = { full: 0, strip: 0, cells: 0, profile: 0 };
      for (const kind of Object.keys(methods) as (keyof typeof methods)[]) {
        const method = methods[kind];
        const original = proto[method];
        originals.set(method, original);
        proto[method] = function (...args) {
          counts[kind]++;
          return original.apply(this, args);
        };
      }

      try {
        const observations = [];
        for (const width of [5.9, 6, 8, 15]) {
          counts = { full: 0, strip: 0, cells: 0, profile: 0 };
          runtime.view.colWidth = width;
          runtime.view.offsetX = runtime.view.area.width - 400 * width;
          runtime.session.invalidate();
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          observations.push({ width, actualWidth: runtime.view.colWidth, ...counts });
        }
        return observations;
      } finally {
        for (const [method, original] of originals) proto[method] = original;
      }
    });

    for (const { width, actualWidth, full, strip, cells, profile } of samples) {
      const context = `${type} at ${width}px`;
      const footprintLod = width >= 6;
      const strips = footprintLod && (type === "footprint" || type === "footprintProfile");
      expect(actualWidth, context).toBe(width);
      expect(full > 0, `${context} full candles`).toBe(!strips);
      expect(strip > 0, `${context} strip candles`).toBe(strips);
      expect(cells > 0, `${context} footprint cells`).toBe(footprintLod && type === "footprint");
      expect(profile > 0, `${context} footprint profile`).toBe(footprintLod && type === "footprintProfile");
    }
  }
});
