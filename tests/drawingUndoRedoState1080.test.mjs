import test from "node:test";
import assert from "node:assert/strict";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";

const MARKET = "BINANCE_FUTURES:btcusdt";
const P1 = { time: 10, price: 100 };
const P2 = { time: 20, price: 120 };

function assertHistoryState(manager, expected) {
  assert.equal(manager.canUndo, expected.canUndo);
  assert.equal(manager.canRedo, expected.canRedo);
  assert.equal(manager.undoCount, expected.undoCount);
  assert.equal(manager.redoCount, expected.redoCount);
}

function assertDrawingParity(manager, expected) {
  const drawings = manager.list();
  assert.equal(drawings.length, 1);
  assert.equal(drawings[0].id, expected.id);
  assert.equal(drawings[0].market, MARKET);
  assert.equal(drawings[0].visible, expected.visible);
  assert.equal(drawings.findIndex((item) => item.id === expected.id), expected.index);
}

test("DrawingManager undo/redo reactive state starts empty", () => {
  const manager = new DrawingManager(() => {});
  assertHistoryState(manager, { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
});

test("DrawingManager undo/redo lifecycle and parity across add, drag, batch style, and delete", () => {
  const notifications = [];
  const manager = new DrawingManager((drawings, transient) => {
    if (!transient) notifications.push(drawings.length);
  });
  manager.setMarket(MARKET);
  assertHistoryState(manager, { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });

  // 1. Add line via placement gesture
  manager.setTool("horizontal");
  assert.equal(manager.pointerDown(P1), true);
  assert.equal(manager.pointerUp(), true);
  const added = manager.list()[0];
  assert.ok(added?.id);
  const id = added.id;
  const initialColor = added.color;
  assertHistoryState(manager, { canUndo: true, canRedo: false, undoCount: 1, redoCount: 0 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });

  // 2. Drag / move coordinate (single undo step)
  assert.equal(manager.pointerDown(P1), true);
  assert.equal(manager.pointerMove({ time: 15, price: 110 }), true);
  assert.equal(manager.pointerUp(), true);
  assertHistoryState(manager, { canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].points[0].price, 110);

  // 3. Batch style/color update (updateSelectedBatch via updateSelectedWithHistory, single undo step)
  manager.select(id);
  manager.updateSelectedWithHistory({ color: "#ff5500", lineWidth: 3 });
  assertHistoryState(manager, { canUndo: true, canRedo: false, undoCount: 3, redoCount: 0 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].color, "#ff5500");

  // 4. Delete drawing (single undo step)
  manager.deleteSelected();
  assertHistoryState(manager, { canUndo: true, canRedo: false, undoCount: 4, redoCount: 0 });
  assert.equal(manager.list().length, 0);

  // 4x undo()
  manager.undo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 3, redoCount: 1 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].color, "#ff5500");

  manager.undo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 2, redoCount: 2 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].color, initialColor);
  assert.equal(manager.list()[0].points[0].price, 110);

  manager.undo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 1, redoCount: 3 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].points[0].price, 100);

  manager.undo();
  assertHistoryState(manager, { canUndo: false, canRedo: true, undoCount: 0, redoCount: 4 });
  assert.equal(manager.list().length, 0);
  assert.deepEqual(manager.getSelectedIds(), []);

  // 4x redo()
  manager.redo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 1, redoCount: 3 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].points[0].price, 100);

  manager.redo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 2, redoCount: 2 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].points[0].price, 110);

  manager.redo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 3, redoCount: 1 });
  assertDrawingParity(manager, { id, visible: true, index: 0 });
  assert.equal(manager.list()[0].color, "#ff5500");

  // Select before redo-delete to verify redo() prunes stale selection
  manager.select(id);
  assert.deepEqual(manager.getSelectedIds(), [id]);
  manager.redo();
  assertHistoryState(manager, { canUndo: true, canRedo: false, undoCount: 4, redoCount: 0 });
  assert.equal(manager.list().length, 0);
  assert.deepEqual(manager.getSelectedIds(), []);
  assert.equal(manager.selected, null);
  assert.ok(notifications.length >= 12);
});

test("DrawingManager selection changes do not mutate undoCount or redoCount", () => {
  const manager = new DrawingManager(() => {});
  manager.setMarket(MARKET);
  manager.replace([
    { id: "d1", type: "trend", points: [P1, P2], color: "#fff", lineWidth: 1, locked: false, visible: true, market: MARKET },
  ]);
  manager.updateWithHistory("d1", { color: "#00ff00" });
  manager.undo();
  assertHistoryState(manager, { canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 });

  manager.select("d1");
  assertHistoryState(manager, { canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 });
  manager.clearSelection();
  assertHistoryState(manager, { canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 });
});

test("DrawingManager clears redoStack when a new edit or addition occurs after undo", () => {
  const manager = new DrawingManager(() => {});
  manager.setMarket(MARKET);
  manager.replace([
    { id: "d1", type: "trend", points: [P1, P2], color: "#fff", lineWidth: 1, locked: false, visible: true, market: MARKET },
  ]);
  manager.updateWithHistory("d1", { color: "#111111" });
  manager.updateWithHistory("d1", { color: "#222222" });
  manager.undo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });

  // Style update after undo clears redoStack
  manager.select("d1");
  manager.updateSelectedWithHistory({ color: "#333333" });
  assertHistoryState(manager, { canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });

  // Undo again, then add a new drawing -> also clears redoStack
  manager.undo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });
  manager.setTool("horizontal");
  manager.pointerDown(P1);
  manager.pointerUp();
  assertHistoryState(manager, { canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });
});

test("DrawingManager enforces 50-entry history cap and resets counts on replace", () => {
  const manager = new DrawingManager(() => {});
  manager.setMarket(MARKET);
  manager.replace([
    { id: "d1", type: "trend", points: [P1, P2], color: "#fff", lineWidth: 1, locked: false, visible: true, market: MARKET },
  ]);

  for (let i = 1; i <= 55; i++) {
    manager.updateWithHistory("d1", { lineWidth: (i % 4) + 1 });
  }
  assert.equal(manager.canUndo, true);
  assert.equal(manager.undoCount <= 50, true);
  assert.equal(manager.undoCount, 50);
  assert.equal(manager.redoCount, 0);

  manager.undo();
  assertHistoryState(manager, { canUndo: true, canRedo: true, undoCount: 49, redoCount: 1 });

  // replace() (load) clears both stacks
  manager.replace([]);
  assertHistoryState(manager, { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
});
