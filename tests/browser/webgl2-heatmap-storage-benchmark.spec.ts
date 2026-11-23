import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { chromium, expect, test, type Browser } from "@playwright/test";
import { FUNCTIONAL_WEBGL_ARGS } from "./support/history.js";
import {
  evaluateWebGl2StorageDecision,
  medianOf,
  resolveWebGl2HeatmapStorageFixture,
  summarizeMetricValues,
  WEBGL2_HEATMAP_STORAGE_VARIANTS,
  WEBGL2_HEATMAP_STORAGE_WORKLOADS,
} from "../../harness/webgl2HeatmapStorageBenchmark.mjs";

const HARDWARE_MODE = process.env.CHART_GPU_BENCHMARK_MODE === "hardware";
const FIXTURE = resolveWebGl2HeatmapStorageFixture({
  hardwareMode: HARDWARE_MODE,
  chartCounts: process.env.CHART_WEBGL2_STORAGE_CHARTS,
});

function launchArgs(): string[] {
  if (HARDWARE_MODE) {
    return [
      "--use-gl=angle",
      "--use-angle=default",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--enable-precise-memory-info",
    ];
  }
  return [...FUNCTIONAL_WEBGL_ARGS, "--enable-precise-memory-info"];
}

async function launchBrowser(args: string[]): Promise<Browser> {
  let executablePath: string | undefined;
  if (process.env.CHROMIUM_PATH) {
    executablePath = process.env.CHROMIUM_PATH;
  } else if (HARDWARE_MODE && process.platform === "win32") {
    const fullExe = chromium.executablePath();
    if (fullExe && existsSync(fullExe)) {
      executablePath = fullExe;
    }
  }
  return chromium.launch({
    headless: true,
    args,
    ...(executablePath ? { executablePath } : {}),
  });
}

function patchHeatmapGpuRendererVariant(body: string, variant: string): string {
  if (variant === "mutable") return body;

  let patched = body;

  if (variant === "bucket") {
    const beforeGrid = patched;
    patched = patched.replace(
      /const\s+gridHeight\s*=\s*Math\.ceil\(\s*cellCount\s*\/\s*gridWidth\s*\)\s*;/,
      `const neededHeight = Math.ceil(cellCount / gridWidth);
    let gridHeight = 1;
    while (gridHeight < neededHeight) gridHeight *= 2;
    if (gridWidth === this.gridWidth && neededHeight <= this.gridHeight) {
      gridHeight = this.gridHeight;
    }`,
    );
    if (patched === beforeGrid) {
      throw new Error("Failed to patch bucket power-of-two gridHeight in heatmapGpuRenderer.ts");
    }
  }

  const beforeTexCreate = patched;
  patched = patched.replace(
    /if\s*\(\s*!this\.densityTexture\s*\)\s*this\.densityTexture\s*=\s*gl\.createTexture\(\)\s*;\s*if\s*\(\s*!this\.validityTexture\s*\)\s*this\.validityTexture\s*=\s*gl\.createTexture\(\)\s*;/,
    `if (this.densityTexture) { gl.deleteTexture(this.densityTexture); this.densityTexture = null; }
      if (this.validityTexture) { gl.deleteTexture(this.validityTexture); this.validityTexture = null; }
      this.densityTexture = gl.createTexture();
      this.validityTexture = gl.createTexture();`,
  );
  if (patched === beforeTexCreate) {
    throw new Error(`Failed to patch immutable texture recreation for variant ${variant}`);
  }

  const beforeR32F = patched;
  patched = patched.replace(
    /gl\.texImage2D\(\s*gl\.TEXTURE_2D\s*,\s*0\s*,\s*gl\.R32F\s*,\s*gridWidth\s*,\s*gridHeight\s*,\s*0\s*,\s*gl\.RED\s*,\s*gl\.FLOAT\s*,\s*null\s*\)\s*;/,
    `gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, gridWidth, gridHeight);`,
  );
  if (patched === beforeR32F) {
    throw new Error(`Failed to patch R32F texStorage2D for variant ${variant}`);
  }

  const beforeR8 = patched;
  patched = patched.replace(
    /gl\.texImage2D\(\s*gl\.TEXTURE_2D\s*,\s*0\s*,\s*gl\.R8\s*,\s*gridWidth\s*,\s*gridHeight\s*,\s*0\s*,\s*gl\.RED\s*,\s*gl\.UNSIGNED_BYTE\s*,\s*null\s*\)\s*;/,
    `gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, gridWidth, gridHeight);`,
  );
  if (patched === beforeR8) {
    throw new Error(`Failed to patch R8 texStorage2D for variant ${variant}`);
  }

  return patched;
}

