import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { settings } from "../dist/core/settings.js";
import {
  isDrawingMagnetEnabled,
  snapPriceToOhlc,
} from "../dist/features/chart/ChartInputController.js";

// Extract real private Runtime methods to test magnet snap behavior directly
const source = await readFile(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("ChartRuntime.ts", source, ts.ScriptTarget.Latest, true);
const owner = ast.statements.find((node) =>
  ts.isClassDeclaration(node) && node.name?.text === "ChartRuntimeImpl");
assert.ok(owner, "real private Runtime source owner");
const methods = {};
for (const name of ["_indexToTime", "_screenToDrawingPoint", "_magnetSnapPrice", "_resolveMagnetSnap"]) {
  const method = owner.members.find((node) =>
    ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(method?.body, "real Runtime method: " + name);
  const parameters = method.parameters.map((parameter) => parameter.getText(ast)).join(", ");
  const program = "const extractedMethod = function(" + parameters + ") " + method.body.getText(ast) + ";";
  const compiled = ts.transpileModule(program, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  methods[name] = new Function("settings", "isDrawingMagnetEnabled", "snapPriceToOhlc",
    compiled + "\nreturn extractedMethod;")(settings, isDrawingMagnetEnabled, snapPriceToOhlc);
  assert.equal(typeof methods[name], "function", "compiled real Runtime method: " + name);
}

test("DrawingManager listCurrentReadonly avoids structuredClone and caches by revision", () => {
  const manager = new DrawingManager(() => {});
  manager.setMarket("BTC");

  const drawings = [];
  for (let i = 0; i < 1000; i++) {
    drawings.push({
      id: `d-${i}`,
      type: "horizontal",
      points: [{ time: 1000 + i * 60, price: 50000 + (i % 100) }],
      market: "BTC",
      visible: true,
    });
  }
  manager.replace(drawings);

  const originalClone = globalThis.structuredClone;
  let cloneCount = 0;
  globalThis.structuredClone = function (val) {
    cloneCount++;
    return originalClone(val);
  };

  try {
    // 1. listCurrentReadonly should not call structuredClone
    cloneCount = 0;
    const readonlyList1 = manager.listCurrentReadonly();
    assert.equal(cloneCount, 0, "listCurrentReadonly must not call structuredClone");
    assert.equal(readonlyList1.length, 1000);

    // 2. Consecutive call returns cached reference
    const readonlyList2 = manager.listCurrentReadonly();
    assert.equal(cloneCount, 0);
    assert.equal(readonlyList1, readonlyList2, "cached readonly list must be referentially identical");

    // 3. public listCurrent() must still return deep copy
    cloneCount = 0;
    const clonedList = manager.listCurrent();
    assert.ok(cloneCount > 0, "public listCurrent must return a structuredClone");
    assert.notEqual(clonedList, readonlyList1);
    assert.equal(clonedList.length, 1000);

    // Modifying cloned list does not mutate readonlyList or manager
    clonedList[0].points[0].price = 999999;
    assert.equal(manager.listCurrentReadonly()[0].points[0].price, 50000);
  } finally {
    globalThis.structuredClone = originalClone;
  }
});

test("Magnet snap on 1,000 drawings uses listCurrentReadonly with 0 structuredClone calls and preserves snap priority", () => {
  const INTERVAL = 60_000;
  const T = 1_800_000_000_000;
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 50200;
  view.pricePerPx = 1;

  const series = new FootprintSeries({ intervalMs: INTERVAL, priceStep: 1 });
  series.loadBars([
    {
      startTime: T,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50050,
      volume: 100,
      delta: 10,
      count: 20,
      cells: new Map([
        [50020, { priceBin: 50020, buyVol: 50, sellVol: 50, count: 10, buyCount: 5, sellCount: 5 }],
      ]),
      hasRef: true,
    },
  ]);

  const manager = new DrawingManager(() => {});
  manager.setMarket("BTC");

  // Create 1,000 drawings, one with an anchor at (T, 50080)
  const drawings = [];
  for (let i = 0; i < 1000; i++) {
    drawings.push({
      id: `d-${i}`,
      type: "ray",
      points: [
        { time: T + i * INTERVAL, price: i === 0 ? 50080 : 40000 + i },
        { time: T + (i + 1) * INTERVAL, price: 40000 + i },
      ],
      market: "BTC",
      visible: true,
    });
  }
  manager.replace(drawings);

  const market = "BTC";
  const context = { drawings: manager };
  const host = {
    ...methods,
    view,
    pipeline: { series },
    state: { market },
    setHookAttr: () => {},
    overlay: {
      getActiveVolumeProfileLevels: () => null,
    },
    svc: {
      getAnalysisContext(requestedMarket, shared) {
        return context;
      },
    },
    analysisContextForChart() {
      return this.svc.getAnalysisContext(this.state.market, true);
    },
  };

  const prevMagnet = settings.magnet;
  const prevMode = settings.magnetMode;
  settings.magnet = true;
  settings.magnetMode = "strong";

  const originalClone = globalThis.structuredClone;
  let cloneCount = 0;
  globalThis.structuredClone = function (val) {
    cloneCount++;
    return originalClone(val);
  };

  try {
    // 1. Cursor close to drawing anchor at 50080: should snap to anchor (50080)
    // barX for index 0 is 10 (colWidth / 2 = 10)
    const anchorY = view.yOfPrice(50080); // 50200 - 50080 = 120
    cloneCount = 0;
    const snap1 = host._screenToDrawingPoint({ x: 10, y: anchorY + 1 });
    assert.equal(cloneCount, 0, "No structuredClone called during magnet snap");
    assert.equal(snap1.price, 50080, "Snaps to anchor price");
    assert.equal(snap1.time, T, "Snaps to anchor time");

    // 2. Cursor close to Bar High (50100): should snap to bar High
    const highY = view.yOfPrice(50100);
    cloneCount = 0;
    const snapHigh = host._screenToDrawingPoint({ x: 10, y: highY + 1 });
    assert.equal(cloneCount, 0, "No structuredClone called during High snap");
    assert.equal(snapHigh.price, 50100, "Snaps to Bar High");

    // 3. Cursor close to Bar POC (50020): should snap to Bar POC
    const pocY = view.yOfPrice(50020);
    cloneCount = 0;
    const snapPoc = host._screenToDrawingPoint({ x: 10, y: pocY });
    assert.equal(cloneCount, 0, "No structuredClone called during POC snap");
    assert.equal(snapPoc.price, 50020, "Snaps to Bar POC");
  } finally {
    globalThis.structuredClone = originalClone;
    settings.magnet = prevMagnet;
    settings.magnetMode = prevMode;
  }
});
