import test from "node:test";
import assert from "node:assert/strict";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { HUD_ROW_HEIGHT } from "../dist/core/render/hudLayout.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { settings } from "../dist/core/settings.js";

function makeRecordedContext(width = 900, height = 522, ownerDocument = null, initialDpr = 1) {
  const calls = [];
  const stateStack = [];
  let transform = { a: initialDpr, b: 0, c: 0, d: initialDpr, e: 0, f: 0 };
  const canvas = {
    width,
    height,
    clientWidth: Math.round(width / initialDpr),
    clientHeight: Math.round(height / initialDpr),
    ownerDocument,
  };

  const ctx = {
    canvas,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    globalAlpha: 1,
    calls,
    saveCount: 0,
    restoreCount: 0,
    stackDepth: 0,
    minStackDepth: 0,
    maxStackDepth: 0,
    save() {
      stateStack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        font: this.font,
        textAlign: this.textAlign,
        textBaseline: this.textBaseline,
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
        transform: { ...transform },
      });
      this.saveCount++;
      this.stackDepth++;
      if (this.stackDepth > this.maxStackDepth) this.maxStackDepth = this.stackDepth;
      calls.push({ op: "save" });
    },
    restore() {
      const prev = stateStack.pop();
      if (prev) {
        this.fillStyle = prev.fillStyle;
        this.strokeStyle = prev.strokeStyle;
        this.font = prev.font;
        this.textAlign = prev.textAlign;
        this.textBaseline = prev.textBaseline;
        this.lineWidth = prev.lineWidth;
        this.globalAlpha = prev.globalAlpha;
        transform = prev.transform;
      }
      this.restoreCount++;
      this.stackDepth--;
      if (this.stackDepth < this.minStackDepth) this.minStackDepth = this.stackDepth;
      calls.push({ op: "restore" });
    },
    getTransform() {
      return { ...transform };
    },
    setTransform(a, b, c, d, e, f) {
      transform = { a, b, c, d, e, f };
      calls.push({ op: "setTransform", a, b, c, d, e, f });
    },
    clearRect(x, y, w, h) {
      calls.push({ op: "clearRect", x, y, w, h });
    },
    fillRect(x, y, w, h) {
      calls.push({ op: "fillRect", x, y, w, h, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha, transform: { ...transform } });
    },
    strokeRect(x, y, w, h) {
      calls.push({ op: "strokeRect", x, y, w, h, strokeStyle: this.strokeStyle, transform: { ...transform } });
    },
    beginPath() {
      calls.push({ op: "beginPath" });
    },
    rect(x, y, w, h) {
      calls.push({ op: "rect", x, y, w, h });
    },
    clip() {
      calls.push({ op: "clip" });
    },
    moveTo(x, y) {
      calls.push({ op: "moveTo", x, y, transform: { ...transform } });
    },
    lineTo(x, y) {
      calls.push({ op: "lineTo", x, y, transform: { ...transform } });
    },
    roundRect(x, y, w, h, r) {
      calls.push({ op: "roundRect", x, y, w, h, r, fillStyle: this.fillStyle });
    },
    arc(x, y, r, startAngle, endAngle) {
      calls.push({ op: "arc", x, y, r, startAngle, endAngle, fillStyle: this.fillStyle });
    },
    closePath() {
      calls.push({ op: "closePath" });
    },
    fill() {
      calls.push({ op: "fill", fillStyle: this.fillStyle });
    },
    stroke() {
      calls.push({ op: "stroke", strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha });
    },
    setLineDash(segments) {
      calls.push({ op: "setLineDash", segments: [...segments] });
    },
    fillText(text, x, y) {
      calls.push({
        op: "fillText",
        text,
        x,
        y,
        fillStyle: this.fillStyle,
        textAlign: this.textAlign,
        font: this.font,
        transform: { ...transform },
      });
    },
    strokeText(text, x, y) {
      calls.push({ op: "strokeText", text, x, y, strokeStyle: this.strokeStyle });
    },
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    drawImage(image, dx, dy) {
      calls.push({ op: "drawImage", image, dx, dy, transform: { ...transform } });
    },
  };
  return ctx;
}

