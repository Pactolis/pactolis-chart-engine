import test from "node:test";
import assert from "node:assert/strict";

import {
  isDrawingMagnetEnabled,
  isDrawingMagnetModifierPressed,
  isDrawingMagnetTransientActive,
  shouldUseTemporaryDrawingMagnet,
  snapPriceToOhlc,
} from "../dist/features/chart/ChartInputController.js";

test("SCENARIO-486-01/02: Ctrl/Cmd enables temporary strong magnet and release restores normal mode", () => {
  assert.equal(isDrawingMagnetModifierPressed({ ctrlKey: false, metaKey: false }), false);
  assert.equal(isDrawingMagnetModifierPressed({ ctrlKey: true, metaKey: false }), true);
  assert.equal(isDrawingMagnetModifierPressed({ ctrlKey: false, metaKey: true }), true);
  assert.equal(shouldUseTemporaryDrawingMagnet("horizontal", { ctrlKey: true, metaKey: false }), true);
  assert.equal(shouldUseTemporaryDrawingMagnet(null, { ctrlKey: true, metaKey: false }), false);
  assert.equal(isDrawingMagnetEnabled(true, false), true);
  assert.equal(isDrawingMagnetEnabled(false, false), false);
  assert.equal(isDrawingMagnetEnabled(false, true), true);
});

test("SCENARIO-486-01: temporary strong mode snaps to nearest OHLC without the weak threshold", () => {
  const ohlc = [100, 110, 90, 104];
  const yOfPrice = (price) => 200 - price;
  assert.equal(snapPriceToOhlc(104.5, 80, ohlc, yOfPrice, false), 104.5);
  assert.equal(snapPriceToOhlc(104.5, 80, ohlc, yOfPrice, true), 110);
});

test("SCENARIO-486-03: empty OHLC data always preserves the raw drawing price", () => {
  const yOfPrice = (price) => 200 - price;
  assert.equal(snapPriceToOhlc(104.5, 80, [], yOfPrice, false), 104.5);
  assert.equal(snapPriceToOhlc(104.5, 80, [], yOfPrice, true), 104.5);
});

test("SCENARIO-491-01/03: transient magnet state is modifier-scoped and lifecycle-safe", () => {
  assert.equal(isDrawingMagnetTransientActive("horizontal", { ctrlKey: true, metaKey: false }), true);
  assert.equal(isDrawingMagnetTransientActive("horizontal", { ctrlKey: false, metaKey: true }), true);
  assert.equal(isDrawingMagnetTransientActive(null, { ctrlKey: true, metaKey: false }), false);
  assert.equal(isDrawingMagnetTransientActive("horizontal", { ctrlKey: false, metaKey: false }), false);
});
