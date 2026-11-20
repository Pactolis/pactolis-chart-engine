#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, hostname, platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  buildWebGpuFlushAssessment,
  formatWebGpuFlushMetadata,
  WEBGPU_FLUSH_DECISION_RULE,
  WEBGPU_FLUSH_FIXTURE,
  WEBGPU_FLUSH_SCENARIOS,
} from "../harness/webgpuFlushBenchmark.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "benchmark-results/gpu-benchmark");
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
  --output-dir PATH  Write one combined JSON and Markdown report here (default: benchmark-results/gpu-benchmark)
  --samples N        Hot/cold frame samples per chart for each scenario (default: ${DEFAULT_SAMPLES})
  --list             List the #74 matrix and #88 WebGPU flush scenarios, then exit
  --dry-run          Validate both suites and print their fixtures/rules without launching Chromium
  --help             Show this help

Owner hardware command:
  npm run benchmark:gpu -- --output-dir /tmp/chart-engine-gpu-benchmark

The command runs the #74 heatmap matrix and #88 WebGPU vs WebGL2 flush suite,
then writes one JSON and one Markdown report. Set CHROMIUM_PATH to select Chromium.
The harness does not force SwiftShader; a software renderer or missing WebGPU
adapter is reported as hardware-invalid and cannot produce a hardware decision.`);
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

function flushScenarios() {
  return WEBGPU_FLUSH_SCENARIOS.map((scenario) => ({
    suite: "#88 WebGPU vs WebGL2 flush",
    scenario,
    backends: ["webgl2", "webgpu"],
    metrics: ["chart.gpu.flush.ms", "chart.gpu.footprint.ms", "chart.surface.gpu.draw.ms"],
    decisionRule: WEBGPU_FLUSH_DECISION_RULE,
  }));
}

function printPlan(samples, listOnly) {
  const matrix = scenarios(samples);
  const flush = flushScenarios();
  if (listOnly) {
    for (const item of matrix) {
      console.log(`${item.cellCount} cells | ${item.chartCount} chart(s) | ${item.phase} | ${item.samples} samples/chart`);
    }
    for (const item of flush) {
      console.log(`#88 ${item.scenario} | ${WEBGPU_FLUSH_FIXTURE.markets.length} charts (${WEBGPU_FLUSH_FIXTURE.viewport.width}x${WEBGPU_FLUSH_FIXTURE.viewport.height}) | ${WEBGPU_FLUSH_FIXTURE.barCount} bars × ${WEBGPU_FLUSH_FIXTURE.cellsPerBar} cells | WebGL2 + WebGPU | mean ratio ≤ ${item.decisionRule.maximumRatio}`);
    }
    return;
  }
  console.log(JSON.stringify({
    scenarioCount: matrix.length + flush.length,
    suites: {
      issue74: { scenarioCount: matrix.length, scenarios: matrix, decisionRule: DECISION_RULE },
      issue88: { scenarioCount: flush.length, scenarios: flush, fixture: WEBGPU_FLUSH_FIXTURE, decisionRule: WEBGPU_FLUSH_DECISION_RULE },
    },
    launchArgs: LAUNCH_ARGS,
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

function commandText(command, args, timeout = 3_000) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function collectDriverInfo() {
  const nvidia = commandText("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"]);
  if (nvidia) return { source: "nvidia-smi", detail: nvidia.split("\n").slice(0, 8) };

  if (platform() === "linux") {
    const vulkan = commandText("vulkaninfo", ["--summary"]);
    if (vulkan) {
      const driverLines = vulkan.split("\n").map((line) => line.trim()).filter((line) => /driver(Name|Info|Version)/i.test(line));
      if (driverLines.length) return { source: "vulkaninfo --summary", detail: driverLines.slice(0, 12) };
    }
    const gl = commandText("glxinfo", ["-B"]);
    if (gl) {
      const driverLines = gl.split("\n").map((line) => line.trim()).filter((line) => /OpenGL vendor|OpenGL renderer|OpenGL version/i.test(line));
      if (driverLines.length) return { source: "glxinfo -B", detail: driverLines.slice(0, 12) };
    }
  } else if (platform() === "darwin") {
    const display = commandText("system_profiler", ["SPDisplaysDataType"]);
    if (display) {
      const driverLines = display.split("\n").map((line) => line.trim()).filter((line) => /Chipset Model|Metal Support/i.test(line));
      if (driverLines.length) return { source: "system_profiler SPDisplaysDataType", detail: driverLines.slice(0, 12) };
    }
  } else if (platform() === "win32") {
    const display = commandText("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress"]);
    if (display) return { source: "Win32_VideoController", detail: display };
  }
  return { source: null, detail: null };
}

function flushMarkdownRows(flushReport) {
  const rows = [];
  for (const scenario of WEBGPU_FLUSH_SCENARIOS) {
    for (const backendName of ["webgl2", "webgpu"]) {
      const backend = flushReport?.[backendName];
      const combined = backend?.scenarios?.[scenario]?.combined ?? {};
      for (const metricName of ["chart.gpu.flush.ms", "chart.gpu.footprint.ms", "chart.surface.gpu.draw.ms"]) {
        const stats = combined[metricName];
        rows.push(`| ${scenario} | ${backendName} | \`${metricName}\` | ${stats?.count ?? 0} | ${formatNumber(stats?.meanMs)} | ${formatNumber(stats?.p50Ms)} | ${formatNumber(stats?.p95Ms)} | ${formatNumber(stats?.p99Ms)} |`);
      }
    }
  }
  return rows.join("\n");
}

function flushRatioRows(flushReport) {
  return (flushReport?.comparisons ?? []).map((comparison) =>
    `| ${comparison.scenario} | ${formatNumber(comparison.webgl2?.flush?.meanMs)} | ${formatNumber(comparison.webgpu?.flush?.meanMs)} | ${Number.isFinite(comparison.rawFlushMeanRatio) ? comparison.rawFlushMeanRatio.toFixed(6) : "—"} | ${comparison.within2xBudget === null ? "n/a" : comparison.within2xBudget ? "yes" : "no"} |`,
  ).join("\n");
}

export function makeMarkdown(report) {
  const probe = report.rendererProbe;
  const renderer = probe?.unmaskedRenderer ?? probe?.renderer ?? "unavailable";
  const vendor = probe?.unmaskedVendor ?? probe?.vendor ?? "unavailable";
  const flushReport = report.webgpuFlush;
  const decisions = report.decisionByIssue ?? { issue74: report.decision, issue88: flushReport?.decision ?? "NOT_EVALUATED" };
  return `# Combined GPU benchmark report\n\n`
    + `- Issues: #74 (Stage 4) and #88\n`
    + `- Run: ${report.runId}\n`
    + `- #74 decision: **${decisions.issue74}**\n`
    + `- #88 decision: **${decisions.issue88}**${flushReport?.decision === "NO_GO" ? " — NO-GO, P3 kalır" : ""}\n`
    + `- Overall hardware valid: **${report.hardwareValid}**\n`
    + `- #74 renderer: ${vendor} / ${renderer}\n`
    + `${formatWebGpuFlushMetadata(flushReport, decisions.issue88)}\n`
    + `- WebGPU canvas presentation: **${flushReport?.presentation ?? "unavailable"}**\n`
    + `- Driver probe: ${report.driverInfo?.source ?? "unavailable"}; ${JSON.stringify(report.driverInfo?.detail ?? null)}\n`
    + `- Host OS: ${report.host?.platform ?? "unknown"} ${report.host?.release ?? ""} (${report.host?.architecture ?? "unknown"})\n`
    + `- Chromium: ${report.browser?.version ?? "unknown"}\n`
    + `- Launch args: \`${(report.browser?.requestedLaunchArgs ?? []).join(" ")}\`\n\n`
    + `- #88 Chromium: ${flushReport?.environment?.browserVersion ?? "unknown"}\n\n`
    + `## #74 fixed decision rule\n\n`
    + `- ${DECISION_RULE.frameRule}\n`
    + `- ${DECISION_RULE.memoryRule}\n`
    + `- ${DECISION_RULE.hardwareRule}\n`
    + `- A software renderer, including SwiftShader, is hardware-invalid and never yields GO/NO-GO.\n\n`
    + `## #74 results\n\n`
    + `| Cells | Charts | Path | Frames | p50 ms | p95 ms | p99 ms | JS heap Δ | Estimated retained | Path ownership |\n`
    + `| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n`
    + `${percentileRows(report)}\n\n`
    + `## #88 fixed decision rule\n\n`
    + `- ${WEBGPU_FLUSH_DECISION_RULE.rule}\n`
    + `- ${WEBGPU_FLUSH_DECISION_RULE.hardwareRule}\n`
    + `- NO-GO means WebGPU remains opt-in and P3; the #200 single-submit coordinator was measured and rejected, and the absolute difference is about 0.1 ms per chart frame.\n`
    + `- Presentation mode is **${flushReport?.presentation ?? "unavailable"}**; the offscreen substitute is used only when real canvas presentation does not work.\n\n`
    + `## #88 measurements\n\n`
    + `| Scenario | Backend | Metric | n | mean ms | p50 ms | p95 ms | p99 ms |\n`
    + `| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |\n`
    + `${flushMarkdownRows(flushReport)}\n\n`
    + `## #88 fixed-rule ratios\n\n`
    + `| Scenario | WebGL2 flush mean ms | WebGPU flush mean ms | WebGPU/WebGL2 ratio | ≤ 2x |\n`
    + `| --- | ---: | ---: | ---: | --- |\n`
    + `${flushRatioRows(flushReport)}\n\n`
    + `#88 decision rationale: ${flushReport?.rationale ?? "measurement unavailable"}\n\n`
    + `## Limitations\n\n`
    + `- GPU memory is a known-resource allocation estimate for the heatmap textures and instance/quad buffers; estimated retained bytes also include any CPU raster cache still held after GPU opt-in. WebGL does not expose a portable dedicated-VRAM counter; driver overhead and allocations outside the heatmap are excluded.\n`
    + `- JavaScript heap data is taken from Chromium \`performance.memory\`; unavailable values are null and prevent a decision.\n`
    + `- GPU frame time includes the engine's CPU prepare path and WebGL submission; it is not a GPU timer query.\n`
    + `- Driver metadata is best effort and null when the host does not expose a supported probe command.\n`;
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

async function runFlushSuite({ outputDir, runId, executablePath }) {
  const evidencePath = resolve(outputDir, `.gpu-flush-${runId}.json`);
  const cliPath = resolve(ROOT, "node_modules/@playwright/test/cli.js");
  await rm(evidencePath, { force: true });
  const child = spawnSync(process.execPath, [
    cliPath,
    "test",
    "tests/browser/webgpu-flush-cost.spec.ts",
    "--project=default",
    "--workers=1",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHART_GPU_BENCHMARK_MODE: "hardware",
      CHART_GPU_BENCHMARK_FLUSH_REPORT_PATH: evidencePath,
      ...(executablePath ? { CHROMIUM_PATH: executablePath } : {}),
    },
    stdio: "inherit",
    timeout: 300_000,
  });

  let flushReport = null;
  try {
    flushReport = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch {
    // A startup failure can happen before the Playwright spec gets a chance to write evidence.
  } finally {
    await rm(evidencePath, { force: true });
  }

  const childFailure = child.error?.message
    ?? (child.status === 0 ? null : `Playwright flush suite exited with status ${child.status ?? "unknown"}`);
  if (!flushReport) {
    return {
      schemaVersion: 1,
      issue: "#88",
      hardwareValid: false,
      decisionRule: WEBGPU_FLUSH_DECISION_RULE,
      decision: "NOT_EVALUATED_INCOMPLETE",
      display: "incomplete",
      rationale: childFailure ?? "Playwright completed without writing flush evidence.",
      browser: { executablePath },
      playwrightExitCode: child.status ?? null,
    };
  }

  const assessment = buildWebGpuFlushAssessment({
    hardwareValid: flushReport.hardwareValid,
    webgl2: flushReport.webgl2,
    webgpu: flushReport.webgpu,
    measurementError: childFailure ?? flushReport.measurementError ?? null,
  });
  return {
    ...flushReport,
    ...assessment,
    playwrightExitCode: child.status ?? null,
    playwrightError: childFailure,
  };
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
    issue: "#74 (Stage 4) + #88 (WebGPU flush)",
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    createdAt: new Date().toISOString(),
    hardwareValid: false,
    stage4HardwareValid: false,
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
    driverInfo: null,
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
  report.stage4HardwareValid = report.hardwareValid;
  report.driverInfo = collectDriverInfo();
  report.webgpuFlush = await runFlushSuite({
    outputDir: options.outputDir,
    runId: report.runId,
    executablePath: report.browser.executablePath,
  });
  report.webgpuFlush.environment = {
    ...report.webgpuFlush.environment,
    host: report.host,
    driverInfo: report.driverInfo,
  };
  report.decisionByIssue = {
    issue74: report.decision,
    issue88: report.webgpuFlush.decision,
  };
  report.hardwareValid = report.stage4HardwareValid && report.webgpuFlush.hardwareValid;

  const fileStem = `gpu-benchmark-${report.runId}`;
  const jsonPath = resolve(options.outputDir, `${fileStem}.json`);
  const markdownPath = resolve(options.outputDir, `${fileStem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, makeMarkdown(report));
  console.log(`hardwareValid=${report.hardwareValid}`);
  console.log(`issue74Decision=${report.decisionByIssue.issue74}`);
  console.log(`issue88Decision=${report.decisionByIssue.issue88}`);
  console.log(`json=${jsonPath}`);
  console.log(`markdown=${markdownPath}`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