test("WebGL2 resident heatmap texStorage2D vs bucket capacity benchmark (#257)", async ({ baseURL }, testInfo) => {
  test.setTimeout(HARDWARE_MODE ? 360_000 : 120_000);
  const resolvedBaseURL = baseURL ?? testInfo.project.use.baseURL ?? "http://127.0.0.1:4173";
  const browser = await launchBrowser(launchArgs());

  try {
    const context = await browser.newContext({ baseURL: resolvedBaseURL, viewport: FIXTURE.viewport });
    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
    });

    await page.route("**/src/features/chart/heatmap/gpu/heatmapGpuRenderer.ts*", async (route) => {
      const url = new URL(route.request().url());
      const variant = url.searchParams.get("variant") ?? "mutable";
      const response = await route.fetch();
      const body = await response.text();
      const patched = patchHeatmapGpuRendererVariant(body, variant);
      const headers = { ...response.headers() };
      delete headers["content-length"];
      await route.fulfill({ status: response.status(), headers, body: patched });
    });

    await page.goto("/harness/blank.html");

    const envInfo = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (!gl) return { ok: false, webglInfo: null, softwareRenderer: true };
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      const webglInfo = {
        vendor: gl.getParameter(gl.VENDOR) as string,
        renderer: gl.getParameter(gl.RENDERER) as string,
        unmaskedVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string : null,
        unmaskedRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string : null,
        debugExtensionAvailable: Boolean(debugInfo),
      };
      const identity = `${webglInfo.unmaskedVendor ?? webglInfo.vendor ?? ""} ${webglInfo.unmaskedRenderer ?? webglInfo.renderer ?? ""}`;
      const softwareRenderer = /swiftshader|llvmpipe|softpipe|software raster|basic render|warp device/i.test(identity);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return { ok: true, webglInfo, softwareRenderer };
    });

    if (!envInfo.ok) {
      test.skip(true, "WebGL2 context unavailable in runtime");
    }

    const hardwareValid = Boolean(
      !envInfo.softwareRenderer
      && envInfo.webglInfo?.debugExtensionAvailable
      && envInfo.webglInfo?.unmaskedVendor
      && envInfo.webglInfo?.unmaskedRenderer,
    );

    const rawResults = await page.evaluate(async ({ fixture, variants, workloads }) => {
      const makeSyntheticFrame = (cellCount: number, stepIndex: number, workload: string) => {
        const main = new Array(cellCount);
        const valueShift = workload === "static" ? 0 : (stepIndex % 7) * 5;
        for (let i = 0; i < cellCount; i++) {
          main[i] = {
            x: (i % 120) * 10,
            yTop: (i % 40) * 18,
            width: 9,
            height: 16,
            value: 120 + ((i + valueShift) % 800),
          };
        }
        return {
          main,
          extension: [],
          ceiling: 920,
          threshold: 50,
          floor: 50,
          opacity: 0.85,
          dataKey: workload === "static" ? "static-key" : `key-${workload}-${stepIndex % 4}`,
        };
      };

      const runScenario = async (variant: string, workload: string, chartCount: number) => {
        const mod = await import(`/src/features/chart/heatmap/gpu/heatmapGpuRenderer.ts?variant=${variant}`);
        const { HeatmapGpuRenderer } = mod;

        const contexts: Array<{
          canvas: HTMLCanvasElement;
          gl: WebGL2RenderingContext;
          renderer: InstanceType<typeof HeatmapGpuRenderer>;
          extTimer: any;
          getStats: () => { textureAllocCount: number; peakBytes: number; glError: number };
        }> = [];

        for (let c = 0; c < chartCount; c++) {
          const canvas = document.createElement("canvas");
          canvas.width = fixture.viewport.width;
          canvas.height = fixture.viewport.height;
          document.body.appendChild(canvas);
          const gl = canvas.getContext("webgl2");
          if (!gl) throw new Error("Failed to acquire WebGL2 context");

          const extTimer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
          let textureAllocCount = 0;
          let currentBytes = 0;
          let peakBytes = 0;
          const texBytes = new Map<WebGLTexture, number>();

          const formatBpp = (fmt: number): number => {
            if (fmt === gl.R32F) return 4;
            if (fmt === gl.R8) return 1;
            return 4;
          };

          const origBindTexture = gl.bindTexture.bind(gl);
          let boundTex: WebGLTexture | null = null;
          gl.bindTexture = ((target: number, texture: WebGLTexture | null) => {
            if (target === gl.TEXTURE_2D) boundTex = texture;
            return origBindTexture(target, texture);
          }) as typeof gl.bindTexture;

          const recordTexAlloc = (internalformat: number, width: number, height: number) => {
            textureAllocCount++;
            if (!boundTex) return;
            const prev = texBytes.get(boundTex) ?? 0;
            const next = width * height * formatBpp(internalformat);
            texBytes.set(boundTex, next);
            currentBytes += next - prev;
            if (currentBytes > peakBytes) peakBytes = currentBytes;
          };

          const origTexImage2D = gl.texImage2D.bind(gl);
          gl.texImage2D = ((...args: any[]) => {
            if (typeof args[2] === "number" && typeof args[3] === "number" && typeof args[4] === "number") {
              recordTexAlloc(args[2], args[3], args[4]);
            }
            return (origTexImage2D as any)(...args);
          }) as typeof gl.texImage2D;

          const origTexStorage2D = gl.texStorage2D.bind(gl);
          gl.texStorage2D = ((target: number, levels: number, internalformat: number, width: number, height: number) => {
            recordTexAlloc(internalformat, width, height);
            return origTexStorage2D(target, levels, internalformat, width, height);
          }) as typeof gl.texStorage2D;

          const origDeleteTexture = gl.deleteTexture.bind(gl);
          gl.deleteTexture = ((texture: WebGLTexture | null) => {
            if (texture && texBytes.has(texture)) {
              currentBytes -= texBytes.get(texture)!;
              texBytes.delete(texture);
            }
            return origDeleteTexture(texture);
          }) as typeof gl.deleteTexture;

          contexts.push({
            canvas,
            gl,
            renderer: new HeatmapGpuRenderer(),
            extTimer,
            getStats: () => ({
              textureAllocCount,
              peakBytes,
              glError: gl.getError(),
            }),
          });
        }

        const nextRaf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const repFrameP50: number[] = [];
        const repFrameP95: number[] = [];
        const allFrameSamples: number[] = [];
        const allGpuSamples: number[] = [];
        let maxAllocCount = 0;
        let maxPeakBytes = 0;
        let firstGlError = 0;

        const cellCountForStep = (step: number): number => {
          if (workload !== "resize") return fixture.staticCells;
          return fixture.resizePattern[step % fixture.resizePattern.length];
        };

        // Prebuild reusable frames by cell pattern key to avoid JS GC noise in timed loops.
        const frameCache = new Map<string, ReturnType<typeof makeSyntheticFrame>>();
        const getFrame = (step: number) => {
          const count = cellCountForStep(step);
          const variantKey = workload === "static" ? "static" : `${workload}-${step % 4}`;
          const cacheKey = `${count}|${variantKey}`;
          let cached = frameCache.get(cacheKey);
          if (!cached) {
            cached = makeSyntheticFrame(count, step, workload);
            frameCache.set(cacheKey, cached);
          }
          return cached;
        };

        try {
          for (let rep = 0; rep < fixture.repetitions; rep++) {
            for (let w = 0; w < fixture.warmupFrames; w++) {
              const frame = getFrame(w);
              for (const ctx of contexts) {
                ctx.renderer.renderFrame(ctx.gl, frame, fixture.plot);
              }
              await nextRaf();
            }

            const repFrames: number[] = [];
            const pendingQueries: Array<{ gl: WebGL2RenderingContext; ext: any; query: WebGLQuery }> = [];

            for (let m = 0; m < fixture.measuredFrames; m++) {
              const frame = getFrame(fixture.warmupFrames + m);
              const t0 = performance.now();
              for (let c = 0; c < contexts.length; c++) {
                const ctx = contexts[c];
                let q: WebGLQuery | null = null;
                if (c === 0 && ctx.extTimer) {
                  q = ctx.gl.createQuery();
                  if (q) ctx.gl.beginQuery(ctx.extTimer.TIME_ELAPSED_EXT, q);
                }
                const ok = ctx.renderer.renderFrame(ctx.gl, frame, fixture.plot);
                if (!ok) throw new Error(`renderFrame returned false for ${variant}/${workload}`);
                if (q && ctx.extTimer) {
                  ctx.gl.endQuery(ctx.extTimer.TIME_ELAPSED_EXT);
                  pendingQueries.push({ gl: ctx.gl, ext: ctx.extTimer, query: q });
                }
              }
              const dt = performance.now() - t0;
              repFrames.push(dt);
              allFrameSamples.push(dt);
              await nextRaf();
            }

            const sortedRep = [...repFrames].sort((a, b) => a - b);
            repFrameP50.push(sortedRep[Math.floor(sortedRep.length * 0.5)] ?? 0);
            repFrameP95.push(sortedRep[Math.min(sortedRep.length - 1, Math.ceil(sortedRep.length * 0.95) - 1)] ?? 0);

            for (const pq of pendingQueries) {
              for (let tries = 0; tries < 20; tries++) {
                if (pq.gl.getQueryParameter(pq.query, pq.gl.QUERY_RESULT_AVAILABLE)) break;
                await nextRaf();
              }
              const available = pq.gl.getQueryParameter(pq.query, pq.gl.QUERY_RESULT_AVAILABLE);
              const disjoint = pq.gl.getParameter(pq.ext.GPU_DISJOINT_EXT);
              if (available && !disjoint) {
                const ns = pq.gl.getQueryParameter(pq.query, pq.gl.QUERY_RESULT);
                if (typeof ns === "number" && ns >= 0) allGpuSamples.push(ns / 1_000_000);
              }
              pq.gl.deleteQuery(pq.query);
            }
          }

          let totalAllocs = 0;
          let totalPeakBytes = 0;
          for (const ctx of contexts) {
            const st = ctx.getStats();
            totalAllocs += st.textureAllocCount;
            totalPeakBytes += st.peakBytes;
            if (firstGlError === 0 && st.glError !== 0) firstGlError = st.glError;
          }
          maxAllocCount = totalAllocs;
          maxPeakBytes = totalPeakBytes;
        } finally {
          for (const ctx of contexts) {
            ctx.renderer.dispose();
            ctx.gl.getExtension("WEBGL_lose_context")?.loseContext();
            ctx.canvas.remove();
          }
        }

        return {
          variant,
          workload,
          chartCount,
          repFrameP50,
          repFrameP95,
          allFrameSamples,
          allGpuSamples,
          textureAllocCount: maxAllocCount,
          texturePayloadPeakMiB: maxPeakBytes / (1024 * 1024),
          glError: firstGlError,
        };
      };

      const rows: any[] = [];
      for (const chartCount of fixture.chartCounts) {
        for (const workload of workloads) {
          for (const variant of variants) {
            rows.push(await runScenario(variant, workload, chartCount));
          }
        }
      }
      return rows;
    }, {
      fixture: FIXTURE,
      variants: WEBGL2_HEATMAP_STORAGE_VARIANTS,
      workloads: WEBGL2_HEATMAP_STORAGE_WORKLOADS,
    });

    await context.close();

    const rows = rawResults.map((raw) => {
      const frame = summarizeMetricValues(raw.allFrameSamples);
      const gpu = summarizeMetricValues(raw.allGpuSamples);
      return {
        variant: raw.variant,
        workload: raw.workload,
        chartCount: raw.chartCount,
        frame: {
          ...frame,
          medianRepP50Ms: medianOf(raw.repFrameP50),
          medianRepP95Ms: medianOf(raw.repFrameP95),
        },
        gpu,
        textureAllocCount: raw.textureAllocCount,
        texturePayloadPeakMiB: raw.texturePayloadPeakMiB,
        glError: raw.glError,
      };
    });

    const assessment = evaluateWebGl2StorageDecision({ hardwareValid, rows });
    const evidence = {
      issue: "#257",
      webglInfo: envInfo.webglInfo,
      hardwareValid,
      rows,
      assessment,
    };

    console.log(`WEBGL2_HEATMAP_STORAGE_EVIDENCE ${JSON.stringify(evidence)}`);
    if (process.env.CHART_WEBGL2_STORAGE_REPORT_PATH) {
      await writeFile(process.env.CHART_WEBGL2_STORAGE_REPORT_PATH, JSON.stringify(evidence, null, 2));
    }

    for (const row of rows) {
      expect(row.glError).toBe(0);
      expect(row.frame.count).toBe(FIXTURE.repetitions * FIXTURE.measuredFrames);
    }

    for (const chartCount of FIXTURE.chartCounts) {
      const mutResize = rows.find((r) => r.variant === "mutable" && r.workload === "resize" && r.chartCount === chartCount);
      const immResize = rows.find((r) => r.variant === "immutable" && r.workload === "resize" && r.chartCount === chartCount);
      const bucResize = rows.find((r) => r.variant === "bucket" && r.workload === "resize" && r.chartCount === chartCount);
      expect(mutResize).toBeTruthy();
      expect(immResize).toBeTruthy();
      expect(bucResize).toBeTruthy();
      expect(bucResize!.textureAllocCount).toBeLessThan(mutResize!.textureAllocCount);
      expect(bucResize!.textureAllocCount).toBeLessThan(immResize!.textureAllocCount);
    }
  } finally {
    await browser.close().catch(() => {});
  }
});
