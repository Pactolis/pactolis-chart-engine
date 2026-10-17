import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { DEFAULT_CHART_LAYOUT_OPTIONS } from "../dist/core/model/chartLayoutOptions.js";
import { drawPriceAxis, drawPriceMarkers, drawCrosshairPriceLabel } from "../dist/core/render/priceAxisRenderer.js";
import { settings } from "../dist/core/settings.js";
import { axisGridLineColor, uiColor } from "../dist/core/ui/seriesPalette.js";

function makeContext({ width = 862, height = 522 } = {}) {
  const calls = [];
  const ctx = {
    canvas: { clientWidth: width, clientHeight: height },
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    calls,
    fillRect(x, y, w, h) { calls.push({ op: "fillRect", x, y, w, h, fillStyle: this.fillStyle }); },
    strokeRect(x, y, w, h) { calls.push({ op: "strokeRect", x, y, w, h, strokeStyle: this.strokeStyle }); },
    beginPath() { calls.push({ op: "beginPath" }); },
    moveTo(x, y) { calls.push({ op: "moveTo", x, y }); },
    lineTo(x, y) { calls.push({ op: "lineTo", x, y }); },
    stroke() { calls.push({ op: "stroke", strokeStyle: this.strokeStyle }); },
    fillText(text, x, y) { calls.push({ op: "fillText", text, x, y, fillStyle: this.fillStyle, font: this.font }); },
    measureText(text) { return { width: String(text).length * 7 }; },
    save() { calls.push({ op: "save" }); },
    restore() { calls.push({ op: "restore" }); },
  };
  return ctx;
}

test("price axis normal tick labels are plain text while axis backgrounds remain filled", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 500 };
  view.priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;
  view.fitPriceRange(62100, 62300);

  const ctx = makeContext();
  drawPriceAxis(ctx, view, 0.1, 1);

  const fillRects = ctx.calls.filter((call) => call.op === "fillRect");
  const strokeRects = ctx.calls.filter((call) => call.op === "strokeRect");
  const tickTexts = ctx.calls.filter((call) => call.op === "fillText");

  assert.equal(fillRects.length, 2, "only price-axis and corner backgrounds should be filled");
  assert.equal(strokeRects.length, 0, "normal tick labels should not draw boxed backgrounds");
  assert.ok(tickTexts.length > 0, "plain text price labels should still be drawn");
  assert.ok(tickTexts.every((call) => call.font === "12px ui-monospace, monospace"));
});

test("price markers use readable text and label height", () => {
  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 500 };
  view.priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;
  view.fitPriceRange(62100, 62300);

  const ctx = makeContext();
  drawPriceMarkers(ctx, view, [{ price: 62200, color: "#00ff00", priority: 1 }], 0.1, 1);

  const markerRect = ctx.calls.find((call) => call.op === "fillRect");
  const markerText = ctx.calls.find((call) => call.op === "fillText");
  assert.equal(markerRect.h, 16);
  assert.equal(markerText.font, "11px ui-monospace, monospace");
});

for (const mode of ["linear", "log"]) {
  test("settings.grid hides only horizontal plot grid while preserving price-axis readouts in " + mode + " mode", () => {
    const hadGrid = Object.hasOwn(settings, "grid");
    const originalGrid = settings.grid;
    try {
      const view = new View();
      view.area = { left: 0, top: 0, width: 800, height: 500 };
      view.priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;
      if (mode === "log") view.setScaleMode("log");
      view.fitPriceRange(62100, 62300);
      const render = (grid) => {
        settings.grid = grid;
        const axis = makeContext();
        drawPriceAxis(axis, view, 0.1, 1);
        const crosshair = makeContext();
        drawCrosshairPriceLabel(crosshair, view,
          { config: { priceStep: 0.1, pricePrecision: 1 } }, { x: 400, y: 250 });
        const grids = [];
        const preserved = [];
        for (let i = 0; i < axis.calls.length; i++) {
          const path = axis.calls.slice(i, i + 4);
          if (path[0]?.op === "beginPath" && path[1]?.op === "moveTo" &&
              path[2]?.op === "lineTo" && path[3]?.op === "stroke" &&
              path[3].strokeStyle === axisGridLineColor &&
              path[1].y === path[2].y && path[1].x === view.area.left &&
              path[2].x === view.area.left + view.area.width) {
            grids.push(path);
            i += 3;
          } else {
            preserved.push(axis.calls[i]);
          }
        }
        return { grids, preserved, crosshair: crosshair.calls };
      };
      const enabled = render(true);
      const disabled = render(false);
      const labels = enabled.preserved.filter((call) => call.op === "fillText");
      assert.ok(enabled.grids.length > 0, "enabled grid must contain actual horizontal plot strokes");
      assert.ok(labels.length > 0, "price-axis labels must be non-vacuous");
      assert.ok(labels.every((call) => call.font === "12px ui-monospace, monospace"));
      assert.equal(enabled.preserved.filter((call) => call.op === "fillRect").length, 2,
        "price-axis and corner backgrounds must remain filled");
      assert.equal(enabled.preserved.filter((call) => call.op === "stroke" &&
        call.strokeStyle === uiColor.separator).length, 1, "axis separator must remain drawn");
      assert.deepEqual(disabled.preserved, enabled.preserved,
        "grid off must preserve separator path, backgrounds, label text, font and positions");
      assert.equal(enabled.crosshair.filter((call) => call.op === "fillText").length, 1,
        "crosshair price readout must be non-vacuous");
      assert.equal(enabled.crosshair.filter((call) => call.op === "strokeRect").length, 1,
        "crosshair readout border must remain drawn");
      assert.deepEqual(disabled.crosshair, enabled.crosshair,
        "grid off must preserve crosshair readout text, position, background and border");
      assert.equal(disabled.grids.length, 0,
        "settings.grid=false must suppress horizontal plot grid strokes");
    } finally {
      if (hadGrid) settings.grid = originalGrid;
      else delete settings.grid;
    }
  });
}
