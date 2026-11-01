import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { quantizeToStep, neighbourBin } from "../dist/core/priceStep.js";
import { calculateTpoProfile } from "../dist/core/analysis/tpoProfile.js";

test("TPO fractional step overlay uses quantizeToStep and neighbourBin matching calculateTpoProfile bins", () => {
  const steps = [0.1, 0.05, 0.01, 0.0001];
  const low = 150.1;
  const high = 152.3;
  const close = 0.3;

  for (const step of steps) {
    const barHigh = step === 0.0001 ? 150.3 : high;
    const bar = {
      startTime: 1_000,
      open: low,
      high: barHigh,
      low,
      close,
      volume: 100,
      delta: 0,
      count: 10,
    };

    const result = calculateTpoProfile([bar], step);
    assert.ok(result.levels.length > 0, `levels for step ${step} must not be empty`);

    const lo = quantizeToStep(bar.low, step);
    const hi = quantizeToStep(bar.high, step);
    const ticks = Math.max(0, Math.round((hi - lo) / step));
    let bin = lo;
    const overlayBins = [];
    for (let tick = 0; tick <= ticks; tick++) {
      overlayBins.push(bin);
      bin = neighbourBin(bin, step, 1);
    }

    assert.equal(overlayBins.length, result.levels.length, `bin count must match for step ${step}`);
    for (let i = 0; i < overlayBins.length; i++) {
      assert.strictEqual(
        overlayBins[i],
        result.levels[i].priceBin,
        `overlay bin at index ${i} must strictly equal result.levels[${i}].priceBin for step ${step}`,
      );
    }

    const lastCloseBin = quantizeToStep(bar.close, step);
    assert.ok(Number.isFinite(lastCloseBin));
  }
});

test("src/core/render/overlay.ts contains no Math.floor(... / step)", async () => {
  const overlaySource = await fs.readFile(
    new URL("../src/core/render/overlay.ts", import.meta.url),
    "utf8",
  );
  const matches = overlaySource.match(/Math\.floor\([^)]*\/\s*step\)/g);
  assert.equal(matches, null, "no Math.floor(... / step) should remain in overlay.ts");
});