function makeMockDocument() {
  const offscreenCanvases = [];
  return {
    offscreenCanvases,
    createElement(tag) {
      assert.equal(tag, "canvas");
      const offCtx = makeRecordedContext(0, 0, null, 1);
      const canvas = offCtx.canvas;
      canvas.getContext = (kind) => (kind === "2d" ? offCtx : null);
      canvas.recordedCtx = offCtx;
      offscreenCanvases.push(canvas);
      return canvas;
    },
  };
}

function withSettingsSnapshot(fn) {
  const snapshot = {
    chartType: settings.chartType,
    tpoMode: settings.tpoMode,
    tpoProfilePeriod: settings.tpoProfilePeriod,
    tpoBracketSize: settings.tpoBracketSize,
    clusterCellData: settings.clusterCellData,
    profileCellData: settings.profileCellData,
    candles: settings.candles,
    heat: settings.heat,
    cellNumbers: settings.cellNumbers,
    poc: settings.poc,
    stackedImbalance: settings.stackedImbalance,
    lastPrice: settings.lastPrice,
    grid: settings.grid,
    volumeProfile: settings.volumeProfile,
    profilePoc: settings.profilePoc,
    profileVah: settings.profileVah,
    profileVal: settings.profileVal,
  };
  try {
    return fn();
  } finally {
    Object.assign(settings, snapshot);
  }
}

const DAY1_START = Date.UTC(2026, 5, 22, 0, 0);
const DAY2_START = Date.UTC(2026, 5, 23, 0, 0);

function makeSeries({
  count = 6,
  startTimeBase = DAY2_START,
  intervalMs = 30 * 60_000,
  priceStep = 1,
  pricePrecision = 1,
} = {}) {
  const series = new FootprintSeries({ intervalMs, priceStep, pricePrecision });
  series.loadBars(Array.from({ length: count }, (_, index) => {
    const startTime = startTimeBase + index * intervalMs;
    const base = 62100 + index;
    const cells = new Map([
      [base, {
        priceBin: base,
        buyVol: 60 + index * 2,
        sellVol: 20,
        count: 8,
        buyCount: 5,
        sellCount: 3,
        liquidationBuyVol: 0,
        liquidationSellVol: 0,
      }],
      [base + 1, {
        priceBin: base + 1,
        buyVol: 15,
        sellVol: 45 + index,
        count: 6,
        buyCount: 2,
        sellCount: 4,
        liquidationBuyVol: 0,
        liquidationSellVol: 0,
      }],
    ]);
    return {
      startTime,
      open: base,
      high: base + 3,
      low: base - 2,
      close: base + 1,
      volume: 140 + index * 3,
      delta: 10 + index,
      count: 14,
      liquidationBuyVol: 0,
      liquidationSellVol: 0,
      cells,
      hasRef: true,
      completeness: "complete",
      sources: ["history"],
      updatedAt: startTime,
      cellRevision: 1,
    };
  }));
  return series;
}

function makeView({ width = 838, height = 400, colWidth = 100, dpr = 1, subPanesH = 0, low = 62095, high = 62115, barIndex = 5 } = {}) {
  const view = new View();
  view.pixelRatio = dpr;
  view.area = { left: 0, top: 0, width, height };
  view.priceAxisW = view.chartLayoutOptions.priceAxisWidth;
  view.subPanesH = subPanesH;
  view.colWidth = colWidth;
  view.scrollToIndex(barIndex, 1);
  view.fitPriceRange(low, high);
  return view;
}

function makeChartConfig(overrides = {}) {
  return {
    chartType: "footprint",
    tpoMode: "blocks",
    tpoProfilePeriod: "daily",
    tpoBracketSize: "auto",
    clusterCellData: "bidask",
    profileCellData: "volume",
    candles: true,
    heat: true,
    cellNumbers: true,
    poc: true,
    stackedImbalance: true,
    ...overrides,
  };
}

