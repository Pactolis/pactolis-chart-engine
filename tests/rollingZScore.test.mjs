import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_MS,
  DEFAULT_ZSCORE_MIN_SPAN_MS,
  RollingZScoreWindow,
  rollingZScore,
} from "../dist/core/analysis/rollingZScore.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

test("rollingZScore matches manual mean, sample std, and z-score over [t - windowMs, t)", () => {
  const values = [10, 12, 14, 16, 20];
  const samples = values.map((value, i) => ({ t: T0 + i * HOUR_MS, value }));
  const result = rollingZScore(samples, {
    windowMs: 10 * HOUR_MS,
    minSpanMs: 3 * HOUR_MS,
    minSamples: 2,
  });

  // Index 0..2 have span < 3h
  assert.equal(result[0].zScore, null);
  assert.equal(result[0].insufficientData, true);
  assert.equal(result[1].zScore, null);
  assert.equal(result[2].zScore, null);

  // Index 3 (t = T0 + 3h): prior window [T0, T0 + 3h) = [10, 12, 14]
  // mean = 12, sample variance = ((10-12)^2 + (12-12)^2 + (14-12)^2) / 2 = 4, std = 2
  // z = (16 - 12) / 2 = 2
  assert.equal(result[3].insufficientData, false);
  assert.ok(Math.abs(result[3].mean - 12) < 1e-12);
  assert.ok(Math.abs(result[3].std - 2) < 1e-12);
  assert.ok(Math.abs(result[3].zScore - 2) < 1e-12);

  // Index 4 (t = T0 + 4h): prior window = [10, 12, 14, 16]
  // mean = 13, sample variance = (9 + 1 + 1 + 9) / 3 = 20 / 3
  const expectedMean = 13;
  const expectedStd = Math.sqrt(20 / 3);
  const expectedZ = (20 - expectedMean) / expectedStd;
  assert.ok(Math.abs(result[4].mean - expectedMean) < 1e-12);
  assert.ok(Math.abs(result[4].std - expectedStd) < 1e-12);
  assert.ok(Math.abs(result[4].zScore - expectedZ) < 1e-12);
});

test("rollingZScore enforces default 7-day minimum data span", () => {
  const totalHours = 8 * 24; // 8 days hourly
  const samples = Array.from({ length: totalHours }, (_, i) => ({
    t: T0 + i * HOUR_MS,
    value: 0.0001 + (i % 5) * 0.00001,
  }));
  const result = rollingZScore(samples);

  const sevenDaysHours = DEFAULT_ZSCORE_MIN_SPAN_MS / HOUR_MS; // 168
  for (let i = 0; i < sevenDaysHours; i++) {
    assert.equal(result[i].insufficientData, true, `hour ${i} (< 7d) must be insufficientData`);
    assert.equal(result[i].zScore, null, `hour ${i} (< 7d) must have null zScore`);
  }
  assert.equal(result[sevenDaysHours].insufficientData, false, "at 7d span, zScore must be emitted");
  assert.ok(Number.isFinite(result[sevenDaysHours].zScore));
});

test("rollingZScore returns null zScore when std === 0", () => {
  const samples = Array.from({ length: 10 * 24 }, (_, i) => ({
    t: T0 + i * HOUR_MS,
    value: 0.0001,
  }));
  const result = rollingZScore(samples, { windowMs: 30 * DAY_MS, minSpanMs: DEFAULT_ZSCORE_MIN_SPAN_MS });
  const last = result[result.length - 1];
  assert.equal(last.mean, 0.0001);
  assert.equal(last.std, 0);
  assert.equal(last.zScore, null);
  assert.equal(last.insufficientData, true);
});

test("RollingZScoreWindow incremental push matches batch rollingZScore with eviction and non-finite inputs", () => {
  const samples = Array.from({ length: 40 * 24 }, (_, i) => ({
    t: T0 + i * HOUR_MS,
    value: i === 200 ? Number.NaN : 0.0001 + Math.sin(i / 6) * 0.00005,
  }));

  const batch = rollingZScore(samples, { windowMs: 14 * DAY_MS, minSpanMs: 7 * DAY_MS });
  const win = new RollingZScoreWindow({ windowMs: 14 * DAY_MS, minSpanMs: 7 * DAY_MS });
  const incremental = samples.map((s) => win.push(s.t, s.value));

  assert.equal(incremental.length, batch.length);
  for (let i = 0; i < batch.length; i++) {
    assert.equal(incremental[i].insufficientData, batch[i].insufficientData);
    assert.equal(incremental[i].zScore, batch[i].zScore);
    assert.equal(incremental[i].mean, batch[i].mean);
    assert.equal(incremental[i].std, batch[i].std);
  }
  assert.equal(incremental[200].zScore, null);
  assert.equal(incremental[200].insufficientData, true);
});
