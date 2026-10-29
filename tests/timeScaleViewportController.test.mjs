import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { TimeScaleViewportController } from "../dist/features/controllers/timeScaleViewportController.js";
import { makeDataUpdateEvent } from "../dist/core/dataUpdateEvent.js";

function makeView(options = {}) {
  const view = new View({
    barSpacing: 20,
    latestBarRightPaddingBars: 2,
    shiftVisibleRangeOnNewBar: true,
    ...options,
  });
  view.area = { left: 0, top: 0, width: 500, height: 300 };
  return view;
}

function latestX(view, total) {
  return view.xOfIndex(total - 1);
}

function snapshot(length, lastBarStart = length > 0 ? (length - 1) * 60_000 : null) {
  return { length, lastBarStart };
}

function dataEvent(kind, previousLength, nextLength, source = "live") {
  return makeDataUpdateEvent(kind, source, snapshot(previousLength), snapshot(nextLength));
}

test("viewport controller places latest after explicit data reset", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);

  assert.equal(viewport.placeLatestAfterDataReset(10), true);

  assert.equal(viewport.followsLatest(), true);
  assert.equal(viewport.state().lastDataLength, 10);
  assert.equal(latestX(view, 10), 500 - 2 * 20);
});

test("viewport controller places latest on history-loaded event", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);

  assert.equal(viewport.applyDataUpdate(dataEvent("history-loaded", 0, 10, "history")), true);

  assert.equal(viewport.followsLatest(), true);
  assert.equal(viewport.state().lastDataLength, 10);
  assert.equal(latestX(view, 10), 500 - 2 * 20);
});

test("viewport controller does not move on same-bar data updates", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  const before = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("same-bar-update", 10, 10)), false);

  assert.equal(view.offsetX, before);
  assert.equal(viewport.followsLatest(), true);
});

test("viewport controller shifts on new bar only while following visible latest", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  const before = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("new-bar-appended", 10, 11)), true);

  assert.notEqual(view.offsetX, before);
  assert.equal(latestX(view, 11), 500 - 2 * 20);
});

test("viewport controller does not shift on new bar when previous latest is off screen", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  view.offsetX -= 1000;
  const before = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("new-bar-appended", 10, 11)), false);

  assert.equal(view.offsetX, before);
  assert.equal(viewport.followsLatest(), true);
  assert.equal(viewport.state().lastDataLength, 11);
});

test("viewport controller preserves user-controlled viewport on live updates", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  view.offsetX += 75;
  viewport.markUserViewportChange(10);
  const before = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("new-bar-appended", 10, 11)), false);

  assert.equal(view.offsetX, before);
  assert.equal(viewport.followsLatest(), false);
  assert.equal(viewport.state().lastDataLength, 11);
});

test("viewport controller respects shiftVisibleRangeOnNewBar option", () => {
  const view = makeView({ shiftVisibleRangeOnNewBar: false });
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  const before = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("new-bar-appended", 10, 11)), false);

  assert.equal(view.offsetX, before);
  assert.equal(viewport.followsLatest(), true);
});

test("viewport controller does not move on history patches or metadata updates", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  const before = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("history-patched", 10, 10, "history")), true);
  assert.equal(viewport.applyDataUpdate(dataEvent("metadata-updated", 10, 10, "metadata")), false);

  assert.equal(view.offsetX, before);
  assert.equal(viewport.state().lastDataLength, 10);
});

test("viewport controller restores the same canvas time anchor after older bars are inserted", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(30);
  view.offsetX += 75;
  viewport.markUserViewportChange(30);
  const anchorX = view.xOfIndex(10);
  const spacing = view.colWidth;

  assert.equal(viewport.restoreTimeAnchor(anchorX, 13), true);
  assert.ok(Math.abs(view.xOfIndex(13) - anchorX) < 1e-9);
  assert.equal(view.colWidth, spacing);
  assert.equal(viewport.followsLatest(), false);
});

test("viewport controller applies resize only for latest-owned viewport", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  view.area = { ...view.area, width: 640 };

  assert.equal(viewport.applyResize(10), true);
  assert.equal(latestX(view, 10), 640 - 2 * 20);

  view.offsetX += 50;
  viewport.markUserViewportChange(10);
  const before = view.offsetX;
  view.area = { ...view.area, width: 720 };

  assert.equal(viewport.applyResize(10), false);
  assert.equal(view.offsetX, before);
});

