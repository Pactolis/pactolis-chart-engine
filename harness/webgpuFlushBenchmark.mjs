export const WEBGPU_FLUSH_FIXTURE = Object.freeze({
  viewport: Object.freeze({ width: 1600, height: 900 }),
  markets: Object.freeze([
    "BINANCE_FUTURES:btcusdt",
    "BINANCE_FUTURES:ethusdt",
    "BINANCE_FUTURES:solusdt",
    "BINANCE_FUTURES:avaxusdt",
  ]),
  barCount: 600,
  cellsPerBar: 40,
  priceStep: 10,
  intervalMs: 60_000,
  fitColumns: 60,
  liveRatePerSecondPerMarket: 200,
  liveFramesPerRepetition: 30,
  panFramesPerRepetition: 35,
  crosshairFramesPerRepetition: 35,
  repetitions: 2,
  frozenNow: Date.UTC(2026, 0, 15, 12, 0, 0),
});

export const WEBGPU_FLUSH_SCENARIOS = Object.freeze(["pan", "live", "crosshair"]);

export const WEBGPU_FLUSH_METRICS = Object.freeze([
  "chart.gpu.flush.ms",
  "chart.gpu.footprint.ms",
  "chart.surface.gpu.draw.ms",
  "chart.frame.render.ms",
]);

export const WEBGPU_FLUSH_DECISION_RULE = Object.freeze({
  name: "webgpu-flush-no-more-than-2x-webgl2",
  metric: "chart.gpu.flush.ms",
  comparison: "meanMs",
  maximumRatio: 2,
  scenarios: WEBGPU_FLUSH_SCENARIOS,
  rule: "On real GPU hardware, WebGPU chart.gpu.flush.ms mean must be at most 2x WebGL2 in pan, live and crosshair.",
  hardwareRule: "A software renderer or unavailable WebGPU adapter is hardware-invalid and produces no GO/NO-GO decision.",
});

export function buildDenseFootprintBars(anchorTo) {
  const { barCount, cellsPerBar, priceStep, intervalMs, frozenNow } = WEBGPU_FLUSH_FIXTURE;
  const bucketEnd = Math.floor(anchorTo / intervalMs) * intervalMs;
  const firstTime = bucketEnd - barCount * intervalMs;
  const basePrice = 60_000;
  return Array.from({ length: barCount }, (_, barIndex) => {
    const time = firstTime + barIndex * intervalMs;
    const low = basePrice;
    const high = basePrice + (cellsPerBar - 1) * priceStep;
    const open = basePrice + (10 + (barIndex % 6)) * priceStep;
    const close = basePrice + (28 - (barIndex % 6)) * priceStep;
    let totalBuy = 0;
    let totalSell = 0;
    const cells = [];
    for (let cellIndex = 0; cellIndex < cellsPerBar; cellIndex++) {
      const priceBin = low + cellIndex * priceStep;
      const buyVol = Number((1.2 + ((barIndex + cellIndex) % 7) * 0.45).toFixed(2));
      const sellVol = Number((1.1 + ((barIndex * 3 + cellIndex) % 7) * 0.4).toFixed(2));
      totalBuy += buyVol;
      totalSell += sellVol;
      cells.push([priceBin, buyVol, sellVol, 0, 0]);
    }
    return {
      t: time,
      o: open,
      h: high,
      l: low,
      c: close,
      v: Number((totalBuy + totalSell).toFixed(2)),
      d: Number((totalBuy - totalSell).toFixed(2)),
      n: cellsPerBar * 2,
      cells,
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: frozenNow,
    };
  });
}

function statsFor(backend, scenario, metric) {
  return backend?.scenarios?.[scenario]?.combined?.[metric] ?? null;
}

export function buildWebGpuFlushAssessment({ hardwareValid, webgl2, webgpu, measurementError = null } = {}) {
  const comparisons = WEBGPU_FLUSH_SCENARIOS.map((scenario) => {
    const webgl2Flush = statsFor(webgl2, scenario, "chart.gpu.flush.ms");
    const webgpuFlush = statsFor(webgpu, scenario, "chart.gpu.flush.ms");
    const webgl2Footprint = statsFor(webgl2, scenario, "chart.gpu.footprint.ms");
    const webgpuFootprint = statsFor(webgpu, scenario, "chart.gpu.footprint.ms");
    const webgl2Draw = statsFor(webgl2, scenario, "chart.surface.gpu.draw.ms");
    const webgpuDraw = statsFor(webgpu, scenario, "chart.surface.gpu.draw.ms");
    const sampleCountsValid = [webgl2Flush, webgpuFlush].every((metric) =>
      Number.isInteger(metric?.count) && metric.count > 0 && Number.isFinite(metric.meanMs));
    const rawRatio = sampleCountsValid && webgl2Flush.meanMs > 0
      ? webgpuFlush.meanMs / webgl2Flush.meanMs
      : null;
    const ratio = rawRatio === null ? null : Math.round(rawRatio * 1_000) / 1_000;
    return {
      scenario,
      webgl2: { flush: webgl2Flush, footprint: webgl2Footprint, surfaceGpuDraw: webgl2Draw },
      webgpu: { flush: webgpuFlush, footprint: webgpuFootprint, surfaceGpuDraw: webgpuDraw },
      rawFlushMeanRatio: rawRatio,
      flushMeanRatio: ratio,
      within2xBudget: rawRatio === null ? null : rawRatio <= WEBGPU_FLUSH_DECISION_RULE.maximumRatio,
    };
  });

  if (!hardwareValid) {
    return {
      decision: "HARDWARE_INVALID",
      display: "hardware-invalid",
      rationale: "A software renderer or unavailable WebGPU adapter prevents a hardware decision.",
      comparisons,
    };
  }
  if (measurementError || comparisons.some((item) => item.flushMeanRatio === null)) {
    return {
      decision: "NOT_EVALUATED_INCOMPLETE",
      display: "incomplete",
      rationale: measurementError ?? "At least one backend/scenario has no valid chart.gpu.flush.ms samples.",
      comparisons,
    };
  }

  const passes = comparisons.every((item) => item.within2xBudget === true);
  return passes
    ? {
        decision: "GO",
        display: "GO",
        rationale: "All three real-hardware scenario means are at or below 2x WebGL2.",
        comparisons,
      }
    : {
        decision: "NO_GO",
        display: "NO-GO, P3 kalır",
        rationale: "WebGPU remains opt-in; the #200 coordinator was measured and rejected, and the absolute difference is about 0.1 ms per chart frame. No additional WebGPU flush optimization is warranted.",
        comparisons,
      };
}
