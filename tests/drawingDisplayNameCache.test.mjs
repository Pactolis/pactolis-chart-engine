import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { drawingDisplayName } from "../dist/features/drawings/drawingPrimitives.js";

test("DrawingManager single-pass display names match drawingDisplayName parity", () => {
  const manager = new DrawingManager(() => {});
  const drawings = [
    { id: "h1", type: "horizontal", points: [{ time: 100, price: 100 }, { time: 200, price: 100 }], market: "BTC", visible: true },
    { id: "h2", type: "horizontal", points: [{ time: 100, price: 150 }, { time: 200, price: 150 }], market: "BTC", visible: true },
    { id: "v1", type: "vertical", points: [{ time: 150, price: 50 }, { time: 150, price: 200 }], market: "BTC", visible: true },
    { id: "custom", type: "horizontal", text: "Custom Level", points: [{ time: 100, price: 200 }, { time: 200, price: 200 }], market: "BTC", visible: true },
  ];

  manager.replace(drawings);

  // Test parity with drawingDisplayName
  for (const d of drawings) {
    const expected = drawingDisplayName(d, drawings);
    if (d.id === "custom") {
      assert.equal(expected, "Custom Level");
    }
  }

  // Render pass uses the display names cache
  const view = new View();
  view.area = { left: 0, top: 0, width: 400, height: 300 };
  view.priceTop = 200;
  view.pricePerPx = 1;
  const time = {
    indexForTime: (v) => v,
    timeForIndex: (idx) => idx,
  };

  const capturedLabels = [];
  const fakeCtx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
    fillText() {},
    strokeRect() {},
    fillRect() {},
    setLineDash() {},
  };

  manager.render(fakeCtx, view, time, (price, text, color) => {
    capturedLabels.push({ price, text, color });
  }, undefined, "BTC");

  assert.ok(capturedLabels.length >= 2, "Expected price axis labels for horizontal lines");
  const customLabel = capturedLabels.find((l) => l.price === 200);
  assert.ok(customLabel, "Custom level label should be queued");
  assert.equal(customLabel.text, "Custom Level");
});
