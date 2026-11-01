import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { settings } from "../dist/core/settings.js";
import { footprintAutoscaleSource, footprintVisiblePriceRange } from "../dist/core/model/footprintAutoscale.js";
import { incrementPerformanceCounter, measurePerformance } from "../dist/core/performanceTelemetry.js";

// Given/When/Then mapping is declared before any fixture mutation:
// AF01/02: positive 500/50000 bars, 250 visible -> one real fit -> exactly 250 at() reads.
// AF03/04: fractional/edge-clamped interval -> fit -> independent bounds, no offscreen extremes.
// AF05/06: raw OHLC and margins, linear/log mode -> fit -> raw snapshot != padded scale.
// AF07: manual autoscale -> _autoFit -> no series access or viewport work.
// AF08/09/10: empty/invalid/flat -> fit -> snapshot cleared, no scale application.
// AF11: same viewport, changed OHLC -> next fit -> fresh raw snapshot, not frame cache.
// AF12: finite narrow range, varying minMove -> fit -> no inappropriate flat padding.
// AF13: same actual fit loop, bounded warmup/samples -> count/timing evidence, no timing gate.
// Evidence pin: ed9bd09dc5f8b5c80d56694ea839c916dc8f6b60.
// Always execute checked-out private source from compiled dist, not a copied fit implementation or browser constructor.
const source = await readFile(new URL("../dist/features/chart/ChartRuntime.js", import.meta.url), "utf8");

function extractClassMethod(source, methodName) {
  const classMatch = source.match(/\bclass\s+ChartRuntimeImpl\b[\s\S]*?\{/);
  if (!classMatch) throw new Error("ChartRuntimeImpl class not found");
  const classStart = classMatch.index + classMatch[0].length;

  let classDepth = 1;
  let classEnd = -1;
  let inStr = null;
  let inComm = false;
  for (let i = classStart; i < source.length; i++) {
    const c = source[i];
    const prev = source[i - 1];
    if (!inComm) {
      if (inStr) {
        if (c === inStr && prev !== "\\") inStr = null;
        continue;
      } else if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
    }
    if (!inStr) {
      if (!inComm && c === "/" && source[i + 1] === "/") {
        const nextNl = source.indexOf("\n", i);
        i = nextNl === -1 ? source.length : nextNl;
        continue;
      }
      if (!inComm && c === "/" && source[i + 1] === "*") {
        inComm = true;
        i++;
        continue;
      }
      if (inComm && c === "*" && source[i + 1] === "/") {
        inComm = false;
        i++;
        continue;
      }
      if (inComm) continue;
    }
    if (c === "{") classDepth++;
    else if (c === "}") {
      classDepth--;
      if (classDepth === 0) {
        classEnd = i;
        break;
      }
    }
  }
  if (classEnd === -1) throw new Error("ChartRuntimeImpl class end not found");

  const classBody = source.slice(classStart, classEnd);
  const methodRegex = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?\\b${methodName}\\s*\\(`, "g");
  const match = methodRegex.exec(classBody);
  if (!match) throw new Error(`Method ${methodName} not found in ChartRuntimeImpl`);

  const methodStart = match.index;
  const isAsync = match[0].includes("async");

  const parenStart = classBody.indexOf("(", methodStart);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < classBody.length; i++) {
    if (classBody[i] === "(") {
      parenDepth++;
    } else if (classBody[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd === -1) throw new Error(`Unmatched parentheses in method signature: ${methodName}`);

  const braceStart = classBody.indexOf("{", parenEnd);
  if (braceStart === -1) throw new Error(`Opening brace not found for method: ${methodName}`);

  let depth = 0;
  let braceEnd = -1;
  inStr = null;
  inComm = false;

  for (let i = braceStart; i < classBody.length; i++) {
    const char = classBody[i];
    const prev = classBody[i - 1];

    if (!inComm) {
      if (inStr) {
        if (char === inStr && prev !== "\\") inStr = null;
        continue;
      } else if (char === '"' || char === "'" || char === "`") {
        inStr = char;
        continue;
      }
    }

    if (!inStr) {
      if (!inComm && char === "/" && classBody[i + 1] === "/") {
        const nextNl = classBody.indexOf("\n", i);
        i = nextNl === -1 ? classBody.length : nextNl;
        continue;
      }
      if (!inComm && char === "/" && classBody[i + 1] === "*") {
        inComm = true;
        i++;
        continue;
      }
      if (inComm && char === "*" && classBody[i + 1] === "/") {
        inComm = false;
        i++;
        continue;
      }
      if (inComm) continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i + 1;
        break;
      }
    }
  }

  if (braceEnd === -1) throw new Error(`Unmatched braces for method: ${methodName}`);

  const params = classBody.slice(parenStart + 1, parenEnd).trim();
  const body = classBody.slice(braceStart, braceEnd);
  return `${isAsync ? "async " : ""}function(${params}) ${body}`;
}

