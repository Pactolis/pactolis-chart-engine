import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { alignLabelCenter, axisLayoutForChartView, axisLayoutForView } from "../dist/core/model/axisLayout.js";
import { DEFAULT_CHART_LAYOUT_OPTIONS } from "../dist/core/model/chartLayoutOptions.js";

function makeView() {
  const view = new View();
  view.area = { left: 0, top: 24, width: 900, height: 500 };
  view.subPanesH = 0;
  view.priceAxisW = DEFAULT_CHART_LAYOUT_OPTIONS.priceAxisWidth;
  return view;
}

test("axis layout keeps time axis and right price-axis corner separate", () => {
  const view = makeView();
  const layout = axisLayoutForView(view, 962, 560);

  assert.equal(layout.timeAxisRect.left, view.area.left);
  assert.equal(layout.timeAxisRect.width, view.area.width);
  assert.equal(layout.cornerRect.left, view.area.left + view.area.width);
  assert.equal(layout.cornerRect.width, view.priceAxisW);
  assert.equal(layout.timeAxisRect.top, layout.cornerRect.top);
  assert.equal(layout.timeAxisRect.left + layout.timeAxisRect.width, layout.cornerRect.left);
});

test("time-axis labels align inside the plot time-axis rect instead of leaking into the corner", () => {
  const view = makeView();
  const layout = axisLayoutForView(view, 962, 560);
  const labelWidth = 40;
  const labelX = alignLabelCenter(layout.timeAxisRect.left + layout.timeAxisRect.width + 18, labelWidth, layout.timeAxisRect);

  assert.ok(labelX + labelWidth / 2 <= layout.cornerRect.left);
});

test("chart-view axis layout matches the canvas-size layout without reading the canvas", () => {
  const view = makeView();
  view.subPanesH = 80;
  const { priceAxisWidth, timeAxisHeight } = view.chartLayoutOptions;
  const canvasWidth = view.area.left + view.area.width + priceAxisWidth;
  const canvasHeight = view.area.top + view.area.height + view.subPanesH + timeAxisHeight;

  assert.deepEqual(axisLayoutForChartView(view), axisLayoutForView(view, canvasWidth, canvasHeight));
  assert.equal(axisLayoutForChartView(view).timeAxisRect.height, timeAxisHeight);
});
