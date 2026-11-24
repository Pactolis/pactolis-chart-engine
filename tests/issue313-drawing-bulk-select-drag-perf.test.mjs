import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";

function instrumentDrawingIdReads(drawings) {
  let reads = 0;
  for (const d of drawings) {
    const rawId = d.id;
    Object.defineProperty(d, "id", {
      configurable: true,
      enumerable: true,
      get() {
        reads++;
        return rawId;
      },
    });
  }
  return {
    getReads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

function makeDrawings(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push({
      id: `d-${i}`,
      type: "trendline",
      points: [
        { time: 1_800_000_000_000 + i * 60_000, price: 50000 + i },
        { time: 1_800_000_060_000 + i * 60_000, price: 50010 + i },
      ],
      market: "BTC",
      visible: true,
      locked: i === 1,
    });
  }
  return list;
}

test("Issue #313: selectMany validates in O(N + M), renderSelection short-circuits on empty selection, and group drag avoids quadratic id scans", () => {
  for (const count of [100, 500, 1000]) {
    const manager = new DrawingManager(() => {});
    manager.setMarket("BTC");
    manager.replace(makeDrawings(count));

    const readonlyDrawings = manager.listCurrentReadonly();
    const probe = instrumentDrawingIdReads(readonlyDrawings);

    // 1. renderSelection with empty selection must read 0 drawing ids
    const view = new View();
    view.area = { left: 0, top: 0, width: 800, height: 600 };
    view.colWidth = 20;
    view.offsetX = 0;
    view.priceTop = 52000;
    view.pricePerPx = 1;
    const dummyCtx = { save() {}, restore() {} };
    const timeCtx = {
      indexForTime: () => 0,
      timeForIndex: () => 1_800_000_000_000,
    };

    probe.reset();
    manager.renderSelection(dummyCtx, view, timeCtx, "BTC");
    assert.equal(probe.getReads(), 0, `count=${count}: empty renderSelection must perform 0 id reads`);

    // 2. selectMany with N/2 ids + invalid ids: single Set pass = exactly N id reads
    const toSelect = [];
    for (let i = 0; i < count; i += 2) toSelect.push(`d-${i}`);
    toSelect.push("non-existent-id");

    probe.reset();
    manager.selectMany(toSelect);
    assert.equal(
      probe.getReads(),
      count,
      `count=${count}: selectMany must read each drawing.id once (${count}), got ${probe.getReads()}`,
    );
    assert.equal(manager.getSelectedIds().length, count / 2);
    assert.equal(manager.selected?.id, `d-${count - 2}`);
  }
});

test("Issue #313: group drag and single-point edit perform 0 drawing.id lookups in pointerMove, respect locked drawings, and commit single undo step", () => {
  const manager = new DrawingManager(() => {});
  manager.setMarket("BTC");
  manager.replace(makeDrawings(500));

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 600 };
  view.colWidth = 20;
  view.offsetX = 0;
  view.priceTop = 50500;
  view.pricePerPx = 1;
  const timeCtx = {
    indexForTime: (t) => (t - 1_800_000_000_000) / 60_000,
    timeForIndex: (idx) => 1_800_000_000_000 + idx * 60_000,
  };
  manager.setHitTestContext(view, timeCtx);

  // Select d-0 (unlocked), d-1 (locked), d-2 (unlocked)
  manager.selectMany(["d-0", "d-1", "d-2"]);
  assert.equal(manager.selected?.id, "d-2");

  const startPt = { time: 1_800_000_000_000, price: 50000 };
  const started = manager.pointerDown(startPt, { x: view.xOfIndex(0) + view.colWidth / 2, y: view.yOfPrice(50000) });
  assert.equal(started, true);

  const probe = instrumentDrawingIdReads(manager.listCurrentReadonly());
  probe.reset();

  for (let step = 1; step <= 20; step++) {
    manager.pointerMove({
      time: startPt.time + step * 60_000,
      price: startPt.price + step * 10,
    });
  }
  assert.equal(probe.getReads(), 0, "pointerMove group drag must perform 0 id scans");

  manager.pointerUp();

  const after = manager.listCurrent();
  // d-0 and d-2 moved by +200 price; d-1 (locked) stayed at 50001
  assert.equal(after[0].points[0].price, 50200);
  assert.equal(after[1].points[0].price, 50001);
  assert.equal(after[2].points[0].price, 50202);

  // Single-step undo/redo
  assert.equal(manager.undo(), true);
  assert.equal(manager.listCurrent()[0].points[0].price, 50000);
  assert.equal(manager.redo(), true);
  assert.equal(manager.listCurrent()[0].points[0].price, 50200);

  // Single-point edit on d-0 must also avoid id scans during pointerMove
  manager.select("d-0");
  assert.equal(manager.pointerDown(after[0].points[0], { x: view.xOfIndex(20) + view.colWidth / 2, y: view.yOfPrice(50200) }), true);
  probe.reset();
  for (let step = 1; step <= 10; step++) {
    manager.pointerMove({ time: after[0].points[0].time, price: 50200 + step });
  }
  assert.equal(probe.getReads(), 0, "pointerMove single-point edit must perform 0 id scans");
  manager.pointerUp();
});
