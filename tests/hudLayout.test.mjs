import test from "node:test";
import assert from "node:assert/strict";
import { HUD_ROW_HEIGHT, hudMaxRows, layoutHud } from "../dist/core/render/hudLayout.js";

// Monospace stand-in: 7px per character, 14px between parts.
const measure = (text) => text.length * 7;
const GAP = 14;
const part = (text, dropOrder = 0) => ({ text, color: "#fff", dropOrder });
const texts = (layout) => layout.rows.map((row) => row.parts.map((p) => p.text));

test("parts that fit stay on one row, spaced by the gap", () => {
  const layout = layoutHud([part("O 100"), part("H 110"), part("L 90")], measure, 400, 3, GAP);
  assert.deepEqual(texts(layout), [["O 100", "H 110", "L 90"]]);
  assert.deepEqual(layout.rows[0].parts.map((p) => p.x), [0, 35 + GAP, 70 + 2 * GAP]);
  assert.equal(layout.rows[0].width, 35 + 35 + 28 + 2 * GAP);
  assert.equal(layout.width, layout.rows[0].width);
});

test("a part that does not fit starts the next row, order kept", () => {
  const parts = [part("O 100.00"), part("H 110.00"), part("L 90.00"), part("C 105.00")];
  const layout = layoutHud(parts, measure, 150, 3, GAP);
  assert.deepEqual(texts(layout), [["O 100.00", "H 110.00"], ["L 90.00", "C 105.00"]]);
  for (const row of layout.rows) assert.ok(row.width <= 150, `row ${row.width} within 150`);
});

test("too many rows drop the part with the highest drop order, the later one on a tie", () => {
  const parts = [
    part("O 1", 0), part("H 2", 0), part("Vol 3", 2), part("Trades 4", 4), part("Range 5", 4), part("Chg 6", 1),
  ];
  // 112px holds three of these on a row. All six need three rows, so Range goes (it ties with Trades and comes later); the other five fit in two.
  const roomy = layoutHud(parts, measure, 112, 2, GAP);
  assert.deepEqual(texts(roomy).flat(), ["O 1", "H 2", "Vol 3", "Trades 4", "Chg 6"]);
  assert.ok(roomy.rows.length <= 2);
  // At 70px Range, Trades and then Vol (order 2, ahead of Chg at 1) have to go before two rows are enough.
  const tight = layoutHud(parts, measure, 70, 2, GAP);
  assert.deepEqual(texts(tight).flat(), ["O 1", "H 2", "Chg 6"]);
  assert.ok(tight.rows.length <= 2);
});

test("parts that never drop stay even when they overflow the rows; the surplus rows are cut", () => {
  const parts = [part("O 100.00"), part("H 110.00"), part("L 90.00"), part("C 105.00")];
  const layout = layoutHud(parts, measure, 60, 2, GAP);
  assert.equal(layout.rows.length, 2);
  assert.deepEqual(texts(layout), [["O 100.00"], ["H 110.00"]]);
});

test("a single part wider than the limit still gets its own row", () => {
  const layout = layoutHud([part("a very long readout part")], measure, 40, 3, GAP);
  assert.deepEqual(texts(layout), [["a very long readout part"]]);
  assert.ok(layout.width > 40);
});

test("no parts, no rows", () => {
  assert.deepEqual(layoutHud([], measure, 300, 3, GAP), { rows: [], width: 0 });
});

test("the readout may use fewer rows on a shorter plot", () => {
  assert.equal(hudMaxRows(822), 3);
  assert.equal(hudMaxRows(400), 3);
  assert.equal(hudMaxRows(399), 2);
  assert.equal(hudMaxRows(220), 2);
  assert.equal(hudMaxRows(219), 1);
  assert.ok(HUD_ROW_HEIGHT >= 14);
});
