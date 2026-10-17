import test from "node:test";
import assert from "node:assert/strict";
import { resolveChartWheelAction } from "../dist/features/chart/wheelPolicy.js";

const ZOOM_OUT = 1.1 ** -1;

test("Alt + wheel resolves to manual Y zoom", () => {
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 0, deltaY: -120, altKey: true, shiftKey: false }),
    { kind: "zoom-y", factor: ZOOM_OUT },
  );
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 0, deltaY: 120, altKey: true, shiftKey: false }),
    { kind: "zoom-y", factor: 1.1 },
  );
});

test("Shift + wheel resolves to horizontal detail zoom", () => {
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 0, deltaY: -120, altKey: false, shiftKey: true }),
    { kind: "zoom-x", factor: 1.1 },
  );
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 0, deltaY: 120, altKey: false, shiftKey: true }),
    { kind: "zoom-x", factor: ZOOM_OUT },
  );
});

test("Shift + translated horizontal wheel deltas still zoom instead of panning", () => {
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: -120, deltaY: 0, altKey: false, shiftKey: true }),
    { kind: "zoom-x", factor: 1.1 },
  );
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 120, deltaY: 0, altKey: false, shiftKey: true }),
    { kind: "zoom-x", factor: ZOOM_OUT },
  );
});

test("unmodified horizontal wheel pans and vertical wheel zooms X", () => {
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 80, deltaY: 0, altKey: false, shiftKey: false }),
    { kind: "pan-x", deltaPx: 40 },
  );
  assert.deepEqual(
    resolveChartWheelAction({ deltaX: 0, deltaY: -120, altKey: false, shiftKey: false }),
    { kind: "zoom-x", factor: 1.1 },
  );
});


test("plain wheel over price axis resolves to manual Y zoom", () => {
  assert.deepEqual(
    resolveChartWheelAction({
      deltaX: 0,
      deltaY: -120,
      altKey: false,
      shiftKey: false,
      target: "price-axis",
    }),
    { kind: "zoom-y", factor: ZOOM_OUT },
  );
  assert.deepEqual(
    resolveChartWheelAction({
      deltaX: 0,
      deltaY: 120,
      altKey: false,
      shiftKey: false,
      target: "price-axis",
    }),
    { kind: "zoom-y", factor: 1.1 },
  );
});

test("time axis wheel keeps horizontal policy", () => {
  assert.deepEqual(
    resolveChartWheelAction({
      deltaX: 0,
      deltaY: -120,
      altKey: false,
      shiftKey: false,
      target: "time-axis",
    }),
    { kind: "zoom-x", factor: 1.1 },
  );
  assert.deepEqual(
    resolveChartWheelAction({
      deltaX: 80,
      deltaY: 0,
      altKey: false,
      shiftKey: false,
      target: "time-axis",
    }),
    { kind: "pan-x", deltaPx: 40 },
  );
});

test("diagonal trackpad gesture zooms and pans in the same event", () => {
  const action = resolveChartWheelAction({ deltaX: 80, deltaY: -10, altKey: false, shiftKey: false });
  assert.equal(action.kind, "zoom-pan-x");
  assert.equal(action.deltaPx, 40);
  assert.ok(Math.abs(action.factor - 1.1 ** 0.1) < 1e-12);
});

test("small trackpad deltas zoom proportionally instead of a full notch", () => {
  const small = resolveChartWheelAction({ deltaX: 0, deltaY: -4, altKey: false, shiftKey: false });
  assert.equal(small.kind, "zoom-x");
  assert.ok(Math.abs(small.factor - 1.1 ** 0.04) < 1e-12);
  assert.ok(small.factor > 1 && small.factor < 1.005);

  const price = resolveChartWheelAction({ deltaX: 0, deltaY: 4, altKey: false, shiftKey: false, target: "price-axis" });
  assert.equal(price.kind, "zoom-y");
  assert.ok(Math.abs(price.factor - 1.1 ** 0.04) < 1e-12);
});

test("zoom step is capped at one notch and symmetric", () => {
  const zoomIn = resolveChartWheelAction({ deltaX: 0, deltaY: -1000, altKey: false, shiftKey: false });
  const zoomOut = resolveChartWheelAction({ deltaX: 0, deltaY: 1000, altKey: false, shiftKey: false });
  assert.equal(zoomIn.factor, 1.1);
  assert.ok(Math.abs(zoomIn.factor * zoomOut.factor - 1) < 1e-12);
});

test("line and page delta modes are converted to pixels", () => {
  const line = resolveChartWheelAction({ deltaX: 0, deltaY: -1, deltaMode: 1, altKey: false, shiftKey: false });
  assert.ok(Math.abs(line.factor - 1.1 ** 0.32) < 1e-12);
  const page = resolveChartWheelAction({ deltaX: 0, deltaY: -1, deltaMode: 2, altKey: false, shiftKey: false });
  assert.equal(page.factor, 1.1);
  const pan = resolveChartWheelAction({ deltaX: 2, deltaY: 0, deltaMode: 1, altKey: false, shiftKey: false });
  assert.deepEqual(pan, { kind: "pan-x", deltaPx: 32 });
});

test("platform delta scale shrinks pixel deltas", () => {
  const scaled = resolveChartWheelAction({ deltaX: 0, deltaY: -100, deltaScale: 0.5, altKey: false, shiftKey: false });
  assert.ok(Math.abs(scaled.factor - 1.1 ** 0.5) < 1e-12);
});
