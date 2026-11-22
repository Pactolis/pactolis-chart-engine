import {
  buildDenseFootprintBars,
  classifyWebGpuAdapter,
  readWebGpuAdapterIdentity,
  round6,
  selectWebGpuProbe,
  shouldTryWebGpuVulkan,
  summarizeMetricValues,
  WEBGPU_NATIVE_FIXTURE,
  webGpuFlushHardwareInvalidReasons,
  webGpuFlushLaunchArgs,
} from "./webgpuNativeBenchmark.mjs";

export {
  buildDenseFootprintBars,
  classifyWebGpuAdapter,
  readWebGpuAdapterIdentity,
  selectWebGpuProbe,
  shouldTryWebGpuVulkan,
  summarizeMetricValues,
  webGpuFlushHardwareInvalidReasons,
  webGpuFlushLaunchArgs,
};

export const FOOTPRINT_TEXT_GATE_RULE = Object.freeze({
  name: "footprint-text-glyph-atlas-gate",
  minTextShareOfFrameP95: 0.30,
  targetCellHeightPx: 12,
  fullColWidthPx: 96,
  compactColWidthPx: 64,
});

export const FOOTPRINT_TEXT_MARKETS = Object.freeze([
  "BINANCE_FUTURES:btcusdt",
  "BINANCE_FUTURES:ethusdt",
  "BINANCE_FUTURES:solusdt",
  "BINANCE_FUTURES:avaxusdt",
  "BINANCE_FUTURES:xauusdt",
  "BINANCE_FUTURES:xagusdt",
  "BINANCE_FUTURES:clusdt",
  "BINANCE_FUTURES:dogeusdt",
]);

export const FOOTPRINT_TEXT_METRICS = Object.freeze([
  "chart.frame.render.ms",
  "chart.surface.gpu.draw.ms",
  "chart.surface.annotation.draw.ms",
  "chart.annotation.layer.footprint-text.ms",
  "chart.annotation.layer.axis.ms",
  "chart.annotation.setup.ms",
]);

export const FOOTPRINT_TEXT_SCENARIOS = Object.freeze(["pan", "zoom", "live"]);

function parseChartCounts(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const items = Array.isArray(raw) ? raw : String(raw).split(",");
  const parsed = items
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0)
    .map((v) => Number(v));
  if (parsed.length === 0) {
    throw new Error("chartCounts must not be empty");
  }
  const unique = [];
  for (const count of parsed) {
    if (!Number.isInteger(count) || count < 1 || count > FOOTPRINT_TEXT_MARKETS.length) {
      throw new Error(`Invalid chartCount: ${count} (expected integer in 1..${FOOTPRINT_TEXT_MARKETS.length})`);
    }
    if (!unique.includes(count)) unique.push(count);
  }
  return unique;
}

export function resolveFootprintTextFixture({ hardwareMode = false, chartCounts } = {}) {
  const isHardware = Boolean(hardwareMode);
  const resolvedCounts = parseChartCounts(chartCounts, isHardware ? [4, 8] : [4]);
  if (isHardware) {
    return Object.freeze({
      hardwareMode: true,
      barCount: 2_500,
      cellsPerBar: 120,
      priceStep: WEBGPU_NATIVE_FIXTURE.priceStep,
      intervalMs: WEBGPU_NATIVE_FIXTURE.intervalMs,
      chartCounts: Object.freeze(resolvedCounts),
      markets: FOOTPRINT_TEXT_MARKETS,
      repetitions: 2,
      panFrames: 35,
      zoomFrames: 35,
      liveFrames: 30,
      liveRatePerSecondPerMarket: 200,
      viewport: Object.freeze({ width: 1600, height: 900 }),
      textModes: Object.freeze(["full", "compact"]),
      frozenNow: WEBGPU_NATIVE_FIXTURE.frozenNow,
    });
  }
  return Object.freeze({
    hardwareMode: false,
    barCount: 200,
    cellsPerBar: 40,
    priceStep: WEBGPU_NATIVE_FIXTURE.priceStep,
    intervalMs: WEBGPU_NATIVE_FIXTURE.intervalMs,
    chartCounts: Object.freeze(resolvedCounts),
    markets: FOOTPRINT_TEXT_MARKETS,
    repetitions: 1,
    panFrames: 10,
    zoomFrames: 10,
    liveFrames: 10,
    liveRatePerSecondPerMarket: 200,
    viewport: Object.freeze({ width: 1600, height: 900 }),
    textModes: Object.freeze(["full"]),
    frozenNow: WEBGPU_NATIVE_FIXTURE.frozenNow,
  });
}

