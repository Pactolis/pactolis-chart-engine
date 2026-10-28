import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { DEFAULT_CHART_LAYOUT_OPTIONS } from "../dist/core/model/chartLayoutOptions.js";
import { drawPriceScaleControls } from "../dist/core/render/axisControlsRenderer.js";
import { Overlay } from "../dist/core/render/overlay.js";
import {
  TOUCH_CONTROL_HIT_SLOP,
  TOUCH_MENU_BUTTON_RESERVE,
  TOUCH_MENU_BUTTON_SIZE,
  pointInTouchControl,
  touchMenuButtonRect,
} from "../dist/core/render/touchControlsRenderer.js";

function makeView({ width = 330, height = 420 } = {}) {
  const view = new View();
  view.area = { left: 0, top: 0, width, height };
  view.priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;
  view.subPanesH = 0;
  return view;
}

function makeContext() {
  const calls = [];
  const record = (op) => (...args) => { calls.push({ op, args, fillStyle: ctx.fillStyle }); };
  const ctx = {
    canvas: { width: 600, height: 600, clientWidth: 392, clientHeight: 442 },
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    calls,
    measureText: (text) => ({ width: String(text).length * 7 }),
  };
  for (const op of ["save", "restore", "beginPath", "moveTo", "lineTo", "stroke", "fill", "arc", "roundRect", "fillRect", "strokeRect", "fillText", "clearRect", "setLineDash"]) {
    ctx[op] = record(op);
  }
  return ctx;
}

const labels = (ctx) => ctx.calls.filter((call) => call.op === "fillText").map((call) => call.args[0]);

test("mouse mode keeps the 18px scale buttons, shown only while hovering the price axis", () => {
  const view = makeView();
  const away = drawPriceScaleControls(makeContext(), view, { x: 100, y: 100, visible: true });
  assert.deepEqual(away, [], "a crosshair over the plot shows no buttons");

  const axisX = view.area.left + view.area.width;
  const hovering = drawPriceScaleControls(makeContext(), view, { x: axisX + 10, y: 200, visible: true });
  assert.equal(hovering.length, 2);
  assert.ok(hovering.every((rect) => rect.w === 18 && rect.h === 18));
});

test("touch mode always shows two finger-sized scale buttons stacked at the foot of the price axis", () => {
  const view = makeView();
  const ctx = makeContext();
  const controls = drawPriceScaleControls(ctx, view, { x: 0, y: 0, visible: false, touch: true });
  assert.deepEqual(controls.map((rect) => rect.id), ["autoScale", "logarithmic"]);
  assert.deepEqual(labels(ctx), ["O", "L"]);

  const [auto, log] = controls;
  const axisLeft = view.area.left + view.area.width;
  for (const rect of controls) {
    assert.ok(rect.w >= 32 && rect.h >= 32, `hit area ${rect.w}x${rect.h} fits a fingertip`);
    assert.ok(rect.x >= axisLeft && rect.x + rect.w <= axisLeft + view.priceAxisW, "inside the price axis column");
    assert.ok(rect.y + rect.h <= view.area.top + view.area.height + 1, "inside the main pane");
  }
  assert.ok(log.y > auto.y, "the log button sits under the auto-scale button");
  assert.ok(auto.y + auto.h <= log.y + 1, "the two hit areas meet without overlapping");
});

test("touch mode leaves a pane too short for the buttons without any", () => {
  const view = makeView({ height: 100 });
  assert.deepEqual(drawPriceScaleControls(makeContext(), view, { x: 0, y: 0, visible: false, touch: true }), []);
});

test("the corner menu button sits top-right beside the HUD's first row and is a fingertip big", () => {
  const view = makeView();
  const rect = touchMenuButtonRect(view);
  assert.ok(rect);
  assert.equal(rect.w, TOUCH_MENU_BUTTON_SIZE);
  assert.ok(TOUCH_MENU_BUTTON_SIZE >= 36);
  assert.ok(rect.x + rect.w <= view.area.left + view.area.width, "inside the plot");
  assert.ok(view.area.left + view.area.width - (rect.x + rect.w) <= 16, "hugging the right edge");
  assert.ok(rect.y <= 8, "level with the HUD pill, which keeps clear of this column");
  assert.ok(TOUCH_MENU_BUTTON_RESERVE >= TOUCH_MENU_BUTTON_SIZE + 8, "the readout leaves the button and its edge offset free");
});

