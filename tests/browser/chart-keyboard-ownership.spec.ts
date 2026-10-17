import { expect, test } from "@playwright/test";

import { installHistory, openHarness } from "./support/history.js";

test("window shortcuts run once, in the chart the key came from or else the active chart", async ({ page }) => {
  await installHistory(page);
  await openHarness(page);

  const probe = await page.evaluate(async () => {
    const { ChartInputController } = await import("/src/features/chart/ChartInputController.ts");

    const log: string[] = [];
    // One drawing store shared by every chart, as AnalysisService provides it.
    const drawings = {
      activeTool: null,
      undo: () => log.push("undo"),
    };
    let activeChartId: string | undefined = "a";

    const mount = (panelId: string) => {
      const root = document.createElement("div");
      const canvas = document.createElement("canvas");
      canvas.className = "chart-interaction-canvas";
      canvas.tabIndex = 0;
      root.appendChild(canvas);
      document.body.appendChild(root);
      const host = {
        svc: {
          getAnalysisContext: () => ({ drawings }),
          getKeyboardTargetChartId: () => activeChartId,
        },
        session: { invalidate: () => undefined },
        panelId,
        resetTimeScale: () => log.push(`reset ${panelId}`),
      };
      const controller = new ChartInputController(canvas, { x: 0, y: 0, visible: false }, host as never);
      return { root, canvas, controller };
    };

    const a = mount("a");
    const b = mount("b");
    const press = (target: EventTarget, key: string, ctrlKey = false) => {
      log.length = 0;
      target.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }));
      return [...log].sort();
    };

    const fromBody = press(document.body, "z", true);
    const fromB = press(b.canvas, "z", true);
    const resetFromBody = press(document.body, "x");
    activeChartId = "b";
    const resetAfterSwitch = press(document.body, "x");

    a.controller.dispose();
    b.controller.dispose();
    a.root.remove();
    b.root.remove();
    return { fromBody, fromB, resetFromBody, resetAfterSwitch };
  });

  expect(probe.fromBody).toEqual(["undo"]);
  expect(probe.fromB).toEqual(["undo"]);
  expect(probe.resetFromBody).toEqual(["reset a"]);
  expect(probe.resetAfterSwitch).toEqual(["reset b"]);
});
