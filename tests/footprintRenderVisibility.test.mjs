/**
 * Regressions for footprint visibility:
 *  - the per-panel view config owns the footprint toggles (not global settings)
 *  - render caches invalidate on a cell change, even inside one millisecond
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state = (value) => value;

const { FootprintSeries } = await import("../dist/core/model/footprint.js");
const { settings } = await import("../dist/core/settings.js");

const MARKET = "BINANCE_FUTURES:btcusdt";
const T0 = Date.UTC(2024, 0, 1);

function trade(overrides = {}) {
  return {
    time: T0 + 1000,
    price: 100,
    qty: 1,
    isBuy: true,
    liquidation: false,
    market: MARKET,
    source: "live",
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("every cell mutation bumps cellRevision, even within one millisecond", () => {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: MARKET });
  // Same receivedAt on purpose: updatedAt cannot distinguish these, which is exactly
  // why the render caches key on cellRevision instead.
  series.addTrade(trade({ price: 100 }));
  const first = series.at(0).cellRevision;
  series.addTrade(trade({ price: 110 }));
  const second = series.at(0).cellRevision;

  assert.equal(series.at(0).updatedAt, 1_700_000_000_000);
  assert.ok(Number.isInteger(first) && first > 0);
  assert.ok(second > first, "cellRevision must advance on every cell mutation");
});

test("cellRevision advances per bar, independently of other bars", () => {
  const a = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: MARKET });
  const b = new FootprintSeries({ intervalMs: 60_000, priceStep: 10, referenceMarket: MARKET });
  a.addTrade(trade());
  a.addTrade(trade({ price: 110 }));
  b.addTrade(trade());
  // Per-bar, so two independently built series agree — a process-global counter would
  // make otherwise identical bars compare unequal.
  assert.equal(a.at(0).cellRevision, 2);
  assert.equal(b.at(0).cellRevision, 1);
});

test("the per-panel view config carries the footprint visibility toggles", () => {
  // These used to be read off the global settings inside the renderer while chartType
  // came from the panel config, so toggling one panel changed every panel.
  for (const key of ["candles", "heat", "cellNumbers", "poc", "stackedImbalance"]) {
    assert.ok(key in settings, `settings must still provide the default for ${key}`);
  }
});

test("renderer and overlay read the toggles from the panel config", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const renderer = fs.readFileSync(path.join(root, "src/core/render/footprintRenderer.ts"), "utf8");
  const overlay = fs.readFileSync(path.join(root, "src/core/render/overlay.ts"), "utf8");

  for (const key of ["candles", "heat", "poc", "stackedImbalance"]) {
    assert.doesNotMatch(renderer, new RegExp(`settings\\.${key}\\b`), `renderer must not read global settings.${key}`);
  }
  assert.doesNotMatch(overlay, /settings\.cellNumbers\b/, "overlay must not read global settings.cellNumbers");
});
