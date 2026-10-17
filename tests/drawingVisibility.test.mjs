import test from "node:test";
import assert from "node:assert/strict";
import { DrawingManager, LEGACY_DRAWING_MARKET } from "../dist/features/drawings/drawingManager.js";

test("bulk drawing visibility is a single undo and redo operation", () => {
  let latest = [];
  const manager = new DrawingManager((drawings) => { latest = drawings; });
  manager.replace([
    { id: "a", type: "horizontal", points: [], color: "#fff", lineWidth: 1, locked: false, visible: true },
    { id: "b", type: "trend", points: [], color: "#fff", lineWidth: 1, locked: false, visible: false },
  ]);
  manager.setMarket(LEGACY_DRAWING_MARKET);

  manager.setAllVisible(false);
  assert.deepEqual(latest.map((drawing) => drawing.visible), [false, false]);
  manager.undo();
  assert.deepEqual(latest.map((drawing) => drawing.visible), [true, false]);
  manager.redo();
  assert.deepEqual(latest.map((drawing) => drawing.visible), [false, false]);
});

test("legacy drawings without a market migrate to the legacy BTC market", () => {
  let latest = [];
  const manager = new DrawingManager((drawings) => { latest = drawings; });
  manager.replace([
    { id: "a", type: "horizontal", points: [], color: "#fff", lineWidth: 1, locked: false, visible: true },
  ]);
  assert.equal(manager.list()[0].market, LEGACY_DRAWING_MARKET);
  void latest;
});

test("listCurrent only returns drawings for the active market", () => {
  const manager = new DrawingManager(() => {});
  manager.replace([
    { id: "a", type: "horizontal", points: [], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:btcusdt" },
    { id: "b", type: "horizontal", points: [], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:ethusdt" },
  ]);

  manager.setMarket("BINANCE_FUTURES:btcusdt");
  assert.deepEqual(manager.listCurrent().map((drawing) => drawing.id), ["a"]);
  assert.equal(manager.list().length, 2);

  manager.setMarket("BINANCE_FUTURES:ethusdt");
  assert.deepEqual(manager.listCurrent().map((drawing) => drawing.id), ["b"]);
});

test("setAllVisible only affects drawings on the active market", () => {
  let latest = [];
  const manager = new DrawingManager((drawings) => { latest = drawings; });
  manager.replace([
    { id: "a", type: "horizontal", points: [], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:btcusdt" },
    { id: "b", type: "horizontal", points: [], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:ethusdt" },
  ]);
  manager.setMarket("BINANCE_FUTURES:btcusdt");

  manager.setAllVisible(false);
  const byId = Object.fromEntries(latest.map((drawing) => [drawing.id, drawing.visible]));
  assert.equal(byId.a, false);
  assert.equal(byId.b, true);
});

test("empty plot click clears selection without deleting or changing drawings", () => {
  const manager = new DrawingManager(() => {});
  manager.replace([
    { id: "a", type: "trend", points: [{ time: 10, price: 100 }, { time: 20, price: 110 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:btcusdt" },
  ]);
  manager.setMarket("BINANCE_FUTURES:btcusdt");
  manager.select("a");

  assert.equal(manager.pointerDown({ time: 999, price: 999 }), false);
  assert.equal(manager.selected, null);
  assert.equal(manager.list().length, 1);
});

test("selected drawings are filtered out for another chart market", () => {
  const manager = new DrawingManager(() => {});
  manager.replace([
    { id: "btc", type: "trend", points: [{ time: 10, price: 100 }, { time: 20, price: 110 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:btcusdt" },
    { id: "eth", type: "trend", points: [{ time: 10, price: 100 }, { time: 20, price: 110 }], color: "#fff", lineWidth: 1, locked: false, visible: true, market: "BINANCE_FUTURES:ethusdt" },
  ]);
  manager.setMarket("BINANCE_FUTURES:btcusdt");
  manager.select("btc");
  manager.setMarket("BINANCE_FUTURES:ethusdt");

  assert.deepEqual(manager.listForMarket("BINANCE_FUTURES:ethusdt").map((drawing) => drawing.id), ["eth"]);
  assert.deepEqual(
    manager.getSelectedDrawings().filter((drawing) => drawing.market === "BINANCE_FUTURES:ethusdt"),
    [],
  );
});
