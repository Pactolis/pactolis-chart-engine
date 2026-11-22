import { expect, test } from "@playwright/test";
import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

test("WebGPU onLost fallback updates hook, diagnostics and preserves host context options", async ({ page }) => {
  await installHistory(page, { bars: buildBars(100) });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&antialias=0&power=low-power");
  await expect(page.locator('[data-testid="chart-hook"]')).toHaveAttribute("data-history-loading", "false");
  const result = await page.evaluate(async () => {
    const harness = await import("/harness/chart.ts");
    const { WebGl2Surface } = await import("/src/core/gpu/webgl2/webgl2Surface.ts");
    const { getGpuDiagnostics, recordGpuBackendSelection } = await import("/src/core/gpu/gpuDiagnostics.ts");
    const runtime = harness.listChartRuntimes()[0];
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2")!;
    const source = new WebGl2Surface(canvas, gl);
    // Deterministic device-loss injection: drive the actual WebGPU onLost handler
    // with a surface that uses the browser's real WebGL for the replacement test.
    let lose!: (reason: string) => void;
    Object.defineProperty(source, "kind", { value: "webgpu" });
    Object.assign(source, { onLost: (cb: (reason: string) => void) => { lose = cb; return () => {}; } });
    recordGpuBackendSelection("webgpu", "webgpu");
    runtime.session.replaceSurface(source);
    lose("device-lost");
    const surface = runtime.session.getSurface();
    const attributes = (surface.canvas.getContext("webgl2") as WebGL2RenderingContext).getContextAttributes();
    return { kind: surface.kind, active: getGpuDiagnostics().active, fallbacks: getGpuDiagnostics().fallbacks,
      attributes, losses: getGpuDiagnostics().counters["chart.gpu.contextLost"] };
  });
  expect(result.kind).toBe("webgl2");
  expect(result.active).toBe("webgl2");
  expect(result.fallbacks).toContainEqual(expect.objectContaining({ from: "webgpu", to: "webgl2", reason: "device-lost" }));
  expect(result.attributes?.antialias).toBe(false);
  expect(result.attributes?.powerPreference).toBe("low-power");
  expect(result.losses).toBe(1);
  await expect(page.locator('[data-testid="chart-hook"]')).toHaveAttribute("data-gpu-backend", "webgl2");
});

test("Canvas2D scene and overlay contextlost/contextrestored recover in mounted ChartRuntime", async ({ page }) => {
  await installHistory(page, { bars: buildBars(60) });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&gpu=canvas2d");
  await expect(page.locator('[data-testid="chart-hook"]')).toHaveAttribute("data-history-loading", "false");
  await expect(page.locator('[data-testid="chart-hook"]')).toHaveAttribute("data-gpu-backend", "canvas2d");

  const result = await page.evaluate(async () => {
    const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
    const harness = await import("/harness/chart.ts");
    const runtime = harness.listChartRuntimes()[0];
    const gpuCanvas = document.querySelector('canvas[data-chart-surface="gpu-scene"]') as HTMLCanvasElement;
    const annotationCanvas = document.querySelector('canvas[data-chart-surface="annotation"]') as HTMLCanvasElement;
    const interactionCanvas = document.querySelector('canvas[data-chart-surface="interaction"]') as HTMLCanvasElement;

    gpuCanvas.dispatchEvent(new Event("contextlost", { cancelable: true }));
    let sceneBlockedWhileLost = false;
    try {
      await runtime.session.captureCompositePng();
    } catch {
      sceneBlockedWhileLost = true;
    }
    gpuCanvas.dispatchEvent(new Event("contextrestored"));

    annotationCanvas.dispatchEvent(new Event("contextlost", { cancelable: true }));
    let annotationBlockedWhileLost = false;
    try {
      await runtime.session.captureCompositePng();
    } catch {
      annotationBlockedWhileLost = true;
    }
    annotationCanvas.dispatchEvent(new Event("contextrestored"));

    interactionCanvas.dispatchEvent(new Event("contextlost", { cancelable: true }));
    interactionCanvas.dispatchEvent(new Event("contextrestored"));

    const captureAfterRestore = await runtime.session.captureCompositePng();
    return {
      sceneBlockedWhileLost,
      annotationBlockedWhileLost,
      captureBytes: captureAfterRestore.bytes,
      counters: getGpuDiagnostics().counters,
    };
  });

  expect(result.sceneBlockedWhileLost).toBe(true);
  expect(result.annotationBlockedWhileLost).toBe(true);
  expect(result.captureBytes).toBeGreaterThan(0);
  expect(result.counters["chart.canvas2d.scene.contextLost"]).toBe(1);
  expect(result.counters["chart.canvas2d.scene.contextRestored"]).toBe(1);
  expect(result.counters["chart.canvas2d.annotation.contextLost"]).toBe(1);
  expect(result.counters["chart.canvas2d.annotation.contextRestored"]).toBe(1);
  expect(result.counters["chart.canvas2d.interaction.contextLost"]).toBe(1);
  expect(result.counters["chart.canvas2d.interaction.contextRestored"]).toBe(1);
});
