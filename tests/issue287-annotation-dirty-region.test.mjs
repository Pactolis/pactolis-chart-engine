import test from "node:test";
import assert from "node:assert/strict";
import {
  AnnotationPassCache,
  alignDirtyRectToDevicePixels,
  annotationPass,
  shouldFallbackToFullRedraw,
  unionDirtyRects,
} from "../dist/core/render/overlay/annotationPassCache.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { Overlay } from "../dist/core/render/overlay.js";
import {
  configurePerformanceTelemetry,
  isPerformanceTelemetryEnabled,
  snapshotPerformanceTelemetry,
} from "../dist/core/performanceTelemetry.js";
import { DEFAULT_VOLUME_PROFILE_SETTINGS } from "../dist/core/analysis/volumeProfile.js";
import { normalizePreviousWeekStrategySettings } from "../dist/core/analysis/previousWeekStrategy.js";
import { normalizeMondayRangeSettings } from "../dist/core/analysis/mondayRange.js";

function makeOverlayMockDocument(dpr = 1, width = 900, height = 520) {
  const created = [];
  const makeCtx = (w, h, initialTransform) => {
    const calls = [];
    const stack = [];
    let transform = { ...(initialTransform ?? { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 }) };
    const canvas = {
      width: w,
      height: h,
      ownerDocument: null,
    };
    const ctx = {
      canvas,
      calls,
      fillStyle: "#000",
      strokeStyle: "#000",
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      lineWidth: 1,
      globalAlpha: 1,
      save() {
        stack.push({
          fillStyle: this.fillStyle,
          strokeStyle: this.strokeStyle,
          font: this.font,
          textAlign: this.textAlign,
          textBaseline: this.textBaseline,
          lineWidth: this.lineWidth,
          globalAlpha: this.globalAlpha,
          transform: { ...transform },
        });
      },
      restore() {
        const prev = stack.pop();
        if (prev) {
          Object.assign(this, prev);
          transform = prev.transform;
        }
      },
      getTransform() {
        return { ...transform };
      },
      setTransform(a, b, c, d, e, f) {
        transform = { a, b, c, d, e, f };
        calls.push({ op: "setTransform", a, b, c, d, e, f });
      },
      clearRect(x, y, rw, rh) {
        calls.push({ op: "clearRect", x, y, w: rw, h: rh });
      },
      fillRect(x, y, rw, rh) {
        calls.push({ op: "fillRect", x, y, w: rw, h: rh, fillStyle: this.fillStyle });
      },
      strokeRect(x, y, rw, rh) {
        calls.push({ op: "strokeRect", x, y, w: rw, h: rh });
      },
      beginPath() {
        calls.push({ op: "beginPath" });
      },
      rect(x, y, rw, rh) {
        calls.push({ op: "rect", x, y, w: rw, h: rh });
      },
      clip() {
        calls.push({ op: "clip" });
      },
      moveTo(x, y) {
        calls.push({ op: "moveTo", x, y });
      },
      lineTo(x, y) {
        calls.push({ op: "lineTo", x, y });
      },
      roundRect() {},
      fill() {},
      stroke() {
        calls.push({ op: "stroke", strokeStyle: this.strokeStyle });
      },
      setLineDash() {},
      fillText(text, x, y) {
        calls.push({ op: "fillText", text: String(text), x, y });
      },
      measureText(text) {
        return { width: String(text).length * 7 };
      },
      drawImage(image, ...args) {
        calls.push({ op: "drawImage", image, args });
      },
    };
    canvas.getContext = (kind) => (kind === "2d" ? ctx : null);
    canvas.recordedCtx = ctx;
    return ctx;
  };
  const doc = {
    created,
    createElement(tag) {
      assert.equal(tag, "canvas");
      const offCtx = makeCtx(0, 0, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      offCtx.canvas.ownerDocument = doc;
      created.push(offCtx.canvas);
      return offCtx.canvas;
    },
  };
  const mainCtx = makeCtx(width, height, { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 });
  mainCtx.canvas.ownerDocument = doc;
  return { mainCtx, created, makeCtx };
}

function makeOverlaySeries(count = 20) {
  const baseTime = Date.UTC(2026, 5, 23, 8, 0);
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1, pricePrecision: 1 });
  series.loadBars(
    Array.from({ length: count }, (_, index) => {
      const startTime = baseTime + index * 60_000;
      const basePrice = 62_100 + index * 2;
      return {
        startTime,
        open: basePrice,
        high: basePrice + 10,
        low: basePrice - 5,
        close: basePrice + 4,
        volume: 100 + index,
        delta: 12,
        count: 10,
        liquidationBuyVol: 0,
        liquidationSellVol: 0,
        cells: new Map([
          [
            basePrice,
            {
              priceBin: basePrice,
              buyVol: 60,
              sellVol: 40,
              count: 10,
              buyCount: 6,
              sellCount: 4,
              liquidationBuyVol: 0,
              liquidationSellVol: 0,
            },
          ],
        ]),
        hasRef: true,
        completeness: "complete",
        sources: ["history"],
        updatedAt: startTime,
      };
    }),
  );
  return { baseTime, series };
}

