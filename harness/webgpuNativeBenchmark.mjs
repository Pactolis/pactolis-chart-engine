import {
  buildDenseFootprintBars,
  classifyWebGpuAdapter,
  readWebGpuAdapterIdentity,
  selectWebGpuProbe,
  shouldTryWebGpuVulkan,
  WEBGPU_FLUSH_FIXTURE,
  webGpuFlushHardwareInvalidReasons,
  webGpuFlushLaunchArgs,
} from "./webgpuFlushBenchmark.mjs";

export {
  buildDenseFootprintBars,
  classifyWebGpuAdapter,
  readWebGpuAdapterIdentity,
  selectWebGpuProbe,
  shouldTryWebGpuVulkan,
  webGpuFlushHardwareInvalidReasons,
  webGpuFlushLaunchArgs,
};

export const WEBGPU_NATIVE_FIXTURE = Object.freeze({
  ...WEBGPU_FLUSH_FIXTURE,
  zoomFramesPerRepetition: 35,
  liveRolloverFramesPerRepetition: 40,
  liveRolloverEveryFrames: 3,
  missedFrameThresholdMs: 20,
});

export const WEBGPU_NATIVE_SCENARIOS = Object.freeze(["pan", "zoom", "live", "live-rollover"]);

export const WEBGPU_NATIVE_MODES = Object.freeze(["immediate", "gpu-native"]);

export const WEBGPU_NATIVE_METRICS = Object.freeze([
  "chart.frame.render.ms",
  "chart.surface.gpu.draw.ms",
  "chart.gpu.candles.ms",
  "chart.gpu.footprint.ms",
  "chart.gpu.flush.ms",
  "chart.gpu.timestamp.ms",
  "chart.gpu.timestamp.compute.ms",
  "chart.gpu.native.overlay.ms",
]);

export const WEBGPU_NATIVE_COUNTERS = Object.freeze([
  "gpu.upload.bytes",
  "gpu.native.upload.dataBytes",
  "gpu.native.upload.uniformBytes",
]);

export function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function summarizeMetricValues(values) {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) {
    return { count: 0, totalMs: 0, meanMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const total = valid.reduce((sum, value) => sum + value, 0);
  const at = (quantile) => valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(quantile * valid.length) - 1))];
  return {
    count: valid.length,
    totalMs: round6(total),
    meanMs: round6(total / valid.length),
    minMs: round6(valid[0]),
    maxMs: round6(valid[valid.length - 1]),
    p50Ms: round6(at(0.5)),
    p95Ms: round6(at(0.95)),
    p99Ms: round6(at(0.99)),
  };
}

export function computeMissedFrameStats(intervalsMs, thresholdMs = WEBGPU_NATIVE_FIXTURE.missedFrameThresholdMs) {
  const valid = intervalsMs.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) {
    return { sampleCount: 0, missedCount: 0, missedFrameRatio: 0, maxIntervalMs: 0, p95IntervalMs: 0 };
  }
  const missedCount = valid.filter((interval) => interval > thresholdMs).length;
  const p95Idx = Math.min(valid.length - 1, Math.max(0, Math.ceil(0.95 * valid.length) - 1));
  return {
    sampleCount: valid.length,
    missedCount,
    missedFrameRatio: round6(missedCount / valid.length),
    maxIntervalMs: round6(valid[valid.length - 1]),
    p95IntervalMs: round6(valid[p95Idx]),
  };
}

export function computeUploadStats(counterDeltas, totalChartFrames) {
  const totalBytes = Math.max(0, Number(counterDeltas?.["gpu.upload.bytes"] ?? 0));
  const dataBytes = Math.max(0, Number(counterDeltas?.["gpu.native.upload.dataBytes"] ?? 0));
  const uniformBytes = Math.max(0, Number(counterDeltas?.["gpu.native.upload.uniformBytes"] ?? 0));
  const denom = totalChartFrames > 0 ? totalChartFrames : 0;
  return {
    totalBytes,
    perFrameBytes: denom > 0 ? round6(totalBytes / denom) : 0,
    dataBytes,
    dataPerFrameBytes: denom > 0 ? round6(dataBytes / denom) : 0,
    uniformBytes,
    uniformPerFrameBytes: denom > 0 ? round6(uniformBytes / denom) : 0,
  };
}

