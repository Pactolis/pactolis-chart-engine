import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testingSubpaths = [
  "core/dataUpdateEvent",
  "core/analysis/calc/ta",
  "features/chart/ChartDataPipeline",
  "features/chart/ChartSession",
  "features/chart/ChartSyncController",
  "features/chart/heatmap/gpu/heatmapGpuRenderer",
  "features/indicators/seriesMutationSummary",
];

test("testing exports resolve from the packed consumer package at runtime and in TypeScript", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "chart-engine-testing-"));
  try {
    const packDir = join(tempRoot, "pack");
    const consumer = join(tempRoot, "consumer");
    const packageDir = join(consumer, "node_modules", "@pactolis", "chart-engine");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(consumer, { recursive: true });

    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    const tarball = join(packDir, "pactolis-chart-engine-0.2.7.tgz");
    assert.ok(readFileSync(tarball).length > 0, "npm pack must produce a tarball");
    mkdirSync(packageDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", packageDir, "--strip-components=1"], { stdio: "pipe" });

    const consumerPackage = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    for (const subpath of testingSubpaths) {
      assert.ok(consumerPackage.exports[`./testing/${subpath}`], `packed exports map includes ./testing/${subpath}`);
    }

    const runtimeScript = join(consumer, "runtime.mjs");
    writeFileSync(runtimeScript, testingSubpaths.map((path, index) =>
      `import * as entry${index} from "@pactolis/chart-engine/testing/${path}";\nif (Object.keys(entry${index}).length === 0) throw new Error("empty export: ${path}");`
    ).join("\n"));
    execFileSync(process.execPath, [runtimeScript], { cwd: consumer, stdio: "pipe" });

    writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
    const typesScript = join(consumer, "consumer.ts");
    writeFileSync(typesScript, [
      'import type { ChartDataUpdateKind } from "@pactolis/chart-engine/testing/core/dataUpdateEvent";',
      'import type { OhlcvInput } from "@pactolis/chart-engine/testing/core/analysis/calc/ta";',
      'import type { ChartDataPipeline } from "@pactolis/chart-engine/testing/features/chart/ChartDataPipeline";',
      'import type { ChartSession } from "@pactolis/chart-engine/testing/features/chart/ChartSession";',
      'import type { ChartSyncController } from "@pactolis/chart-engine/testing/features/chart/ChartSyncController";',
      'import type { HeatmapGpuRenderer } from "@pactolis/chart-engine/testing/features/chart/heatmap/gpu/heatmapGpuRenderer";',
      'import type { IndicatorSeriesMutationSummary } from "@pactolis/chart-engine/testing/features/indicators/seriesMutationSummary";',
      'const kind: ChartDataUpdateKind = "history-loaded";',
      'const bar: OhlcvInput = { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 };',
      'type ConsumerTypes = [ChartDataPipeline, ChartSession, ChartSyncController, HeatmapGpuRenderer, IndicatorSeriesMutationSummary];',
      'const typedValues: [ChartDataUpdateKind, OhlcvInput] = [kind, bar];',
      'void typedValues;',
      'export type { ConsumerTypes };',
    ].join("\n"));
    const tsc = resolve(repoRoot, "node_modules/typescript/bin/tsc");
    try {
      execFileSync(process.execPath, [
        tsc, "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
        "--module", "NodeNext", "--moduleResolution", "NodeNext", typesScript,
      ], { cwd: consumer, stdio: "pipe" });
    } catch (error) {
      const stdout = String(error.stdout ?? "").slice(0, 8000);
      const stderr = String(error.stderr ?? "").slice(0, 8000);
      const fixture = JSON.stringify(JSON.parse(readFileSync(join(consumer, "package.json"), "utf8")));
      assert.fail(`TypeScript consumer failed (exit ${error.status}); consumer package.json=${fixture}; stdout:\n${stdout}\nstderr:\n${stderr}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