function safeShare(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return round6(num / den);
}

export function evaluateFootprintTextGate({ hardwareValid, entries = [], measurementError = null } = {}) {
  const rows = (entries ?? []).map((entry) => {
    const metrics = entry?.combined ?? entry?.metrics ?? {};
    const frameRender = metrics["chart.frame.render.ms"] ?? null;
    const gpuDraw = metrics["chart.surface.gpu.draw.ms"] ?? null;
    const annotationDraw = metrics["chart.surface.annotation.draw.ms"] ?? null;
    const footprintText = metrics["chart.annotation.layer.footprint-text.ms"] ?? null;
    const axisLayer = metrics["chart.annotation.layer.axis.ms"] ?? null;
    const annotationSetup = metrics["chart.annotation.setup.ms"] ?? null;

    const textValid = Boolean(footprintText && footprintText.count > 0);
    const frameValid = Boolean(frameRender && frameRender.count > 0);
    const annotationValid = Boolean(annotationDraw && annotationDraw.count > 0);

    const textShareOfFrameP95 = textValid && frameValid ? safeShare(footprintText.p95Ms, frameRender.p95Ms) : null;
    const textShareOfFrameMean = textValid && frameValid ? safeShare(footprintText.meanMs, frameRender.meanMs) : null;
    const textShareOfTotal = textValid && frameValid ? safeShare(footprintText.totalMs, frameRender.totalMs) : null;
    const annotationShareOfFrameP95 = annotationValid && frameValid ? safeShare(annotationDraw.p95Ms, frameRender.p95Ms) : null;

    return {
      chartCount: Number(entry?.chartCount ?? 0),
      textMode: String(entry?.textMode ?? "unknown"),
      scenario: String(entry?.scenario ?? "unknown"),
      reuseCount: Number(entry?.reuseCount ?? 0),
      totalFrames: Number(entry?.totalFrames ?? 0),
      frameRender,
      gpuDraw,
      annotationDraw,
      footprintText,
      axisLayer,
      annotationSetup,
      textShareOfFrameP95,
      textShareOfFrameMean,
      textShareOfTotal,
      annotationShareOfFrameP95,
    };
  });

  const panZoomShares = rows
    .filter((row) => (row.scenario === "pan" || row.scenario === "zoom") && Number.isFinite(row.textShareOfFrameP95))
    .map((row) => row.textShareOfFrameP95);
  const maxPanZoomTextShareP95 = panZoomShares.length > 0 ? round6(Math.max(...panZoomShares)) : null;

  if (!hardwareValid) {
    return {
      rule: FOOTPRINT_TEXT_GATE_RULE,
      decision: "HARDWARE_INVALID",
      maxPanZoomTextShareP95,
      rationale: "Yazılım rasterizer veya kullanılamayan WebGPU adaptörü nedeniyle #266 ön-kapı ölçümü değerlendirilemedi.",
      rows,
    };
  }

  if (measurementError) {
    return {
      rule: FOOTPRINT_TEXT_GATE_RULE,
      decision: "DEFER_NOT_NEEDED",
      maxPanZoomTextShareP95,
      rationale: `Ölçüm tamamlanamadı (${measurementError}); #266 glyph atlası için anlamlı eşik aşılamadı.`,
      rows,
    };
  }

  if (maxPanZoomTextShareP95 !== null && maxPanZoomTextShareP95 >= FOOTPRINT_TEXT_GATE_RULE.minTextShareOfFrameP95) {
    return {
      rule: FOOTPRINT_TEXT_GATE_RULE,
      decision: "PROCEED_GLYPH_ATLAS",
      maxPanZoomTextShareP95,
      rationale: `pan/zoom karelerinde en yüksek footprint-text p95 payı (${(maxPanZoomTextShareP95 * 100).toFixed(1)}%) eşiği (>= ${(FOOTPRINT_TEXT_GATE_RULE.minTextShareOfFrameP95 * 100).toFixed(0)}%) geçti; #266 SDF/MSDF glyph atlası uygulanmalı.`,
      rows,
    };
  }

  const maxDisplay = maxPanZoomTextShareP95 !== null ? `${(maxPanZoomTextShareP95 * 100).toFixed(1)}%` : "ölçülemedi";
  return {
    rule: FOOTPRINT_TEXT_GATE_RULE,
    decision: "DEFER_NOT_NEEDED",
    maxPanZoomTextShareP95,
    rationale: `pan/zoom karelerinde en yüksek footprint-text p95 payı (${maxDisplay}) %${(FOOTPRINT_TEXT_GATE_RULE.minTextShareOfFrameP95 * 100).toFixed(0)} eşiğinin altında kaldığı için #266 şimdilik ertelenebilir.`,
    rows,
  };
}