test("renderAnnotations keeps canvas save/restore balanced and restores DPR transform across populated, empty, and suppressed passes", () => {
  withSettingsSnapshot(() => {
    settings.volumeProfile = true;
    settings.profilePoc = true;
    settings.profileVah = true;
    settings.profileVal = true;
    settings.lastPrice = true;

    const doc = makeMockDocument();
    const dpr = 2;
    const ctx = makeRecordedContext(1800, 1044, doc, dpr);
    const series = makeSeries({ count: 6 });
    const view = makeView({ width: 838, height: 360, colWidth: 100, dpr, subPanesH: 80 });

    let hudText;
    let heatmapDrawn = 0;
    let foregroundDrawn = 0;
    let paneBgDrawn = 0;
    let paneDrawn = 0;
    let priceOverlayDrawn = 0;
    let suppressed = false;

    const overlay = new Overlay(
      ctx,
      () => { foregroundDrawn++; },
      () => ({ enabled: true, mode: "visible", valueAreaPercent: 0.7, showPoc: true, showVah: true, showVal: true }),
      () => ({ enabled: true, visible: { pwh: true, pwRange: true } }),
      () => [
        { id: "pwRange", group: "pw", kind: "zone", label: "PW Range", color: "#38bdf8", sourceEnd: DAY2_START, fromPrice: 62098, toPrice: 62104, fillOpacity: 0.14 },
        { id: "pwh", group: "pw", kind: "line", label: "PWH", color: "#60a5fa", sourceEnd: DAY2_START, price: 62110, lineStyle: "dashed" },
      ],
      () => ({ enabled: true, visible: { monH: true } }),
      () => [
        { id: "monH", group: "mon", kind: "line", label: "MON-H", color: "#f59e0b", sourceEnd: DAY2_START, price: 62107, lineStyle: "dotted" },
      ],
      () => [
        { id: "npoc-1", market: "BTCUSDT", period: "daily", periodStart: DAY1_START, periodEnd: DAY2_START, price: 62103, age: 1, complete: true },
      ],
      () => [
        { id: "ref-1", market: "BTCUSDT", family: "open", period: "daily", sourceStart: DAY2_START, sourceEnd: DAY2_START + 60_000, price: 62101, label: "DO", color: "#eab308" },
      ],
      () => [
        { id: "cvd", height: 80, scaleMode: "linear", toggleScaleMode: () => "log", draw: () => { paneDrawn++; } },
      ],
      () => [
        { id: "ema", height: 0, scaleMode: "linear", toggleScaleMode: () => "linear", draw: () => { priceOverlayDrawn++; } },
      ],
      undefined,
      (text) => { hudText = text; },
      () => { paneBgDrawn++; },
      () => suppressed,
      undefined,
      undefined,
      () => { heatmapDrawn++; },
    );
    overlay.setChartConfig(makeChartConfig());

    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 6]);
    assert.equal(ctx.saveCount, ctx.restoreCount);
    assert.equal(ctx.stackDepth, 0);
    assert.equal(ctx.minStackDepth, 0);
    assert.deepEqual(ctx.getTransform(), { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 });
    assert.equal(heatmapDrawn, 1);
    assert.equal(foregroundDrawn, 1);
    assert.equal(paneBgDrawn, 1);
    assert.equal(paneDrawn, 1);
    assert.equal(priceOverlayDrawn, 1);
    assert.equal(typeof hudText, "string");
    assert.ok(doc.offscreenCanvases.length >= 2, "DPR axis layer creates offscreen price & time canvases");

    const emptySeries = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, pricePrecision: 1 });
    overlay.renderAnnotations(view, emptySeries, { x: 0, y: 0, visible: false }, [0, 0]);
    assert.equal(ctx.saveCount, ctx.restoreCount);
    assert.equal(ctx.stackDepth, 0);
    assert.equal(ctx.minStackDepth, 0);
    assert.equal(hudText, null);

    suppressed = true;
    const prevHeatmap = heatmapDrawn;
    const prevFg = foregroundDrawn;
    const prevPriceOverlay = priceOverlayDrawn;
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 6]);
    assert.equal(ctx.saveCount, ctx.restoreCount);
    assert.equal(ctx.stackDepth, 0);
    assert.equal(ctx.minStackDepth, 0);
    assert.equal(heatmapDrawn, prevHeatmap);
    assert.equal(foregroundDrawn, prevFg);
    assert.equal(priceOverlayDrawn, prevPriceOverlay);
    assert.equal(paneDrawn, 2);
    assert.equal(hudText, null);
  });
});