test("viewport resize re-applies the 4000-bar floor while preserving visible latest ownership", () => {
  const view = makeView({ barSpacing: 0.05 });
  view.area = { ...view.area, width: 900 };
  const viewport = new TimeScaleViewportController(view);
  viewport.applyWheelZoom(0.001, 450, 5000);
  assert.equal(view.colWidth, 900 / 4000);

  view.area = { ...view.area, width: 1800 };
  assert.equal(viewport.applyResize(5000), true);
  assert.equal(view.colWidth, 1800 / 4000);
  assert.equal(viewport.followsLatest(), true);
});

test("replay prefix placement preserves zoom and keeps its last bar visible", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(80);
  view.zoomX(1.7, 250);
  const spacing = view.colWidth;

  assert.equal(viewport.placeReplayPrefixEnd(4), true);

  assert.equal(view.colWidth, spacing);
  assert.equal(viewport.followsLatest(), true);
  assert.equal(viewport.state().lastDataLength, 4);
  assert.equal(latestX(view, 4), 500 - 2 * spacing);
});

test("viewport controller can focus a range end without entering live-follow", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);

  assert.equal(viewport.placeFocusedRangeEnd(12), true);

  assert.equal(viewport.followsLatest(), false);
  assert.equal(latestX(view, 12), 500 - 2 * 20);
});

test("viewport controller owns wheel pan and marks viewport user-controlled", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(50);
  const before = view.offsetX;

  assert.equal(viewport.applyWheelPan(60, 50), true);

  assert.equal(view.offsetX, before - 60);
  assert.equal(viewport.followsLatest(), false);
  assert.equal(viewport.state().lastDataLength, 50);
});

test("viewport controller owns wheel zoom and preserves the anchor logical index", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(50);
  const anchorX = 250;
  const beforeIndex = view.indexOfX(anchorX);

  assert.equal(viewport.applyWheelZoom(1.2, anchorX, 50), true);

  assert.equal(viewport.followsLatest(), false);
  assert.ok(Math.abs(view.indexOfX(anchorX) - beforeIndex) < 1e-9);
});

test("viewport controller zoom does not re-acquire live-follow on a user-owned historical viewport", () => {
  // Regression for TASK-425: a user who panned into history (follow=false) and then
  // zoomed must not have live-follow silently re-acquired just because the latest bar
  // happens to fall back into view. Re-acquiring it re-armed the 20s OHLC re-assert
  // timer into a right-edge snap on the next history-patched update.
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(500);

  // Pan into history: push the latest bar's x well past the right edge of the plot.
  view.offsetX += 1000;
  viewport.markUserViewportChange(500);
  assert.equal(viewport.followsLatest(), false);
  assert.ok(latestX(view, 500) > view.area.left + view.area.width);

  // Zoom out around a mid-plot anchor. This brings the latest bar's x back inside
  // the visible area even though the viewport is still user-owned.
  assert.equal(viewport.applyWheelZoom(0.15, 250, 500), true);
  assert.ok(latestX(view, 500) >= view.area.left && latestX(view, 500) <= view.area.left + view.area.width);
  assert.equal(viewport.followsLatest(), false);

  // A subsequent history-patched update (e.g. the daily-bar OHLC re-assert timer)
  // must not snap the viewport, since follow is still off.
  const before = view.offsetX;
  assert.equal(viewport.applyDataUpdate(dataEvent("history-patched", 500, 500, "history")), false);
  assert.equal(view.offsetX, before);
});

test("viewport controller zoom keeps or drops live-follow while it is already active", () => {
  // Preserved behavior: the pre-existing wheel-zoom convention (zooming while the
  // latest bar is visible keeps live-follow on; zooming it out of view drops it)
  // must still hold when follow starts out true.
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(50);
  const latestBefore = latestX(view, 50);

  // Zoom anchored exactly on the latest bar keeps it in view — follow stays true.
  assert.equal(viewport.applyWheelZoom(2.5, latestBefore, 50), true);
  assert.equal(viewport.followsLatest(), true);
  assert.ok(Math.abs(latestX(view, 50) - latestBefore) < 1e-9);

  // Zooming again so the latest bar is pushed out of the visible area drops follow.
  assert.equal(viewport.applyWheelZoom(1.2, 250, 50), true);
  assert.equal(viewport.followsLatest(), false);
  assert.ok(latestX(view, 50) > view.area.left + view.area.width);
});

