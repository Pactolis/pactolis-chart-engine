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

export const WEBGPU_HEATMAP_MODES = Object.freeze(["immediate", "resident"]);
export const WEBGPU_HEATMAP_SCENARIOS = Object.freeze(["pan", "zoom", "live", "live-rollover"]);

function parsePositiveInt(raw, fallback, min, max, label) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${label}: ${raw} (expected integer in ${min}..${max})`);
  }
  return n;
}

export function resolveWebGpuHeatmapFixture({ barCount, cellsPerBar, fitColumns } = {}) {
  return Object.freeze({
    ...WEBGPU_HEATMAP_FIXTURE,
    barCount: parsePositiveInt(barCount, WEBGPU_HEATMAP_FIXTURE.barCount, 100, 10_000, "barCount"),
    cellsPerBar: parsePositiveInt(cellsPerBar, WEBGPU_HEATMAP_FIXTURE.cellsPerBar, 5, 200, "cellsPerBar"),
    fitColumns: parsePositiveInt(fitColumns, WEBGPU_HEATMAP_FIXTURE.fitColumns, 20, 500, "fitColumns"),
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

export function evaluateWebGpuHeatmapAssessment({
  hardwareValid = false,
  residentZeroPanZoomUpload = false,
  residentPrepareCallsDuringPanZoom = -1,
  fallbacks = 0,
  scenarios = {},
} = {}) {
  const checks = [];
  if (!hardwareValid) checks.push("non-hardware-adapter");
  if (!residentZeroPanZoomUpload) checks.push("pan-zoom-data-upload-nonzero");
  if (residentPrepareCallsDuringPanZoom !== 0) checks.push("resident-called-prepareReservedGpuCells");
  if (fallbacks > 0) checks.push("runtime-fallbacks-observed");
  const decision = checks.length === 0 ? "PASS" : "INVESTIGATE";
  return { decision, reasons: checks, scenarios };
}

export function formatWebGpuHeatmapMarkdown(report) {
  const lines = [
    `# WebGPU Native Resident Heatmap Benchmark (#265)`,
    ``,
    `- **Run ID:** ${report.runId ?? "n/a"}`,
    `- **Created At:** ${report.createdAt ?? "n/a"}`,
    `- **Fixture:** ${report.fixture?.barCount ?? 0} bars x ${report.fixture?.cellsPerBar ?? 0} cells = ${(report.fixture?.barCount ?? 0) * (report.fixture?.cellsPerBar ?? 0)} cells`,
    `- **Adapter:** ${report.adapter?.description ?? report.adapter?.vendor ?? "unavailable"} (${report.adapterClass ?? "unknown"})`,
    `- **Hardware Valid:** ${Boolean(report.hardwareValid)}`,
    `- **Decision:** ${report.assessment?.decision ?? "UNKNOWN"}`,
    ``,
    `## Pan / Zoom Upload & CPU Prepare`,
    ``,
    `- Resident pan/zoom dataBytes: ${report.residentPanZoomDataBytes ?? "n/a"}`,
    `- Resident pan/zoom uniformBytes: ${report.residentPanZoomUniformBytes ?? "n/a"}`,
    `- Resident pan/zoom prepare.ms count: ${report.residentPanZoomPrepareCount ?? "n/a"}`,
    `- Immediate pan/zoom data upload / frame: ${report.immediatePanZoomUploadBytes ?? "n/a"}`,
  ];
  return lines.join("\n");
}
