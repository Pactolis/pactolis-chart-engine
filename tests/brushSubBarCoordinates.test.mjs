import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { screenPoint } from "../dist/features/drawings/drawingPrimitives.js";
import { settings } from "../dist/core/settings.js";
import {
  isDrawingMagnetEnabled, isDrawingMagnetModifierPressed, snapPriceToOhlc, WEAK_MAGNET_THRESHOLD_PX,
} from "../dist/features/chart/ChartInputController.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";

// Source owner: ChartRuntimeImpl (private, deliberately not exported).
// Initial evidence pin: f817a9c9fe695c9b541cd5922cce86a3771d1d53.
// Read the compiled dist source so runtime execution does not depend on compiler AST APIs.
// No copied inverse mapper, rewritten method body, or dist prototype assumption.
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

const methods = {};
for (const name of ["_indexToTime", "_screenToDrawingPoint", "_magnetSnapPrice", "_resolveMagnetSnap"]) {
  const extracted = extractClassMethod(source, name);
  const program = "const extractedMethod = " + extracted + ";\nreturn extractedMethod;";
  methods[name] = new Function(
    "settings", "isDrawingMagnetEnabled", "snapPriceToOhlc", "WEAK_MAGNET_THRESHOLD_PX", "ChartChange",
    program
  )(settings, isDrawingMagnetEnabled, snapPriceToOhlc, WEAK_MAGNET_THRESHOLD_PX, ChartChange);
  assert.equal(typeof methods[name], "function", "compiled real Runtime method: " + name);
}

const T = 1_800_000_000_000;
const INTERVAL = 60_000;
const REGULAR = [T, T + INTERVAL, T + 2 * INTERVAL, T + 3 * INTERVAL];
function fixture({ times = REGULAR, spacing = 13.25, tool = "brush", offset = -3.125 } = {}) {
  const view = new View();
  view.area = { left: 37, top: 11, width: 159, height: 400 };
  view.colWidth = spacing;
  view.offsetX = offset;
  view.priceTop = 200;
  view.pricePerPx = 1;
  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.loadBars(times.map((startTime) => ({
    startTime, open: 100, high: 110, low: 90, close: 104,
    volume: 0, delta: 0, count: 0, cells: new Map(), hasRef: true,
  })));
  const manager = new DrawingManager(() => {});
  manager.setTool(tool);
  assert.equal(manager.activeTool, tool);
  const context = { drawings: manager };
  const market = "BINANCE:BTCUSDT";
  const host = {
    ...methods, view, pipeline: { series }, state: { market },
    svc: { getAnalysisContext(requestedMarket, shared) {
      assert.equal(requestedMarket, market);
      assert.equal(shared, true);
      return context;
    } },
    analysisContextForChart() {
      return this.svc.getAnalysisContext(this.state.market, true);
    },
  };
  return { host, view, series, manager };
}
function withMagnet(value, run) {
  const previous = settings.magnet;
  settings.magnet = value;
  try { return run(); } finally { settings.magnet = previous; }
}
// Independent expectations are declared fixture timestamps, never Runtime inverse calls.
// screenPoint is the actual forward drawing projection, including the half-column offset.
function prove(f, rawLogical, expectedTime) {
  const x = f.view.xOfIndex(rawLogical);
  const y = f.view.yOfPrice(102.25);
  const point = f.host._screenToDrawingPoint(x, y);
  assert.ok(Math.abs(point.time - expectedTime) <= 0.001,
    "timestamp mismatch: expected " + expectedTime + ", actual " + point.time);
  const projected = screenPoint(point, f.view, {
    indexForTime: (time) => f.series.indexOfTime(time),
  });
  assert.ok(Math.abs(projected.x - x) <= 1e-8,
    "raw CSS X mismatch: expected " + x + ", actual " + projected.x);
  assert.ok(Math.abs(projected.y - y) <= 1e-8, "raw CSS Y preserved");
  return point;
}

test("brush magnet OFF candle midpoint maps to that candle timestamp", () =>
  withMagnet(false, () => prove(fixture(), 1.5, T + INTERVAL)));

test("three X samples within one bar retain distinct sub-bar timestamps", () =>
  withMagnet(false, () => {
    const f = fixture();
    const points = [
      [1.51, T + 1.01 * INTERVAL],
      [1.65, T + 1.15 * INTERVAL],
      [1.85, T + 1.35 * INTERVAL],
    ].map(([x, time]) => prove(f, x, time));
    assert.equal(new Set(points.map((point) => point.time)).size, 3);
  }));

test("fractional CSS spacing preserves points across multiple bars", () =>
  withMagnet(false, () => {
    const f = fixture({ spacing: 13.25 });
    for (const [x, time] of [[0.75, T + 15_000], [1.9, T + 84_000], [2.625, T + 127_500]]) {
      prove(f, x, time);
    }
  }));

test("actual single-bar series extrapolates by declared interval", () =>
  withMagnet(false, () => {
    const f = fixture({ times: [T] });
    prove(f, -0.25, T - 45_000);
    prove(f, 1.75, T + 75_000);
  }));

test("both visible edge X coordinates survive without new clamping", () =>
  withMagnet(false, () => {
    // Edge raw logical values are -0.25 and 3.75; no inverse oracle.
    const f = fixture({ spacing: 13.25, offset: 3.3125 });
    f.view.area.width = 53;
    prove(f, -0.25, T - 45_000);
    prove(f, 3.75, T + 195_000);
  }));

test("real series gap uses fixture piecewise time, not fixed interval", () =>
  withMagnet(false, () => {
    const f = fixture({ times: [T, T + 60_000, T + 240_000, T + 300_000] });
    prove(f, 1.75, T + 105_000);
    prove(f, 2.25, T + 195_000);
  }));

test("non-brush and null active tool retain legacy candle time", () =>
  withMagnet(false, () => {
    for (const tool of ["trend", null]) {
      const f = fixture({ tool });
      for (const rawLogical of [1.51, 1.65, 1.85]) {
        const point = f.host._screenToDrawingPoint(f.view.xOfIndex(rawLogical), f.view.yOfPrice(102.25));
        assert.equal(point.time, T + 120_000);
        assert.equal(point.price, 102.25);
      }
    }
  }));

test("persistent and temporary Ctrl/Meta magnet preserve quantized time/OHLC", () => {
  const modes = [
    { persistent: true, temporary: false, price: 104.5 },
    ...[{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }].map((event) => ({
      persistent: false, temporary: isDrawingMagnetModifierPressed(event), price: 130,
    })),
  ];
  for (const mode of modes) withMagnet(mode.persistent, () => {
    const f = fixture();
    const cy = f.view.yOfPrice(mode.price);
    const point = f.host._screenToDrawingPoint(f.view.xOfIndex(1.65), cy, mode.temporary);
    assert.equal(point.time, T + 120_000);
    const expected = snapPriceToOhlc(mode.price, cy, [100, 110, 90, 104],
      (price) => f.view.yOfPrice(price), mode.temporary);
    assert.equal(point.price, expected);
    assert.equal(point.price, mode.temporary ? 110 : 104);
  });
});
// This proves exported modifier helper semantics, not browser DOM key dispatch or IDB.