test("viewport controller owns plot pan gesture snapshots", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(50);
  const before = view.offsetX;

  viewport.beginPlotPan();
  assert.equal(viewport.dragPlotPanTo(90, 50), true);
  viewport.endPlotPan();

  assert.equal(view.offsetX, before + 90);
  assert.equal(viewport.followsLatest(), false);
});

test("viewport controller owns time-axis scale gesture snapshots", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(50);
  const rightEdgeIndex = view.indexOfX(view.area.left + view.area.width);
  const previousPriceTop = view.priceTop;
  const previousPricePerPx = view.pricePerPx;

  viewport.beginTimeAxisScale(250);
  assert.equal(viewport.dragTimeAxisScaleTo(330, 50), true);
  viewport.endTimeAxisScale();

  assert.ok(view.colWidth < 20);
  assert.equal(view.priceTop, previousPriceTop);
  assert.equal(view.pricePerPx, previousPricePerPx);
  assert.equal(viewport.followsLatest(), true);
  assert.ok(Math.abs(view.indexOfX(view.area.left + view.area.width) - rightEdgeIndex) < 1e-9);
});

test("viewport controller defers initial latest placement until geometry is available", () => {
  const view = makeView();
  view.area = { left: 0, top: 0, width: 1, height: 300 };
  const viewport = new TimeScaleViewportController(view);

  assert.equal(viewport.placeLatestAfterDataReset(100), false);
  assert.equal(view.offsetX, 0);

  view.area = { ...view.area, width: 500 };
  assert.equal(viewport.ensurePendingLatestPlacement(100), true);
  assert.equal(latestX(view, 100), 500 - 2 * 20);
  assert.equal(viewport.ensurePendingLatestPlacement(100), false);
});


test("user-owned viewport cancels deferred initial latest placement", () => {
  const view = makeView();
  view.area = { left: 0, top: 0, width: 1, height: 300 };
  const viewport = new TimeScaleViewportController(view);

  viewport.placeLatestAfterDataReset(100);
  viewport.markUserViewportChange(100);
  const before = view.offsetX;

  view.area = { ...view.area, width: 500 };
  assert.equal(viewport.ensurePendingLatestPlacement(100), false);
  assert.equal(view.offsetX, before);
  assert.equal(viewport.followsLatest(), false);
});
test("live-follow timeframe changes preserve useful bar spacing", () => {
  const view = makeView();
  view.colWidth = 84;
  const viewport = new TimeScaleViewportController(view);

  viewport.rescaleForIntervalChange(60_000, 4 * 60 * 60_000);

  assert.equal(view.colWidth, 84, "live-follow must not expand to the 400 px ceiling");
});

// Startup/reset fit uses usable CSS plot width, not canvas/DPI or axis width.
function makeDefaultFitView(width = 997) {
  const view = new View({
    latestBarRightPaddingBars: 2,
    resetRightPaddingBars: 3,
  });
  view.area = { left: 37, top: 0, width, height: 300 };
  return view;
}

function assertNear(actual, expected, label) {
  assert.ok(Number.isFinite(actual), `${label} must be finite, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`);
}

function assert250ColumnFit(view, total, padding) {
  const count = Math.min(total, 250);
  // xOfIndex is the column LEFT edge: there are N-1 gaps to latest,
  // then padding gaps to the plot right edge (including latest's full column).
  const spacing = view.area.width / (count + padding - 1);
  assert.ok(spacing > 0.05 && spacing < 400 && spacing > view.area.width / 4000,
    "fixture must not invoke absolute clamps or the 4000-bar floor");
  assertNear(view.colWidth, spacing, "250-column CSS spacing");
  assertNear(view.xOfIndex(total - count), view.area.left, "first full column left edge");
  assertNear(latestX(view, total),
    view.area.left + view.area.width - padding * spacing, "latest column left edge");
  assertNear(latestX(view, total) + view.colWidth,
    view.area.left + view.area.width - (padding - 1) * spacing, "latest full column right edge");
}

