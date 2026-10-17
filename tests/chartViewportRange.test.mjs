import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";

// TASK-028 — programatik viewport API'sinin matematiksel çekirdeği.
// setVisibleIndexRange, verilen [fromIdx, toIdx] aralığını plot genişliğine oturtmalı:
// sol kenar fromIdx'e, sağ kenar toIdx'e karşılık gelmeli (colWidth clamp sınırları içinde).

test("setVisibleIndexRange places fromIdx at left edge and toIdx at right edge", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 700, height: 400 };

  view.setVisibleIndexRange(100, 150);

  // Round-trip: ekran kenarlarının index karşılığı hedef aralığa eşit olmalı.
  assert.ok(Math.abs(view.indexOfX(view.area.left) - 100) < 1e-6, "left edge maps to fromIdx");
  assert.ok(Math.abs(view.indexOfX(view.area.left + view.area.width) - 150) < 1e-6, "right edge maps to toIdx");
});

test("setVisibleIndexRange clamps colWidth to barSpacing limits", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 700, height: 400 };

  // Çok dar aralık → colWidth maxBarSpacing'e clamp'lenir (taşma kabul edilir).
  view.setVisibleIndexRange(0, 1);
  assert.ok(view.colWidth <= view.timeScaleOptions.maxBarSpacing, "colWidth <= max");
  assert.ok(view.colWidth >= view.timeScaleOptions.minBarSpacing, "colWidth >= min");

  // Çok geniş aralık → colWidth minBarSpacing'e clamp'lenir.
  view.setVisibleIndexRange(0, 100000);
  assert.equal(view.colWidth, view.minimumBarSpacing(), "wide range pins to dynamic min spacing");
});

test("setVisibleIndexRange is stable across left offset", () => {
  const view = new View();
  view.area = { left: 50, top: 0, width: 600, height: 400 };

  view.setVisibleIndexRange(20, 80);
  assert.ok(Math.abs(view.indexOfX(view.area.left) - 20) < 1e-6, "respects non-zero area.left");
});

test("a requested 3600-bar range fits inside a 900px plot", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 900, height: 400 };
  view.setVisibleIndexRange(0, 3600);

  assert.equal(view.colWidth, 0.25);
  assert.ok(Math.abs(view.indexOfX(900) - 3600) < 1e-6);
});

test("maximum zoom out is dynamically capped at 4000 visible bars", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 900, height: 400 };
  view.zoomX(0.001, 450);
  view.scrollToIndex(3999, 1);

  assert.equal(view.colWidth, 900 / 4000);
  assert.ok(Math.abs(view.xOfIndex(3999) - (900 - view.colWidth)) < 1e-6);
  assert.equal(Math.ceil(view.indexOfX(900)) - Math.floor(view.indexOfX(0)), 4000);
});

test("maximum visible-bar cap scales with wider plots", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 1800, height: 400 };
  view.zoomX(0.001, 900);
  view.scrollToIndex(3999, 1);

  assert.equal(view.colWidth, 1800 / 4000);
  assert.equal(Math.ceil(view.indexOfX(1800)) - Math.floor(view.indexOfX(0)), 4000);
});

test("resize enforcement raises stale spacing to the 4000-bar cap", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 900, height: 400 };
  view.zoomX(0.001, 450);
  view.area = { left: 0, top: 0, width: 1800, height: 400 };

  assert.equal(view.enforceMinimumBarSpacing(), true);
  assert.equal(view.colWidth, 1800 / 4000);
  assert.equal(view.enforceMinimumBarSpacing(), false);
});
