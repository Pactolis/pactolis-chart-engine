#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildWebGpuNativeAssessment,
  formatWebGpuNativeMarkdown,
  WEBGPU_NATIVE_FIXTURE,
  WEBGPU_NATIVE_METRICS,
  WEBGPU_NATIVE_MODES,
  WEBGPU_NATIVE_SCENARIOS,
} from "../harness/webgpuNativeBenchmark.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "benchmark-results/webgpu-native");

function usage() {
  console.log(`Usage: npm run benchmark:webgpu-native -- [options]

Options:
  --output-dir PATH  Write JSON and Markdown reports here (default: benchmark-results/webgpu-native)
  --list             List the #258 WebGPU immediate vs gpu-native scenarios, then exit
  --dry-run          Print fixture, metrics and plan JSON without launching Chromium
  --help             Show this help

Example:
  npm run benchmark:webgpu-native -- --output-dir gpu-rapor`);
}

export function parseArgs(argv) {
  const options = { outputDir: DEFAULT_OUTPUT_DIR, list: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output-dir") {
      if (!argv[i + 1]) throw new Error("--output-dir requires a path");
      options.outputDir = resolve(argv[++i]);
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
  if (options.list && options.dryRun) {
    throw new Error("Choose either --list or --dry-run");
  }
  return options;
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function printPlan(listOnly) {
  const items = WEBGPU_NATIVE_SCENARIOS.flatMap((scenario) =>
    WEBGPU_NATIVE_MODES.map((mode) => ({
      issue: "#258",
      scenario,
      mode,
      charts: WEBGPU_NATIVE_FIXTURE.markets.length,
      viewport: `${WEBGPU_NATIVE_FIXTURE.viewport.width}x${WEBGPU_NATIVE_FIXTURE.viewport.height}`,
      bars: WEBGPU_NATIVE_FIXTURE.barCount,
      cellsPerBar: WEBGPU_NATIVE_FIXTURE.cellsPerBar,
      metrics: WEBGPU_NATIVE_METRICS,
    })),
  );
  if (listOnly) {
    for (const item of items) {
      console.log(`#258 ${item.scenario} | ${item.mode} | ${item.charts} charts (${item.viewport}) | ${item.bars}x${item.cellsPerBar}`);
    }
    return;
  }
  console.log(JSON.stringify({
    issue: "#258",
    scenarioCount: items.length,
    scenarios: items,
    fixture: WEBGPU_NATIVE_FIXTURE,
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
  const evidencePath = resolve(options.outputDir, `.webgpu-native-${runId}.json`);
  const cliPath = resolve(ROOT, "node_modules/@playwright/test/cli.js");
  await rm(evidencePath, { force: true });

  const child = spawnSync(process.execPath, [
    cliPath,
    "test",
    "tests/browser/webgpu-native-poc.spec.ts",
    "--project=default",
    "--workers=1",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHART_GPU_BENCHMARK_MODE: "hardware",
      CHART_GPU_NATIVE_REPORT_PATH: evidencePath,
    },
    stdio: "inherit",
    timeout: 300_000,
  });

  let rawReport = null;
  try {
    rawReport = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch {
    rawReport = null;
  } finally {
    await rm(evidencePath, { force: true });
  }

  const childError = child.error?.message
    ?? (child.status === 0 ? null : `Playwright exited with status ${child.status ?? "unknown"}`);

  const baseMeta = {
    runId,
    createdAt: new Date().toISOString(),
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
  };

  const report = rawReport
    ? { ...baseMeta, ...rawReport }
    : {
        ...baseMeta,
        schemaVersion: 1,
        issue: "#258",
        hardwareValid: false,
        hardwareInvalidReasons: ["measurement-unavailable"],
        timestampQuerySupported: false,
        presentation: "unavailable",
        ...buildWebGpuNativeAssessment({ hardwareValid: false, measurementError: childError }),
      };

  const stem = `webgpu-native-benchmark-${runId}`;
  const jsonPath = resolve(options.outputDir, `${stem}.json`);
  const mdPath = resolve(options.outputDir, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, `${formatWebGpuNativeMarkdown(report)}\n`, "utf8");

  console.log(`decision=${report.decision}`);
  console.log(`hardwareValid=${report.hardwareValid}`);
  console.log(`json=${jsonPath}`);
  console.log(`markdown=${mdPath}`);
  if (child.status !== 0 && !rawReport) {
    process.exitCode = child.status ?? 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
