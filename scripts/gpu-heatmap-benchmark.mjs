#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, hostname, platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "benchmark-results/gpu-heatmap-stage4");
const DEFAULT_SAMPLES = 30;
const BARS = 250;
const BASE_PRICE = 50_000;
const BUCKET_STEP = 50;
const CELLS = [15_000, 40_000];
const CHART_COUNTS = [1, 8];
const PHASES = ["cpu-cold", "cpu-hot", "gpu"];
const DECISION_RULE = Object.freeze({
  name: "conservative-hardware-go",
  requiredP95Ratio: 0.8,
  frameMetric: "chart.frame.render.ms",
  frameRule: "GPU p95 must be at most 80% of CPU hot p95 at both cell counts and both chart counts.",
  memoryRule: "At both cell counts, 8-chart GPU estimated retained bytes must not exceed 8-chart CPU-hot estimated retained bytes.",
  memoryMetric: "performance.memory usedJSHeapSize delta + GPU resource estimate + any retained CPU raster cache",
  hardwareRule: "Decision is evaluated only when WebGL2 reports an unmasked non-software renderer.",
});
const LAUNCH_ARGS = [
  "--use-gl=angle",
  "--use-angle=default",
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--enable-unsafe-swiftshader",
  "--enable-precise-memory-info",
];

function usage() {
  console.log(`Usage: npm run benchmark:gpu -- [options]

Options:
  --output-dir PATH  Write JSON and Markdown reports here (default: benchmark-results/gpu-heatmap-stage4)
  --samples N        Hot/cold frame samples per chart for each scenario (default: ${DEFAULT_SAMPLES})
  --list             List the fixed 15k/40k × 1/8 chart × CPU/GPU matrix and exit
  --dry-run          Validate and print the benchmark plan without launching Chromium
  --help             Show this help

Set CHROMIUM_PATH to use a specific Chromium executable. The harness does not
force SwiftShader; a software renderer is reported as hardware-invalid.`);
}

function parseArgs(argv) {
  const options = { outputDir: DEFAULT_OUTPUT_DIR, samples: DEFAULT_SAMPLES, list: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      if (!argv[index + 1]) throw new Error("--output-dir requires a path");
      options.outputDir = resolve(argv[++index]);
    } else if (arg === "--samples") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 5 || value > 250) throw new Error("--samples must be an integer from 5 through 250");
      options.samples = value;
    } else if (arg === "--list") options.list = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.list && options.dryRun) throw new Error("Choose either --list or --dry-run");
  return options;
}

function scenarios(samples) {
  return CELLS.flatMap((cellCount) => CHART_COUNTS.flatMap((chartCount) => PHASES.map((phase) => ({
    cellCount,
    chartCount,
    phase,
    samples,
    barsCount: BARS,
    levelsPerBar: cellCount / BARS,
    basePrice: BASE_PRICE,
    bucketStep: BUCKET_STEP,
  }))));
}

function printPlan(samples, listOnly) {
  const matrix = scenarios(samples);
  if (listOnly) {
    for (const item of matrix) {
      console.log(`${item.cellCount} cells | ${item.chartCount} chart(s) | ${item.phase} | ${item.samples} samples/chart`);
    }
    return;
  }
  console.log(JSON.stringify({
    scenarioCount: matrix.length,
    scenarios: matrix,
    launchArgs: LAUNCH_ARGS,
    decisionRule: DECISION_RULE,
    measurementEnabled: false,
  }, null, 2));
}