const bindings = { settings, footprintVisiblePriceRange, footprintAutoscaleSource,
  incrementPerformanceCounter, measurePerformance };
const methods = {};
for (const name of ["_fitToData", "_autoFit"]) {
  const extracted = extractClassMethod(source, name);
  const program = "const extractedMethod = " + extracted + ";\nreturn extractedMethod;";
  methods[name] = new Function(...Object.keys(bindings), program)(...Object.values(bindings));
  assert.equal(typeof methods[name], "function", "compiled real Runtime method: " + name);
}
const T = 1_800_000_000_000;
function bar(index, low, high) {
  return { startTime: T + index * 60_000, open: low, high, low, close: high,
    volume: 0, delta: 0, count: 0, cells: new Map(), hasRef: true };
}
function fixture({ bars = [bar(0, 100, 400)], range = [0, 1], step = 1, mode = "linear" } = {}) {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: step });
  series.loadBars(bars);
  const view = new View();
  view.area = { left: 0, top: 0, width: 1000, height: 400 };
  view.setScaleMode(mode);
  const realAt = series.at.bind(series);
  const stats = { reads: 0, indices: [], capture: true, visibleCalls: 0, scaleCalls: 0 };
  series.at = (index) => {
    stats.reads++;
    if (stats.capture) stats.indices.push(index);
    return realAt(index);
  };
  const realSetScaleRange = view.setScaleRange.bind(view);
  view.setScaleRange = (next) => { stats.scaleCalls++; realSetScaleRange(next); };
  const host = {
    ...methods, view, pipeline: { series },
    renderer: { autoscaleRange(actualView, length) {
      assert.equal(actualView, view);
      assert.equal(length, series.length);
      stats.visibleCalls++;
      return range;
    } },
    lastAutoFitSnapshot: { from: -1, to: -1, min: -1, max: -1 },
  };
  const reset = () => { stats.reads = 0; stats.indices = []; stats.visibleCalls = 0; stats.scaleCalls = 0; };
  return { host, view, series, stats, reset };
}
function margins(top, bottom, run) {
  const previous = [settings.scaleMarginTop, settings.scaleMarginBottom];
  settings.scaleMarginTop = top;
  settings.scaleMarginBottom = bottom;
  try { return run(); } finally {
    [settings.scaleMarginTop, settings.scaleMarginBottom] = previous;
  }
}
function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-10, "expected " + expected + ", actual " + actual);
}
function snapshot(f, from, to, min, max) {
  assert.deepEqual(f.host.lastAutoFitSnapshot, { from, to, min, max });
}
function scale(f, min, max) {
  const applied = f.view.priceScale.priceRange();
  assert.ok(applied, "real PriceScaleModel received range");
  close(applied.minValue(), min);
  close(applied.maxValue(), max);
  close(f.view.priceTop, max);
  close(f.view.pricePerPx, (max - min) / 400);
}
function noScale(f) {
  assert.equal(f.host.lastAutoFitSnapshot, null);
  assert.equal(f.stats.scaleCalls, 0);
  assert.equal(f.view.priceScale.priceRange(), null);
}
function boundedFixture(total) {
  const start = total === 500 ? 125 : 24875;
  const bars = Array.from({ length: total }, (_, i) =>
    i >= start && i < start + 250 ? bar(i, 100, 400) : bar(i, 1, 1_000_000));
  return fixture({ bars, range: [start + 0.25, start + 249.75] });
}