function makeOverlayView(dpr = 1) {
  const view = new View();
  view.pixelRatio = dpr;
  view.area = { left: 0, top: 0, width: 838, height: 500 };
  view.priceAxisW = view.chartLayoutOptions.priceAxisWidth;
  view.colWidth = 20;
  view.scrollToIndex(19, 2);
  view.fitPriceRange(62_080, 62_220);
  return view;
}

test("alignDirtyRectToDevicePixels aligns DPR 1/1.25/1.5/2 with 2px AA padding and clamps to canvas", () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const canvasW = Math.round(900 * dpr);
    const canvasH = Math.round(520 * dpr);
    const rect = { x: 100.3, y: 12.7, width: 20.4, height: 80.2 };
    const aligned = alignDirtyRectToDevicePixels(rect, dpr, canvasW, canvasH, 2);
    assert.equal(Number.isInteger(aligned.x), true);
    assert.equal(Number.isInteger(aligned.y), true);
    assert.equal(Number.isInteger(aligned.width), true);
    assert.equal(Number.isInteger(aligned.height), true);
    assert.equal(aligned.x, Math.max(0, Math.floor(rect.x * dpr) - 2));
    assert.equal(aligned.y, Math.max(0, Math.floor(rect.y * dpr) - 2));
    assert.equal(aligned.x + aligned.width, Math.min(canvasW, Math.ceil((rect.x + rect.width) * dpr) + 2));
    assert.equal(aligned.y + aligned.height, Math.min(canvasH, Math.ceil((rect.y + rect.height) * dpr) + 2));
  }

  // Clamping at origin and far edge
  const clamped = alignDirtyRectToDevicePixels({ x: -5, y: 0, width: 15, height: 600 }, 1.5, 900, 520, 2);
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.width, 17); // ceil(10 * 1.5) + 2
  assert.equal(clamped.height, 520);

  // Empty / out-of-bounds rects
  assert.deepEqual(alignDirtyRectToDevicePixels({ x: 950, y: 0, width: 20, height: 20 }, 1, 900, 520), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  assert.deepEqual(alignDirtyRectToDevicePixels({ x: 10, y: 10, width: 0, height: 20 }, 1, 900, 520), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
});

test("unionDirtyRects and shouldFallbackToFullRedraw enforce bounding union and area ratio cap", () => {
  const a = { x: 10, y: 20, width: 30, height: 40 };
  const b = { x: 100, y: 10, width: 50, height: 80 };
  assert.deepEqual(unionDirtyRects(a, b), { x: 10, y: 10, width: 140, height: 80 });
  assert.deepEqual(unionDirtyRects({ x: 0, y: 0, width: 0, height: 10 }, b), b);
  assert.deepEqual(unionDirtyRects(a, { x: 0, y: 0, width: 10, height: 0 }), a);

  assert.equal(shouldFallbackToFullRedraw({ x: 0, y: 0, width: 450, height: 100 }, 1000, 100, 0.45), false);
  assert.equal(shouldFallbackToFullRedraw({ x: 0, y: 0, width: 451, height: 100 }, 1000, 100, 0.45), true);
  assert.equal(shouldFallbackToFullRedraw({ x: 0, y: 0, width: 10, height: 10 }, 0, 100, 0.45), true);
});

test("AnnotationPassCache.blitRegion blits exact clamped device-pixel coordinates and replays effects", () => {
  const cache = new AnnotationPassCache();
  const { mainCtx } = makeOverlayMockDocument(2, 200, 100);
  let effectsReplayed = 0;
  cache.begin(ChartChange.All, "k1");
  assert.equal(
    cache.render(mainCtx, annotationPass("axis"), "", ChartChange.All, () => 42, (v) => {
      effectsReplayed += v;
    }),
    "miss",
  );

  const region = { x: 150, y: 10, width: 80, height: 60 }; // x+width=230 -> clamped to 200 -> width=50
  mainCtx.calls.length = 0;
  cache.begin(ChartChange.DataTail, "k1");
  assert.equal(
    cache.render(
      mainCtx,
      annotationPass("axis"),
      "",
      ChartChange.DataTail,
      () => {
        throw new Error("should not redraw on hit");
      },
      (v) => {
        effectsReplayed += v;
      },
      region,
    ),
    "hit",
  );
  assert.equal(effectsReplayed, 42);
  const drawCall = mainCtx.calls.find((c) => c.op === "drawImage");
  assert.ok(drawCall);
  assert.deepEqual(drawCall.args, [150, 10, 50, 60, 150, 10, 50, 60]);
});

