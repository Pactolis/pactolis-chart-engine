import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTpoProfileGroups, effectiveTpoBracketMs } from "../dist/core/analysis/tpoProfile.js";
import { configurePerformanceTelemetry, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";
import { drawTpo } from "../dist/core/render/overlay/tpoPaintHelpers.js";

const INTERVAL = 30 * 60_000;
const DAY = 48 * INTERVAL;
const START = Date.UTC(2026, 10, 1);

function makeBar(startTime, index) {
  const open = 100 + index % 7;
  return { startTime, open, high: open + 3, low: open - 2, close: open + 1, volume: 1, delta: 1,
    count: 1, cells: new Map(), sources: ["history"], hasRef: true };
}

function fixture(count = 5 * 48, intervalMs = INTERVAL) {
  let bars = Array.from({ length: count }, (_, index) => makeBar(START + index * intervalMs, index));
  const series = { config: { intervalMs, priceStep: 1 }, revision: 1, listReadonly: () => bars };
  let vaPercent = 0.7;
  const view = {
    area: { left: 0, top: 0, width: 800, height: 400 }, colWidth: 8,
    xOfIndex: (index) => index * 8, yOfPrice: (price) => 200 - price * 2, priceOfY: () => 100,
  };
  const host = {
    ctx: { save() {}, restore() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, fillText() {} },
    chartConfig: { chartType: "tpo", tpoProfilePeriod: "daily", tpoBracketSize: "30m", tpoMode: "blocks" },
    tpoCache: null,
    tpoMergeLeftSessionStarts: new Set(),
    getProfileSettings: () => ({ valueAreaPercent: vaPercent }),
    pushTpoProfileHitZone() {},
  };
  return {
    host, series,
    get bars() { return bars; },
    setValueArea(percent) { vaPercent = percent; },
    setBars(next) { bars = next; series.revision++; },
    draw(from = 0, to = bars.length) {
      drawTpo(host, view, series, [from, to]);
      const { priceStep, intervalMs: interval } = series.config;
      const { tpoProfilePeriod, tpoBracketSize } = host.chartConfig;
      const oracle = buildTpoProfileGroups(bars, from, to, tpoProfilePeriod,
        effectiveTpoBracketMs(tpoBracketSize, interval), interval, priceStep, vaPercent, host.tpoMergeLeftSessionStarts);
      assert.deepStrictEqual(host.tpoCache.brackets, oracle.brackets);
      assert.deepStrictEqual(host.tpoCache.groups, oracle.groups);
      return host.tpoCache.groups.map(({ result }) => result);
    },
  };
}

function computedGroups() {
  return snapshotPerformanceTelemetry().counters["chart.tpo.compute.groups"] ?? 0;
}

test("live TPO updates recompute only the active profile and preserve closed results and brackets", () => {
  const { enabled } = snapshotPerformanceTelemetry();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const f = fixture(4 * 48 + 17);
    const initial = f.draw();
    const firstBracket = f.host.tpoCache.brackets[0];
    const before = computedGroups();
    const tail = f.bars.at(-1);
    tail.high += 4;
    tail.close = tail.high;
    f.series.revision++;
    const updated = f.draw();
    assert.equal(computedGroups() - before, 1);
    for (let i = 0; i < 4; i++) assert.strictEqual(updated[i], initial[i]);
    assert.strictEqual(f.host.tpoCache.brackets[0], firstBracket);
    assert.notStrictEqual(updated[4], initial[4]);

    tail.volume += 0.01;
    tail.cellRevision = 1;
    tail.sources.push("live");
    f.series.revision++;
    assert.strictEqual(f.draw()[4], updated[4], "trade metadata alone preserves the TPO profile");
    assert.equal(computedGroups() - before, 1);
  } finally {
    configurePerformanceTelemetry({ enabled });
  }
});

test("repair and a new daily session preserve profiles outside the changed group", () => {
  const f = fixture();
  const initial = f.draw();
  const repaired = [...f.bars];
  repaired[52] = { ...repaired[52], low: 92, sources: ["recovery"] };
  f.setBars(repaired);
  const afterRepair = f.draw();
  for (const index of [0, 2, 3, 4]) assert.strictEqual(afterRepair[index], initial[index]);
  assert.notStrictEqual(afterRepair[1], initial[1]);

  f.setBars([...f.bars, makeBar(START + 5 * DAY, 240)]);
  const rolled = f.draw();
  assert.equal(rolled.length, 6);
  for (let i = 0; i < 5; i++) assert.strictEqual(rolled[i], afterRepair[i]);
  assert.equal(f.host.tpoCache.groups[4].partial, false);
  assert.equal(f.host.tpoCache.groups[5].partial, true);
});

test("TPO cache agrees with the oracle after prepend, merge, undo and viewport eviction", () => {
  const f = fixture();
  f.draw();
  const prepended = Array.from({ length: 48 }, (_, index) => makeBar(START - DAY + index * INTERVAL, index));
  f.setBars([...prepended, ...f.bars]);
  f.series.structureRevision = 2;
  const initial = f.draw();
  f.host.tpoMergeLeftSessionStarts.add(START + DAY);
  const merged = f.draw(99, 143);
  assert.equal(merged.length, 1);
  assert.deepStrictEqual(f.host.tpoCache.groups[0].sessionStarts, [START, START + DAY]);
  f.host.tpoMergeLeftSessionStarts.clear();
  f.draw(99, 143);
  const expanded = f.draw();
  assert.notStrictEqual(expanded[0], initial[0], "offscreen groups are evicted");
});

test("profile settings and interval changes rebuild cache entries; backward replay stays as-of", () => {
  const f = fixture();
  const reconfigure = (update) => {
    const before = f.draw();
    update();
    const after = f.draw();
    assert.ok(after.every((result) => !before.includes(result)));
  };
  reconfigure(() => f.setValueArea(0.8));
  reconfigure(() => { f.host.chartConfig.tpoBracketSize = "1h"; });
  reconfigure(() => { f.host.chartConfig.tpoProfilePeriod = "weekly"; });
  reconfigure(() => { f.series.config.priceStep = 0.5; });
  reconfigure(() => { f.series.config.intervalMs = 15 * 60_000; });

  const full = f.bars;
  f.setBars(full.slice(0, 73));
  f.draw(59, 71);
  const group = f.host.tpoCache.groups.at(-1);
  assert.equal(group.lastIdx, 72);
  assert.equal(group.partial, true);
  assert.ok(group.result.toTime <= full[72].startTime);
  f.setBars(full);
  f.draw(59, 71);
});

test("sessions follow bracket starts even when a multi-hour bracket crosses midnight", () => {
  const f = fixture(50, 5 * 60 * 60_000);
  for (const period of ["daily", "weekly", "monthly", "visible"]) {
    f.host.chartConfig.tpoProfilePeriod = period;
    f.draw(3, 38);
    f.draw(14, 29);
  }
});
