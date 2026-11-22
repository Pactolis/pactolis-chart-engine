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

export async function readWebGpuAdapterIdentity(adapter) {
  if (!adapter) return null;
  const info = adapter.info;
  let identity = info;
  if (!identity && typeof adapter.requestAdapterInfo === "function") {
    try {
      identity = await adapter.requestAdapterInfo();
    } catch {
      identity = null;
    }
  }
  return {
    vendor: identity?.vendor ?? null,
    architecture: identity?.architecture ?? null,
    description: identity?.description ?? null,
    isFallbackAdapter: info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
  };
}

export function classifyWebGpuAdapter(adapterInfo) {
  if (adapterInfo?.isFallbackAdapter === true) {
    return { software: true, reason: "webgpu-fallback-adapter" };
  }
  const identity = [adapterInfo?.vendor, adapterInfo?.architecture, adapterInfo?.description]
    .filter((value) => typeof value === "string" && value.trim());
  if (identity.some((value) => /swiftshader|llvmpipe|lavapipe|softpipe|warp|microsoft basic render/i.test(value))) {
    return { software: true, reason: "webgpu-software-adapter" };
  }
  return { software: false, reason: identity.length === 0 ? "webgpu-adapter-identity-unavailable" : null };
}

export function webGpuFlushLaunchArgs({ kind, variant, hardwareMode, platform, functionalWebglArgs }) {
  const vulkan = kind === "webgpu" && variant === "vulkan-compositor";
  if (hardwareMode) {
    const linuxVulkan = vulkan && platform === "linux";
    const args = [
      "--use-gl=angle",
      linuxVulkan ? "--use-angle=vulkan" : "--use-angle=default",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--enable-unsafe-webgpu",
      "--enable-precise-memory-info",
    ];
    if (vulkan) args.push("--enable-features=Vulkan");
    if (linuxVulkan) args.push("--disable-vulkan-surface");
    return args;
  }
  const args = [...functionalWebglArgs];
  if (kind === "webgpu") {
    args.push("--enable-unsafe-webgpu", "--use-vulkan=swiftshader", "--disable-vulkan-surface");
  }
  if (vulkan) args.push("--enable-features=Vulkan");
  return args;
}

export function shouldTryWebGpuVulkan(primary, hardwareMode) {
  return !primary.ok || (hardwareMode && (!primary.canvasPresentation.supported || primary.webgpuSoftware.reason !== null));
}

export function selectWebGpuProbe(primary, fallback, hardwareMode) {
  if (!hardwareMode) return primary.ok ? primary : fallback;
  if (!fallback.ok) return primary;
  if (!primary.ok) return fallback;
  if (fallback.webgpuSoftware.reason === null
    && (primary.webgpuSoftware.reason !== null || fallback.canvasPresentation.supported)) {
    return fallback;
  }
  return primary;
}

export function webGpuFlushHardwareInvalidReasons(webgpuProbe, webglProbe) {
  const reasons = [];
  if (!webgpuProbe.ok) reasons.push(`webgpu-adapter-unavailable:${webgpuProbe.reason ?? "unknown"}`);
  if (!webglProbe.webglInfo?.debugExtensionAvailable
    || !webglProbe.webglInfo.unmaskedRenderer
    || !webglProbe.webglInfo.unmaskedVendor) {
    reasons.push("webgl-renderer-identity-unavailable");
  }
  if (webglProbe.softwareRenderer) reasons.push("software-renderer");
  if (webgpuProbe.webgpuSoftware.reason) reasons.push(webgpuProbe.webgpuSoftware.reason);
  return reasons;
}

export function formatWebGpuFlushMetadata(flushReport, decision) {
  const environment = flushReport?.environment;
  const probe = flushReport?.webgpuProbe;
  const renderer = environment?.webglRenderer === undefined ? probe?.webglInfo : environment.webglRenderer;
  const adapter = environment?.webgpuAdapter === undefined
    ? probe?.adapterInfo ?? flushReport?.webgpu?.adapter
    : environment.webgpuAdapter;
  const args = environment?.webgpuLaunchArgs ?? probe?.args ?? environment?.launchArgs;
  const variant = environment?.webgpuVariant ?? probe?.variant ?? "unknown";
  const lines = [
    `- #88 WebGL2 renderer: ${renderer?.unmaskedVendor || renderer?.vendor || "unknown"} / ${renderer?.unmaskedRenderer || renderer?.renderer || "unknown"}`,
    `- #88 WebGPU adapter: ${adapter?.vendor || "unknown"} / ${adapter?.architecture || "unknown"} / ${adapter?.description || "unknown"} (fallback: ${adapter?.isFallbackAdapter ?? "unknown"})`,
    `- #88 WebGPU variant: ${variant}`,
    `- #88 WebGPU launch args: \`${args?.join(" ") || "unknown"}\``,
  ];
  if (decision === "NOT_EVALUATED_HARDWARE_INVALID" || decision === "HARDWARE_INVALID") {
    const reasons = flushReport?.hardwareInvalidReasons ?? [];
    lines.push(`- #88 hardware invalid reasons: ${reasons.join(", ") || "unknown"}`);
  }
  return lines.join("\n");
}

export function buildDenseFootprintBars(anchorTo, options = {}) {
  const barCount = options.barCount ?? WEBGPU_FLUSH_FIXTURE.barCount;
  const cellsPerBar = options.cellsPerBar ?? WEBGPU_FLUSH_FIXTURE.cellsPerBar;
  const priceStep = options.priceStep ?? WEBGPU_FLUSH_FIXTURE.priceStep;
  const { intervalMs, frozenNow } = WEBGPU_FLUSH_FIXTURE;
  const bucketEnd = Math.floor(anchorTo / intervalMs) * intervalMs;
  const firstTime = bucketEnd - barCount * intervalMs;
  const basePrice = 60_000;
  const clampCellIdx = (idx) => Math.max(0, Math.min(cellsPerBar - 1, idx));
  return Array.from({ length: barCount }, (_, barIndex) => {
    const time = firstTime + barIndex * intervalMs;
    const low = basePrice;
    const high = basePrice + (cellsPerBar - 1) * priceStep;
    const openIdx = cellsPerBar >= 40
      ? 10 + (barIndex % 6)
      : clampCellIdx(Math.floor(cellsPerBar * 0.25) + (barIndex % Math.max(1, Math.min(6, cellsPerBar))));
    const closeIdx = cellsPerBar >= 40
      ? 28 - (barIndex % 6)
      : clampCellIdx(Math.floor(cellsPerBar * 0.75) - (barIndex % Math.max(1, Math.min(6, cellsPerBar))));
    const open = basePrice + openIdx * priceStep;
    const close = basePrice + closeIdx * priceStep;
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
      decision: "NOT_EVALUATED_HARDWARE_INVALID",
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