test("a plot too small for the corner button gets none", () => {
  assert.equal(touchMenuButtonRect(makeView({ width: 120, height: 300 })), null);
  assert.equal(touchMenuButtonRect(makeView({ width: 400, height: 100 })), null);
});

test("the menu button hit area reaches a few pixels past the drawn button", () => {
  const rect = { x: 100, y: 50, w: 36, h: 36 };
  assert.equal(pointInTouchControl(rect, 118, 68), true);
  assert.equal(pointInTouchControl(rect, 100 - TOUCH_CONTROL_HIT_SLOP, 50), true);
  assert.equal(pointInTouchControl(rect, 100 - TOUCH_CONTROL_HIT_SLOP - 1, 50), false);
  assert.equal(pointInTouchControl(rect, 136 + TOUCH_CONTROL_HIT_SLOP, 86 + TOUCH_CONTROL_HIT_SLOP), true);
  assert.equal(pointInTouchControl(rect, 136 + TOUCH_CONTROL_HIT_SLOP + 1, 86), false);
});

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
  };
}

test("the overlay draws and hit-tests the menu button only in touch mode, and not while the crosshair inspects", () => {
  const view = makeView();
  const ctx = makeContext();
  const overlay = new Overlay(ctx);
  const series = seriesWithOneBar();
  const layers = ["interaction-controls"];
  const button = touchMenuButtonRect(view);
  const center = { x: button.x + button.w / 2, y: button.y + button.h / 2 };

  overlay.renderInteraction(view, series, { x: 0, y: 0, visible: false }, [0, 1], layers);
  assert.equal(overlay.getMenuButtonAt(center.x, center.y), false, "no button with a mouse");
  assert.equal(overlay.getMenuButtonRect(), null);

  overlay.renderInteraction(view, series, { x: 0, y: 0, visible: false, touch: true }, [0, 1], layers);
  assert.equal(overlay.getMenuButtonAt(center.x, center.y), true);
  assert.equal(overlay.getMenuButtonAt(button.x - TOUCH_CONTROL_HIT_SLOP - 1, center.y), false);
  assert.deepEqual({ ...overlay.getMenuButtonRect() }, button);
  assert.equal(ctx.calls.filter((call) => call.op === "arc").length, 3, "three dots");

  overlay.renderInteraction(view, series, { x: 40, y: 40, visible: true, touch: true }, [0, 1], layers);
  assert.equal(overlay.getMenuButtonAt(center.x, center.y), false, "the crosshair has the plot to itself");

  overlay.renderInteraction(view, series, { x: 0, y: 0, visible: false, touch: true }, [0, 1], layers);
  assert.equal(overlay.getMenuButtonAt(center.x, center.y), true);
  overlay.renderInteraction(view, series, { x: 0, y: 0, visible: false }, [0, 1], layers);
  assert.equal(overlay.getMenuButtonAt(center.x, center.y), false, "leaving touch mode takes the button away");
});

test("touch mode also gives the overlay's price-scale hit areas to taps on the axis", () => {
  const view = makeView();
  const overlay = new Overlay(makeContext());
  overlay.renderInteraction(view, seriesWithOneBar(), { x: 0, y: 0, visible: false, touch: true }, [0, 1], ["interaction-controls"]);
  const axisLeft = view.area.left + view.area.width;
  const x = axisLeft + view.priceAxisW / 2;
  const bottom = view.area.top + view.area.height;
  assert.equal(overlay.getPriceScaleControlAt(x, bottom - 4 - 16), "logarithmic");
  assert.equal(overlay.getPriceScaleControlAt(x, bottom - 4 - 32 - 6 - 16), "autoScale");
  assert.equal(overlay.getPriceScaleControlAt(x, view.area.top + 20), null);
});
