export const HEATMAP_PAN_FIXTURE = Object.freeze({
  market: "BINANCE_FUTURES:btcusdt",
  timeframe: "15m",
  intervalMs: 15 * 60_000,
  bucketStep: 25,
  thresholdBtc: 10,
  unit: "btc",
  mode: "single",
  contrast: "medium",
  fixedCeilingBtc: 200,
  opacities: Object.freeze(["off", 0.65, 0.85]),
  chartCounts: Object.freeze([1, 2]),
  barsCount: 250,
  levelsPerBar: 40,
  basePrice: 50_000,
  panRoundTrips: 8,
  panPxOneWay: 160,
  panFramesPerTrip: 10,
  zoomFrames: 8,
  liveTailFrames: 6,
  staticFrames: 6,
  frozenNow: Date.UTC(2026, 0, 15, 12, 0, 0),
});

export const HEATMAP_PAN_DECISION_RULE = Object.freeze({
  name: "heatmap-pan-hardware-validation",
  hardwareRule: "Decision is evaluated only when WebGL2 reports an unmasked non-software renderer.",
  softwareBehavior: "SwiftShader or missing unmasked renderer sets hardwareValid=false and decision=NOT_EVALUATED_HARDWARE_INVALID.",
});

export function buildHeatmapPanScenarios() {
  const scenarios = [];
  for (const chartCount of HEATMAP_PAN_FIXTURE.chartCounts) {
    for (const opacitySetting of HEATMAP_PAN_FIXTURE.opacities) {
      scenarios.push({
        issue: "#260/#256",
        chartCount,
        mode: opacitySetting === "off" ? "off" : "single",
        opacity: opacitySetting === "off" ? null : opacitySetting,
        scaleMode: "auto",
        contrast: HEATMAP_PAN_FIXTURE.contrast,
        bucketStep: HEATMAP_PAN_FIXTURE.bucketStep,
        thresholdBtc: HEATMAP_PAN_FIXTURE.thresholdBtc,
        phases: ["static", "pan", "zoom", "live-book-invalidation"],
      });
    }
    scenarios.push({
      issue: "#260",
      chartCount,
      mode: "single",
      opacity: 0.65,
      scaleMode: "fixed",
      fixedCeilingBtc: HEATMAP_PAN_FIXTURE.fixedCeilingBtc,
      contrast: HEATMAP_PAN_FIXTURE.contrast,
      bucketStep: HEATMAP_PAN_FIXTURE.bucketStep,
      thresholdBtc: HEATMAP_PAN_FIXTURE.thresholdBtc,
      phases: ["static", "pan"],
    });
  }
  return scenarios;
}

export function buildHeatmapPanBars({
  barsCount = HEATMAP_PAN_FIXTURE.barsCount,
  levelsPerBar = HEATMAP_PAN_FIXTURE.levelsPerBar,
  basePrice = HEATMAP_PAN_FIXTURE.basePrice,
  bucketStep = HEATMAP_PAN_FIXTURE.bucketStep,
  intervalMs = HEATMAP_PAN_FIXTURE.intervalMs,
  frozenNow = HEATMAP_PAN_FIXTURE.frozenNow,
} = {}) {
  const lastTime = Math.floor(frozenNow / intervalMs) * intervalMs;
  const firstTime = lastTime - Math.max(0, barsCount - 1) * intervalMs;
  const bars = [];
  const heatmapBars = [];

  for (let barIndex = 0; barIndex < barsCount; barIndex++) {
    const t = firstTime + barIndex * intervalMs;
    const midPrice = basePrice + Math.floor(levelsPerBar / 2) * bucketStep;
    bars.push({
      t,
      o: midPrice - 50,
      h: basePrice + (levelsPerBar - 1) * bucketStep,
      l: basePrice,
      c: midPrice + 50,
      v: 20,
      d: 2,
      n: 20,
      cells: [
        [basePrice, 5, 5, 0, 0, 10, 5, 5],
        [midPrice, 5, 5, 0, 0, 10, 5, 5],
      ],
      lb: 0,
      ls: 0,
      completeness: "complete",
      updatedAt: frozenNow,
    });

    const cells = [];
    for (let level = 0; level < levelsPerBar; level++) {
      const price = basePrice + level * bucketStep;
      const middle = price + bucketStep / 2;
      // Include sub-threshold levels (<10 BTC), exact threshold (10 BTC), and mid/high walls (14..160 BTC).
      let btcValue;
      if (level % 10 === 0) btcValue = 5;
      else if (level % 10 === 1) btcValue = 10;
      else btcValue = 14 + ((barIndex * 7 + level * 11) % 146);
      const totalUsd = Math.round(btcValue * middle);
      const bidUsd = Math.floor(totalUsd / 2);
      const askUsd = totalUsd - bidUsd;
      cells.push([price, bidUsd, askUsd]);
    }
    heatmapBars.push({ t, cells });
  }

  return { bars, heatmapBars, firstTime, lastTime };
}