test("renderAnnotations and renderInteraction preserve two-pass contract, custom layer order, single indicator batch, and touch controls", () => {
  const annotationCtx = makeRecordedContext(900, 522);
  const interactionCtx = makeRecordedContext(900, 522);
  const series = makeSeries({ count: 5 });
  const view = makeView({ width: 838, height: 360, colWidth: 80, subPanesH: 90, barIndex: 4 });
  const events = [];
  let scaleMode = "linear";
  let suppressed = false;
  let syncTime = series.at(1).startTime;
  const hudHistory = [];

  const overlay = new Overlay(
    annotationCtx,
    () => { events.push("drawForeground"); },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => [{
      id: "deltaPane",
      height: 90,
      scaleMode,
      toggleScaleMode: () => {
        scaleMode = scaleMode === "linear" ? "log" : "linear";
        return scaleMode;
      },
      draw: () => { events.push("indicatorPane"); },
    }],
    () => [{
      id: "vwapOverlay",
      height: 0,
      scaleMode: "linear",
      toggleScaleMode: () => "linear",
      draw: () => { events.push("indicatorPriceOverlay"); },
    }],
    () => syncTime,
    (text) => { hudHistory.push(text); },
    () => { events.push("indicatorPaneBg"); },
    () => suppressed,
    interactionCtx,
    () => { events.push("interactionForeground"); },
    () => { events.push("orderbookHeatmap"); },
    () => { events.push("orderbookHover"); },
  );

  overlay.renderAnnotations(
    view,
    series,
    { x: 0, y: 0, visible: false },
    [0, 5],
    ["drawings", "indicator:rsi", "indicator:macd", "orderbook-heatmap", "axis"],
  );
  assert.deepEqual(events, [
    "drawForeground",
    "indicatorPaneBg",
    "indicatorPane",
    "indicatorPriceOverlay",
    "orderbookHeatmap",
  ]);
  assert.equal(hudHistory.length, 1);
  assert.ok(hudHistory[0].startsWith("O "), "default annotation HUD omits hover marker");
  assert.equal(interactionCtx.calls.length, 0);

  // When crosshair is visible, annotation pass skips HUD while interaction pass renders hovered HUD onto interactionCtx.
  const annotationCallsBeforeHover = annotationCtx.calls.length;
  hudHistory.length = 0;
  overlay.renderAnnotations(view, series, { x: view.xOfIndex(2) + 10, y: view.yOfPrice(62102), visible: true }, [0, 5], ["axis"]);
  assert.equal(hudHistory.length, 0);

  const barHoverX = view.xOfIndex(2) + 10;
  const barHoverY = view.yOfPrice(62102);
  const interactionCallsBefore = annotationCtx.calls.length;
  overlay.renderInteraction(view, series, { x: barHoverX, y: barHoverY, visible: true }, [0, 5]);
  assert.equal(annotationCtx.calls.length, interactionCallsBefore);
  assert.ok(annotationCtx.calls.length > annotationCallsBeforeHover);
  assert.equal(interactionCtx.calls[0].op, "clearRect");
  assert.equal(hudHistory.length, 1);
  assert.ok(
    interactionCtx.calls.some((call) => call.op === "fillText" && String(call.text).startsWith("◆ ")),
    "interaction HUD renders hover diamond marker",
  );
  assert.ok(events.includes("orderbookHover"));
  assert.ok(events.includes("interactionForeground"));

  const axisHoverX = view.area.left + view.area.width + 14;
  const hoverAxisY = view.area.top + view.area.height - 10;
  overlay.renderInteraction(view, series, { x: axisHoverX, y: hoverAxisY, visible: true }, [0, 5]);
  assert.equal(overlay.getPriceScaleControlAt(axisHoverX, hoverAxisY), "autoScale");

  // Crosshair sync + local dashed crosshair lines drawn on interactionCtx
  const dashedCalls = interactionCtx.calls.filter((call) => call.op === "setLineDash" && call.segments.length === 2);
  assert.ok(dashedCalls.length >= 2, "both sync and local crosshair use dashed strokes");

  // Price scale control hit-testing & indicator pane/axis hit-testing
  assert.equal(overlay.getIndicatorAxisPaneAt(axisHoverX, view.area.top + view.area.height + 20), "deltaPane");
  assert.equal(overlay.getIndicatorPaneAt(view.area.left + 20, view.area.top + view.area.height + 20), "deltaPane");
  assert.equal(overlay.toggleIndicatorScaleMode("deltaPane"), "log");
  assert.equal(scaleMode, "log");

  // Hovering indicator axis gutter exposes indicator scale control hit rect
  overlay.renderInteraction(view, series, { x: axisHoverX, y: view.area.top + view.area.height + 40, visible: true }, [0, 5]);
  const indCtrl = overlay.getIndicatorScaleControlAt(axisHoverX, view.area.top + view.area.height + 90 - 10);
  assert.ok(indCtrl === null || indCtrl.paneId === "deltaPane");

  // Touch menu button appears when touch && !crosshair.visible and disappears when crosshair becomes visible
  overlay.renderInteraction(view, series, { x: 0, y: 0, visible: false, touch: true }, [0, 5]);
  const menuRect = overlay.getMenuButtonRect();
  assert.ok(menuRect !== null);
  assert.equal(overlay.getMenuButtonAt(menuRect.x + 2, menuRect.y + 2), true);

  overlay.renderInteraction(view, series, { x: 120, y: 120, visible: true, touch: true }, [0, 5]);
  assert.equal(overlay.getMenuButtonRect(), null);
  assert.equal(overlay.getMenuButtonAt(menuRect.x + 2, menuRect.y + 2), false);

  // Suppressed main chart skips drawOrderbookHover and interactionForeground
  suppressed = true;
  const eventsBeforeSuppressed = events.length;
  overlay.renderInteraction(view, series, { x: 120, y: 120, visible: true }, [0, 5]);
  assert.deepEqual(events.slice(eventsBeforeSuppressed), []);
});

