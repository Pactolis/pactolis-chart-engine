export const WEBGL2_HEATMAP_STORAGE_VARIANTS = Object.freeze(["mutable", "immutable", "bucket"]);
export const WEBGL2_HEATMAP_STORAGE_WORKLOADS = Object.freeze(["static", "fixed-update", "resize"]);

export const WEBGL2_HEATMAP_STORAGE_DECISION_RULE = Object.freeze({
  name: "webgl2-resident-heatmap-storage-research",
  speedupThreshold: 1.10,
  requireFewerResizeAllocs: true,
  requireZeroGlErrors: true,
  requireHardwareRenderer: true,
});

function parseChartCounts(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return Object.freeze([...fallback]);
  const list = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 16);
  if (list.length === 0) {
    throw new Error(`Invalid chartCounts: ${raw} (expected comma-separated integers in 1..16)`);
  }
  return Object.freeze(list);
}

export function resolveWebGl2HeatmapStorageFixture({ hardwareMode = false, chartCounts } = {}) {
  const hw = Boolean(hardwareMode);
  return Object.freeze({
    hardwareMode: hw,
    viewport: Object.freeze({ width: 1280, height: 800 }),
    plot: Object.freeze({ left: 0, top: 0, width: 1200, height: 760, pixelRatio: 1 }),
    chartCounts: parseChartCounts(chartCounts, hw ? [1, 8] : [1]),
    repetitions: hw ? 3 : 1,
    warmupFrames: hw ? 16 : 4,
    measuredFrames: hw ? 36 : 8,
    staticCells: hw ? 40_000 : 4_000,
    resizePattern: Object.freeze(hw ? [15_000, 40_000, 16_000, 39_000] : [1_500, 4_000, 1_600, 3_900]),
  });
}

export function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

export function medianOf(values) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (valid.length === 0) return 0;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid] : round4((valid[mid - 1] + valid[mid]) / 2);
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

function findRow(rows, variant, workload, chartCount) {
  return rows.find((r) => r.variant === variant && r.workload === workload && r.chartCount === chartCount) ?? null;
}

export function evaluateWebGl2StorageDecision({ hardwareValid = false, rows = [] } = {}) {
  if (!hardwareValid) {
    return {
      decision: "HARDWARE_INVALID",
      reason: "Donanım dışı (software) WebGL2 renderer veya eksik unmasked kimlik nedeniyle donanım kararı üretilemedi.",
      comparisons: [],
    };
  }

  const chartCounts = [...new Set(rows.map((r) => r.chartCount))].sort((a, b) => a - b);
  const comparisons = [];
  let hasRecommendableWin = false;

  for (const chartCount of chartCounts) {
    for (const workload of WEBGL2_HEATMAP_STORAGE_WORKLOADS) {
      const mut = findRow(rows, "mutable", workload, chartCount);
      const imm = findRow(rows, "immutable", workload, chartCount);
      const buc = findRow(rows, "bucket", workload, chartCount);
      if (!mut || !buc) continue;

      const mutP95 = mut.frame?.p95Ms ?? 0;
      const immP95 = imm?.frame?.p95Ms ?? 0;
      const bucP95 = buc.frame?.p95Ms ?? 0;
      const speedupBucketVsMutable = mutP95 > 0 && bucP95 > 0 ? round4(mutP95 / bucP95) : 1;
      const speedupImmutableVsMutable = mutP95 > 0 && immP95 > 0 ? round4(mutP95 / immP95) : 1;
      const allocReduction = mut.textureAllocCount > 0 ? buc.textureAllocCount < mut.textureAllocCount : false;

      if (
        (workload === "resize" && allocReduction && speedupBucketVsMutable >= WEBGL2_HEATMAP_STORAGE_DECISION_RULE.speedupThreshold)
        || (speedupBucketVsMutable >= WEBGL2_HEATMAP_STORAGE_DECISION_RULE.speedupThreshold && chartCount >= 1)
      ) {
        hasRecommendableWin = true;
      }

      comparisons.push({
        chartCount,
        workload,
        mutableFrameP95Ms: mutP95,
        immutableFrameP95Ms: immP95,
        bucketFrameP95Ms: bucP95,
        speedupImmutableVsMutable,
        speedupBucketVsMutable,
        mutableAllocCount: mut.textureAllocCount ?? 0,
        immutableAllocCount: imm?.textureAllocCount ?? 0,
        bucketAllocCount: buc.textureAllocCount ?? 0,
      });
    }
  }

  if (comparisons.length === 0) {
    return {
      decision: "RECOMMEND_NOT_PLANNED",
      reason: "Kıyaslanabilir benchmark satırı bulunamadı.",
      comparisons,
    };
  }

  if (hasRecommendableWin) {
    return {
      decision: "RECOMMEND_IMPLEMENT",
      reason: "Power-of-two bucket texStorage2D yeniden kullanımı allocation sayısını düşürüp p95 kare süresinde anlamlı iyileşme sağladı.",
      comparisons,
    };
  }

  return {
    decision: "RECOMMEND_NOT_PLANNED",
    reason: "texStorage2D / bucket yeniden kullanımı allocation sayısını azaltsa da donanım p95 kare süresinde >= 1.10x eşik iyileşme göstermedi.",
    comparisons,
  };
}

