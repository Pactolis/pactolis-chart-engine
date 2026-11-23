#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateWebGpuHeatmapAssessment,
  formatWebGpuHeatmapMarkdown,
  resolveWebGpuHeatmapFixture,
  WEBGPU_HEATMAP_MODES,
  WEBGPU_HEATMAP_SCENARIOS,
} from "../harness/webgpuNativeHeatmapBenchmark.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "benchmark-results/webgpu-heatmap");

function usage() {
  console.log(`Usage: npm run benchmark:webgpu-heatmap -- [options]

Options:
  --bars N           Override barCount (default: 2000)
  --cells N          Override cellsPerBar (default: 20)
  --fit N            Override fitColumns (default: 120)
  --output-dir PATH  Write JSON and Markdown reports here (default: benchmark-results/webgpu-heatmap)
  --list             Print scenarios and modes, then exit
  --dry-run          Print plan JSON without launching Chromium
  --help             Show this help`);
}

export function parseArgs(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    bars: null,
    cells: null,
    fit: null,
    list: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output-dir") {
      if (!argv[i + 1]) throw new Error("--output-dir requires a path");
      options.outputDir = resolve(argv[++i]);
    } else if (arg === "--bars") {
      options.bars = argv[++i];
    } else if (arg === "--cells") {
      options.cells = argv[++i];
    } else if (arg === "--fit") {
      options.fit = argv[++i];
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
  options.fixture = resolveWebGpuHeatmapFixture({
    barCount: options.bars,
    cellsPerBar: options.cells,
    fitColumns: options.fit,
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
    console.log(JSON.stringify({ fixture: options.fixture, modes: WEBGPU_HEATMAP_MODES, scenarios: WEBGPU_HEATMAP_SCENARIOS }, null, 2));
    return;
  }
  if (options.dryRun) {
    console.log(JSON.stringify({
      issue: "#265",
      fixture: options.fixture,
      modes: WEBGPU_HEATMAP_MODES,
      scenarios: WEBGPU_HEATMAP_SCENARIOS,
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
    "tests/browser/webgpu-native-heatmap.spec.ts",
    "--project=default",
    "--workers=1",
    "--grep",
    "40k-cell resident vs immediate heatmap benchmark",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHART_GPU_BENCHMARK_MODE: "hardware",
      CHART_GPU_HEATMAP_REPORT_PATH: evidencePath,
      CHART_GPU_HEATMAP_BARS: String(options.fixture.barCount),
      CHART_GPU_HEATMAP_CELLS: String(options.fixture.cellsPerBar),
      CHART_GPU_HEATMAP_FIT: String(options.fixture.fitColumns),
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
        assessment: evaluateWebGpuHeatmapAssessment({ hardwareValid: false }),
      };

  const stem = `webgpu-native-heatmap-${runId}`;
  const jsonPath = resolve(options.outputDir, `${stem}.json`);
  const mdPath = resolve(options.outputDir, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, `${formatWebGpuHeatmapMarkdown(report)}\n`, "utf8");

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