test("renderAnnotations draws footprint cells (full vs compact, notional toggle), volume profile levels, line labels, and queues", () => {
  withSettingsSnapshot(() => {
    settings.volumeProfile = true;
    settings.profilePoc = true;
    settings.profileVah = true;
    settings.profileVal = true;

    const ctx = makeRecordedContext(900, 522);
    const series = makeSeries({ count: 3, priceStep: 1 });
    const view = makeView({ width: 838, height: 300, colWidth: 100, barIndex: 2, low: 62099, high: 62105 });

    const overlay = new Overlay(
      ctx,
      undefined,
      () => ({ enabled: true, mode: "visible", valueAreaPercent: 0.7, showPoc: true, showVah: true, showVal: true }),
    );
    overlay.setChartConfig(makeChartConfig({ chartType: "footprint", clusterCellData: "bidask", cellNumbers: true }));

    // Full mode: colWidth=100 -> candleStrip=16 -> fpW=84 >= 72 -> left & right text per cell
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["footprint-text", "volume-profile", "axis"]);
    const fullCellTexts = ctx.calls.filter((call) => call.op === "fillText" && (call.textAlign === "left" || call.textAlign === "right"));
    assert.ok(fullCellTexts.length >= 4, "full footprint mode draws separate bid/ask texts");
    assert.ok(fullCellTexts.some((call) => String(call.text).endsWith("M")), "notional mode scales qty*price into M/k units");

    const vpLevels = overlay.getActiveVolumeProfileLevels();
    assert.ok(vpLevels !== null && vpLevels.poc !== null);

    // Turning showNotional off invalidates cellTextCache even when cellRevision stays constant
    const skipAnnotationHud = { x: 0, y: 0, visible: true };
    overlay.showNotional = false;
    ctx.calls.length = 0;
    overlay.renderAnnotations(view, series, skipAnnotationHud, [0, 3], ["footprint-text"]);
    const baseUnitTexts = ctx.calls.filter((call) => call.op === "fillText" && (call.textAlign === "left" || call.textAlign === "right"));
    assert.ok(baseUnitTexts.some((call) => String(call.text) === "60.0" || String(call.text) === "20.0"));

    // Compact mode: colWidth=60 -> candleStrip=13.2 -> fpW=46.8 in [44, 72) -> centered single value
    view.colWidth = 60;
    ctx.calls.length = 0;
    overlay.renderAnnotations(view, series, skipAnnotationHud, [0, 3], ["footprint-text"]);
    assert.ok(ctx.calls.some((call) => call.op === "fillText" && call.textAlign === "center"));
    assert.equal(ctx.calls.some((call) => call.op === "fillText" && (call.textAlign === "left" || call.textAlign === "right")), false);

    // Candlestick chartType draws zero cell numbers
    overlay.setChartConfig(makeChartConfig({ chartType: "candlestick" }));
    ctx.calls.length = 0;
    overlay.renderAnnotations(view, series, skipAnnotationHud, [0, 3], ["footprint-text"]);
    assert.equal(ctx.calls.filter((call) => call.op === "fillText").length, 0);

    // Cross-surface queues appear on the axis pass and reset on the subsequent pass
    overlay.queueLineObject(62102, "CUSTOM-POC", "#38bdf8");
    overlay.queuePriceAxisLabel(62101, "MARK-A", "#fbbf24");
    overlay.queueTimeObject(series.at(1).startTime, "T1", "#a855f7");
    ctx.calls.length = 0;
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["axis"]);
    const axisTexts = ctx.calls.filter((call) => call.op === "fillText").map((call) => call.text);
    assert.ok(axisTexts.includes("CUSTOM-POC"));
    assert.ok(axisTexts.includes("MARK-A"));
    assert.ok(ctx.calls.some((call) => call.op === "stroke" && call.strokeStyle === "#a855f7"));

    ctx.calls.length = 0;
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["axis"]);
    const nextAxisTexts = ctx.calls.filter((call) => call.op === "fillText").map((call) => call.text);
    assert.equal(nextAxisTexts.includes("CUSTOM-POC"), false);
    assert.equal(nextAxisTexts.includes("MARK-A"), false);
    assert.equal(ctx.calls.some((call) => call.op === "stroke" && call.strokeStyle === "#a855f7"), false);
  });
});

