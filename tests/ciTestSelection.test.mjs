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

test("a changed census spec runs census (and Tam) only", () => {
  const result = selectTests([CENSUS_SPEC], closures);
  assert.equal(result.browser, "none");
  assert.equal(result.census, true);
});

test("a source file selects exactly the specs whose import closure contains it", () => {
  const file = "src/features/chart/ChartDataPipeline.ts";
  const expected = defaultSpecs.filter((spec) => closures.get(spec)?.has(file)).sort();
  assert.ok(expected.length > 0);
  const result = selectTests([file], closures);
  assert.equal(result.census, closures.get(CENSUS_SPEC)?.has(file));
  if (expected.length === defaultSpecs.length) assert.equal(result.browser, "all");
  else assert.deepEqual(result.specs, expected);
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