export function formatTimestampSummary(stats) {
  if (!stats || !Number.isInteger(stats.count) || stats.count <= 0) {
    return "yok";
  }
  return `${stats.meanMs.toFixed(3)} / ${stats.p95Ms.toFixed(3)} ms`;
}

function scenarioData(modeReport, scenario) {
  return modeReport?.scenarios?.[scenario] ?? null;
}

function metricStats(modeReport, scenario, metric) {
  return scenarioData(modeReport, scenario)?.combined?.[metric] ?? null;
}

function ratio(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return round6(num / den);
}

function summarizeRolloverFrames(scenarioEntry) {
  const rf = scenarioEntry?.rolloverFrames;
  if (!rf) return null;
  const metrics = rf.combined ?? {};
  return {
    frameCount: Number(rf.frameCount ?? 0),
    rolloverCount: Number(scenarioEntry?.rolloverCount ?? rf.rolloverCount ?? 0),
    frameRender: metrics["chart.frame.render.ms"] ?? null,
    surfaceGpuDraw: metrics["chart.surface.gpu.draw.ms"] ?? null,
    flush: metrics["chart.gpu.flush.ms"] ?? null,
    timestamp: metrics["chart.gpu.timestamp.ms"] ?? null,
    timestampCompute: metrics["chart.gpu.timestamp.compute.ms"] ?? null,
    uploads: rf.uploads ?? computeUploadStats({}, 0),
  };
}