test("16 MiB retained cap is preserved with partial region support", () => {
  const cache = new AnnotationPassCache();
  // 1800 * 1040 * 4 = 7,488,000 bytes (~7.14 MiB). Two layers + axis reserve stays bounded to 16 MiB.
  const { mainCtx } = makeOverlayMockDocument(2, 1800, 1040);
  cache.begin(ChartChange.All, "dpr2");
  assert.equal(cache.render(mainCtx, annotationPass("closed-footprint-text"), "", ChartChange.All, () => {}, () => {}), "miss");
  assert.equal(cache.render(mainCtx, annotationPass("strategy-levels"), "", ChartChange.All, () => {}, () => {}), false);
  assert.equal(cache.render(mainCtx, annotationPass("axis"), "", ChartChange.All, () => {}, () => {}), "miss");
});

test("Overlay.renderAnnotations opt-in partialTailRedraw clips & blits dirty region on DataTail and matches full parity", () => {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const baseLayers = ["footprint-text", "strategy-levels", "naked-poc", "reference-levels", "last-price", "axis"];
    const pwSettings = normalizePreviousWeekStrategySettings({ enabled: true, visible: { "pw-1": true } });
    const mrSettings = normalizeMondayRangeSettings({ enabled: true, visible: { "mr-1": true } });

    const runScenario = (enablePartial) => {
      const { mainCtx } = makeOverlayMockDocument(1, 900, 520);
      const { baseTime, series } = makeOverlaySeries();
      const view = makeOverlayView(1);
      const crosshair = { x: 0, y: 0, visible: false };
      const pwLevels = [{ id: "pw-1", kind: "line", price: 62_140, label: "PW-1", color: "#fbbf24", sourceStart: baseTime, sourceEnd: baseTime + 60_000 }];
      const mrLevels = [{ id: "mr-1", kind: "line", price: 62_150, label: "MON-1", color: "#a855f7", sourceStart: baseTime, sourceEnd: baseTime + 60_000 }];
      const nakedPocs = [{ id: "np-1", market: "BTCUSDT", period: "daily", periodStart: baseTime, periodEnd: baseTime + 60_000, price: 62_120, age: 1, complete: true }];
      const refLevels = [{ id: "ref-1", family: "level", period: "daily", label: "REF-1", price: 62_130, color: "#38bdf8", sourceStart: baseTime, sourceEnd: baseTime + 60_000 }];

      const overlay = new Overlay(
        mainCtx,
        undefined,
        () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
        () => pwSettings,
        () => pwLevels,
        () => mrSettings,
        () => mrLevels,
        () => nakedPocs,
        () => refLevels,
      );
      if (enablePartial) {
        assert.equal(overlay.isPartialTailRedrawEnabled(), false);
        overlay.setPartialTailRedrawEnabled(true);
        assert.equal(overlay.isPartialTailRedrawEnabled(), true);
      }

      overlay.renderAnnotations(view, series, crosshair, [0, 20], baseLayers, ChartChange.All);

      // Update tail bar close price and render DataTail frame
      const last = series.at(series.length - 1);
      series.upsertBar({ ...last, close: last.close + 2, high: last.high + 2 });
      const callsStart = mainCtx.calls.length;
      const beforeCounters = snapshotPerformanceTelemetry().counters;
      overlay.renderAnnotations(view, series, crosshair, [0, 20], baseLayers, ChartChange.DataTail);
      const afterCounters = snapshotPerformanceTelemetry().counters;
      return {
        calls: mainCtx.calls.slice(callsStart),
        hitDelta: (afterCounters["chart.annotation.partial.hit"] ?? 0) - (beforeCounters["chart.annotation.partial.hit"] ?? 0),
        fallbackDelta: (afterCounters["chart.annotation.partial.fallback"] ?? 0) - (beforeCounters["chart.annotation.partial.fallback"] ?? 0),
      };
    };

    const full = runScenario(false);
    const partial = runScenario(true);

    // Default disabled emits no partial telemetry and clears full canvas
    assert.equal(full.hitDelta, 0);
    assert.equal(full.fallbackDelta, 0);
    const fullClear = full.calls.find((c) => c.op === "clearRect");
    assert.deepEqual(fullClear, { op: "clearRect", x: 0, y: 0, w: 900, h: 520 });

    // Partial enabled records hit, clips & clears bounded dirty rect, and blits 9-arg sub-region
    assert.equal(partial.hitDelta, 1);
    assert.equal(partial.fallbackDelta, 0);
    const partialClear = partial.calls.find((c) => c.op === "clearRect");
    assert.ok(partialClear);
    assert.ok(partialClear.w < 900, "partial clearRect width must be strictly smaller than full canvas width");
    assert.ok(partial.calls.some((c) => c.op === "clip"));
    const partialDrawImages = partial.calls.filter((c) => c.op === "drawImage");
    assert.ok(partialDrawImages.length >= 4);
    for (const imgCall of partialDrawImages) {
      assert.equal(imgCall.args.length, 8, "partial blitRegion uses 9-arg drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh)");
    }

    // Last price marker text parity between full and partial
    const fullTexts = full.calls.filter((c) => c.op === "fillText").map((c) => c.text);
    const partialTexts = partial.calls.filter((c) => c.op === "fillText").map((c) => c.text);
    assert.deepEqual(partialTexts, fullTexts);
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
});

