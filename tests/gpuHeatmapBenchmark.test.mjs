import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/gpu-heatmap-benchmark.mjs");

function run(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("GPU heatmap benchmark list is the complete fixed workload matrix", () => {
  const lines = run("--list").split("\n");
  assert.equal(lines.length, 12);
  for (const cells of ["15000", "40000"]) {
    for (const charts of ["1", "8"]) {
      for (const phase of ["cpu-cold", "cpu-hot", "gpu"]) {
        assert.ok(lines.some((line) => line.startsWith(`${cells} cells | ${charts} chart(s) | ${phase} |`)));
      }
    }
  }
});

test("GPU heatmap benchmark dry run pins the pre-measurement decision rule", () => {
  const plan = JSON.parse(run("--dry-run"));
  assert.equal(plan.measurementEnabled, false);
  assert.equal(plan.scenarioCount, 12);
  assert.equal(plan.decisionRule.requiredP95Ratio, 0.8);
  assert.match(plan.decisionRule.memoryRule, /8-chart GPU estimated retained bytes must not exceed 8-chart CPU-hot/);
  assert.ok(plan.launchArgs.includes("--use-angle=default"));
  assert.ok(!plan.launchArgs.includes("--use-angle=swiftshader-webgl"));
});