export function buildWebGpuNativeAssessment({
  hardwareValid,
  immediate,
  gpuNative,
  measurementError = null,
} = {}) {
  const comparisons = WEBGPU_NATIVE_SCENARIOS.map((scenario) => {
    const immData = scenarioData(immediate, scenario);
    const natData = scenarioData(gpuNative, scenario);
    const immRender = metricStats(immediate, scenario, "chart.frame.render.ms");
    const natRender = metricStats(gpuNative, scenario, "chart.frame.render.ms");
    const immDraw = metricStats(immediate, scenario, "chart.surface.gpu.draw.ms");
    const natDraw = metricStats(gpuNative, scenario, "chart.surface.gpu.draw.ms");
    const immCandles = metricStats(immediate, scenario, "chart.gpu.candles.ms");
    const natCandles = metricStats(gpuNative, scenario, "chart.gpu.candles.ms");
    const immFootprint = metricStats(immediate, scenario, "chart.gpu.footprint.ms");
    const natFootprint = metricStats(gpuNative, scenario, "chart.gpu.footprint.ms");
    const immFlush = metricStats(immediate, scenario, "chart.gpu.flush.ms");
    const natFlush = metricStats(gpuNative, scenario, "chart.gpu.flush.ms");
    const immTs = metricStats(immediate, scenario, "chart.gpu.timestamp.ms");
    const natTs = metricStats(gpuNative, scenario, "chart.gpu.timestamp.ms");
    const immTsCompute = metricStats(immediate, scenario, "chart.gpu.timestamp.compute.ms");
    const natTsCompute = metricStats(gpuNative, scenario, "chart.gpu.timestamp.compute.ms");
    const immOverlay = metricStats(immediate, scenario, "chart.gpu.native.overlay.ms");
    const natOverlay = metricStats(gpuNative, scenario, "chart.gpu.native.overlay.ms");

    const immUpload = immData?.uploads ?? computeUploadStats({}, 0);
    const natUpload = natData?.uploads ?? computeUploadStats({}, 0);
    const immRaf = immData?.raf ?? computeMissedFrameStats([]);
    const natRaf = natData?.raf ?? computeMissedFrameStats([]);
    const immRollover = scenario === "live-rollover" ? summarizeRolloverFrames(immData) : null;
    const natRollover = scenario === "live-rollover" ? summarizeRolloverFrames(natData) : null;

    return {
      scenario,
      immediate: {
        frameRender: immRender,
        surfaceGpuDraw: immDraw,
        candles: immCandles,
        footprint: immFootprint,
        flush: immFlush,
        timestamp: immTs,
        timestampDisplay: formatTimestampSummary(immTs),
        timestampCompute: immTsCompute,
        timestampComputeDisplay: formatTimestampSummary(immTsCompute),
        overlay: immOverlay,
        raf: immRaf,
        uploads: immUpload,
        rolloverCount: immData?.rolloverCount ?? null,
        rolloverFrames: immRollover,
      },
      gpuNative: {
        frameRender: natRender,
        surfaceGpuDraw: natDraw,
        candles: natCandles,
        footprint: natFootprint,
        flush: natFlush,
        timestamp: natTs,
        timestampDisplay: formatTimestampSummary(natTs),
        timestampCompute: natTsCompute,
        timestampComputeDisplay: formatTimestampSummary(natTsCompute),
        overlay: natOverlay,
        raf: natRaf,
        uploads: natUpload,
        rolloverCount: natData?.rolloverCount ?? null,
        rolloverFrames: natRollover,
      },
      renderMeanSpeedup: ratio(immRender?.meanMs, natRender?.meanMs),
      gpuDrawMeanSpeedup: ratio(immDraw?.meanMs, natDraw?.meanMs),
      uploadReductionRatio: ratio(immUpload.totalBytes, natUpload.totalBytes),
      panOrZoomZeroDataUpload: scenario === "pan" || scenario === "zoom" ? natUpload.dataBytes === 0 : null,
    };
  });

  if (!hardwareValid) {
    return {
      decision: "NOT_EVALUATED_HARDWARE_INVALID",
      display: "hardware-invalid",
      rationale: "Yazılım rasterizer veya kullanılamayan WebGPU adaptörü nedeniyle donanım kararı üretilemedi.",
      comparisons,
    };
  }

  const incomplete = Boolean(measurementError) || comparisons.some(
    (c) => !c.immediate.frameRender?.count || !c.gpuNative.frameRender?.count,
  );
  if (incomplete) {
    return {
      decision: "NOT_EVALUATED_INCOMPLETE",
      display: "incomplete",
      rationale: measurementError ?? "En az bir mod/senaryo için geçerli chart.frame.render.ms ölçümü alınamadı.",
      comparisons,
    };
  }

  const zeroPanZoomUpload = comparisons
    .filter((c) => c.scenario === "pan" || c.scenario === "zoom")
    .every((c) => c.panOrZoomZeroDataUpload === true);

  return {
    decision: zeroPanZoomUpload ? "MEASURED" : "MEASURED_UPLOAD_REGRESSION",
    display: zeroPanZoomUpload ? "MEASURED (pan/zoom 0-data-upload OK)" : "MEASURED (pan/zoom data upload > 0)",
    rationale: zeroPanZoomUpload
      ? "Aynı WebGPU adaptöründe immediate vs gpu-native kıyası tamamlandı; pan ve zoom senaryolarında gpu.native.upload.dataBytes = 0 doğrulandı."
      : "Ölçüm tamamlandı ancak pan veya zoom senaryosunda gpu.native.upload.dataBytes sıfır değil.",
    comparisons,
  };
}

function fmtMsPair(stats) {
  if (!stats || !stats.count) return "—";
  return `${stats.meanMs.toFixed(3)} / ${stats.p95Ms.toFixed(3)}`;
}