test("Overlay.renderAnnotations preserves WebGPU native text skip guard on partial DataTail frames", () => {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const { mainCtx } = makeOverlayMockDocument(1, 900, 520);
    const { series } = makeOverlaySeries();
    const view = makeOverlayView(1);
    const crosshair = { x: 0, y: 0, visible: false };
    const overlay = new Overlay(
      mainCtx,
      undefined,
      () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true, // shouldSkipFootprintText
    );
    overlay.setPartialTailRedrawEnabled(true);
    const layers = ["footprint-text", "axis"];

    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All);
    const callsStart = mainCtx.calls.length;
    const before = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    const after = snapshotPerformanceTelemetry().counters;

    assert.equal((after["chart.annotation.partial.hit"] ?? 0) - (before["chart.annotation.partial.hit"] ?? 0), 1);
    // Footprint cell volumes ("60", "40") must NOT be drawn when shouldSkipFootprintText() === true
    const drawnTexts = mainCtx.calls.slice(callsStart).filter((c) => c.op === "fillText").map((c) => c.text);
    assert.equal(drawnTexts.includes("60"), false);
    assert.equal(drawnTexts.includes("40"), false);
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
});

test("Overlay.renderAnnotations falls back deterministically on non-tail, resize, rotation, and context restore", () => {
  const wasEnabled = isPerformanceTelemetryEnabled();
  configurePerformanceTelemetry({ enabled: true });
  try {
    const { mainCtx, makeCtx } = makeOverlayMockDocument(1, 900, 520);
    const { series } = makeOverlaySeries();
    const view = makeOverlayView(1);
    const crosshair = { x: 0, y: 0, visible: false };
    const overlay = new Overlay(
      mainCtx,
      undefined,
      () => ({ ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false }),
    );
    overlay.setPartialTailRedrawEnabled(true);
    const layers = ["drawings", "axis"];

    // 1. ChartChange.All -> fallback
    let before = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All);
    let after = snapshotPerformanceTelemetry().counters;
    assert.equal((after["chart.annotation.partial.fallback"] ?? 0) - (before["chart.annotation.partial.fallback"] ?? 0), 1);

    // 2. ChartChange.DataNonTail -> fallback
    before = after;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataNonTail);
    after = snapshotPerformanceTelemetry().counters;
    assert.equal((after["chart.annotation.partial.fallback"] ?? 0) - (before["chart.annotation.partial.fallback"] ?? 0), 1);

    // Warm up with All
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All);

    // 3. Resize -> fallback
    mainCtx.canvas.width = 960;
    before = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    after = snapshotPerformanceTelemetry().counters;
    assert.equal((after["chart.annotation.partial.fallback"] ?? 0) - (before["chart.annotation.partial.fallback"] ?? 0), 1);

    // Warm up at new size
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All);

    // 4. Rotation/skew transform -> fallback
    mainCtx.setTransform(1, 0.1, 0, 1, 0, 0);
    before = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    after = snapshotPerformanceTelemetry().counters;
    assert.equal((after["chart.annotation.partial.fallback"] ?? 0) - (before["chart.annotation.partial.fallback"] ?? 0), 1);

    // 5. Context restore invalidation -> fallback
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.All);
    const restoredCtx = makeCtx(960, 520, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    restoredCtx.canvas.ownerDocument = mainCtx.canvas.ownerDocument;
    overlay.updateContext(restoredCtx);
    before = snapshotPerformanceTelemetry().counters;
    overlay.renderAnnotations(view, series, crosshair, [0, 20], layers, ChartChange.DataTail);
    after = snapshotPerformanceTelemetry().counters;
    assert.equal((after["chart.annotation.partial.fallback"] ?? 0) - (before["chart.annotation.partial.fallback"] ?? 0), 1);
  } finally {
    configurePerformanceTelemetry({ enabled: wasEnabled });
  }
});
