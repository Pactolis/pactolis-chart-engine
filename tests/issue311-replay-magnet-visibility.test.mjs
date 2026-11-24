import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { settings } from "../dist/core/settings.js";
import {
  isDrawingMagnetEnabled,
  snapPriceToOhlc,
  WEAK_MAGNET_THRESHOLD_PX,
} from "../dist/features/chart/ChartInputController.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";

const source = await readFile(new URL("../dist/features/chart/ChartRuntime.js", import.meta.url), "utf8");

function extractClassMethod(src, methodName) {
  const classMatch = src.match(/\bclass\s+ChartRuntimeImpl\b[\s\S]*?\{/);
  if (!classMatch) throw new Error("ChartRuntimeImpl class not found");
  const classStart = classMatch.index + classMatch[0].length;

  let classDepth = 1;
  let classEnd = -1;
  let inStr = null;
  let inComm = false;
  for (let i = classStart; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
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
      if (!inComm && c === "/" && src[i + 1] === "/") {
        const nextNl = src.indexOf("\n", i);
        i = nextNl === -1 ? src.length : nextNl;
        continue;
      }
      if (!inComm && c === "/" && src[i + 1] === "*") {
        inComm = true;
        i++;
        continue;
      }
      if (inComm && c === "*" && src[i + 1] === "/") {
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
  const classBody = src.slice(classStart, classEnd);
  const methodRegex = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?\\b${methodName}\\s*\\(`, "g");
  const match = methodRegex.exec(classBody);
  if (!match) throw new Error(`Method ${methodName} not found in ChartRuntimeImpl`);

  const parenStart = classBody.indexOf("(", match.index);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < classBody.length; i++) {
    if (classBody[i] === "(") parenDepth++;
    else if (classBody[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  const braceStart = classBody.indexOf("{", parenEnd);
  let depth = 0;
  let braceEnd = -1;
  inStr = null;
  inComm = false;
  for (let i = braceStart; i < classBody.length; i++) {
    const ch = classBody[i];
    const prev = classBody[i - 1];
    if (!inComm) {
      if (inStr) {
        if (ch === inStr && prev !== "\\") inStr = null;
        continue;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
    }
    if (!inStr) {
      if (!inComm && ch === "/" && classBody[i + 1] === "/") {
        const nextNl = classBody.indexOf("\n", i);
        i = nextNl === -1 ? classBody.length : nextNl;
        continue;
      }
      if (!inComm && ch === "/" && classBody[i + 1] === "*") {
        inComm = true;
        i++;
        continue;
      }
      if (inComm && ch === "*" && classBody[i + 1] === "/") {
        inComm = false;
        i++;
        continue;
      }
      if (inComm) continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i + 1;
        break;
      }
    }
  }
  const params = classBody.slice(parenStart + 1, parenEnd).trim();
  const body = classBody.slice(braceStart, braceEnd);
  return `function(${params}) ${body}`;
}

const methods = {};
for (const name of ["_indexToTime", "_screenToDrawingPoint", "_magnetSnapPrice", "_resolveMagnetSnap"]) {
  const extracted = extractClassMethod(source, name);
  const program = `const extractedMethod = ${extracted};\nreturn extractedMethod;`;
  methods[name] = new Function(
    "settings", "isDrawingMagnetEnabled", "snapPriceToOhlc", "ChartChange", "WEAK_MAGNET_THRESHOLD_PX",
    program,
  )(settings, isDrawingMagnetEnabled, snapPriceToOhlc, ChartChange, WEAK_MAGNET_THRESHOLD_PX);
}

test("Issue #311: magnet snap respects drawingIsAvailableAsOf, panel market, replay seek, and active drag exclusion", () => {
  const INTERVAL = 60_000;
  const T0 = 1_800_000_000_000;
  const T1 = T0 + INTERVAL;
  const T2 = T0 + 2 * INTERVAL;
  const T3 = T0 + 3 * INTERVAL;

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 40;
  view.offsetX = 0;
  view.priceTop = 50200;
  view.pricePerPx = 1;

  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.loadBars([
    { startTime: T0, open: 50000, high: 50010, low: 49990, close: 50005, volume: 10, delta: 1, count: 2, hasRef: true },
    { startTime: T1, open: 50005, high: 50015, low: 49995, close: 50010, volume: 10, delta: 1, count: 2, hasRef: true },
    { startTime: T2, open: 50010, high: 50020, low: 49990, close: 50015, volume: 10, delta: 1, count: 2, hasRef: true },
    { startTime: T3, open: 50015, high: 50025, low: 49995, close: 50020, volume: 10, delta: 1, count: 2, hasRef: true },
  ]);

  const manager = new DrawingManager(() => {});
  manager.setMarket("BTC");
  manager.replace([
    // Fully available by T1
    {
      id: "past-only",
      type: "trendline",
      points: [
        { time: T0, price: 50080 },
        { time: T1, price: 50090 },
      ],
      market: "BTC",
      visible: true,
    },
    // Starts at T0, ends in future T2: unavailable when asOfTime === T1
    {
      id: "spans-future",
      type: "trendline",
      points: [
        { time: T0, price: 50120 },
        { time: T2, price: 50130 },
      ],
      market: "BTC",
      visible: true,
    },
    // Different market drawing at exact same coords
    {
      id: "other-market",
      type: "trendline",
      points: [
        { time: T0, price: 50150 },
        { time: T1, price: 50160 },
      ],
      market: "ETH",
      visible: true,
    },
  ]);

  let replayActive = false;
  let virtualTime = T1;
  let dragActive = false;
  let selectedIds = [];

  const drawingsProxy = {
    activeTool: null,
    listCurrentReadonly: () => manager.list(),
    getRevision: () => manager.getRevision(),
    isPointerDragActive: () => dragActive,
    getSelectedIds: () => selectedIds,
  };

  const host = {
    ...methods,
    view,
    pipeline: { series },
    state: { market: "BTC" },
    replayCoordinator: {
      isActive: () => replayActive,
      getSnapshot: () => (replayActive ? { virtualTime } : null),
    },
    session: { invalidate: () => {} },
    setHookAttr: () => {},
    overlay: { getActiveVolumeProfileLevels: () => null },
    analysisContextForChart: () => ({ drawings: drawingsProxy }),
  };

  const prevMagnet = settings.magnet;
  const prevMode = settings.magnetMode;
  settings.magnet = true;
  settings.magnetMode = "weak";

  try {
    const xT0 = view.xOfIndex(series.indexOfTime(T0));

    // 1. Live chart: both BTC drawings available, ETH drawing ignored
    replayActive = false;
    assert.equal(host._screenToDrawingPoint(xT0, view.yOfPrice(50080) + 1).price, 50080);
    assert.equal(host._screenToDrawingPoint(xT0, view.yOfPrice(50120) + 1).price, 50120);
    assert.notEqual(host._screenToDrawingPoint(xT0, view.yOfPrice(50150) + 1).price, 50150);

    // 2. Replay at T1: past-only available, spans-future (p0 at T0, p1 at T2) must NOT snap
    replayActive = true;
    virtualTime = T1;
    assert.equal(host._screenToDrawingPoint(xT0, view.yOfPrice(50080) + 1).price, 50080);
    assert.notEqual(host._screenToDrawingPoint(xT0, view.yOfPrice(50120) + 1).price, 50120);

    // 3. Replay forward seek to T2: spans-future becomes available and snaps
    virtualTime = T2;
    assert.equal(host._screenToDrawingPoint(xT0, view.yOfPrice(50120) + 1).price, 50120);

    // 4. Replay backward seek to T1: spans-future is hidden again and must NOT snap
    virtualTime = T1;
    assert.notEqual(host._screenToDrawingPoint(xT0, view.yOfPrice(50120) + 1).price, 50120);

    // 5. Active pointer drag excludes selected drawing's own anchors
    dragActive = true;
    selectedIds = ["past-only"];
    assert.notEqual(host._screenToDrawingPoint(xT0, view.yOfPrice(50080) + 1).price, 50080);
  } finally {
    settings.magnet = prevMagnet;
    settings.magnetMode = prevMode;
  }
});
