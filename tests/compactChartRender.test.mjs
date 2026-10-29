import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { HUD_ROW_HEIGHT } from "../dist/core/render/hudLayout.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { drawCrosshairTimeLabel, drawTimeAxis } from "../dist/core/render/timeAxisRenderer.js";
import { TOUCH_MENU_BUTTON_RESERVE, touchMenuButtonRect } from "../dist/core/render/touchControlsRenderer.js";

// 7px per character, like the other render tests.
function makeContext() {
  const calls = [];
  const record = (op) => (...args) => { calls.push({ op, args }); };
  const ctx = {
    canvas: { width: 1200, height: 800, clientWidth: 1000, clientHeight: 500 },
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    calls,
    measureText: (text) => ({ width: String(text).length * 7 }),
  };
  for (const op of ["save", "restore", "beginPath", "moveTo", "lineTo", "stroke", "fill", "arc", "roundRect", "fillRect", "strokeRect", "rect", "clip", "fillText", "clearRect", "setLineDash"]) {
    ctx[op] = record(op);
  }
  return ctx;
}

function makeView({ width, height, density = "regular" }) {
  const view = new View({}, { density });
  view.area = { left: 0, top: 0, width, height };
  view.priceAxisW = view.chartLayoutOptions.priceAxisWidth;
  return view;
}

function seriesWithOneBar() {
  const bar = {
    startTime: 60_000, open: 100, high: 110, low: 100, close: 105, volume: 10, delta: 2, count: 4,
    cells: new Map([[103, { priceBin: 103, buyVol: 6, sellVol: 4 }]]), hasRef: true,
  };
  return {
    length: 1,
    config: { intervalMs: 60_000, priceStep: 1, pricePrecision: 0 },
    list: () => [bar],
    at: (index) => (index === 0 ? bar : undefined),
    timeOfIndex: (index) => 60_000 + index * 60_000,
  };
}

/** What the bar readout drew: its texts with their rows and right edges, and its background pill. */
function drawReadout(view, crosshair = { x: 0, y: 0, visible: false }) {
  const ctx = makeContext();
  new Overlay(ctx).renderInteraction(view, seriesWithOneBar(), crosshair, [0, 1], ["hud"]);
  const texts = ctx.calls
    .filter((call) => call.op === "fillText")
    .map(({ args: [text, x, y] }) => ({ text, x, y, right: x + text.length * 7 }));
  const pills = ctx.calls.filter((call) => call.op === "roundRect").map(({ args: [x, y, w, h] }) => ({ x, y, w, h }));
  const rows = [...new Set(texts.map((t) => t.y))];
  return { texts, pills, rows, names: texts.map((t) => t.text.split(" ")[0]) };
}

test("a plot wide enough keeps the readout on one line, as before", () => {
  const { texts, rows, pills } = drawReadout(makeView({ width: 1200, height: 500 }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0], 8);
  assert.equal(texts.length, 5, "open-to-volume, delta, trades, range and change");
  assert.equal(pills[0].h, 20);
});

test("a narrow plot flows the readout into rows that stay inside the plot", () => {
  const view = makeView({ width: 330, height: 500 });
  const { texts, rows, pills, names } = drawReadout(view);
  assert.ok(rows.length >= 2, `wrapped into ${rows.length} rows`);
  assert.ok(rows.length <= 3);
  assert.deepEqual(rows, rows.map((_, index) => 8 + index * HUD_ROW_HEIGHT), "rows are one HUD row apart");
  for (const t of texts) {
    assert.ok(t.right <= view.area.width - 8, `"${t.text}" ends at ${t.right}, inside the plot`);
  }
  for (const name of ["O", "H", "L", "C"]) assert.ok(names.includes(name), `${name} is never dropped`);
  assert.equal(pills[0].h, 20 + (rows.length - 1) * HUD_ROW_HEIGHT, "the pill grows with the rows");
  assert.ok(pills[0].x + pills[0].w <= view.area.width, "and ends inside the plot");
});

