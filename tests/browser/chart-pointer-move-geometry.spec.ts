import { expect, test } from "@playwright/test";

import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

interface PointerProbeHandle {
  rectCalls: number;
  lastCrosshair: { time: number | null; price: number | null } | null;
  resetRectCalls(): void;
  layout(): { left: number; top: number; width: number; height: number };
  expectedCrosshair(cx: number, cy: number): { time: number | null; price: number | null };
  expectedDrawingPrice(cx: number, cy: number): number;
  setHorizontalTool(active: boolean): void;
  clearSelection(): void;
  drawings(): { items: Array<{ id: string; price: number }>; selectedIds: string[] };
  yOfPrice(price: number): number;
  cleanup(): void;
}

test("crosshair hover, drawing placement and hit-testing remain accurate after CSS move and resize", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installHistory(page, { bars: buildBars(120) });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt");

  const hook = page.locator('[data-testid="chart-hook"]:not([data-ft-synthetic="1"])');
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 30_000 });
  await expect(hook).toHaveAttribute("data-series-len", "120", { timeout: 30_000 });

  const panelId = await hook.getAttribute("data-panel-id");
  if (!panelId) throw new Error("Missing chart panel id");

  const canvas = hook.locator("xpath=..").locator('canvas[data-chart-surface="interaction"]');
  const initialBox = await canvas.boundingBox();
  if (!initialBox || initialBox.width < 300 || initialBox.height < 300) {
    throw new Error("Invalid initial chart canvas geometry");
  }

  await page.evaluate(async (id) => {
    const { getChartRuntime } = await import("/harness/chart.ts");
    const runtime = getChartRuntime(id) as unknown as {
      view: {
        area: { left: number; top: number; width: number; height: number };
        yOfPrice(price: number): number;
      };
      subscribeCrosshairMove(cb: (e: { time: number | null; price: number | null }) => void): () => void;
      resolveScreenCrosshair(cx: number, cy: number): { time: number | null; price: number | null };
      screenToDrawingPoint(cx: number, cy: number): { time: number; price: number };
      svc: {
        getAnalysisContext(): {
          drawings: {
            setTool(tool: string | null): void;
            clearSelection(): void;
            listCurrent(): Array<{ id: string; points: Array<{ time: number; price: number }> }>;
            getSelectedIds(): string[];
          };
        };
      };
    };
    if (!runtime) throw new Error("Missing mounted ChartRuntime");
    const hookEl = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`);
    const interaction = hookEl?.parentElement?.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="interaction"]');
    if (!interaction) throw new Error("Missing interaction canvas");

    const probe: PointerProbeHandle = {
      rectCalls: 0,
      lastCrosshair: null,
      resetRectCalls() {
        this.rectCalls = 0;
      },
      layout() {
        return { ...runtime.view.area };
      },
      expectedCrosshair(cx: number, cy: number) {
        return runtime.resolveScreenCrosshair(cx, cy);
      },
      expectedDrawingPrice(cx: number, cy: number) {
        return runtime.screenToDrawingPoint(cx, cy).price;
      },
      setHorizontalTool(active: boolean) {
        runtime.svc.getAnalysisContext().drawings.setTool(active ? "horizontal" : null);
      },
      clearSelection() {
        runtime.svc.getAnalysisContext().drawings.clearSelection();
      },
      drawings() {
        const manager = runtime.svc.getAnalysisContext().drawings;
        return {
          items: manager.listCurrent().map((d) => ({ id: d.id, price: d.points[0]?.price ?? Number.NaN })),
          selectedIds: manager.getSelectedIds(),
        };
      },
      yOfPrice(price: number) {
        return runtime.view.yOfPrice(price);
      },
      cleanup: () => {},
    };

    const origGetBoundingClientRect = interaction.getBoundingClientRect.bind(interaction);
    interaction.getBoundingClientRect = () => {
      probe.rectCalls += 1;
      return origGetBoundingClientRect();
    };
    const unsubscribe = runtime.subscribeCrosshairMove((event) => {
      probe.lastCrosshair = { ...event };
    });
    probe.cleanup = () => {
      unsubscribe();
      interaction.getBoundingClientRect = origGetBoundingClientRect;
    };
    (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe = probe;
  }, panelId);

  try {
    const readLayout = () => page.evaluate(() => {
      const win = window as Window & { __pointerMoveProbe?: PointerProbeHandle };
      return win.__pointerMoveProbe!.layout();
    });

    // 1. Baseline hover on plot
    const area0 = await readLayout();
    const hover0X = Math.round(area0.left + area0.width * 0.45);
    const hover0Y = Math.round(area0.top + area0.height * 0.40);
    await page.evaluate(() => {
      (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.resetRectCalls();
    });
    await page.mouse.move(initialBox.x + hover0X, initialBox.y + hover0Y);
    const baseline = await page.evaluate(({ cx, cy }) => {
      const probe = (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!;
      return {
        rectCalls: probe.rectCalls,
        actual: probe.lastCrosshair,
        expected: probe.expectedCrosshair(cx, cy),
      };
    }, { cx: hover0X, cy: hover0Y });
    expect(baseline.rectCalls).toBeLessThanOrEqual(1);
    expect(baseline.actual?.time).toBe(baseline.expected.time);
    expect(baseline.actual?.price).not.toBeNull();
    expect(Math.abs((baseline.actual?.price ?? Number.NaN) - (baseline.expected.price ?? Number.NaN))).toBeLessThan(1e-3);

    // 2. Move container via CSS transform (no ResizeObserver/scroll) -> check hover + drawing placement
    await page.evaluate((id) => {
      const hookEl = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`);
      const container = hookEl?.parentElement;
      if (!container) throw new Error("Missing chart container");
      container.style.transform = "translate(140px, 80px)";
    }, panelId);
    await expect.poll(async () => {
      const box = await canvas.boundingBox();
      return box ? Math.round(box.x) : -1;
    }).toBe(Math.round(initialBox.x + 140));
    const movedBox = await canvas.boundingBox();
    if (!movedBox) throw new Error("Missing canvas box after transform move");

    const hoverMovedX = Math.round(area0.left + area0.width * 0.55);
    const hoverMovedY = Math.round(area0.top + area0.height * 0.35);
    await page.evaluate(() => {
      (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.resetRectCalls();
    });
    await page.mouse.move(movedBox.x + hoverMovedX, movedBox.y + hoverMovedY);
    const afterTransformHover = await page.evaluate(({ cx, cy }) => {
      const probe = (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!;
      return {
        rectCalls: probe.rectCalls,
        actual: probe.lastCrosshair,
        expected: probe.expectedCrosshair(cx, cy),
        stale: probe.expectedCrosshair(cx + 140, cy + 80),
      };
    }, { cx: hoverMovedX, cy: hoverMovedY });
    expect(afterTransformHover.rectCalls).toBeLessThanOrEqual(1);
    expect(afterTransformHover.actual?.time).toBe(afterTransformHover.expected.time);
    expect(Math.abs((afterTransformHover.actual?.price ?? Number.NaN) - (afterTransformHover.expected.price ?? Number.NaN))).toBeLessThan(1e-3);
    expect(Math.abs((afterTransformHover.actual?.price ?? Number.NaN) - (afterTransformHover.stale.price ?? Number.NaN))).toBeGreaterThan(1);

    // Place a horizontal line at local (drawX, drawY) while container is translated
    const drawX = Math.round(area0.left + area0.width * 0.42);
    const drawY = Math.round(area0.top + area0.height * 0.48);
    await page.evaluate(() => {
      (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.setHorizontalTool(true);
    });
    await page.mouse.click(movedBox.x + drawX, movedBox.y + drawY);
    const placed = await page.evaluate(({ cx, cy }) => {
      const probe = (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!;
      probe.setHorizontalTool(false);
      return {
        snapshot: probe.drawings(),
        expectedPrice: probe.expectedDrawingPrice(cx, cy),
        stalePrice: probe.expectedDrawingPrice(cx + 140, cy + 80),
      };
    }, { cx: drawX, cy: drawY });
    expect(placed.snapshot.items).toHaveLength(1);
    const placedDrawing = placed.snapshot.items[0];
    expect(Math.abs(placedDrawing.price - placed.expectedPrice)).toBeLessThan(1e-3);
    expect(Math.abs(placedDrawing.price - placed.stalePrice)).toBeGreaterThan(1);

    // 3. Move via marginLeft/marginTop AND resize container -> check hover + drawing hit-testing
    await page.evaluate((id) => {
      const hookEl = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`);
      const container = hookEl?.parentElement;
      if (!container) throw new Error("Missing chart container");
      container.style.transform = "none";
      container.style.inset = "auto";
      container.style.left = "0px";
      container.style.top = "0px";
      container.style.marginLeft = "90px";
      container.style.marginTop = "50px";
      container.style.width = "760px";
      container.style.height = "480px";
    }, panelId);
    await expect.poll(async () => {
      const box = await canvas.boundingBox();
      const layout = await readLayout();
      if (!box) return false;
      return Math.abs(box.x - 90) < 2
        && Math.abs(box.y - 50) < 2
        && Math.abs(box.width - 760) < 2
        && Math.abs(box.height - 480) < 2
        && layout.width > 500
        && layout.width < 760
        && layout.height > 300
        && layout.height < 480;
    }).toBe(true);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const resizedBox = await canvas.boundingBox();
    if (!resizedBox) throw new Error("Missing canvas box after move + resize");
    const areaResized = await readLayout();

    const hoverResizedX = Math.round(areaResized.left + areaResized.width * 0.40);
    const hoverResizedY = Math.round(areaResized.top + areaResized.height * 0.35);
    await page.evaluate(() => {
      (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.resetRectCalls();
    });
    await page.mouse.move(resizedBox.x + hoverResizedX, resizedBox.y + hoverResizedY);
    const afterResizeHover = await page.evaluate(({ cx, cy }) => {
      const probe = (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!;
      return {
        rectCalls: probe.rectCalls,
        actual: probe.lastCrosshair,
        expected: probe.expectedCrosshair(cx, cy),
      };
    }, { cx: hoverResizedX, cy: hoverResizedY });
    expect(afterResizeHover.rectCalls).toBeLessThanOrEqual(1);
    expect(afterResizeHover.actual?.time).toBe(afterResizeHover.expected.time);
    expect(Math.abs((afterResizeHover.actual?.price ?? Number.NaN) - (afterResizeHover.expected.price ?? Number.NaN))).toBeLessThan(1e-3);

    // Verify hit-test on placed horizontal drawing succeeds only at its resized + shifted coordinates
    const lineY = await page.evaluate(
      (price) => (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.yOfPrice(price),
      placedDrawing.price,
    );
    expect(lineY).toBeGreaterThanOrEqual(areaResized.top + 8);
    expect(lineY).toBeLessThanOrEqual(areaResized.top + areaResized.height - 8);
    const hitX = Math.round(areaResized.left + areaResized.width * 0.52);
    const missY = lineY + 45 <= areaResized.top + areaResized.height - 8 ? lineY + 45 : lineY - 45;

    await page.evaluate(() => {
      (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.clearSelection();
    });
    await page.mouse.click(resizedBox.x + hitX, resizedBox.y + missY);
    const afterMiss = await page.evaluate(
      () => (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.drawings(),
    );
    expect(afterMiss.selectedIds).toEqual([]);

    await page.mouse.click(resizedBox.x + hitX, resizedBox.y + lineY);
    const afterHit = await page.evaluate(
      () => (window as Window & { __pointerMoveProbe?: PointerProbeHandle }).__pointerMoveProbe!.drawings(),
    );
    expect(afterHit.selectedIds).toEqual([placedDrawing.id]);
  } finally {
    await page.evaluate(() => {
      const win = window as Window & { __pointerMoveProbe?: PointerProbeHandle };
      win.__pointerMoveProbe?.cleanup();
      delete win.__pointerMoveProbe;
    });
  }
});