function fmtMsTriple(stats) {
  if (!stats || !stats.count) return "—";
  return `${stats.meanMs.toFixed(3)} / ${stats.p95Ms.toFixed(3)} / ${stats.p99Ms.toFixed(3)}`;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${Math.round(bytes)} B`;
}

export function formatWebGpuNativeMarkdown(report) {
  const env = report?.environment ?? {};
  const adapter = env.webgpuAdapter ?? report?.webgpuProbe?.adapterInfo ?? {};
  const renderer = env.webglRenderer ?? report?.webgpuProbe?.webglInfo ?? {};
  const lines = [
    "# WebGPU Immediate vs GPU-Native PoC Raporu (`Refs #258`)",
    "",
    `- Run ID: ${report?.runId ?? "unknown"}`,
    `- Karar / Durum: **${report?.decision ?? "NOT_EVALUATED"}** (${report?.display ?? "—"})`,
    `- Donanım geçerli (` + "`hardwareValid`" + `): **${Boolean(report?.hardwareValid)}**`,
    `- Sunum modu (` + "`presentation`" + `): **${report?.presentation ?? "unavailable"}**`,
    `- WebGPU adaptörü: ${adapter?.vendor || "unknown"} / ${adapter?.architecture || "unknown"} / ${adapter?.description || "unknown"} (fallback: ${adapter?.isFallbackAdapter ?? "unknown"})`,
    `- WebGPU ` + "`timestamp-query`" + ` desteği: **${Boolean(report?.timestampQuerySupported)}**`,
    `- WebGL2 referans kimliği: ${renderer?.unmaskedVendor || renderer?.vendor || "unknown"} / ${renderer?.unmaskedRenderer || renderer?.renderer || "unknown"}`,
    `- Chromium: ${env.browserVersion ?? "unknown"}`,
    `- İşletim sistemi: ${env.operatingSystem ?? "unknown"}`,
    `- Launch args: \`${(env.webgpuLaunchArgs ?? env.launchArgs ?? []).join(" ") || "unknown"}\``,
  ];

  if (!report?.hardwareValid) {
    const reasons = report?.hardwareInvalidReasons ?? [];
    lines.push(`- Hardware-invalid nedenleri: ${reasons.join(", ") || "unknown"}`);
  }

  lines.push(
    "",
    "## Fixture Özeti (#88 Yoğun Sahne)",
    "",
    `- Viewport: ${WEBGPU_NATIVE_FIXTURE.viewport.width}×${WEBGPU_NATIVE_FIXTURE.viewport.height} (4 grafik, 2×2 800×450)`,
    `- Seri: ${WEBGPU_NATIVE_FIXTURE.barCount} bar × ${WEBGPU_NATIVE_FIXTURE.cellsPerBar} hücre, fit=${WEBGPU_NATIVE_FIXTURE.fitColumns}`,
    `- Canlı akış: ${WEBGPU_NATIVE_FIXTURE.liveRatePerSecondPerMarket} trade/s/market; rollover: ${WEBGPU_NATIVE_FIXTURE.liveRolloverFramesPerRepetition} kare/rep, her ${WEBGPU_NATIVE_FIXTURE.liveRolloverEveryFrames} karede bar devri`,
    `- rAF missed-frame eşiği: interval > ${WEBGPU_NATIVE_FIXTURE.missedFrameThresholdMs} ms`,
    "",
    "## Senaryo Bazlı Zamanlama Karşılaştırması (mean / p95 ms)",
    "",
    "| Senaryo | Mod | `frame.render` | `surface.gpu.draw` | `gpu.candles` | `gpu.footprint` | `gpu.flush` | `gpu.timestamp` | `gpu.ts.compute` | rAF missed |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const item of report?.comparisons ?? []) {
    for (const [label, data] of [["immediate", item.immediate], ["gpu-native", item.gpuNative]]) {
      const missedPct = data.raf?.sampleCount > 0 ? `${(data.raf.missedFrameRatio * 100).toFixed(1)}%` : "—";
      lines.push(
        `| ${item.scenario} | ${label} | ${fmtMsPair(data.frameRender)} | ${fmtMsPair(data.surfaceGpuDraw)} | ${fmtMsPair(data.candles)} | ${fmtMsPair(data.footprint)} | ${fmtMsPair(data.flush)} | ${data.timestampDisplay ?? "yok"} | ${data.timestampComputeDisplay ?? "yok"} | ${missedPct} |`,
      );
    }
  }

  lines.push(
    "",
    "> Telemetri Notu: `gpu-native` modunda `gpu.candles` ve `gpu.footprint` kasıtlı olarak `—` gösterilir; bu çizimler CPU quad döngüsü yerine tek GPU pass içinde shader ile yürütülür ve süresi `gpu.flush` / `gpu.timestamp` ölçümlerine dahildir (varsa `stackedImbalance` kaplaması `chart.gpu.native.overlay.ms` olarak kaydedilir).",
    "",
    "## GPU Veri Yükleme Karşılaştırması",
    "",
    "| Senaryo | Mod | `gpu.upload.bytes` (toplam / kare) | `native.dataBytes` (toplam / kare) | `native.uniformBytes` (toplam / kare) |",
    "| --- | --- | ---: | ---: | ---: |",
  );

  for (const item of report?.comparisons ?? []) {
    for (const [label, data] of [["immediate", item.immediate], ["gpu-native", item.gpuNative]]) {
      const u = data.uploads ?? {};
      lines.push(
        `| ${item.scenario} | ${label} | ${fmtBytes(u.totalBytes)} / ${fmtBytes(u.perFrameBytes)} | ${fmtBytes(u.dataBytes)} / ${fmtBytes(u.dataPerFrameBytes)} | ${fmtBytes(u.uniformBytes)} / ${fmtBytes(u.uniformPerFrameBytes)} |`,
      );
    }
  }

  const rolloverItem = (report?.comparisons ?? []).find((item) => item.scenario === "live-rollover");
  if (rolloverItem && (rolloverItem.immediate?.rolloverFrames || rolloverItem.gpuNative?.rolloverFrames)) {
    lines.push(
      "",
      "## Bar Devri (Rollover) Kareleri Özeti (mean / p95 / p99 ms)",
      "",
      "| Mod | `rolloverCount` | `frame.render` | `surface.gpu.draw` | `gpu.flush` | `gpu.timestamp` | `gpu.ts.compute` | `gpu.upload.bytes` (toplam / kare) | `native.dataBytes` (toplam / kare) |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const [label, data] of [["immediate", rolloverItem.immediate], ["gpu-native", rolloverItem.gpuNative]]) {
      const rf = data?.rolloverFrames;
      const u = rf?.uploads ?? {};
      const countDisplay = Number.isFinite(rf?.rolloverCount) ? String(rf.rolloverCount) : (Number.isFinite(data?.rolloverCount) ? String(data.rolloverCount) : "—");
      lines.push(
        `| ${label} | ${countDisplay} | ${fmtMsTriple(rf?.frameRender)} | ${fmtMsTriple(rf?.surfaceGpuDraw)} | ${fmtMsTriple(rf?.flush)} | ${fmtMsTriple(rf?.timestamp)} | ${fmtMsTriple(rf?.timestampCompute)} | ${fmtBytes(u.totalBytes)} / ${fmtBytes(u.perFrameBytes)} | ${fmtBytes(u.dataBytes)} / ${fmtBytes(u.dataPerFrameBytes)} |`,
      );
    }
  }

  if (report?.parity) {
    lines.push(
      "",
      "## Piksel Paritesi ve Feature Path Doğrulaması",
      "",
      `- ` + "`immediate`" + ` featurePaths.scene: \`${report.immediate?.featurePaths?.scene ?? "unknown"}\``,
      `- ` + "`gpu-native`" + ` featurePaths.scene: \`${report.gpuNative?.featurePaths?.scene ?? "unknown"}\``,
      `- ` + "`gpu-native`" + ` arka plan dışı piksel sayısı: ${report.parity.nonBgPixelsNative ?? "—"}`,
      `- Parite eşleşme oranı (kanal toleransı ≤ 2): ${Number.isFinite(report.parity.matchRatio) ? `${(report.parity.matchRatio * 100).toFixed(2)}%` : "—"}`,
    );
  }

  lines.push(
    "",
    `> Gerekçe: ${report?.rationale ?? "—"}`,
    "",
  );
  return lines.join("\n");
}
