export const WEBGPU_HEATMAP_FIXTURE = Object.freeze({
  barCount: 2000,
  cellsPerBar: 20,
  fitColumns: 120,
  panFrames: 40,
  zoomFrames: 30,
  liveFrames: 30,
  rolloverEveryFrames: 5,
  step: 50,
  basePrice: 60_000,
});

export const WEBGPU_HEATMAP_MODES = Object.freeze(["canvas2d", "webgpu-native"]);
export const WEBGPU_HEATMAP_SCENARIOS = Object.freeze(["pan", "zoom"]);

function parsePositiveInt(raw, fallback, min, max, label) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${label}: ${raw} (expected integer in ${min}..${max})`);
  }
  return n;
}

export function resolveWebGpuHeatmapFixture({
  barCount,
  cellsPerBar,
  fitColumns,
  panFrames,
  zoomFrames,
} = {}) {
  return Object.freeze({
    ...WEBGPU_HEATMAP_FIXTURE,
    barCount: parsePositiveInt(barCount, WEBGPU_HEATMAP_FIXTURE.barCount, 100, 10_000, "barCount"),
    cellsPerBar: parsePositiveInt(cellsPerBar, WEBGPU_HEATMAP_FIXTURE.cellsPerBar, 5, 200, "cellsPerBar"),
    fitColumns: parsePositiveInt(fitColumns, WEBGPU_HEATMAP_FIXTURE.fitColumns, 20, 500, "fitColumns"),
    panFrames: parsePositiveInt(panFrames, WEBGPU_HEATMAP_FIXTURE.panFrames, 2, 200, "panFrames"),
    zoomFrames: parsePositiveInt(zoomFrames, WEBGPU_HEATMAP_FIXTURE.zoomFrames, 2, 200, "zoomFrames"),
  });
}

export function buildWebGpuHeatmapBars(fixture, nowMs = 1_760_000_000_000) {
  const intervalMs = 15 * 60_000;
  const lastTime = Math.floor(nowMs / intervalMs) * intervalMs;
  const firstTime = lastTime - (fixture.barCount - 1) * intervalMs;
  const bars = new Array(fixture.barCount);
  const heatmapBars = new Array(fixture.barCount);
  for (let i = 0; i < fixture.barCount; i++) {
    const t = firstTime + i * intervalMs;
    const low = fixture.basePrice + (i % 15) * fixture.step;
    const high = low + (fixture.cellsPerBar - 1) * fixture.step;
    const open = low + fixture.step;
    const close = low + Math.floor(fixture.cellsPerBar * 0.5) * fixture.step;
    const fCells = new Array(fixture.cellsPerBar);
    const hCells = new Array(fixture.cellsPerBar);
    for (let j = 0; j < fixture.cellsPerBar; j++) {
      const price = low + j * fixture.step;
      const bid = 10 + ((i + j) % 25);
      const ask = 8 + ((i * 3 + j) % 21);
      fCells[j] = [price, bid, ask, 0, 0, Math.min(bid, ask), Math.floor(bid / 2), Math.floor(ask / 2)];
      const btc = 18 + ((i * 7 + j * 11) % 140);
      hCells[j] = [price, btc * price, 0];
    }
    bars[i] = {
      t,
      o: open,
      h: high,
      l: low,
      c: close,
      v: 250,
      d: 18,
      n: 64,
      cells: fCells,
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: nowMs,
    };
    heatmapBars[i] = { t, cells: hCells };
  }
  return { bars, heatmapBars, intervalMs, lastTime };
}

export function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

export function summarizeMetricValues(values) {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0, maxMs: 0 };
  }
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    p50Ms: round4(q(0.5)),
    p95Ms: round4(q(0.95)),
    p99Ms: round4(q(0.99)),
    meanMs: round4(sum / sorted.length),
    maxMs: round4(sorted[sorted.length - 1]),
  };
}

function summarizeScenarioComparison(canvas2dScenario, residentScenario) {
  if (!canvas2dScenario && !residentScenario) return null;
  const cFrameP95 = canvas2dScenario?.frame?.p95Ms ?? 0;
  const rFrameP95 = residentScenario?.frame?.p95Ms ?? 0;
  const cHeatmapP95 = canvas2dScenario?.heatmap?.p95Ms ?? 0;
  const rHeatmapP95 = residentScenario?.heatmap?.p95Ms ?? 0;
  return {
    canvas2d: canvas2dScenario ?? null,
    resident: residentScenario ?? null,
    frameP95Speedup: cFrameP95 > 0 && rFrameP95 > 0 ? round4(cFrameP95 / rFrameP95) : null,
    heatmapP95Speedup: cHeatmapP95 > 0 && rHeatmapP95 > 0 ? round4(cHeatmapP95 / rHeatmapP95) : null,
  };
}

export function evaluateWebGpuHeatmapAssessment({
  hardwareValid = false,
  residentZeroPanZoomUpload,
  residentPrepareCallsDuringPanZoom,
  fallbacks = 0,
  scenarios = {},
  ab = null,
  parity = null,
} = {}) {
  const derivedZeroUpload = residentZeroPanZoomUpload !== undefined
    ? Boolean(residentZeroPanZoomUpload)
    : Boolean(ab?.resident?.pan?.dataBytes === 0 && ab?.resident?.zoom?.dataBytes === 0);
  const derivedPrepareCalls = residentPrepareCallsDuringPanZoom !== undefined
    ? residentPrepareCallsDuringPanZoom
    : ((ab?.resident?.pan?.prepareCount ?? 0) + (ab?.resident?.zoom?.prepareCount ?? 0));

  const abSummary = ab
    ? {
        pan: summarizeScenarioComparison(ab.canvas2d?.pan, ab.resident?.pan),
        zoom: summarizeScenarioComparison(ab.canvas2d?.zoom, ab.resident?.zoom),
      }
    : null;

  const checks = [];
  if (!hardwareValid) checks.push("non-hardware-adapter");
  if (!derivedZeroUpload) checks.push("pan-zoom-data-upload-nonzero");
  if (derivedPrepareCalls !== 0) checks.push("resident-called-prepareReservedGpuCells");
  if (fallbacks > 0) checks.push("runtime-fallbacks-observed");
  if (parity && typeof parity.matchRatio === "number" && parity.matchRatio < 0.98) {
    checks.push("parity-below-threshold");
  }
  const decision = checks.length === 0 ? "PASS" : "INVESTIGATE";
  return { decision, reasons: checks, scenarios, ab: abSummary, parity };
}

function fmtMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function fmtSpeedup(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}x` : "n/a";
}

