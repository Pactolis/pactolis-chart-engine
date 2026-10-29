import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHART_WEBGL_OPTIONS,
  effectivePixelRatio,
  resolveChartDisplayOptions,
  sameChartDisplayOptions,
} from "../dist/core/model/chartDisplayOptions.js";
import {
  COMPACT_CHART_LAYOUT_OPTIONS,
  DEFAULT_CHART_LAYOUT_OPTIONS,
} from "../dist/core/model/chartLayoutOptions.js";
import { DEFAULT_TIME_SCALE_OPTIONS } from "../dist/core/model/timeScaleOptions.js";

test("a host that answers nothing gets the desktop defaults", () => {
  for (const input of [undefined, null, {}]) {
    const resolved = resolveChartDisplayOptions(input);
    assert.deepEqual({ ...resolved.layout }, { ...DEFAULT_CHART_LAYOUT_OPTIONS });
    assert.deepEqual({ ...resolved.timeScale }, {}, "no time-scale field is set, so the engine's own stay");
    assert.equal(resolved.maxDevicePixelRatio, null, "follows the window's devicePixelRatio");
    assert.deepEqual({ ...resolved.webgl }, { antialias: true, powerPreference: "default" });
    assert.deepEqual({ ...resolved.webgl }, { ...DEFAULT_CHART_WEBGL_OPTIONS });
  }
  assert.equal(DEFAULT_CHART_LAYOUT_OPTIONS.density, "regular");
  assert.equal(DEFAULT_TIME_SCALE_OPTIONS.defaultFitColumns, 250);
});

test("resolved options are frozen so one chart cannot change what another reads", () => {
  const resolved = resolveChartDisplayOptions({ density: "compact", defaultFitColumns: 70 });
  assert.throws(() => { resolved.maxDevicePixelRatio = 2; }, TypeError);
  assert.throws(() => { resolved.layout.timeAxisHeight = 99; }, TypeError);
  assert.throws(() => { resolved.timeScale.defaultFitColumns = 5; }, TypeError);
  assert.throws(() => { resolved.webgl.antialias = false; }, TypeError);
  assert.throws(() => { DEFAULT_CHART_WEBGL_OPTIONS.antialias = false; }, TypeError);
});

test("compact density starts from the compact axis sizes and each size stays overridable", () => {
  const compact = resolveChartDisplayOptions({ density: "compact" });
  assert.deepEqual({ ...compact.layout }, { ...COMPACT_CHART_LAYOUT_OPTIONS });
  assert.equal(compact.layout.density, "compact");
  assert.equal(compact.layout.priceAxisWidth, 62, "the price gutter keeps its width");
  assert.ok(compact.layout.timeAxisHeight > DEFAULT_CHART_LAYOUT_OPTIONS.timeAxisHeight, "a taller strip to drag");

  const wider = resolveChartDisplayOptions({ density: "compact", priceAxisWidth: 70, timeAxisHeight: 40 });
  assert.deepEqual({ ...wider.layout }, { priceAxisWidth: 70, timeAxisHeight: 40, density: "compact" });

  const tallerRegular = resolveChartDisplayOptions({ timeAxisHeight: 28 });
  assert.deepEqual({ ...tallerRegular.layout }, { priceAxisWidth: 62, timeAxisHeight: 28, density: "regular" });

  assert.equal(resolveChartDisplayOptions({ density: "huge" }).layout.density, "regular", "an unknown density is regular");
});

test("invalid fields fall back one by one and leave the valid ones alone", () => {
  const resolved = resolveChartDisplayOptions({
    priceAxisWidth: -4,
    timeAxisHeight: 30,
    defaultFitColumns: 0,
    maxDevicePixelRatio: 0.5,
    antialias: "no",
    powerPreference: "fast",
  });
  assert.equal(resolved.layout.priceAxisWidth, 62);
  assert.equal(resolved.layout.timeAxisHeight, 30);
  assert.deepEqual({ ...resolved.timeScale }, {});
  assert.equal(resolved.maxDevicePixelRatio, null);
  assert.deepEqual({ ...resolved.webgl }, { antialias: true, powerPreference: "default" });
});

test("default fit columns are floored, kept at one or more and held to a sane ceiling", () => {
  const fit = (value) => resolveChartDisplayOptions({ defaultFitColumns: value }).timeScale.defaultFitColumns;
  assert.equal(fit(80), 80);
  assert.equal(fit(80.9), 80);
  assert.equal(fit(1), 1);
  assert.equal(fit(100_000), 4000);
  for (const bad of [0, 0.5, -3, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
    assert.equal(fit(bad), undefined, `${String(bad)} is not a column count`);
  }
});

test("the pixel-ratio cap keeps finite values of at least one", () => {
  const cap = (value) => resolveChartDisplayOptions({ maxDevicePixelRatio: value }).maxDevicePixelRatio;
  assert.equal(cap(2), 2);
  assert.equal(cap(1), 1);
  assert.equal(cap(1.5), 1.5);
  for (const bad of [0.99, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
    assert.equal(cap(bad), null, `${String(bad)} means no cap`);
  }
});

test("antialias and power preference accept their documented values only", () => {
  const webgl = (extra) => ({ ...resolveChartDisplayOptions(extra).webgl });
  assert.deepEqual(webgl({ antialias: false }), { antialias: false, powerPreference: "default" });
  for (const powerPreference of ["default", "low-power", "high-performance"]) {
    assert.equal(webgl({ powerPreference }).powerPreference, powerPreference);
  }
  assert.equal(webgl({ powerPreference: "HIGH-PERFORMANCE" }).powerPreference, "default");
  assert.equal(webgl({ antialias: 0 }).antialias, true, "only a boolean switches antialiasing");
});

test("the effective pixel ratio is the window's, held down to the cap", () => {
  assert.equal(effectivePixelRatio(3, null), 3);
  assert.equal(effectivePixelRatio(3, 2), 2);
  assert.equal(effectivePixelRatio(2, 2), 2);
  assert.equal(effectivePixelRatio(1.5, 2), 1.5, "a cap never raises the ratio");
  assert.equal(effectivePixelRatio(1, 1), 1);
  assert.equal(effectivePixelRatio(Number.NaN, null), 1);
  assert.equal(effectivePixelRatio(0, 2), 1);
  assert.equal(effectivePixelRatio(-1, null), 1);
});

test("two resolved sets are the same only when every field matches", () => {
  const base = { density: "compact", priceAxisWidth: 64, timeAxisHeight: 30, defaultFitColumns: 80, maxDevicePixelRatio: 2, antialias: false, powerPreference: "low-power" };
  const a = resolveChartDisplayOptions(base);
  assert.equal(sameChartDisplayOptions(a, resolveChartDisplayOptions({ ...base })), true);
  assert.equal(sameChartDisplayOptions(resolveChartDisplayOptions(undefined), resolveChartDisplayOptions({})), true);
  for (const change of [
    { density: "regular" },
    { priceAxisWidth: 66 },
    { timeAxisHeight: 31 },
    { defaultFitColumns: 81 },
    { defaultFitColumns: undefined },
    { maxDevicePixelRatio: 3 },
    { maxDevicePixelRatio: undefined },
    { antialias: true },
    { powerPreference: "high-performance" },
  ]) {
    assert.equal(
      sameChartDisplayOptions(a, resolveChartDisplayOptions({ ...base, ...change })),
      false,
      `${JSON.stringify(change)} renders a different chart`,
    );
  }
});
