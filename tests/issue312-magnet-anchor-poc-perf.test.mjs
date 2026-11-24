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

test("Issue #312: weak magnet binary search + POC WeakMap cache cuts indexOfTime & cell reads over 60 snaps, and invalidates on live cell updates", () => {
  const INTERVAL = 60_000;
  const T = 1_800_000_000_000;

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 52200;
  view.pricePerPx = 1;

  let cellVolReads = 0;
  const cells = new Map();
  for (let p = 50000; p < 52000; p++) {
    const isInitialPoc = p === 50500;
    const rawBuy = isInitialPoc ? 500 : 10;
    const rawSell = isInitialPoc ? 500 : 10;
    const cell = {
      priceBin: p,
      count: 10,
      buyCount: 5,
      sellCount: 5,
      _buyVol: rawBuy,
      _sellVol: rawSell,
      get buyVol() {
        cellVolReads++;
        return this._buyVol;
      },
      set buyVol(v) {
        this._buyVol = v;
      },
      get sellVol() {
        return this._sellVol;
      },
      set sellVol(v) {
        this._sellVol = v;
      },
    };
    cells.set(p, cell);
  }

  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.loadBars([
    {
      startTime: T,
      open: 50100,
      high: 52000,
      low: 50000,
      close: 51000,
      volume: 42000,
      delta: 0,
      count: 2000,
      cells,
      cellRevision: 1,
      hasRef: true,
    },
  ]);

  let indexOfTimeCalls = 0;
  const origIndexOfTime = series.indexOfTime.bind(series);
  series.indexOfTime = (t) => {
    indexOfTimeCalls++;
    return origIndexOfTime(t);
  };

  const manager = new DrawingManager(() => {});
  manager.setMarket("BTC");
  const drawings = [];
  for (let i = 0; i < 500; i++) {
    drawings.push({
      id: `d-${i}`,
      type: "trendline",
      points: [
        { time: T + (i + 10) * INTERVAL, price: 50200 + (i % 400) },
        { time: T + (i + 11) * INTERVAL, price: 50250 + (i % 400) },
      ],
      market: "BTC",
      visible: true,
    });
  }
  manager.replace(drawings);

  const host = {
    ...methods,
    view,
    pipeline: { series },
    state: { market: "BTC" },
    session: { invalidate: () => {} },
    setHookAttr: () => {},
    overlay: { getActiveVolumeProfileLevels: () => null },
    analysisContextForChart: () => ({ drawings: manager }),
  };

  const prevMagnet = settings.magnet;
  const prevMode = settings.magnetMode;
  settings.magnet = true;
  settings.magnetMode = "weak";

  try {
    const barX = view.xOfIndex(0);
    const pocY = view.yOfPrice(50500.5);
    indexOfTimeCalls = 0;
    cellVolReads = 0;

    for (let i = 0; i < 60; i++) {
      const snapped = host._screenToDrawingPoint(barX, pocY + 1);
      assert.equal(snapped.price, 50500.5);
    }

    // Weak magnet must NOT call indexOfTime for 500*2*60 = 60,000 times
    assert.ok(indexOfTimeCalls <= 60, `Expected <= 60 indexOfTime calls, got ${indexOfTimeCalls}`);
    // POC WeakMap cache must read 2,000 cells only once across 60 snaps
    assert.equal(cellVolReads, 2000, `Expected 2000 cell reads (1x cache fill), got ${cellVolReads}`);

    // Live cell mutation bumps cellRevision -> POC cache invalidates and updates
    const liveBar = series.at(0);
    const newPocCell = cells.get(50800);
    newPocCell.buyVol = 5000;
    newPocCell.sellVol = 5000;
    liveBar.cellRevision = (liveBar.cellRevision ?? 0) + 1;

    const updatedSnap = host._screenToDrawingPoint(barX, view.yOfPrice(50800.5) + 1);
    assert.equal(updatedSnap.price, 50800.5, "POC must update after live cellRevision change");
    assert.equal(cellVolReads, 4000, "Cache should recompute once after cellRevision bump");
  } finally {
    settings.magnet = prevMagnet;
    settings.magnetMode = prevMode;
  }
});

test("Issue #312: tie-break priority order and strong-mode global search are preserved", () => {
  const INTERVAL = 60_000;
  const T = 1_800_000_000_000;

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 50300;
  view.pricePerPx = 1;

  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.loadBars([
    {
      startTime: T,
      open: 50100,
      high: 50150,
      low: 50050,
      close: 50100,
      volume: 100,
      delta: 0,
      count: 10,
      hasRef: true,
    },
  ]);

  const manager = new DrawingManager(() => {});
  manager.setMarket("BTC");
  manager.replace([
    {
      id: "far-anchor",
      type: "horizontal",
      points: [{ time: T + 100 * INTERVAL, price: 50250 }],
      market: "BTC",
      visible: true,
    },
    {
      id: "tie-anchor",
      type: "horizontal",
      points: [{ time: T, price: 50100 }],
      market: "BTC",
      visible: true,
    },
  ]);

  let lastSnapLabel = "";
  const host = {
    ...methods,
    view,
    pipeline: { series },
    state: { market: "BTC" },
    session: { invalidate: () => {} },
    setHookAttr: (_k, v) => {
      lastSnapLabel = v;
    },
    overlay: {
      getActiveVolumeProfileLevels: () => ({ poc: 50100, vah: 50150, val: 50050 }),
    },
    analysisContextForChart: () => ({ drawings: manager }),
  };

  const prevMagnet = settings.magnet;
  const prevMode = settings.magnetMode;
  settings.magnet = true;
  settings.magnetMode = "weak";

  try {
    // At exact (T, 50100), ANCHOR, O, C, PPOC are all distance 0; ANCHOR must win
    const barX = view.xOfIndex(0);
    host._screenToDrawingPoint(barX, view.yOfPrice(50100));
    assert.equal(lastSnapLabel, "ANCHOR");

    // Strong mode finds far-anchor even when pointer is far beyond 14px
    settings.magnetMode = "strong";
    const farX = view.xOfIndex(100);
    const farSnap = host._screenToDrawingPoint(farX + 40, view.yOfPrice(50250) - 40);
    assert.equal(farSnap.price, 50250);
    assert.equal(farSnap.time, T + 100 * INTERVAL);
  } finally {
    settings.magnet = prevMagnet;
    settings.magnetMode = prevMode;
  }
});