export function formatWebGpuHeatmapMarkdown(report) {
  const adapter = report.adapter ?? {};
  const lines = [
    `# WebGPU Native Resident Heatmap Benchmark (#265)`,
    ``,
    `- **Run ID:** ${report.runId ?? "n/a"}`,
    `- **Created At:** ${report.createdAt ?? "n/a"}`,
    `- **Fixture:** ${report.fixture?.barCount ?? 0} bars x ${report.fixture?.cellsPerBar ?? 0} cells = ${(report.fixture?.barCount ?? 0) * (report.fixture?.cellsPerBar ?? 0)} cells`,
    `- **Adapter:** ${adapter.description ?? adapter.vendor ?? "unavailable"} (fallback: ${adapter.isFallbackAdapter ?? "unknown"})`,
    `- **Hardware Valid:** ${Boolean(report.hardwareValid)}`,
    `- **Decision:** ${report.assessment?.decision ?? "UNKNOWN"}`,
    `- **Reasons:** ${(report.assessment?.reasons ?? []).join(", ") || "none"}`,
    ``,
    `## Pan / Zoom Upload & CPU Prepare`,
    ``,
    `- Resident pan/zoom dataBytes: ${report.residentPanZoomDataBytes ?? "n/a"}`,
    `- Resident pan/zoom uniformBytes: ${report.residentPanZoomUniformBytes ?? "n/a"}`,
    `- Resident pan/zoom prepare.ms count: ${report.residentPanZoomPrepareCount ?? "n/a"}`,
    `- Canvas2D vs WebGPU-Native Parity: ${report.parity?.matchRatio !== undefined ? `${(report.parity.matchRatio * 100).toFixed(2)}% (nonBg=${report.parity.nonBg ?? 0})` : "n/a"}`,
  ];

  const abSummary = report.assessment?.ab;
  if (abSummary) {
    lines.push(
      ``,
      `## A/B Comparison (\`canvas2d\` vs \`webgpu-native\`)`,
      ``,
      `| Scenario | Path | Frame p50 (ms) | Frame p95 (ms) | Frame p95 Speedup | Heatmap p50 (ms) | Heatmap p95 (ms) | Heatmap p95 Speedup | rAF Missed | Data Upload (B) | Uniform Upload (B) | Prepare Count |`,
      `| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    );
    for (const scenarioName of WEBGPU_HEATMAP_SCENARIOS) {
      const entry = abSummary[scenarioName];
      if (!entry) continue;
      if (entry.canvas2d) {
        const c = entry.canvas2d;
        lines.push(
          `| ${scenarioName} | canvas2d | ${fmtMs(c.frame?.p50Ms)} | ${fmtMs(c.frame?.p95Ms)} | baseline | ${fmtMs(c.heatmap?.p50Ms)} | ${fmtMs(c.heatmap?.p95Ms)} | baseline | ${c.rafMissed ?? 0} | ${c.dataBytes ?? 0} | ${c.uniformBytes ?? 0} | ${c.prepareCount ?? 0} |`,
        );
      }
      if (entry.resident) {
        const r = entry.resident;
        lines.push(
          `| ${scenarioName} | webgpu-native | ${fmtMs(r.frame?.p50Ms)} | ${fmtMs(r.frame?.p95Ms)} | ${fmtSpeedup(entry.frameP95Speedup)} | ${fmtMs(r.heatmap?.p50Ms)} | ${fmtMs(r.heatmap?.p95Ms)} | ${fmtSpeedup(entry.heatmapP95Speedup)} | ${r.rafMissed ?? 0} | ${r.dataBytes ?? 0} | ${r.uniformBytes ?? 0} | ${r.prepareCount ?? 0} |`,
        );
      }
    }
  }

  return lines.join("\n");
}
