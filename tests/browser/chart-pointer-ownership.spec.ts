import { expect, test } from "@playwright/test";

import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test("a second pointer neither takes over nor ends the pointer gesture in progress", async ({ page }) => {
  await installHistory(page);
  await openHarness(page);

  const probe = await page.evaluate(async () => {
    const { ChartInputController } = await import("/src/features/chart/ChartInputController.ts");
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    Object.defineProperties(canvas, {
      setPointerCapture: { value: () => undefined },
      releasePointerCapture: { value: () => undefined },
      hasPointerCapture: { value: () => false },
    });
    canvas.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300,
      toJSON: () => ({}),
    });

    const log: string[] = [];
    const drawings = {
      activeTool: null,
      setMarket: () => undefined,
      hasDraft: () => false,
      isPointerDragActive: () => false,
      pointerDown: () => false,
      pointerMove: () => true,
      pointerUp: () => true,
    };
    const host = {
      svc: { getAnalysisContext: () => ({ drawings }) },
      view: {
        area: { left: 0, top: 0, width: 350, height: 250 }, priceAxisW: 50, subPanesH: 0,
        chartLayoutOptions: { timeAxisHeight: 50 },
        priceTop: 0, pricePerPx: 1,
        isPriceAutoScale: () => true,
        indexOfX: () => 0,
        priceOfY: () => 100,
      },
      session: { invalidate: () => undefined },
      pipeline: { series: { length: 10 } },
      overlay: {
        // The right half of the plot stands in for an indicator pane's price axis.
        getIndicatorAxisPaneAt: (x: number) => (x > 200 && x < 340 ? "rsi" : null),
        getIndicatorScaleControlAt: () => null,
        getPriceScaleControlAt: () => null,
      },
      timeViewport: {
        beginPlotPan: () => log.push("begin"),
        dragPlotPanTo: (dx: number) => log.push(`drag ${dx}`),
        endPlotPan: () => log.push("end"),
      },
      state: { market: "BTCUSDT" },
      panelId: "pointer-ownership",
      applyingExternal: false,
      isReplaySelecting: () => false,
      screenToDrawingPoint: () => ({ time: 1, price: 100 }),
      indexToTime: () => 1,
      // Stands in for the runtime-owned raw cursor seam; mirrors time 1 / price 100 above.
      resolveScreenCrosshair: () => ({ time: 1, price: 100 }),
      notifyCrosshair: () => undefined,
      autoFit: () => undefined,
      emitVisibleRange: () => undefined,
      scaleIndicatorPane: (paneId: string) => { log.push(`scale ${paneId}`); return true; },
    };

    const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false }, host as never);
    const dispatch = (type: string, pointerId: number, clientX: number, clientY = 100) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId, clientX, clientY }));

    // Plot pan with finger 1; finger 2 lands and lifts in the middle of it.
    dispatch("pointerdown", 1, 100);
    dispatch("pointerdown", 2, 150);
    dispatch("pointermove", 2, 180);
    dispatch("pointerup", 2, 180);
    dispatch("pointermove", 1, 120);
    dispatch("pointerup", 1, 120);
    const pan = [...log];
    log.length = 0;

    // Dragging an indicator pane's axis scales that pane.
    dispatch("pointerdown", 3, 250, 100);
    dispatch("pointermove", 3, 250, 130);
    dispatch("pointerup", 3, 250, 130);
    const indicator = [...log];

    controller.dispose();
    canvas.remove();
    return { pan, indicator };
  });

  expect(probe.pan).toEqual(["begin", "drag 20", "end"]);
  expect(probe.indicator).toEqual(["scale rsi"]);
});

test("a price-axis drag interrupted by a wheel step is not read as a click on release", async ({ page }) => {
  await installHistory(page);
  await openHarness(page);

  const probe = await page.evaluate(async () => {
    const { ChartInputController } = await import("/src/features/chart/ChartInputController.ts");
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    Object.defineProperties(canvas, {
      setPointerCapture: { value: () => undefined },
      releasePointerCapture: { value: () => undefined },
      hasPointerCapture: { value: () => false },
    });
    canvas.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300,
      toJSON: () => ({}),
    });

    const log: string[] = [];
    const drawings = {
      activeTool: null,
      setMarket: () => undefined,
      hasDraft: () => false,
      isPointerDragActive: () => false,
      pointerDown: () => false,
      pointerMove: () => true,
      pointerUp: () => true,
    };
    let autoScale = false;
    const host = {
      svc: { getAnalysisContext: () => ({ drawings }) },
      view: {
        area: { left: 0, top: 0, width: 350, height: 250 }, priceAxisW: 50, subPanesH: 0,
        chartLayoutOptions: { timeAxisHeight: 50 },
        priceTop: 0, pricePerPx: 1,
        isPriceAutoScale: () => autoScale,
        setPriceAutoScale: (next: boolean) => { autoScale = next; },
        indexOfX: () => 0,
        priceOfY: () => 100,
        startPriceAxisScale: (y: number) => log.push(`start ${y}`),
        scalePriceAxisTo: (y: number) => log.push(`scale ${y}`),
        endPriceAxisScale: () => log.push("end"),
        zoomY: () => log.push("zoomY"),
      },
      session: { invalidate: () => undefined },
      pipeline: { series: { length: 10 } },
      overlay: {
        getIndicatorAxisPaneAt: () => null,
        getIndicatorScaleControlAt: () => null,
        // The bottom of the price axis stands in for the auto-scale button.
        getPriceScaleControlAt: (x: number, y: number) => (x > 350 && y > 200 ? "autoScale" : null),
      },
      timeViewport: {},
      state: { market: "BTCUSDT" },
      panelId: "pointer-ownership-wheel",
      applyingExternal: false,
      isReplaySelecting: () => false,
      screenToDrawingPoint: () => ({ time: 1, price: 100 }),
      indexToTime: () => 1,
      resolveScreenCrosshair: () => ({ time: 1, price: 100 }),
      notifyCrosshair: () => undefined,
      autoFit: () => undefined,
      emitVisibleRange: () => undefined,
      setPriceAutoScaleFromControl: (next: boolean) => log.push(`autoScale ${next}`),
    };

    const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false }, host as never);
    const pointer = (type: string, clientY: number) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: 375, clientY }));
    const wheel = (clientY: number) =>
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 375, clientY, deltaY: -100 }));

    // Drag the price axis down onto the auto-scale button, wheel there, release without moving.
    pointer("pointerdown", 100);
    pointer("pointermove", 220);
    wheel(220);
    pointer("pointerup", 220);
    const dragThenWheel = [...log];
    log.length = 0;

    // Press on the button, wheel without moving, release: still not a click.
    pointer("pointerdown", 220);
    wheel(220);
    pointer("pointerup", 220);
    const pressThenWheel = [...log];
    log.length = 0;

    // A plain press and release on the button is still a click.
    pointer("pointerdown", 220);
    pointer("pointerup", 220);
    const click = [...log];

    controller.dispose();
    canvas.remove();
    return { dragThenWheel, pressThenWheel, click };
  });

  expect(probe.dragThenWheel).toEqual(["start 100", "scale 220", "zoomY", "end", "start 220", "end"]);
  expect(probe.pressThenWheel).toEqual(["start 220", "zoomY", "end", "start 220", "end"]);
  expect(probe.click).toEqual(["start 220", "end", "autoScale true"]);
});

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

test.describe("real runtime pointer geometry after container move and resize", () => {
  test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

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
});
