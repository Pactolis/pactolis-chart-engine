import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CENSUS_SPEC, selectTests, specClosures } from "../scripts/select-ci-tests.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const closures = specClosures(root);
const defaultSpecs = [...closures.keys()].filter((spec) => spec !== CENSUS_SPEC);

test("every browser spec reaches itself and the census spec reaches the harness", () => {
  assert.ok(closures.size > 1);
  for (const [spec, closure] of closures) assert.ok(closure.has(spec), `${spec} reaches itself`);
  assert.ok(closures.get(CENSUS_SPEC)?.has("harness/chart.ts"));
});

test("docs, Node unit tests and other workflows select no browser test", () => {
  const result = selectTests(["md/TESTING.md", "README.md", "tests/footprint.test.mjs", ".github/workflows/release.yml"], closures);
  assert.equal(result.browser, "none");
  assert.equal(result.census, false);
});

test("a changed browser spec selects only that spec", () => {
  const spec = defaultSpecs[0];
  const result = selectTests([spec], closures);
  assert.equal(result.browser, "list");
  assert.deepEqual(result.specs, [spec]);
  assert.equal(result.census, false);
});

test("a changed census spec runs census only", () => {
  const result = selectTests([CENSUS_SPEC], closures);
  assert.equal(result.browser, "none");
  assert.equal(result.census, true);
});

test("engine source runs every browser test, including harness-driven specs (ChartRuntime regression)", () => {
  // These specs reach ChartRuntime only at runtime through page.goto("/harness/...").
  for (const file of ["src/features/chart/ChartRuntime.ts", "src/features/chart/ChartDataPipeline.ts", "src/core/analysis/topTradingDays.ts"]) {
    const result = selectTests([file], closures);
    assert.equal(result.browser, "all", file);
    assert.equal(result.census, true, file);
  }
});

test("shared browser test support runs every browser test", () => {
  for (const file of ["tests/browser/support/history.ts", "tests/browser/support/touchRig.ts"]) {
    const result = selectTests([file], closures);
    assert.equal(result.browser, "all", file);
    assert.equal(result.census, true, file);
  }
});

test("fail-safe: shared config, unreached sources, unknown paths and odd names run everything", () => {
  for (const changed of [
    ["package-lock.json"],
    ["harness/index.html"],
    [".github/workflows/ci.yml"],
    ["scripts/select-ci-tests.mjs"],
    ["src/brand-new-module.ts"],
    ["something/unknown.txt"],
    ["tests/browser/x;rm -rf ~.spec.ts"],
    [],
  ]) {
    const result = selectTests(changed, closures);
    assert.equal(result.browser, "all", JSON.stringify(changed));
    assert.equal(result.census, true, JSON.stringify(changed));
  }
});

test("selected spec names are safe to pass on a command line", () => {
  for (const spec of closures.keys()) assert.match(spec, /^[A-Za-z0-9._/-]+$/);
});
