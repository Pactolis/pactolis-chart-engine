#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateFootprintTextGate,
  FOOTPRINT_TEXT_GATE_RULE,
  FOOTPRINT_TEXT_METRICS,
  FOOTPRINT_TEXT_SCENARIOS,
  formatFootprintTextMarkdown,
  resolveFootprintTextFixture,
} from "../harness/footprintTextGateBenchmark.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "benchmark-results/footprint-text-gate");

function usage() {
  console.log(`Usage: npm run benchmark:footprint-text -- [options]

Options:
  --output-dir PATH  Write JSON and Markdown reports here (default: benchmark-results/footprint-text-gate)
  --charts LIST      Comma-separated chart counts in 1..8 (default: 4,8)
  --list             List #266 footprint text gate scenarios, then exit
  --dry-run          Print resolved fixture, metrics and gate rule JSON without launching Chromium
  --help             Show this help

Example:
  npm run benchmark:footprint-text -- --output-dir gpu-rapor`);
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
      if (!argv[i + 1]) throw new Error("--charts requires a comma-separated list (e.g. 4,8)");
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
  options.fixture = resolveFootprintTextFixture({
    hardwareMode: true,
    chartCounts: options.charts,
  });
  return options;
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function printPlan(listOnly, fixture) {
  const items = fixture.chartCounts.flatMap((chartCount) =>
    fixture.textModes.flatMap((textMode) =>
      FOOTPRINT_TEXT_SCENARIOS.map((scenario) => ({
        issue: "#266",
        chartCount,
        textMode,
        scenario,
        bars: fixture.barCount,
        cellsPerBar: fixture.cellsPerBar,
        viewport: `${fixture.viewport.width}x${fixture.viewport.height}`,
        metrics: FOOTPRINT_TEXT_METRICS,
      })),
    ),
  );
  if (listOnly) {
    for (const item of items) {
      console.log(`#266 ${item.chartCount} charts | ${item.textMode} | ${item.scenario} | ${item.bars}x${item.cellsPerBar}`);
    }
    return;
  }
  console.log(JSON.stringify({
    issue: "#266",
    rule: FOOTPRINT_TEXT_GATE_RULE,
    fixture,
    scenarioCount: items.length,
    scenarios: items,
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
    printPlan(options.list, options.fixture);
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = resolve(options.outputDir, `.footprint-text-gate-${runId}.json`);
  const cliPath = resolve(ROOT, "node_modules/@playwright/test/cli.js");
  await rm(evidencePath, { force: true });

  const child = spawnSync(process.execPath, [
    cliPath,
    "test",
    "tests/browser/footprint-text-gate.spec.ts",
    "--project=default",
    "--workers=1",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHART_GPU_BENCHMARK_MODE: "hardware",
      CHART_FOOTPRINT_TEXT_REPORT_PATH: evidencePath,
      CHART_FOOTPRINT_TEXT_CHARTS: options.fixture.chartCounts.join(","),
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

  const childError = child.error?.message
    ?? (child.status === 0 ? null : `Playwright exited with status ${child.status ?? "unknown"}`);

  const baseMeta = {
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
  };

  const report = rawReport
    ? { ...baseMeta, ...rawReport }
    : {
        ...baseMeta,
        schemaVersion: 1,
        issue: "#266",
        hardwareValid: false,
        hardwareInvalidReasons: ["measurement-unavailable"],
        ...evaluateFootprintTextGate({
          hardwareValid: false,
          entries: [],
          measurementError: childError,
        }),
      };

  const stem = `footprint-text-gate-${runId}`;
  const jsonPath = resolve(options.outputDir, `${stem}.json`);
  const mdPath = resolve(options.outputDir, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, `${formatFootprintTextMarkdown(report)}\n`, "utf8");

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
