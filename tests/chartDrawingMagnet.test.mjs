import test from "node:test";
import assert from "node:assert/strict";

import {
  isDrawingMagnetEnabled,
  isDrawingMagnetModifierPressed,
  isDrawingMagnetTransientActive,
  shouldUseTemporaryDrawingMagnet,
  snapPriceToOhlc,
  WEAK_MAGNET_THRESHOLD_PX,
} from "../dist/features/chart/ChartInputController.js";
import { settings } from "../dist/core/settings.js";

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

test("SCENARIO-MAGNET-V2-01: XOR invert enables bypass when persistent magnet is active", () => {
  // Magnet active + Ctrl modifier -> bypass (free placement)
  assert.equal(isDrawingMagnetEnabled(true, true), false);
  // Magnet active + no modifier -> active
  assert.equal(isDrawingMagnetEnabled(true, false), true);
  // Magnet off + Ctrl modifier -> temporary active
  assert.equal(isDrawingMagnetEnabled(false, true), true);
  // Magnet off + no modifier -> off
  assert.equal(isDrawingMagnetEnabled(false, false), false);
});

test("SCENARIO-MAGNET-V2-02: Anchor point editing enables transient modifier without activeTool", () => {
  // During anchor drag, activeTool is null but isEditingDrawing is true
  assert.equal(shouldUseTemporaryDrawingMagnet(null, { ctrlKey: true, metaKey: false }, true), true);
  assert.equal(shouldUseTemporaryDrawingMagnet(null, { ctrlKey: true, metaKey: false }, false), false);
  assert.equal(isDrawingMagnetTransientActive(null, { ctrlKey: true, metaKey: false }, true), true);
  assert.equal(isDrawingMagnetTransientActive(null, { ctrlKey: true, metaKey: false }, false), false);
});

test("SCENARIO-MAGNET-V2-03: snapPriceToOhlc supports customizable weak threshold (8px default vs 16px v2)", () => {
  const ohlc = [100, 110, 90, 104];
  const yOfPrice = (price) => 200 - price;
  // At y = 80, rawPrice = 120. yOfPrice(110) = 90. Distance = |90 - 80| = 10px.
  // 10px > 8px (default threshold) -> not snapped
  assert.equal(snapPriceToOhlc(104.5, 80, ohlc, yOfPrice, false), 104.5);
  assert.equal(snapPriceToOhlc(104.5, 80, ohlc, yOfPrice, false, 8), 104.5);
  // 10px <= 16px (WEAK_MAGNET_THRESHOLD_PX) -> snapped to 110
  assert.equal(snapPriceToOhlc(104.5, 80, ohlc, yOfPrice, false, WEAK_MAGNET_THRESHOLD_PX), 110);
  assert.equal(snapPriceToOhlc(104.5, 80, ohlc, yOfPrice, false, 16), 110);
});

test("SCENARIO-MAGNET-V2-04: default settings export magnetMode 'weak'", () => {
  assert.equal(settings.magnet, false);
  assert.equal(settings.magnetMode, "weak");
});
