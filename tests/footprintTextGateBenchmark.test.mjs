import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFootprintTextGate,
  FOOTPRINT_TEXT_AB_MODES,
  FOOTPRINT_TEXT_GATE_RULE,
  FOOTPRINT_TEXT_MARKETS,
  FOOTPRINT_TEXT_METRICS,
  formatFootprintTextMarkdown,
  resolveFootprintTextFixture,
  summarizeFootprintTextAbComparison,
} from "../harness/footprintTextGateBenchmark.mjs";
import { parseArgs } from "../scripts/footprint-text-gate-benchmark.mjs";

function makeEntry({
  chartCount = 4,
  textMode = "full",
  scenario = "pan",
  frameP50 = 2.0,
  frameP95 = 4.0,
  frameMean = 2.5,
  frameTotal = 250,
  textP50 = 0.6,
  textP95 = 1.0,
  textMean = 0.7,
  textTotal = 70,
  annotationP95 = 1.2,
  gpuDrawP95 = 0.8,
  reuseCount = 0,
} = {}) {
  return {
    chartCount,
    textMode,
    scenario,
    reuseCount,
    totalFrames: 100,
    combined: {
      "chart.frame.render.ms": { count: 100, meanMs: frameMean, totalMs: frameTotal, p50Ms: frameP50, p95Ms: frameP95, p99Ms: frameP95 * 1.1 },
      "chart.surface.gpu.draw.ms": { count: 100, meanMs: gpuDrawP95 * 0.7, totalMs: gpuDrawP95 * 70, p50Ms: gpuDrawP95 * 0.7, p95Ms: gpuDrawP95, p99Ms: gpuDrawP95 * 1.1 },
      "chart.surface.annotation.draw.ms": { count: 100, meanMs: annotationP95 * 0.7, totalMs: annotationP95 * 70, p50Ms: annotationP95 * 0.7, p95Ms: annotationP95, p99Ms: annotationP95 * 1.1 },
      "chart.annotation.layer.footprint-text.ms": { count: 100, meanMs: textMean, totalMs: textTotal, p50Ms: textP50, p95Ms: textP95, p99Ms: textP95 * 1.1 },
      "chart.annotation.layer.axis.ms": { count: 100, meanMs: 0.1, totalMs: 10, p50Ms: 0.1, p95Ms: 0.15, p99Ms: 0.2 },
      "chart.annotation.setup.ms": { count: 100, meanMs: 0.05, totalMs: 5, p50Ms: 0.05, p95Ms: 0.08, p99Ms: 0.1 },
    },
  };
}

test("resolveFootprintTextFixture handles hardware, fast CI smoke, and bounded chartCounts", () => {
  assert.equal(FOOTPRINT_TEXT_GATE_RULE.name, "footprint-text-glyph-atlas-gate");
  assert.equal(FOOTPRINT_TEXT_GATE_RULE.minTextShareOfFrameP95, 0.30);
  assert.equal(FOOTPRINT_TEXT_MARKETS.length, 8);
  assert.ok(FOOTPRINT_TEXT_METRICS.includes("chart.annotation.layer.footprint-text.ms"));

  const hw = resolveFootprintTextFixture({ hardwareMode: true });
  assert.equal(hw.barCount, 2500);
  assert.equal(hw.cellsPerBar, 120);
  assert.deepEqual(hw.chartCounts, [4, 8]);
  assert.deepEqual(hw.textModes, ["full", "compact"]);
  assert.equal(hw.panFrames, 35);
  assert.equal(hw.zoomFrames, 35);
  assert.equal(hw.liveFrames, 30);

  const ci = resolveFootprintTextFixture({ hardwareMode: false });
  assert.equal(ci.barCount, 200);
  assert.equal(ci.cellsPerBar, 40);
  assert.deepEqual(ci.chartCounts, [4]);
  assert.deepEqual(ci.textModes, ["full"]);
  assert.equal(ci.panFrames, 10);

  const custom = resolveFootprintTextFixture({ hardwareMode: true, chartCounts: "8,4,8" });
  assert.deepEqual(custom.chartCounts, [8, 4]);

  assert.throws(() => resolveFootprintTextFixture({ hardwareMode: true, chartCounts: "0" }), /Invalid chartCount/);
  assert.throws(() => resolveFootprintTextFixture({ hardwareMode: true, chartCounts: "9" }), /Invalid chartCount/);
  assert.throws(() => resolveFootprintTextFixture({ hardwareMode: true, chartCounts: "," }), /must not be empty/);
});