test("initial history of 500 bars fits 250 full columns in CSS plot width", () => {
  const view = makeDefaultFitView();
  const viewport = new TimeScaleViewportController(view);
  const spacingBeforeData = view.colWidth;
  const offsetBeforeData = view.offsetX;

  assert.equal(viewport.applyResize(0, "width-before-history"), false);
  assert.equal(viewport.ensurePendingLatestPlacement(0), false);
  assert.equal(viewport.state().lastDataLength, 0);
  assert.equal(view.colWidth, spacingBeforeData);
  assert.equal(view.offsetX, offsetBeforeData);

  assert.equal(viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history")), true);
  assert.equal(viewport.state().lastDataLength, 500);
  assert.equal(viewport.followsLatest(), true);
  assert.notEqual(view.offsetX, offsetBeforeData);
  assert250ColumnFit(view, 500, 2);
});

test("live seed does not consume initial fit before 500 history bars", () => {
  const view = makeDefaultFitView();
  const viewport = new TimeScaleViewportController(view);

  assert.equal(viewport.applyDataUpdate(dataEvent("new-bar-appended", 0, 1, "live")), true);
  assert.equal(viewport.state().lastDataLength, 1);
  // Do not prescribe a one-bar seed fit; only observe its actual latest placement.
  assertNear(latestX(view, 1),
    view.area.left + view.area.width - 2 * view.colWidth, "live seed latest placement");
  const seedOffset = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("history-loaded", 1, 500, "history")), true);
  assert.equal(viewport.state().lastDataLength, 500);
  assert.notEqual(view.offsetX, seedOffset);
  assert250ColumnFit(view, 500, 2);
});

test("uninteracted history growth from 8 to 500 bars reaches 250-column fit", () => {
  const view = makeDefaultFitView(333);
  const viewport = new TimeScaleViewportController(view);

  assert.equal(viewport.applyDataUpdate(dataEvent("history-loaded", 0, 8, "history")), true);
  assert.equal(viewport.state().lastDataLength, 8);
  assertNear(latestX(view, 8),
    view.area.left + view.area.width - 2 * view.colWidth, "first history chunk placement");
  const chunkOffset = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("history-patched", 8, 500, "history")), true);
  assert.equal(viewport.state().lastDataLength, 500);
  assert.notEqual(view.offsetX, chunkOffset);
  assert250ColumnFit(view, 500, 2);
});

