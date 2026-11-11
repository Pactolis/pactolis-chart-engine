import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const moduleSubpaths = [
  "core/dataUpdateEvent",
  "core/analysis/calc/ta",
  "features/chart/ChartDataPipeline",
  "features/chart/ChartSession",
  "features/chart/ChartSyncController",
  "features/chart/heatmap/gpu/heatmapGpuRenderer",
  "features/indicators/seriesMutationSummary",
];

test("issue 107 modules have canonical public testing subpaths", () => {
  for (const moduleSubpath of moduleSubpaths) {
    const exportKey = `./testing/${moduleSubpath}`;
    assert.deepEqual(
      packageJson.exports[exportKey],
      {
        types: `./dist/${moduleSubpath}.d.ts`,
        default: `./dist/${moduleSubpath}.js`,
      },
      `${exportKey} must map types and default to its canonical dist files`,
    );
  }
});