test("evaluateFootprintTextGate decides HARDWARE_INVALID, PROCEED_GLYPH_ATLAS, and DEFER_NOT_NEEDED", () => {
  const invalid = evaluateFootprintTextGate({
    hardwareValid: false,
    entries: [makeEntry({ frameP95: 4.0, textP95: 2.0 })],
  });
  assert.equal(invalid.decision, "HARDWARE_INVALID");
  assert.equal(invalid.maxPanZoomTextShareP95, 0.5);

  const proceed = evaluateFootprintTextGate({
    hardwareValid: true,
    entries: [
      makeEntry({ chartCount: 4, textMode: "full", scenario: "pan", frameP95: 10.0, textP95: 2.5 }),
      makeEntry({ chartCount: 8, textMode: "compact", scenario: "zoom", frameP95: 10.0, textP95: 3.5, frameTotal: 500, textTotal: 150, reuseCount: 2 }),
      makeEntry({ chartCount: 8, textMode: "compact", scenario: "live", frameP95: 5.0, textP95: 0.4 }),
    ],
  });
  assert.equal(proceed.decision, "PROCEED_GLYPH_ATLAS");
  assert.equal(proceed.maxPanZoomTextShareP95, 0.35);
  assert.equal(proceed.rows[1].textShareOfFrameP95, 0.35);
  assert.equal(proceed.rows[1].textShareOfTotal, 0.3);
  assert.equal(proceed.rows[1].reuseCount, 2);

  // Live >= 0.30 does not trigger PROCEED_GLYPH_ATLAS when pan/zoom are below 0.30
  const defer = evaluateFootprintTextGate({
    hardwareValid: true,
    entries: [
      makeEntry({ chartCount: 4, textMode: "full", scenario: "pan", frameP95: 10.0, textP95: 2.0 }),
      makeEntry({ chartCount: 8, textMode: "compact", scenario: "zoom", frameP95: 10.0, textP95: 2.9 }),
      makeEntry({ chartCount: 8, textMode: "compact", scenario: "live", frameP95: 4.0, textP95: 2.0 }),
    ],
  });
  assert.equal(defer.decision, "DEFER_NOT_NEEDED");
  assert.equal(defer.maxPanZoomTextShareP95, 0.29);
});

test("formatFootprintTextMarkdown renders Turkish gate table and CLI parseArgs handles options", () => {
  const gate = evaluateFootprintTextGate({
    hardwareValid: true,
    entries: [
      makeEntry({ chartCount: 4, textMode: "full", scenario: "pan", frameP50: 3.1, frameP95: 6.0, textP50: 1.5, textP95: 2.4, reuseCount: 4 }),
    ],
  });
  const md = formatFootprintTextMarkdown({
    runId: "gate-test-run",
    hardwareValid: true,
    environment: {
      browserVersion: "158.0",
      operatingSystem: "win32 x64",
      webgpuAdapter: { vendor: "intel", architecture: "gen-9", description: "UHD 620", isFallbackAdapter: false },
      webglRenderer: { unmaskedVendor: "Intel", unmaskedRenderer: "UHD 620" },
    },
    featurePathsByChartCount: { "4": { scene: "webgpu-native" } },
    ...gate,
  });

  assert.match(md, /PROCEED_GLYPH_ATLAS/);
  assert.match(md, /\| 4 \| full \| pan \|/);
  assert.match(md, /webgpu-native/);
  assert.match(md, /40\.0%/);

  assert.equal(parseArgs(["--list"]).list, true);
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(parseArgs(["--charts", "4"]).fixture.chartCounts, [4]);
  assert.ok(parseArgs(["--output-dir", "gpu-rapor"]).outputDir.endsWith("gpu-rapor"));
  assert.throws(() => parseArgs(["--list", "--dry-run"]));
  assert.throws(() => parseArgs(["--charts", "12"]));
  assert.throws(() => parseArgs(["--unknown"]));

  assert.deepEqual(FOOTPRINT_TEXT_AB_MODES, ["canvas2d", "webgpu-sdf"]);
  assert.ok(FOOTPRINT_TEXT_METRICS.includes("chart.gpu.native.text.ms"));

  const ab = summarizeFootprintTextAbComparison(
    [makeEntry({ chartCount: 4, textMode: "full", scenario: "pan", frameP95: 8.0, frameMean: 5.0, textP95: 4.0 })],
    [{
      ...makeEntry({ chartCount: 4, textMode: "full", scenario: "pan", frameP95: 2.0, frameMean: 1.5, textP95: 0.01 }),
      nativeText: { count: 100, meanMs: 0.2, totalMs: 20, p50Ms: 0.2, p95Ms: 0.3, p99Ms: 0.4 },
    }],
  );
  assert.equal(ab.rows.length, 1);
  assert.equal(ab.rows[0].frameP95Speedup, 4);
  assert.equal(ab.rows[0].sdfNativeTextP95Ms, 0.3);
  const abMd = formatFootprintTextMarkdown({ ...gate, abComparison: ab });
  assert.match(abMd, /A\/B Karşılaştırması/);
  assert.match(abMd, /4\.00×/);
});