function fmtMs(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "—";
}

function fmtPair(stats) {
  if (!stats || !stats.count) return "—";
  return `${fmtMs(stats.p50Ms)} / ${fmtMs(stats.p95Ms)}`;
}

function fmtPct(share) {
  return Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : "—";
}

export function formatFootprintTextMarkdown(report) {
  const env = report?.environment ?? {};
  const adapter = env.webgpuAdapter ?? report?.webgpuProbe?.adapterInfo ?? {};
  const renderer = env.webglRenderer ?? report?.webgpuProbe?.webglInfo ?? {};
  const scenePaths = report?.featurePathsByChartCount ?? {};
  const sceneDisplay = Object.keys(scenePaths).length > 0
    ? Object.entries(scenePaths).map(([cnt, fp]) => `${cnt}g=\`${fp?.scene ?? "unknown"}\``).join(", ")
    : `\`${report?.featurePaths?.scene ?? "unknown"}\``;
  const maxPct = fmtPct(report?.maxPanZoomTextShareP95);

  const lines = [
    "# Footprint Hücre Metni Payı Ön-Kapısı Raporu (`Refs #266`)",
    "",
    `- Run ID: ${report?.runId ?? "unknown"}`,
    `- Kapı Kararı: **${report?.decision ?? "HARDWARE_INVALID"}** (maks. pan/zoom \`footprint-text\` p95 payı: **${maxPct}**, eşik: \`>= ${(FOOTPRINT_TEXT_GATE_RULE.minTextShareOfFrameP95 * 100).toFixed(0)}%\`)`,
    `- Donanım geçerli (\`hardwareValid\`): **${Boolean(report?.hardwareValid)}**`,
    `- WebGPU adaptörü: ${adapter?.vendor || "unknown"} / ${adapter?.architecture || "unknown"} / ${adapter?.description || "unknown"} (fallback: ${adapter?.isFallbackAdapter ?? "unknown"})`,
    `- WebGL2 kimliği: ${renderer?.unmaskedVendor || renderer?.vendor || "unknown"} / ${renderer?.unmaskedRenderer || renderer?.renderer || "unknown"}`,
    `- \`featurePaths.scene\`: ${sceneDisplay}`,
    `- Chromium / OS: ${env.browserVersion ?? "unknown"} / ${env.operatingSystem ?? "unknown"}`,
  ];

  if (!report?.hardwareValid && Array.isArray(report?.hardwareInvalidReasons) && report.hardwareInvalidReasons.length > 0) {
    lines.push(`- Hardware-invalid nedenleri: ${report.hardwareInvalidReasons.join(", ")}`);
  }

  lines.push(
    "",
    "## Senaryo Bazlı Katman Süreleri ve Metin Payı",
    "",
    "| Grafik | Metin Modu | Senaryo | frame p50/p95 | gpu.draw p95 | annotation p95 | footprint-text p50/p95 | text/frame p95 % | text/frame total % | reuse |",
    "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const row of report?.rows ?? []) {
    lines.push(
      `| ${row.chartCount} | ${row.textMode} | ${row.scenario} | ${fmtPair(row.frameRender)} | ${fmtMs(row.gpuDraw?.count ? row.gpuDraw.p95Ms : null)} | ${fmtMs(row.annotationDraw?.count ? row.annotationDraw.p95Ms : null)} | ${fmtPair(row.footprintText)} | ${fmtPct(row.textShareOfFrameP95)} | ${fmtPct(row.textShareOfTotal)} | ${row.reuseCount ?? 0} |`,
    );
  }

  lines.push(
    "",
    `> Sonuç (#266 Kapısı): **${report?.decision ?? "HARDWARE_INVALID"}** — ${report?.rationale ?? "—"}`,
    "",
  );
  return lines.join("\n");
}