for (const [id, total] of [["AF01", 500], ["AF02", 50000]]) {
  test(id + ": one fit reads each of 250 visible OHLC bars once in " + total + "-bar series", () =>
    margins(0.2, 0.1, () => {
      const f = boundedFixture(total);
      const start = total === 500 ? 125 : 24875;
      f.host._fitToData();
      snapshot(f, start + 0.25, start + 249.75, 100, 400);
      scale(f, 100 - 300 / 0.7 * 0.1, 400 + 300 / 0.7 * 0.2);
      assert.equal(f.stats.visibleCalls, 1);
      assert.equal(f.stats.scaleCalls, 1);
      console.log("AUTOFIT_VISITS " + JSON.stringify({
        scenario: id, totalBars: total, visibleBars: 250, invocationCount: 1,
        readCount: f.stats.reads, uniqueVisibleCount: new Set(f.stats.indices).size,
        expectedReadCount: 250,
      }));
      assert.equal(f.stats.reads, 250, "one _fitToData invocation must scan 250 visible bars once, not twice");
      assert.deepEqual(f.stats.indices, Array.from({ length: 250 }, (_, i) => start + i));
    }));
}

test("AF03: fractional interval includes floor/ceil endpoints but excludes offscreen extremes", () =>
  margins(0, 0, () => {
    const f = fixture({ range: [1.25, 3.1], bars: [
      bar(0, 1, 1_000_000), bar(1, 100, 200), bar(2, 150, 300),
      bar(3, 200, 400), bar(4, 2, 900_000),
    ] });
    f.host._fitToData();
    snapshot(f, 1.25, 3.1, 100, 400);
    scale(f, 100, 400);
    assert.deepEqual([...new Set(f.stats.indices)].sort((a, b) => a - b), [1, 2, 3]);
    assert.ok(f.stats.indices.every((i) => i >= 1 && i <= 3));
  }));

test("AF04: visible interval clamps at both series edges, retaining original snapshot interval", () =>
  margins(0, 0, () => {
    for (const [range, indices, min, max] of [
      [[-9.5, 1.1], [0, 1], 100, 300],
      [[1.1, 9.5], [1, 2], 200, 400],
    ]) {
      const f = fixture({ range, bars: [bar(0, 100, 200), bar(1, 200, 300), bar(2, 300, 400)] });
      f.host._fitToData();
      snapshot(f, ...range, min, max);
      scale(f, min, max);
      assert.deepEqual([...new Set(f.stats.indices)].sort((a, b) => a - b), indices);
      assert.ok(f.stats.indices.every((i) => indices.includes(i)));
    }
  }));

test("AF05: linear padded range follows changed settings while snapshot stays raw", () => {
  const f = fixture();
  margins(0.2, 0.1, () => {
    f.host._fitToData();
    snapshot(f, 0, 1, 100, 400);
    scale(f, 100 - 300 / 0.7 * 0.1, 400 + 300 / 0.7 * 0.2);
  });
  margins(0.1, 0.2, () => {
    f.host._fitToData();
    snapshot(f, 0, 1, 100, 400);
    scale(f, 100 - 300 / 0.7 * 0.2, 400 + 300 / 0.7 * 0.1);
    assert.deepEqual(f.view.priceScale.scaleMargins(), { top: 0.1, bottom: 0.2 });
  });
});

test("AF06: logarithmic padded scale uses declared conversion, never log/padded snapshot", () =>
  margins(0.2, 0.1, () => {
    const f = fixture({ mode: "log" });
    f.host._fitToData();
    snapshot(f, 0, 1, 100, 400);
    // Independent formula for this positive range (span >= 1): offset=4, coordOffset=0.0001.
    // No production range or conversion helper is used as the expectation oracle.
    const low = Math.log10(100.0001) + 4;
    const high = Math.log10(400.0001) + 4;
    const span = (high - low) / 0.7;
    scale(f, low - span * 0.1, high + span * 0.2);
    assert.equal(f.view.isLogScale(), true);
  }));

test("AF07: manual _autoFit returns before any series access or renderer/scale work", () => {
  const f = fixture();
  f.view.setPriceAutoScale(false);
  let pipelineAccesses = 0;
  Object.defineProperty(f.host, "pipeline", { get() {
    pipelineAccesses++;
    throw new Error("manual autoscale must not access series");
  } });
  const before = { ...f.host.lastAutoFitSnapshot };
  f.host._autoFit();
  assert.equal(pipelineAccesses, 0);
  assert.equal(f.stats.reads, 0);
  assert.equal(f.stats.visibleCalls, 0);
  assert.equal(f.stats.scaleCalls, 0);
  assert.deepEqual(f.host.lastAutoFitSnapshot, before);
});

