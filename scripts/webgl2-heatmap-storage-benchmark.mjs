#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateWebGl2StorageDecision,
  formatWebGl2HeatmapStorageMarkdown,
  resolveWebGl2HeatmapStorageFixture,
  WEBGL2_HEATMAP_STORAGE_VARIANTS,
  WEBGL2_HEATMAP_STORAGE_WORKLOADS,
} from "../harness/webgl2HeatmapStorageBenchmark.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "benchmark-results/webgl2-heatmap-storage");

function usage() {
  console.log(`Usage: npm run benchmark:webgl2-heatmap-storage -- [options]

Options:
  --output-dir PATH  Write JSON and Markdown reports here (default: benchmark-results/webgl2-heatmap-storage)
  --charts LIST      Comma-separated chart counts (default: 1,8 in hardware mode)
  --list             Print variants, workloads and fixture plan, then exit
  --dry-run          Print benchmark plan JSON without launching Chromium
  --help             Show this help`);
}

export function parseArgs(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    charts: null,
    list: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output-dir") {
      if (!argv[i + 1]) throw new Error("--output-dir requires a path");
      options.outputDir = resolve(argv[++i]);
    } else if (arg === "--charts") {
      if (!argv[i + 1]) throw new Error("--charts requires comma-separated integers");
      options.charts = argv[++i];
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
  options.fixture = resolveWebGl2HeatmapStorageFixture({
    hardwareMode: true,
    chartCounts: options.charts,
  });
  return options;
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.list) {
    console.log(JSON.stringify({
      issue: "#257",
      variants: WEBGL2_HEATMAP_STORAGE_VARIANTS,
      workloads: WEBGL2_HEATMAP_STORAGE_WORKLOADS,
      fixture: options.fixture,
    }, null, 2));
    return;
  }
  if (options.dryRun) {
    console.log(JSON.stringify({
      issue: "#257",
      variants: WEBGL2_HEATMAP_STORAGE_VARIANTS,
      workloads: WEBGL2_HEATMAP_STORAGE_WORKLOADS,
      fixture: options.fixture,
      outputDir: options.outputDir,
    }, null, 2));
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = resolve(options.outputDir, `.raw-${runId}.json`);
  const cliPath = resolve(ROOT, "node_modules/@playwright/test/cli.js");

  const child = spawnSync(process.execPath, [
    cliPath,
    "test",
    "tests/browser/webgl2-heatmap-storage-benchmark.spec.ts",
    "--project=default",
    "--workers=1",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHART_GPU_BENCHMARK_MODE: "hardware",
      CHART_WEBGL2_STORAGE_REPORT_PATH: evidencePath,
      ...(options.charts ? { CHART_WEBGL2_STORAGE_CHARTS: options.charts } : {}),
    },
    stdio: "inherit",
    timeout: 600_000,
  });

  let rawReport = null;
  try {
    rawReport = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch {
    rawReport = null;
  } finally {
    await rm(evidencePath, { force: true });
  }

  const report = rawReport
    ? {
        runId,
        createdAt: new Date().toISOString(),
        fixture: options.fixture,
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
        ...rawReport,
      }
    : {
        runId,
        createdAt: new Date().toISOString(),
        fixture: options.fixture,
        hardwareValid: false,
        rows: [],
        assessment: evaluateWebGl2StorageDecision({ hardwareValid: false, rows: [] }),
      };

  const stem = `webgl2-heatmap-storage-${runId}`;
  const jsonPath = resolve(options.outputDir, `${stem}.json`);
  const mdPath = resolve(options.outputDir, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, `${formatWebGl2HeatmapStorageMarkdown(report)}\n`, "utf8");

  console.log(`hardwareValid=${Boolean(report.hardwareValid)}`);
  console.log(`decision=${report.assessment?.decision ?? "unknown"}`);
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
