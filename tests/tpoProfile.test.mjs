import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTpoSessionSpans,
  aggregateTpoBrackets,
  buildTpoBracketSpans,
  buildTpoProfileGroups,
  calculateTpoProfile,
  effectiveTpoBracketMs,
  mergeTpoSessionSpans,
  tpoBracketLabel,
  tpoSessionRange,
  tpoSessionPartial,
} from "../dist/core/analysis/tpoProfile.js";
import { chartLocale, configureChartLocale } from "../dist/core/chartLocale.js";
import { drawTpo } from "../dist/core/render/overlay/tpoPaintHelpers.js";

const STEP = 10;

function bar(startTime, low, high) {
  return {
    startTime, open: low, high, low, close: high,
    volume: 0, delta: 0, count: 0, cells: new Map(), hasRef: true,
  };
}

function countMap(result) {
  return Object.fromEntries(result.levels.map((l) => [l.priceBin, l.count]));
}

function bracketIndexMap(result) {
  return Object.fromEntries(result.levels.map((l) => [l.priceBin, l.bracketIndices]));
}

test("counts one TPO per bracket for each price bin its range spans", () => {
  const result = calculateTpoProfile([
    bar(0, 100, 120),       // bins 100,110,120
    bar(1, 110, 130),       // bins 110,120,130
  ], STEP);
  assert.deepEqual(countMap(result), { 100: 1, 110: 2, 120: 2, 130: 1 });
  assert.equal(result.totalCount, 6);
});

test("profile levels keep profile-local bracket indices for block shading", () => {
  const result = calculateTpoProfile([
    bar(0, 100, 120),
    bar(1, 110, 130),
    bar(2, 120, 120),
  ], STEP);
  assert.deepEqual(bracketIndexMap(result), {
    100: [0],
    110: [0, 1],
    120: [0, 1, 2],
    130: [1],
  });
});

test("POC is the most-touched level; value area covers the % of TPOs", () => {
  const result = calculateTpoProfile([
    bar(0, 100, 120),
    bar(1, 110, 130),
  ], STEP, 0.7);
  assert.equal(result.poc, 110);   // count 2, first max
  assert.equal(result.val, 100);
  assert.equal(result.vah, 120);
});

test("single-level bar yields poc=vah=val at that bin", () => {
  const result = calculateTpoProfile([bar(0, 100, 100)], STEP);
  assert.deepEqual(countMap(result), { 100: 1 });
  assert.equal(result.poc, 100);
  assert.equal(result.vah, 100);
  assert.equal(result.val, 100);
});

test("empty input returns null levels", () => {
  const result = calculateTpoProfile([], STEP);
  assert.equal(result.levels.length, 0);
  assert.equal(result.totalCount, 0);
  assert.equal(result.poc, null);
});

test("non-positive price step is handled safely", () => {
  const result = calculateTpoProfile([bar(0, 100, 120)], 0);
  assert.equal(result.levels.length, 0);
  assert.equal(result.poc, null);
});

test("bracket labels follow A..Z, a..z, then raw index", () => {
  assert.equal(tpoBracketLabel(0), "A");
  assert.equal(tpoBracketLabel(25), "Z");
  assert.equal(tpoBracketLabel(26), "a");
  assert.equal(tpoBracketLabel(51), "z");
  assert.equal(tpoBracketLabel(52), "52");
  assert.equal(tpoBracketLabel(-1), "");
});

test("session spans merge left through boundary session starts", () => {
  const day = 86_400_000;
  const bars = [
    bar(0, 100, 100),
    bar(day, 110, 110),
    bar(day * 2, 120, 120),
    bar(day * 3, 130, 130),
  ];
  const spans = buildTpoSessionSpans(bars, 0, bars.length, day);
  assert.deepEqual(spans.map((span) => span.sessionStart), [0, day, day * 2, day * 3]);

  const merged = mergeTpoSessionSpans(spans, new Set([day, day * 2]));
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].sessionStarts, [0, day, day * 2]);
  assert.equal(merged[0].firstIdx, 0);
  assert.equal(merged[0].lastIdx, 2);
  assert.deepEqual(merged[1].sessionStarts, [day * 3]);
});