test("TPO blocks, letters, hit zones, merge-left undo state, and DPR axis cache invalidation behave identically", () => {
  const doc = makeMockDocument();
  const dpr = 2;
  const ctx = makeRecordedContext(1800, 1044, doc, dpr);
  const series = new FootprintSeries({ intervalMs: 30 * 60_000, priceStep: 1, pricePrecision: 1 });
  series.loadBars([
    { startTime: DAY1_START, open: 62100, high: 62104, low: 62099, close: 62102, volume: 100, delta: 10, count: 5, liquidationBuyVol: 0, liquidationSellVol: 0, cells: new Map(), hasRef: true },
    { startTime: DAY1_START + 30 * 60_000, open: 62102, high: 62106, low: 62101, close: 62103, volume: 120, delta: 15, count: 6, liquidationBuyVol: 0, liquidationSellVol: 0, cells: new Map(), hasRef: true },
    { startTime: DAY2_START, open: 62103, high: 62108, low: 62102, close: 62105, volume: 90, delta: 8, count: 4, liquidationBuyVol: 0, liquidationSellVol: 0, cells: new Map(), hasRef: true },
    { startTime: DAY2_START + 30 * 60_000, open: 62105, high: 62109, low: 62104, close: 62106, volume: 110, delta: 12, count: 5, liquidationBuyVol: 0, liquidationSellVol: 0, cells: new Map(), hasRef: true },
  ]);
  const view = makeView({ width: 838, height: 400, colWidth: 30, dpr, low: 62096, high: 62114, barIndex: 3 });

  const overlay = new Overlay(ctx);
  overlay.setChartConfig(makeChartConfig({
    chartType: "tpo",
    tpoMode: "blocks",
    tpoProfilePeriod: "daily",
    tpoBracketSize: "auto",
  }));

  overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 4], ["tpo"]);
  assert.ok(ctx.calls.some((call) => call.op === "fillRect"), "TPO block mode draws histogram squares");

  const day2MidX = (view.xOfIndex(2) + view.xOfIndex(4)) / 2;
  const hitBeforeMerge = overlay.getTpoProfileAt(day2MidX, 200);
  assert.ok(hitBeforeMerge !== null);
  assert.equal(hitBeforeMerge.sessionStart, DAY2_START);
  assert.equal(hitBeforeMerge.canMergeLeft, true);
  assert.equal(hitBeforeMerge.canUndoMerges, false);

  // Merge Day 2 into Day 1
  overlay.setTpoMergeLeftSessionStarts(new Set([DAY2_START]));
  overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 4], ["tpo"]);
  const hitAfterMerge = overlay.getTpoProfileAt(day2MidX, 200);
  assert.ok(hitAfterMerge !== null);
  assert.deepEqual(hitAfterMerge.groupSessionStarts, [DAY1_START, DAY2_START]);
  assert.equal(hitAfterMerge.canUndoMerges, true);

  // Switch to letters mode
  overlay.setChartConfig(makeChartConfig({
    chartType: "tpo",
    tpoMode: "letters",
    tpoProfilePeriod: "daily",
    tpoBracketSize: "auto",
  }));
  ctx.calls.length = 0;
  overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 4], ["tpo"]);
  const letterCalls = ctx.calls.filter((call) => call.op === "fillText" && call.text === "A");
  assert.ok(letterCalls.length > 0, "TPO letters mode prints bracket letters");

  // DPR axis cache reuse & invalidateAxisCache()
  overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 4], ["axis"]);
  const offCtxCallsAfterFirstAxis = doc.offscreenCanvases.map((c) => c.recordedCtx.calls.length);
  const priceCanvas = doc.offscreenCanvases.find((c) => c.width > 0 && c.width < 1000);
  assert.ok(priceCanvas && priceCanvas.width > view.priceAxisW, "offscreen price axis bitmap scales with DPR");

  overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 4], ["axis"]);
  assert.deepEqual(
    doc.offscreenCanvases.map((c) => c.recordedCtx.calls.length),
    offCtxCallsAfterFirstAxis,
    "repeated axis frame hits offscreen cache without redrawing offscreen labels",
  );

  overlay.invalidateAxisCache();
  overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 4], ["axis"]);
  const rebuilt = doc.offscreenCanvases.some((c, i) => c.recordedCtx.calls.length > (offCtxCallsAfterFirstAxis[i] ?? 0));
  assert.equal(rebuilt, true, "invalidateAxisCache forces offscreen axis redraw");
});

