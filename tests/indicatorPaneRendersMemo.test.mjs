import test from "node:test";
import assert from "node:assert/strict";
import { ChartIndicatorController } from "../dist/features/chart/ChartIndicatorController.js";
import { createIndicatorPaneHeadersModel } from "../dist/features/indicators/indicatorPaneHeaders.js";

function makeFakeHarness(initial = []) {
  const doc = {
    defaultView: globalThis,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  const root = {
    ownerDocument: doc,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ height: 600, width: 800, top: 0, left: 0, bottom: 600, right: 800 }),
  };
  const context = { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: 60_000 };
  const headers = createIndicatorPaneHeadersModel();
  const controller = new ChartIndicatorController({
    ownerDocument: doc,
    root,
    initial,
    onChange: () => {},
    onLayoutChange: () => {},
    onInvalidate: () => {},
    getChartContext: () => context,
    queuePriceLabel: () => {},
    headers,
  });
  return { controller, context, headers };
}

test("ChartIndicatorController.getPaneRenders() and requiresAnnotationInteractionRedraw() are memoized O(1)", () => {
  const rsiInstance = {
    id: "rsi-1",
    type: "rsi",
    title: "RSI",
    visible: true,
    order: 0,
    placement: "separate-pane",
    paneHeight: 100,
    collapsed: false,
    settings: {},
  };
  const { controller } = makeFakeHarness([rsiInstance]);

  // First call computes pane renders
  const renders1 = controller.getPaneRenders();
  assert.equal(renders1.length, 1);
  assert.equal(renders1[0].id, "rsi-1");

  // Subsequent calls return the exact same array reference
  const renders2 = controller.getPaneRenders();
  assert.equal(renders2, renders1);

  // requiresAnnotationInteractionRedraw returns cached boolean
  const redraw1 = controller.requiresAnnotationInteractionRedraw();
  const redraw2 = controller.requiresAnnotationInteractionRedraw();
  assert.equal(redraw1, redraw2);
  assert.equal(controller.getPaneRenders(), renders1);

  // Changing indicator visibility invalidates memoization
  controller.setVisible("rsi-1", false);
  const renders3 = controller.getPaneRenders();
  assert.notEqual(renders3, renders1);
  assert.equal(renders3.length, 0); // hidden instance not rendered in separate panes

  // Subsequent call is memoized again
  assert.equal(controller.getPaneRenders(), renders3);

  // Restoring indicators updates revision and invalidates cache
  controller.restore([rsiInstance]);
  const renders4 = controller.getPaneRenders();
  assert.notEqual(renders4, renders3);
  assert.equal(renders4.length, 1);
  assert.equal(controller.getPaneRenders(), renders4);

  // clearInteractionCache evicts memoized panes
  controller.clearInteractionCache();
  const renders5 = controller.getPaneRenders();
  assert.notEqual(renders5, renders4);
  assert.equal(renders5.length, 1);
  assert.equal(controller.getPaneRenders(), renders5);

  controller.dispose();
});
