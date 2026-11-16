import { expect, test } from "@playwright/test";

import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

type HarnessModule = {
  harnessChart?: {
    panelId: string;
    root: HTMLElement;
    handle: {
      dispose(): void;
      updateState(next: Record<string, unknown>): void;
    };
    services: unknown;
  };
  getChartRuntime(panelId: string): {
    getState(): Record<string, unknown>;
    applyExternalMarket(market: string): void;
    applyExternalTimeframe(timeframe: string): void;
    setLinkGroup(color: string | null): void;
    refreshHostLifecycle(): void;
  } | undefined;
  mountChart(
    root: HTMLElement,
    state: Record<string, unknown>,
    services: unknown,
    panelId: string,
  ): {
    dispose(): void;
    updateState(next: Record<string, unknown>): void;
  };
};

test("interactionCanvas syncs aria-label across state/lifecycle flows and shows host-tokenized :focus-visible outline only on keyboard focus", async ({ page }) => {
  await installHistory(page, { bars: buildBars(60) });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m");

  const hook = page.locator('[data-testid="chart-hook"]');
  await expect(hook).toHaveCount(1);
  await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 30_000 });
  await expect(hook).toHaveAttribute("data-series-len", "60", { timeout: 30_000 });

  const canvas = page.locator('canvas.chart-interaction-canvas[data-chart-surface="interaction"]');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute("role", "application");
  await expect(canvas).toHaveAttribute("tabindex", "0");
  await expect(canvas).toHaveAttribute("aria-label", "BINANCE_FUTURES:btcusdt 15m");

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  // 1. Mouse click focuses canvas without activating :focus-visible outline.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const afterMouseClick = await canvas.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      isActive: document.activeElement === el,
      focus: el.matches(":focus"),
      focusVisible: el.matches(":focus-visible"),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
    };
  });
  expect(afterMouseClick.isActive).toBe(true);
  expect(afterMouseClick.focus).toBe(true);
  expect(afterMouseClick.focusVisible).toBe(false);
  expect(afterMouseClick.outlineStyle).toBe("none");
  expect(afterMouseClick.outlineWidth).toBe("0px");

  // 2. Keyboard Tab navigation activates :focus-visible outline using host CSS token / fallback.
  await page.evaluate(() => {
    const prevBtn = document.createElement("button");
    prevBtn.id = "a11y-prev-focus-sentinel";
    prevBtn.textContent = "previous";
    prevBtn.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;z-index:999999;";
    document.body.prepend(prevBtn);
    prevBtn.focus();
  });
  await page.keyboard.press("Tab");

  const afterKeyboardTab = await canvas.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      isActive: document.activeElement === el,
      focusVisible: el.matches(":focus-visible"),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineOffset: cs.outlineOffset,
      outlineColor: cs.outlineColor,
    };
  });
  expect(afterKeyboardTab.isActive).toBe(true);
  expect(afterKeyboardTab.focusVisible).toBe(true);
  expect(afterKeyboardTab.outlineStyle).toBe("solid");
  expect(afterKeyboardTab.outlineWidth).toBe("2px");
  expect(afterKeyboardTab.outlineOffset).toBe("-2px");
  expect(afterKeyboardTab.outlineColor).toBe("rgb(56, 189, 248)");

  // Verify host CSS theme variables (--ui-color-info / --ui-focus-ring-color) take precedence when set.
  const tokenColors = await canvas.evaluate((el) => {
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ui-color-info", "rgb(125, 211, 252)");
    const infoOutline = getComputedStyle(el).outlineColor;
    rootStyle.setProperty("--ui-focus-ring-color", "rgb(230, 200, 79)");
    const ringOutline = getComputedStyle(el).outlineColor;
    rootStyle.removeProperty("--ui-focus-ring-color");
    rootStyle.removeProperty("--ui-color-info");
    document.getElementById("a11y-prev-focus-sentinel")?.remove();
    return { infoOutline, ringOutline };
  });
  expect(tokenColors.infoOutline).toBe("rgb(125, 211, 252)");
  expect(tokenColors.ringOutline).toBe("rgb(230, 200, 79)");

  // 3. State changes via updateState, syncController external transitions, persistState & refreshHostLifecycle sync aria-label.
  await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts") as unknown as HarnessModule;
    const rt = harness.getChartRuntime("harness-chart")!;
    harness.harnessChart!.handle.updateState({ ...rt.getState(), market: "BINANCE_FUTURES:ethusdt" });
  });
  await expect(canvas).toHaveAttribute("aria-label", "BINANCE_FUTURES:ethusdt 15m");

  await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts") as unknown as HarnessModule;
    const rt = harness.getChartRuntime("harness-chart")!;
    rt.applyExternalTimeframe("1h");
  });
  await expect(canvas).toHaveAttribute("aria-label", "BINANCE_FUTURES:ethusdt 1h");

  await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts") as unknown as HarnessModule;
    const rt = harness.getChartRuntime("harness-chart")!;
    rt.applyExternalMarket("BINANCE_FUTURES:solusdt");
  });
  await expect(canvas).toHaveAttribute("aria-label", "BINANCE_FUTURES:solusdt 1h");

  await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts") as unknown as HarnessModule;
    const rt = harness.getChartRuntime("harness-chart")!;
    rt.setLinkGroup("blue");
    rt.refreshHostLifecycle();
  });
  await expect(canvas).toHaveAttribute("aria-label", "BINANCE_FUTURES:solusdt 1h");

  // 4. Multi-chart style idempotency, remount label accuracy, and refcounted cleanup on dispose.
  const lifecycleCounts = await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts") as unknown as HarnessModule;
    const secondRoot = document.createElement("div");
    secondRoot.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px;";
    document.body.appendChild(secondRoot);

    const handle2 = harness.mountChart(
      secondRoot,
      { type: "chart", market: "BINANCE_FUTURES:avaxusdt", timeframe: "4h", scaleMode: "linear", chartType: "footprint", candles: true },
      harness.harnessChart!.services,
      "secondary-a11y-chart",
    );

    const waitSecondCanvas = () => new Promise<HTMLCanvasElement>((resolve) => {
      const check = () => {
        const c = secondRoot.querySelector<HTMLCanvasElement>('canvas.chart-interaction-canvas[data-chart-surface="interaction"]');
        if (c && harness.getChartRuntime("secondary-a11y-chart")) resolve(c);
        else requestAnimationFrame(check);
      };
      check();
    });
    const secondCanvas = await waitSecondCanvas();
    const secondLabel = secondCanvas.getAttribute("aria-label");
    const stylesDuringTwoCharts = document.querySelectorAll("#pactolis-chart-interaction-canvas-style").length;

    handle2.dispose();
    secondRoot.remove();
    const stylesAfterFirstDispose = document.querySelectorAll("#pactolis-chart-interaction-canvas-style").length;

    harness.harnessChart!.handle.dispose();
    const stylesAfterAllDisposed = document.querySelectorAll("#pactolis-chart-interaction-canvas-style").length;
    return { secondLabel, stylesDuringTwoCharts, stylesAfterFirstDispose, stylesAfterAllDisposed };
  });

  expect(lifecycleCounts.secondLabel).toBe("BINANCE_FUTURES:avaxusdt 4h");
  expect(lifecycleCounts.stylesDuringTwoCharts).toBe(1);
  expect(lifecycleCounts.stylesAfterFirstDispose).toBe(1);
  expect(lifecycleCounts.stylesAfterAllDisposed).toBe(0);
});