test("HUD priority, notional unit toggle, narrow multi-row layout, and dispose reset behave consistently", () => {
  withSettingsSnapshot(() => {
    settings.volumeProfile = true;
    const ctx = makeRecordedContext(900, 522);
    const series = makeSeries({ count: 3, priceStep: 1, pricePrecision: 1 });
    const view = makeView({ width: 838, height: 300, colWidth: 80, barIndex: 2, low: 62095, high: 62115 });
    let syncTime = series.at(1).startTime;
    const hudTexts = [];

    const overlay = new Overlay(
      ctx,
      undefined,
      () => ({ enabled: true, mode: "visible", valueAreaPercent: 0.7, showPoc: true, showVah: true, showVal: true }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => [{ id: "vol", height: 60, scaleMode: "linear", toggleScaleMode: () => "linear", draw: () => {} }],
      undefined,
      () => syncTime,
      (text) => { hudTexts.push(text); },
    );

    // 1. Crosshair hidden + sync time -> reads sync bar (bar 1: open 62101.0, count 14, close 62102.0)
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["hud"]);
    assert.ok(hudTexts.at(-1).includes("O 62101.0 "), "sync bar overrides latest bar when local crosshair hidden");

    // 2. Local crosshair visible on bar 0 -> overrides sync time (bar 1)
    overlay.renderInteraction(
      view,
      series,
      { x: view.xOfIndex(0) + 10, y: view.yOfPrice(62100), visible: true },
      [0, 3],
      ["hud"],
    );
    assert.ok(hudTexts.at(-1).includes("O 62100.0 "), "local crosshair wins over sync crosshair");
    assert.ok(hudTexts.at(-1).includes(" $"), "default showNotional=true prints $");

    // 3. No sync, hidden crosshair -> latest bar (bar 2: open 62102.0) with base BTC unit when showNotional=false
    syncTime = null;
    overlay.showNotional = false;
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["hud"]);
    assert.ok(hudTexts.at(-1).includes("O 62102.0 "));
    assert.ok(hudTexts.at(-1).includes(" ₿"));

    // 4. Narrow viewport wraps HUD across multiple rows spaced by HUD_ROW_HEIGHT within view bounds
    const narrowView = makeView({ width: 240, height: 300, colWidth: 80, barIndex: 2, low: 62095, high: 62115 });
    ctx.calls.length = 0;
    overlay.renderAnnotations(narrowView, series, { x: 0, y: 0, visible: false }, [0, 3], ["hud"]);
    const hudDrawTexts = ctx.calls.filter((call) => call.op === "fillText");
    const ys = [...new Set(hudDrawTexts.map((call) => call.y))];
    assert.ok(ys.length > 1, "narrow plot wraps HUD into multiple rows");
    assert.equal(ys[1] - ys[0], HUD_ROW_HEIGHT);
    assert.ok(hudDrawTexts.every((call) => call.x + call.text.length * 7 <= narrowView.area.left + narrowView.area.width));

    // 5. Interaction dependency & tail helpers
    assert.equal(overlay.requiresInteractionRedraw(), true);
    assert.equal(overlay.hasInteractionDependentHudContent({ x: 10, y: 10, visible: true }), true);
    assert.equal(overlay.hasInteractionDependentHudContent({ x: 10, y: 10, visible: true }), false);
    assert.equal(
      overlay.hasTailDependentInteractionContent(view, series, { x: view.xOfIndex(2) + 5, y: 100, visible: true }, [0, 3]),
      true,
    );
    assert.equal(
      overlay.hasTailDependentInteractionContent(view, series, { x: view.xOfIndex(2) + 5, y: 100, visible: true }, [0, 3], ["interaction-controls"]),
      false,
    );

    // 6. Populate transient caches/zones and verify dispose() clears everything
    overlay.setChartConfig(makeChartConfig({ chartType: "tpo" }));
    view.subPanesH = 60;
    overlay.renderAnnotations(view, series, { x: 0, y: 0, visible: false }, [0, 3], ["volume-profile", "tpo", "indicators"]);
    overlay.renderInteraction(view, series, { x: 0, y: 0, visible: false, touch: true }, [0, 3]);
    const priceCtrlX = view.area.left + view.area.width + Math.floor(view.priceAxisW / 2);
    const priceCtrlY = view.area.top + view.area.height - 10;
    assert.ok(overlay.getActiveVolumeProfileLevels() !== null);
    assert.ok(overlay.getTpoProfileAt(view.xOfIndex(1), 100) !== null);
    assert.ok(overlay.getMenuButtonRect() !== null);
    assert.equal(overlay.getPriceScaleControlAt(priceCtrlX, priceCtrlY), "logarithmic");
    assert.equal(overlay.getIndicatorAxisPaneAt(view.area.left + view.area.width + 5, view.area.top + view.area.height + 10), "vol");

    overlay.dispose();
    assert.equal(overlay.getActiveVolumeProfileLevels(), null);
    assert.equal(overlay.getTpoProfileAt(view.xOfIndex(1), 100), null);
    assert.equal(overlay.getMenuButtonRect(), null);
    assert.equal(overlay.getIndicatorAxisPaneAt(view.area.left + view.area.width + 5, view.area.top + view.area.height + 10), null);
    assert.equal(overlay.getPriceScaleControlAt(priceCtrlX, priceCtrlY), null);
  });
});