test("TPO brackets aggregate finer chart bars independently from chart timeframe", () => {
  const fiveMinutes = 5 * 60_000;
  const bars = Array.from({ length: 7 }, (_, index) => bar(index * fiveMinutes, 100 + index, 102 + index));
  const bracketMs = effectiveTpoBracketMs("30m", fiveMinutes);
  const brackets = aggregateTpoBrackets(bars, 0, bars.length, bracketMs);
  assert.equal(bracketMs, 30 * 60_000);
  assert.equal(brackets.length, 2);
  assert.equal(brackets[0].firstIdx, 0);
  assert.equal(brackets[0].lastIdx, 5);
  assert.equal(brackets[0].bar.open, 100);
  assert.equal(brackets[0].bar.high, 107);
  assert.equal(brackets[0].bar.low, 100);
  assert.equal(brackets[0].bar.close, 107);
  assert.equal(brackets[1].firstIdx, 6);
  assert.equal(brackets[1].lastIdx, 6);

  const spans = buildTpoBracketSpans(brackets, "daily");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].firstBracketIndex, 0);
  assert.equal(spans[0].lastBracketIndex, 1);
});

test("visible TPO profile period keeps the loaded range as one profile", () => {
  const day = 86_400_000;
  const bars = [
    bar(0, 100, 100),
    bar(day, 110, 110),
    bar(day * 2, 120, 120),
  ];
  const brackets = aggregateTpoBrackets(bars, 0, bars.length, day);
  const spans = buildTpoBracketSpans(brackets, "visible");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].sessionStart, 0);
  assert.equal(spans[0].firstBracketIndex, 0);
  assert.equal(spans[0].lastBracketIndex, 2);
  assert.equal(spans[0].firstIdx, 0);
  assert.equal(spans[0].lastIdx, 2);
});

test("effective TPO bracket never becomes finer than loaded chart bars", () => {
  assert.equal(effectiveTpoBracketMs("30m", 60 * 60_000), 60 * 60_000);
  assert.equal(effectiveTpoBracketMs("auto", 15 * 60_000), 15 * 60_000);
});


test("session profile is invariant to viewport clipping and keeps a stable cache range", () => {
  const hour = 3600000;
  const base = Date.UTC(2026, 10, 3);
  const bars = Array.from({ length: 72 }, (_, i) => bar(base + i * hour, i % 24 < 12 ? 100 : 130, i % 24 < 12 ? 110 : 140));
  const ranges = [[24, 48], [34, 40], [25, 47]].map(([from, to]) => tpoSessionRange(bars, from, to, "daily"));
  assert.deepEqual(ranges, [[24, 48], [24, 48], [24, 48]]);
  const profiles = ranges.map(([from, to]) => calculateTpoProfile(aggregateTpoBrackets(bars, from, to, hour).map((b) => b.bar), STEP, 0.7));
  assert.deepEqual(profiles[0], profiles[1]);
  assert.equal(tpoSessionPartial(bars, 24, 47, "daily", hour), false);
  assert.equal(tpoSessionPartial(bars.slice(30), 0, 17, "daily", hour), true);
});