export function evaluateHeatmapPanHardwareGuardrail(probe, hardwareMode = false) {
  const valid = Boolean(hardwareMode && probe && probe.hardwareValid === true);
  return {
    hardwareValid: valid,
    decision: valid ? "EVALUATED" : "NOT_EVALUATED_HARDWARE_INVALID",
    invalidReason: !hardwareMode
      ? "ci-non-hardware-mode"
      : (probe?.invalidReason ?? (valid ? null : "software-or-unmasked-unavailable")),
  };
}

export function summarizeHeatmapSamples(values) {
  const valid = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (valid.length === 0) {
    return { count: 0, meanMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const round3 = (n) => Math.round(n * 1_000) / 1_000;
  const sum = valid.reduce((acc, n) => acc + n, 0);
  const at = (q) => valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(q * valid.length) - 1))];
  return {
    count: valid.length,
    meanMs: round3(sum / valid.length),
    minMs: round3(valid[0]),
    maxMs: round3(valid[valid.length - 1]),
    p50Ms: round3(at(0.5)),
    p95Ms: round3(at(0.95)),
    p99Ms: round3(at(0.99)),
  };
}

function fmtMs(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "—";
}

function fmtBytes(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : "—";
}

export function makeHeatmapPanMarkdown(report) {
  const probe = report?.rendererProbe ?? {};
  const vendor = probe.unmaskedVendor ?? probe.vendor ?? "unknown";
  const renderer = probe.unmaskedRenderer ?? probe.renderer ?? "unknown";
  const rows = (report?.results ?? []).map((entry) => {
    const hm = entry.heatmapMs ?? {};
    const ann = entry.annotationMs ?? {};
    const frm = entry.frameMs ?? {};
    const c = entry.counters ?? {};
    return `| ${entry.chartCount ?? "—"} | ${entry.label ?? "—"} | ${entry.phase ?? "—"} | ${hm.count ?? 0} | ${fmtMs(hm.p50Ms)} | ${fmtMs(hm.p95Ms)} | ${fmtMs(hm.p99Ms)} | ${fmtMs(ann.p95Ms)} | ${fmtMs(frm.p95Ms)} | ${c.hit ?? 0}/${c.skip ?? 0}/${c.miss ?? 0}/${c.motionReuse ?? 0}/${c.tailPatch ?? 0} | ${entry.visibleCells ?? "—"} | ${fmtBytes(entry.reservedRasterBytes)} |`;
  }).join("\n");

  const parityRows = (report?.colorParity ?? []).map((p) =>
    `| ${p.opacity} | ${p.normalMatch ? "PASS" : "FAIL"} | ${p.liveExtMatch ? "PASS" : "FAIL"} | ${p.normalDeltaMax ?? "—"} | ${p.liveExtDeltaMax ?? "—"} |`,
  ).join("\n");

  return `# Heatmap Pan/LUT/Raster Optimization Report (#260 / #256)\n\n`
    + `- Run: ${report?.runId ?? "unknown"}\n`
    + `- Decision: **${report?.decision ?? "NOT_EVALUATED_HARDWARE_INVALID"}**\n`
    + `- Hardware valid: **${Boolean(report?.hardwareValid)}**\n`
    + `- Invalid reason: ${report?.invalidReason ?? "none"}\n`
    + `- Preset: Single (Binance perp) | BTC | $${HEATMAP_PAN_FIXTURE.bucketStep} | ${HEATMAP_PAN_FIXTURE.thresholdBtc} BTC | Auto P96 (${HEATMAP_PAN_FIXTURE.contrast})\n`
    + `- WebGL2 renderer: ${vendor} / ${renderer}\n`
    + `- Host OS: ${report?.host?.platform ?? "unknown"} ${report?.host?.release ?? ""} (${report?.host?.architecture ?? "unknown"})\n`
    + `- Chromium: ${report?.browser?.version ?? "unknown"}\n\n`
    + `## Guardrail\n\n`
    + `- ${HEATMAP_PAN_DECISION_RULE.hardwareRule}\n`
    + `- ${HEATMAP_PAN_DECISION_RULE.softwareBehavior}\n\n`
    + `## Preset & Motion Measurements\n\n`
    + `| Charts | Condition | Phase | n | heatmap p50 ms | heatmap p95 ms | heatmap p99 ms | annotation p95 ms | frame p95 ms | hit/skip/miss/reuse/tail | Visible cells | Raster bytes |\n`
    + `| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |\n`
    + `${rows}\n\n`
    + `## Color & Alpha Parity (Normal + Live Extension 0.45)\n\n`
    + `| Opacity | Normal cell | Live extension | Max Δ (normal) | Max Δ (live ext) |\n`
    + `| --- | --- | --- | ---: | ---: |\n`
    + `${parityRows}\n`;
}