test("AF08: empty series and empty bounded interval clear snapshot without applying scale", () => {
  for (const options of [{ bars: [] }, { range: [1, 1] }, { range: [5, 8] }]) {
    const f = fixture(options);
    f.host._fitToData();
    noScale(f);
    assert.equal(f.stats.reads, 0);
  }
});

test("AF09: invalid finite endpoints are ignored; missing finite min or max clears snapshot", () =>
  margins(0, 0, () => {
    for (const field of ["low", "high", "both"]) {
      const f = fixture();
      const stored = f.series.at(0);
      // Corrupt a real stored bar after valid load to exercise defensive finite checks.
      if (field !== "high") stored.low = NaN;
      if (field !== "low") stored.high = Infinity;
      f.reset();
      f.host._fitToData();
      noScale(f);
    }
    const f = fixture({ bars: [bar(0, 100, 200), bar(1, 150, 400)], range: [0, 2] });
    f.series.at(0).low = NaN;
    f.series.at(0).high = Infinity;
    f.reset();
    f.host._fitToData();
    snapshot(f, 0, 2, 150, 400);
    scale(f, 150, 400);
  }));

test("AF10: currently empty flat PriceRange is skipped before minMove padding", () => {
  // PriceRange.isEmpty() regards equal endpoints as empty; autoscaleRange skips it
  // before expandDegenerateRange. Do not introduce a new padding semantic here.
  for (const step of [0.01, 1, 10]) {
    const f = fixture({ bars: [bar(0, 100, 100)], step });
    f.host._fitToData();
    noScale(f);
  }
});

test("AF11: repeated _autoFit invocation observes changed raw OHLC on unchanged viewport", () =>
  margins(0, 0, () => {
    const f = fixture();
    f.host._autoFit();
    snapshot(f, 0, 1, 100, 400);
    const stored = f.series.at(0);
    stored.low = 80;
    stored.high = 500;
    f.reset();
    f.host._autoFit();
    snapshot(f, 0, 1, 80, 500);
    scale(f, 80, 500);
    assert.ok(f.stats.reads > 0, "next invocation must observe current bars");
    assert.equal(f.stats.scaleCalls, 1);
  }));

test("AF12: nonflat narrow range is preserved independently of declared minMove", () =>
  margins(0, 0, () => {
    for (const step of [0.01, 1, 10]) {
      const f = fixture({ bars: [bar(0, 100, 100.25)], step });
      f.host._fitToData();
      snapshot(f, 0, 1, 100, 100.25);
      scale(f, 100, 100.25);
    }
  }));

test("AF13: bounded actual-fit measurements report work and p50/p95 without timing gates", () =>
  margins(0.2, 0.1, () => {
    for (const total of [500, 50000]) {
      const f = boundedFixture(total);
      f.stats.capture = false;
      const warmup = 20;
      const samples = 40;
      const batch = 10;
      for (let i = 0; i < warmup; i++) f.host._fitToData();
      f.reset();
      const elapsed = [];
      for (let sample = 0; sample < samples; sample++) {
        const started = performance.now();
        for (let i = 0; i < batch; i++) f.host._fitToData();
        elapsed.push((performance.now() - started) / batch);
      }
      elapsed.sort((a, b) => a - b);
      console.log("AUTOFIT_MEASUREMENT " + JSON.stringify({
        subject: "checked-out actual _fitToData", totalBars: total, visibleBars: 250,
        warmupInvocations: warmup, samples, invocationsPerSample: batch,
        invocationCount: samples * batch, readCount: f.stats.reads,
        readsPerInvocation: f.stats.reads / (samples * batch),
        elapsedMsP50: elapsed[19], elapsedMsP95: elapsed[37],
        timingGate: false, optimizedComparison: "not implemented in test-only RED slice",
      }));
      assert.equal(f.stats.visibleCalls, samples * batch);
      assert.equal(f.stats.scaleCalls, samples * batch);
    }
  }));