test("daily TPO groups keep POC/VA and partial coverage invariant across A/B/C/D viewports", () => {
  const hour = 3_600_000;
  const day = 24 * hour;
  const base = Date.UTC(2026, 10, 3);
  const full = Array.from({ length: 72 }, (_, i) => bar(base + i * hour, i % 6 < 3 ? 100 : 130, i % 6 < 3 ? 110 : 140));
  const viewports = [[24, 48], [30, 36], [36, 42], [47, 48]];
  const fullGroups = viewports.map(([from, to]) =>
    buildTpoProfileGroups(full, from, to, "daily", hour, hour, STEP).groups,
  );
  assert.ok(fullGroups.every((groups) => groups.length === 1 && groups[0].partial === false));
  for (const groups of fullGroups.slice(1)) assert.deepEqual(groups, fullGroups[0]);

  // The same four viewports over an already-loaded partial session all disclose
  // partial coverage while using exactly the same loaded bars and profile values.
  const partial = full.slice(30, 48);
  const partialViewports = [[0, 18], [0, 6], [6, 12], [17, 18]];
  const partialGroups = partialViewports.map(([from, to]) =>
    buildTpoProfileGroups(partial, from, to, "daily", hour, hour, STEP).groups,
  );
  assert.ok(partialGroups.every((groups) => groups.length === 1 && groups[0].partial === true));
  for (const groups of partialGroups.slice(1)) assert.deepEqual(groups, partialGroups[0]);
  assert.equal(partial.length, 18, "profile calculation reuses loaded bars and does not fetch more history");
  assert.equal(buildTpoProfileGroups(partial, 5, 8, "daily", hour, hour, STEP).groups[0].sessionStarts[0], base + day);
});

test("replay as-of series cannot contribute future bars to an expanded TPO session", () => {
  const hour = 3600000;
  const base = Date.UTC(2026, 10, 3);
  const replay = Array.from({ length: 12 }, (_, i) => bar(base + i * hour, 100, 110));
  assert.deepEqual(tpoSessionRange(replay, 8, 10, "daily"), [0, 12]);
  assert.equal(tpoSessionPartial(replay, 0, 11, "daily", hour), true);
  assert.equal(aggregateTpoBrackets(replay, 0, 12, hour).length, 12);
  const full = Array.from({ length: 24 }, (_, i) => bar(base + i * hour, 100 + i, 110 + i));
  const atTen = full.slice(0, 10);
  const replayGroup = buildTpoProfileGroups(atTen, 8, 10, "daily", hour, hour, STEP).groups[0];
  const liveCutGroup = buildTpoProfileGroups(full.slice(0, 10), 0, 10, "daily", hour, hour, STEP).groups[0];
  assert.deepEqual(replayGroup, liveCutGroup, "replay at t matches live calculation over the same bars through t");
  assert.equal(replayGroup.lastIdx, 9, "future bars in the original full series are outside replay input");
});

test("partial TPO drawing disclosure is localized in Turkish and English", () => {
  const previous = chartLocale();
  const labels = [];
  const ctx = {
    save() {}, restore() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    setLineDash() {}, fillText(text) { labels.push(text); }, font: "", fillStyle: "", strokeStyle: "", lineWidth: 1,
    globalAlpha: 1, textBaseline: "middle", textAlign: "left",
  };
  const hour = 3_600_000;
  const base = Date.UTC(2026, 10, 3);
  const bars = Array.from({ length: 4 }, (_, i) => bar(base + i * hour, 100, 110));
  const series = { config: { intervalMs: hour, priceStep: STEP }, revision: 1, listReadonly: () => bars };
  const view = {
    area: { left: 0, top: 0, width: 800, height: 400 }, colWidth: 8,
    xOfIndex: (index) => index * 8,
    yOfPrice: (price) => 200 - price * 2,
    priceOfY: () => 100,
  };
  const host = {
    ctx,
    chartConfig: { chartType: "tpo", tpoProfilePeriod: "daily", tpoBracketSize: "auto", tpoMode: "blocks" },
    tpoCache: null,
    tpoMergeLeftSessionStarts: new Set(),
    getProfileSettings: () => ({ valueAreaPercent: 0.7 }),
    pushTpoProfileHitZone() {},
  };
  try {
    for (const [locale, expected] of [["tr-TR", "Kısmi"], ["en-US", "Partial"]]) {
      labels.length = 0;
      configureChartLocale({ locale: () => locale, timeZone: () => "UTC", translate: (key) => key, onLocaleChange: () => () => {} });
      host.tpoCache = null;
      drawTpo(host, view, series, [0, bars.length]);
      assert.ok(labels.includes(expected), `${locale} drawing label`);
    }
  } finally {
    configureChartLocale(previous);
  }
});
