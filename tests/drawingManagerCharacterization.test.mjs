import test from "node:test";
import assert from "node:assert/strict";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";

const MARKET = "BINANCE_FUTURES:btcusdt";
const point = { time: 10, price: 100 };
const line = (patch = {}) => ({
  id: "line", type: "horizontal", points: [point, { time: 20, price: 100 }],
  color: "#fff", lineWidth: 1, locked: false, visible: true, market: MARKET, ...patch,
});

// These characterize the facade before the #121 move. In particular, selection-only
// clicks and callbacks do not introduce history entries or expose the mutable graph.
test("DrawingManager characterization: locked pointer selection notifies once and cannot edit or delete", () => {
  const events = [];
  const manager = new DrawingManager((drawings, transient) => events.push({ drawings, transient }));
  manager.replace([line({ locked: true })]);
  manager.setMarket(MARKET);
  events.length = 0;
  const before = manager.list();
  assert.equal(manager.pointerDown(point), true);
  assert.deepEqual(manager.getSelectedIds(), ["line"]);
  assert.equal(manager.isPointerDragActive(), false);
  assert.equal(manager.pointerMove({ time: 30, price: 200 }), false);
  assert.equal(manager.pointerUp(), false);
  manager.deleteSelected();
  assert.deepEqual(manager.list(), before);
  assert.deepEqual(events, [{ drawings: before, transient: false }]);
});

test("DrawingManager characterization: double-click settings emits selection before settings even after silent hit", () => {
  const events = [];
  const manager = new DrawingManager(
    (_drawings, transient) => events.push(["change", transient, manager.getSelectedIds()]),
    undefined, undefined, (id) => events.push(["settings", id]),
  );
  manager.replace([line()]);
  manager.setMarket(MARKET);
  events.length = 0;
  assert.equal(manager.hitTestAt(point)?.id, "line");
  assert.deepEqual(events, []);
  manager.requestSettings("line");
  assert.deepEqual(events, [["change", false, ["line"]], ["settings", "line"]]);
});

test("DrawingManager characterization: completed point edit is one undo step and selection-only click preserves redo", () => {
  const manager = new DrawingManager(() => {});
  manager.replace([line()]);
  manager.setMarket(MARKET);
  const before = manager.list();
  manager.pointerDown(point);
  manager.pointerMove({ time: 15, price: 110 });
  manager.pointerUp();
  const after = manager.list();
  assert.notDeepEqual(after, before);
  manager.undo();
  assert.deepEqual(manager.list(), before);
  manager.pointerDown(point);
  manager.pointerUp();
  manager.redo();
  assert.deepEqual(manager.list(), after);
});

test("DrawingManager characterization: serialization and notifications retain clone isolation", () => {
  let notified;
  const manager = new DrawingManager((drawings) => { notified = drawings; });
  const input = [line()];
  manager.replace(input);
  manager.setMarket(MARKET);
  const golden = JSON.stringify(manager.list());
  input[0].points[0] = { time: -1, price: -1 };
  notified[0].points[0].price = -2;
  const selected = manager.select("line");
  selected.points[0].price = -3;
  assert.equal(JSON.stringify(manager.list()), golden);
  const restored = new DrawingManager(() => {});
  restored.replace(JSON.parse(golden));
  assert.equal(JSON.stringify(restored.list()), golden);
});

test("DrawingManager characterization: text placement orders tool reset, persisted change, and editor request", () => {
  const events = [];
  const manager = new DrawingManager(
    (drawings, transient) => events.push(["change", drawings.map((drawing) => drawing.type), transient]),
    (tool) => events.push(["tool", tool]),
    (_id, deleteOnCancel) => events.push(["text", deleteOnCancel]),
  );
  manager.setMarket(MARKET);
  events.length = 0;
  manager.setTool("text");
  manager.pointerDown(point);
  assert.deepEqual(events, [["tool", "text"], ["tool", null], ["change", ["text"], false], ["text", true]]);
});

test("DrawingState clears summaryCache and readonlyListCache on setMarket/replace and bounds cache size (#405)", () => {
  const manager = new DrawingManager(() => {});
  manager.setMarket("BINANCE_FUTURES:btcusdt");
  manager.replace([line({ id: "d-btc", market: "BINANCE_FUTURES:btcusdt" })]);

  // Query >16 markets and verify both caches stay bounded.
  for (let i = 0; i < 20; i++) {
    const mkt = `BINANCE_FUTURES:sym${i}usdt`;
    manager.marketSummary(mkt);
    manager.listForMarketReadonly(mkt);
  }
  assert.ok(manager.summaryCache.size <= 16, `expected summaryCache.size <= 16, got ${manager.summaryCache.size}`);
  assert.ok(manager.readonlyListCache.size <= 16, `expected readonlyListCache.size <= 16, got ${manager.readonlyListCache.size}`);

  // setMarket clears caches immediately.
  manager.setMarket("BINANCE_FUTURES:ethusdt");
  assert.equal(manager.summaryCache.size, 0);
  assert.equal(manager.readonlyListCache.size, 0);

  // Populate again and verify replace() (load/clear) clears caches.
  manager.marketSummary("BINANCE_FUTURES:ethusdt");
  manager.listForMarketReadonly("BINANCE_FUTURES:ethusdt");
  assert.equal(manager.summaryCache.size, 1);
  assert.equal(manager.readonlyListCache.size, 1);

  manager.replace([]);
  assert.equal(manager.summaryCache.size, 0);
  assert.equal(manager.readonlyListCache.size, 0);
});