test("hidden initial history fit waits for valid plot geometry", () => {
  const view = makeDefaultFitView(1);
  const viewport = new TimeScaleViewportController(view);
  const spacingBeforeHistory = view.colWidth;

  assert.equal(viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history")), false);
  assert.equal(viewport.state().lastDataLength, 500);
  assert.equal(view.colWidth, spacingBeforeHistory);
  assert.equal(view.offsetX, 0);
  assert.equal(viewport.ensurePendingLatestPlacement(500), false);

  view.area = { ...view.area, width: 997 };
  assert.equal(viewport.ensurePendingLatestPlacement(500), true);
  assert.equal(viewport.state().lastDataLength, 500);
  assert.equal(viewport.ensurePendingLatestPlacement(500), false);
  assert250ColumnFit(view, 500, 2);
});

test("explicit reset fits 250 columns with reset padding", () => {
  const view = makeDefaultFitView();
  const viewport = new TimeScaleViewportController(view);
  view.colWidth = 9;
  viewport.markUserViewportChange(500);

  assert.equal(viewport.resetToDefault(500), true);
  assert.equal(viewport.state().lastDataLength, 500);
  assert.equal(viewport.followsLatest(), true);
  assert250ColumnFit(view, 500, 3);
});

test("a host that lowers the default fit gets its column count on the initial fit and on reset", () => {
  const view = new View({ defaultFitColumns: 70, latestBarRightPaddingBars: 2, resetRightPaddingBars: 3 });
  view.area = { left: 0, top: 0, width: 333, height: 300 };
  const viewport = new TimeScaleViewportController(view);

  // 100 bars is far short of the desktop 250 but past the 70 this host wants, so the initial fit runs on load.
  assert.equal(viewport.applyDataUpdate(dataEvent("history-loaded", 0, 100, "history")), true);
  assertNear(view.colWidth, 333 / (70 + 2 - 1), "70-column initial spacing");
  assertNear(latestX(view, 100), 333 - 2 * view.colWidth, "latest column placement");

  view.colWidth = 9;
  viewport.markUserViewportChange(100);
  assert.equal(viewport.resetToDefault(100), true);
  assertNear(view.colWidth, 333 / (70 + 3 - 1), "70-column spacing after a reset");

  // A history shorter than the host's count fits whole, as it does on desktop.
  const short = new View({ defaultFitColumns: 70, resetRightPaddingBars: 3 });
  short.area = { left: 0, top: 0, width: 333, height: 300 };
  assert.equal(new TimeScaleViewportController(short).resetToDefault(40), true);
  assertNear(short.colWidth, 333 / (40 + 3 - 1), "a 40-bar history fits all 40");
});

test("deferred explicit reset retains reset padding when geometry arrives", () => {
  const view = makeDefaultFitView(0);
  const viewport = new TimeScaleViewportController(view);

  viewport.resetToDefault(500);
  assert.equal(viewport.state().lastDataLength, 500);
  assert.ok(Number.isFinite(view.colWidth) && Number.isFinite(view.offsetX));
  assert.equal(viewport.ensurePendingLatestPlacement(500), false);
  view.area = { ...view.area, width: 1 };
  assert.equal(viewport.ensurePendingLatestPlacement(500), false);

  view.area = { ...view.area, width: 333 };
  assert.equal(viewport.ensurePendingLatestPlacement(500), true);
  assert.equal(viewport.ensurePendingLatestPlacement(500), false);
  assert250ColumnFit(view, 500, 3);
});

test("ordinary resize preserves chosen spacing for latest and user-owned viewports", () => {
  const view = makeDefaultFitView();
  const viewport = new TimeScaleViewportController(view);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
  assert.equal(viewport.applyWheelZoom(7 / view.colWidth, latestX(view, 500), 500), true);
  viewport.goLatest(500);
  assertNear(view.colWidth, 7, "chosen latest-follow spacing");

  const beforeResize = view.offsetX;
  view.area = { ...view.area, width: 333 };
  assert.equal(viewport.applyResize(500, "ordinary-latest-resize"), true);
  assert.notEqual(view.offsetX, beforeResize);
  assertNear(view.colWidth, 7, "latest-follow resize spacing");
  assertNear(latestX(view, 500), 37 + 333 - 2 * 7, "resized latest placement");

  assert.equal(viewport.applyWheelZoom(9 / view.colWidth, 37 + 333 / 2, 500), true);
  viewport.markUserViewportChange(500);
  assertNear(view.colWidth, 9, "chosen user-owned spacing");
  const userOffset = view.offsetX;
  view.area = { ...view.area, width: 997 };
  assert.equal(viewport.applyResize(500, "ordinary-user-resize"), false);
  assertNear(view.colWidth, 9, "user-owned resize spacing");
  assert.equal(view.offsetX, userOffset);
  assert.equal(viewport.state().lastDataLength, 500);
});

test("user zoom survives later history, live, latest navigation and replay", () => {
  const view = makeDefaultFitView(333);
  const viewport = new TimeScaleViewportController(view);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
  const beforeZoom = view.colWidth;
  assert.equal(viewport.applyWheelZoom(7 / beforeZoom, latestX(view, 500), 500), true);
  assert.notEqual(view.colWidth, beforeZoom);
  viewport.markUserViewportChange(500);
  const userOffset = view.offsetX;

  assert.equal(viewport.applyDataUpdate(dataEvent("history-patched", 500, 750, "history")), false);
  assert.equal(viewport.state().lastDataLength, 750);
  assert.equal(view.offsetX, userOffset);
  assertNear(view.colWidth, 7, "history prepend preserves user zoom");

  viewport.applyDataUpdate(dataEvent("history-loaded", 750, 900, "history"));
  assert.equal(viewport.state().lastDataLength, 900);
  assertNear(view.colWidth, 7, "additional history load preserves user zoom");
  viewport.applyDataUpdate(dataEvent("new-bar-appended", 900, 901, "live"));
  assert.equal(viewport.state().lastDataLength, 901);
  assertNear(view.colWidth, 7, "live append preserves user zoom");

  assert.equal(viewport.goLatest(901), true);
  assertNear(view.colWidth, 7, "goLatest preserves user zoom");
  assertNear(latestX(view, 901), 37 + 333 - 2 * 7, "goLatest placement");
  assert.equal(viewport.placeReplayPrefixEnd(100), true);
  assert.equal(viewport.state().lastDataLength, 100);
  assertNear(view.colWidth, 7, "replay prefix preserves user zoom");
  assertNear(latestX(view, 100), 37 + 333 - 2 * 7, "replay prefix placement");
});

 // Real runtime order: ChartRuntime.onResize/layout-change applies layout, calls
 // applyResize, and only its renderer then calls ensurePendingLatestPlacement.
test("runtime resize before render preserves hidden initial 250 fit", () => {
  const view = makeDefaultFitView(1);
  const viewport = new TimeScaleViewportController(view);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
  view.area = { ...view.area, width: 997 };
  viewport.applyResize(500, "resize-observer");
  viewport.ensurePendingLatestPlacement(500);
  assert250ColumnFit(view, 500, 2);
});

test("history settle wrapper must not overwrite hidden initial fit", () => {
  const view = makeDefaultFitView(1);
  const viewport = new TimeScaleViewportController(view);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
  // ChartHistoryController.loadHistory: after await/settle guard, these calls
  // run in this order even if history-loaded already requested a deferred fit.
  viewport.placeLatestAfterDataReset(500);
  viewport.completeInitialHistoryFit(500);
  view.area = { ...view.area, width: 997 };
  viewport.ensurePendingLatestPlacement(500);
  assert250ColumnFit(view, 500, 2);
});

test("hidden history patches preserve pending initial fit through runtime resize", () => {
  const view = makeDefaultFitView(1);
  const viewport = new TimeScaleViewportController(view);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
  viewport.applyDataUpdate(dataEvent("history-patched", 500, 750, "history"));
  view.area = { ...view.area, width: 997 };
  viewport.applyResize(750, "resize-observer");
  viewport.ensurePendingLatestPlacement(750);
  assert250ColumnFit(view, 750, 2);
});

test("hidden live append preserves a pending initial fit", () => {
  const view = makeDefaultFitView(1);
  const viewport = new TimeScaleViewportController(view);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
  // The real pipeline snapshots the current series before a contiguous append.
  viewport.applyDataUpdate(dataEvent("new-bar-appended", 500, 501, "live"));
  view.area = { ...view.area, width: 997 };
  viewport.ensurePendingLatestPlacement(501);
  assert250ColumnFit(view, 501, 2);
});

test("runtime resize before render retains deferred explicit reset padding", () => {
  const view = makeDefaultFitView(1);
  const viewport = new TimeScaleViewportController(view);
  viewport.resetToDefault(500);
  view.area = { ...view.area, width: 333 };
  viewport.applyResize(500, "resize-observer");
  viewport.ensurePendingLatestPlacement(500);
  assert250ColumnFit(view, 500, 3);
});

test("explicit reset without data does not suppress first history fit", () => {
  const view = makeDefaultFitView(997);
  const viewport = new TimeScaleViewportController(view);
  viewport.resetToDefault(0);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
  viewport.completeInitialHistoryFit(500);
  assert250ColumnFit(view, 500, 2);
});

test("real settled short history fits 73 columns once without consuming empty readiness", () => {
  const view = makeDefaultFitView();
  const viewport = new TimeScaleViewportController(view);
  const initialSpacing = view.colWidth;
  assert.equal(viewport.completeInitialHistoryFit(0), false);
  viewport.applyDataUpdate(dataEvent("new-bar-appended", 0, 1, "live"));
  assert.equal(view.colWidth, initialSpacing);
  viewport.applyDataUpdate(dataEvent("history-loaded", 1, 73, "history"));
  assert.equal(view.colWidth, initialSpacing, "unsettled short chunk is not final readiness");
  viewport.placeLatestAfterDataReset(73);
  assert.equal(viewport.completeInitialHistoryFit(73), true);
  assert250ColumnFit(view, 73, 2);
  assert.equal(viewport.completeInitialHistoryFit(73), false);
});

test("hidden settled short history survives wrapper repeats and runtime resize", () => {
  const view = makeDefaultFitView(1);
  const viewport = new TimeScaleViewportController(view);
  viewport.applyDataUpdate(dataEvent("history-loaded", 0, 73, "history"));
  viewport.placeLatestAfterDataReset(73);
  viewport.completeInitialHistoryFit(73);
  viewport.placeLatestAfterDataReset(73);
  view.area = { ...view.area, width: 997 };
  viewport.applyResize(73, "layout-change");
  viewport.ensurePendingLatestPlacement(73);
  assert250ColumnFit(view, 73, 2);
});

for (const gesture of ["zoom", "pan"]) {
  test("user " + gesture + " before history settlement cancels automatic fit", () => {
    const view = makeDefaultFitView();
    const viewport = new TimeScaleViewportController(view);
    viewport.applyDataUpdate(dataEvent("history-loaded", 0, 73, "history"));
    if (gesture === "zoom") {
      viewport.applyWheelZoom(7 / view.colWidth, latestX(view, 73), 73);
      assert.equal(viewport.followsLatest(), true, "zoom fixture retains latest ownership");
    } else {
      viewport.applyWheelPan(60, 73);
      assert.equal(viewport.followsLatest(), false);
    }
    const spacing = view.colWidth;
    assert.equal(viewport.completeInitialHistoryFit(73), false);
    assert.equal(view.colWidth, spacing);
    viewport.goLatest(73);
    viewport.placeReplayPrefixEnd(20);
    assert.equal(view.colWidth, spacing, "navigation and replay preserve chosen zoom");
  });
}

for (const fixture of [
  { width: 997, options: { minBarSpacing: 8 }, expected: 8 },
  { width: 997, options: { maxBarSpacing: 2 }, expected: 2 },
  { width: 997, options: { resetRightPaddingBars: 5000 }, expected: 997 / 4000 },
]) {
  test("reset fit respects legitimate bounds " + JSON.stringify(fixture.options), () => {
    const view = new View(fixture.options);
    view.area = { left: 37, top: 0, width: fixture.width, height: 300 };
    const viewport = new TimeScaleViewportController(view);
    viewport.resetToDefault(500);
    assertNear(view.colWidth, fixture.expected, "bounded spacing, not unconditional 250 oracle");
    assertNear(latestX(view, 500),
      view.area.left + view.area.width - view.timeScaleOptions.resetRightPaddingBars * fixture.expected,
      "bounded placement uses normalized reset padding");
  });
}

for (const padding of [0, 1]) {
  test("normalized padding " + padding + " retains column-left placement semantics", () => {
    const view = new View({ resetRightPaddingBars: padding });
    view.area = { left: 37, top: 0, width: 997, height: 300 };
    assert.equal(view.timeScaleOptions.resetRightPaddingBars, padding);
    view.resetTimeScale(500);
    const spacing = 997 / (250 + padding - 1);
    assertNear(view.colWidth, spacing, "supported normalized padding fit");
    assertNear(latestX(view, 500), 37 + 997 - padding * spacing, "latest column left edge");
    assertNear(latestX(view, 500) + spacing, 37 + 997 + (1 - padding) * spacing,
      "padding zero puts latest left edge at plot right, not a full visible column");
  });
}

// Deferred fits are one-shot even when ordinary resize precedes later history.
for (const completion of ["history-patched", "history-settled"]) {
  test("completed hidden initial fit stays consumed after resize and " + completion, () => {
    const view = makeDefaultFitView(1);
    const viewport = new TimeScaleViewportController(view);
    viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
    view.area = { ...view.area, width: 997 };
    viewport.applyResize(500, "resize-observer");
    assert.equal(viewport.ensurePendingLatestPlacement(500), true);
    assert250ColumnFit(view, 500, 2);
    const fittedSpacing = view.colWidth;
    view.area = { ...view.area, width: 333 };
    viewport.applyResize(500, "ordinary-resize");
    assertNear(view.colWidth, fittedSpacing, "ordinary resize preserves completed fit spacing");
    if (completion === "history-patched") {
      viewport.applyDataUpdate(dataEvent("history-patched", 500, 750, "history"));
    } else {
      viewport.completeInitialHistoryFit(750);
    }
    assertNear(view.colWidth, fittedSpacing, "later history must not repeat the consumed initial fit");
  });
}

for (const navigation of ["goLatest", "placeReplayPrefixEnd"]) {
  test("hidden " + navigation + " supersedes a deferred fit without changing spacing", () => {
    const view = makeDefaultFitView(1);
    view.colWidth = 7;
    const viewport = new TimeScaleViewportController(view);
    if (navigation === "goLatest") {
      viewport.applyDataUpdate(dataEvent("history-loaded", 0, 500, "history"));
    } else {
      viewport.resetToDefault(500);
    }
    assertNear(view.colWidth, 7, "hidden fit has not changed spacing");
    const total = navigation === "goLatest" ? 500 : 20;
    viewport[navigation](total);
    view.area = { ...view.area, width: 997 };
    viewport.applyResize(total, "resize-observer");
    assert.equal(viewport.ensurePendingLatestPlacement(total), true);
    assertNear(view.colWidth, 7, "explicit navigation preserves existing spacing after deferred render");
    assertNear(latestX(view, total), 37 + 997 - 2 * 7, "navigation uses latest padding");
  });
}

test("zoom-out while following keeps the user's right gap on later live placements", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(10);
  // Zoom out around a mid-plot anchor: the latest bar moves left, leaving a gap on the right.
  assert.equal(viewport.applyWheelZoom(0.5, 250, 10), true);
  assert.equal(viewport.followsLatest(), true);
  const gapBars = (500 - latestX(view, 10)) / view.colWidth;
  assert.ok(gapBars > 2, `expected a widened right gap, got ${gapBars}`);

  // The 20s OHLC maintenance patch must not snap the latest bar back to the right edge.
  const beforePatch = view.offsetX;
  viewport.applyDataUpdate(dataEvent("history-patched", 10, 10, "history"));
  assert.equal(view.offsetX, beforePatch);

  // A new bar shifts the range by exactly one bar, keeping the gap (LWC rightOffset).
  viewport.applyDataUpdate(dataEvent("new-bar-appended", 10, 11));
  assert.ok(Math.abs((500 - latestX(view, 11)) / view.colWidth - gapBars) < 1e-9);
  assert.ok(Math.abs(view.offsetX - (beforePatch - view.colWidth)) < 1e-9);

  // Explicit latest navigation restores the default padding.
  viewport.goLatest(11);
  assert.equal(latestX(view, 11), 500 - 2 * view.colWidth);
});

