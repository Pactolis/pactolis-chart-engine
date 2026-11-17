import { performance } from "node:perf_hooks";
import {
  aggregateTpoBrackets,
  buildTpoBracketSpans,
  calculateTpoProfile,
  mergeTpoSessionSpans,
  tpoSessionRange,
} from "../dist/core/analysis/tpoProfile.js";
import { bucketStart, DAY_MS } from "../dist/core/time.js";

const INTERVAL_MS = 30 * 60_000;
const PRICE_STEP = 10;
const VALUE_AREA_PERCENT = 0.7;
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = 40;
const BASE_TIME = Date.UTC(2026, 0, 1);
const sessionMs = DAY_MS;

function makeBars(days) {
  const bars = [];
  const barsPerDay = DAY_MS / INTERVAL_MS;
  for (let index = 0; index < days * barsPerDay; index += 1) {
    const day = Math.floor(index / barsPerDay);
    const slot = index % barsPerDay;
    const halfDay = slot < barsPerDay / 2 ? 0 : 1;
    const price = 60_000 + day * 2_000 + halfDay * 500 + (slot % 6) * PRICE_STEP;
    bars.push({
      startTime: BASE_TIME + index * INTERVAL_MS,
      open: price,
      high: price + (1 + (slot % 4)) * PRICE_STEP,
      low: price - (1 + (slot % 3)) * PRICE_STEP,
      close: price + PRICE_STEP / 2,
      volume: 100 + slot,
      delta: (slot % 9) - 4,
      count: 20 + (slot % 7),
      cells: new Map(),
      hasRef: true,
      sources: ["history"],
    });
  }
  return bars;
}

function profileSummary(brackets) {
  const result = calculateTpoProfile(brackets.map((bracket) => bracket.bar), PRICE_STEP, VALUE_AREA_PERCENT);
  return {
    brackets: brackets.length,
    tpoCount: result.totalCount,
    poc: result.poc,
    vah: result.vah,
    val: result.val,
  };
}

// Mirrors the data-selection and aggregation sequence in Overlay.drawTpo on the
// measured head. Session profiles expand the visible indices to complete loaded
// sessions; visible profiles deliberately retain the requested viewport.
function drawLikeCurrentOverlay(bars, from, to, period) {
  const [dataFrom, dataTo] = tpoSessionRange(bars, from, to, period);
  const brackets = aggregateTpoBrackets(bars, dataFrom, dataTo, INTERVAL_MS);
  const spans = buildTpoBracketSpans(brackets, period);
  const groups = mergeTpoSessionSpans(spans, new Set());
  return groups.map((group) => {
    const profileBrackets = brackets.slice(group.firstBracketIndex, group.lastBracketIndex + 1);
    return {
      sessionStart: group.sessionStarts[0],
      ...profileSummary(profileBrackets),
    };
  });
}

function formatPrice(value) {
  return value === null ? "—" : String(value);
}

