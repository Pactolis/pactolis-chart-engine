import { expect, test } from "@playwright/test";

import { installHistory, openHarness } from "./support/history.js";

test("SCENARIO-486-01/02: Ctrl/Cmd uses strong OHLC magnet only during active drawing", async ({ page }) => {
  await installHistory(page);
  await openHarness(page);

  const probe = await page.evaluate(async () => {
    const { ChartInputController, snapPriceToOhlc } = await import("/src/features/chart/ChartInputController.ts");
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

    const ohlc = [100, 110, 90, 104];
    const yOfPrice = (price: number) => 200 - price;
    const rawPriceAt = (y: number) => 200 - y;
    const temporaryModes: boolean[] = [];
    const points: Array<{ price: number }> = [];
    let activeTool: string | null = "horizontal";
    let draft = false;
    const drawings = {
      get activeTool() { return activeTool; },
      setMarket: () => undefined,
      hasDraft: () => draft,
      isPointerDragActive: () => false,
      pointerDown: (point: { price: number }) => {
        points.push(point);
        if (draft) {
          draft = false;
          activeTool = null;
        } else if (activeTool !== null) {
          draft = true;
        }
        return true;
      },
      pointerMove: (point: { price: number }) => { points.push(point); return true; },
      pointerUp: () => true,
    };
    const host = {
      svc: { getAnalysisContext: () => ({ drawings }) },
      view: {
        area: { left: 0, top: 0, width: 350, height: 250 }, priceAxisW: 50, subPanesH: 0,
        chartLayoutOptions: { timeAxisHeight: 50 },
      },
      session: { invalidate: () => undefined },
      pipeline: { series: { length: 1 } },
      overlay: { getIndicatorAxisPaneAt: () => null },
      timeViewport: {},
      state: { market: "BTCUSDT" },
      panelId: "magnet-probe",
      applyingExternal: false,
      isReplaySelecting: () => false,
      screenToDrawingPoint: (_x: number, y: number, forceNearest = false) => {
        temporaryModes.push(forceNearest);
        const rawPrice = rawPriceAt(y);
        return {
          time: 1,
          price: snapPriceToOhlc(rawPrice, y, ohlc, yOfPrice, forceNearest),
        };
      },
    };

    const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false }, host as never);
    const dispatch = (type: string, init: PointerEventInit) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 7, clientX: 100, clientY: 80, ...init,
    }));

    // Active drawing: Ctrl and Cmd force the nearest OHLC even when 10px away.
    dispatch("pointerdown", { ctrlKey: true });
    dispatch("pointermove", { ctrlKey: true });
    dispatch("pointermove", { metaKey: true });
    dispatch("pointermove", {});
    dispatch("pointerup", {});
    dispatch("pointerdown", {});
    dispatch("pointermove", {});
    dispatch("pointerup", {});

    // A modifier without an active drawing must not enable temporary strong mode.
    activeTool = null;
    dispatch("pointerdown", { metaKey: true });
    dispatch("pointermove", { metaKey: true });
    dispatch("pointerup", {});

    controller.dispose();
    canvas.remove();
    return { temporaryModes, points };
  });

  expect(probe.temporaryModes).toEqual([true, true, true, false, false, false]);
  expect(probe.points.map(({ price }) => price)).toEqual([110, 110, 110, 120, 120, 120]);
});

test("SCENARIO-491-01/03: ownerWindow modifier feedback clears on keyup, blur, cancellation, and dispose", async ({ page }) => {
  await installHistory(page);
  await openHarness(page);

  const states = await page.evaluate(async () => {
    const { ChartInputController } = await import("/src/features/chart/ChartInputController.ts");
    const { subscribeDrawingMagnetTransient } = await import("/src/features/chart/drawingInteractionState.ts");
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const activeTool = "horizontal";
    const drawings = {
      activeTool,
      setMarket: () => undefined,
      pointerDown: () => true,
      pointerMove: () => true,
      pointerUp: () => true,
    };
    const host = {
      svc: { getAnalysisContext: () => ({ drawings }) },
      view: { area: { left: 0, top: 0, width: 350, height: 250 }, priceAxisW: 50, subPanesH: 0, chartLayoutOptions: { timeAxisHeight: 50 } },
      session: { invalidate: () => undefined }, pipeline: { series: { length: 1 } },
      overlay: { getIndicatorAxisPaneAt: () => null }, timeViewport: {},
      state: { market: "BTCUSDT" }, panelId: "transient-lifecycle", applyingExternal: false,
      isReplaySelecting: () => false, screenToDrawingPoint: () => ({ time: 1, price: 100 }),
    };
    const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false }, host as never);
    const observed: boolean[] = [];
    const unsubscribe = subscribeDrawingMagnetTransient((active) => observed.push(active));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    controller.dispose();
    unsubscribe();
    canvas.remove();
    return observed;
  });

  expect(states).toEqual([false, true, false, true, false, true, false, true, false]);
});

test("SCENARIO-491-02: transient magnet aggregates sources across chart realms", async ({ page }) => {
  await installHistory(page);
  await openHarness(page);

  const states = await page.evaluate(async () => {
    const { setDrawingMagnetTransient, subscribeDrawingMagnetTransient } =
      await import("/src/features/chart/drawingInteractionState.ts");
    const sourceA = {};
    const sourceB = {};
    const observed: boolean[] = [];
    const unsubscribe = subscribeDrawingMagnetTransient((active) => observed.push(active));
    setDrawingMagnetTransient(sourceA, true);
    setDrawingMagnetTransient(sourceB, true);
    setDrawingMagnetTransient(sourceA, false);
    setDrawingMagnetTransient(sourceB, false);
    unsubscribe();
    return observed;
  });

  expect(states).toEqual([false, true, false]);
});

test("SCENARIO-491-04: completed drawing clears transient feedback while modifier remains held", async ({ page }) => {
  await installHistory(page);
  await openHarness(page);

  const states = await page.evaluate(async () => {
    const { ChartInputController } = await import("/src/features/chart/ChartInputController.ts");
    const { subscribeDrawingMagnetTransient } = await import("/src/features/chart/drawingInteractionState.ts");
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const drawings = {
      activeTool: "horizontal" as string | null,
      setMarket: () => undefined,
      pointerDown: () => true,
      pointerMove: () => true,
      pointerUp: () => { drawings.activeTool = null; },
    };
    const host = {
      svc: { getAnalysisContext: () => ({ drawings }) },
      view: { area: { left: 0, top: 0, width: 350, height: 250 }, priceAxisW: 50, subPanesH: 0, chartLayoutOptions: { timeAxisHeight: 50 } },
      session: { invalidate: () => undefined }, pipeline: { series: { length: 1 } },
      overlay: { getIndicatorAxisPaneAt: () => null }, timeViewport: {},
      state: { market: "BTCUSDT" }, panelId: "completed-drawing", applyingExternal: false,
      isReplaySelecting: () => false, screenToDrawingPoint: () => ({ time: 1, price: 100 }),
    };
    const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false }, host as never);
    const observed: boolean[] = [];
    const unsubscribe = subscribeDrawingMagnetTransient((active) => observed.push(active));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 7, clientX: 100, clientY: 100, ctrlKey: true }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerId: 7, clientX: 100, clientY: 100, ctrlKey: true }));
    controller.dispose();
    unsubscribe();
    canvas.remove();
    return observed;
  });

  expect(states).toEqual([false, true, false]);
});