function firstSystemChromium() {
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function makeFixture() {
  const intervalMs = 15 * 60_000;
  const frozenNow = Date.UTC(2026, 0, 15, 12, 0, 0);
  const lastTime = Math.floor(frozenNow / intervalMs) * intervalMs;
  const firstTime = lastTime - (BARS - 1) * intervalMs;
  const bars = Array.from({ length: BARS }, (_, index) => {
    const t = firstTime + index * intervalMs;
    return {
      t,
      o: BASE_PRICE + 1_200,
      h: BASE_PRICE + 7_950,
      l: BASE_PRICE - 200,
      c: BASE_PRICE + 1_500,
      v: 20,
      d: 2,
      n: 20,
      cells: [
        [BASE_PRICE, 5, 5, 0, 0, 10, 5, 5],
        [BASE_PRICE + 1_500, 5, 5, 0, 0, 10, 5, 5],
      ],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: frozenNow,
    };
  });
  const cellsByWorkload = new Map(CELLS.map((cellCount) => {
    const levels = cellCount / BARS;
    const heatmapBars = bars.map((bar, barIndex) => ({
      t: bar.t,
      cells: Array.from({ length: levels }, (_, level) => {
        const price = BASE_PRICE + level * BUCKET_STEP;
        const bid = 2_000 + ((barIndex + level) % 10) * 400;
        const ask = 2_000 + ((barIndex * 3 + level) % 10) * 400;
        return [price, bid, ask];
      }),
    }));
    return [cellCount, heatmapBars];
  }));
  return { bars, cellsByWorkload, frozenNow };
}

function percentileRows(report) {
  return report.results.map((result) => {
    const frame = result.frameTime ?? {};
    const memory = result.memory ?? {};
    const jsDelta = memory.jsHeapDeltaBytes;
    const retained = memory.estimatedTotalRetainedBytes;
    return `| ${result.workload?.cellCount ?? "—"} | ${result.workload?.chartCount ?? "—"} | ${result.phase ?? "—"} | ${frame.count ?? 0} | ${formatNumber(frame.p50Ms)} | ${formatNumber(frame.p95Ms)} | ${formatNumber(frame.p99Ms)} | ${formatBytes(jsDelta)} | ${formatBytes(retained)} | ${result.error ? "ERROR" : result.gpuOwned ? "GPU owned" : "CPU"} |`;
  }).join("\n");
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "—";
}

function formatBytes(value) {
  return Number.isFinite(value) ? `${(value / (1024 * 1024)).toFixed(2)} MiB` : "—";
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function makeMarkdown(report) {
  const probe = report.rendererProbe;
  const renderer = probe?.unmaskedRenderer ?? probe?.renderer ?? "unavailable";
  const vendor = probe?.unmaskedVendor ?? probe?.vendor ?? "unavailable";
  return `# Stage 4 GPU heatmap benchmark\n\n`
    + `- Issue: #74 (Stage 4)\n`
    + `- Run: ${report.runId}\n`
    + `- Decision: **${report.decision}**\n`
    + `- Hardware valid: **${report.hardwareValid}**${probe?.invalidReason ? ` (${probe.invalidReason})` : ""}\n`
    + `- Renderer: ${vendor} / ${renderer}\n`
    + `- Chromium: ${report.browser?.version ?? "unknown"}\n`
    + `- Launch args: \`${(report.browser?.requestedLaunchArgs ?? []).join(" ")}\`\n\n`
    + `## Fixed decision rule\n\n`
    + `- ${DECISION_RULE.frameRule}\n`
    + `- ${DECISION_RULE.memoryRule}\n`
    + `- ${DECISION_RULE.hardwareRule}\n`
    + `- A software renderer, including SwiftShader, is hardware-invalid and never yields GO/NO-GO.\n\n`
    + `## Results\n\n`
    + `| Cells | Charts | Path | Frames | p50 ms | p95 ms | p99 ms | JS heap Δ | Estimated retained | Path ownership |\n`
    + `| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n`
    + `${percentileRows(report)}\n\n`
    + `## Limitations\n\n`
    + `- GPU memory is a known-resource allocation estimate for the heatmap textures and instance/quad buffers; estimated retained bytes also include any CPU raster cache still held after GPU opt-in. WebGL does not expose a portable dedicated-VRAM counter; driver overhead and allocations outside the heatmap are excluded.\n`
    + `- JavaScript heap data is taken from Chromium \`performance.memory\`; unavailable values are null and prevent a decision.\n`
    + `- GPU frame time includes the engine's CPU prepare path and WebGL submission; it is not a GPU timer query.\n`;
}

function evaluateDecision(report) {
  if (!report.hardwareValid) return "NOT_EVALUATED_HARDWARE_INVALID";
  if (report.results.some((result) => result.error)) return "NOT_EVALUATED_INCOMPLETE";
  const lookup = new Map(report.results.map((result) => [
    `${result.workload.cellCount}:${result.workload.chartCount}:${result.phase}`,
    result,
  ]));
  let performancePass = true;
  for (const cellCount of CELLS) {
    for (const chartCount of CHART_COUNTS) {
      const cpuHot = lookup.get(`${cellCount}:${chartCount}:cpu-hot`);
      const gpu = lookup.get(`${cellCount}:${chartCount}:gpu`);
      if (!cpuHot?.frameTime?.p95Ms || !gpu?.frameTime?.p95Ms
        || gpu.frameTime.p95Ms > cpuHot.frameTime.p95Ms * DECISION_RULE.requiredP95Ratio) {
        performancePass = false;
      }
    }
  }
  let memoryPass = true;
  for (const cellCount of CELLS) {
    const cpuHot = lookup.get(`${cellCount}:8:cpu-hot`);
    const gpu = lookup.get(`${cellCount}:8:gpu`);
    const cpuBytes = cpuHot?.memory?.estimatedTotalRetainedBytes;
    const gpuBytes = gpu?.memory?.estimatedTotalRetainedBytes;
    if (!Number.isFinite(cpuBytes) || !Number.isFinite(gpuBytes)) return "NOT_EVALUATED_MEMORY_UNAVAILABLE";
    if (gpuBytes > cpuBytes) memoryPass = false;
  }
  return performancePass && memoryPass ? "GO" : "NO_GO";
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }
  if (options.list || options.dryRun) {
    printPlan(options.samples, options.list);
    return;
  }

  const fixture = makeFixture();
  const server = await createServer({
    configFile: resolve(ROOT, "vite.config.ts"),
    root: ROOT,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 4173, strictPort: true },
  });
  let browser;
  const results = [];
  const report = {
    schemaVersion: 1,
    issue: "#74 (Stage 4)",
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    createdAt: new Date().toISOString(),
    hardwareValid: false,
    decision: "NOT_EVALUATED",
    decisionRule: DECISION_RULE,
    browser: {},
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpuModel: cpus()[0]?.model ?? null,
      cpuLogicalCount: cpus().length,
      nodeVersion: process.version,
    },
    git: {
      main: gitValue(["rev-parse", "origin/main"]),
      head: gitValue(["rev-parse", "HEAD"]),
      branch: gitValue(["branch", "--show-current"]),
    },
    rendererProbe: null,
    results,
  };

  try {
    await server.listen();
    const baseUrl = "http://127.0.0.1:4173";
    const executablePath = process.env.CHROMIUM_PATH || firstSystemChromium();
    browser = await chromium.launch({
      headless: true,
      args: LAUNCH_ARGS,
      ...(executablePath ? { executablePath } : {}),
    });
    report.browser = {
      version: browser.version(),
      executablePath: executablePath ?? chromium.executablePath(),
      requestedLaunchArgs: LAUNCH_ARGS,
      headless: true,
    };

    const probePage = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
    await probePage.goto(`${baseUrl}/harness/blank.html`);
    report.rendererProbe = await probePage.evaluate(async () => {
      const benchmark = await import("/harness/gpuHeatmapBenchmark.ts");
      return benchmark.probeGpuRenderer();
    });
    report.hardwareValid = report.rendererProbe.hardwareValid;
    await probePage.close();

    for (const input of scenarios(options.samples)) {
      const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
      const heatmapBars = fixture.cellsByWorkload.get(input.cellCount);
      if (!heatmapBars) throw new Error(`Missing fixture for ${input.cellCount} cells`);
      await page.route(/\/history(?:\?.*)?$/, (route) => {
        const query = new URL(route.request().url()).searchParams;
        const from = Number(query.get("from"));
        const to = Number(query.get("to"));
        const candleOnly = query.get("includeFootprint") === "0";
        const meta = candleOnly ? { schemaVersion: 1, generatedAt: fixture.frozenNow } : {
          schemaVersion: 1,
          generatedAt: fixture.frozenNow,
          footprint: { available: true, allowed: true, priceStep: BUCKET_STEP },
          footprintCoverage: {
            status: "complete",
            requestedFrom: from,
            requestedTo: to,
            coveredFrom: from,
            coveredThrough: to,
          },
        };
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: { bars: fixture.bars }, meta }),
        });
      });
      await page.route(/\/api\/orderbook\/heatmap(?:\?.*)?$/, (route) => {
        const query = new URL(route.request().url()).searchParams;
        const from = Number(query.get("from"));
        const to = Number(query.get("to"));
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              schemaVersion: 1,
              generatedAt: fixture.frozenNow,
              base: "BTC",
              source: query.get("source") ?? "single",
              resolution: query.get("resolution") ?? "15m",
              bucketStep: Number(query.get("bucketStep") ?? BUCKET_STEP),
              from,
              to,
              bars: heatmapBars.filter((bar) => bar.t >= from && bar.t <= to),
            },
          }),
        });
      });
      try {
        await page.goto(`${baseUrl}/harness/`);
        await page.waitForFunction(() => window.__chartHarnessReady === true);
        const measured = await page.evaluate(async (scenario) => {
          const benchmark = await import("/harness/gpuHeatmapBenchmark.ts");
          return benchmark.runGpuHeatmapBenchmark(scenario);
        }, input);
        results.push(measured);
        console.log(`measured ${input.cellCount} cells × ${input.chartCount} charts × ${input.phase}`);
      } catch (error) {
        results.push({
          workload: { cellCount: input.cellCount, chartCount: input.chartCount },
          phase: input.phase,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
        console.error(`failed ${input.cellCount} cells × ${input.chartCount} charts × ${input.phase}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await page.close();
      }
    }
    report.results = results;
    report.decision = evaluateDecision(report);
    report.completed = results.length === scenarios(options.samples).length && !results.some((result) => result.error);
  } finally {
    await browser?.close();
    await server.close();
  }

  await mkdir(options.outputDir, { recursive: true });
  const fileStem = `gpu-heatmap-${report.runId}`;
  const jsonPath = resolve(options.outputDir, `${fileStem}.json`);
  const markdownPath = resolve(options.outputDir, `${fileStem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, makeMarkdown(report));
  console.log(`hardwareValid=${report.hardwareValid}`);
  console.log(`decision=${report.decision}`);
  console.log(`json=${jsonPath}`);
  console.log(`markdown=${markdownPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