function dailyViewportResults() {
  const bars = makeBars(3);
  const dayOneStart = 48;
  const viewports = [
    { label: "A 00:00–24:00", from: dayOneStart, to: dayOneStart + 48 },
    { label: "B 06:00–12:00", from: dayOneStart + 12, to: dayOneStart + 24 },
    { label: "C 12:00–18:00", from: dayOneStart + 24, to: dayOneStart + 36 },
    { label: "D 23:00–01:00", from: dayOneStart + 46, to: dayOneStart + 50 },
  ];
  const rows = [];
  const visibleRows = [];

  for (const viewport of viewports) {
    const currentProfiles = drawLikeCurrentOverlay(bars, viewport.from, viewport.to, "daily");
    const visibleProfiles = drawLikeCurrentOverlay(bars, viewport.from, viewport.to, "visible");
    const touchedSessionStarts = [...new Set(
      bars.slice(viewport.from, viewport.to).map((bar) => bucketStart(bar.startTime, sessionMs)),
    )];

    for (const sessionStart of touchedSessionStarts) {
      const first = bars.findIndex((bar) => bucketStart(bar.startTime, sessionMs) === sessionStart);
      const last = bars.findLastIndex((bar) => bucketStart(bar.startTime, sessionMs) === sessionStart);
      const oracle = profileSummary(aggregateTpoBrackets(bars, first, last + 1, INTERVAL_MS));
      const current = currentProfiles.find((profile) => profile.sessionStart === sessionStart);
      if (!current) throw new Error(`Current overlay path omitted loaded session ${new Date(sessionStart).toISOString()}`);
      const equal = current.brackets === oracle.brackets
        && current.tpoCount === oracle.tpoCount
        && current.poc === oracle.poc
        && current.vah === oracle.vah
        && current.val === oracle.val;
      rows.push({
        viewport: viewport.label,
        session: new Date(sessionStart).toISOString().slice(0, 10),
        current,
        oracle,
        parity: equal ? "yes" : "NO",
      });
    }

    const visible = visibleProfiles[0];
    visibleRows.push({
      viewport: viewport.label,
      brackets: visible?.brackets ?? 0,
      tpoCount: visible?.tpoCount ?? 0,
      poc: visible?.poc ?? null,
      vah: visible?.vah ?? null,
      val: visible?.val ?? null,
    });
  }
  return { rows, visibleRows };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function measureCacheMiss(days, chartCount) {
  const bars = makeBars(days);
  let sink = 0;
  const oneRenderRebuild = () => {
    for (let chart = 0; chart < chartCount; chart += 1) {
      const brackets = aggregateTpoBrackets(bars, 0, bars.length, INTERVAL_MS);
      const spans = buildTpoBracketSpans(brackets, "daily");
      sink += brackets.length + spans.length;
    }
  };
  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) oneRenderRebuild();

  const samples = [];
  for (let iteration = 0; iteration < MEASURED_ITERATIONS; iteration += 1) {
    const start = performance.now();
    oneRenderRebuild();
    samples.push(performance.now() - start);
  }
  const sorted = samples.sort((a, b) => a - b);
  return {
    days,
    charts: chartCount,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    samples: samples.length,
    sink,
  };
}

function printMarkdownTable(headers, rows) {
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
}

const { rows, visibleRows } = dailyViewportResults();
console.log(`# TPO viewport and cache-miss measurement`);
console.log(`Node ${process.version}; loaded synthetic 30m BTC bars; source SHA ${process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? "not supplied"}.`);
console.log(`The daily path below mirrors current Overlay.drawTpo data selection. Oracle recomputes the full loaded UTC session(s).`);
console.log(`Source check: aggregation and span building are inside the cache-miss branch on this head; the cost table is per rebuild, not every unchanged draw.`);
console.log(`\n## Daily viewport versus full-session oracle`);
printMarkdownTable(
  ["Viewport", "UTC session", "Current brackets", "Current TPO", "Current POC/VAH/VAL", "Oracle brackets", "Oracle TPO", "Oracle POC/VAH/VAL", "Parity"],
  rows.map(({ viewport, session, current, oracle, parity }) => [
    viewport,
    session,
    String(current.brackets),
    String(current.tpoCount),
    `${formatPrice(current.poc)} / ${formatPrice(current.vah)} / ${formatPrice(current.val)}`,
    String(oracle.brackets),
    String(oracle.tpoCount),
    `${formatPrice(oracle.poc)} / ${formatPrice(oracle.vah)} / ${formatPrice(oracle.val)}`,
    parity,
  ]),
);

console.log(`\n## Visible mode (viewport-dependent behavior is expected)`);
printMarkdownTable(
  ["Viewport", "Brackets", "TPO", "POC", "VAH", "VAL"],
  visibleRows.map((row) => [row.viewport, String(row.brackets), String(row.tpoCount), formatPrice(row.poc), formatPrice(row.vah), formatPrice(row.val)]),
);

console.log(`\n## Cache-miss aggregation + span-building cost`);
console.log(`${WARMUP_ITERATIONS} warm-ups, ${MEASURED_ITERATIONS} measured samples; p50/p95 are milliseconds per rebuild across the listed chart count. This measures the two functions inside Overlay.drawTpo's cache-miss branch.`);
const costRows = [];
for (const days of [1, 30, 365]) {
  for (const charts of [1, 4, 8]) costRows.push(measureCacheMiss(days, charts));
}
printMarkdownTable(
  ["Days", "Charts", "p50 ms", "p95 ms", "Samples"],
  costRows.map((row) => [String(row.days), String(row.charts), row.p50Ms.toFixed(3), row.p95Ms.toFixed(3), String(row.samples)]),
);

if (rows.some((row) => row.parity !== "yes")) process.exitCode = 1;
