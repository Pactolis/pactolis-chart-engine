import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("DrawingManager keeps mutable interaction state separate from pure drawing primitives", async () => {
  const [manager, primitives] = await Promise.all([
    read("src/features/drawings/drawingManager.ts"),
    read("src/features/drawings/drawingPrimitives.ts").catch(() => ""),
  ]);

  assert.match(manager, /from "\.\/drawingPrimitives\.js"/);
  assert.match(manager, /export class DrawingManager/);
  assert.doesNotMatch(manager, /function renderFibonacciTool\(/);
  assert.doesNotMatch(manager, /function measurementHitTest\(/);
  assert.doesNotMatch(manager, /function normalizeDrawingStylePreset\(/);
  assert.ok(manager.split("\n").length < 1_110, "DrawingManager should remain focused on mutable interaction state");

  assert.match(primitives, /export function renderFibonacciTool\(/);
  assert.match(primitives, /export function measurementHitTest\(/);
  assert.match(primitives, /function normalizeDrawingStylePreset\(/);
  assert.match(primitives, /export function normalizePositionRiskSettings\(/);
});

test("drawingManager preserves its public helper facade after primitive extraction", async () => {
  const manager = await read("src/features/drawings/drawingManager.ts");

  assert.match(manager, /DEFAULT_FIBONACCI_RETRACEMENT_LEVELS/);
  assert.match(manager, /DEFAULT_FIBONACCI_EXTENSION_LEVELS/);
  assert.match(manager, /positionRiskMetrics/);
  assert.match(manager, /normalizePositionRiskSettings/);
  assert.match(manager, /LEGACY_DRAWING_MARKET/);
});
