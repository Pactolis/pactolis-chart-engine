import { expect, test } from "@playwright/test";

import { installHistory, openHarness } from "./support/history.js";

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
