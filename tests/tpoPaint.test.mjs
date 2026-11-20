import assert from "node:assert/strict";
import { test } from "node:test";
import { configureChartLocale } from "../dist/core/chartLocale.js";
import { View } from "../dist/core/engine/view.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { configurePerformanceTelemetry, snapshotPerformanceTelemetry } from "../dist/core/performanceTelemetry.js";
import { Overlay } from "../dist/core/render/overlay.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";
import { settings } from "../dist/core/settings.js";

function fakeCanvas(width, height) {
  const calls = { fill: 0, fillRect: 0, fillStyle: 0, fillText: 0, drawImage: 0 };
  const canvas = { width, height, ownerDocument: { createElement: () => fakeCanvas(0, 0).ctx.canvas } };
  const ctx = {
    canvas,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    save() {}, restore() {}, setTransform() {}, clearRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, stroke() {},
    fill() { calls.fill++; },
    fillRect() { calls.fillRect++; },
    set fillStyle(_color) { calls.fillStyle++; },
    fillText() { calls.fillText++; },
    drawImage() { calls.drawImage++; },
  };
  canvas.getContext = () => ctx;
  return { ctx, calls };
}

test("closed TPO sessions reduce Canvas calls on a 38-session collapsed frame and replay hit zones", () => {
  configureChartLocale({ locale: () => "en", translate: () => "Partial" });
  const intervalMs = 30 * 60_000;
  const start = Date.UTC(2026, 0, 1);
  const series = new FootprintSeries({ intervalMs, priceStep: 1, pricePrecision: 0 });
  series.loadBars(Array.from({ length: 37 * 48 + 20 }, (_, index) => ({
    startTime: start + index * intervalMs,
    open: 103, high: 105, low: 100, close: 104,
    volume: 1, delta: 1, count: 1, cells: new Map(), hasRef: true,
  })));
  const { ctx, calls } = fakeCanvas(320, 150);
  const view = new View();
  view.area = { left: 0, top: 0, width: 320, height: 150 };
  view.colWidth = 0.175;
  view.priceTop = 120;
  view.pricePerPx = 0.75;
  const overlay = new Overlay(ctx);
  overlay.setChartConfig({ ...settings, chartType: "tpo" });
  const crosshair = { x: 0, y: 0, visible: true };
  const paint = (changes) => {
    for (const name of Object.keys(calls)) calls[name] = 0;
    overlay.renderAnnotations(view, series, crosshair, [0, series.length], ["tpo"], changes);
    return { ...calls };
  };
  const paintSamples = () => snapshotPerformanceTelemetry().metrics["chart.tpo.paint.ms"]?.count ?? 0;

  try {
    // The former path assigned every row and leader color and painted every row on each frame.
    const former = { fill: 0, fillRect: 228, fillStyle: 343, fillText: 115, drawImage: 0 };
    assert.equal(paint(ChartChange.Viewport).fillRect, former.fillRect);
    assert.equal(paintSamples(), 0);
    configurePerformanceTelemetry({ enabled: true });
    const miss = paint(ChartChange.DataTail);
    assert.equal(miss.fillRect, former.fillRect);
    assert.ok(miss.fillStyle < former.fillStyle);
    const closedHit = overlay.getTpoProfileAt(4, 10);
    const tail = series.at(series.length - 1);
    series.reassertOHLC(tail.startTime, tail.open, tail.high, tail.low, { close: 101, preferIncomingClose: true });
    assert.deepEqual(paint(ChartChange.DataTail), {
      fill: 0, fillRect: 6, fillStyle: 8, fillText: 4, drawImage: 1,
    });
    assert.equal(paintSamples(), 2);
    assert.ok(closedHit);
    assert.deepEqual(overlay.getTpoProfileAt(4, 10), closedHit);
  } finally {
    configurePerformanceTelemetry({ enabled: false });
    overlay.dispose();
  }
});
