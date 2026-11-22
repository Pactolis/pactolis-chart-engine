#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildHeatmapPanScenarios,
  HEATMAP_PAN_DECISION_RULE,
  HEATMAP_PAN_FIXTURE,
  makeHeatmapPanMarkdown,
} from "../harness/heatmapPanBenchmark.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "benchmark-results/heatmap-pan-benchmark");

export function usage() {
  console.log(`Usage: npm run benchmark:heatmap-pan -- [options]

Options:
  --output-dir PATH  Write JSON and Markdown reports here (default: benchmark-results/heatmap-pan-benchmark)
  --list             List the #260/#256 preset & motion scenarios, then exit
  --dry-run          Validate the preset matrix and guardrail rules without launching Chromium
  --help             Show this help

Hardware benchmark command:
  npm run benchmark:heatmap-pan -- --output-dir gpu-rapor

Set CHROMIUM_PATH to select Chromium. Software renderers (such as SwiftShader)
are marked hardwareValid=false and produce NOT_EVALUATED_HARDWARE_INVALID.`);
}

export function parseArgs(argv) {
  const options = { outputDir: DEFAULT_OUTPUT_DIR, list: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      if (!argv[index + 1]) throw new Error("--output-dir requires a path");
      options.outputDir = resolve(argv[++index]);
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.list && options.dryRun) throw new Error("Choose either --list or --dry-run");
  return options;
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

function printPlan(listOnly) {
  const scenarios = buildHeatmapPanScenarios();
  if (listOnly) {
    for (const s of scenarios) {
      const opacityLabel = s.mode === "off" ? "off" : `${Math.round(s.opacity * 100)}%`;
      const scaleLabel = s.scaleMode === "fixed" ? `fixed(${s.fixedCeilingBtc} BTC)` : `auto(${s.contrast})`;
      console.log(`${s.issue} | ${s.chartCount} chart(s) | ${opacityLabel} | ${scaleLabel} | ${s.phases.join(",")}`);
    }
    return;
  }
  console.log(JSON.stringify({
    scenarioCount: scenarios.length,
    fixture: HEATMAP_PAN_FIXTURE,
    decisionRule: HEATMAP_PAN_DECISION_RULE,
    scenarios,
    measurementEnabled: false,
  }, null, 2));
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
    printPlan(options.list);
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = resolve(options.outputDir, `.heatmap-pan-${runId}.json`);
  const cliPath = resolve(ROOT, "node_modules/@playwright/test/cli.js");
  const executablePath = process.env.CHROMIUM_PATH || firstSystemChromium();

  await rm(evidencePath, { force: true });
  const child = spawnSync(process.execPath, [
    cliPath,
    "test",
    "tests/browser/heatmap-pan-benchmark.spec.ts",
    "--project=heatmap-pan-benchmark",
    "--workers=1",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHART_GPU_BENCHMARK_MODE: "hardware",
      HEATMAP_PAN_BENCHMARK_REPORT_PATH: evidencePath,
      ...(executablePath ? { CHROMIUM_PATH: executablePath } : {}),
    },
    stdio: "inherit",
    timeout: 300_000,
  });

  let report = null;
  try {
    report = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch {
    report = null;
  } finally {
    await rm(evidencePath, { force: true });
  }

  if (!report) {
    const message = child.error?.message ?? `Playwright benchmark exited with status ${child.status ?? "unknown"}`;
    throw new Error(message);
  }

  report.runId = report.runId ?? runId;
  const stem = `heatmap-pan-benchmark-${report.runId}`;
  const jsonPath = resolve(options.outputDir, `${stem}.json`);
  const markdownPath = resolve(options.outputDir, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, makeHeatmapPanMarkdown(report));
  console.log(`hardwareValid=${Boolean(report.hardwareValid)}`);
  console.log(`decision=${report.decision ?? "NOT_EVALUATED_HARDWARE_INVALID"}`);
  console.log(`json=${jsonPath}`);
  console.log(`markdown=${markdownPath}`);
  if (child.status !== 0) {
    process.exitCode = child.status ?? 1;
  }
}

export { makeHeatmapPanMarkdown };

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
