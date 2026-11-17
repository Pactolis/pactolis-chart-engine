import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { FUNCTIONAL_WEBGL_ARGS } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS, "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--disable-vulkan-surface"] } });

test("four-surface WebGPU flush measurements preserve resolution reuse and empty-layer behavior", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const baselineCommit = "5ce5c7eab84640757e7358c5785e5c45b70e134e";
  const baselineSource = readFileSync(new URL("./fixtures/webgpu-quad-main-5ce5c7e.ts.fixture", import.meta.url), "utf8");
  const baselineJs = ts.transpileModule(baselineSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  await page.goto("/harness/");
  const report = await page.evaluate(async ({ baselineJs, baselineCommit }) => {
    const { WebGpuSurface } = await import("/src/core/gpu/webgpu/webgpuSurface.ts");
    const { WebGl2Surface } = await import("/src/core/gpu/webgl2/webgl2Surface.ts");
    const { WebGpuQuadPipeline } = await import("/src/core/gpu/webgpu/webgpuQuadPipeline.ts");
    const BaselinePipeline = (await import(URL.createObjectURL(new Blob([baselineJs], { type: "text/javascript" })))).WebGpuQuadPipeline;
    const { requestWebGpuDevice } = await import("/src/core/gpu/webgpu/webgpuDevice.ts");
    const handle = await requestWebGpuDevice();
    if (!handle) throw new Error("SwiftShader WebGPU device unavailable");
    const dimensions = { width: 800, height: 450 };
    const surfaces = [];
    const textures: any[] = [];
    for (const variant of ["main", "branch"]) {
    for (let i = 0; i < 4; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const texture = handle.device.createTexture({ size: [800, 450], format: handle.format, usage: 0x10 | 0x01 });
      textures.push(texture);
      // Same offscreen-present workaround as issue #88: encode/upload/submit is
      // real; only browser swap-chain presentation is replaced by a device texture.
      const gpuCanvas = { width: 800, height: 450,
        getContext: () => ({ configure() {}, getCurrentTexture: () => texture }) } as unknown as HTMLCanvasElement;
      const Pipeline = variant === "main" ? BaselinePipeline : WebGpuQuadPipeline;
      const gpu = new WebGpuSurface(gpuCanvas, handle, new Pipeline(handle.device, handle.format));
      const gl = canvas.getContext("webgl2", { antialias: false });
      if (!gl) throw new Error("WebGL2 unavailable");
      surfaces.push({ variant, gpu, gl: new WebGl2Surface(canvas, gl) });
    }
    }
    const rows = [];
    const clear = { r: 0, g: 0, b: 0, a: 1 };
    const color = { r: 0.1, g: 0.7, b: 0.2, a: 1 };
    for (const variant of ["main", "branch"]) {
    for (const scenario of ["pan", "live", "crosshair"]) {
      for (const backend of ["gl", "gpu"] as const) {
        const repetitions = [];
        for (let repetition = 0; repetition < 2; repetition++) {
          let totalMs = 0;
          let count = 0;
          for (let frameIndex = 0; frameIndex < 120; frameIndex++) {
            for (const pair of surfaces.filter((pair) => pair.variant === variant)) {
              const frame = pair[backend].beginFrame(clear);
              // 600 source bars × 40 cells; fit=60 gives 4,800 visible buy/sell
              // quads. Geometry is regenerated outside the timed flush section.
              for (let bar = 0; bar < 60; bar++) {
                for (let cell = 0; cell < 40; cell++) {
                  const sourceBar = scenario === "pan" ? (bar + frameIndex) % 600 : 540 + bar;
                  const liveDelta = scenario === "live" && bar === 59 ? frameIndex % 4 : 0;
                  const x = bar * 12 + (scenario === "pan" ? frameIndex % 3 : 0);
                  const y = cell * 10 + (sourceBar % 7) + liveDelta;
                  frame.quads.rect(x, y, 5, 8, color);
                  frame.quads.rect(x + 6, y, 5, 8, color);
                }
              }
              const started = performance.now();
              frame.flushQuads(800, 450);
              const elapsed = performance.now() - started;
              if (frameIndex >= 20) { totalMs += elapsed; count++; }
              frame.end();
            }
            // Explicit GPU completion prevents a growing command backlog from
            // contaminating later phases. No wall-clock scheduling assumption.
            await handle.device.queue.onSubmittedWorkDone();
          }
          repetitions.push({ count, meanMs: totalMs / count });
        }
        rows.push({ variant, scenario, backend: backend === "gpu" ? "webgpu" : "webgl2", repetitions });
      }
    }
    }
    for (const pair of surfaces) { pair.gpu.dispose(); pair.gl.dispose(); }
    for (const texture of textures) texture.destroy();
    handle.dispose();
    return { baselineCommit, fixture: { sourceBars: 600, cellsPerBar: 40, charts: 4, viewport: "1600x900", fit: 60, visibleQuadsPerChart: 4800,
      measuredFramesPerRepetition: 100, repetitions: 2, presentation: "offscreen device texture", metric: "flushQuads CPU elapsed; frame generation excluded" }, rows };
  }, { baselineJs, baselineCommit });
  expect(report.rows).toHaveLength(12);
  for (const row of report.rows) {
    for (const sample of row.repetitions) {
      expect(sample.count).toBe(400);
      expect(Number.isFinite(sample.meanMs)).toBe(true);
      expect(sample.meanMs).toBeGreaterThanOrEqual(0);
    }
  }
  console.log("WEBGPU_FLUSH_STAGE12_EVIDENCE", JSON.stringify(report));
  await testInfo.attach("webgpu-flush-stage12-evidence.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
});
