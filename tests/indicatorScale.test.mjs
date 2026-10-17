import test from "node:test";
import assert from "node:assert/strict";
import { createIndicatorScale, indicatorDisplayRange } from "../dist/features/indicators/scale/indicatorScale.js";

test("indicator scale maps linear values to pane coordinates", () => {
  const scale = createIndicatorScale({ mode: "linear", min: -10, max: 30 }, { top: 100, bottom: 200 });

  assert.equal(scale.y(scale.max), 100);
  assert.equal(scale.y(scale.min), 200);
  assert.equal(scale.contains(0), true);
  assert.ok(scale.y(0) > 100 && scale.y(0) < 200);
  assert.equal(scale.format(23.456), "23.46");
  assert.equal(scale.format(-7), "-7.00");
});

test("signed-zero indicator scale fits its range instead of mirroring it around zero", () => {
  const scale = createIndicatorScale(
    { mode: "signed-zero", min: -25, max: 100, baseline: 0, paddingFraction: 0 },
    { top: 20, bottom: 120 },
  );

  assert.equal(scale.min, -25);
  assert.equal(scale.max, 100);
  assert.equal(scale.y(0), 100);
  assert.deepEqual(scale.ticks().map((tick) => tick.value), [100, 0, -25]);
});

test("signed-zero ticks skip zero out of view and an end tick crowding it", () => {
  const positive = createIndicatorScale({ mode: "signed-zero", min: 100, max: 200, baseline: 0 }, { top: 0, bottom: 100 });
  assert.equal(positive.contains(0), false);
  assert.deepEqual(positive.ticks().map((tick) => tick.value), [200, 150, 100]);

  const nearZero = createIndicatorScale({ mode: "signed-zero", min: -5, max: 100, baseline: 0 }, { top: 0, bottom: 100 });
  assert.deepEqual(nearZero.ticks().map((tick) => tick.value), [100, 0]);
});

test("tick labels that would repeat get the decimals their spacing needs", () => {
  const cvd = createIndicatorScale({ mode: "linear", min: 1411, max: 1523 }, { top: 0, bottom: 100 });
  assert.deepEqual(cvd.ticks().map((tick) => tick.label), ["1.52K", "1.47K", "1.41K"]);

  const usd = createIndicatorScale({ mode: "usd", min: -1523, max: -1411 }, { top: 0, bottom: 100 });
  assert.deepEqual(usd.ticks().map((tick) => tick.label), ["-$1.41K", "-$1.47K", "-$1.52K"]);

  const ratio = createIndicatorScale({ mode: "linear", min: 1.401, max: 1.405, formatter: (value) => `${value.toFixed(2)}x` }, { top: 0, bottom: 100 });
  assert.deepEqual(ratio.ticks().map((tick) => tick.label), ["1.405x", "1.403x", "1.401x"]);

  const wide = createIndicatorScale({ mode: "linear", min: 0, max: 100 }, { top: 0, bottom: 100 });
  assert.deepEqual(wide.ticks().map((tick) => tick.label), ["100.00", "50.00", "0.00"]);

  const grouped = createIndicatorScale({ mode: "linear", min: 1234.1, max: 1234.3, formatter: () => "1,234" }, { top: 0, bottom: 100 });
  assert.deepEqual(grouped.ticks().map((tick) => tick.label), ["1,234", "1,234", "1,234"]);
});

test("indicator scale does not force a baseline outside its range into view", () => {
  const rsi = createIndicatorScale({ mode: "percent", min: 55, max: 75, baseline: 50 }, { top: 0, bottom: 100 });
  assert.equal(rsi.min, 55);
  assert.equal(rsi.max, 75);
  assert.equal(rsi.contains(50), false);
});

test("indicator log display scale is finite and invertible for positive values", () => {
  const scale = createIndicatorScale({ mode: "linear", min: 1, max: 100, displayMode: "log" }, { top: 10, bottom: 210 });
  assert.equal(scale.displayMode, "log");
  assert.ok(Math.abs(scale.y(10) - 110) < 1e-9);
  assert.ok(Math.abs(scale.valueAtY(scale.y(25)) - 25) < 1e-9);
});

test("indicator log display scale uses an invertible signed transform across zero", () => {
  const scale = createIndicatorScale({ mode: "signed-zero", min: -50, max: 50, displayMode: "log" }, { top: 0, bottom: 100 });
  for (const value of [-50, -10, 0, 10, 50]) {
    assert.ok(Number.isFinite(scale.y(value)));
    assert.ok(Math.abs(scale.valueAtY(scale.y(value)) - value) < 1e-8);
  }
});

test("indicator manual scale range is pane-local and auto scale restores the data range", () => {
  assert.deepEqual(indicatorDisplayRange({}, 0, 100), { min: 0, max: 100 });
  assert.deepEqual(indicatorDisplayRange({ paneScaleAuto: false, paneScaleFactor: 0.5 }, 0, 100), { min: 25, max: 75 });
  assert.deepEqual(indicatorDisplayRange({ paneScaleAuto: false, paneScaleFactor: 2 }, 0, 100), { min: -50, max: 150 });
});
