import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { installHistory, openHarness } from "./support/history.js";

const MARKET = "BINANCE_FUTURES:btcusdt";

// One DrawingManager serves every chart of the host. It remembers the view and the time mapping
// of the chart that drew or hit-tested last, and those reach that chart's runtime, series and
// canvases. Disposing a chart has to release them; otherwise the last chart that was closed stays
// in memory (data and WebGL context included) until another chart draws.
//
// Reachability is read through a FinalizationRegistry after a forced collection. Heap-inspection
// tools such as CDP `Runtime.queryObjects` hold on to the objects they list and would report a
// leak that is not there.
type Probe = Window & {
  __released?: string[];
  __registry?: FinalizationRegistry<string>;
  __services?: unknown;
};

async function collectUntilReleased(cdp: CDPSession, page: Page, names: string[]): Promise<string[]> {
  const deadline = Date.now() + 20_000;
  let released: string[] = [];
  while (Date.now() < deadline) {
    await cdp.send("HeapProfiler.collectGarbage");
    // Finalization callbacks run in a task after the collection that found the object dead.
    await page.waitForTimeout(100);
    released = await page.evaluate(() => (window as Probe).__released ?? []);
    if (names.every((name) => released.includes(name))) break;
  }
  return released;
}

test("disposing a chart releases it from the shared drawing manager", async ({ page }) => {
  test.setTimeout(90_000);
  await installHistory(page);
  await openHarness(page);
  const cdp = await page.context().newCDPSession(page);

  const evidence = await page.evaluate(async (market) => {
    const probe = window as Probe;
    probe.__released = [];
    probe.__registry = new FinalizationRegistry<string>((name) => { probe.__released!.push(name); });

    const [{ mountChart, createChartSurfaceModel, getChartRuntime }, { createHarnessServices }] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
    ]);
    // Like the application's analysis service, the services (and with them the manager) outlive every chart.
    const services = createHarnessServices();
    probe.__services = services;
    const drawings = services.drawings as unknown as { lastView: unknown; lastTime: unknown };

    const waitFor = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${description}`);
    };

    const root = document.createElement("div");
    root.style.cssText = "position:fixed;left:8px;top:16px;width:640px;height:360px;overflow:hidden;";
    document.body.appendChild(root);
    const panelId = `dispose-drawing-context-${Date.now()}`;
    const handle = mountChart(root, {
      type: "chart",
      market,
      timeframe: "15m",
      scaleMode: "linear",
      chartType: "footprint",
      candles: true,
    } as never, services as never, panelId, createChartSurfaceModel());

    // The first drawn frame hands the manager its view and time mapping.
    await waitFor(() => Boolean(getChartRuntime(panelId)) && drawings.lastView !== null, "the chart to draw");
    const runtime = getChartRuntime(panelId) as unknown as { pipeline: { series: object } };
    probe.__registry.register(runtime, "runtime");
    probe.__registry.register(runtime.pipeline.series, "series");
    const heldWhileMounted = drawings.lastView !== null && drawings.lastTime !== null;

    handle.dispose();
    root.remove();
    await waitFor(() => !getChartRuntime(panelId), "the runtime registry teardown");
    return {
      heldWhileMounted,
      viewKept: drawings.lastView !== null,
      timeKept: drawings.lastTime !== null,
    };
  }, MARKET);

  expect(evidence.heldWhileMounted).toBe(true);
  expect(evidence.viewKept).toBe(false);
  expect(evidence.timeKept).toBe(false);

  const released = await collectUntilReleased(cdp, page, ["runtime", "series"]);
  expect(released).toContain("runtime");
  expect(released).toContain("series");
});

test("disposing a chart keeps the drawing context of a chart that is still open", async ({ page }) => {
  test.setTimeout(60_000);
  await installHistory(page);
  await openHarness(page);

  const evidence = await page.evaluate(async (market) => {
    const [{ mountChart, createChartSurfaceModel, getChartRuntime }, { createHarnessServices }] = await Promise.all([
      import("/harness/chart.ts"),
      import("/harness/services.ts"),
    ]);
    const services = createHarnessServices();
    const drawings = services.drawings as unknown as { lastView: unknown; setHitTestContext(view: unknown, time: unknown): void };

    const waitFor = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${description}`);
    };
    const mount = (name: string, left: number) => {
      const root = document.createElement("div");
      root.style.cssText = `position:fixed;left:${left}px;top:16px;width:320px;height:360px;overflow:hidden;`;
      document.body.appendChild(root);
      const panelId = `dispose-drawing-context-${name}-${Date.now()}`;
      const handle = mountChart(root, {
        type: "chart",
        market,
        timeframe: "15m",
        scaleMode: "linear",
        chartType: "footprint",
        candles: true,
      } as never, services as never, panelId, createChartSurfaceModel());
      return { root, panelId, handle };
    };

    const first = mount("first", 8);
    const second = mount("second", 340);
    await waitFor(() => Boolean(getChartRuntime(first.panelId)) && Boolean(getChartRuntime(second.panelId)) && drawings.lastView !== null, "both charts to draw");
    const secondView = (getChartRuntime(second.panelId) as unknown as { view: unknown }).view;

    try {
      // The second chart holds the context, as after its latest frame or a double-click on it. Both
      // calls run in one task, so no frame of the first chart can take the context back in between.
      drawings.setHitTestContext(secondView, { indexForTime: (time: number) => time, timeForIndex: (index: number) => index });
      first.handle.dispose();
      const keptAfterFirst = drawings.lastView === secondView;
      second.handle.dispose();
      return { keptAfterFirst, keptAfterSecond: drawings.lastView !== null };
    } finally {
      first.root.remove();
      second.root.remove();
    }
  }, MARKET);

  expect(evidence.keptAfterFirst).toBe(true);
  expect(evidence.keptAfterSecond).toBe(false);
});
