import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTpoSessionSpans,
  aggregateTpoBrackets,
  buildTpoBracketSpans,
  calculateTpoProfile,
  effectiveTpoBracketMs,
  mergeTpoSessionSpans,
  tpoBracketLabel,
} from "../dist/core/analysis/tpoProfile.js";

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