test("a short pane gets one row and gives up the less useful figures to fit it", () => {
  const view = makeView({ width: 330, height: 180 });
  const { texts, rows, names } = drawReadout(view);
  assert.deepEqual(rows, [8]);
  for (const name of ["O", "H", "L", "C"]) assert.ok(names.includes(name));
  assert.ok(!names.includes("Range") && !names.includes("Trades"), "range and trades go first");
  assert.ok(texts.every((t) => t.right <= view.area.width - 8));
});

test("a plot with no room for a readout draws none rather than running over the axis", () => {
  const { texts } = drawReadout(makeView({ width: 70, height: 300 }));
  assert.deepEqual(texts, []);
});

test("in touch mode the readout leaves the corner column to the menu button", () => {
  // The width at which the whole line just fits a mouse chart but not one that reserves the button's column.
  const probe = drawReadout(makeView({ width: 2000, height: 500 }));
  const lineWidth = Math.max(...probe.texts.map((t) => t.right)) - 8;
  const width = Math.ceil(lineWidth) + 16 + 20;
  assert.ok(TOUCH_MENU_BUTTON_RESERVE > 20);

  const mouse = drawReadout(makeView({ width, height: 500 }));
  assert.equal(mouse.rows.length, 1, "fits on one line with a mouse");

  const view = makeView({ width, height: 500 });
  const touch = drawReadout(view, { x: 0, y: 0, visible: false, touch: true });
  const button = touchMenuButtonRect(view);
  assert.ok(button);
  assert.ok(touch.rows.length >= 2, "wraps once the button takes its column");
  for (const t of touch.texts) {
    assert.ok(t.right <= button.x, `"${t.text}" ends at ${t.right}, left of the button at ${button.x}`);
  }
});

test("a plot too small for the menu button does not reserve its column", () => {
  const view = makeView({ width: 150, height: 300 });
  assert.equal(touchMenuButtonRect(view), null);
  const touch = drawReadout(view, { x: 0, y: 0, visible: false, touch: true });
  const mouse = drawReadout(view);
  assert.deepEqual(touch.texts, mouse.texts);
});

// --- time axis -------------------------------------------------------------------

function timeSeries(count = 40) {
  const start = Date.UTC(2026, 5, 23, 8, 0);
  const bars = Array.from({ length: count }, (_, index) => ({ startTime: start + index * 60_000 }));
  return {
    length: bars.length,
    config: { intervalMs: 60_000 },
    at: (index) => bars[index],
    timeOfIndex: (index) => start + index * 60_000,
  };
}

function timeAxisView(layout) {
  const view = new View({}, layout);
  view.area = { left: 0, top: 0, width: 700, height: 300 };
  view.priceAxisW = view.chartLayoutOptions.priceAxisWidth;
  view.colWidth = 20;
  view.scrollToIndex(39, 1);
  return view;
}

const tickLabelYs = (ctx) => ctx.calls
  .filter((call) => call.op === "fillText")
  .map((call) => call.args[2]);

test("a taller time strip keeps its labels centered; the regular strip is unchanged", () => {
  const draw = (layout) => {
    const ctx = makeContext();
    drawTimeAxis(ctx, timeAxisView(layout), timeSeries());
    return tickLabelYs(ctx);
  };
  const regular = draw({});
  const compact = draw({ density: "compact" });
  assert.ok(regular.length > 0 && regular.length === compact.length);
  const axisTop = 300;
  assert.ok(regular.every((y) => y === axisTop + 3 + 2), "regular: just under the tick");
  assert.ok(compact.every((y) => y === axisTop + 5 + 3 + 2), "compact: 5px lower, half of the 10px the strip gained");

  assert.ok(draw({ timeAxisHeight: 24 }).every((y) => y === axisTop + 3 + 2), "a 2px taller strip needs no shift");
  assert.ok(draw({ timeAxisHeight: 28 }).every((y) => y === axisTop + 3 + 3 + 2), "28px: half of the 6px gained");
});

test("the crosshair's time label moves down with the strip too", () => {
  const draw = (layout) => {
    const view = timeAxisView(layout);
    const ctx = makeContext();
    drawCrosshairTimeLabel(ctx, view, timeSeries(), { x: view.xOfIndex(30) + 5, y: 100, visible: true });
    return ctx.calls.find((call) => call.op === "fillText").args[2];
  };
  assert.equal(draw({ density: "compact" }) - draw({}), 5);
});