test("pan and zoom commits bump the user viewport revision", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(50);
  const start = viewport.userViewportRevision();

  viewport.applyDataUpdate(dataEvent("history-patched", 50, 50, "history"));
  assert.equal(viewport.userViewportRevision(), start, "data updates are not user moves");

  viewport.applyWheelZoom(0.8, 250, 50);
  const afterZoom = viewport.userViewportRevision();
  assert.notEqual(afterZoom, start);

  viewport.applyWheelPan(30, 50);
  assert.notEqual(viewport.userViewportRevision(), afterZoom);
});

test("keeping the viewport after a load leaves a panned historical view in place", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(500);
  viewport.applyWheelPan(-400, 500);
  assert.equal(viewport.followsLatest(), false);
  const before = view.offsetX;

  assert.equal(viewport.keepViewportAfterHistoryLoad(500), false);

  assert.equal(view.offsetX, before);
  assert.equal(viewport.followsLatest(), false);
});

test("keeping the viewport after a load keeps the right offset a zoom-out left", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(50);
  viewport.applyWheelZoom(0.5, 250, 50);
  assert.equal(viewport.followsLatest(), true);
  const gap = view.area.left + view.area.width - latestX(view, 50);
  assert.ok(gap > 2 * view.colWidth, "the zoom-out must have opened a wider right gap");

  // A new bar arrived during the load; the latest bar keeps the same gap.
  assert.equal(viewport.keepViewportAfterHistoryLoad(51), true);

  assert.equal(viewport.followsLatest(), true);
  assert.ok(Math.abs(view.area.left + view.area.width - latestX(view, 51) - gap) < 1e-9);
});

test("a preserved history-loaded event does not reset follow or the zoom right offset", () => {
  const view = makeView();
  const viewport = new TimeScaleViewportController(view);
  viewport.placeLatestAfterDataReset(500);
  viewport.applyWheelPan(-400, 500);
  const pannedOffset = view.offsetX;

  assert.equal(
    viewport.applyDataUpdate(dataEvent("history-loaded", 500, 500, "history"), { preserveViewport: true }),
    false,
  );
  assert.equal(view.offsetX, pannedOffset);
  assert.equal(viewport.followsLatest(), false);

  // Without the flag the same event is an explicit reset to the latest bar.
  assert.equal(viewport.applyDataUpdate(dataEvent("history-loaded", 500, 500, "history")), true);
  assert.equal(viewport.followsLatest(), true);
  assert.equal(latestX(view, 500), 500 - 2 * view.colWidth);
});