function fmtNum(v, digits = 3) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "yok";
}

export function formatWebGl2HeatmapStorageMarkdown(report) {
  const gl = report.webglInfo ?? {};
  const lines = [
    `# WebGL2 Resident Heatmap texStorage2D ve Kapasite Yeniden Kullanım Kıyaslaması (#257)`,
    ``,
    `- **Çalışma ID:** ${report.runId ?? "yok"}`,
    `- **Tarih:** ${report.createdAt ?? "yok"}`,
    `- **Mod:** ${report.fixture?.hardwareMode ? "Donanım" : "CI Smoke"}`,
    `- **GL Renderer:** ${gl.unmaskedVendor ?? gl.vendor ?? "bilinmiyor"} / ${gl.unmaskedRenderer ?? gl.renderer ?? "bilinmiyor"}`,
    `- **Donanım Geçerliliği:** ${Boolean(report.hardwareValid)}`,
    `- **Karar:** ${report.assessment?.decision ?? "BİLİNMİYOR"}`,
    `- **Gerekçe:** ${report.assessment?.reason ?? "yok"}`,
    ``,
    `## Senaryo Sonuçları`,
    ``,
    `| Grafik | İş Yükü | Varyant | Frame p50 (ms) | Frame p95 (ms) | GPU p95 (ms) | Doku Allocation | Zirve Doku (MiB) | GL Hata |`,
    `| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];

  for (const row of report.rows ?? []) {
    lines.push(
      `| ${row.chartCount} | ${row.workload} | ${row.variant} | ${fmtNum(row.frame?.p50Ms)} | ${fmtNum(row.frame?.p95Ms)} | ${row.gpu?.count ? fmtNum(row.gpu.p95Ms) : "yok"} | ${row.textureAllocCount ?? 0} | ${fmtNum(row.texturePayloadPeakMiB, 4)} | ${row.glError ?? 0} |`,
    );
  }

  if ((report.assessment?.comparisons?.length ?? 0) > 0) {
    lines.push(
      ``,
      `## Hızlanma Özeti (\`mutable\` Tabanlı)`,
      ``,
      `| Grafik | İş Yükü | \`immutable\` p95 Hızlanma | \`bucket\` p95 Hızlanma | Allocation (\`mutable / immutable / bucket\`) |`,
      `| ---: | --- | ---: | ---: | --- |`,
    );
    for (const c of report.assessment.comparisons) {
      lines.push(
        `| ${c.chartCount} | ${c.workload} | ${fmtNum(c.speedupImmutableVsMutable, 2)}x | ${fmtNum(c.speedupBucketVsMutable, 2)}x | ${c.mutableAllocCount} / ${c.immutableAllocCount} / ${c.bucketAllocCount} |`,
      );
    }
  }

  return lines.join("\n");
}
