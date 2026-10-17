import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";

function makeView({ width = 600, colWidth = 50 } = {}) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height: 400 };
  view.colWidth = colWidth;
  return view;
}

test("rescaleColWidthForInterval preserves the visible time window across a timeframe change (DEC-0094)", () => {
  // 4h→1d: each bar spans 6× the time, so colWidth must grow 6× to keep the same time window.
  const view = makeView({ colWidth: 3 });
  view.rescaleColWidthForInterval(4 * 3600_000, 24 * 3600_000);
  assert.equal(view.colWidth, 18, "colWidth scales by newInterval/oldInterval");

  // 1d→4h: inverse — colWidth shrinks 6×.
  const view2 = makeView({ colWidth: 18 });
  view2.rescaleColWidthForInterval(24 * 3600_000, 4 * 3600_000);
  assert.equal(view2.colWidth, 3);

  // No-op guards: same interval, or non-positive inputs, leave colWidth untouched.
  const view3 = makeView({ colWidth: 42 });
  view3.rescaleColWidthForInterval(3600_000, 3600_000);
  view3.rescaleColWidthForInterval(0, 3600_000);
  view3.rescaleColWidthForInterval(3600_000, -1);
  assert.equal(view3.colWidth, 42);
});

test("rescaleColWidthForInterval clamps to the usable bar-spacing range", () => {
  // An extreme zoom-out (tiny colWidth) shrinking further must clamp at the minimum,
  // not collapse toward zero (which produced the 33-year blank window, DEC-0094).
  const view = makeView({ colWidth: 0.2 });
  view.rescaleColWidthForInterval(24 * 3600_000, 3600_000); // 1d→1h, ratio 1/24
  assert.ok(view.colWidth >= view.minimumBarSpacing(), "clamped to minimum bar spacing");
});

test("clampOffsetX permits long pans while retaining guarded edge bars", () => {
  const view = makeView();
  view.offsetX = -100_000;
  view.clampOffsetX(100);
  assert.equal(view.offsetX, -(100 - 2) * 50);

  view.offsetX = 100_000;
  view.clampOffsetX(100);
  assert.equal(view.offsetX, 600 - 2 * 50);
});

test("clampOffsetX handles fewer bars than the requested minimum", () => {
  const view = makeView({ width: 800, colWidth: 80 });
  view.offsetX = -100_000;
  view.clampOffsetX(2);
  assert.equal(view.offsetX, -80);

  view.offsetX = 100_000;
  view.clampOffsetX(2);
  assert.equal(view.offsetX, 720);
});

test("clampOffsetX supports explicit edge padding without inverted bounds", () => {
  const view = makeView({ width: 320, colWidth: 40 });
  view.offsetX = -100_000;
  view.clampOffsetX(20, 4, 2);
  assert.equal(view.offsetX, -(20 - 2) * 40);

  view.offsetX = 100_000;
  view.clampOffsetX(20, 4, 2);
  assert.equal(view.offsetX, 320 - 2 * 40);
});

test("fitPriceRange contains the selected range in linear and log modes", () => {
  const view = makeView();
  view.fitPriceRange(100, 200);
  assert.ok(view.priceOfY(view.area.top) > 200);
  assert.ok(view.priceOfY(view.area.top + view.area.height) < 100);

  view.setScaleMode("log");
  view.fitPriceRange(1_000, 4_000);
  assert.ok(view.priceOfY(view.area.top) > 4_000);
  assert.ok(view.priceOfY(view.area.top + view.area.height) < 1_000);
});

for (const width of [333, 997, 1441]) {
  for (const pad of [1, 3]) {
    for (const total of [500, 73]) {
      test("Settings/250 reset complete columns W=" + width + " total=" + total + " p=" + pad, () => {
        const view = makeView({ width, colWidth: 19.75 });
        view.area.left = 37;
        view.offsetX = -1234.5;
        const count = Math.min(total, 250);
        const spacing = width / (count + pad - 1);
        view.resetTimeScale(total, pad);
        assert.ok(Math.abs(view.colWidth - spacing) < 1e-9,
          "fractional 250 fit: expected " + spacing + ", actual " + view.colWidth);
        assert.ok(Math.abs(view.xOfIndex(total - count) - 37) < 1e-9, "oldest complete column starts at plot left");
        assert.ok(Math.abs(view.xOfIndex(total - 1) - (37 + width - pad * spacing)) < 1e-9,
          "helper padding counts from latest column left edge");
        assert.ok(Math.abs(view.xOfIndex(total - 1) + spacing - (37 + width - (pad - 1) * spacing)) < 1e-9,
          "latest complete column leaves p-1 empty columns");
        const epsilon = 1e-7;
        const complete = Array.from({ length: total }, (_, index) => index).filter((index) =>
          view.xOfIndex(index) >= 37 - epsilon &&
          view.xOfIndex(index) + view.colWidth <= 37 + width + epsilon);
        assert.deepEqual(complete, Array.from({ length: count }, (_, index) => total - count + index),
          "exactly latest N complete columns; not padded visibleRange");
      });
    }
  }
}
