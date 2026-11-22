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

test("WebGPU verifyInit scoped error on ?gpu=webgpu initial mount falls back to connected WebGL2 canvas", async ({ page }) => {
  await page.addInitScript(() => {
    const locked = new WeakMap<HTMLCanvasElement, string>();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown,
    ) {
      const prev = locked.get(this);
      if (prev && prev !== contextId) return null;
      if (contextId === "webgpu") {
        locked.set(this, "webgpu");
        return {
          configure() {},
          unconfigure() {},
          getCurrentTexture() {
            return { createView() { return {}; } };
          },
        } as unknown as RenderingContext;
      }
      const ctx = (origGetContext as (id: string, opts?: unknown) => RenderingContext | null).call(this, contextId, options);
      if (ctx && !prev) locked.set(this, contextId);
      return ctx;
    } as typeof HTMLCanvasElement.prototype.getContext;

    const errorScopeStack: string[] = [];
    const mockDevice = {
      features: new Set<string>(),
      limits: { maxBufferSize: 268435456, maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      addEventListener() {},
      removeEventListener() {},
      destroy() {},
      pushErrorScope(filter: string) {
        errorScopeStack.push(filter);
      },
      async popErrorScope() {
        const filter = errorScopeStack.pop();
        return filter === "validation" ? { message: "Mock WebGPU validation error during shader init" } : null;
      },
      createShaderModule() { return {}; },
      createBuffer() { return { destroy() {}, unmap() {} }; },
      createBindGroupLayout() { return {}; },
      createBindGroup() { return {}; },
      createPipelineLayout() { return {}; },
      createRenderPipeline() { return {}; },
      createTexture() { return { createView() { return {}; }, destroy() {} }; },
      createCommandEncoder() {
        return {
          beginRenderPass() {
            return { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {}, end() {} };
          },
          copyTextureToBuffer() {},
          finish() { return {}; },
        };
      },
      queue: { writeBuffer() {}, submit() {} },
    };

    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        getPreferredCanvasFormat: () => "rgba8unorm",
        requestAdapter: async () => ({
          info: { vendor: "mock", architecture: "test", isFallbackAdapter: false },
          requestDevice: async () => mockDevice,
        }),
      },
    });
  });

  await installHistory(page, { bars: buildBars(60) });
  await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=15m&gpu=webgpu");
  await expect(page.locator('[data-testid="chart-hook"]')).toHaveAttribute("data-history-loading", "false");
  await expect(page.locator('[data-testid="chart-hook"]')).toHaveAttribute("data-gpu-backend", "webgl2");

  const state = await page.evaluate(async () => {
    const { getGpuDiagnostics } = await import("/src/core/gpu/gpuDiagnostics.ts");
    const harness = await import("/harness/chart.ts");
    const runtime = harness.listChartRuntimes()[0];
    const sceneCanvases = [...document.querySelectorAll('canvas[data-chart-surface="gpu-scene"]')];
    const annotationCanvas = document.querySelector('canvas[data-chart-surface="annotation"]');
    const capture = await runtime.session.captureCompositePng();
    return {
      sceneCount: sceneCanvases.length,
      connected: sceneCanvases[0]?.isConnected ?? false,
      nextSiblingIsAnnotation: sceneCanvases[0]?.nextElementSibling === annotationCanvas,
      surfaceKind: runtime.session.getSurface().kind,
      captureBytes: capture.bytes,
      diag: getGpuDiagnostics(),
    };
  });

  expect(state.sceneCount).toBe(1);
  expect(state.connected).toBe(true);
  expect(state.nextSiblingIsAnnotation).toBe(true);
  expect(state.surfaceKind).toBe("webgl2");
  expect(state.captureBytes).toBeGreaterThan(0);
  expect(state.diag.active).toBe("webgl2");
  expect(state.diag.fallbacks).toContainEqual(
    expect.objectContaining({ from: "webgpu", to: "webgl2", reason: "surface_init_failed" }),
  );
});
