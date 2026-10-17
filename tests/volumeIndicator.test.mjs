import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

async function volumeModule() {
  return import("../dist/features/indicators/builtins/volume.js");
}

test("volume bars use buy/sell colors from delta sign", async () => {
  const { volumeBarColor } = await volumeModule();
  assert.equal(volumeBarColor(12, "buy", "sell"), "buy");
  assert.equal(volumeBarColor(0, "buy", "sell"), "buy");
  assert.equal(volumeBarColor(-1, "buy", "sell"), "sell");
});

test("quote volume uses footprint price bins and falls back to close notional", async () => {
  const { quoteVolumeForBar } = await volumeModule();
  const bar = { close: 105, volume: 3, cells: new Map([[100, { priceBin: 100, buyVol: 1, sellVol: 2 }]]) };
  assert.equal(quoteVolumeForBar(bar), 300);
  assert.equal(quoteVolumeForBar({ ...bar, cells: new Map() }), 315);
});

test("volume defaults use canonical theme colors", async () => {
  const { volumeIndicatorDefinition } = await volumeModule();
  const settings = volumeIndicatorDefinition.defaultSettings();
  assert.equal(settings.upColor, "#3fe0a0");
  assert.equal(settings.downColor, "#e06c75");
  assert.equal(settings.deltaColored, true);
});
